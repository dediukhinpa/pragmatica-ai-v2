import { describe, expect, test } from 'bun:test';
import { computeMarketAverage, formatPriceTiers } from '../../../src/kit/domain/market-price';
import { diffPrices, findPriceJumps } from '../../../src/kit/domain/price-diff';
import { priceItemSchema } from '../../../src/kit/domain/models';
import { item } from './support/price-fixtures';

const T50 = (price: number) => ({ minQuantity: 50, price });
const T100 = (price: number) => ({ minQuantity: 100, price });
const T500 = (price: number) => ({ minQuantity: 500, price });

/** Позиция с тиражами: основная цена - первого тиража. */
function tiered(name: string, tiers: Array<{ minQuantity: number; price: number }>) {
  return item(name, tiers[0]?.price ?? 0, { sku: 'A1', priceTiers: tiers });
}

describe('формат цен по тиражам', () => {
  test('«от 50 шт — X, от 100 — Y»', () => {
    expect(formatPriceTiers([T50(120), T100(100.5)], 'RUB')).toBe(
      'от 50 шт — 120 RUB, от 100 — 100,50 RUB',
    );
  });
});

describe('схема позиции с тиражами', () => {
  const base = { ...item('Ручка', 12), priceTiers: [T50(12), T100(10)] };
  test('принимает от двух тиражей и без них', () => {
    expect(priceItemSchema.parse(base).priceTiers).toHaveLength(2);
    expect(priceItemSchema.parse(item('Ручка', 12)).priceTiers).toBeUndefined();
  });
  test('один тираж (из ячейки, миграция 033) допустим; нулевая цена и дробный тираж - нет', () => {
    expect(priceItemSchema.safeParse({ ...base, priceTiers: [T50(12)] }).success).toBe(true);
    expect(priceItemSchema.safeParse({ ...base, priceTiers: [] }).success).toBe(false);
    expect(priceItemSchema.safeParse({ ...base, priceTiers: [T50(0), T100(1)] }).success).toBe(
      false,
    );
    expect(
      priceItemSchema.safeParse({
        ...base,
        priceTiers: [{ minQuantity: 0.5, price: 1 }, T100(1)],
      }).success,
    ).toBe(false);
  });
});

describe('средняя по базе считается по цене минимального тиража', () => {
  test('в среднее идёт amount (цена минимального тиража), тиражи его не меняют', () => {
    const average = computeMarketAverage([
      { amount: 12, currency: 'RUB', tiers: [T50(12), T100(6)] },
      { amount: 8, currency: 'RUB' },
    ]);
    expect(average).toMatchObject({ status: 'ok', groups: [{ n: 2, average: 10 }] });
  });
});

describe('скачки: тираж сравнивается с тиражом того же минимума', () => {
  test('скачок в тираже «от 100» при неизменной основной цене - скачок', () => {
    const old = tiered('Ручка', [T50(12), T100(10)]);
    const next = tiered('Ручка', [T50(12), T100(30)]);
    expect(findPriceJumps([next], [old])).toHaveLength(1);
    expect(diffPrices([old], [next]).review.map((r) => r.reason)).toContain('price_jump');
  });

  test('малые изменения тиражей скачком не считаются', () => {
    const old = tiered('Ручка', [T50(12), T100(10)]);
    const next = tiered('Ручка', [T50(13), T100(11)]);
    expect(findPriceJumps([next], [old])).toEqual([]);
  });

  test('тираж «от 500» без пары в прежнем прайсе игнорируется, сверка по общим', () => {
    const old = tiered('Ручка', [T50(12), T100(10)]);
    const next = tiered('Ручка', [T50(12), T100(10), T500(1)]);
    expect(findPriceJumps([next], [old])).toEqual([]);
  });

  test('общих тиражей нет: сравниваются основные цены', () => {
    const old = tiered('Ручка', [T50(12), T100(10)]);
    const jump = tiered('Ручка', [T500(40), { minQuantity: 1000, price: 30 }]);
    const calm = tiered('Ручка', [T500(13), { minQuantity: 1000, price: 1 }]);
    expect(findPriceJumps([jump], [old])).toHaveLength(1);
    expect(findPriceJumps([calm], [old])).toEqual([]);
  });

  test('прежняя позиция без тиражов: сравниваются основные цены', () => {
    const old = item('Ручка', 12, { sku: 'A1' });
    expect(findPriceJumps([tiered('Ручка', [T50(40), T100(1)])], [old])).toHaveLength(1);
    expect(findPriceJumps([tiered('Ручка', [T50(13), T100(1)])], [old])).toEqual([]);
  });

  test('смена валюты по-прежнему скачок', () => {
    const old = tiered('Ручка', [T50(12), T100(10)]);
    const next = { ...tiered('Ручка', [T50(12), T100(10)]), currency: 'USD' };
    expect(findPriceJumps([next], [old])).toHaveLength(1);
  });
});
