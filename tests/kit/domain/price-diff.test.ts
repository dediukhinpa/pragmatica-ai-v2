import { describe, expect, test } from 'bun:test';
import { diffPrices, findPriceJumps } from '../../../src/kit/domain/price-diff';
import { isPriceStale, lastPriceUpdate } from '../../../src/kit/domain/price-schedule';
import { matchPriceItem } from '../../../src/kit/domain/price-match';
import { validatePriceImport } from '../../../src/kit/domain/validators.owned';
import { OLD_DATE, item } from './support/price-fixtures';

/** Дней без обновления, при которых прайс ещё свежий (порог - три календарных месяца). */
const FRESH_DAYS = 10;
const NEW_DATE = '2026-02-01T00:00:00.000Z';

describe('diffPrices', () => {
  test('новые, снятые, изменившиеся и неизменные позиции', () => {
    const existing = [
      item('Болт', 10, { sku: 'B1' }),
      item('Гайка', 5, { sku: 'G1' }),
      item('Шайба', 1, { sku: 'S1' }),
    ];
    const incoming = [
      item('Болт', 11, { sku: 'B1' }),
      item('Гайка', 5, { sku: 'G1' }),
      item('Винт', 7, { sku: 'V1' }),
    ];
    const diff = diffPrices(existing, incoming);
    expect(diff.added.map((i) => i.sku)).toEqual(['V1']);
    expect(diff.removed.map((i) => i.sku)).toEqual(['S1']);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ sku: 'B1', oldPrice: 10, newPrice: 11, changePct: 10 });
    expect(diff.unchanged).toBe(1);
    expect(diff.jumps).toEqual([]);
  });

  test('скачок сверх порога попадает в jumps и на проверку', () => {
    const diff = diffPrices([item('Болт', 10, { sku: 'B1' })], [item('Болт', 40, { sku: 'B1' })]);
    expect(diff.jumps.map((j) => j.changePct)).toEqual([300]);
    expect(diff.review).toEqual([
      { key: 'sku:b1', productName: 'Болт', sku: 'B1', reason: 'price_jump' },
    ]);
  });

  test('изменение ровно на пороге не скачок', () => {
    const diff = diffPrices([item('Болт', 10, { sku: 'B1' })], [item('Болт', 15, { sku: 'B1' })]);
    expect(diff.jumps).toEqual([]);
  });

  test('без артикула: на проверку только новые и изменившиеся, неизменные не шумят', () => {
    const existing = [item('Гайка', 5), item('Болт', 10)];
    const incoming = [item('Гайка', 5), item('Болт', 11), item('Винт', 3)];
    const reasons = diffPrices(existing, incoming).review.map((r) => [r.productName, r.reason]);
    expect(reasons).toEqual([
      ['Болт', 'no_sku'],
      ['Винт', 'no_sku'],
    ]);
  });

  test('дубль, одно название с разными артикулами и смена валюты', () => {
    const existing = [item('Болт', 10, { sku: 'B1' })];
    const incoming = [
      item('Болт', 10, { sku: 'B1', currency: 'USD' }),
      item('Болт', 10, { sku: 'B1' }),
      item('Болт', 12, { sku: 'B2' }),
    ];
    const reasons = diffPrices(existing, incoming).review.map((r) => r.reason);
    expect(reasons).toContain('duplicate');
    expect(reasons).toContain('same_name_different_sku');
    expect(reasons).toContain('currency_changed');
  });

  test('история в базе: сравнение с последней по дате ценой', () => {
    const existing = [
      item('Болт', 10, { sku: 'B1' }),
      item('Болт', 20, { sku: 'B1', date: NEW_DATE }),
    ];
    expect(diffPrices(existing, [item('Болт', 20, { sku: 'B1' })]).unchanged).toBe(1);
  });
});

describe('findPriceJumps и validatePriceImport', () => {
  test('валидатор импорта и diff определяют скачок одинаково', () => {
    const existing = [item('Болт', 10), item('Гайка', 100)];
    const imported = [item('Болт', 40), item('Гайка', 101)];
    const jumps = findPriceJumps(imported, existing);
    const issues = validatePriceImport({ sourceRowCount: 2, imported, existing });
    expect(jumps.map((j) => j.productName)).toEqual(['Болт']);
    expect(issues.filter((i) => i.code === 'price_jump')).toHaveLength(jumps.length);
  });
});

describe('matchPriceItem', () => {
  const items = [
    item('Болт М8', 10, { sku: 'B8' }),
    item('Болт М10', 12, { sku: 'B10' }),
    item('Гайка', 5),
    item('Гайка', 6, { sku: 'G2' }),
  ];

  test('по артикулу и по точному названию', () => {
    expect(matchPriceItem(items, { sku: ' b8 ' })).toMatchObject({ kind: 'match' });
    expect(matchPriceItem(items, { productName: 'болт  м10' })).toMatchObject({ kind: 'match' });
  });

  test('приблизительное название не совпадение: кандидаты', () => {
    const found = matchPriceItem(items, { productName: 'Болт' });
    expect(found.kind).toBe('none');
    expect(found.kind === 'none' ? found.candidates.length : 0).toBe(2);
  });

  test('несколько позиций с одним названием: неоднозначно', () => {
    expect(matchPriceItem(items, { productName: 'Гайка' }).kind).toBe('ambiguous');
  });

  test('ничего не указано: none без кандидатов', () => {
    expect(matchPriceItem(items, {})).toEqual({ kind: 'none', candidates: [] });
  });
});

describe('график обновлений', () => {
  test('lastPriceUpdate и isPriceStale', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(lastPriceUpdate([])).toBeNull();
    expect(lastPriceUpdate([item('a', 1), item('b', 1, { date: NEW_DATE })])).toBe(NEW_DATE);
    expect(isPriceStale(null, now)).toBe(true);
    expect(isPriceStale(OLD_DATE, now)).toBe(true);
    const fresh = new Date(now.getTime() - FRESH_DAYS * 86_400_000).toISOString();
    expect(isPriceStale(fresh, now)).toBe(false);
  });
});

describe('R3-ALG-22: порог скачка в целых', () => {
  const jumps = (oldPrice: number, newPrice: number, threshold?: number) =>
    findPriceJumps(
      [item('Болт', newPrice, { sku: 'B1' })],
      [item('Болт', oldPrice, { sku: 'B1' })],
      threshold,
    );

  test('ровно +50% и -50% не скачок, как бы ни легла двоичная дробь', () => {
    expect(jumps(0.3, 0.45)).toEqual([]);
    expect(jumps(0.3, 0.15)).toEqual([]);
    expect(jumps(1, 1.5)).toEqual([]);
  });

  test('чуть больше порога - скачок, процент округлён до сотых', () => {
    const result = jumps(0.3, 0.4501);
    expect(result).toHaveLength(1);
    expect(result[0]?.changePct).toBe(50.03);
  });

  test('другой порог тоже сравнивается в целых', () => {
    expect(jumps(0.58, 0.9164, 0.58)).toEqual([]);
    expect(jumps(0.58, 0.9165, 0.58)).toHaveLength(1);
  });
});
