import { describe, expect, test } from 'bun:test';
import {
  amountInWords,
  integerInWords,
  rublesInWords,
} from '../../../src/kit/domain/amount-in-words';
import { formatContractNumber } from '../../../src/kit/domain/contract-number';
import { vatRateOn } from '../../../src/kit/domain/vat';

describe('рубли прописью', () => {
  test.each([
    [0, 'ноль рублей'],
    [1, 'один рубль'],
    [2, 'два рубля'],
    [5, 'пять рублей'],
    [11, 'одиннадцать рублей'],
    [12, 'двенадцать рублей'],
    [13, 'тринадцать рублей'],
    [14, 'четырнадцать рублей'],
    [21, 'двадцать один рубль'],
    [22, 'двадцать два рубля'],
    [100, 'сто рублей'],
    [111, 'сто одиннадцать рублей'],
    [1000, 'одна тысяча рублей'],
    [2000, 'две тысячи рублей'],
    [5000, 'пять тысяч рублей'],
    [11_000, 'одиннадцать тысяч рублей'],
    [21_000, 'двадцать одна тысяча рублей'],
    [120_000, 'сто двадцать тысяч рублей'],
    [121_500, 'сто двадцать одна тысяча пятьсот рублей'],
    [1_000_000, 'один миллион рублей'],
    [2_000_001, 'два миллиона один рубль'],
    [1_000_000_000, 'один миллиард рублей'],
  ])('%d -> %s', (value, words) => {
    expect(rublesInWords(value)).toBe(words);
  });

  test('число без валюты и женский род для «тысяч» шаблона', () => {
    expect(integerInWords(120_000)).toBe('сто двадцать тысяч');
    expect(integerInWords(2, 'f')).toBe('две');
    expect(integerInWords(21, 'f')).toBe('двадцать одна');
    expect(integerInWords(2, 'm')).toBe('два');
  });

  test('не целое, отрицательное и слишком большое - не пропись', () => {
    expect(integerInWords(1.5)).toBeUndefined();
    expect(integerInWords(-1)).toBeUndefined();
    expect(integerInWords(1e13)).toBeUndefined();
  });

  test('сумма с копейками цифрами', () => {
    expect(amountInWords(0)).toBe('ноль рублей 00 копеек');
    expect(amountInWords(105)).toBe('один рубль 05 копеек');
    expect(amountInWords(12_345_067)).toBe(
      'сто двадцать три тысячи четыреста пятьдесят рублей 67 копеек',
    );
    expect(amountInWords(-1)).toBeUndefined();
  });
});

describe('ставка НДС по дате', () => {
  test('граница 2025-12-31 / 2026-01-01', () => {
    expect(vatRateOn('2025-12-31')).toBe(20);
    expect(vatRateOn('2026-01-01')).toBe(22);
  });

  test('история: 18% до 2019, 20% с 2019-01-01, время и Date', () => {
    expect(vatRateOn('2018-12-31')).toBe(18);
    expect(vatRateOn('2019-01-01')).toBe(20);
    expect(vatRateOn('2004-01-01')).toBe(18);
    expect(vatRateOn('2026-10-21T10:00:00.000Z')).toBe(22);
    expect(vatRateOn(new Date('2025-12-31T23:59:59.000Z'))).toBe(20);
  });

  test('до начала таблицы и не дата - нет ставки', () => {
    expect(vatRateOn('2003-12-31')).toBeUndefined();
    expect(vatRateOn('вчера')).toBeUndefined();
  });
});

describe('формат номера договора', () => {
  test('префикс юрлица, год и четыре цифры', () => {
    expect(formatContractNumber('mg', 2026, 7)).toBe('МГ-2026-0007');
    expect(formatContractNumber('pr', 2026, 12_345)).toBe('ПР-2026-12345');
    expect(() => formatContractNumber('xx', 2026, 1)).toThrow();
  });
});
