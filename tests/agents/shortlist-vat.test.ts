import { describe, expect, test } from 'bun:test';
import { buildShortlistSheets } from '../../src/agents/order-calc/shortlist-xlsx';
import {
  entryCardBlocks,
  entryLines,
  vatNote,
} from '../../src/agents/order-calc/shortlist-message';
import type { MarketPriceSample } from '../../src/kit/domain/market-price';
import type { ShortlistEntry, ShortlistProposal } from '../../src/kit/domain/shortlist';
import type { TableSheet } from '@business-ai/core';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import type { PgClient } from '@business-ai/adapters';

/** НДС в строках шорт-листа: по полю price_vat, неизвестное не угадывается. */

function entryWith(price: MarketPriceSample): ShortlistEntry {
  return {
    supplierId: 's-1',
    name: 'ТЕСТ Поставщик',
    sources: ['knowledge'],
    score: 1,
    references: [],
    prices: [price],
  };
}

function priceLine(price: MarketPriceSample): string {
  return entryLines(entryWith(price), 0).join('\n');
}

describe('НДС в строке шорт-листа', () => {
  test('цена с НДС подписана «с НДС»', () => {
    const text = priceLine({ item: 'ручка', amount: 54.4, currency: 'RUB', vat: 'included' });
    expect(text).toContain('54,40 ₽ (с НДС)');
  });

  test('цена без НДС и поставщик без НДС подписаны «без НДС»', () => {
    expect(priceLine({ amount: 54.4, currency: 'RUB', vat: 'excluded' })).toContain('(без НДС)');
    expect(priceLine({ amount: 54.4, currency: 'RUB', vat: 'none' })).toContain('(без НДС)');
  });

  test('признак неизвестен или не размечен: «НДС не указан»', () => {
    expect(priceLine({ amount: 54.4, currency: 'RUB', vat: 'unknown' })).toContain(
      '(НДС не указан)',
    );
    expect(priceLine({ amount: 54.4, currency: 'RUB' })).toContain('(НДС не указан)');
    expect(vatNote(undefined)).toBe('НДС не указан');
  });
});

describe('price_vat доходит из базы до цены шорт-листа', () => {
  function clientWith(rows: Record<string, unknown>[]): PgClient {
    const db: PgClient = {
      query: async () => rows,
      transaction: async (run) => run(db),
      close: async () => undefined,
    };
    return db;
  }
  const row = {
    supplier_id: 's-1',
    product_name: 'ТЕСТ Ручка',
    sku: null,
    price: '10',
    currency: 'RUB',
    price_date: '2026-10-01T00:00:00.000Z',
  };

  test('известное значение читается, NULL опускается', async () => {
    const repo = new PostgresPriceRepository(
      clientWith([
        { ...row, price_vat: 'excluded' },
        { ...row, price_vat: null },
      ]),
    );
    const [withVat, withoutVat] = await repo.searchSuppliersByProduct('ручка', 10);
    expect(withVat?.priceVat).toBe('excluded');
    expect(withoutVat?.priceVat).toBeUndefined();
  });

  test('непонятное значение не принимается молча', async () => {
    const repo = new PostgresPriceRepository(clientWith([{ ...row, price_vat: '20%' }]));
    await expect(repo.searchSuppliersByProduct('ручка', 10)).rejects.toThrow();
  });
});

/** Любая из трёх пометок НДС: у цены должна быть ровно одна. */
const VAT_MARK = /с НДС|без НДС|НДС не указан/gu;

function proposalOf(entry: ShortlistEntry): ShortlistProposal {
  return {
    requestId: 'REQ-1',
    version: 'v1',
    createdAt: '2026-11-08T00:00:00.000Z',
    managerThreadId: 'mgr',
    entries: [entry],
    truncated: 0,
    sources: [],
  };
}

/** Стоимость поставщика в трёх видах: текст чата, карточка, ячейка xlsx. */
function costViews(entry: ShortlistEntry): { text: string; card: string; xlsx: string } {
  const prefix = '   Стоимость: ';
  const line = entryLines(entry, 0).find((item) => item.startsWith(prefix)) ?? '';
  const grid = entryCardBlocks(entry, 0).find((block) => block.kind === 'grid');
  const rows = grid?.kind === 'grid' ? grid.rows : [];
  const row = rows.find((item) => item.name === 'Стоимость');
  const [main] = buildShortlistSheets(proposalOf(entry)) as [TableSheet, TableSheet];
  const index = (main.columns as readonly string[]).indexOf('Стоимость');
  return {
    text: line.slice(prefix.length),
    card: row?.value ?? '',
    xlsx: String(main.rows[0]?.[index] ?? ''),
  };
}

function count(text: string): number {
  return text.match(VAT_MARK)?.length ?? 0;
}

describe('п.2: пометка НДС у каждой цены поставщика (чат, карточка, xlsx)', () => {
  const base = { currency: 'RUB', item: 'Мёд' };
  const variants: Array<[string, MarketPriceSample]> = [
    ['обычная цена с НДС', { ...base, amount: 100, vat: 'included' }],
    ['цена без НДС', { ...base, amount: 100, vat: 'excluded' }],
    ['поставщик без НДС (УСН)', { ...base, amount: 100, vat: 'none' }],
    ['признак неизвестен', { ...base, amount: 100, vat: 'unknown' }],
    ['нет разметки', { ...base, amount: 100 }],
    ['цена «от»', { ...base, amount: 100, qualifier: 'from' }],
    [
      'тиражи',
      {
        ...base,
        amount: 100,
        tiers: [
          { minQuantity: 100, price: 90 },
          { minQuantity: 500, price: 80 },
        ],
      },
    ],
    ['один тираж', { ...base, amount: 100, tiers: [{ minQuantity: 100, price: 90 }] }],
    ['приблизительная', { ...base, amount: 100, approximate: true }],
    ['похожий товар', { ...base, amount: 100, similar: true }],
    ['неподтверждённая', { ...base, amount: 100, unconfirmed: 'нет на диске' }],
    ['с условиями', { ...base, amount: 100, note: 'от 32 кг' }],
  ];

  for (const [title, price] of variants) {
    test(`база: ${title}`, () => {
      const views = costViews(entryWith(price));
      expect(count(views.text)).toBe(1);
      expect(count(views.card)).toBe(1);
      expect(count(views.xlsx)).toBe(1);
    });
  }

  test('несколько цен: пометка у каждой показанной (в xlsx - у всех)', () => {
    const prices: MarketPriceSample[] = ['а', 'б', 'в', 'г', 'д'].map((item, index) => ({
      item,
      amount: 10 + index,
      currency: 'RUB',
      vat: index % 2 === 0 ? 'included' : 'excluded',
    }));
    const views = costViews({ ...entryWith(prices[0] as MarketPriceSample), prices });
    // В чате три цены и «и ещё 2»; полный список - в xlsx.
    expect(count(views.text)).toBe(3);
    expect(count(views.card)).toBe(3);
    expect(count(views.xlsx)).toBe(5);
    expect(views.xlsx.split('\n')).toHaveLength(5);
  });

  describe('цены из интернета', () => {
    const web = (webPrices: MarketPriceSample[]): ShortlistEntry => ({
      supplierId: 's-2',
      name: 'ТЕСТ Сайт',
      sources: ['web'],
      score: 1,
      references: [],
      webPrices,
    });

    test('страница НДС не назвала: «НДС не указан»', () => {
      const views = costViews(web([{ ...base, amount: 1305, unit: 'уп' }]));
      for (const value of [views.text, views.card, views.xlsx]) {
        expect(value).toContain('НДС не указан');
        expect(count(value)).toBe(1);
      }
    });

    test('страница назвала НДС: пометка по данным страницы', () => {
      const included = costViews(web([{ ...base, amount: 1305, vat: 'included' }]));
      const excluded = costViews(web([{ ...base, amount: 1305, vat: 'excluded' }]));
      for (const value of [included.text, included.card, included.xlsx]) {
        expect(value).toContain('с НДС');
        expect(value).not.toContain('НДС не указан');
      }
      for (const value of [excluded.text, excluded.card, excluded.xlsx]) {
        expect(value).toContain('без НДС');
      }
    });

    test('несколько позиций, похожий товар и условия: у каждой цены своя пометка', () => {
      const views = costViews(
        web([
          { item: 'мёд', amount: 100, currency: 'RUB', vat: 'included' },
          { item: 'орех', amount: 200, currency: 'RUB', approximate: true },
          { item: 'чай', amount: 300, currency: 'RUB', note: 'от 10 кг' },
        ]),
      );
      expect(count(views.text)).toBe(3);
      expect(count(views.card)).toBe(3);
      expect(count(views.xlsx)).toBe(3);
    });

    test('прежняя запись с одной ценой (webPrice)', () => {
      const legacy: ShortlistEntry = {
        ...web([]),
        webPrices: undefined,
        webPrice: { amount: 61800, currency: 'RUB', unit: 'т' },
      };
      const views = costViews(legacy);
      expect(count(views.text)).toBe(1);
      expect(count(views.xlsx)).toBe(1);
    });
  });
});
