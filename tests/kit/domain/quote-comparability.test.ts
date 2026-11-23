import { describe, expect, test } from 'bun:test';
import { compareQuotes, quoteDraftSchema } from '../../../src/kit/domain/quotes';
import {
  supplierQuoteSchema,
  type QuoteLine,
  type SupplierQuote,
} from '../../../src/kit/domain/models';
import { NOW, REQUEST } from './support/quote-fixtures';

const SUPPLIERS = [
  { id: 'a', name: 'Альфа' },
  { id: 'b', name: 'Бета' },
];

function quote(supplierId: string, price: number, extra: Partial<QuoteLine> = {}): SupplierQuote {
  return {
    id: `q-${supplierId}`,
    requestId: 'r1',
    supplierId,
    currency: 'RUB',
    receivedAt: '2026-01-05T00:00:00.000Z',
    validUntil: '2026-02-01T00:00:00.000Z',
    paymentTerms: 'постоплата',
    deliveryDays: 5,
    gaps: [],
    lines: [
      { productName: 'Арматура', unitPrice: price, quantity: 100, ...extra },
      { productName: 'Сетка', unitPrice: price * 4, quantity: 10, ...extra },
    ],
  };
}

const compare = (quotes: SupplierQuote[]) =>
  compareQuotes({ request: REQUEST, suppliers: SUPPLIERS, quotes, now: NOW });

describe('R4-ALG-4: НДС и условия отгрузки', () => {
  test('нет сведений об НДС ни у кого: минимум называется, как раньше', () => {
    const result = compare([quote('a', 50), quote('b', 60)]);
    expect(result.rows[0]?.minUnitPrice).toBe(50);
    expect(result.flags.some((f) => f.code === 'vat_differs')).toBe(false);
    expect(result.suppliers.every((s) => s.comparable)).toBe(true);
  });

  test('все цены с НДС: сопоставимо', () => {
    const result = compare([
      quote('a', 50, { vatIncluded: true }),
      quote('b', 60, { vatIncluded: true, vatRate: 20 }),
    ]);
    expect(result.rows[0]?.minUnitPrice).toBe(50);
  });

  test('смесь «с НДС» и «без НДС»: минимум не называется, итог считается с флагом', () => {
    const result = compare([
      quote('a', 50, { vatIncluded: false, vatRate: 20 }),
      quote('b', 55, { vatIncluded: true, vatRate: 20 }),
    ]);
    for (const row of result.rows) {
      expect(row.minUnitPrice).toBeUndefined();
      expect(row.minSupplierIds).toEqual([]);
      expect(row.maxUnitPrice).toBeUndefined();
      expect(row.incomparable).toBe(true);
    }
    expect(result.flags.some((f) => f.code === 'vat_differs')).toBe(true);
    const alpha = result.suppliers.find((s) => s.supplierId === 'a');
    expect(alpha?.orderTotal).toBe(50 * 100 + 200 * 10);
    expect(alpha?.comparable).toBe(false);
    expect(alpha?.incomparableReasons).toContain('vat_mixed');
  });

  test('у одного поставщика указано, у другого нет: несопоставимо', () => {
    const result = compare([quote('a', 50, { vatIncluded: true }), quote('b', 40)]);
    expect(result.rows[0]?.minUnitPrice).toBeUndefined();
    expect(result.flags.some((f) => f.code === 'vat_differs')).toBe(true);
  });

  test('ставка 0 (без НДС по УСН): цена итоговая, с ценой «с НДС» сопоставима', () => {
    const result = compare([
      quote('a', 50, { vatIncluded: false, vatRate: 0 }),
      quote('b', 55, { vatIncluded: true, vatRate: 20 }),
    ]);
    expect(result.rows[0]?.minUnitPrice).toBe(50);
  });

  test('истёкшее КП с другим НДС не блокирует минимум остальных', () => {
    const expired = { ...quote('b', 10, { vatIncluded: false }), validUntil: '2026-01-01' };
    const result = compare([quote('a', 50, { vatIncluded: true }), expired]);
    expect(result.rows[0]?.minUnitPrice).toBe(50);
  });

  test('фасовка не делит запрошенное количество: несопоставимо, итог по заявке', () => {
    const result = compare([quote('a', 50, { packSize: 30 }), quote('b', 60)]);
    expect(result.rows[0]?.minUnitPrice).toBeUndefined();
    expect(result.flags.some((f) => f.code === 'pack_size_mismatch' && f.supplierId === 'a')).toBe(
      true,
    );
    const alpha = result.suppliers.find((s) => s.supplierId === 'a');
    expect(alpha?.orderTotal).toBe(50 * 100 + 200 * 10);
    expect(alpha?.incomparableReasons).toContain('pack_size');
  });

  test('фасовка делит количество: флага нет', () => {
    const result = compare([quote('a', 50, { packSize: 5 }), quote('b', 60)]);
    expect(result.rows[0]?.minUnitPrice).toBe(50);
    expect(result.flags.some((f) => f.code === 'pack_size_mismatch')).toBe(false);
  });

  test('минимальная партия больше запрошенного количества: несопоставимо', () => {
    const result = compare([quote('a', 50, { minOrder: 500 }), quote('b', 60)]);
    expect(result.rows[0]?.minUnitPrice).toBeUndefined();
    expect(result.flags.some((f) => f.code === 'min_order_exceeds')).toBe(true);
    expect(
      result.suppliers.find((s) => s.supplierId === 'a')?.incomparableReasons,
    ).toContain('min_order');
  });

  test('схемы принимают и проверяют новые поля', () => {
    const draftLine = { productName: 'Болт', vatIncluded: true, vatRate: 20, packSize: 50 };
    expect(
      quoteDraftSchema.safeParse({ lines: [draftLine], currency: 'rub', vatIncluded: false })
        .success,
    ).toBe(true);
    expect(
      quoteDraftSchema.safeParse({ lines: [{ ...draftLine, vatRate: 120 }], currency: 'RUB' })
        .success,
    ).toBe(false);
    expect(
      supplierQuoteSchema.safeParse({ ...quote('a', 1), lines: [{ ...draftLine, minOrder: 0 }] })
        .success,
    ).toBe(false);
  });
});
