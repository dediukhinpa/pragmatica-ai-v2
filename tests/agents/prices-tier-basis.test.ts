import { beforeEach, describe, expect, test } from 'bun:test';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { parseTableRows } from '../../src/agents/prices/table-rows';
import { SUPPLIER_ID } from './support';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

const PARAMS = { supplierId: 's1', headerRows: 1, defaultCurrency: 'RUB', date: '2026-10-01' };
const HEAD = ['Наименование', 'Цена от 62 000', 'Цена от 102 000'];
const TIERS = [
  { column: 1, minQuantity: 62000 },
  { column: 2, minQuantity: 102000 },
];
const ROWS = [HEAD, ['Одеяло', '1200', '1100']];

describe('основание тиража: разбор таблицы', () => {
  test('tierBasis=order_sum попадает в позицию вместе с порогами-суммами', () => {
    const out = parseTableRows(ROWS, {
      ...PARAMS,
      columns: { name: 0, priceTiers: TIERS, tierBasis: 'order_sum' },
    });
    expect(out.rejected).toEqual([]);
    expect(out.items[0]).toMatchObject({
      price: 1200,
      priceTierBasis: 'order_sum',
      priceTiers: [
        { minQuantity: 62000, price: 1200 },
        { minQuantity: 102000, price: 1100 },
      ],
    });
  });

  test('по умолчанию (и quantity) поле основания не пишется', () => {
    for (const tierBasis of [undefined, 'quantity' as const]) {
      const out = parseTableRows(ROWS, {
        ...PARAMS,
        columns: { name: 0, priceTiers: TIERS, ...(tierBasis ? { tierBasis } : {}) },
      });
      expect(out.items[0]).not.toHaveProperty('priceTierBasis');
    }
  });

  test('order_sum без priceTiers - ошибка ввода', () => {
    expect(() =>
      parseTableRows(ROWS, { ...PARAMS, columns: { name: 0, price: 1, tierBasis: 'order_sum' } }),
    ).toThrow(/priceTiers/);
  });

  test('схема столбцов принимает tierBasis, плоская и без посторонних значений', () => {
    const columns = { name: 0, priceTiers: TIERS };
    const base = { path: 't.csv', supplierId: 's1', headerRows: 1, columns };
    const ok = normalizePriceTable.inputSchema.safeParse({
      ...base,
      columns: { ...base.columns, tierBasis: 'order_sum' },
    });
    expect(ok.success).toBe(true);
    const bad = normalizePriceTable.inputSchema.safeParse({
      ...base,
      columns: { ...base.columns, tierBasis: 'weight' },
    });
    expect(bad.success).toBe(false);
  });

  test('промпт описывает tierBasis и не содержит слова «черновик»', () => {
    expect(PRICES_PROMPT).toContain('tierBasis');
    expect(PRICES_PROMPT).toContain('order_sum');
    expect(PRICES_PROMPT.toLowerCase()).not.toContain('черновик');
  });
});

describe('основание тиража: запись', () => {
  test('сохранённая позиция сохраняет основание и пороги-суммы', async () => {
    await deps.prices.saveImport(
      SUPPLIER_ID,
      [
        {
          supplierId: SUPPLIER_ID,
          productName: 'Одеяло',
          price: 1200,
          currency: 'RUB',
          date: '2026-10-01T00:00:00.000Z',
          priceTiers: [
            { minQuantity: 62000, price: 1200 },
            { minQuantity: 102000, price: 1100 },
          ],
          priceTierBasis: 'order_sum',
        },
      ],
      'seed-sum' as never,
    );
    const stored = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(stored[0]?.priceTierBasis).toBe('order_sum');
  });
});
