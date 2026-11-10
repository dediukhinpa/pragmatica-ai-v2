import { describe, expect, test } from 'bun:test';
import {
  compareQuotes,
  findQuoteGaps,
  findRequestItemIndex,
  findRequestItemMatch,
  validateQuoteDraft,
  type QuoteDraft,
} from '../../../src/kit/domain/quotes';
import { type PurchaseRequest, type SupplierQuote } from '../../../src/kit/domain/models';
import { NOW, REQUEST } from './support/quote-fixtures';

const SUPPLIERS = [
  { id: 'a', name: 'Альфа' },
  { id: 'b', name: 'Бета' },
  { id: 'c', name: 'Гамма' },
];

function quote(supplierId: string, patch: Partial<SupplierQuote> = {}): SupplierQuote {
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
      { productName: 'Арматура', unitPrice: 50, quantity: 100 },
      { productName: 'Сетка', unitPrice: 200, quantity: 10 },
    ],
    ...patch,
  };
}

const compare = (quotes: SupplierQuote[]) =>
  compareQuotes({ request: REQUEST, suppliers: SUPPLIERS, quotes, now: NOW });

describe('findRequestItemIndex', () => {
  test('точное совпадение, префикс по границе слова, «болт м80» не равен «болт м8»', () => {
    const items = [
      { name: 'Болт М8', quantity: 1, unit: 'шт' },
      { name: 'Болт М8 оцинк', quantity: 1, unit: 'шт' },
    ];
    expect(findRequestItemIndex('болт  м8', items)).toBe(0);
    expect(findRequestItemIndex('Болт М8 оцинк 40 мм', items)).toBe(1);
    expect(findRequestItemIndex('Болт М80', items)).toBe(-1);
  });
});

describe('R3-ALG-6: неоднозначное сопоставление названия с позицией заявки', () => {
  const items = [
    { name: 'Болт М8', quantity: 1, unit: 'шт' },
    { name: 'Болт М10', quantity: 1, unit: 'шт' },
    { name: 'Гайка', quantity: 1, unit: 'шт' },
  ];

  test('неполное название подходит двум позициям: неоднозначно, не первая из них', () => {
    expect(findRequestItemMatch('Болт', items)).toEqual({ kind: 'ambiguous', indexes: [0, 1] });
    expect(findRequestItemIndex('Болт', items)).toBe(-1);
  });

  test('одному кандидату и точному совпадению - однозначно', () => {
    expect(findRequestItemMatch('Гай', items)).toEqual({ kind: 'none' });
    expect(findRequestItemMatch('Гайка', items)).toEqual({ kind: 'match', index: 2 });
    expect(findRequestItemMatch('Болт М8', items)).toEqual({ kind: 'match', index: 0 });
    expect(findRequestItemMatch('Гайка шестигранная', items)).toEqual({ kind: 'match', index: 2 });
  });

  test('две одноимённые позиции заявки: неоднозначно даже при точном названии', () => {
    const twins = [items[0]!, items[0]!];
    expect(findRequestItemMatch('Болт М8', twins)).toEqual({ kind: 'ambiguous', indexes: [0, 1] });
  });

  test('и короче, и длиннее одновременно: неоднозначно', () => {
    const mixed = [
      { name: 'Болт М8', quantity: 1, unit: 'шт' },
      { name: 'Болт М8 оцинк 40', quantity: 1, unit: 'шт' },
    ];
    expect(findRequestItemMatch('Болт М8 оцинк', mixed).kind).toBe('ambiguous');
  });

  test('проверка КП называет причину отдельным кодом', () => {
    const request: PurchaseRequest = { ...REQUEST, items };
    const draft: QuoteDraft = { currency: 'RUB', lines: [{ productName: 'Болт', unitPrice: 5 }] };
    const codes = validateQuoteDraft(draft, {
      request,
      allowedSupplierIds: ['a'],
      supplierId: 'a',
    }).map((issue) => issue.code);
    expect(codes).toEqual(['ambiguous_line']);
  });
});

describe('compareQuotes', () => {
  test('таблица, минимум и максимум по позиции, итог по заказу', () => {
    const result = compare([
      quote('a'),
      quote('b', {
        lines: [
          { productName: 'Арматура', unitPrice: 45, quantity: 100 },
          { productName: 'Сетка', unitPrice: 220, quantity: 10 },
        ],
      }),
    ]);
    const [armature, mesh] = result.rows;
    expect(armature).toMatchObject({ minUnitPrice: 45, minSupplierIds: ['b'], maxUnitPrice: 50 });
    expect(mesh).toMatchObject({ minUnitPrice: 200, minSupplierIds: ['a'], maxUnitPrice: 220 });
    expect(result.suppliers.map((s) => s.orderTotal)).toEqual([7000, 6700, undefined]);
    expect(result.notRepliedSupplierIds).toEqual(['c']);
  });

  test('не рекомендует: результат не содержит победителя или оценки', () => {
    const keys = Object.keys(compare([quote('a')]));
    expect(keys.sort()).toEqual(
      ['baseCurrency', 'flags', 'notRepliedSupplierIds', 'requestId', 'rows', 'suppliers'].sort(),
    );
  });

  test('флаги: нет цены, не по всем позициям, не ответил', () => {
    const result = compare([quote('a', { lines: [{ productName: 'Арматура', quantity: 100 }] })]);
    const codes = result.flags.map((f) => `${f.code}:${f.supplierId ?? ''}`);
    expect(codes).toContain('no_price:a');
    expect(codes).toContain('partial_answer:a');
    expect(codes).toContain('no_reply:b');
    expect(codes).toContain('no_reply:c');
    expect(result.rows[0]?.cells[0]?.state).toBe('no_price');
    expect(result.rows[1]?.cells[0]?.state).toBe('not_covered');
  });

  test('просроченное КП и другая валюта: флаги, без конвертации и вне минимумов', () => {
    const result = compare([
      quote('a'),
      quote('b', {
        validUntil: '2026-01-09T00:00:00.000Z',
        lines: [
          { productName: 'Арматура', unitPrice: 1, quantity: 100 },
          { productName: 'Сетка', unitPrice: 1, quantity: 10 },
        ],
      }),
      quote('c', {
        currency: 'USD',
        lines: [
          { productName: 'Арматура', unitPrice: 2, quantity: 100 },
          { productName: 'Сетка', unitPrice: 2, quantity: 10 },
        ],
      }),
    ]);
    const codes = result.flags.map((f) => f.code);
    expect(codes).toContain('quote_expired');
    expect(codes).toContain('currency_differs');
    expect(codes).toContain('mixed_currencies');
    expect(result.rows[0]?.minSupplierIds).toEqual(['a']);
    expect(result.suppliers[2]).toMatchObject({
      currency: 'USD',
      orderTotal: 220,
      comparable: false,
    });
  });

  test('замена и расхождение количества — предупреждения; замена в таблицу не входит', () => {
    const result = compare([
      quote('a', {
        lines: [
          { productName: 'Арматура', unitPrice: 50, quantity: 80 },
          { productName: 'Сетка', unitPrice: 200, quantity: 10 },
          { productName: 'Сетка рабица', unitPrice: 1, quantity: 10, isReplacement: true },
        ],
      }),
    ]);
    const codes = result.flags.map((f) => f.code);
    expect(codes).toContain('has_replacement');
    expect(codes).toContain('quantity_differs');
    expect(result.suppliers[0]?.orderTotal).toBe(80 * 50 + 2000);
  });
});

describe('validateQuoteDraft и findQuoteGaps', () => {
  const draft: QuoteDraft = {
    currency: 'RUB',
    lines: [{ productName: 'Арматура', unitPrice: 50 }],
  };
  const context = { request: REQUEST, allowedSupplierIds: ['a'], supplierId: 'a' };

  test('правила: поставщик, валюта, позиция вне заявки, дубль', () => {
    expect(validateQuoteDraft(draft, context)).toEqual([]);
    const codes = (d: QuoteDraft, c = context) => validateQuoteDraft(d, c).map((i) => i.code);
    expect(codes(draft, { ...context, supplierId: 'z' })).toEqual(['supplier_not_in_selection']);
    expect(codes({ ...draft, currency: 'ZZZ' })).toEqual(['unknown_currency']);
    expect(codes({ ...draft, lines: [{ productName: 'Гвозди' }] })).toEqual([
      'line_not_in_request',
    ]);
    expect(
      codes({ ...draft, lines: [{ productName: 'Арматура' }, { productName: 'арматура' }] }),
    ).toEqual(['duplicate_line']);
  });

  test('пропущенное попадает в «чего не хватает»', () => {
    const gaps = findQuoteGaps(
      {
        lines: [{ productName: 'Арматура' }],
        deliveryDays: undefined,
        paymentTerms: undefined,
        validUntil: undefined,
      },
      REQUEST,
    ).map((g) => `${g.code}:${g.productName ?? ''}`);
    expect(gaps).toEqual([
      'no_price:Арматура',
      'no_quantity:Арматура',
      'item_not_covered:Сетка',
      'no_delivery:',
      'no_payment_terms:',
      'no_validity:',
    ]);
  });
});

describe('D-11: единицы измерения КП и заявки', () => {
  const withUnit = (supplierId: string, unit: string, price = 200) =>
    quote(supplierId, {
      lines: [
        { productName: 'Арматура', unitPrice: 50, quantity: 100, unit: 'м' },
        { productName: 'Сетка', unitPrice: price, quantity: 10, unit },
      ],
    });

  test('синонимы единиц считаются одной единицей', () => {
    const result = compare([withUnit('a', 'штука'), withUnit('b', 'Шт.'), withUnit('c', 'pcs')]);
    expect(result.flags.map((f) => f.code)).not.toContain('unit_differs');
  });

  test('цена за упаковку против штук: предупреждение, в минимумах не участвует', () => {
    // Альфа: 10 за упаковку (число совпало бы «дешёвым»), Бета: 200 за штуку.
    const result = compare([withUnit('a', 'упак', 10), withUnit('b', 'шт', 200)]);
    const flag = result.flags.find((f) => f.code === 'unit_differs');
    expect(flag).toMatchObject({ supplierId: 'a', productName: 'Сетка' });
    expect(flag?.message).toContain('упак');
    const row = result.rows.find((r) => r.itemName === 'Сетка');
    expect(row?.minSupplierIds).toEqual(['b']);
    // Цена не пересчитывалась: в ячейке остаётся то, что написал поставщик.
    expect(row?.cells.find((c) => c.supplierId === 'a')?.unitPrice).toBe(10);
  });

  test('R2-D-1: ячейка в другой единице не входит в итог и число оценённых позиций', () => {
    // Альфа: 100 м по 50 = 5000 и сетка 10 упак по 10 (другая единица): итог без сетки.
    const result = compare([withUnit('a', 'упак', 10), withUnit('b', 'шт', 200)]);
    const alpha = result.suppliers.find((s) => s.supplierId === 'a');
    const beta = result.suppliers.find((s) => s.supplierId === 'b');
    expect(alpha?.orderTotal).toBe(5000);
    expect(alpha?.pricedItems).toBe(1);
    expect(alpha?.unitMismatchItems).toBe(1);
    expect(alpha?.comparable).toBe(false);
    expect(beta?.orderTotal).toBe(7000);
    const cell = result.rows.find((r) => r.itemName === 'Сетка')?.cells[0];
    expect(cell?.unitDiffers).toBe(true);
    expect(cell?.lineTotal).toBeUndefined();
    const flag = result.flags.find((f) => f.code === 'unit_differs');
    expect(flag?.message).toContain('в итог');
  });

  test('R2-D-1: единственная позиция в другой единице - итога нет', () => {
    const request: PurchaseRequest = {
      ...REQUEST,
      items: [{ name: 'Цемент', quantity: 10, unit: 'т' }],
    };
    const mk = (id: string, unit: string, price: number): SupplierQuote =>
      quote(id, { lines: [{ productName: 'Цемент', unitPrice: price, quantity: 10, unit }] });
    const result = compareQuotes({
      request,
      suppliers: SUPPLIERS,
      quotes: [mk('a', 'т', 1000), mk('b', 'кг', 1)],
      now: NOW,
    });
    const b = result.suppliers.find((s) => s.supplierId === 'b');
    expect(b?.orderTotal).toBeUndefined();
    expect(b?.pricedItems).toBe(0);
    expect(result.suppliers.find((s) => s.supplierId === 'a')?.orderTotal).toBe(10000);
  });

  test('единица в КП не указана - расхождения нет', () => {
    const result = compare([quote('a')]);
    expect(result.flags.map((f) => f.code)).not.toContain('unit_differs');
  });
});
