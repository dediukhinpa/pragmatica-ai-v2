import { describe, expect, test } from 'bun:test';
import { parseTableRows } from '../../src/agents/prices/table-rows';
import { formatPriceTiers } from '../../src/kit/domain/market-price';
import { priceItemSchema } from '../../src/kit/domain/models';

const PARAMS = { supplierId: 's1', headerRows: 1, defaultCurrency: 'RUB', date: '2026-10-01' };
/** Шапка матрицы: столбец размера и четыре тиража числами. */
const HEAD = ['Размер', '10', '50', '100', '500'];
const TIERS = [
  { column: 1, minQuantity: 10 },
  { column: 2, minQuantity: 50 },
  { column: 3, minQuantity: 100 },
  { column: 4, minQuantity: 500 },
];
/** Столбец размера - и название, и вариант; название товара - в строке-заголовке группы. */
const COLUMNS = { name: 0, variantColumns: [0], groupHeaderRows: true, priceTiers: TIERS };

/** Синтетические одеяла: цены-диапазоны, две группы с одинаковым размером. */
const BLANKETS = [
  HEAD,
  ['Одеяло бамбук', '', '', '', ''],
  ['140*205', '500-600', '480-580', '450-550', '400-500'],
  ['172*205', '600-700', '580-680', '550-650', '500-600'],
  ['Одеяло верблюд', '', '', '', ''],
  ['140*205', '500-600', '480-580', '450-550', '400-500'],
];
/** Синтетические коробки: точные цены, размеры с «x». */
const BOXES = [
  HEAD,
  ['Коробка гофро 3 слоя', '', '', '', ''],
  ['20x30x10', '30', '28', '25', '22'],
  ['30x40x15', '45', '42', '38', '33'],
];

describe('матрица «размер × тираж»', () => {
  test('одеяла: название группы + размер, тиражи-диапазоны хранятся в тираже', () => {
    const out = parseTableRows(BLANKETS, { ...PARAMS, columns: COLUMNS });
    expect(out.rejected).toEqual([]);
    expect(out.items.map((item) => item.productName)).toEqual([
      'Одеяло бамбук 140*205',
      'Одеяло бамбук 172*205',
      'Одеяло верблюд 140*205',
    ]);
    expect(out.skipped.map((row) => row.text)).toEqual(['Одеяло бамбук', 'Одеяло верблюд']);
    const first = out.items[0];
    expect(first).toMatchObject({ price: 500, priceQualifier: 'range', priceMax: 600 });
    expect(first?.priceTiers).toEqual([
      { minQuantity: 10, price: 500, qualifier: 'range', max: 600 },
      { minQuantity: 50, price: 480, qualifier: 'range', max: 580 },
      { minQuantity: 100, price: 450, qualifier: 'range', max: 550 },
      { minQuantity: 500, price: 400, qualifier: 'range', max: 500 },
    ]);
    expect(priceItemSchema.safeParse(first).success).toBe(true);
    expect(formatPriceTiers(first?.priceTiers ?? [], 'RUB')).toBe(
      'от 10 шт — 500–600 RUB, от 50 — 480–580 RUB, ' +
        'от 100 — 450–550 RUB, от 500 — 400–500 RUB',
    );
  });

  test('коробки: точные цены, размер «20x30x10» - вариант', () => {
    const out = parseTableRows(BOXES, { ...PARAMS, columns: COLUMNS });
    expect(out.rejected).toEqual([]);
    expect(out.items.map((item) => item.productName)).toEqual([
      'Коробка гофро 3 слоя 20x30x10',
      'Коробка гофро 3 слоя 30x40x15',
    ]);
    expect(out.items[0]).toMatchObject({ price: 30 });
    expect(out.items[0]?.priceQualifier).toBeUndefined();
    expect(out.items[0]?.priceTiers).toEqual([
      { minQuantity: 10, price: 30 },
      { minQuantity: 50, price: 28 },
      { minQuantity: 100, price: 25 },
      { minQuantity: 500, price: 22 },
    ]);
  });

  test('заголовок группы с числом в названии остаётся группой', () => {
    const out = parseTableRows(
      [HEAD, ['Одеяло 200 г/м2', '', '', '', ''], ['9*9', '5', '4', '3', '2']],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.items.map((item) => item.productName)).toEqual(['Одеяло 200 г/м2 9*9']);
  });

  test('строка позиции без размера берёт название группы', () => {
    const out = parseTableRows([HEAD, ['Подушка', '', '', '', ''], ['', '5', '4', '3', '2']], {
      ...PARAMS,
      columns: COLUMNS,
    });
    expect(out.items.map((item) => item.productName)).toEqual(['Подушка']);
  });

  test('одинаковые строки в одной группе схлопываются, в разных группах - нет', () => {
    const out = parseTableRows(
      [
        HEAD,
        ['Подушка А', '', '', '', ''],
        ['50x70', '5', '4', '3', '2'],
        ['50x70', '5', '4', '3', '2'],
        ['Подушка Б', '', '', '', ''],
        ['50x70', '5', '4', '3', '2'],
      ],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.items).toHaveLength(2);
    expect(out.skipped.some((row) => row.reason.includes('дубль'))).toBe(true);
  });

  test('диапазон в ячейке тиража и «от N шт» в ячейке: второе по-прежнему отклоняется', () => {
    const out = parseTableRows(
      [HEAD, ['Подушка', '', '', '', ''], ['50x70', 'от 10 шт 5 руб', '4', '3', '2']],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.items).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });

  test('без variantColumns на столбце названия прежнее поведение не меняется', () => {
    const out = parseTableRows(
      [HEAD, ['Ручка', '12', '10', '8', '7']],
      { ...PARAMS, columns: { name: 0, priceTiers: TIERS } },
    );
    expect(out.items[0]?.productName).toBe('Ручка');
  });
});
