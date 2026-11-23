import { describe, expect, test } from 'bun:test';
import { normalizeIntakeItems } from '../../src/agents/order-calc/intake';
import { DomainError } from '@business-ai/core';
import { findRequestItemMatch, validateQuoteDraft } from '../../src/kit/domain/quotes';

/**
 * R9-A1-08: повтор позиции в заявке определяется той же нормализацией названия, что и
 * сопоставление строк КП (NFKC, «ё» = «е», тире, пробелы), и нормализацией единицы («шт» =
 * «шт.»). Иначе позиции, которые КП считает одной, в заявке оставались двумя, и каждая строка
 * КП по ним получала ambiguous_line.
 */

function rejection(action: () => unknown): DomainError {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('ожидался отказ');
}

describe('R9-A1-08: ключ повтора позиции заявки', () => {
  test('merge: «Ёрш»/«Ерш» и «шт»/«шт.» - одна позиция, КП по ней записывается', () => {
    const items = normalizeIntakeItems(
      [
        { name: 'Ёрш для труб', unit: 'шт', quantity: 2 },
        { name: 'Ерш  для труб', unit: 'шт.', quantity: 3 },
      ],
      'merge',
    );
    // Раньше две позиции и ambiguous [0, 1] на строке КП.
    expect(items).toEqual([{ name: 'Ёрш для труб', unit: 'шт', quantity: 5 }]);
    expect(findRequestItemMatch('Ерш для труб', items)).toEqual({ kind: 'match', index: 0 });
    const issues = validateQuoteDraft(
      { currency: 'RUB', lines: [{ productName: 'Ерш для труб', unitPrice: 100 }] },
      {
        request: {
          id: 'r1',
          dealRef: 'd1',
          items,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
        allowedSupplierIds: ['s1'],
        supplierId: 's1',
      },
    );
    expect(issues.map((issue) => issue.code)).not.toContain('ambiguous_line');
  });

  test('reject: тире и регистр не делают позицию другой', () => {
    const error = rejection(() =>
      normalizeIntakeItems(
        [
          { name: 'Труба 20–3', unit: 'м', quantity: 2 },
          { name: 'труба 20 - 3', unit: 'М', quantity: 3 },
        ],
        'reject',
      ),
    );
    expect(error.message).toContain('номера 1 и 2');
  });

  test('одно название с разными единицами - отказ с номерами и в merge', () => {
    const error = rejection(() =>
      normalizeIntakeItems(
        [
          { name: 'Болт М8', unit: 'шт', quantity: 10 },
          { name: 'Гайка М8', unit: 'шт', quantity: 10 },
          { name: 'Гайка М8', unit: 'шт', quantity: 5 },
          { name: 'болт м8', unit: 'уп', quantity: 2 },
        ],
        'merge',
      ),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('номера 1 и 4');
    expect(error.message).not.toContain('Болт');
  });

  test('разные названия и прежние повторы - как раньше', () => {
    const items = normalizeIntakeItems(
      [
        { name: 'Болт М8', unit: 'шт', quantity: 10 },
        { name: 'Болт М10', unit: 'шт', quantity: 1 },
        { name: 'Болт М8', unit: 'шт', quantity: 5 },
      ],
      'merge',
    );
    expect(items.map((item) => [item.name, item.quantity])).toEqual([
      ['Болт М8', 15],
      ['Болт М10', 1],
    ]);
  });
});
