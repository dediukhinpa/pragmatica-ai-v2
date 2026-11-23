import { describe, expect, test } from 'bun:test';
import {
  DIFF_SAMPLE_SIZE,
  countSourceDataRows,
  countSourceItemUnits,
  diffItems,
  reconcileScriptItems,
} from '../../src/agents/prices/script-reconcile';
import { parseScriptItems, toPriceItems } from '../../src/agents/prices/script-price-items';
import { tableFormFingerprint } from '../../src/agents/prices/table-form';
import { priceItemSchema, type PriceItem } from '../../src/kit/domain/models';

const SUPPLIER = 's1';
const DATE = '2026-10-27T10:00:00.000Z';

function convert(raw: unknown[]) {
  const parsed = parseScriptItems(raw);
  const items = toPriceItems(parsed.items, { supplierId: SUPPLIER, date: DATE });
  return { parsed, items };
}

const codes = (raw: unknown[], sourceRows = raw.length): string[] => {
  const { parsed, items } = convert(raw);
  return reconcileScriptItems({ rawCount: raw.length, parsed, items, sourceRows }).map(
    (issue) => issue.code,
  );
};

describe('контракт price_items', () => {
  test('конвертер: вариант, артикул, валюта, тиражи, основание, признак цены', () => {
    const { parsed, items } = convert([
      {
        name: 'Одеяло',
        variant: '200х220',
        sku: 'OD-1',
        price: 1200,
        currency: 'USD',
        tier_basis: 'order_sum',
        tiers: [
          { min_quantity: 62000, price: 1200 },
          { min_quantity: 102000, price: 1100, qualifier: 'range', max: 1150 },
        ],
        price_qualifier: 'from',
      },
    ]);
    expect(parsed.invalid).toEqual([]);
    expect(items[0]).toMatchObject({
      supplierId: SUPPLIER,
      productName: 'Одеяло 200х220',
      sku: 'OD-1 / 200х220',
      currency: 'USD',
      priceTierBasis: 'order_sum',
      priceQualifier: 'from',
    });
    expect(items[0]?.priceTiers?.[1]).toEqual({
      minQuantity: 102000,
      price: 1100,
      qualifier: 'range',
      max: 1150,
    });
    // Результат - валидная позиция прайса: пройдёт тот же staging и валидатор.
    expect(priceItemSchema.safeParse(items[0]).success).toBe(true);
  });

  test('валюта по умолчанию RUB, вариант в названии не повторяется, quantity не хранится', () => {
    const { items } = convert([
      { name: 'Болт М8', variant: 'м8', price: 10, tier_basis: 'quantity' },
    ]);
    expect(items[0]).toMatchObject({ productName: 'Болт М8', currency: 'RUB' });
    expect(items[0]).not.toHaveProperty('priceTierBasis');
  });

  test('лишние ключи, нулевая цена и пустое название не проходят контракт', () => {
    const { parsed } = convert([
      { name: 'А', price: 1, extra: 1 },
      { name: 'Б', price: 0 },
      { name: '  ', price: 1 },
      { name: 'В', price: '10' },
      { name: 'Г', price: 5 },
    ]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.invalid.map((item) => [item.index, item.field])).toEqual([
      [1, 'item'],
      [2, 'price'],
      [3, 'name'],
      [4, 'price'],
    ]);
  });
});

describe('сверка до записи', () => {
  test('чистый результат проходит', () => {
    expect(codes([{ name: 'А', price: 1 }, { name: 'Б', price: 2 }])).toEqual([]);
  });

  test('пусто, нечисловые цены, пустые названия', () => {
    expect(codes([])).toEqual(['no_items']);
    expect(codes([{ name: 'А', price: 'x' }, { name: '', price: 2 }, { name: 'В', price: 3 }]))
      .toEqual(expect.arrayContaining(['non_numeric_price', 'empty_name']));
  });

  test('число позиций против строк исходника: потеряно и слишком много', () => {
    const few = [{ name: 'А', price: 1 }];
    expect(codes(few, 10)).toContain('items_fewer_than_rows');
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `Т${i}`, price: 1 }));
    expect(codes(many, 2)).toContain('items_more_than_rows');
    expect(codes(many, 11)).toEqual([]);
  });

  test('дубли ключей: одинаковое название и тот же артикул', () => {
    expect(codes([{ name: 'Болт', price: 1 }, { name: ' болт ', price: 2 }])).toContain(
      'duplicate_keys',
    );
    expect(
      codes([
        { name: 'А', sku: '1', price: 1 },
        { name: 'Б', sku: '1', price: 1 },
      ]),
    ).toContain('duplicate_keys');
    // Варианты одной модели с общим артикулом дублем не считаются.
    expect(
      codes([
        { name: 'А', variant: 'S', sku: '1', price: 1 },
        { name: 'А', variant: 'M', sku: '1', price: 1 },
      ]),
    ).toEqual([]);
  });

  test('немонотонные тиражи, цена не равна первому тиражу, order_sum без тиражей', () => {
    const tiers = (list: Array<[number, number]>) =>
      list.map(([min_quantity, price]) => ({ min_quantity, price }));
    expect(
      codes([{ name: 'А', price: 10, tiers: tiers([[100, 10], [50, 9]]) }]),
    ).toContain('tiers_not_monotonic');
    expect(
      codes([{ name: 'А', price: 10, tiers: tiers([[10, 10], [100, 12]]) }]),
    ).toContain('tiers_not_monotonic');
    expect(codes([{ name: 'А', price: 11, tiers: tiers([[10, 10], [100, 9]]) }])).toContain(
      'tier_price_mismatch',
    );
    expect(codes([{ name: 'А', price: 10, tier_basis: 'order_sum' }])).toContain(
      'tier_basis_without_tiers',
    );
    expect(codes([{ name: 'А', price: 10, tiers: tiers([[10, 10], [100, 9]]) }])).toEqual([]);
  });

  test('сообщения без значений данных (названия, цены)', () => {
    const { parsed, items } = convert([
      { name: 'СекретноеИмя', price: 5 },
      { name: 'секретноеимя', price: 6 },
    ]);
    const text = JSON.stringify(
      reconcileScriptItems({ rawCount: 2, parsed, items, sourceRows: 2 }),
    );
    expect(text).not.toContain('екретное');
  });

  test('строки данных исходника: число и текст в одной строке', () => {
    const rows = countSourceDataRows([
      [
        ['Наименование', 'Цена'],
        ['Болт', '10'],
        ['Итого', '10'],
        ['', ''],
        ['только текст', 'ещё'],
      ],
    ]);
    expect(rows).toBe(2);
  });

  test('матрица тиражей: позиций столько, сколько столбцов цен, а не строк тиражей', () => {
    const matrix = [
      [
        ['Тираж', '1 цвет', '2 цвета', '3 цвета', '4 цвета'],
        ['100 шт', '30', '34', '38', '44'],
        ['250 шт', '26', '29', '33', '39'],
        ['500 шт', '22', '25', '28', '34'],
        ['1000 шт', '19', '21', '24', '29'],
        ['2500 шт', '16', '18', '21', '26'],
        ['от 5000', '14', '16', '19', '23'],
      ],
    ];
    expect(countSourceDataRows(matrix)).toBe(6);
    expect(countSourceItemUnits(matrix)).toBe(4);
    // Четыре позиции из матрицы 6x4 - не «потерянные строки».
    const { parsed, items } = convert(
      ['a', 'b', 'c', 'd'].map((name) => ({ name, price: 10 })),
    );
    const issues = reconcileScriptItems({
      rawCount: 4,
      parsed,
      items,
      sourceRows: countSourceDataRows(matrix),
      sourceUnits: countSourceItemUnits(matrix),
    });
    expect(issues).toEqual([]);
  });

  test('список со столбцом «10 шт»: верхняя граница считает строки, ложных «повторов» нет', () => {
    const list = [
      [
        ['Болт', '10 шт', '5'],
        ['Гайка', '20 шт', '6'],
        ['Шайба', '30 шт', '7'],
        ['Винт', '40 шт', '8'],
        ['Гвоздь', '50 шт', '9'],
      ],
    ];
    expect(countSourceDataRows(list)).toBe(5);
    const { parsed, items } = convert([{ name: 'Болт', price: 5 }]);
    const issues = reconcileScriptItems({
      rawCount: 1,
      parsed,
      items,
      sourceRows: 5,
      sourceUnits: countSourceItemUnits(list),
    });
    // Подряд идущие строки с «шт» нижняя оценка принимает за матрицу (она ослаблена), а верхняя
    // граница по-прежнему считает строки.
    expect(issues.map((issue) => issue.code)).not.toContain('items_more_than_rows');
  });
});

function priced(name: string, price: number, extra: Partial<PriceItem> = {}): PriceItem {
  return { supplierId: SUPPLIER, productName: name, price, currency: 'RUB', date: DATE, ...extra };
}

describe('разница «было/стало»', () => {
  test('счётчики и образец изменений', () => {
    const before = [priced('А', 1), priced('Б', 2), priced('В', 3)];
    const after = [priced('А', 1), priced('Б', 5), priced('Г', 4)];
    const diff = diffItems(before, after);
    expect(diff).toMatchObject({ before: 3, after: 3, added: 1, removed: 1, changed: 1 });
    expect(diff.sample).toEqual([{ name: 'Б', field: 'price', was: '2', now: '5' }]);
  });

  test('тиражи и основание тиража различаются, образец ограничен', () => {
    const tiers = [{ minQuantity: 10, price: 5 }];
    const before = [priced('А', 5, { priceTiers: tiers })];
    const after = [priced('А', 5, { priceTiers: tiers, priceTierBasis: 'order_sum' })];
    expect(diffItems(before, after).changed).toBe(1);
    const many = Array.from({ length: 20 }, (_, i) => priced(`Т${i}`, i + 1));
    const moved = many.map((item) => ({ ...item, price: item.price + 1 }));
    const diff = diffItems(many, moved);
    expect(diff.changed).toBe(20);
    expect(diff.sample).toHaveLength(DIFF_SAMPLE_SIZE);
  });
});

describe('отпечаток формы таблицы', () => {
  const table = (rows: string[][]) => [rows];
  const header = ['Наименование', 'Артикул', 'Цена, руб'];

  test('те же шапка и ширина дают тот же отпечаток при других данных', () => {
    const a = tableFormFingerprint(table([header, ['Болт', 'A1', '10'], ['Гайка', 'A2', '5']]));
    const b = tableFormFingerprint(table([header, ['Шайба', 'B7', '99,5']]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('другая шапка, другая раскладка или ширина - другой отпечаток', () => {
    const base = tableFormFingerprint(table([header, ['Болт', 'A1', '10']]));
    const renamed = table([['Название', 'Артикул', 'Цена, руб'], ['Болт', 'A1', '10']]);
    expect(tableFormFingerprint(renamed)).not.toBe(base);
    const swapped = table([['Артикул', 'Наименование', 'Цена, руб'], ['A1', 'Болт', '10']]);
    expect(tableFormFingerprint(swapped)).not.toBe(base);
    expect(tableFormFingerprint(table([[...header, 'Остаток'], ['Болт', 'A1', '10', '5']])))
      .not.toBe(base);
  });

  test('цифры в шапке (даты, годы) не меняют отпечаток', () => {
    const a = tableFormFingerprint(table([['Наименование', 'Цена 2025'], ['Болт', '10']]));
    const b = tableFormFingerprint(table([['Наименование', 'Цена 2026'], ['Болт', '10']]));
    expect(a).toBe(b);
  });

  test('ступенчатые шапки с числами не склеиваются, а сами числа в отпечаток не входят', () => {
    const names = tableFormFingerprint(
      table([['Наименование', '50', '100', '500'], ['Болт', '1', '2', '3']]),
    );
    const skus = tableFormFingerprint(
      table([['Артикул', '10', '20', '30'], ['A1', '1', '2', '3']]),
    );
    expect(names).not.toBe(skus);
    const otherTiers = tableFormFingerprint(
      table([['Наименование', '10', '200', '1000'], ['Гайка', '7', '8', '9']]),
    );
    expect(otherTiers).toBe(names);
  });
});
