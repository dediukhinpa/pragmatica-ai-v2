import { describe, expect, test } from 'bun:test';
import { validateDocumentFields } from '../../../src/kit/domain/validators.owned';
import { vatIncludedInTotal, vatIncludedPerLine } from '../../../src/kit/domain/vat';
import { type DealDocument } from '../../../src/kit/domain/models';
import { rng } from '@business-ai/testing';

/**
 * R9-A1-07: НДС документа принимается и «от итога», и построчно (НДС каждой строки округлён до
 * копейки, затем сложен - так считает 1С в счёте и УПД). Любая другая сумма - `vat_mismatch`.
 */

function doc(lines: Array<[number, number]>, vatRate: number, vatAmount: number): DealDocument {
  const totalCents = lines.reduce((sum, [qty, price]) => sum + Math.round(qty * price * 100), 0);
  return {
    id: 'd1',
    kind: 'invoice',
    number: '42',
    buyer: 'А',
    seller: 'Б',
    lines: lines.map(([quantity, unitPrice], i) => ({ name: `Шайба ${i}`, quantity, unitPrice })),
    total: totalCents / 100,
    currency: 'RUB',
    issuedAt: '2026-10-01',
    vatRate,
    vatAmount,
  };
}

function vatIssues(document: DealDocument): string[] {
  return validateDocumentFields(document)
    .filter((issue) => issue.code.startsWith('vat_'))
    .map((issue) => issue.message);
}

const TEN_RUBLE_LINES: Array<[number, number]> = Array.from({ length: 10 }, () => [1, 1]);

describe('R9-A1-07: НДС построчно', () => {
  test('10 строк по 1,00 ₽ при 20%: 1,70 построчно и 1,67 от итога - оба верны', () => {
    expect(vatIncludedPerLine(Array.from({ length: 10 }, () => 100), 20)).toBe(1.7);
    expect(vatIncludedInTotal(10, 20)).toBe(1.67);
    // Раньше 1,70 давало vat_mismatch «должно быть 1.67».
    expect(vatIssues(doc(TEN_RUBLE_LINES, 20, 1.7))).toEqual([]);
    expect(vatIssues(doc(TEN_RUBLE_LINES, 20, 1.67))).toEqual([]);
  });

  test('прочие суммы дают предупреждение, в тексте оба способа расчёта', () => {
    expect(vatIssues(doc(TEN_RUBLE_LINES, 20, 1.64))).toEqual([
      'НДС 1.64 не сходится: при ставке 20% от итога 10 должно быть 1.67, построчно - 1.7 ' +
        '(НДС входит в итог). Проверьте НДС.',
    ]);
    // Одна строка: способы совпадают, текст прежний.
    expect(vatIssues(doc([[1, 120]], 20, 21))).toEqual([
      'НДС 21 не сходится: при ставке 20% от итога 120 должно быть 20 (НДС входит в итог). ' +
        'Проверьте НДС.',
    ]);
  });

  test('НДС от итога принимается на любых документах, как раньше', () => {
    const random = rng(707);
    for (let round = 0; round < 2_000; round += 1) {
      const lines: Array<[number, number]> = Array.from(
        { length: 1 + Math.floor(random() * 30) },
        () => [1 + Math.floor(random() * 9), Math.floor(random() * 100_000) / 100],
      );
      const rate = [0, 5, 7, 10, 20, 22][Math.floor(random() * 6)] as number;
      const base = doc(lines, rate, 0);
      expect(vatIssues({ ...base, vatAmount: vatIncludedInTotal(base.total, rate) })).toEqual([]);
    }
  });
});
