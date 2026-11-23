import { describe, expect, test } from 'bun:test';
import { buildShortlistSheets } from '../../src/agents/order-calc/shortlist-xlsx';
import { entryCardBlocks, entryLines } from '../../src/agents/order-calc/shortlist-message';
import { ORDER_CALC_MAIL_PROMPT, ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { WEB_SOURCE_MARK } from '../../src/kit/domain/supplier-enrichment';
import {
  mergeCandidates,
  shortlistProposalSchema,
  type ShortlistProposal,
  type SourceResult,
} from '../../src/kit/domain/shortlist';
import type { TableSheet } from '@business-ai/core';

/**
 * Доработки по ревью этапа 214: пометка «ИЗ ИНТЕРНЕТА» у «Почему в списке» и «локации»,
 * старые записи шорт-листа, «Средняя/мин» с НДС, длина строк промпта.
 */

type Entry = ShortlistProposal['entries'][number];

const MARK = `(${WEB_SOURCE_MARK})`;

function entry(extra: Partial<Entry> = {}): Entry {
  return {
    supplierId: 's1',
    name: 'Ромашка',
    sources: ['knowledge'],
    score: 1,
    references: [],
    ...extra,
  };
}

function proposal(entries: Entry[]): ShortlistProposal {
  return {
    requestId: 'REQ-1',
    version: 'v1',
    createdAt: '2026-11-08T00:00:00.000Z',
    managerThreadId: 'mgr',
    entries,
    truncated: 0,
    sources: [],
  };
}

function textValue(target: Entry, label: string): string {
  const prefix = `   ${label}: `;
  const line = entryLines(target, 0).find((item) => item.startsWith(prefix));
  return line === undefined ? '' : line.slice(prefix.length);
}

function cardValue(target: Entry, label: string): string {
  const grid = entryCardBlocks(target, 0).find((block) => block.kind === 'grid');
  const row = grid?.kind === 'grid' ? grid.rows.find((item) => item.name === label) : undefined;
  return row?.value ?? '';
}

function xlsxValue(target: Entry, column: string): string {
  const [main] = buildShortlistSheets(proposal([target])) as [TableSheet, TableSheet];
  const index = (main.columns as readonly string[]).indexOf(column);
  return String(main.rows[0]?.[index] ?? '');
}

const REASON = 'точный товар, цена ниже';

describe('п.1: «Почему в списке» - данные из интернета помечены', () => {
  const webSamples: Array<[string, Partial<Entry>]> = [
    ['поля веб-кандидата', { sources: ['web'], city: 'Пермь', webFields: ['city'] }],
    [
      'цены страниц',
      { sources: ['web'], webPrices: [{ item: 'Мёд', amount: 100, currency: 'RUB' }] },
    ],
    ['прежняя цена страницы', { webPrice: { amount: 100, currency: 'RUB' } }],
    ['обогащение карточки базы', { webEnrichment: { city: 'Пермь', match: 'inn' } }],
  ];
  for (const [title, extra] of webSamples) {
    test(`${title}: причина с пометкой в тексте и карточке`, () => {
      const target = entry({ ...extra, rankReason: REASON });
      expect(textValue(target, 'Почему в списке')).toBe(`${REASON} ${MARK}`);
      expect(cardValue(target, 'Почему в списке')).toBe(`${REASON} ${MARK}`);
    });
  }

  test('поставщик только из базы: причина без пометки', () => {
    const target = entry({ city: 'Казань', rankReason: REASON });
    expect(textValue(target, 'Почему в списке')).toBe(REASON);
    expect(cardValue(target, 'Почему в списке')).toBe(REASON);
  });
});

describe('п.3: прежняя запись шорт-листа без webFields', () => {
  const legacy = entry({
    sources: ['web'],
    city: 'Пермь',
    contacts: 'тел. +70000000004',
    leadTime: '5 дней',
    references: ['https://romashka.test/price'],
  });

  test('чат, карточка и xlsx показывают пометку по выведенным полям', () => {
    for (const [label, column, shown] of [
      ['Город', 'Город/адрес', 'Пермь'],
      ['Контакты', 'Контакты', 'тел. +70000000004'],
      ['Срок', 'Срок', '5 дней'],
      ['Сайт', 'Сайт', 'https://romashka.test/price'],
    ] as const) {
      expect(textValue(legacy, label)).toBe(`${shown} ${MARK}`);
      expect(cardValue(legacy, label)).toBe(`${shown} ${MARK}`);
      expect(xlsxValue(legacy, column)).toBe(`${shown} ${MARK}`);
    }
  });

  test('прежняя запись базы (источник knowledge) остаётся без пометки', () => {
    const own = entry({ city: 'Казань', references: ['https://romashka.test/price'] });
    expect(textValue(own, 'Город')).toBe('Казань');
    expect(textValue(own, 'Сайт')).toBe('https://romashka.test/price');
  });


  test('явные webFields важнее вывода по источнику', () => {
    const explicit = entry({
      sources: ['web'],
      city: 'Казань',
      leadTime: '5 дней',
      webFields: ['leadTime'],
    });
    expect(textValue(explicit, 'Город')).toBe('Казань');
    expect(textValue(explicit, 'Срок')).toBe(`5 дней ${MARK}`);
  });

  test('запись, прочитанная схемой, показывается с пометкой', () => {
    const parsed = shortlistProposalSchema.parse({
      ...proposal([]),
      entries: [
        { supplierId: 'a', name: 'А', sources: ['web'], score: 1, references: [], city: 'Омск' },
      ],
    });
    const [first] = parsed.entries;
    expect(first === undefined ? '' : textValue(first, 'Город')).toBe(`Омск ${MARK}`);
  });
});

describe('п.5: «локация: X» с пометкой, если место поставщика из интернета', () => {
  const header = (target: Entry): string => entryLines(target, 0)[0] ?? '';
  const card = (target: Entry): string => {
    const [message] = entryCardBlocks(target, 0);
    return message?.kind === 'message' ? message.text : '';
  };

  test('город из интернета: пометка в заголовке текста и карточки', () => {
    const target = entry({
      sources: ['web'],
      city: 'Пермь',
      webFields: ['city'],
      locationGroup: 'Пермь',
    });
    expect(header(target)).toContain(`локация: Пермь ${MARK}`);
    expect(card(target)).toContain(`локация: Пермь ${MARK}`);
  });

  test('город найден обогащением карточки: тоже из интернета', () => {
    const target = entry({
      webEnrichment: { city: 'Пермь', match: 'inn' },
      locationGroup: 'Пермь',
    });
    expect(header(target)).toContain(`локация: Пермь ${MARK}`);
  });

  test('город из карточки базы: без пометки', () => {
    const target = entry({ city: 'Пермь', locationGroup: 'Пермь' });
    expect(header(target)).toContain('локация: Пермь');
    expect(header(target)).not.toContain(WEB_SOURCE_MARK);
  });

  test('город базы совпал с локацией, обогащение лишь добавило другой: без пометки', () => {
    const target = entry({
      city: 'Пермь',
      webEnrichment: { city: 'Казань', match: 'inn' },
      locationGroup: 'Пермь',
    });
    expect(header(target)).not.toContain(WEB_SOURCE_MARK);
  });
});

describe('п.6: website и specialization не получают пометки молча', () => {
  test('веб-кандидат не заносит website/specialization в строку шорт-листа', () => {
    const results: SourceResult[] = [
      {
        source: 'web',
        status: 'ok',
        candidates: [
          {
            name: 'Ромашка',
            score: 1,
            reference: 'https://romashka.test',
            website: 'https://romashka.test',
            specialization: 'мёд',
          },
        ],
      },
    ];
    const { entries } = mergeCandidates(results, {
      limit: 10,
      externalId: (name: string): string => `ext-${name}`,
    });
    expect(entries[0]?.website).toBeUndefined();
    expect(entries[0]?.specialization).toBeUndefined();
  });

  test('карточка базы website/specialization по-прежнему даёт', () => {
    const results: SourceResult[] = [
      {
        source: 'knowledge',
        status: 'ok',
        candidates: [
          {
            name: 'Ромашка',
            supplierId: 's1',
            score: 1,
            website: 'https://romashka.test',
            specialization: 'мёд',
          },
        ],
      },
    ];
    const { entries } = mergeCandidates(results, {
      limit: 10,
      externalId: (name: string): string => `ext-${name}`,
    });
    expect(entries[0]?.website).toBe('https://romashka.test');
    expect(entries[0]?.specialization).toBe('мёд');
  });
});

describe('п.2: xlsx «Средняя/мин» не смешивает цены с НДС и без', () => {
  const price = (amount: number, vat?: 'included' | 'excluded'): Entry['prices'] => [
    { item: 'Мёд', amount, currency: 'RUB', unit: 'кг', ...(vat === undefined ? {} : { vat }) },
  ];

  test('цены с НДС и без НДС - отдельные строки с пометкой НДС', () => {
    const target = entry({
      prices: [
        ...(price(120, 'included') ?? []),
        { item: 'Мёд', amount: 100, currency: 'RUB', unit: 'кг', vat: 'excluded' },
        { item: 'Мёд', amount: 110, currency: 'RUB', unit: 'кг' },
      ],
    });
    const lines = xlsxValue(target, 'Средняя/мин').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('с НДС') && !line.includes('без НДС'))).toBe(true);
    expect(lines.some((line) => line.includes('без НДС'))).toBe(true);
    expect(lines.some((line) => line.includes('НДС не указан'))).toBe(true);
    expect(lines.every((line) => !line.includes('ср.'))).toBe(true);
  });

  test('две цены одного признака НДС усредняются, пометка одна', () => {
    const target = entry({
      prices: [
        { item: 'Мёд', amount: 100, currency: 'RUB', unit: 'кг', vat: 'included' },
        { item: 'Мёд', amount: 120, currency: 'RUB', unit: 'кг', vat: 'included', note: 'опт' },
      ],
    });
    const lines = xlsxValue(target, 'Средняя/мин').split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ср.');
    expect(lines[0]).toContain('(с НДС)');
  });
});

describe('п.10: строки промптов агента поиска не длиннее 100 знаков', () => {
  for (const [title, prompt] of [
    ['без почты', ORDER_CALC_PROMPT],
    ['с почтой', ORDER_CALC_MAIL_PROMPT],
  ] as const) {
    test(title, () => {
      const long = prompt.split('\n').filter((line) => [...line].length > 100);
      expect(long).toEqual([]);
    });
  }
});
