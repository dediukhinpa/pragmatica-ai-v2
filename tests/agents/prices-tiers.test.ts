import { beforeEach, describe, expect, test } from 'bun:test';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { parseTableRows } from '../../src/agents/prices/table-rows';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagedImportValidator } from '../../src/agents/prices/commit-price-import';
import { CTX, SUPPLIER_ID, putFile } from './support';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

const PARAMS = { supplierId: 's1', headerRows: 1, defaultCurrency: 'RUB', date: '2026-10-01' };
/** Синтетическая шапка: название, артикул и три тиража в разных столбцах. */
const HEAD = ['Наименование', 'Артикул', 'от 50 шт', 'от 100 шт', 'от 500 шт'];
const TIERS = [
  { column: 2, minQuantity: 50 },
  { column: 3, minQuantity: 100 },
  { column: 4, minQuantity: 500 },
];
const COLUMNS = { name: 0, sku: 1, priceTiers: TIERS };

describe('цены по тиражам: разбор строк', () => {
  test('основная цена - минимального тиража, все тиражи в позиции', () => {
    const out = parseTableRows([HEAD, ['Ручка', 'R-1', '12', '10', '8']], {
      ...PARAMS,
      columns: COLUMNS,
    });
    expect(out.rejected).toEqual([]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      productName: 'Ручка',
      price: 12,
      priceTiers: [
        { minQuantity: 50, price: 12 },
        { minQuantity: 100, price: 10 },
        { minQuantity: 500, price: 8 },
      ],
    });
  });

  test('столбцы тиражей в любом порядке: тиражи сортируются по минимуму', () => {
    const out = parseTableRows([HEAD, ['Ручка', '', '8', '10', '12']], {
      ...PARAMS,
      columns: {
        name: 0,
        priceTiers: [
          { column: 2, minQuantity: 500 },
          { column: 3, minQuantity: 100 },
          { column: 4, minQuantity: 50 },
        ],
      },
    });
    expect(out.items[0]?.price).toBe(12);
    expect(out.items[0]?.priceTiers?.map((t) => t.minQuantity)).toEqual([50, 100, 500]);
  });

  test('пустой или «по запросу» тираж пропускается, остальные остаются', () => {
    const out = parseTableRows(
      [HEAD, ['Ручка', '', '12', '', '8'], ['Папка', '', '30', 'по запросу', '25']],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.rejected).toEqual([]);
    expect(out.items[0]?.priceTiers).toEqual([
      { minQuantity: 50, price: 12 },
      { minQuantity: 500, price: 8 },
    ]);
    expect(out.items[1]?.priceTiers?.map((t) => t.minQuantity)).toEqual([50, 500]);
  });

  test('заполнен один тираж: обычная цена без массива тиражей', () => {
    const out = parseTableRows([HEAD, ['Ручка', '', '12', '', '']], {
      ...PARAMS,
      columns: COLUMNS,
    });
    expect(out.items[0]).toMatchObject({ price: 12 });
    expect(out.items[0]?.priceTiers).toBeUndefined();
  });

  test('цена минимального тиража пуста, а другие есть: строка отклонена', () => {
    const out = parseTableRows([HEAD, ['Ручка', '', '', '10', '8']], {
      ...PARAMS,
      columns: COLUMNS,
    });
    expect(out.items).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });

  test('неоднозначная цена тиража или другая валюта в нём отклоняют строку', () => {
    const out = parseTableRows(
      [HEAD, ['Ручка', '', '12', '1,234', '8'], ['Папка', '', '12 руб.', '10 USD', '8']],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.items).toEqual([]);
    expect(out.rejected).toHaveLength(2);
  });

  test('строка без цен - заголовок группы, а не позиция', () => {
    const out = parseTableRows([HEAD, ['Ручки', '', '', '', ''], ['Ручка', '', '12', '10', '8']], {
      ...PARAMS,
      columns: COLUMNS,
    });
    expect(out.items).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.reason).toContain('заголовок группы');
  });

  test('повторная шапка внутри листа пропускается', () => {
    const out = parseTableRows([HEAD, ['Ручка', '', '12', '10', '8'], HEAD], {
      ...PARAMS,
      columns: COLUMNS,
    });
    expect(out.items).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  test('полный дубль со всеми тиражами схлопывается, другие тиражи - нет', () => {
    const out = parseTableRows(
      [
        HEAD,
        ['Ручка', 'R-1', '12', '10', '8'],
        ['Ручка', 'R-1', '12', '10', '8'],
        ['Ручка', 'R-1', '12', '9', '8'],
      ],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.items).toHaveLength(2);
    expect(out.skipped.some((s) => s.reason.includes('дубль'))).toBe(true);
  });

  test('валюта берётся из заголовка любого столбца тиража', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Артикул', 'от 50 шт, USD', 'от 100 шт, USD', 'от 500 шт, USD'],
        ['Ручка', '', '1', '0,9', '0,8'],
      ],
      { ...PARAMS, columns: COLUMNS, defaultCurrency: 'USD' },
    );
    expect(out.items[0]?.currency).toBe('USD');
  });
});

describe('цены по тиражам: проверка столбцов', () => {
  const table = [HEAD, ['Ручка', '', '12', '10', '8']];
  test('price вместе с priceTiers, дубль тиража и дубль столбца - invalid_input', () => {
    const bad = [
      { name: 0, price: 2, priceTiers: TIERS },
      { name: 0, priceTiers: [TIERS[0]!, { column: 3, minQuantity: 50 }] },
      { name: 0, priceTiers: [TIERS[0]!, { column: 2, minQuantity: 100 }] },
    ];
    for (const columns of bad) {
      expect(() => parseTableRows(table, { ...PARAMS, columns })).toThrow();
    }
  });
  test('нет ни price, ни priceTiers - invalid_input', () => {
    expect(() => parseTableRows(table, { ...PARAMS, columns: { name: 0 } })).toThrow(
      'столбец цены',
    );
  });
});

const CSV = [
  'Наименование,Артикул,от 50 шт,от 100 шт,от 500 шт',
  'Ручка,R-1,12,10,8',
  'Папка,P-1,30,25,',
].join('\n');

describe('цены по тиражам: инструменты', () => {
  const input = { path: 't.csv', supplierId: SUPPLIER_ID, columns: COLUMNS };

  test('normalizePriceTable отдаёт тиражи, схема столбцов принимает priceTiers', async () => {
    putFile(deps, 't.csv', CSV);
    const parsedInput = normalizePriceTable.inputSchema.parse(input);
    const out = await normalizePriceTable.execute(parsedInput, deps, CTX);
    expect(out.rejected).toEqual([]);
    expect(out.items.map((i) => i.price)).toEqual([12, 30]);
    expect(out.items[1]?.priceTiers).toEqual([
      { minQuantity: 50, price: 30 },
      { minQuantity: 100, price: 25 },
    ]);
  });

  test('savePriceImport пишет основную цену минимального тиража и сохраняет тиражи', async () => {
    putFile(deps, 't.csv', CSV);
    const out = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse(input),
      deps,
      CTX,
    );
    const parsed = savePriceImport.inputSchema.parse({ ...input, fileHash: out.fileHash });
    expect(await priceImportValidator.validate(parsed, deps, CTX)).toEqual([]);
    const saved = await savePriceImport.execute(parsed, deps, CTX);
    expect(saved.saved).toBe(2);
    const stored = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(stored.map((i) => i.price)).toEqual([12, 30]);
    expect(stored[0]?.priceTiers).toHaveLength(3);
  });

  test('stagePriceRows + фиксация сохраняют тиражи', async () => {
    putFile(deps, 't.csv', CSV);
    const staged = await stagePriceRows.execute(
      stagePriceRows.inputSchema.parse({ ...input, reset: true }),
      deps,
      CTX,
    );
    expect(staged.totalStaged).toBe(2);
    expect(staged.rejectedCount).toBe(0);
    const commit = { supplierId: SUPPLIER_ID, fileHash: staged.fileHash };
    expect(await stagedImportValidator.validate(commit, deps, CTX)).toEqual([]);
  });

  test('кэш плана различает один и тот же лист с price и с priceTiers', () => {
    const table = [HEAD, ['Ручка', '', '12', '10', '8']];
    const tiered = parseTableRows(table, { ...PARAMS, columns: COLUMNS });
    const single = parseTableRows(table, { ...PARAMS, columns: { name: 0, price: 2 } });
    expect(tiered.items[0]?.priceTiers).toHaveLength(3);
    expect(single.items[0]?.priceTiers).toBeUndefined();
  });
});

describe('промпт «Прайсов»: тиражи', () => {
  test('объясняет priceTiers и цену минимального тиража', () => {
    expect(PRICES_PROMPT).toContain('priceTiers');
    expect(PRICES_PROMPT).toContain('МИНИМАЛЬНОГО тиража');
  });
});
