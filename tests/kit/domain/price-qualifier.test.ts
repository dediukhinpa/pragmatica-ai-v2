import { describe, expect, test } from 'bun:test';
import {
  computeMarketAverage,
  formatPriceWithQualifier,
} from '../../../src/kit/domain/market-price';
import { countPriceForms, priceItemSchema, type PriceItem } from '../../../src/kit/domain/models';
import { diffPrices } from '../../../src/kit/domain/price-diff';

const base: PriceItem = {
  supplierId: 's1',
  productName: 'Ручка',
  sku: 'R-1',
  price: 500,
  currency: 'RUB',
  date: '2026-10-01T00:00:00.000Z',
};

describe('formatPriceWithQualifier', () => {
  test('точная, от, диапазон, единица', () => {
    expect(formatPriceWithQualifier({ amount: 500, currency: 'RUB' })).toBe('500 RUB');
    expect(formatPriceWithQualifier({ amount: 500, currency: 'RUB', qualifier: 'from' })).toBe(
      'от 500 RUB',
    );
    expect(
      formatPriceWithQualifier({
        amount: 1500,
        currency: 'RUB',
        qualifier: 'range',
        max: 2000,
        unit: 'шт',
      }),
    ).toBe('1 500–2 000 RUB/шт');
  });
});

describe('схема позиции', () => {
  test('priceMax только у диапазона и больше цены', () => {
    const ok = { ...base, priceQualifier: 'range', priceMax: 700 };
    expect(priceItemSchema.safeParse(ok).success).toBe(true);
    expect(priceItemSchema.safeParse({ ...ok, priceMax: 400 }).success).toBe(false);
    expect(priceItemSchema.safeParse({ ...base, priceQualifier: 'from', priceMax: 700 }).success)
      .toBe(false);
  });

  test('тираж из одного элемента допустим', () => {
    const item = { ...base, priceTiers: [{ minQuantity: 100, price: 500 }] };
    expect(priceItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('средняя рыночная цена и признак', () => {
  test('точные цены считаются без «от»', () => {
    const avg = computeMarketAverage([
      { amount: 100, currency: 'RUB' },
      { amount: 200, currency: 'RUB' },
      { amount: 10, currency: 'RUB', qualifier: 'from' },
    ]);
    expect(avg).toMatchObject({ status: 'ok', found: 2 });
    if (avg.status === 'ok') {
      expect(avg.groups[0]).toMatchObject({ n: 2, average: 150 });
      expect(avg.groups[0]?.lowerBound).toBeUndefined();
    }
  });

  test('только «от»/диапазон: цена не обнуляется, помечена как оценка снизу', () => {
    const avg = computeMarketAverage([
      { amount: 100, currency: 'RUB', qualifier: 'from' },
      { amount: 300, currency: 'RUB', qualifier: 'range', max: 400 },
    ]);
    expect(avg.status).toBe('ok');
    if (avg.status === 'ok') {
      expect(avg.groups[0]).toMatchObject({ n: 2, average: 200, lowerBound: true });
    }
  });
});

describe('сравнение прайсов и признак', () => {
  const diff = (old: PriceItem, now: PriceItem) => diffPrices([old], [now]);

  test('точная 500 -> «от 500» - изменение', () => {
    const result = diff(base, { ...base, priceQualifier: 'from' });
    expect(result.unchanged).toBe(0);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({ newQualifier: 'from', changePct: 0 });
  });

  test('смена верхней границы диапазона - изменение, тот же диапазон - нет', () => {
    const range = { ...base, priceQualifier: 'range' as const, priceMax: 700 };
    expect(diff(range, { ...range, priceMax: 800 }).changed).toHaveLength(1);
    expect(diff(range, { ...range }).unchanged).toBe(1);
  });
});

describe('countPriceForms', () => {
  test('считает «от», диапазон и тираж из ячейки', () => {
    expect(
      countPriceForms([
        { ...base, priceQualifier: 'from' },
        { ...base, priceQualifier: 'range', priceMax: 600 },
        { ...base, priceTiers: [{ minQuantity: 10, price: 500 }] },
        {
          ...base,
          priceTiers: [
            { minQuantity: 10, price: 500 },
            { minQuantity: 20, price: 400 },
          ],
        },
        base,
      ]),
    ).toEqual({ from: 1, range: 1, cellTier: 1 });
  });
});
