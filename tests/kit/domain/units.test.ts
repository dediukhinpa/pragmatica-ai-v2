import { describe, expect, test } from 'bun:test';
import { computeMarketAverage, formatPrice } from '../../../src/kit/domain/market-price';
import {
  normalizeUnit,
  piecesInUnit,
  sameUnit,
  splitUnitText,
  unitSuffix,
} from '../../../src/kit/domain/units';
import { parseWebPageFacts } from '../../../src/kit/domain/web-candidate';

describe('normalizeUnit', () => {
  test('синонимы сводятся к краткой форме', () => {
    expect(normalizeUnit('Штука')).toBe('шт');
    expect(normalizeUnit(' шт. ')).toBe('шт');
    expect(normalizeUnit('тонна')).toBe('т');
    expect(normalizeUnit('п.м.')).toBe('м');
    expect(normalizeUnit('кв. м')).toBe('м2');
    expect(normalizeUnit('М²')).toBe('м2');
  });

  test('разные единицы остаются разными, незнакомая сравнивается как записана', () => {
    expect(sameUnit('упаковка', 'шт')).toBe(false);
    expect(sameUnit('кг', 'т')).toBe(false);
    expect(sameUnit('Бидон', 'бидон.')).toBe(true);
    expect(sameUnit('бидон', 'шт')).toBe(false);
  });
});

describe('единицы с сайтов: показ отдельно от ключа сравнения', () => {
  test('строки из боя 29.10 читаются по-человечески', () => {
    expect(splitUnitText('за100г')).toEqual({ unit: '100 г' });
    expect(splitUnitText('забанку70гр')).toEqual({ unit: 'банку 70 г' });
    expect(splitUnitText('закг(минимальныйзаказ32кг)')).toEqual({
      unit: 'кг',
      note: 'минимальный заказ 32 кг',
    });
    expect(unitSuffix('за100г')).toBe(' за 100 г');
    expect(unitSuffix('забанку70гр')).toBe(' за банку 70 г');
    expect(unitSuffix('закг(минимальныйзаказ32кг)')).toBe('/кг');
    expect(formatPrice({ amount: 180, currency: '₽', unit: 'за100г' })).toBe('180 ₽ за 100 г');
    expect(formatPrice({ amount: 255, currency: '₽', unit: 'кг' })).toBe('255 ₽/кг');
  });

  test('условия и длинный хвост уходят в пометку, «за» в начале убирается', () => {
    expect(splitUnitText('кг при заказе от 15 кг: 10 275 руб')).toEqual({
      unit: 'кг',
      note: 'при заказе от 15 кг: 10 275 руб',
    });
    expect(splitUnitText('за кг')).toEqual({ unit: 'кг' });
    expect(splitUnitText('заготовка')).toEqual({ unit: 'заготовка' });
    expect(splitUnitText('м2')).toEqual({ unit: 'м2' });
    expect(splitUnitText('упаковка сорока разных сортов по цене одного')).toHaveProperty('note');
  });

  test('ключ сравнения одинаков для разных записей одной фасовки', () => {
    expect(normalizeUnit('банка 70 г')).toBe(normalizeUnit('забанку70гр'));
    expect(normalizeUnit('100 гр')).toBe(normalizeUnit('за100г'));
    expect(normalizeUnit('закг(минимальныйзаказ32кг)')).toBe('кг');
    expect(sameUnit('100 г', 'кг')).toBe(false);
  });

  test('разбор страницы хранит читаемую единицу и пометку, группы средней — по ключу', () => {
    const facts = parseWebPageFacts({
      prices: [
        { item: 'мёд', amount: 255, currency: 'RUB', unit: 'закг(минимальныйзаказ32кг)' },
        { item: 'мёд', amount: 300, currency: 'RUB', unit: 'килограмм', note: 'розница' },
        { item: 'орех', amount: 83, currency: 'RUB', unit: 'забанку70гр' },
        { item: 'орех', amount: 90, currency: 'RUB', unit: 'банка 70 г' },
      ],
    });
    const prices = facts.prices ?? [];
    expect(prices[0]).toMatchObject({ unit: 'кг', note: 'минимальный заказ 32 кг' });
    expect(prices[1]).toMatchObject({ unit: 'кг', note: 'розница' });
    expect(prices[2]).toMatchObject({ unit: 'банку 70 г' });
    const average = computeMarketAverage(prices);
    expect(average.status === 'ok' ? average.groups.map((g) => g.n) : []).toEqual([2, 2]);
  });
});

describe('фасовка с тарой и цена упаковки (бой 29.10)', () => {
  test('«банка 250 г» и «250 г» - одна фасовка; без количества тара остаётся', () => {
    expect(normalizeUnit('банка 250 г')).toBe(normalizeUnit('250 г'));
    expect(normalizeUnit('упаковка 16 шт')).toBe('16шт');
    expect(normalizeUnit('банка')).toBe('банка');
    expect(normalizeUnit('банка 250 г мёда')).not.toBe(normalizeUnit('250 г'));
  });

  test('штук в фасовке: только больше одной', () => {
    expect(piecesInUnit('упаковка 16 шт')).toBe(16);
    expect(piecesInUnit('9шт')).toBe(9);
    expect(piecesInUnit('шт')).toBeUndefined();
    expect(piecesInUnit('1 шт')).toBeUndefined();
    expect(piecesInUnit('250 г')).toBeUndefined();
  });

  test('средняя: упаковка 16 шт считается за штуку, банки 250 г - одной группой', () => {
    const average = computeMarketAverage([
      { item: 'мёд', amount: 2640, currency: 'RUB', unit: 'упаковка 16 шт' },
      { item: 'мёд', amount: 335, currency: 'RUB', unit: 'шт' },
      { item: 'мёд', amount: 607, currency: 'RUB', unit: '250 г' },
      { item: 'мёд', amount: 375, currency: 'RUB', unit: 'банка 250 г' },
    ]);
    if (average.status !== 'ok') throw new Error('нет средней');
    expect(average.groups.map((group) => [group.unit, group.n, group.average])).toEqual([
      ['250 г', 2, 491],
      ['шт', 2, 250],
    ]);
  });
});
