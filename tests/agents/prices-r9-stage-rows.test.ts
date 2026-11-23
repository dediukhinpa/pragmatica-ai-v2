import { beforeEach, describe, expect, test } from 'bun:test';
import { countDataRows, parseTableRows } from '../../src/agents/prices/table-rows';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { PRICE_WITH_SUFFIX, normalizePriceCell } from '../../src/agents/prices/currencies';
import { parseNumberText } from '../../src/kit/domain/number-text';
import type { ParsedDocument } from '@business-ai/core';
import { rng } from '@business-ai/testing';
import { CTX, SUPPLIER_ID, buildPricesDeps, putFile } from './support';

/**
 * R9-A1-03: большой прайс кусками `stagePriceRows` - без повторного разбора файла и пересчёта
 * всей таблицы на каждом куске, ячейка цены разбирается один раз, а регулярка валюты в конце
 * ячейки - без медленного в JSC просмотра назад.
 */

const COLUMNS = { name: 0, price: 1 };
/** Прайс крупнее прежнего бюджета кэша разборов (6 млн символов), как лист в 30 тыс. строк. */
const BIG_ROWS = 30_000;
const DESCRIPTION = 'Описание позиции для проверки бюджета кэша разборов прайса';

function bigTable(): string[][] {
  return [
    ['Наименование', 'Цена, руб.', 'Описание', 'Описание', 'Описание', 'Описание'],
    ...Array.from({ length: BIG_ROWS }, (_, i) => [
      `Товар ${i}`,
      `${100 + (i % 50)},50`,
      DESCRIPTION,
      DESCRIPTION,
      DESCRIPTION,
      DESCRIPTION,
    ]),
  ];
}

describe('R9-A1-03: stagePriceRows по большому прайсу', () => {
  let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
  let parseCalls = 0;
  let parsed: ParsedDocument;

  beforeEach(async () => {
    deps = await buildPricesDeps();
    parseCalls = 0;
    parsed = {
      text: '',
      tables: [bigTable()],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
    deps.parser = {
      async parse(): Promise<ParsedDocument> {
        parseCalls += 1;
        return parsed;
      },
    };
  });

  const stage = (fromRow: number, toRow: number) =>
    stagePriceRows.execute(
      {
        path: 'big.csv',
        supplierId: SUPPLIER_ID,
        tableIndex: 0,
        headerRows: 1,
        columns: COLUMNS,
        fromRow,
        toRow,
        reset: false,
      },
      deps,
      CTX,
    );

  test('разбор прайса в 30 тыс. строк кэшируется: куски не разбирают файл заново', async () => {
    putFile(deps, 'big.csv', 'stub');
    const CHUNK = 10_000;
    const first = await stage(1, 1 + CHUNK);
    await stage(1 + CHUNK, 1 + 2 * CHUNK);
    const last = await stage(1 + 2 * CHUNK, 1 + 3 * CHUNK);
    // Раньше разбор крупнее 6 млн символов не кэшировался: по разбору на кусок.
    expect(parseCalls).toBe(1);
    expect(first.tableDataRows).toBe(BIG_ROWS);
    expect(last.totalStaged).toBe(BIG_ROWS);
    expect(last.nextRow).toBeNull();
  }, 60_000);
});

describe('R9-A1-03: число строк данных таблицы считается один раз', () => {
  test('повторный вызов по той же таблице и столбцам не проходит строки', () => {
    let rowReads = 0;
    const rows = bigTable().slice(0, 1_001);
    const table = new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(countDataRows(table, 1, COLUMNS)).toBe(1_000);
    const firstReads = rowReads;
    expect(firstReads).toBeGreaterThanOrEqual(1_000);
    expect(countDataRows(table, 1, COLUMNS)).toBe(1_000);
    expect(rowReads).toBe(firstReads);
    // Другие столбцы или заголовок - другой счёт.
    expect(countDataRows(table, 2, COLUMNS)).toBe(999);
    expect(countDataRows(table, 1, { name: 2, price: 0 })).toBe(0);
  });
});

/** Прежняя регулярка валюты в конце ячейки - с просмотром назад (эталон набора ячеек). */
const LOOKBEHIND_SUFFIX = new RegExp(
  PRICE_WITH_SUFFIX.source.replace('^(|.*?[^\\p{L}])\\s?(', '^(.*?)\\s?(?<![\\p{L}])('),
  'iu',
);

describe('R9-A1-03: регулярка валюты без просмотра назад', () => {
  test('эталонная регулярка действительно прежняя', () => {
    expect(LOOKBEHIND_SUFFIX.source).toContain('(?<![\\p{L}])');
    expect(LOOKBEHIND_SUFFIX.source).not.toBe(PRICE_WITH_SUFFIX.source);
  });

  test('те же ячейки дают ту же валюту и то же число', () => {
    const random = rng(303);
    const PARTS = [
      '1', '2', '0', '9', ' ', ',', '.', '-', 'а', 'б', 'z', 'р', 'р.', 'руб', 'руб.', '₽', '$',
      'usd', 'USD', 'eur', '€', '¥', 'тыс', 'abc', '/', 'шт', ' руб.', '100', '1 234',
    ];
    const outcome = (regex: RegExp, raw: string): string => {
      const text = normalizePriceCell(raw);
      const match = regex.exec(text);
      if (match === null) return 'none';
      return JSON.stringify([parseNumberText(match[1] ?? ''), (match[2] ?? '').toLowerCase()]);
    };
    for (let round = 0; round < 20_000; round += 1) {
      const length = 1 + Math.floor(random() * 6);
      const raw = Array.from(
        { length },
        () => PARTS[Math.floor(random() * PARTS.length)] as string,
      ).join('');
      expect(outcome(PRICE_WITH_SUFFIX, raw)).toBe(outcome(LOOKBEHIND_SUFFIX, raw));
    }
  });

  test('регулярка в разы быстрее прежней на обычных ячейках цены', () => {
    const cells = Array.from({ length: 20_000 }, (_, i) =>
      i % 2 === 0 ? `${1 + (i % 900)} 234,50` : `${1 + (i % 900)} 234,50 руб.`,
    );
    const timed = (regex: RegExp): number => {
      const started = performance.now();
      for (const cell of cells) regex.exec(cell);
      return performance.now() - started;
    };
    timed(PRICE_WITH_SUFFIX);
    timed(LOOKBEHIND_SUFFIX);
    // Сравнение относительное (хост тестов бывает загружен): на этом хосте разница 10-15 раз.
    const MIN_SPEEDUP = 4;
    expect(timed(PRICE_WITH_SUFFIX) * MIN_SPEEDUP).toBeLessThan(timed(LOOKBEHIND_SUFFIX));
  });

  test('разбор строк таблицы: годные, отклонённые и пропущенные - как раньше', () => {
    const table = [
      ['Наименование', 'Цена'],
      ['Болт', '1 234,50 руб.'],
      ['Гайка', '1,234'],
      ['Шайба', 'abc'],
      ['Группа', ''],
      ['Итого', '100'],
      ['Винт', '0'],
      ['Скоба', 'по запросу'],
    ];
    const rows = parseTableRows(table, {
      supplierId: SUPPLIER_ID,
      headerRows: 1,
      columns: COLUMNS,
      defaultCurrency: 'RUB',
      date: '2026-10-01T00:00:00.000Z',
    });
    expect(rows.items.map((item) => [item.productName, item.price, item.currency])).toEqual([
      ['Болт', 1234.5, 'RUB'],
    ]);
    expect(rows.rejected.map((row) => [row.row, row.reason])).toEqual([
      [2, 'цена неоднозначна (запятая или точка), уточните'],
      [3, 'цена не распознана'],
    ]);
    expect(rows.skipped.map((row) => row.row)).toEqual([4, 5, 6, 7]);
    expect(rows.sourceRowCount).toBe(3);
  });
});
