import { describe, expect, test } from 'bun:test';
import {
  OKVED_PATTERN,
  normalizeOkved,
  parseDiscountPercent,
  parsePackagingKind,
  parseTurnoverByYear,
  parseTurnoverRub,
  parseVat,
} from '../../../src/kit/domain/supplier-card-values';
import {
  DISCOUNT_CASES,
  OKVED_CASES,
  PACKAGING_CASES,
  TURNOVER_CASES,
  VAT_CASES,
} from '../support/supplier-value-cases';

describe('разбор значений карточки поставщика (таблицы случаев)', () => {
  test.each(VAT_CASES)('НДС %p', (input, expected) => {
    const result = parseVat(input);
    if (expected === null) {
      expect(result.ok).toBe(false);
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe(expected.mode);
    expect(result.ratePercent).toBe(expected.rate);
  });

  test.each(DISCOUNT_CASES)('скидка %p', (input, expected) => {
    const result = parseDiscountPercent(input);
    expect(result.ok ? result.value : null).toBe(expected);
  });

  test.each(TURNOVER_CASES)('оборот %p', (input, expected) => {
    const result = parseTurnoverRub(input);
    expect(result.ok ? result.value : null).toBe(expected);
  });

  test.each(OKVED_CASES)('ОКВЭД %p', (input, expected) => {
    const result = normalizeOkved(input);
    expect(result.ok ? result.code : null).toBe(expected);
  });

  test.each(PACKAGING_CASES)('упаковка %p', (input, expected) => {
    const result = parsePackagingKind(input);
    expect(result.status === 'ok' ? result.kind : result.status).toBe(expected);
  });

  test('шаблон ОКВЭД 2: допустимые формы и отказ остальным', () => {
    for (const ok of ['01', '99', '47.1', '47.19', '47.19.1', '47.19.12']) {
      expect(OKVED_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['00', '4', '470', '47.', '47.1.2', '47.190', '47.19.123', '47.19.', 'a7']) {
      expect(OKVED_PATTERN.test(bad)).toBe(false);
    }
  });

  test('нулевая ставка плательщика и «без НДС» - разные значения', () => {
    expect(parseVat('0')).toEqual({ ok: true, mode: 'with_vat', ratePercent: 0 });
    expect(parseVat('без НДС')).toEqual({ ok: true, mode: 'no_vat' });
  });
});

describe('оборот по годам (разд. 10.9)', () => {
  const CASES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]> | null]> = [
    ['2025: 150 млн', [[2025, 150_000_000]]],
    ['2024: 120 млн; 2025: 150 млн', [[2025, 150_000_000], [2024, 120_000_000]]],
    ['2025 г. - 1,5 млрд, 2024 г. - 900 млн', [[2025, 1_500_000_000], [2024, 900_000_000]]],
    ['150 млн (2025)\n120 млн за 2024 г.', [[2025, 150_000_000], [2024, 120_000_000]]],
    ['2025 = 500 000 000 руб.', [[2025, 500_000_000]]],
    ['150 млн', null],
    ['2025: много', null],
    ['2025: 150 млн; 2025: 120 млн', null],
    ['2025', null],
    ['2025:', null],
    ['', null],
  ];

  test.each(CASES)('%p', (input, expected) => {
    const result = parseTurnoverByYear(input);
    if (expected === null) {
      expect(result.ok).toBe(false);
      return;
    }
    expect(result.ok ? result.years.map((item) => [item.year, item.rub]) : null).toEqual(
      expected.map((pair) => [...pair]),
    );
  });
});
