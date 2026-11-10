import { describe, expect, test } from 'bun:test';
import { buildShortlistSheets } from '../../src/agents/order-calc/shortlist-xlsx';
import {
  entryCardBlocks,
  entryLines,
  shortlistHeaderLines,
  sourceLabel,
} from '../../src/agents/order-calc/shortlist-message';
import { TELEGRAM_SOURCE_MARK, type TelegramField } from '../../src/kit/domain/telegram-source';
import { WEB_SOURCE_MARK } from '../../src/kit/domain/supplier-enrichment';
import { type ShortlistProposal } from '../../src/kit/domain/shortlist';
import type { TableSheet } from '@business-ai/core';

/**
 * Пометка «из Telegram-канала» у сведений, взятых из канала (этап 216): в тексте чата, в
 * карточках и в xlsx. Не путать с «ИЗ ИНТЕРНЕТА»: у канала своя подпись источника.
 */

type Entry = ShortlistProposal['entries'][number];

function entry(extra: Partial<Entry> = {}): Entry {
  return {
    supplierId: 's1',
    name: 'Канальный металл',
    sources: ['telegram'],
    score: 1,
    references: ['tg:suppliers/101'],
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

const MARK = `(${TELEGRAM_SOURCE_MARK})`;

interface FieldCase {
  field: TelegramField;
  data: Partial<Entry>;
  label: string;
  column: string;
  shown: string;
}

const FIELD_CASES: FieldCase[] = [
  { field: 'city', data: { city: 'Пермь' }, label: 'Город', column: 'Город/адрес', shown: 'Пермь' },
  {
    field: 'contacts',
    data: { contacts: 'тел. +70000000004' },
    label: 'Контакты',
    column: 'Контакты',
    shown: 'тел. +70000000004',
  },
  {
    field: 'email',
    data: { email: 'zakaz@kanal.test' },
    label: 'Контакты',
    column: 'Контакты',
    shown: 'zakaz@kanal.test',
  },
  { field: 'leadTime', data: { leadTime: '3 дня' }, label: 'Срок', column: 'Срок', shown: '3 дня' },
];

describe('подпись источника', () => {
  test('канал - своя константа, не «ИЗ ИНТЕРНЕТА»; база и веб прежние', () => {
    expect(sourceLabel('telegram')).toBe(TELEGRAM_SOURCE_MARK);
    expect(sourceLabel('telegram', true)).toBe(TELEGRAM_SOURCE_MARK);
    expect(sourceLabel('web')).toBe(WEB_SOURCE_MARK);
    expect(sourceLabel('knowledge')).toBe('база знаний');
  });

  test('чат, карточка и xlsx называют источник строки', () => {
    const target = entry();
    expect(entryLines(target, 0)[0]).toContain(`(${TELEGRAM_SOURCE_MARK})`);
    const head = entryCardBlocks(target, 0)[0];
    expect(head?.kind === 'message' ? head.text : '').toContain(TELEGRAM_SOURCE_MARK);
    expect(xlsxValue(target, 'Источник')).toBe(TELEGRAM_SOURCE_MARK);
  });
});

describe('сведения канала помечены «из Telegram-канала»', () => {
  for (const item of FIELD_CASES) {
    describe(`поле ${item.field}`, () => {
      const own = entry({ sources: ['knowledge'], ...item.data });
      const tg = entry({ ...item.data, telegramFields: [item.field] });

      test('чат, карточка, xlsx: значение с пометкой', () => {
        expect(textValue(tg, item.label)).toBe(`${item.shown} ${MARK}`);
        expect(cardValue(tg, item.label)).toBe(`${item.shown} ${MARK}`);
        expect(xlsxValue(tg, item.column)).toBe(`${item.shown} ${MARK}`);
      });

      test('то же значение из карточки базы - без пометки', () => {
        expect(textValue(own, item.label)).toBe(item.shown);
        expect(cardValue(own, item.label)).toBe(item.shown);
        expect(xlsxValue(own, item.column)).toBe(item.shown);
      });
    });
  }

  test('цены канала: каждая с пометкой и НДС; цены базы без пометки', () => {
    const prices = [{ item: 'Арматура', amount: 55, currency: 'RUB', unit: 'м' }];
    const tg = entry({
      prices: prices.map((price) => ({ ...price, fromTelegram: true as const })),
      telegramFields: ['prices'],
    });
    expect(textValue(tg, 'Стоимость')).toContain(`(НДС не указан) ${MARK}`);
    expect(cardValue(tg, 'Стоимость')).toContain(MARK);
    expect(xlsxValue(tg, 'Стоимость')).toContain(MARK);
    const own = entry({ sources: ['knowledge'], prices });
    expect(textValue(own, 'Стоимость')).not.toContain(TELEGRAM_SOURCE_MARK);
    expect(xlsxValue(own, 'Стоимость')).not.toContain(TELEGRAM_SOURCE_MARK);
  });

  test('у поставщика цены базы и канала вперемешку: пометка только у цены из канала', () => {
    const mixed = entry({
      sources: ['knowledge', 'telegram'],
      prices: [
        { item: 'Арматура', amount: 55, currency: 'RUB', unit: 'м' },
        { item: 'Сетка', amount: 70, currency: 'RUB', unit: 'м', fromTelegram: true },
      ],
      telegramFields: ['prices'],
    });
    for (const text of [
      textValue(mixed, 'Стоимость'),
      cardValue(mixed, 'Стоимость'),
      xlsxValue(mixed, 'Стоимость'),
    ]) {
      expect(text.split(TELEGRAM_SOURCE_MARK)).toHaveLength(2);
      expect(text.indexOf('Сетка')).toBeLessThan(text.indexOf(TELEGRAM_SOURCE_MARK));
      expect(text.indexOf(TELEGRAM_SOURCE_MARK)).toBeGreaterThan(text.indexOf('70'));
    }
    // Цена базы стоит раньше и без пометки.
    const first = xlsxValue(mixed, 'Стоимость').split('Сетка')[0] ?? '';
    expect(first).not.toContain(TELEGRAM_SOURCE_MARK);
  });

  test('«Средняя/мин» в xlsx: по ценам канала с пометкой, по ценам базы без', () => {
    const channelOnly = entry({
      prices: [
        { item: 'Арматура', amount: 55, currency: 'RUB', unit: 'м', fromTelegram: true },
      ],
      telegramFields: ['prices'],
    });
    expect(xlsxValue(channelOnly, 'Средняя/мин')).toContain(TELEGRAM_SOURCE_MARK);
    const base = entry({
      sources: ['knowledge'],
      prices: [{ item: 'Арматура', amount: 55, currency: 'RUB', unit: 'м' }],
    });
    expect(xlsxValue(base, 'Средняя/мин')).not.toContain(TELEGRAM_SOURCE_MARK);
  });

  test('город и адрес разного происхождения: помечена только часть из канала', () => {
    const mixed = entry({
      sources: ['knowledge', 'telegram'],
      city: 'Пермь',
      address: 'ул. Складская, 5',
      telegramFields: ['city'],
    });
    expect(textValue(mixed, 'Город')).toBe(`Пермь ${MARK}; адрес: ул. Складская, 5`);
  });

  test('причина выбора от модели: целиком с пометкой, если в строке есть сведения канала', () => {
    const tg = entry({ city: 'Пермь', telegramFields: ['city'], rankReason: 'Цена ниже' });
    expect(textValue(tg, 'Почему в списке')).toBe(`Цена ниже ${MARK}`);
    const own = entry({ sources: ['knowledge'], rankReason: 'Цена ниже' });
    expect(textValue(own, 'Почему в списке')).toBe('Цена ниже');
  });

  test('локация, найденная по городу из канала: с пометкой канала', () => {
    const tg = entry({
      city: 'Пермь',
      telegramFields: ['city'],
      locationGroup: 'Пермь',
    });
    expect(entryLines(tg, 0)[0]).toContain(`локация: Пермь ${MARK}`);
  });
});


describe('средняя по каналу в шапке и в xlsx (ревью 216, п.2)', () => {
  const telegramMarket = {
    status: 'ok' as const,
    found: 2,
    groups: [
      { item: 'Арматура', currency: 'RUB', unit: 'м', n: 2, average: 52.5, min: 50, max: 55 },
    ],
  };

  test('блок есть, только когда у канала нашлись цены; значение с пометкой канала', () => {
    const withMarket = { ...proposal([entry()]), telegramMarket };
    const lines = shortlistHeaderLines(withMarket).join('\n');
    expect(lines).toContain('Средняя цена по Telegram-каналу');
    expect(lines).toContain(MARK);
    expect(shortlistHeaderLines(proposal([entry()])).join('\n')).not.toContain('Telegram');
  });

  test('лист «Заявка» в xlsx: отдельная строка средней по каналу', () => {
    const sheets = buildShortlistSheets({ ...proposal([entry()]), telegramMarket });
    const info = sheets[1]?.rows.map((row) => String(row[0])) ?? [];
    expect(info).toContain('Средняя по Telegram-каналу');
    const without = buildShortlistSheets(proposal([entry()]));
    expect(without[1]?.rows.map((row) => String(row[0]))).not.toContain(
      'Средняя по Telegram-каналу',
    );
  });
});
