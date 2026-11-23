import { beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@business-ai/core';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import {
  SCAN_IMPORT_WARNING,
  SCAN_TABLE_HEADER,
  ScanTableDocumentParser,
  withScanTableParser,
} from '../../src/scan-price-parser';
import { CTX, SUPPLIER_ID, putFile } from '../agents/support';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';
import {
  DOUBTFUL_PRICE_LIST,
  MUG_INVOICE,
  PNG_HEAD,
  SCAN_WARNING,
  recognizedScan,
  scanParserOf,
} from './scan-fixtures';

/**
 * П6, этап 9v: сканы прайсов идут в базу без подтверждения владельца (с диска) тем же путём, что
 * текстовые файлы; позиции с нечитаемыми или несошедшимися числами не пишутся и уходят «на
 * проверку» предупреждением. Из чата правило «в базу пишется только диск» сохраняется.
 */

const SCAN_FILE = 'Прайсы/кружки скан.png';
/** Столбцы таблицы из скана: название, количество, цена, сумма. */
const COLUMNS = { name: 0, price: 2 };

let deps: FullPricesDeps;

beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

/** Параметры записи по таблице скана. */
function importArgs(path: string, fileHash: string) {
  return {
    path,
    supplierId: SUPPLIER_ID,
    fileHash,
    tableIndex: 0,
    headerRows: 1,
    columns: COLUMNS,
    defaultCurrency: 'RUB',
  };
}

describe('скан-прайс с диска: позиции в базу без подтверждения', () => {
  beforeEach(() => {
    deps.parser = withScanTableParser(scanParserOf(recognizedScan(DOUBTFUL_PRICE_LIST)), true);
    putFile(deps, SCAN_FILE, 'png');
  });

  test('чтение: таблица из понятных позиций, предупреждения «из скана» и проверки', async () => {
    const page = await readPriceFile.execute({ path: SCAN_FILE }, deps, CTX);
    expect(page.needsOcr).toBe(false);
    expect(page.tableCount).toBe(1);
    expect(page.tableRows).toEqual([3]);
    expect(page.markdown).toContain('Кружка керамическая');
    expect(page.markdown).toContain('Салфетница пластиковая');
    expect(page.markdown).not.toContain('Блюдце');
    expect(page.markdown).not.toContain('Ложка');
    expect(page.warnings).toContain(SCAN_WARNING);
    expect(page.warnings).toContain(SCAN_IMPORT_WARNING);
    const review = page.warnings.find((warning) => warning.includes('на проверку'));
    expect(review).toContain('на проверку 2 поз.');
    expect(review).toContain('«Блюдце фарфоровое» (цена не читается или неоднозначна)');
    expect(review).toContain('«Ложка чайная» (цена x количество не равны сумме)');
  });

  test('запись: понятные позиции в базе, спорные нет, источник - файл-скан', async () => {
    const page = await readPriceFile.execute({ path: SCAN_FILE }, deps, CTX);
    const out = await savePriceImport.execute(importArgs(SCAN_FILE, page.hash), deps, CTX);
    expect(out).toMatchObject({ supplierId: SUPPLIER_ID, saved: 2, changed: 2 });
    const items = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(items.map((item) => [item.productName, item.price]).sort()).toEqual([
      ['Кружка керамическая', 250],
      ['Салфетница пластиковая', 75],
    ]);
    // Происхождение записи: файл-скан (расширение картинки) в sourceFile, колонки «источник» нет
    expect(items.every((item) => item.sourceFile === SCAN_FILE)).toBe(true);
  });

  test('stagePriceRows: две позиции в staging, спорные не блокируют запись', async () => {
    const page = await readPriceFile.execute({ path: SCAN_FILE }, deps, CTX);
    const staged = await stagePriceRows.execute(
      { ...importArgs(SCAN_FILE, page.hash), reset: true },
      deps,
      CTX,
    );
    expect(staged).toMatchObject({ staged: 2, rejectedCount: 0, nextRow: null });
  });

  test('шапка таблицы из скана фиксирована', () => {
    expect(SCAN_TABLE_HEADER).toEqual(['Наименование', 'Кол-во', 'Цена', 'Сумма']);
  });
});

describe('скан-счёт без сомнений', () => {
  test('все три позиции в таблице, предупреждения «на проверку» нет', async () => {
    deps.parser = withScanTableParser(scanParserOf(recognizedScan(MUG_INVOICE)), true);
    putFile(deps, SCAN_FILE, 'png');
    const page = await readPriceFile.execute({ path: SCAN_FILE }, deps, CTX);
    expect(page.tableRows).toEqual([4]);
    expect(page.warnings.some((warning) => warning.includes('на проверку'))).toBe(false);
  });
});

describe('скан из чата: правило «в базу пишется только диск» сохраняется', () => {
  test('предложение, а не запись; позиции те же', async () => {
    deps.parser = withScanTableParser(scanParserOf(recognizedScan(DOUBTFUL_PRICE_LIST)), true);
    const stored = await deps.intake.put(EMPLOYEE_THREAD, 'кружки.png', PNG_HEAD);
    const ctx: ToolContext = employeeContext('u-scan', EMPLOYEE_THREAD);
    const page = await readPriceFile.execute({ path: stored.path }, deps, ctx);
    expect(page.tableRows).toEqual([3]);
    const out = await savePriceImport.execute(importArgs(stored.path, page.hash), deps, ctx);
    expect(out).toMatchObject({ status: 'proposed_not_written', saved: 0, proposed: 2 });
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(0);
  });
});

describe('надстройка разборщика', () => {
  test('сохраняет свойства базового: чтение картинок, потоковый разбор файла', async () => {
    const base = {
      ...scanParserOf(recognizedScan(MUG_INVOICE)),
      readsArchives: true,
      async parseFile() {
        return recognizedScan(MUG_INVOICE);
      },
    };
    const parser = new ScanTableDocumentParser(base);
    expect(parser.readsImages).toBe(true);
    expect(parser.readsArchives).toBe(true);
    const viaFile = await parser.parseFile?.('x.png', {} as never);
    expect(viaFile?.tables).toHaveLength(1);
  });

  test('без parseFile у базового его нет и у надстройки', () => {
    expect(new ScanTableDocumentParser(scanParserOf(recognizedScan(''))).parseFile).toBeUndefined();
  });

  test('файлы без признака скана и готовые таблицы не меняются', async () => {
    const plain = { ...recognizedScan('1 Кружка 10 шт 250,00 2 500,00'), warnings: [] };
    const parser = new ScanTableDocumentParser(scanParserOf(plain));
    expect(await parser.parse('a.pdf', new Uint8Array())).toEqual(plain);
    const withTable = { ...recognizedScan(MUG_INVOICE), tables: [[['a', 'b']]] };
    const same = new ScanTableDocumentParser(scanParserOf(withTable));
    expect(await same.parse('a.png', new Uint8Array())).toEqual(withTable);
  });

  test('нечитаемый скан (needsOcr) и скан без позиций остаются как были', async () => {
    const unread = { ...recognizedScan(''), needsOcr: true };
    const readUnread = new ScanTableDocumentParser(scanParserOf(unread));
    expect(await readUnread.parse('a.png', PNG_HEAD)).toEqual(unread);
    const noItems = recognizedScan('Текст с фото: подпись и печать');
    expect(
      await new ScanTableDocumentParser(scanParserOf(noItems)).parse('a.png', PNG_HEAD),
    ).toEqual(noItems);
  });
});

describe('флаг PRICES_SCAN_FLOW_ENABLED=false: прежнее поведение', () => {
  test('разборщик возвращается как есть, таблицы из скана нет, импорт невозможен', async () => {
    const base = scanParserOf(recognizedScan(MUG_INVOICE));
    expect(withScanTableParser(base, false)).toBe(base);
    deps.parser = withScanTableParser(base, false);
    putFile(deps, SCAN_FILE, 'png');
    const page = await readPriceFile.execute({ path: SCAN_FILE }, deps, CTX);
    expect(page.tableCount).toBe(0);
    expect(page.warnings).not.toContain(SCAN_IMPORT_WARNING);
  });
});
