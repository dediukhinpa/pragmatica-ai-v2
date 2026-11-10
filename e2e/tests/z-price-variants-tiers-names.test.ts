import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import type { PgClient } from '@business-ai/adapters';
import { toRunSpec } from '@business-ai/core';
import { formatPriceTiers } from '../../src/kit/domain/market-price';
import { buildApp, e2eEnv, openDb, resetScenarioTables } from '../lib/project-env';
import type { E2eApp } from '../lib/project-env';
import { LlmStub, lastResult, type StubScript } from '@business-ai/testing/e2e';
import { buildTablePrice, readNormalizeSaveScript, type TableCell } from '../lib/table-price';

/**
 * Сценарий z (этап 106, тема 6): разбор прайсов с вариантами, группами, тиражами и «именами» в
 * названиях. Боевая сборка, настоящие Postgres, documents, pseudonymizer и pii-guard; модель -
 * скрипт. Данные синтетические.
 *
 *  z1 - размеры одной модели и группа с названием в строке-заголовке: записаны, позиции различимы;
 *  z2 - цены по тиражам: основная цена минимального тиража, тиражи видны в поиске;
 *  z3 - длинный список позиций с «именем» в названии: ход не падает, названия восстановлены.
 */

const SUPPLIER_ID = 'sup-e2e-z106';
const ROOT_DIR = 'z-106-prices';
const DONE_TEXT = 'Прайс разобран.';
/** Сколько позиций в длинном списке z3: достаточно, чтобы NER увидел контекст. */
const LONG_LIST_SIZE = 40;
const MIN_TIER_PRICE = 120;
const MIDDLE_TIER_PRICE = 100;
const MAX_TIER_PRICE = 80;

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;
let rootPath = '';
let counter = 0;

/** Колонки: артикул, название, размер, цена (синтетическая шапка). */
const VARIANT_HEAD: TableCell[] = ['Артикул', 'Наименование', 'Размер', 'Цена'];

/** Запуск агента на одном файле; возвращает итог хода. */
async function runOnFile(relative: string, script: StubScript): Promise<string> {
  llm.begin(script);
  counter += 1;
  const spec = ctx.app.registry.get('prices');
  const result = await ctx.app.runtime.run(
    toRunSpec(spec),
    `e2e-z106-${counter}`,
    `Обработай прайс «${relative}»`,
  );
  expect(llm.scriptErrors).toEqual([]);
  expect(result.status).toBe('completed');
  return result.output;
}

beforeAll(async () => {
  db = openDb();
  rootPath = `${e2eEnv().work}/files/${ROOT_DIR}`;
  llm.start(e2eEnv().llmPort);
  ctx = buildApp(new Map(), { PRICES_FILES_ROOT: rootPath });
});

beforeEach(async () => {
  await resetScenarioTables(db);
  await new PostgresSupplierRepository(db).upsert({ id: SUPPLIER_ID, name: 'ООО Вариант Опт' });
  await mkdir(rootPath, { recursive: true });
});

afterEach(async () => {
  await rm(rootPath, { recursive: true, force: true });
});

afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

describe('z1: варианты размеров и группы', () => {
  test('одна модель в трёх размерах и группа с названием в заголовке записаны, позиции различимы', async () => {
    const file = 'вариант/Размеры.xlsx';
    buildTablePrice(`${rootPath}/${file}`, [
      VARIANT_HEAD,
      // Один артикул и название, разные размеры и цены: раньше это были «дубли».
      ['JK-1', 'Куртка рабочая', 'S', 3000],
      ['JK-1', 'Куртка рабочая', 'M', 3100],
      ['JK-1', 'Куртка рабочая', 'L', 3200],
      // Группа: название только в строке-заголовке, у строк вариантов оно пусто.
      ['', 'Перчатки трикотажные', '', ''],
      ['GL-1', '', 'M', 40],
      ['GL-2', '', 'L', 45],
    ]);
    const columns = { sku: 0, name: 1, variantColumns: [2], price: 3, groupHeaderRows: true };
    const output = await runOnFile(file, readNormalizeSaveScript(file, SUPPLIER_ID, columns, DONE_TEXT));
    expect(output).toBe(DONE_TEXT);

    const items = await new PostgresPriceRepository(db).listBySupplier(SUPPLIER_ID);
    const prices = new Map(items.map((item) => [item.productName, item.price]));
    expect(prices.get('Куртка рабочая S')).toBe(3000);
    expect(prices.get('Куртка рабочая M')).toBe(3100);
    expect(prices.get('Куртка рабочая L')).toBe(3200);
    expect(prices.get('Перчатки трикотажные M')).toBe(40);
    expect(prices.get('Перчатки трикотажные L')).toBe(45);
    // Все пять позиций разные: ни одна не склеилась и не ушла на проверку.
    expect(items).toHaveLength(5);
    expect(new Set(items.map((item) => item.productName)).size).toBe(5);
  });
});

describe('z2: цены по тиражам', () => {
  test('основная цена - минимального тиража, тиражи видны в поиске', async () => {
    const file = 'тираж/Тиражи.xlsx';
    buildTablePrice(`${rootPath}/${file}`, [
      ['Артикул', 'Наименование', 'от 50 шт', 'от 100 шт', 'от 500 шт'],
      ['PN-1', 'Ручка шариковая брендированная', MIN_TIER_PRICE, MIDDLE_TIER_PRICE, MAX_TIER_PRICE],
      ['PN-2', 'Блокнот А5 с логотипом', 300, '', ''],
    ]);
    const tiers = [
      { column: 2, minQuantity: 50 },
      { column: 3, minQuantity: 100 },
      { column: 4, minQuantity: 500 },
    ];
    const columns = { sku: 0, name: 1, priceTiers: tiers };
    await runOnFile(file, readNormalizeSaveScript(file, SUPPLIER_ID, columns, DONE_TEXT));

    const prices = new PostgresPriceRepository(db);
    const found = await prices.searchProducts('Ручка шариковая', 5);
    expect(found).toHaveLength(1);
    const pen = found[0];
    // В базе цен основная цена - минимального тиража (не средняя и не последняя).
    expect(pen?.price).toBe(MIN_TIER_PRICE);
    expect(pen?.priceTiers).toEqual([
      { minQuantity: 50, price: MIN_TIER_PRICE },
      { minQuantity: 100, price: MIDDLE_TIER_PRICE },
      { minQuantity: 500, price: MAX_TIER_PRICE },
    ]);
    // Показ людям: «от 50 шт — 120 RUB, от 100 — 100 RUB, от 500 — 80 RUB».
    const shown = formatPriceTiers(pen?.priceTiers ?? [], pen?.currency ?? 'RUB');
    expect(shown).toContain('от 50 шт');
    expect(shown).toContain('от 500');
    // Позиция с одним заполненным тиражом - обычная цена без массива тиражей.
    const notebook = (await prices.searchProducts('Блокнот', 5))[0];
    expect(notebook?.price).toBe(300);
    expect(notebook?.priceTiers).toBeUndefined();
  });
});

describe('z3: «имя» в названии товара в длинном списке', () => {
  test('ход не падает на перемаскировании, названия записаны без токенов', async () => {
    const file = 'имена/Керамика.xlsx';
    const rows: TableCell[][] = [['Артикул', 'Наименование', 'Цена']];
    for (let n = 1; n <= LONG_LIST_SIZE; n += 1) {
      // Каждая пятая позиция называется «по имени мастера»: NER в контексте списка видит ФИО.
      const title = n % 5 === 0 ? `Ваза Анна Смирнова авторская ${n}` : `Ваза керамическая ${n}`;
      rows.push([`VZ-${n}`, title, 1000 + n]);
    }
    rows.push(['VZ-900', 'Кружка А. ИВАНОВ серия', 500]);
    buildTablePrice(`${rootPath}/${file}`, rows);
    const columns = { sku: 0, name: 1, price: 2 };
    const output = await runOnFile(file, readNormalizeSaveScript(file, SUPPLIER_ID, columns, DONE_TEXT));
    expect(output).toBe(DONE_TEXT);

    const items = await new PostgresPriceRepository(db).listBySupplier(SUPPLIER_ID);
    expect(items).toHaveLength(LONG_LIST_SIZE + 1);
    const names = items.map((item) => item.productName);
    // Токены [PERSON_n] при записи восстановлены: в базе исходные названия.
    expect(names.some((name) => /\[PERSON_\d+\]/.test(name))).toBe(false);
    expect(names).toContain('Ваза Анна Смирнова авторская 5');
    expect(names).toContain('Кружка А. ИВАНОВ серия');
    // Результат чтения файла дошёл до модели (ход не оборвался отказом по ПДн).
    expect(llm.bodies().join('\n')).toContain('Ваза керамическая 1');
    expect(lastResult(JSON.parse(llm.requests.at(-1)?.raw ?? '{}'), 'savePriceImport')).toBeDefined();
  });
});
