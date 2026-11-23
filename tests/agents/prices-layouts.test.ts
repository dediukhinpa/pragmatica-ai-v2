import { beforeEach, describe, expect, test } from 'bun:test';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import {
  countSourceDataRows,
  countSourceItemUnits,
  reconcileScriptItems,
} from '../../src/agents/prices/script-reconcile';
import { parseScriptItems, toPriceItems } from '../../src/agents/prices/script-price-items';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { withSheetNames } from '../../src/agents/prices/sheet-tables';
import type { ParsedDocument } from '@business-ai/core';
import { CTX, buildPricesDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
beforeEach(async () => {
  deps = await buildPricesDeps();
});

function md(rows: string[][]): string {
  const [head = [], ...body] = rows;
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');
}

const BADGE = [['Товар', 'Цена'], ['Лента', '10']];
const COST = [['Себестоимость', 'Наценка'], ['5', '100%']];
const WORKBOOK_TEXT = [
  '## Лист: Прайс',
  md(BADGE),
  '## Лист: Прибыль при сборке [hidden]',
  md(COST),
  '## Лист: Пустой',
  '_(пусто)_',
  '## Лист: Лист34 [hidden]',
  md(COST),
].join('\n\n');

function workbook(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    text: WORKBOOK_TEXT,
    tables: [BADGE, COST, COST],
    needsOcr: false,
    hasHiddenContent: true,
    hiddenSheets: ['Прибыль при сборке', 'Лист34'],
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

describe('скрытые листы читаются с предупреждением', () => {
  test('таблицы скрытых листов читаются и помечены, предупреждение называет листы', () => {
    const out = withSheetNames(workbook());
    expect(out.tables).toEqual([BADGE, COST, COST]);
    expect(out.tableNames).toEqual([
      'Прайс',
      'Прибыль при сборке (скрытый лист)',
      'Лист34 (скрытый лист)',
    ]);
    expect(out.hiddenSheets).toEqual(['Прибыль при сборке', 'Лист34']);
    expect(out.warnings.join()).toContain('скрытые листы, они прочитаны');
    expect(out.warnings.join()).toContain('Прибыль при сборке, Лист34');
  });

  test('readPriceFile: агент видит скрытый лист с пометкой, названия и флаги', async () => {
    putFile(deps, 'badges.xlsx', 'x');
    const stub = { ...deps, parser: { parse: async () => workbook() } };
    const out = await readPriceFile.execute({ path: 'badges.xlsx' }, stub, CTX);
    expect(out.tableCount).toBe(3);
    expect(out.tableNames[0]).toBe('Прайс');
    expect(out.markdown).toContain('Таблица 0: «Прайс»');
    expect(out.markdown).toContain('Себестоимость');
    expect(out.markdown).toContain('(скрытый лист)');
    expect(out.warnings.join()).toContain('скрытые листы');
    expect(out.hidden).toBe(true);
    expect(out.hiddenSheets).toEqual(['Прибыль при сборке', 'Лист34']);
  });

  test('все листы скрыты: таблица читается с пометкой', () => {
    const text = `## Лист: A [hidden]\n\n${md(COST)}`;
    const out = withSheetNames(
      workbook({ text, tables: [COST], hiddenSheets: ['A'] }),
    );
    expect(out.tables).toEqual([COST]);
    expect(out.tableNames).toEqual(['A (скрытый лист)']);
  });

  test('число таблиц не сошлось с разметкой: отдаём как есть, есть предупреждение', () => {
    const out = withSheetNames(workbook({ tables: [BADGE] }));
    expect(out.tables).toEqual([BADGE]);
    expect(out.warnings.join()).toContain('отделить их таблицы от видимых не удалось');
  });

  test('документ без листов (csv, pdf) не меняется', () => {
    const doc = workbook({ text: md(BADGE), tables: [BADGE], hiddenSheets: [] });
    expect(withSheetNames(doc)).toBe(doc);
  });
});

function check(raw: unknown[], tables: string[][][]): string[] {
  const parsed = parseScriptItems(raw);
  const items = toPriceItems(parsed.items, { supplierId: 's1', date: '2026-10-28T00:00:00.000Z' });
  return reconcileScriptItems({
    rawCount: raw.length,
    parsed,
    items,
    sourceRows: countSourceDataRows(tables),
    sourceUnits: countSourceItemUnits(tables),
  }).map((issue) => issue.code);
}

describe('раскладки: сверка скрипта', () => {
  test('лист = товар: вертикальные тиражи и допы дают товар и опции без замечаний', () => {
    const sheet = [
      ['Браслет силиконовый стандарт', ''],
      ['ТИРАЖ', 'цена за шт с НДС'],
      ['от 100 до 299 шт', '68'],
      ['от 300 до 499 шт', '61'],
      ['от 500 до 999 шт', '55'],
      ['от 1000 шт', '50'],
      ['ДОПОЛНИТЕЛЬНО', ''],
      ['Добавить цвет нанесения', '7'],
      ['Нумерация', '9'],
    ];
    const raw = [
      {
        name: 'Стандарт',
        price: 68,
        tiers: [
          { min_quantity: 100, price: 68 },
          { min_quantity: 300, price: 61 },
          { min_quantity: 500, price: 55 },
          { min_quantity: 1000, price: 50 },
        ],
      },
      { name: 'Стандарт', variant: 'Добавить цвет нанесения', price: 7 },
      { name: 'Стандарт', variant: 'Нумерация', price: 9 },
    ];
    expect(check(raw, [sheet])).toEqual([]);
    // Один товар на лист без допов тоже проходит (раньше «от 100 до 299 шт» строкой не считалось).
    expect(check([raw[0]], [sheet.slice(0, 6)])).toEqual([]);
  });

  test('два товара в строке: позиций вдвое больше строк, это норма', () => {
    const table = [
      ['Чай черный 50гр', '', '', '', 'Чай зеленый 50гр', '', '', ''],
      ['', '50', '100', '200', '', '50', '100', '200'],
      ['Чай черный с мятой', '321.48', '292', '263', 'Зеленый чай с мятой', '345', '321', '287'],
      ['Чай черный с чабрецом', '330', '300', '270', 'Зеленый чай с жасмином', '350', '325', '290'],
      ['Чай черный классик', '300', '280', '250', 'Зеленый чай классик', '320', '300', '270'],
    ];
    const tiers = (a: number, b: number, c: number) => [
      { min_quantity: 50, price: a },
      { min_quantity: 100, price: b },
      { min_quantity: 200, price: c },
    ];
    const raw = [
      ['Чай черный с мятой', 321.48, 292, 263],
      ['Зеленый чай с мятой', 345, 321, 287],
      ['Чай черный с чабрецом', 330, 300, 270],
      ['Зеленый чай с жасмином', 350, 325, 290],
      ['Чай черный классик', 300, 280, 250],
      ['Зеленый чай классик', 320, 300, 270],
    ].map(([name, a, b, c]) => ({
      name,
      price: a,
      tiers: tiers(a as number, b as number, c as number),
    }));
    expect(check(raw, [table])).toEqual([]);
  });

  test('несколько блоков со своей шкалой: шапки шкал не считаются строками данных', () => {
    const table = [
      ['Тираж', 'мин.72', '100', '200'],
      ['Шар стеклянный', '120', '110', '100'],
      ['Доп. цвет', '15', '14', '13'],
      ['Упаковка', '30', '28', '25'],
      ['Тираж', 'мин.60', '100', '200'],
      ['Шар малый', '90', '80', '70'],
      ['Доп. цвет', '12', '11', '10'],
      ['Упаковка', '25', '23', '20'],
    ];
    expect(countSourceDataRows([table])).toBe(6);
    const item = (name: string, min: number, p: number[]) => ({
      name,
      price: p[0],
      tiers: [min, 100, 200].map((q, i) => ({ min_quantity: q, price: p[i] })),
    });
    const raw = [
      item('Шар стеклянный', 72, [120, 110, 100]),
      { ...item('Шар стеклянный', 72, [15, 14, 13]), variant: 'Доп. цвет' },
      { ...item('Шар стеклянный', 72, [30, 28, 25]), variant: 'Упаковка' },
      item('Шар малый', 60, [90, 80, 70]),
      { ...item('Шар малый', 60, [12, 11, 10]), variant: 'Доп. цвет' },
      { ...item('Шар малый', 60, [25, 23, 20]), variant: 'Упаковка' },
    ];
    expect(check(raw, [table])).toEqual([]);
  });
});

describe('правила в промпте', () => {
  test('скрытые листы, раскладки и «Прагматика» - покупатель', () => {
    expect(PRICES_PROMPT).toContain('Скрытые листы читаются, как видимые, но с предупреждением');
    expect(PRICES_PROMPT).toContain('Лист = товар');
    expect(PRICES_PROMPT).toContain('Два товара в строке');
    expect(PRICES_PROMPT).toContain('Несколько товарных блоков на листе');
    expect(PRICES_PROMPT).toContain('это МЫ, покупатель');
  });
});
