import { describe, expect, test } from 'bun:test';
import { withHexLetter } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { rng } from '@business-ai/testing';

/** Эталон: FNV-1a 64 бита на BigInt, как было до этапа 30 (формат ключей в базе тот же). */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const HEX_RADIX = 16;
const HASH_HEX_LENGTH = 16;

function referenceFnv(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash ^ BigInt(text.charCodeAt(index))) * FNV_PRIME) & UINT64_MASK;
  }
  return withHexLetter(hash.toString(HEX_RADIX).padStart(HASH_HEX_LENGTH, '0'));
}

/** Эталон отпечатка для строки: stableHash строки хэширует её JSON-представление. */
const referenceOfString = (value: string): string => referenceFnv(JSON.stringify(value));

describe('stableHash: значение побитово совпадает с эталоном на BigInt', () => {
  test('граничные входы: пусто, кириллица, суррогатные пары, управляющие символы', () => {
    const inputs = [
      '',
      'a',
      'Болт М8 оцинк.',
      'ёЁ',
      '😀',
      'a😀b',
      '\ud83d',
      '\ude00',
      '\u0000\u001f\u007f￿',
      'x'.repeat(10000),
      'Привет, мир! '.repeat(500),
    ];
    for (const input of inputs) {
      expect(stableHash(input)).toBe(referenceOfString(input));
    }
  });

  test('случайные строки по всему диапазону UTF-16', () => {
    const random = rng(42);
    for (let round = 0; round < 500; round += 1) {
      const length = Math.floor(random() * 200);
      let text = '';
      for (let i = 0; i < length; i += 1) {
        text += String.fromCharCode(Math.floor(random() * 0x10000));
      }
      expect(stableHash(text)).toBe(referenceOfString(text));
    }
  });

  test('структуры: ключи по алфавиту, undefined отброшен, Date/Map/Set', () => {
    const value = {
      b: [1, 'два', { я: null, a: undefined }],
      a: new Map([['k', new Set([1, 2])]]),
      d: new Date(0),
    };
    const canonicalText = JSON.stringify({
      a: { $map: [['k', { $set: [1, 2] }]] },
      b: [1, 'два', { я: null }],
      d: { $date: 0 },
    });
    expect(stableHash(value)).toBe(referenceFnv(canonicalText));
    expect(stableHash(undefined)).toBe(referenceFnv(''));
  });

  test('быстрее эталона на BigInt', () => {
    const text = 'Болт М8 оцинк. 40 мм, ящик 100 шт; '.repeat(40000);
    const MIN_SPEEDUP = 2;
    let started = performance.now();
    const fresh = stableHash(text);
    const freshMs = performance.now() - started;
    started = performance.now();
    const old = referenceOfString(text);
    const oldMs = performance.now() - started;
    expect(fresh).toBe(old);
    expect(freshMs * MIN_SPEEDUP).toBeLessThan(oldMs);
  });
});
