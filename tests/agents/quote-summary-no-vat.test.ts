import { describe, expect, test } from 'bun:test';
import { buildQuoteSheets, buildQuoteSummaryText } from '../../src/agents/order-calc/quote-summary';
import { compareQuotes } from '../../src/kit/domain/quotes';
import { type QuoteLine, type SupplierQuote } from '../../src/kit/domain/models';
import { NOW, REQUEST } from '../kit/domain/support/quote-fixtures';

/**
 * Решение владельца 09.11 (п.2): НДС виден только в шорт-листе и в карточке поставщика,
 * в сводке КП (текст и файл) его нет и отсылок туда нет. Минимум при разном НДС по-прежнему
 * не называется.
 */

const SUPPLIERS = [
  { id: 'a', name: 'Альфа' },
  { id: 'b', name: 'Бета' },
];

function quote(supplierId: string, price: number, extra: Partial<QuoteLine>): SupplierQuote {
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

/** Весь текст сводки: сообщение менеджеру и все ячейки файла. */
function wholeSummary(quotes: SupplierQuote[]): { text: string; minNamed: boolean } {
  const comparison = compareQuotes({ request: REQUEST, suppliers: SUPPLIERS, quotes, now: NOW });
  const message = buildQuoteSummaryText(comparison).text;
  const sheets = buildQuoteSheets(comparison);
  const cells = sheets.flatMap((sheet) => [sheet.name, ...sheet.columns, ...sheet.rows.flat()]);
  return {
    text: [message, ...cells.map(String)].join('\n'),
    minNamed: comparison.rows.some((row) => row.minUnitPrice !== undefined),
  };
}

describe('сводка КП без НДС', () => {
  test('разный НДС: слов про НДС в сообщении и файле нет, минимум не назван', () => {
    const out = wholeSummary([
      quote('a', 50, { vatIncluded: false, vatRate: 20 }),
      quote('b', 55, { vatIncluded: true, vatRate: 20 }),
    ]);
    expect(out.text).not.toMatch(/НДС/u);
    expect(out.text).toContain('НЕСОПОСТАВИМО');
    expect(out.text).toContain('Минимум не назван: условия ответов поставщиков');
    expect(out.text).toContain('сверьте их ответы');
    // шорт-лист и карточка показывают НДС прайса, а не этого КП: отсылки быть не должно
    expect(out.text).not.toMatch(/шорт-лист|карточк/u);
    expect(out.minNamed).toBe(false);
  });

  test('НДС не указан у части поставщиков: тоже без слов про НДС', () => {
    const out = wholeSummary([quote('a', 50, { vatIncluded: true }), quote('b', 40, {})]);
    expect(out.text).not.toMatch(/НДС/u);
    expect(out.minNamed).toBe(false);
  });

  test('одинаковый НДС: минимум называется, слов про НДС нет', () => {
    const out = wholeSummary([
      quote('a', 50, { vatIncluded: true }),
      quote('b', 55, { vatIncluded: true }),
    ]);
    expect(out.text).not.toMatch(/НДС/u);
    expect(out.minNamed).toBe(true);
  });
});
