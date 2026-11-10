import { describe, expect, test } from 'bun:test';
import {
  collapseExactDuplicates,
  countSourceDataRows,
  reconcileScriptItems,
} from '../../src/agents/prices/script-reconcile';
import { parseScriptItems, toPriceItems } from '../../src/agents/prices/script-price-items';

/**
 * Сверка по покрытию (этап 117): синтетические таблицы четырёх раскладок, на которых сверка по
 * числу строк ошибалась, и негативы - выдуманная цена, потеря половины цен, перепутанные цены.
 */

type Table = string[][];
type RawItem = Record<string, unknown>;

function check(raw: RawItem[], tables: Table[], names?: string[]): string[] {
  const parsed = parseScriptItems(raw);
  const valid = collapseExactDuplicates(parsed.items);
  const items = toPriceItems(valid, { supplierId: 's1', date: '2026-10-28T00:00:00.000Z' });
  return reconcileScriptItems({
    rawCount: raw.length,
    parsed: { items: valid, invalid: parsed.invalid },
    items,
    sourceRows: countSourceDataRows(tables),
    sourceTables: tables,
    sourceTableNames: names,
  }).map((issue) => issue.code);
}

// --- 1. Матрица без столбца названия: блок = заголовок + размеры; плотности - три цены ---
const DENSITIES = ['360 г', '420 г', '460 г'];
const TOWELS: Array<{ title: string; rows: Array<[string, number, number, number, number]> }> = [
  { title: 'Полотенце махровое', rows: [['50х90', 100, 120, 140, 50], ['70х140', 250, 290, 330, 30]] },
  { title: 'Простыня хлопок', rows: [['150х220', 510, 560, 610, 20], ['200х220', 640, 690, 740, 10]] },
  { title: 'Халат вафельный', rows: [['M', 880, 930, 980, 15], ['XL', 910, 960, 1010, 15]] },
];

const matrixTable: Table = TOWELS.flatMap(({ title, rows }) => [
  [title, ...DENSITIES, 'Мин. партия'],
  ...rows.map(([size, a, b, c, min]) => [size, `${a}`, `${b}`, `${c}`, `${min}`]),
]);
const matrixItems = (): RawItem[] =>
  TOWELS.flatMap(({ title, rows }) =>
    rows.flatMap(([size, ...prices]) =>
      DENSITIES.map((density, i) => ({
        name: title,
        variant: `${size} ${density}`,
        price: prices[i],
      })),
    ),
  );

// --- 2. Блоки изделий на нескольких листах ---
const SPORT = [
  { sheet: 'Футболки', title: 'Футболка спортивная', lines: [['Кулирка', 'Печать', 450], ['Кулирка', 'Вышивка', 520]] },
  { sheet: 'Шорты', title: 'Шорты игровые', lines: [['Полиэстер', 'Печать', 610], ['Трикотаж', 'Вышивка', 700]] },
  { sheet: 'Гетры', title: 'Гетры футбольные', lines: [['Нейлон', 'Без нанесения', 330], ['Нейлон', 'Печать', 380]] },
] as const;
const sportTables: Table[] = SPORT.map(({ title, lines }) => [
  [title],
  ['Описание: быстросохнущий материал, швы плоские'],
  ['Ткань', 'Нанесение', 'Цена от 20 шт'],
  ...lines.map(([fabric, print, price]) => [fabric, print, `${price}`]),
]);
const sportNames = SPORT.map(({ sheet }) => sheet);
const sportItems = (): RawItem[] =>
  SPORT.flatMap(({ title, lines }) =>
    lines.map(([fabric, print, price]) => ({ name: title, variant: `${fabric} ${print}`, price })),
  );

// --- 3. Группы со шкалой тиражей в строке шапки ---
const SCALE = ['50 шт', '100 шт', '500 шт'];
const BOXES = [
  { group: 'КОНСТРУКЦИЯ КРЫШКА-ДНО', name: 'Коробка крышка-дно', lines: [['100х100х50', 60, 55, 50], ['200х150х80', 90, 82, 75]] },
  { group: 'ПЕЧАТЬ ШЕЛКОГРАФИЕЙ', name: 'Печать шелкографией', lines: [['1 цвет', 12, 10, 8], ['2 цвета', 19, 16, 13]] },
] as const;
const boxTable: Table = BOXES.flatMap(({ group, lines }) => [
  [group, ...SCALE],
  ...lines.map(([size, a, b, c]) => [size, `${a}`, `${b}`, `${c}`]),
]);
const boxItems = (): RawItem[] =>
  BOXES.flatMap(({ name, lines }) =>
    lines.map(([size, a, b, c]) => ({
      name,
      variant: size,
      price: a,
      tiers: [
        { min_quantity: 50, price: a },
        { min_quantity: 100, price: b },
        { min_quantity: 500, price: c },
      ],
    })),
  );

// --- 4. Два листа: на первом два товара в строке, на втором повторы банок ---
const teaSheet1: Table = [
  ['Чай Эрл Грей', 'Цена', 'Чай Сенча', 'Цена'],
  ['Чай Эрл Грей 100 г', '250', 'Чай Сенча 100 г', '270'],
  ['Чай Эрл Грей 500 г', '1100', 'Чай Сенча 500 г', '1200'],
];
const teaSheet2: Table = [
  ['Упаковка', 'Цена'],
  ...Array.from({ length: 8 }, () => ['Банка жестяная 100 мл', '35']),
  ...Array.from({ length: 6 }, () => ['Банка стеклянная 250 мл', '48']),
];
const teaItems = (): RawItem[] => [
  { name: 'Чай Эрл Грей 100 г', price: 250 },
  { name: 'Чай Сенча 100 г', price: 270 },
  { name: 'Чай Эрл Грей 500 г', price: 1100 },
  { name: 'Чай Сенча 500 г', price: 1200 },
  // Скрипт мог выдать повторы строк листа «Упаковка» как есть.
  ...Array.from({ length: 8 }, () => ({ name: 'Банка жестяная 100 мл', price: 35 })),
  ...Array.from({ length: 6 }, () => ({ name: 'Банка стеклянная 250 мл', price: 48 })),
];

describe('сверка по покрытию: раскладки без замечаний', () => {
  test('матрица без столбца названия: позиций больше строк в разы', () => {
    const raw = matrixItems();
    expect(raw.length).toBeGreaterThan(countSourceDataRows([matrixTable]) * 3 - 1);
    expect(check(raw, [matrixTable])).toEqual([]);
  });

  test('блоки изделий на нескольких листах', () => {
    expect(check(sportItems(), sportTables, sportNames)).toEqual([]);
  });

  test('название изделия берётся с названия листа, а не из ячеек', () => {
    const noTitles = sportTables.map((table) => table.slice(1));
    const raw = sportItems().map((item, i) => ({ ...item, name: `${SPORT[Math.floor(i / 2)]?.sheet}` }));
    expect(check(raw, noTitles, sportNames)).toEqual([]);
  });

  test('группы со шкалой тиражей в шапке', () => {
    expect(check(boxItems(), [boxTable])).toEqual([]);
  });

  test('два листа с повторами: точные дубли схлопываются', () => {
    expect(check(teaItems(), [teaSheet1, teaSheet2], ['Чай', 'Упаковка'])).toEqual([]);
  });
});

describe('сверка по покрытию: негативы', () => {
  test('выдуманная цена', () => {
    const raw = matrixItems();
    raw[3] = { ...raw[3], price: 777 };
    expect(check(raw, [matrixTable])).toContain('price_not_in_source');
    const boxes = boxItems();
    boxes[0] = { ...boxes[0], tiers: [{ min_quantity: 50, price: 61 }], price: 61 };
    expect(check(boxes, [boxTable])).toContain('price_not_in_source');
  });

  test('выдуманное название', () => {
    const raw = matrixItems();
    raw[0] = { name: 'Космический ковёр', variant: 'Ультра', price: 100 };
    expect(check(raw, [matrixTable])).toContain('name_not_in_source');
  });

  test('потеряна половина цен', () => {
    const matrix = matrixItems();
    expect(check(matrix.slice(0, matrix.length / 2), [matrixTable])).toContain(
      'source_prices_unused',
    );
    const sport = sportItems();
    expect(check(sport.slice(0, 3), sportTables, sportNames)).toContain('source_prices_unused');
  });

  test('перепутанные цены изделий', () => {
    // Каждое изделие получило цены соседнего: значения те же, но стоят не рядом с названием.
    const sport = sportItems();
    const shifted = sport.map((item, i) => ({ ...item, price: sport[(i + 2) % sport.length]?.price }));
    expect(check(shifted, sportTables, sportNames)).toContain('price_context_mismatch');
    const boxes = boxItems();
    const rotated = boxes.map((item, i) => {
      const other = boxes[(i + 2) % boxes.length];
      return { ...item, price: other?.price, tiers: other?.tiers };
    });
    expect(check(rotated, [boxTable])).toContain('price_context_mismatch');
  });

  test('одинаковые названия с разными ценами - ошибка, одинаковые с теми же - нет', () => {
    const raw = teaItems();
    raw.push({ name: 'Банка жестяная 100 мл', price: 48 });
    expect(check(raw, [teaSheet1, teaSheet2], ['Чай', 'Упаковка'])).toContain('duplicate_keys');
    expect(check(teaItems(), [teaSheet1, teaSheet2], ['Чай', 'Упаковка'])).not.toContain(
      'duplicate_keys',
    );
  });

  test('таблиц без цен нет: сверка по покрытию не включается', () => {
    const parsed = parseScriptItems([{ name: 'А', price: 1 }]);
    const items = toPriceItems(parsed.items, { supplierId: 's1', date: '2026-10-28T00:00:00.000Z' });
    const issues = reconcileScriptItems({
      rawCount: 1,
      parsed,
      items,
      sourceRows: 0,
      sourceTables: [[['Текст без чисел']]],
    });
    expect(issues).toEqual([]);
  });
});

/** Имя файла передаётся отдельным аргументом (этап s160). */
function checkFile(raw: RawItem[], tables: Table[], names: string[], fileName: string): string[] {
  const parsed = parseScriptItems(raw);
  const valid = collapseExactDuplicates(parsed.items);
  const items = toPriceItems(valid, { supplierId: 's1', date: '2026-10-28T00:00:00.000Z' });
  return reconcileScriptItems({
    rawCount: raw.length,
    parsed: { items: valid, invalid: parsed.invalid },
    items,
    sourceRows: countSourceDataRows(tables),
    sourceTables: tables,
    sourceTableNames: names,
    sourceFileName: fileName,
  }).map((issue) => issue.code);
}

// --- Название товара только в имени файла ---
const FILE_TABLE: Table = [
  ['Тираж', 'красный', 'синий'],
  ['100 шт', '31', '35'],
  ['500 шт', '23', '27'],
];
const fileItems = (name: string): RawItem[] => ['красный', 'синий'].map((variant, i) => ({
  name,
  variant,
  price: [31, 35][i],
  tiers: [{ min_quantity: 100, price: [31, 35][i] }, { min_quantity: 500, price: [23, 27][i] }],
}));

describe('имя файла как источник названия', () => {
  test('название только в имени файла принимается', () => {
    expect(checkFile(fileItems('Фонарик налобный'), [FILE_TABLE], ['Лист1'],
      'Прайс/Фонарик налобный оптом.xlsx')).toEqual([]);
  });

  test('без имени файла то же название отклоняется', () => {
    const codes = check(fileItems('Фонарик налобный'), [FILE_TABLE], ['Лист1']);
    expect(codes).toContain('name_not_in_source');
  });

  test('название нигде не встречается - отклоняется и с именем файла', () => {
    const codes = checkFile(fileItems('Гирлянда новогодняя'), [FILE_TABLE], ['Лист1'],
      'Фонарик налобный оптом.xlsx');
    expect(codes).toContain('name_not_in_source');
  });
});

// --- Объединённые ячейки: название только у первой строки группы ---
const MERGED_TABLE: Table = [
  ['Артикул', 'Материал', 'Тираж', 'Цена'],
  ['A-1', 'Велюр плотный', 'от 10-50', '410'],
  ['', '', 'от 51-100', '380'],
  ['A-2', 'Замша тонкая', 'от 10-50', '360'],
  ['', '', 'от 51-100', '330'],
];
const mergedItems = (swap: boolean): RawItem[] => [
  { name: 'Подушка диванная Велюр', price: swap ? 360 : 410,
    tiers: [
      { min_quantity: 10, price: swap ? 360 : 410 },
      { min_quantity: 51, price: swap ? 330 : 380 },
    ] },
  { name: 'Подушка диванная Замша', price: swap ? 410 : 360,
    tiers: [
      { min_quantity: 10, price: swap ? 410 : 360 },
      { min_quantity: 51, price: swap ? 380 : 330 },
    ] },
];

describe('объединённые ячейки названия', () => {
  test('цены продолжающих строк относятся к названию владельца группы', () => {
    expect(checkFile(mergedItems(false), [MERGED_TABLE], ['Подушки'], 'Прайс подушки.xlsx'))
      .toEqual([]);
  });

  test('перепутанные цены между группами по-прежнему отклоняются', () => {
    const codes = checkFile(mergedItems(true), [MERGED_TABLE], ['Подушки'], 'Прайс подушки.xlsx');
    expect(codes).toContain('price_context_mismatch');
  });
});

describe('основа слова с беглой гласной', () => {
  test('«значок» в позиции находит «значки» в имени файла', () => {
    expect(checkFile(fileItems('Значок закатный круглый'), [FILE_TABLE], ['Лист1'],
      'Прайс значки закатные.xlsx')).toEqual([]);
  });
});
