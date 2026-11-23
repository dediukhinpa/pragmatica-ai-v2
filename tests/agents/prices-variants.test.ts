import { beforeEach, describe, expect, test } from 'bun:test';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { countDataRows, parseTableRows } from '../../src/agents/prices/table-rows';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagedImportValidator } from '../../src/agents/prices/commit-price-import';
import { CTX, SUPPLIER_ID, putFile } from './support';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

const PARAMS = {
  supplierId: 's1',
  headerRows: 1,
  defaultCurrency: 'RUB',
  date: '2026-10-01',
};

/** Таблица «название | цена | артикул | размер | цвет» (синтетическая). */
const HEAD = ['Наименование', 'Цена', 'Артикул', 'Размер', 'Цвет'];
const VARIANT_COLUMNS = { name: 0, price: 1, sku: 2, variantColumns: [3, 4] };

describe('варианты товара: название и ключ собирает код', () => {
  test('название = «название вариант1 вариант2», разные размеры не дубли по названию', () => {
    const out = parseTableRows(
      [
        HEAD,
        ['Футболка', '500', '', 'S', 'синий'],
        ['Футболка', '550', '', 'M', 'синий'],
        ['Футболка', '600', '', 'M', 'красный'],
      ],
      { ...PARAMS, columns: { name: 0, price: 1, sku: 2, variantColumns: [3, 4] } },
    );
    expect(out.items.map((i) => i.productName)).toEqual([
      'Футболка S синий',
      'Футболка M синий',
      'Футболка M красный',
    ]);
    expect(out.rejected).toEqual([]);
    expect(out.sourceRowCount).toBe(3);
  });

  test('вариант, уже названный в названии, не дублируется (целым словом)', () => {
    const out = parseTableRows(
      [
        HEAD,
        ['Кружка синяя 300 мл', '100', '', '300 мл', 'синяя'],
        ['Shirt', '100', '', 'S', ''],
      ],
      { ...PARAMS, columns: VARIANT_COLUMNS },
    );
    expect(out.items.map((i) => i.productName)).toEqual(['Кружка синяя 300 мл', 'Shirt S']);
  });

  test('общий артикул с разными размерами: артикул получает вариант, ключи различаются', () => {
    const out = parseTableRows(
      [HEAD, ['Футболка', '500', 'FT-1', 'S', ''], ['Футболка', '550', 'FT-1', 'M', '']],
      { ...PARAMS, columns: VARIANT_COLUMNS },
    );
    expect(out.items.map((i) => i.sku)).toEqual(['FT-1 / S', 'FT-1 / M']);
  });

  test('без variantColumns ничего не меняется: названия как в файле', () => {
    const out = parseTableRows(
      [HEAD, ['Футболка', '500', 'FT-1', 'S', '']],
      { ...PARAMS, columns: { name: 0, price: 1, sku: 2 } },
    );
    expect(out.items[0]?.productName).toBe('Футболка');
    expect(out.items[0]?.sku).toBe('FT-1');
  });
});

describe('группы: название в строке-заголовке или в столбце группы', () => {
  test('groupHeaderRows: строки без названия получают название группы и вариант', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Цена', 'Размер'],
        ['Худи Классика', '', ''],
        ['', '2000', 'S'],
        ['', '2100', 'XL'],
        ['Худи Спорт', '', ''],
        ['', '2500', 'M'],
      ],
      { ...PARAMS, columns: { name: 0, price: 1, variantColumns: [2], groupHeaderRows: true } },
    );
    expect(out.items.map((i) => [i.productName, i.price])).toEqual([
      ['Худи Классика S', 2000],
      ['Худи Классика XL', 2100],
      ['Худи Спорт M', 2500],
    ]);
    expect(out.skipped.map((s) => s.row)).toEqual([1, 4]);
    expect(out.rejected).toEqual([]);
  });

  test('без groupHeaderRows строка без названия по-прежнему отклоняется', () => {
    const out = parseTableRows(
      [['Наименование', 'Цена'], ['Худи', ''], ['', '2000']],
      { ...PARAMS, columns: { name: 0, price: 1 } },
    );
    expect(out.items).toEqual([]);
    expect(out.rejected).toEqual([{ row: 2, reason: 'пустое название' }]);
  });

  test('собственное название строки сильнее названия группы', () => {
    const out = parseTableRows(
      [['Наименование', 'Цена'], ['Кружки', ''], ['Кружка белая', '100'], ['', '120']],
      { ...PARAMS, columns: { name: 0, price: 1, groupHeaderRows: true } },
    );
    expect(out.items.map((i) => i.productName)).toEqual(['Кружка белая', 'Кружки']);
  });

  test('столбец group: название берётся из группы, пустая ячейка группы - прежняя группа', () => {
    const out = parseTableRows(
      [
        ['Модель', 'Название', 'Цена', 'Размер'],
        ['Куртка Зима', '', '5000', '44'],
        ['', '', '5200', '46'],
        ['Куртка Лето', '', '3000', '44'],
      ],
      { ...PARAMS, columns: { name: 1, price: 2, group: 0, variantColumns: [3] } },
    );
    expect(out.items.map((i) => i.productName)).toEqual([
      'Куртка Зима 44',
      'Куртка Зима 46',
      'Куртка Лето 44',
    ]);
  });

  test('группа сбрасывает прежнее название: пустая строка после нового заголовка', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Цена', 'Размер'],
        ['Шарф', '300', 'L'],
        ['Перчатки', '', ''],
        ['', '200', 'M'],
      ],
      { ...PARAMS, columns: { name: 0, price: 1, variantColumns: [2], groupHeaderRows: true } },
    );
    expect(out.items.map((i) => i.productName)).toEqual(['Шарф L', 'Перчатки M']);
  });
});

describe('объединённые ячейки названия', () => {
  test('пустое название у строки с вариантом заполняется значением сверху', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Цена', 'Вес'],
        ['Мёд липовый', '400', '250 г'],
        ['', '700', '500 г'],
        ['', '1200', '1 кг'],
        ['Мёд гречишный', '450', '250 г'],
        ['', '800', '500 г'],
      ],
      { ...PARAMS, columns: { name: 0, price: 1, variantColumns: [2] } },
    );
    expect(out.items.map((i) => i.productName)).toEqual([
      'Мёд липовый 250 г',
      'Мёд липовый 500 г',
      'Мёд липовый 1 кг',
      'Мёд гречишный 250 г',
      'Мёд гречишный 500 г',
    ]);
    expect(out.rejected).toEqual([]);
  });

  test('пустое название без варианта и без группы - по-прежнему отклонено', () => {
    const out = parseTableRows(
      [['Наименование', 'Цена', 'Вес'], ['Мёд', '400', '250 г'], ['', '700', '']],
      { ...PARAMS, columns: { name: 0, price: 1, variantColumns: [2] } },
    );
    expect(out.rejected).toEqual([{ row: 2, reason: 'пустое название' }]);
  });
});

describe('повторная шапка внутри листа', () => {
  const COLUMNS = { name: 0, price: 1, variantColumns: [2] };

  test('дословный повтор шапки и шапка без цены - skipped с причиной, не rejected', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Цена, руб.', 'Размер'],
        ['Шарф', '300', 'L'],
        ['Наименование', 'Цена, руб.', 'Размер'],
        ['Наименование', '', 'Размер'],
        ['Перчатки', '200', 'M'],
      ],
      { ...PARAMS, columns: COLUMNS },
    );
    expect(out.items).toHaveLength(2);
    expect(out.rejected).toEqual([]);
    expect(out.skipped.map((s) => [s.row, s.reason])).toEqual([
      [2, 'повторная шапка таблицы'],
      [3, 'повторная шапка таблицы'],
    ]);
    expect(out.sourceRowCount).toBe(2);
  });

  test('шапка с названием столбца цены вместо числа тоже пропускается', () => {
    const out = parseTableRows(
      [['Наименование', 'Цена'], ['Шарф', '300'], ['Модель', 'Розничная цена'], ['Гетры', '90']],
      { ...PARAMS, columns: { name: 0, price: 1 } },
    );
    expect(out.rejected).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(['повторная шапка таблицы']);
  });

  test('заголовок группы «Товары для дома» шапкой не считается', () => {
    const out = parseTableRows(
      [['Наименование', 'Цена'], ['Товары для дома', ''], ['Ведро', '100']],
      { ...PARAMS, columns: { name: 0, price: 1 } },
    );
    expect(out.skipped[0]?.reason).toContain('заголовок группы');
  });
});

describe('настоящие дубли и дубли с разной ценой', () => {
  test('то же название, варианты и цена - схлопывается, строка в skipped с пометкой', () => {
    const table = [
      HEAD,
      ['Футболка', '500', '', 'S', ''],
      ['Футболка', '500', '', 'S', ''],
      ['Футболка', '500', '', 'M', ''],
    ];
    const params = { ...PARAMS, columns: VARIANT_COLUMNS };
    const out = parseTableRows(table, params);
    expect(out.items.map((i) => i.productName)).toEqual(['Футболка S', 'Футболка M']);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.reason).toContain('схлопнут');
    expect(out.sourceRowCount).toBe(2);
    expect(countDataRows(table, 1, VARIANT_COLUMNS)).toBe(2);
  });

  test('схлопывание не зависит от границ куска', () => {
    const table = [HEAD, ['Футболка', '500', '', 'S', ''], ['Футболка', '500', '', 'S', '']];
    const params = { ...PARAMS, columns: VARIANT_COLUMNS };
    expect(parseTableRows(table, params, 2, 3).items).toEqual([]);
    expect(parseTableRows(table, params, 1, 2).items).toHaveLength(1);
  });

  test('то же название и варианты, разные цены - обе позиции остаются', () => {
    const out = parseTableRows(
      [HEAD, ['Футболка', '500', '', 'S', ''], ['Футболка', '600', '', 'S', '']],
      { ...PARAMS, columns: VARIANT_COLUMNS },
    );
    expect(out.items).toHaveLength(2);
    expect(out.skipped).toEqual([]);
  });
});

describe('инструменты: нормализация, запись, staging', () => {
  const CSV = [
    'Наименование,Цена,Артикул,Размер',
    'Худи Классика,,,',
    ',2000,HD-1,S',
    ',2100,HD-1,XL',
    'Наименование,Цена,Артикул,Размер',
    'Худи Спорт,,,',
    ',2500,HD-2,M',
    ',2500,HD-2,M',
  ].join('\n');
  const columns = {
    name: 0,
    price: 1,
    sku: 2,
    variantColumns: [3],
    groupHeaderRows: true,
  };

  test('без variantColumns/groupHeaderRows та же таблица блокируется на проверку', async () => {
    putFile(deps, 'v.csv', CSV);
    const columns = { name: 0, price: 1, sku: 2 };
    const input = { path: 'v.csv', supplierId: SUPPLIER_ID, columns };
    const out = await normalizePriceTable.execute(input, deps, CTX);
    expect(out.rejected.length).toBeGreaterThan(0);
  });

  test('normalizePriceTable + savePriceImport: варианты различимы, дубль схлопнут', async () => {
    putFile(deps, 'v.csv', CSV);
    const input = { path: 'v.csv', supplierId: SUPPLIER_ID, columns };
    const out = await normalizePriceTable.execute(input, deps, CTX);
    expect(out.rejected).toEqual([]);
    expect(out.items.map((i) => i.productName)).toEqual([
      'Худи Классика S',
      'Худи Классика XL',
      'Худи Спорт M',
    ]);
    expect(out.skippedRows.some((s) => s.reason.includes('схлопнут'))).toBe(true);
    const saveInput = { ...input, tableIndex: 0, headerRows: 1, fileHash: out.fileHash };
    const parsed = savePriceImport.inputSchema.parse(saveInput);
    expect(await priceImportValidator.validate(parsed, deps, CTX)).toEqual([]);
    const saved = await savePriceImport.execute(parsed, deps, CTX);
    expect(saved.saved).toBe(3);
  });

  test('разные цены при тех же названии и вариантах - дубль на проверку (blocked)', async () => {
    putFile(deps, 'd.csv', 'Наименование,Цена,Размер\nФутболка,500,S\nФутболка,600,S');
    const input = {
      path: 'd.csv',
      supplierId: SUPPLIER_ID,
      columns: { name: 0, price: 1, variantColumns: [2] },
    };
    const out = await normalizePriceTable.execute(input, deps, CTX);
    const parsed = savePriceImport.inputSchema.parse({
      ...input,
      tableIndex: 0,
      headerRows: 1,
      fileHash: out.fileHash,
    });
    const issues = await priceImportValidator.validate(parsed, deps, CTX);
    expect(issues.map((i) => i.code)).toContain('duplicate_row');
  });

  test('stagePriceRows кусками: число строк сходится, фиксация проходит', async () => {
    putFile(deps, 'v.csv', CSV);
    const base = { path: 'v.csv', supplierId: SUPPLIER_ID, columns };
    // Кусок режется между заголовком группы и её вариантами: группа переходит через границу.
    const first = await stagePriceRows.execute(
      { ...base, reset: true, headerRows: 1, tableIndex: 0, toRow: 3 },
      deps,
      CTX,
    );
    const second = await stagePriceRows.execute(
      { ...base, reset: false, headerRows: 1, tableIndex: 0, fromRow: first.nextRow ?? 3 },
      deps,
      CTX,
    );
    expect(second.nextRow).toBeNull();
    expect(second.totalStaged).toBe(3);
    const commit = { supplierId: SUPPLIER_ID, fileHash: first.fileHash };
    expect(await stagedImportValidator.validate(commit, deps, CTX)).toEqual([]);
  });
});

describe('промпт «Прайсов»', () => {
  test('объясняет variantColumns и groupHeaderRows', () => {
    expect(PRICES_PROMPT).toContain('variantColumns');
    expect(PRICES_PROMPT).toContain('groupHeaderRows=true');
    expect(PRICES_PROMPT).toContain('повторная шапка');
  });
});
