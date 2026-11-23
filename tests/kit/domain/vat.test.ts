import { describe, expect, test } from 'bun:test';
import {
  VAT_RATES_PERCENT,
  allowedVatRatesText,
  isAllowedVatRate,
  vatIncludedInTotal,
} from '../../../src/kit/domain/vat';
import { roundMoney } from '../../../src/kit/domain/money';
import { validateDocumentFields } from '../../../src/kit/domain/validators.owned';
import { type DealDocument } from '../../../src/kit/domain/models';

/** Документ на одну строку с итогом `total` и заданным НДС. */
function docWithVat(total: number, vatRate: number, vatAmount: number): DealDocument {
  return {
    id: 'd1',
    kind: 'invoice',
    number: '42',
    buyer: 'А',
    seller: 'Б',
    lines: [{ name: 'Арматура', quantity: 1, unitPrice: total }],
    total,
    currency: 'RUB',
    issuedAt: '2026-10-01',
    vatRate,
    vatAmount,
  };
}

function codes(doc: DealDocument): string[] {
  return validateDocumentFields(doc).map((issue) => issue.code);
}

describe('R9-A1-02: действующие ставки НДС', () => {
  test('перечень: 0, 5, 7, 10, 20, 22', () => {
    expect([...VAT_RATES_PERCENT]).toEqual([0, 5, 7, 10, 20, 22]);
    expect(allowedVatRatesText()).toBe('0, 5, 7, 10, 20, 22%');
    for (const rate of VAT_RATES_PERCENT) expect(isAllowedVatRate(rate)).toBe(true);
    for (const rate of [18, 21.9, 22.0001, -5, 100]) expect(isAllowedVatRate(rate)).toBe(false);
  });

  // [ставка, итог с НДС, НДС в итоге] - копейки округляются «от нуля», как суммы строк.
  const sums: Array<[number, number, number]> = [
    [22, 1220, 220],
    [22, 1000, 180.33],
    [22, 100, 18.03],
    [22, 0.01, 0],
    [22, 123456.78, 22262.7],
    [5, 1050, 50],
    [5, 1000, 47.62],
    [5, 100, 4.76],
    [5, 99999.99, 4761.9],
    [7, 1070, 70],
    [7, 1000, 65.42],
    [7, 100, 6.54],
    [7, 12345.67, 807.66],
    [10, 1100, 100],
    [10, 1000, 90.91],
    [20, 1200, 200],
    [20, 1000, 166.67],
    // Ровно половина копейки (0.03 × 20 / 120 = 0.005) округляется вверх.
    [20, 0.03, 0.01],
    [0, 1000, 0],
  ];

  test.each(sums)('ставка %p%%, итог %p -> НДС %p', (rate, total, vat) => {
    expect(vatIncludedInTotal(total, rate)).toBe(vat);
    expect(codes(docWithVat(total, rate, vat))).toEqual([]);
  });

  test('расчёт совпадает с прежней формулой для 20% и тем же округлением для всех ставок', () => {
    for (const rate of VAT_RATES_PERCENT) {
      for (let cents = 0; cents <= 200_000; cents += 7) {
        const total = cents / 100;
        expect(vatIncludedInTotal(total, rate)).toBe(roundMoney((total * rate) / (100 + rate)));
      }
    }
  });

  test('документ на 22% проходит, сумма по 20% при ставке 22 - vat_mismatch', () => {
    expect(codes(docWithVat(1220, 22, 220))).toEqual([]);
    expect(codes(docWithVat(1220, 22, 203.33))).toEqual(['vat_mismatch']);
    // Допуск в копейку, как у остальных сумм.
    expect(codes(docWithVat(1000, 22, 180.34))).toEqual([]);
    expect(codes(docWithVat(1000, 22, 180.35))).toEqual(['vat_mismatch']);
  });

  test('недопустимая ставка: сообщение перечисляет действующие и не подсказывает замену', () => {
    const issues = validateDocumentFields(docWithVat(1180, 18, 180));
    expect(issues.map((issue) => issue.code)).toEqual(['vat_rate_invalid']);
    const message = issues[0]?.message ?? '';
    expect(message).toContain('18%');
    expect(message).toContain('0, 5, 7, 10, 20, 22%');
    expect(message).not.toMatch(/(укажите|поставьте|используйте) (ставку )?20/i);
  });
});
