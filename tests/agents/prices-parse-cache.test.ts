import { beforeEach, describe, expect, test } from 'bun:test';
import { PARSE_CACHE_MAX_CHARS } from '../../src/agents/prices/parse-cache';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import type { DocumentParser, ParsedDocument } from '@business-ai/core';
import { CTX, SUPPLIER_ID, buildPricesDeps, putFile } from './support';

const COLUMNS = { name: 0, price: 1 };
const ROWS = 30;
const CHUNK = 10;

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
let parseCalls = 0;
beforeEach(async () => {
  deps = await buildPricesDeps();
  parseCalls = 0;
  const inner: DocumentParser = deps.parser;
  deps.parser = {
    async parse(name: string, content: Uint8Array): Promise<ParsedDocument> {
      parseCalls += 1;
      return inner.parse(name, content);
    },
  };
});

const csv = (rows: number): string =>
  ['Наименование,Цена', ...Array.from({ length: rows }, (_, i) => `Товар ${i},${100 + i}`)].join(
    '\n',
  );

const stage = (path: string, fromRow: number, toRow: number) =>
  stagePriceRows.execute(
    {
      path,
      supplierId: SUPPLIER_ID,
      tableIndex: 0,
      headerRows: 1,
      columns: COLUMNS,
      defaultCurrency: 'RUB',
      fromRow,
      toRow,
      reset: false,
    },
    deps,
    CTX,
  );

describe('R3-MEM-11: разбор файла не повторяется на каждый вызов', () => {
  test('куски одного файла разбираются один раз', async () => {
    putFile(deps, 'price.csv', csv(ROWS));
    await stage('price.csv', 1, 1 + CHUNK);
    await stage('price.csv', 1 + CHUNK, 1 + 2 * CHUNK);
    const last = await stage('price.csv', 1 + 2 * CHUNK, 1 + 3 * CHUNK);
    expect(parseCalls).toBe(1);
    expect(last.totalStaged).toBe(ROWS);
  });

  test('чтение страницами и разбор кусками делят один разбор', async () => {
    putFile(deps, 'price.csv', csv(ROWS));
    await readPriceFile.execute({ path: 'price.csv' }, deps, CTX);
    await stage('price.csv', 1, 1 + CHUNK);
    expect(parseCalls).toBe(1);
  });

  test('изменённый файл (другой хэш) разбирается заново', async () => {
    putFile(deps, 'price.csv', csv(ROWS));
    await stage('price.csv', 1, 1 + CHUNK);
    putFile(deps, 'price.csv', csv(ROWS + 1));
    await stage('price.csv', 1, 1 + CHUNK);
    expect(parseCalls).toBe(2);
  });

  test('параллельные вызовы по одному файлу дают один разбор', async () => {
    putFile(deps, 'price.csv', csv(ROWS));
    await Promise.all([stage('price.csv', 1, 1 + CHUNK), stage('price.csv', 1, 1 + CHUNK)]);
    expect(parseCalls).toBe(1);
  });

  test('бюджет кэша задан константой', () => {
    expect(PARSE_CACHE_MAX_CHARS).toBeGreaterThan(0);
  });
});
