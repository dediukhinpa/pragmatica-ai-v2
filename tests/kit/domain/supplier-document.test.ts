import { describe, expect, test } from 'bun:test';
import {
  buildReviewChecklist,
  checkDocumentAgainstQuote,
  checkDocumentRequisites,
  quoteTotal,
} from '../../../src/kit/domain/supplier-document';
import { supplierRequisitesRecord } from '../../../src/kit/domain/requisites';
import { type DealDocument, type SupplierQuote } from '../../../src/kit/domain/models';
import { FULL_SUPPLIER } from '../support/supplier-fixtures';

const QUOTE: SupplierQuote = {
  id: 'q',
  requestId: 'r1',
  supplierId: 's1',
  currency: 'RUB',
  receivedAt: '2026-01-05T00:00:00.000Z',
  validUntil: '2026-02-01T00:00:00.000Z',
  paymentTerms: '50% предоплата',
  deliveryDays: 7,
  gaps: [],
  lines: [{ productName: 'Болт М8', unitPrice: 12, quantity: 10 }],
};
const DOC: DealDocument = {
  id: 'd',
  kind: 'contract',
  number: 'Д-1',
  buyer: 'ООО Прагматика',
  seller: 'МеталлТорг',
  lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12 }],
  total: 120,
  currency: 'RUB',
  issuedAt: '2026-01-06T00:00:00.000Z',
  supplierId: 's1',
  requestId: 'r1',
  paymentTerms: '50% предоплата',
  deliveryDays: 7,
  requisites: supplierRequisitesRecord(FULL_SUPPLIER),
};
const NOW = new Date('2026-01-10T00:00:00.000Z');
const codes = (doc: DealDocument, quote = QUOTE) =>
  checkDocumentAgainstQuote(doc, quote, NOW).map((i) => i.code);

describe('документ против КП', () => {
  test('совпадает: замечаний нет', () => {
    expect(codes(DOC)).toEqual([]);
    expect(quoteTotal(QUOTE)).toBe(120);
  });

  test('расхождения суммы, цены, количества, позиций, условий и срока', () => {
    expect(codes({ ...DOC, total: 150 })).toEqual(['total_differs_from_quote']);
    expect(
      codes({ ...DOC, lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 15 }], total: 150 }),
    ).toEqual(['price_differs_from_quote', 'total_differs_from_quote']);
    expect(
      codes({ ...DOC, lines: [{ name: 'Гайка', quantity: 1, unitPrice: 1 }], total: 1 }),
    ).toContain('line_not_in_quote');
    expect(codes({ ...DOC, paymentTerms: '100% предоплата' })).toEqual([
      'payment_terms_differ_from_quote',
    ]);
    expect(codes({ ...DOC, paymentTerms: undefined })).toEqual(['payment_terms_differ_from_quote']);
    expect(codes({ ...DOC, deliveryDays: 3 })).toEqual(['delivery_differs_from_quote']);
    expect(codes({ ...DOC, currency: 'USD' })).toEqual(['currency_differs_from_quote']);
  });

  test('R3-ALG-8: единица измерения сверяется с КП', () => {
    const quote = { ...QUOTE, lines: [{ ...QUOTE.lines[0]!, unit: 'шт' }] };
    const withUnit = (unit: string | undefined): DealDocument => ({
      ...DOC,
      lines: [{ ...DOC.lines[0]!, unit }],
    });
    expect(codes(withUnit('штука'), quote)).toEqual([]);
    expect(codes(withUnit('упак'), quote)).toEqual(['unit_differs_from_quote']);
    expect(codes(withUnit(undefined), quote)).toEqual(['unit_missing_in_document']);
    // В КП единицы нет - сверять нечего.
    expect(codes(withUnit('упак'))).toEqual([]);
  });

  test('R3-ALG-8: построчный срок КП важнее общего', () => {
    const quote = {
      ...QUOTE,
      deliveryDays: undefined,
      lines: [{ ...QUOTE.lines[0]!, deliveryDays: 5 }],
    };
    const withDays = (line: number | undefined, doc: number | undefined): DealDocument => ({
      ...DOC,
      deliveryDays: doc,
      lines: [{ ...DOC.lines[0]!, deliveryDays: line }],
    });
    expect(codes(withDays(5, undefined), quote)).toEqual([]);
    expect(codes(withDays(undefined, 5), quote)).toEqual([]);
    expect(codes(withDays(9, 5), quote)).toEqual(['delivery_differs_from_quote']);
    expect(codes(withDays(undefined, undefined), quote)).toEqual(['delivery_differs_from_quote']);
  });

  test('R3-ALG-19/20: сумма в копейках, построчное округление, нет ложного расхождения', () => {
    const lines = Array.from({ length: 3 }, () => ({
      productName: 'Болт М8',
      unitPrice: 0.1,
      quantity: 1,
    }));
    const quote = { ...QUOTE, lines: [{ productName: 'Болт М8', unitPrice: 0.335, quantity: 3 }] };
    expect(quoteTotal({ ...QUOTE, lines })).toBe(0.3);
    expect(quoteTotal(quote)).toBe(1.01);
    const doc: DealDocument = {
      ...DOC,
      lines: [{ name: 'Болт М8', quantity: 3, unitPrice: 0.335 }],
      total: 1.01,
    };
    expect(codes(doc, quote)).toEqual([]);
  });

  test('просроченное и неполное КП блокируют', () => {
    expect(codes(DOC, { ...QUOTE, validUntil: '2026-01-09T00:00:00.000Z' })).toEqual([
      'quote_expired',
    ]);
    expect(codes(DOC, { ...QUOTE, gaps: [{ code: 'no_price', productName: 'x' }] })).toContain(
      'quote_incomplete',
    );
  });
});

describe('реквизиты в документе против базы', () => {
  test('совпадают; расхождение и отсутствие отмечены без значений', () => {
    expect(checkDocumentRequisites(DOC, FULL_SUPPLIER)).toEqual([]);
    const wrong = checkDocumentRequisites(
      { ...DOC, requisites: { ...DOC.requisites, inn: '7707083894', kpp: '' } },
      FULL_SUPPLIER,
    );
    expect(wrong.map((i) => i.code)).toEqual([
      'requisite_mismatch',
      'requisite_absent_in_document',
    ]);
    expect(JSON.stringify(wrong)).not.toContain('7707083894');
    expect(checkDocumentRequisites({ ...DOC, seller: 'Другой' }, FULL_SUPPLIER)[0]?.code).toBe(
      'seller_mismatch',
    );
  });
});

describe('чек-лист', () => {
  test('значения документа и источник каждого; статуса «подписано» нет', () => {
    const list = buildReviewChecklist(DOC, FULL_SUPPLIER, QUOTE);
    expect(new Set(list.map((i) => i.topic))).toEqual(
      new Set(['requisites', 'amounts', 'terms', 'payment']),
    );
    expect(list.every((i) => i.source !== '' && i.value !== '')).toBe(true);
    expect(list.find((i) => i.label === 'Итого')?.value).toBe('120 RUB');
    expect(JSON.stringify(list)).not.toMatch(/подписано|согласовано/);
  });
});
