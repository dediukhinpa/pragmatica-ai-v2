import { describe, expect, test } from 'bun:test';
import { computeMarketAverage, formatPriceTiers } from '../../../src/kit/domain/market-price';
import { findPriceJumps } from '../../../src/kit/domain/price-diff';
import { priceItemSchema } from '../../../src/kit/domain/models';
import { item } from './support/price-fixtures';

/** Пороги - суммы заказа в рублях («Цена от 62 000 / 102 000»). */
const SUM_TIERS = [
  { minQuantity: 62000, price: 1200 },
  { minQuantity: 102000, price: 1100 },
];

describe('основание тиража: показ', () => {
  test('order_sum: «от заказа на 62 000 ₽», а не «от 62 000 шт»', () => {
    const text = formatPriceTiers(SUM_TIERS, 'RUB', 'order_sum');
    expect(text).toBe('от заказа на 62 000 ₽ — 1 200 RUB, от заказа на 102 000 ₽ — 1 100 RUB');
    expect(text).not.toContain('шт');
  });

  test('quantity и основание по умолчанию выглядят как раньше', () => {
    const tiers = [
      { minQuantity: 50, price: 120 },
      { minQuantity: 100, price: 100 },
    ];
    expect(formatPriceTiers(tiers, 'RUB')).toBe('от 50 шт — 120 RUB, от 100 — 100 RUB');
    expect(formatPriceTiers(tiers, 'RUB', 'quantity')).toBe(formatPriceTiers(tiers, 'RUB'));
  });
});

describe('основание тиража: схема позиции', () => {
  const base = { ...item('Одеяло', 1200), priceTiers: SUM_TIERS };
  test('order_sum принимается только вместе с тиражами', () => {
    expect(priceItemSchema.safeParse({ ...base, priceTierBasis: 'order_sum' }).success).toBe(true);
    const { priceTiers: _tiers, ...noTiers } = base;
    expect(priceItemSchema.safeParse({ ...noTiers, priceTierBasis: 'order_sum' }).success).toBe(
      false,
    );
    expect(priceItemSchema.safeParse({ ...base, priceTierBasis: 'weight' }).success).toBe(false);
  });
});

describe('основание тиража: среднее по базе', () => {
  test('скидочная цена по сумме заказа не идёт в точное среднее при наличии точных', () => {
    const avg = computeMarketAverage([
      { item: 'Одеяло', amount: 1500, currency: 'RUB' },
      { item: 'Одеяло', amount: 1200, currency: 'RUB', tierBasis: 'order_sum', tiers: SUM_TIERS },
    ]);
    expect(avg).toMatchObject({ status: 'ok', found: 1 });
    if (avg.status === 'ok') expect(avg.groups[0]?.average).toBe(1500);
  });

  test('если других цен нет, она остаётся как оценка снизу', () => {
    const avg = computeMarketAverage([
      { item: 'Одеяло', amount: 1200, currency: 'RUB', tierBasis: 'order_sum', tiers: SUM_TIERS },
    ]);
    if (avg.status !== 'ok') throw new Error('ожидалась группа');
    expect(avg.groups[0]?.lowerBound).toBe(true);
  });
});

describe('основание тиража: сравнение прайсов', () => {
  const old = item('Одеяло', 1200, { sku: 'B1', priceTiers: SUM_TIERS });

  test('то же основание: скачок цены тиража замечается', () => {
    const tripled = SUM_TIERS.map((t) => ({ ...t, price: t.price * 3 }));
    expect(findPriceJumps([{ ...old, price: 3600, priceTiers: tripled }], [old])).toHaveLength(1);
  });

  test('пороги с тем же числом, но другим основанием, не считаются общими тиражами', () => {
    // Тиражи те же: при одном основании они совпали бы (скачка нет). При разном сравниваются
    // основные цены (3600 против 1200), и скачок виден.
    const sameBasis = { ...old, price: 3600, priceTierBasis: 'order_sum' as const };
    const prior = { ...old, priceTierBasis: 'order_sum' as const };
    expect(findPriceJumps([sameBasis], [prior])).toEqual([]);
    expect(findPriceJumps([sameBasis], [old])).toHaveLength(1);
  });
});
