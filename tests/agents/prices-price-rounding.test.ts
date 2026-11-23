import { describe, expect, test } from 'bun:test';
import { findDigitSeries } from '@business-ai/core';
import {
  PRICE_FRACTION_DIGITS,
  parsePriceCell,
  roundPrice,
} from '../../src/agents/prices/table-rows';

/** Число цифр после точки в записи числа, как её видит модель в JSON. */
function fractionDigits(value: number): number {
  return (String(value).split('.')[1] ?? '').length;
}

describe('округление цены при разборе ячейки', () => {
  test('хвост плавающей точки из формулы отрезается', () => {
    const cell = parsePriceCell('266.66666666666666');
    expect(cell).toEqual({ kind: 'ok', value: 266.6667, currency: undefined });
  });

  test('дробная часть из 10 цифр (похожа на ИНН) до модели не доходит', () => {
    const cell = parsePriceCell('12,7707083893');
    expect(cell.kind).toBe('ok');
    const value = cell.kind === 'ok' ? cell.value : 0;
    expect(fractionDigits(value)).toBeLessThanOrEqual(PRICE_FRACTION_DIGITS);
    expect(findDigitSeries(JSON.stringify({ price: value }))).toEqual([]);
  });

  test('доли копейки сохраняются, обычная цена не меняется', () => {
    expect(roundPrice(0.0345)).toBe(0.0345);
    expect(parsePriceCell('1 234,50 руб.')).toEqual({ kind: 'ok', value: 1234.5, currency: 'RUB' });
  });

  test('цена, которая округляется в ноль, - нулевая', () => {
    expect(parsePriceCell('0,00001')).toEqual({ kind: 'zero' });
  });
});
