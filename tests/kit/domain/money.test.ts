import { describe, expect, test } from 'bun:test';
import {
  deviationExceeds,
  lineCents,
  roundMoney,
  sameMoney,
  sumLineCents,
  toMinorUnits,
} from '../../../src/kit/domain/money';

describe('деньги в копейках', () => {
  test('округление по десятичной записи, а не по хвосту двоичной дроби', () => {
    expect(toMinorUnits(1.005)).toBe(101);
    expect(toMinorUnits(0.285)).toBe(29);
    expect(toMinorUnits(-1.005)).toBe(-101);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1.005)).toBe(1.01);
  });

  test('сумма строки: количество × цена с округлением', () => {
    expect(lineCents(3, 0.1)).toBe(30);
    expect(lineCents(0.125, 10.1)).toBe(126);
    expect(sumLineCents([{ quantity: 3, unitPrice: 0.335 }, { quantity: 1, unitPrice: 0.1 }])).toBe(
      101 + 10,
    );
  });

  test('допуск одна копейка в целых копейках', () => {
    expect(sameMoney(100.01, 100)).toBe(true);
    expect(sameMoney(0.3, 0.1 + 0.2)).toBe(true);
    expect(sameMoney(100.02, 100)).toBe(false);
    // Разность 0.01 в двоичной дроби бывает чуть больше 0.01: в копейках это ровно 1.
    expect(sameMoney(1.01, 1.0)).toBe(true);
  });

  test('скачок: ровно порог - не скачок, порог и чуть больше - скачок', () => {
    expect(deviationExceeds(0.3, 0.45, 0.5)).toBe(false);
    expect(deviationExceeds(100, 150, 0.5)).toBe(false);
    expect(deviationExceeds(100, 150.01, 0.5)).toBe(true);
    expect(deviationExceeds(100, 49.99, 0.5)).toBe(true);
    expect(deviationExceeds(0.58, 0.9164, 0.58)).toBe(false);
    expect(deviationExceeds(100, 100, 0.5)).toBe(false);
    // Мелкие цены (меньше копейки) сравниваются точно, а не схлопываются в ноль.
    expect(deviationExceeds(0.00004, 0.00006, 0.5)).toBe(false);
    expect(deviationExceeds(0.00004, 0.000061, 0.5)).toBe(true);
  });
});
