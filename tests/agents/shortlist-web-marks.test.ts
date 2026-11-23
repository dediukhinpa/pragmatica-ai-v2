import { describe, expect, test } from 'bun:test';
import { buildShortlistSheets } from '../../src/agents/order-calc/shortlist-xlsx';
import {
  entryCardBlocks,
  entryLines,
  shortlistHeaderLines,
} from '../../src/agents/order-calc/shortlist-message';
import { WEB_SOURCE_MARK } from '../../src/kit/domain/supplier-enrichment';
import { type ShortlistProposal, type WebField } from '../../src/kit/domain/shortlist';
import type { TableSheet } from '@business-ai/core';

/**
 * Пометка «ИЗ ИНТЕРНЕТА» у каждого параметра шорт-листа, взятого из интернета (п.6 доработок
 * 08.11): в тексте чата, в карточках и в xlsx. Происхождение хранится по полю (`webFields`),
 * форматтер его не угадывает.
 */

type Entry = ShortlistProposal['entries'][number];

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

function proposal(entries: Entry[], extra: Partial<ShortlistProposal> = {}): ShortlistProposal {
  return {
    requestId: 'REQ-1',
    version: 'v1',
    createdAt: '2026-11-08T00:00:00.000Z',
    managerThreadId: 'mgr',
    entries,
    truncated: 0,
    sources: [],
    ...extra,
  };
}

/** Значение поля `label` в тексте чата (строка «   Подпись: значение»). */
function textValue(target: Entry, label: string): string {
  const prefix = `   ${label}: `;
  const line = entryLines(target, 0).find((item) => item.startsWith(prefix));
  return line === undefined ? '' : line.slice(prefix.length);
}

/** Значение строки карточки `label`. */
function cardValue(target: Entry, label: string): string {
  const grid = entryCardBlocks(target, 0).find((block) => block.kind === 'grid');
  const row = grid?.kind === 'grid' ? grid.rows.find((item) => item.name === label) : undefined;
  return row?.value ?? '';
}

/** Значение ячейки xlsx. */
function xlsxValue(target: Entry, column: string): string {
  const [main] = buildShortlistSheets(proposal([target])) as [TableSheet, TableSheet];
  const index = (main.columns as readonly string[]).indexOf(column);
  return String(main.rows[0]?.[index] ?? '');
}

const MARK = `(${WEB_SOURCE_MARK})`;

/** Поле шорт-листа, его данные, подписи в чате/карточке/xlsx. */
interface FieldCase {
  field: WebField;
  data: Partial<Entry>;
  label: string;
  column: string;
  /** Что видно в значении без пометки. */
  shown: string;
}

const FIELD_CASES: FieldCase[] = [
  { field: 'city', data: { city: 'Пермь' }, label: 'Город', column: 'Город/адрес', shown: 'Пермь' },
  {
    field: 'address',
    data: { address: 'ул. Заводская, 1' },
    label: 'Город',
    column: 'Город/адрес',
    shown: 'ул. Заводская, 1',
  },
  {
    field: 'contacts',
    data: { contacts: 'тел. +70000000004' },
    label: 'Контакты',
    column: 'Контакты',
    shown: 'тел. +70000000004',
  },
  {
    field: 'email',
    data: { email: 'zakaz@romashka.test' },
    label: 'Контакты',
    column: 'Контакты',
    shown: 'zakaz@romashka.test',
  },
  { field: 'leadTime', data: { leadTime: '5 дней' }, label: 'Срок', column: 'Срок', shown: '5 дней' },
  {
    field: 'site',
    data: { references: ['https://romashka.test/price'] },
    label: 'Сайт',
    column: 'Сайт',
    shown: 'https://romashka.test/price',
  },
];

describe('параметры веб-кандидата помечены «ИЗ ИНТЕРНЕТА»', () => {
  for (const item of FIELD_CASES) {
    describe(`поле ${item.field}`, () => {
      const web = entry({ sources: ['web'], ...item.data, webFields: [item.field] });
      const own = entry(item.data);

      test('чат (текст): значение с пометкой', () => {
        expect(textValue(web, item.label)).toBe(`${item.shown} ${MARK}`);
      });

      test('карточка: значение с пометкой', () => {
        expect(cardValue(web, item.label)).toBe(`${item.shown} ${MARK}`);
      });

      test('xlsx: значение с пометкой', () => {
        expect(xlsxValue(web, item.column)).toBe(`${item.shown} ${MARK}`);
      });

      test('то же значение из карточки базы - без пометки', () => {
        expect(textValue(own, item.label)).toBe(item.shown);
        expect(cardValue(own, item.label)).toBe(item.shown);
        expect(xlsxValue(own, item.column)).toBe(item.shown);
      });
    });
  }

  test('город базы и адрес из интернета: помечена только та часть, что из интернета', () => {
    const mixed = entry({ city: 'Казань', address: 'ул. Заводская, 1', webFields: ['address'] });
    expect(textValue(mixed, 'Город')).toBe(`Казань; адрес: ул. Заводская, 1 ${MARK}`);
    expect(xlsxValue(mixed, 'Город/адрес')).toBe(`Казань; адрес: ул. Заводская, 1 ${MARK}`);
  });

  test('город и адрес оба из интернета: одна пометка на всё', () => {
    const both = entry({ city: 'Пермь', address: 'ул. Заводская, 1', webFields: ['city', 'address'] });
    expect(textValue(both, 'Город')).toBe(`Пермь (ул. Заводская, 1) ${MARK}`);
  });

  test('ссылка сайта из интернета остаётся кликабельной без пометки в самой ссылке', () => {
    const web = entry({
      sources: ['web'],
      references: ['https://romashka.test/price'],
      webFields: ['site'],
    });
    const grid = entryCardBlocks(web, 0).find((block) => block.kind === 'grid');
    const row = grid?.kind === 'grid' ? grid.rows.find((r) => r.name === 'Сайт') : undefined;
    expect(row?.link).toBe('https://romashka.test/price');
  });
});

describe('цена из интернета', () => {
  const webPrices = [{ item: 'Мёд', amount: 1305, currency: 'RUB', unit: 'уп', offer: 'Крем-мёд' }];

  test('чат, карточка, xlsx: пометка вместо прежней «по данным сайта»', () => {
    const web = entry({ sources: ['web'], webPrices });
    for (const value of [
      textValue(web, 'Стоимость'),
      cardValue(web, 'Стоимость'),
      xlsxValue(web, 'Стоимость'),
    ]) {
      expect(value).toContain(MARK);
      expect(value).not.toContain('по данным сайта');
    }
  });

  test('прежняя запись с одной ценой (webPrice) помечена так же', () => {
    const web = entry({ sources: ['web'], webPrice: { amount: 61800, currency: 'RUB', unit: 'т' } });
    expect(textValue(web, 'Стоимость')).toContain(MARK);
    expect(xlsxValue(web, 'Стоимость')).toContain(MARK);
  });

  test('цена из прайса базы без пометки', () => {
    const own = entry({ prices: [{ item: 'Мёд', amount: 100, currency: 'RUB', unit: 'кг' }] });
    expect(textValue(own, 'Стоимость')).not.toContain(WEB_SOURCE_MARK);
    expect(cardValue(own, 'Стоимость')).not.toContain(WEB_SOURCE_MARK);
    expect(xlsxValue(own, 'Стоимость')).not.toContain(WEB_SOURCE_MARK);
  });

  test('xlsx «Средняя/мин» по веб-ценам: каждая строка с пометкой', () => {
    const web = entry({
      sources: ['web'],
      webPrices: [
        { item: 'Мёд', amount: 100, currency: 'RUB', unit: 'кг' },
        { item: 'Мёд', amount: 120, currency: 'RUB', unit: 'кг' },
        { item: 'Орех', amount: 500, currency: 'RUB', unit: 'кг' },
      ],
    });
    const lines = xlsxValue(web, 'Средняя/мин').split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.endsWith(MARK)).toBe(true);
  });

  test('xlsx «Средняя/мин» по ценам базы - без пометки', () => {
    const own = entry({
      prices: [{ item: 'Мёд', amount: 100, currency: 'RUB', unit: 'кг' }],
    });
    expect(xlsxValue(own, 'Средняя/мин')).not.toContain(WEB_SOURCE_MARK);
  });

  test('средняя по интернету в шапке и на листе заявки помечена, по базе - нет', () => {
    const withWeb = proposal([entry({ sources: ['web'] })], {
      market: {
        status: 'ok',
        found: 1,
        groups: [{ currency: 'RUB', unit: 'кг', n: 1, average: 100, min: 100, max: 100 }],
      },
      webMarket: {
        status: 'ok',
        found: 2,
        groups: [{ currency: 'RUB', unit: 'кг', n: 2, average: 110, min: 100, max: 120 }],
      },
    });
    const head = shortlistHeaderLines(withWeb);
    const baseLine = head.find((line) => line.includes('по нашей базе')) ?? '';
    const webLine = head.find((line) => line.includes('по интернету')) ?? '';
    expect(baseLine).not.toContain(WEB_SOURCE_MARK);
    expect(webLine).toContain(MARK);
    const [, info] = buildShortlistSheets(withWeb) as [TableSheet, TableSheet];
    const dump = Object.fromEntries(info.rows.map((row) => [row[0], String(row[1])]));
    expect(dump['Средняя по интернету']).toContain(MARK);
    expect(dump['Средняя по базе']).not.toContain(WEB_SOURCE_MARK);
  });

  test('средняя по интернету «нет данных»: пометки нет', () => {
    const none = proposal([entry()], { webMarket: { status: 'none' } });
    const webLine = shortlistHeaderLines(none).find((line) => line.includes('по интернету')) ?? '';
    expect(webLine).toContain('нет данных');
    expect(webLine).not.toContain(WEB_SOURCE_MARK);
  });
});

describe('обогащение карточки базы из интернета', () => {
  const enriched = entry({
    webEnrichment: {
      match: 'inn',
      city: 'Казань',
      phone: '+78435550101',
      email: 'sales@luna.example',
      site: 'https://luna.example',
    },
  });

  test('город, контакты и сайт - с той же константой, в чате, карточках и xlsx', () => {
    expect(textValue(enriched, 'Город')).toBe(`Казань ${MARK}`);
    expect(cardValue(enriched, 'Город')).toBe(`Казань ${MARK}`);
    expect(xlsxValue(enriched, 'Город/адрес')).toBe(`Казань ${MARK}`);
    expect(textValue(enriched, 'Контакты')).toBe(`+78435550101, sales@luna.example ${MARK}`);
    expect(xlsxValue(enriched, 'Контакты')).toBe(`+78435550101, sales@luna.example ${MARK}`);
    expect(textValue(enriched, 'Сайт')).toBe(`https://luna.example ${MARK}`);
    expect(cardValue(enriched, 'Сайт')).toBe(`https://luna.example ${MARK}`);
    expect(xlsxValue(enriched, 'Сайт')).toBe(`https://luna.example ${MARK}`);
  });
});

describe('источник строки', () => {
  test('поставщик, найденный в интернете: заголовок с константой везде', () => {
    const web = entry({ sources: ['web'] });
    expect(entryLines(web, 0)[0]).toContain(`(${WEB_SOURCE_MARK})`);
    const message = entryCardBlocks(web, 0)[0];
    expect(message?.kind === 'message' ? message.text : '').toContain(WEB_SOURCE_MARK);
    expect(xlsxValue(web, 'Источник')).toBe(WEB_SOURCE_MARK);
  });

  test('база и интернет вместе: оба источника в заголовке', () => {
    const both = entry({ sources: ['knowledge', 'web'] });
    expect(entryLines(both, 0)[0]).toContain(`(база знаний, ${WEB_SOURCE_MARK})`);
    expect(xlsxValue(both, 'Источник')).toBe(`база знаний, ${WEB_SOURCE_MARK}`);
  });

  test('поставщик только из базы: пометки нет нигде', () => {
    const own = entry({
      city: 'Казань',
      contacts: 'info@romashka.test',
      leadTime: '3 дня',
      prices: [{ amount: 10, currency: 'RUB' }],
    });
    const dump = JSON.stringify([
      entryLines(own, 0),
      entryCardBlocks(own, 0),
      buildShortlistSheets(proposal([own])),
    ]);
    expect(dump).not.toContain(WEB_SOURCE_MARK);
  });
});
