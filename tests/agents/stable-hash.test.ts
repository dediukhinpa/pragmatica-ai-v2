import { describe, expect, test } from 'bun:test';
import { encodeIdentifiers, findDigitSeries, stableHash } from '@business-ai/core';

/** Вход, у которого FNV-1a даёт 16 цифр без единой буквы (найден перебором). */
const DIGITS_ONLY_INPUT = ['digits', 1151];
const SAMPLE_COUNT = 5_000;

describe('stableHash', () => {
  test('16 hex-символов, одинаковых для одинаковых данных при любом порядке ключей', () => {
    const hash = stableHash({ b: 1, a: [1, 2, { d: undefined, c: 'x' }] });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash({ a: [1, 2, { c: 'x' }], b: 1 })).toBe(hash);
    expect(stableHash({ a: [2, 1, { c: 'x' }], b: 1 })).not.toBe(hash);
  });

  test('R3-ALG-33: Date, Map и Set не совпадают с пустым объектом и друг с другом', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(stableHash({ at: date })).not.toBe(stableHash({ at: {} }));
    expect(stableHash({ at: date })).not.toBe(stableHash({ at: date.toISOString() }));
    expect(stableHash({ at: date })).not.toBe(stableHash({ at: new Date('2026-01-02') }));
    expect(stableHash({ at: date })).toBe(stableHash({ at: new Date(date.getTime()) }));
    expect(stableHash(new Map([['a', 1]]))).not.toBe(stableHash({}));
    expect(stableHash(new Set([1]))).not.toBe(stableHash([1]));
    expect(stableHash(new Set([1]))).not.toBe(stableHash(new Map([[1, 1]])));
  });

  test('данные без Date, Map и Set хэшируются как раньше', () => {
    expect(stableHash({ b: 1, a: [1, 2, { c: 'x' }] })).toBe(
      stableHash({ a: [1, 2, { c: 'x' }], b: 1 }),
    );
    expect(stableHash(DIGITS_ONLY_INPUT)).toBe('f398427837237413');
  });

  test('в отпечатке всегда есть буква: значение из одних цифр не выдаётся', () => {
    expect(stableHash(DIGITS_ONLY_INPUT)).toBe('f398427837237413');
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      expect(stableHash(['digits', index])).toMatch(/[a-f]/);
    }
  });

  test('после кодека ни один отпечаток не несёт серию цифр', () => {
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const id = `doc-${stableHash(['digits', index])}`;
      expect(findDigitSeries(encodeIdentifiers(id))).toEqual([]);
    }
  });
});
