import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource } from '@business-ai/adapters';
import {
  MAX_NORMALIZED_ITEMS_LISTED,
  normalizePriceTable,
} from '../../src/agents/prices/normalize-price-table';
import { encodeIdentifiers, findDigitSeries } from '@business-ai/core';
import { listPriceFiles } from '../../src/agents/prices/list-price-files';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { parsePrice, parseTableRows } from '../../src/agents/prices/table-rows';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { type PricesDeps } from '../../src/agents/prices/deps';
import { isDomainError } from '@business-ai/core';
import type { ParsedDocument } from '@business-ai/core';
import {
  CTX,
  MANAGER_THREAD,
  SUPPLIER_ID,
  buildPricesDeps,
  existingPrice,
  priceCsv,
  putFile,
} from './support';

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;

beforeEach(async () => {
  deps = await buildPricesDeps();
});

const COLUMNS = { name: 0, price: 1 };
/** Настоящее время изменения файла, мс: 13 цифр подряд. */
const REAL_MTIME_MS = 1_760_000_000_000;

async function normalized(path = 'price.csv') {
  const input = { path, supplierId: SUPPLIER_ID, columns: COLUMNS };
  return normalizePriceTable.execute(input, deps, CTX);
}

describe('listPriceFiles', () => {
  test('полный список помечает сканы и пропускает чужие форматы', async () => {
    putFile(deps, 'a.csv', 'x');
    putFile(deps, 'scan.jpg', 'x');
    putFile(deps, 'notes.zip', 'x');
    const out = await listPriceFiles.execute({}, deps, CTX);
    expect(out.files.map((f) => [f.path, f.isScan])).toEqual([
      ['a.csv', false],
      ['scan.jpg', true],
    ]);
  });

  test('новые форматы офиса попадают в список, ppt и cdr нет', async () => {
    for (const name of ['a.xls', 'a.xlsm', 'a.doc', 'a.pptx', 'a.rtf', 'a.ppt', 'a.cdr']) {
      putFile(deps, name, 'x');
    }
    const out = await listPriceFiles.execute({}, deps, CTX);
    expect(out.files.map((f) => f.path).sort()).toEqual(
      ['a.doc', 'a.pptx', 'a.rtf', 'a.xls', 'a.xlsm'],
    );
  });

  test('время изменения отдаётся строкой ISO, а не числом миллисекунд', async () => {
    (deps.files as MemoryFileSource).put('a.csv', new TextEncoder().encode('x'), REAL_MTIME_MS);
    const out = await listPriceFiles.execute({}, deps, CTX);
    expect(out.files[0]?.modifiedAt).toBe(new Date(REAL_MTIME_MS).toISOString());
    // Хэш файла прячет кодек на границе с моделью; число миллисекунд он бы не спрятал.
    expect(findDigitSeries(encodeIdentifiers(JSON.stringify(out)))).toEqual([]);
    expect(findDigitSeries(String(REAL_MTIME_MS))).toHaveLength(1);
  });

  test('known без времени или с испорченным временем: изменения ищутся по хэшу', async () => {
    putFile(deps, 'a.csv', 'one');
    putFile(deps, 'gone.csv', 'x');
    const [first, gone] = (await listPriceFiles.execute({}, deps, CTX)).files;
    (deps.files as MemoryFileSource).remove('gone.csv');
    const known = [
      { path: 'a.csv', hash: first?.hash ?? '', modifiedAt: 'не дата' },
      { path: 'gone.csv', hash: gone?.hash ?? '' },
    ];
    const out = await listPriceFiles.execute({ known }, deps, CTX);
    expect(out.files).toEqual([
      { path: 'gone.csv', hash: gone?.hash ?? '', change: 'removed', isScan: false },
    ]);
  });

  test('с known возвращает только изменения', async () => {
    putFile(deps, 'a.csv', 'one');
    const known = (await listPriceFiles.execute({}, deps, CTX)).files;
    putFile(deps, 'a.csv', 'two');
    putFile(deps, 'b.csv', 'new');
    const out = await listPriceFiles.execute({ known }, deps, CTX);
    expect(out.files.map((f) => [f.path, f.change])).toEqual([
      ['a.csv', 'modified'],
      ['b.csv', 'added'],
    ]);
  });
});

describe('readPriceFile', () => {
  test('отдаёт таблицу в markdown с номерами строк и хэшем', async () => {
    putFile(deps, 'price.csv', priceCsv([['Болт', 10]]));
    const out = await readPriceFile.execute({ path: 'price.csv' }, deps, CTX);
    expect(out.needsOcr).toBe(false);
    expect(out.hidden).toBe(false);
    expect(out.hiddenSheets).toEqual([]);
    expect(out.markdown).toContain('| 1 | Болт | 10 |');
    expect(out.hash.length).toBeGreaterThan(0);
  });

  test('скан по расширению: парсер не вызывается, needsOcr=true', async () => {
    putFile(deps, 'scan.jpg', 'binary');
    const out = await readPriceFile.execute({ path: 'scan.jpg' }, deps, CTX);
    expect(out).toMatchObject({ needsOcr: true, markdown: '', tableCount: 0 });
  });

  test('файл без текстового слоя тоже требует OCR', async () => {
    putFile(deps, 'empty.txt', ' ');
    expect((await readPriceFile.execute({ path: 'empty.txt' }, deps, CTX)).needsOcr).toBe(true);
  });

  test('флаги парсера доходят до агента', async () => {
    const parsed: ParsedDocument = {
      text: '',
      tables: [],
      needsOcr: true,
      hasHiddenContent: true,
      hiddenSheets: ['Архив'],
      truncated: true,
      warnings: ['лист обрезан'],
    };
    putFile(deps, 'scan.pdf', 'x');
    const stub = { ...deps, parser: { parse: async () => parsed } };
    const out = await readPriceFile.execute({ path: 'scan.pdf' }, stub, CTX);
    expect(out).toMatchObject({
      needsOcr: true,
      hidden: true,
      hiddenSheets: ['Архив'],
      truncated: true,
      warnings: ['лист обрезан'],
    });
  });

  test('скан определяет флаг парсера, а не длина текста', async () => {
    const parse = async (): Promise<ParsedDocument> => ({
      text: 'коротко',
      tables: [],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    });
    putFile(deps, 'short.pdf', 'x');
    const stub = { ...deps, parser: { parse } };
    expect((await readPriceFile.execute({ path: 'short.pdf' }, stub, CTX)).needsOcr).toBe(false);
  });

  test('нет файла: not_found', async () => {
    const error = await readPriceFile.execute({ path: 'нет.csv' }, deps, CTX).catch((e) => e);
    expect(isDomainError(error) && error.code).toBe('not_found');
  });
});

describe('parsePrice', () => {
  test('форматы цен', () => {
    expect(parsePrice('1 234,50')).toBe(1234.5);
    expect(parsePrice('10 руб.')).toBe(10);
    expect(parsePrice('abc')).toBeNull();
    expect(parsePrice('0')).toBeNull();
    expect(parsePrice('1.234,50')).toBe(1234.5);
    expect(parsePrice('0,125')).toBe(0.125);
  });

  test('неоднозначное «1,234» не угадывается', () => {
    expect(parsePrice('1,234')).toBeNull();
    expect(parsePrice('1.234')).toBeNull();
  });

  const PARAMS = {
    supplierId: 's1',
    headerRows: 0,
    columns: { name: 0, price: 1, currency: 2 },
    defaultCurrency: 'USD',
    date: '2026-10-01',
  };

  test('валюта из самой ячейки цены важнее валюты по умолчанию', () => {
    const out = parseTableRows([['Болт', '100 руб.'], ['Гайка', '$5'], ['Шайба', '7']], PARAMS);
    expect(out.items.map((i) => [i.price, i.currency])).toEqual([
      [100, 'RUB'],
      [5, 'USD'],
      [7, 'USD'],
    ]);
  });

  test('валюта в цене и в столбце расходится - строка отклонена', () => {
    const out = parseTableRows([['Болт', '100 руб.', 'EUR']], PARAMS);
    expect(out.items).toEqual([]);
    expect(out.rejected[0]?.reason).toContain('валюта');
  });

  test('неоднозначная цена уходит в отклонённые, а не угадывается', () => {
    const out = parseTableRows([['Болт', '1,234'], ['Гайка', '1 234,5']], PARAMS);
    expect(out.items.map((i) => i.price)).toEqual([1234.5]);
    expect(out.rejected).toEqual([{ row: 0, reason: expect.stringContaining('неоднознач') }]);
  });
});

describe('normalizePriceTable', () => {
  test('разбирает позиции и считает строки исходника', async () => {
    putFile(deps, 'price.csv', priceCsv([['Болт', 10], ['Гайка', 5]]));
    const out = await normalized();
    expect(out.sourceRowCount).toBe(2);
    expect(out.items.map((i) => [i.productName, i.price, i.currency])).toEqual([
      ['Болт', 10, 'RUB'],
      ['Гайка', 5, 'RUB'],
    ]);
    expect(out.rejected).toEqual([]);
  });

  test('нераспознанная цена попадает в rejected и в число строк', async () => {
    putFile(deps, 'price.csv', 'Наименование,Цена\nБолт,10\nГайка,12abc');
    const out = await normalized();
    expect(out.sourceRowCount).toBe(2);
    expect(out.items).toHaveLength(1);
    expect(out.rejected).toEqual([{ row: 2, reason: 'цена не распознана' }]);
  });

  test('неизвестный поставщик и несуществующая таблица', async () => {
    putFile(deps, 'price.csv', priceCsv([['Болт', 10]]));
    const unknown = await normalizePriceTable
      .execute({ path: 'price.csv', supplierId: 'нет', columns: COLUMNS }, deps, CTX)
      .catch((e) => e);
    expect(isDomainError(unknown) && unknown.code).toBe('not_found');
    const noTable = await normalizePriceTable
      .execute(
        { path: 'price.csv', supplierId: SUPPLIER_ID, tableIndex: 3, columns: COLUMNS },
        deps,
        CTX,
      )
      .catch((e) => e);
    expect(isDomainError(noTable) && noTable.code).toBe('invalid_input');
  });
});

describe('savePriceImport', () => {
  /** Аргументы модели: только указатель на файл, хэш из разбора и колонки. */
  async function importArgs(rows: Array<[string, number]>) {
    putFile(deps, 'price.csv', priceCsv(rows));
    const { fileHash } = await normalized();
    return { path: 'price.csv', supplierId: SUPPLIER_ID, fileHash, columns: COLUMNS };
  }

  test('сохраняет прайс из файла и считает изменившиеся позиции', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
    const args = await importArgs([
      ['Болт', 11],
      ['Гайка', 5],
    ]);
    const out = await savePriceImport.execute(args, deps, CTX);
    expect(out).toEqual({ supplierId: SUPPLIER_ID, saved: 2, changed: 2 });
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(2);
  });

  test('скачок цены: валидатор запись не блокирует, прайс сохраняется', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
    const args = await importArgs([['Болт', 30]]);
    expect(await priceImportValidator.validate(args, deps, CTX)).toEqual([]);
    const out = await savePriceImport.execute(args, deps, CTX);
    expect(out).toEqual({ supplierId: SUPPLIER_ID, saved: 1, changed: 1 });
  });

  test('без скачка и расхождений валидатор пропускает', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
    const args = await importArgs([['Болт', 12]]);
    expect(await priceImportValidator.validate(args, deps, CTX)).toEqual([]);
  });

  test('неразобранная строка блокирует запись: число строк считает код', async () => {
    putFile(deps, 'price.csv', 'Наименование,Цена\nБолт,10\nГайка,12abc');
    const { fileHash } = await normalized();
    const args = { path: 'price.csv', supplierId: SUPPLIER_ID, fileHash, columns: COLUMNS };
    const issues = await priceImportValidator.validate(args, deps, CTX);
    expect(issues.map((issue) => issue.code)).toEqual(['rows_rejected', 'row_count_mismatch']);
  });

  test('валидатор срабатывает только на savePriceImport', () => {
    expect(priceImportValidator.appliesTo).toEqual(['savePriceImport']);
  });

  test('ключ идемпотентности зависит от хэша файла', async () => {
    const args = await importArgs([['Болт', 10]]);
    const expected = `price-import:${SUPPLIER_ID}:${args.fileHash}`;
    expect(savePriceImport.idempotencyKey?.(args)).toBe(expected);
    expect(savePriceImport.sideEffect).toBe(true);
  });
});

describe('reportToManager', () => {
  const base = { path: 'dir/price.csv', fileHash: 'h1' };

  test('итог без ПДн: числа и имя файла', async () => {
    await reportToManager.execute(
      { ...base, kind: 'import_done', updated: 7, needsReview: 2 },
      deps as PricesDeps,
      CTX,
    );
    expect(deps.chat.outbox).toEqual([
      {
        threadId: MANAGER_THREAD,
        message: { text: 'Прайс «price.csv»: обновил 7 позиций, 2 на проверку.' },
      },
    ]);
  });

  test('скан: просит прислать Excel', async () => {
    await reportToManager.execute({ ...base, kind: 'scan_skipped' }, deps, CTX);
    expect(deps.chat.outbox[0]?.message?.text).toContain('скан');
  });

  test('свободный текст в кодах замечаний не принимается', async () => {
    const error = await reportToManager
      .execute({ ...base, kind: 'needs_review', issueCodes: ['Иван Иванов +7999'] }, deps, CTX)
      .catch((e) => e);
    expect(isDomainError(error) && error.code).toBe('invalid_input');
  });
});

describe('normalizePriceTable: предел позиций', () => {
  test('таблица больше предела усекается, отдаётся признак и подсказка', async () => {
    const total = MAX_NORMALIZED_ITEMS_LISTED + 25;
    const rows = Array.from({ length: total }, (_, i): [string, number] => [`Болт ${i}`, i + 1]);
    putFile(deps, 'price.csv', priceCsv(rows));
    const out = await normalized();
    expect(out.items).toHaveLength(MAX_NORMALIZED_ITEMS_LISTED);
    expect(out.itemsCount).toBe(total);
    expect(out.itemsTruncated).toBe(true);
    expect(out.hint).toContain('stagePriceRows');
    // Усечение касается только показа: счётчик строк и хэш относятся к файлу целиком.
    expect(out.sourceRowCount).toBe(total);
    expect(normalizePriceTable.outputSchema.safeParse(out).success).toBe(true);
  });

  test('ровно предел и меньше: без усечения и без подсказки', async () => {
    const rows = Array.from(
      { length: MAX_NORMALIZED_ITEMS_LISTED },
      (_, i): [string, number] => [`Болт ${i}`, i + 1],
    );
    putFile(deps, 'price.csv', priceCsv(rows));
    const out = await normalized();
    expect(out.items).toHaveLength(MAX_NORMALIZED_ITEMS_LISTED);
    expect(out.itemsCount).toBe(MAX_NORMALIZED_ITEMS_LISTED);
    expect(out.itemsTruncated).toBe(false);
    expect(out.hint).toBeUndefined();
  });
});
