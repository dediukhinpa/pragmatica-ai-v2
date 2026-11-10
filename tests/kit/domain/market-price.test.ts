import { describe, expect, test } from 'bun:test';
import {
  computeMarketAverage,
  formatPrice,
  formatPriceAmount,
  marketAverageSchema,
  type MarketPriceSample,
} from '../../../src/kit/domain/market-price';

const rub = (amount: number, extra: Partial<MarketPriceSample> = {}): MarketPriceSample => ({
  amount,
  currency: 'RUB',
  ...extra,
});

describe('computeMarketAverage', () => {
  test('цен нет - none, а не нулевая средняя', () => {
    expect(computeMarketAverage([])).toEqual({ status: 'none' });
    expect(computeMarketAverage([rub(0), rub(-5), rub(Number.NaN)])).toEqual({ status: 'none' });
  });

  test('одна цена - уже среднее (порога нет)', () => {
    const result = computeMarketAverage([rub(100)]);
    expect(result).toEqual({
      status: 'ok',
      found: 1,
      groups: [{ currency: 'RUB', n: 1, average: 100, min: 100, max: 100 }],
    });
  });

  test('две цены - среднее арифметическое с n=2', () => {
    const result = computeMarketAverage([rub(100), rub(200)]);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups).toEqual([{ currency: 'RUB', n: 2, average: 150, min: 100, max: 200 }]);
  });

  test('три цены - среднее, минимум, максимум и n', () => {
    const result = computeMarketAverage([rub(100), rub(200), rub(600)]);
    expect(result).toMatchObject({ status: 'ok', found: 3 });
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups).toEqual([{ currency: 'RUB', n: 3, average: 300, min: 100, max: 600 }]);
  });

  test('среднее округляется до копеек', () => {
    const result = computeMarketAverage([rub(10), rub(10), rub(10.01)]);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups[0]?.average).toBe(10);
    const third = computeMarketAverage([rub(1), rub(1), rub(2)]);
    if (third.status !== 'ok') throw new Error('ожидалось ok');
    expect(third.groups[0]?.average).toBe(1.33);
  });

  test('разные валюты не смешиваются: в каждой своё среднее', () => {
    const usd = (amount: number): MarketPriceSample => ({ amount, currency: 'usd' });
    const result = computeMarketAverage([
      rub(100),
      rub(200),
      rub(300),
      usd(1),
      usd(2),
      usd(3),
    ]);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups.map((g) => [g.currency, g.average])).toEqual([
      ['RUB', 200],
      ['USD', 2],
    ]);
  });

  test('валюта с одной ценой даёт свою группу и не мешается с другими', () => {
    const result = computeMarketAverage([
      rub(100),
      rub(200),
      rub(300),
      { amount: 1, currency: 'USD' },
    ]);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups.map((g) => [g.currency, g.n, g.average])).toEqual([
      ['RUB', 3, 200],
      ['USD', 1, 1],
    ]);
    expect(result.found).toBe(4);
  });

  test('цены в разных валютах - среднее у каждой валюты своё, общей нет', () => {
    const result = computeMarketAverage([
      rub(100),
      rub(200),
      { amount: 1, currency: 'USD' },
      { amount: 2, currency: 'USD' },
    ]);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups.map((g) => g.currency)).toEqual(['RUB', 'USD']);
    expect(result.found).toBe(4);
  });

  test('разные единицы не смешиваются, синонимы единицы - одна группа', () => {
    const result = computeMarketAverage([
      rub(10, { unit: 'шт' }),
      rub(20, { unit: 'штука' }),
      rub(30, { unit: 'pcs' }),
      rub(1000, { unit: 'кг' }),
      rub(2000, { unit: 'кг' }),
    ]);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups.map((g) => [g.unit, g.n, g.average])).toEqual([
      ['кг', 2, 1500],
      ['шт', 3, 20],
    ]);
  });

  test('разные позиции заявки не смешиваются', () => {
    const prices = [
      ...[10, 20, 30].map((amount) => rub(amount, { item: 'Болт' })),
      ...[100, 200].map((amount) => rub(amount, { item: 'Гайка' })),
    ];
    const result = computeMarketAverage(prices);
    if (result.status !== 'ok') throw new Error('ожидалось ok');
    expect(result.groups.map((g) => [g.item, g.n])).toEqual([
      ['Болт', 3],
      ['Гайка', 2],
    ]);
  });

  test('запись с прежним too_few читается как «нет данных»', () => {
    const legacy = { status: 'too_few', found: 2, minSamples: 3 };
    expect(marketAverageSchema.parse(legacy)).toEqual({ status: 'none' });
  });

  test('прежняя запись ok с порогом читается без лишних полей', () => {
    const legacy = {
      status: 'ok',
      found: 3,
      minSamples: 3,
      belowThreshold: 0,
      groups: [{ currency: 'RUB', n: 3, average: 2, min: 1, max: 3 }],
    };
    expect(marketAverageSchema.parse(legacy)).toEqual({
      status: 'ok',
      found: 3,
      groups: legacy.groups,
    });
  });

  test('результат проходит собственную схему', () => {
    const result = computeMarketAverage([rub(1), rub(2), rub(3)]);
    expect(marketAverageSchema.parse(result)).toEqual(result);
    expect(marketAverageSchema.parse({ status: 'none' })).toEqual({ status: 'none' });
  });
});

describe('приблизительные цены', () => {
  test('не входят в среднюю по базе', () => {
    const result = computeMarketAverage([
      { amount: 100, currency: 'RUB' },
      { amount: 900, currency: 'RUB', approximate: true },
    ]);
    expect(result.status === 'ok' ? result.groups[0]?.average : null).toBe(100);
    expect(computeMarketAverage([{ amount: 5, currency: 'RUB', approximate: true }]).status).toBe(
      'none',
    );
  });
});

describe('форматирование цены', () => {
  test('тысячи пробелом, запятая, копейки только если есть', () => {
    expect(formatPriceAmount(1250)).toBe('1 250');
    expect(formatPriceAmount(1234567.5)).toBe('1 234 567,50');
    expect(formatPriceAmount(0.5)).toBe('0,50');
    expect(formatPrice({ amount: 12, currency: 'RUB', unit: 'шт' })).toBe('12 RUB/шт');
  });
});
