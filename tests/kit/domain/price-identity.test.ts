import { describe, expect, test } from 'bun:test';
import {
  diffPrices,
  findPriceJumps,
  nextConfirmedPrices,
  normalizeProductName,
  normalizeSku,
  priceItemKey,
} from '../../../src/kit/domain/price-diff';
import { matchPriceItem } from '../../../src/kit/domain/price-match';
import { validatePriceImport } from '../../../src/kit/domain/validators.owned';
import { item } from './support/price-fixtures';

describe('D-2: правило нормализации ключа позиции', () => {
  test('артикул: регистр, NFKC, виды тире, пробелы по краям и вокруг дефиса', () => {
    expect(normalizeSku('ab-1')).toBe(normalizeSku('AB-1'));
    expect(normalizeSku('  AB-1 ')).toBe(normalizeSku('AB-1'));
    expect(normalizeSku('AB–1')).toBe(normalizeSku('AB-1'));
    expect(normalizeSku('AB - 1')).toBe(normalizeSku('AB-1'));
    // Полноширинные символы (NFKC) - те же знаки.
    expect(normalizeSku('ＡＢ-１')).toBe(normalizeSku('AB-1'));
    expect(normalizeSku('AB  1')).toBe(normalizeSku('AB 1'));
  });

  test('разные артикулы не склеиваются', () => {
    const distinct = ['AB-1', 'AB1', 'AB 1', 'A-B1', 'AB-10', 'AB-1/2', 'AB.1', 'AB_1'];
    expect(new Set(distinct.map(normalizeSku)).size).toBe(distinct.length);
    // Кириллица и латиница не приравниваются: совпадение тогда ищется по названию.
    expect(normalizeSku('АВ-1')).not.toBe(normalizeSku('AB-1'));
  });

  test('название: регистр, «ё/е», пробелы, тире; разные названия остаются разными', () => {
    expect(normalizeProductName('  Ёмкость   10 л ')).toBe(normalizeProductName('емкость 10 л'));
    expect(normalizeProductName('Болт М8—40')).toBe(normalizeProductName('болт м8-40'));
    expect(normalizeProductName('Болт М8')).not.toBe(normalizeProductName('Болт М80'));
    expect(normalizeProductName('Болт М8')).not.toBe(normalizeProductName('БолтМ8'));
  });

  test('ключ позиции: артикул и название в разных пространствах', () => {
    expect(priceItemKey({ sku: 'ab-1', productName: 'Болт' })).toBe(
      priceItemKey({ sku: ' AB-1', productName: 'Другое' }),
    );
    expect(priceItemKey({ productName: 'ab-1' })).not.toBe(
      priceItemKey({ sku: 'ab-1', productName: 'Болт' }),
    );
  });
});

describe('D-2: скачок не прячется за сменой ключа или валюты', () => {
  const existing = [item('Болт М8', 100, { sku: 'AB-1' })];

  test('пропал артикул: сверка по названию, скачок найден', () => {
    const jumps = findPriceJumps([item('Болт М8', 220)], existing);
    expect(jumps.map((j) => [j.oldPrice, j.newPrice])).toEqual([[100, 220]]);
  });

  test('сменился регистр артикула: скачок найден', () => {
    const jumps = findPriceJumps([item('Болт М8', 220, { sku: 'ab-1' })], existing);
    expect(jumps).toHaveLength(1);
  });

  test('сменился артикул при том же названии: скачок найден', () => {
    const jumps = findPriceJumps([item('болт  м8', 220, { sku: 'ZZ-9' })], existing);
    expect(jumps).toHaveLength(1);
  });

  test('смена валюты - скачок независимо от числа', () => {
    const jumps = findPriceJumps(
      [item('Болт М8', 100, { sku: 'AB-1', currency: 'USD' })],
      existing,
    );
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ oldCurrency: 'RUB', currency: 'USD' });
    const issues = validatePriceImport({
      sourceRowCount: 1,
      imported: [item('Болт М8', 100, { sku: 'AB-1', currency: 'USD' })],
      existing,
    });
    expect(issues.map((i) => i.code)).toEqual(['price_jump']);
  });

  test('пара «снята + добавлена» с тем же названием - изменение, а не две операции', () => {
    const diff = diffPrices(existing, [item('Болт М8', 220)]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.jumps).toHaveLength(1);
    expect(diff.review.map((r) => r.reason)).toContain('sku_changed');
  });

  test('тот же артикул в другом регистре: изменение, без add/remove', () => {
    const diff = diffPrices(existing, [item('Болт М8', 101, { sku: 'ab-1' })]);
    expect([diff.added.length, diff.removed.length, diff.changed.length]).toEqual([0, 0, 1]);
  });

  test('новый артикул с известным названием: новая позиция, цена сверяется с одноимённой', () => {
    const incoming = [item('Болт М8', 100, { sku: 'AB-1' }), item('Болт М8', 500, { sku: 'AB-2' })];
    const diff = diffPrices(existing, incoming);
    expect(diff.added.map((i) => i.sku)).toEqual(['AB-2']);
    expect(diff.removed).toEqual([]);
    // Иначе цену «Болт М8» можно поднять в два шага: добавить дорогой дубль, затем снять старый.
    expect(diff.jumps.map((j) => [j.sku, j.oldPrice, j.newPrice])).toEqual([['AB-2', 100, 500]]);
    expect(diff.review.map((r) => r.reason)).toContain('same_name_different_sku');
    const close = [item('Болт М8', 100, { sku: 'AB-1' }), item('Болт М8', 120, { sku: 'AB-2' })];
    expect(diffPrices(existing, close).jumps).toEqual([]);
  });

  test('несколько позиций с тем же названием: сверка с каждой, скачок от любой', () => {
    const base = [item('Болт', 10, { sku: 'B1' }), item('Болт', 100, { sku: 'B2' })];
    const jumps = findPriceJumps([item('Болт', 100)], base);
    expect(jumps.map((j) => j.oldPrice)).toEqual([10]);
  });

  test('подтверждённая человеком цена: нарезка по 49% даёт скачок на втором шаге', () => {
    const confirmed = [item('Болт М8', 100, { sku: 'AB-1' })];
    const afterFirstStep = [item('Болт М8', 149, { sku: 'AB-1' })];
    expect(findPriceJumps(afterFirstStep, existing, undefined, confirmed)).toEqual([]);
    const second = findPriceJumps(
      [item('Болт М8', 220, { sku: 'AB-1' })],
      afterFirstStep,
      undefined,
      confirmed,
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ oldPrice: 149, newPrice: 220, confirmedPrice: 100 });
  });

  test('позицию сняли и вернули дороже: скачок от подтверждённой цены', () => {
    const confirmed = [item('Болт М8', 100, { sku: 'AB-1' })];
    const jumps = findPriceJumps([item('Болт М8', 300, { sku: 'AB-1' })], [], undefined, confirmed);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ oldPrice: 100, newPrice: 300 });
  });
});

describe('nextConfirmedPrices', () => {
  const key = (sku: string): string => priceItemKey({ sku, productName: '' });

  test('первая цена запоминается, неподтверждённые изменения её не двигают', () => {
    const first = nextConfirmedPrices([], [], [item('Болт', 100, { sku: 'B1' })], new Set());
    expect(first.map((i) => i.price)).toEqual([100]);
    const second = nextConfirmedPrices(
      first,
      [item('Болт', 100, { sku: 'B1' })],
      [item('Болт', 149, { sku: 'B1' })],
      new Set(),
    );
    expect(second.map((i) => i.price)).toEqual([100]);
  });

  test('принятый человеком скачок становится новой подтверждённой ценой', () => {
    const confirmed = [item('Болт', 100, { sku: 'B1' })];
    const next = nextConfirmedPrices(
      confirmed,
      confirmed,
      [item('Болт', 300, { sku: 'B1' })],
      new Set([key('B1')]),
    );
    expect(next.map((i) => i.price)).toEqual([300]);
  });

  test('позиция уже была в базе без подтверждённой цены: запоминается цена до импорта', () => {
    const next = nextConfirmedPrices(
      [],
      [item('Болт', 100, { sku: 'B1' })],
      [item('Болт', 140, { sku: 'B1' })],
      new Set(),
    );
    expect(next.map((i) => i.price)).toEqual([100]);
  });

  test('R3-ALG-17: смена артикула переносит подтверждённую цену под новый ключ', () => {
    const confirmed = [item('Болт', 100, { sku: 'OLD-1' })];
    const next = nextConfirmedPrices(
      confirmed,
      confirmed,
      [item('Болт', 120, { sku: 'NEW-1' })],
      new Set(),
    );
    expect(next.map((i) => [i.sku, i.price])).toEqual([['NEW-1', 100]]);
  });

  test('R3-ALG-17: принятый скачок при смене артикула не оставляет старый ключ', () => {
    const confirmed = [item('Болт', 100, { sku: 'OLD-1' })];
    const next = nextConfirmedPrices(
      confirmed,
      confirmed,
      [item('Болт', 300, { sku: 'NEW-1' })],
      new Set([key('NEW-1')]),
    );
    expect(next.map((i) => [i.sku, i.price])).toEqual([['NEW-1', 300]]);
  });

  test('R3-ALG-17: старый артикул, оставшийся в прайсе, не переносится', () => {
    const confirmed = [item('Болт', 100, { sku: 'OLD-1' })];
    const next = nextConfirmedPrices(
      confirmed,
      confirmed,
      [item('Болт', 100, { sku: 'OLD-1' }), item('Болт', 120, { sku: 'NEW-1' })],
      new Set(),
    );
    expect(next.map((i) => [i.sku, i.price])).toEqual([['OLD-1', 100]]);
  });

  test('снятая позиция сохраняет подтверждённую цену', () => {
    const confirmed = [item('Болт', 100, { sku: 'B1' })];
    const next = nextConfirmedPrices(
      confirmed,
      confirmed,
      [item('Гайка', 5, { sku: 'G1' })],
      new Set(),
    );
    expect(next.map((i) => [i.sku, i.price]).sort()).toEqual([
      ['B1', 100],
      ['G1', 5],
    ]);
  });
});

describe('D-13: названный артикул не подменяется названием', () => {
  const items = [item('Болт М8', 10, { sku: 'B1' }), item('Гайка М8', 5, { sku: 'G1' })];

  test('артикул не найден: «не найдено» с кандидатами, даже если название совпало точно', () => {
    const found = matchPriceItem(items, { sku: 'B9', productName: 'Гайка М8' });
    expect(found.kind).toBe('none');
    expect(found.kind === 'none' && found.candidates.map((c) => c.sku)).toEqual(['G1']);
  });

  test('артикул найден без учёта регистра; без артикула поиск по названию как раньше', () => {
    expect(matchPriceItem(items, { sku: ' b1 ' })).toMatchObject({ kind: 'match' });
    expect(matchPriceItem(items, { productName: 'гайка  м8' })).toMatchObject({ kind: 'match' });
  });

  test('артикул и название указывают на разные позиции: неоднозначно, обе в кандидатах', () => {
    const found = matchPriceItem(items, { sku: 'B1', productName: 'Гайка М8' });
    expect(found.kind).toBe('ambiguous');
  });

  test('R3-ALG-18: название похоже на другую позицию, а не на найденную по артикулу', () => {
    const found = matchPriceItem(items, { sku: 'B1', productName: 'Гайка' });
    expect(found.kind).toBe('ambiguous');
    expect(found.kind === 'ambiguous' && found.candidates.map((c) => c.sku)).toEqual(['B1', 'G1']);
  });

  test('R3-ALG-18: название похоже на найденную позицию - совпадение', () => {
    expect(matchPriceItem(items, { sku: 'B1', productName: 'Болт' }).kind).toBe('match');
  });
});
