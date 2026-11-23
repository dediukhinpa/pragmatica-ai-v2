import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { type PgClient } from '@business-ai/adapters';
import { toRunSpec } from '@business-ai/core';
import { buildApp, e2eEnv, openDb, resetScenarioTables, type E2eApp } from '../lib/project-env';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import {
  isRecord,
  LlmStub,
  lastResult,
  type StubReply,
  type StubScript,
} from '@business-ai/testing/e2e';
import { headerRowCount } from '../lib/prices-flow';
import {
  allToolNames,
  baseNameOf,
  itemsByName,
  makePricesRoot,
  sandboxOverrides,
} from '../lib/script-flow';
import { buildFormFile, FORM_PII, type FormCell, type FormSheet } from '../lib/script-forms';

/**
 * Сценарий s111-employee: сотрудник поправил разбор.
 *  1. Агент разобрал прайс скриптом по столбцу C (версия 1, автор agent), в базу не записал.
 *  2. Сотрудник: «Цена в столбце D». Агент переписывает скрипт (onEmployeeRequest): в сводке
 *     разница «было/стало», версия 2 (автор employee_request); фиксация пишет цены столбца D.
 *  3. Второй прайс той же формы: сохранённый скрипт разбирает его без модели (stagePriceRows
 *     отвечает viaSavedScript, runDataScript не вызывается); столбцы в вызове заведомо
 *     неверные, значит цены D попали в базу именно скриптом.
 */

const SUPPLIER_ID = 'sup-e2e-s111-employee';
const THREAD = 'e2e-s111-employee';
const THREAD_SECOND = 'e2e-s111-employee-second';
const FILE_ONE = 'Канцелярия Север/Прайс канцелярия январь.xlsx';
const FILE_TWO = 'Канцелярия Север/Прайс канцелярия февраль.xlsx';
const PRICE_COLUMN_WRONG = 2;
const PRICE_COLUMN_RIGHT = 3;
const CONTACT = `Менеджер Кузнецова Марина Олеговна, тел. +7 (495) 777-12-34, m.kuznetsova@forms-example.ru`;
const HEADER: FormCell[] = ['Артикул', 'Наименование', 'Закупочная', 'Цена'];

type Row = [string, string, number, number];
const ROWS_ONE: Row[] = [
  ['SK-1', 'Блокнот А5', 100, 150],
  ['SK-2', 'Ручка шариковая', 20, 35],
  ['SK-3', 'Папка-скоросшиватель', 40, 60],
  ['SK-4', 'Маркер перманентный', 55, 80],
];
const ROWS_TWO: Row[] = [
  ['SK-1', 'Блокнот А5', 104, 155],
  ['SK-2', 'Ручка шариковая', 21, 38],
  ['SK-3', 'Папка-скоросшиватель', 41, 62],
  ['SK-4', 'Маркер перманентный', 57, 85],
  ['SK-5', 'Степлер', 120, 185],
];

const sheetOf = (rows: Row[]): FormSheet[] => [
  { title: 'Прайс', rows: [[CONTACT, '', '', ''], HEADER, ...rows] },
];

/** Скрипт разбора: цена берётся из столбца `column` (общие помощники кода - внутри). */
const scriptOf = (column: number): string => `import re

def clean(c):
    return re.sub(r"\\s+", " ", c or "").strip()

def num(c):
    m = re.match(r"^\\s*(\\d[\\d\\s]*(?:[.,]\\d+)?)\\s*$", clean(c))
    return float(m.group(1).replace(" ", "").replace(",", ".")) if m else None

def run(tables, source):
    out = []
    for row in tables[0]:
        c = [clean(x) for x in row] + [""] * 4
        if c[0].startswith("SK-") and num(c[${column}]):
            out.append({"name": c[1], "sku": c[0], "price": num(c[${column}])})
    return out
`;

const llm = new LlmStub();
let db: PgClient;
let ctx: E2eApp;
let root = '';
/** Тела запросов к модели за все ходы сценария (заглушка обнуляет их на каждом ходе). */
const allBodies: string[] = [];

beforeAll(async () => {
  db = openDb();
  await resetScenarioTables(db);
  await db.query('TRUNCATE supplier_price_scripts, workflow_state');
  root = await makePricesRoot('s111-employee-prices');
  buildFormFile(`${root}/${FILE_ONE}`, sheetOf(ROWS_ONE));
  buildFormFile(`${root}/${FILE_TWO}`, sheetOf(ROWS_TWO));
  await new PostgresSupplierRepository(db).upsert({ id: SUPPLIER_ID, name: 'ООО Канцелярия' });
  llm.start(e2eEnv().llmPort);
  ctx = buildApp(new Map(), sandboxOverrides(root));
});

afterAll(async () => {
  await ctx.app.close();
  await db.close();
  await llm.stop();
});

function pathOf(body: Record<string, unknown>): string {
  const files = lastResult(body, 'listPriceFiles')['files'];
  const first = (Array.isArray(files) ? files[0] : undefined) as { path?: string } | undefined;
  if (first?.path === undefined) throw new Error('listPriceFiles не вернул файл');
  return first.path;
}

const listStep = (file: string): StubReply => ({
  kind: 'tool',
  name: 'listPriceFiles',
  input: { query: baseNameOf(file) },
});

/** Прогон хода агента со сценарием; тела запросов копятся для проверки утечек. */
async function turn(script: StubScript, thread: string, text: string) {
  llm.begin(script);
  const result = await ctx.app.runtime.run(toRunSpec(ctx.app.registry.get('prices')), thread, text);
  allBodies.push(...llm.bodies());
  expect(llm.scriptErrors).toEqual([]);
  expect(result.status).toBe('completed');
  return result;
}

function summaryOf(): Record<string, unknown> {
  const body = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
  const run = lastResult(body, 'runDataScript');
  expect(run['ok']).toBe(true);
  const summary = run['summary'];
  if (!isRecord(summary)) throw new Error('нет сводки');
  return summary;
}

const savedScripts = () =>
  db.query('SELECT version, created_by, code FROM supplier_price_scripts ORDER BY version');

describe('s111: сотрудник поправил разбор', () => {
  test('1. скрипт по столбцу C: версия 1 (agent), в базу ничего не записано', async () => {
    await turn(
      ({ index, body }) => {
        switch (index) {
          case 0:
            return listStep(FILE_ONE);
          case 1:
            return { kind: 'tool', name: 'readPriceFile', input: { path: pathOf(body) } };
          case 2:
            return {
              kind: 'tool',
              name: 'runDataScript',
              input: {
                code: scriptOf(PRICE_COLUMN_WRONG),
                fileRef: pathOf(body),
                resultKind: 'price_items',
                supplierId: SUPPLIER_ID,
              },
            };
          default:
            return { kind: 'text', text: 'Разобрано, жду подтверждения.' };
        }
      },
      THREAD,
      'Разбери прайс',
    );
    const summary = summaryOf();
    expect(summary).toMatchObject({ accepted: true, staged: 4, scriptVersion: 1 });
    expect(summary['diff']).toBeUndefined();
    expect((await savedScripts()).map((r) => [r['version'], r['created_by']])).toEqual([
      [1, 'agent'],
    ]);
    expect((await itemsByName(db, SUPPLIER_ID)).size).toBe(0);
  });

  test('2. «Цена в столбце D»: разница было/стало, версия 2 (employee_request), фиксация', async () => {
    await turn(
      ({ index, body }) => {
        switch (index) {
          case 0:
            return listStep(FILE_ONE);
          case 1:
            return {
              kind: 'tool',
              name: 'runDataScript',
              input: {
                code: scriptOf(PRICE_COLUMN_RIGHT),
                fileRef: pathOf(body),
                resultKind: 'price_items',
                supplierId: SUPPLIER_ID,
                onEmployeeRequest: true,
              },
            };
          case 2:
            return {
              kind: 'tool',
              name: 'commitPriceImport',
              input: { supplierId: SUPPLIER_ID, fileHash: summaryFromBody(body)['fileHash'] },
            };
          default:
            return { kind: 'text', text: 'Исправил: цена из столбца D.' };
        }
      },
      THREAD,
      'Цена в столбце D',
    );
    const summary = (() => {
      const body = JSON.parse(llm.bodies().at(-1) ?? '{}') as Record<string, unknown>;
      return summaryFromBody(body);
    })();
    expect(summary).toMatchObject({ accepted: true, staged: 4, scriptVersion: 2 });
    const diff = summary['diff'] as Record<string, unknown>;
    expect(diff).toMatchObject({ before: 4, after: 4, added: 0, removed: 0, changed: 4 });
    const sample = diff['sample'] as Array<Record<string, string>>;
    expect(sample[0]).toMatchObject({ field: 'price', was: '100', now: '150' });
    const scripts = await savedScripts();
    expect(scripts.map((r) => [r['version'], r['created_by']])).toEqual([
      [1, 'agent'],
      [2, 'employee_request'],
    ]);
    const items = await itemsByName(db, SUPPLIER_ID);
    for (const [, name, , right] of ROWS_ONE) expect(items.get(name)?.price).toBe(right);
  });

  test('3. второй прайс той же формы: сохранённый скрипт, без модели и без runDataScript', async () => {
    const headerRows = { value: 0 };
    await turn(
      ({ index, body }) => {
        switch (index) {
          case 0:
            return listStep(FILE_TWO);
          case 1:
            return { kind: 'tool', name: 'readPriceFile', input: { path: pathOf(body) } };
          case 2: {
            headerRows.value = headerRowCount(String(lastResult(body, 'readPriceFile')['markdown']));
            return {
              kind: 'tool',
              name: 'stagePriceRows',
              input: {
                path: pathOf(body),
                supplierId: SUPPLIER_ID,
                tableIndex: 0,
                headerRows: headerRows.value,
                // Заведомо неверный столбец цены: верные цены даёт только сохранённый скрипт.
                columns: { sku: 0, name: 1, price: PRICE_COLUMN_WRONG },
                reset: true,
              },
            };
          }
          case 3: {
            const staged = lastResult(body, 'stagePriceRows');
            expect(staged['viaSavedScript']).toBe(true);
            expect(staged['totalStaged']).toBe(ROWS_TWO.length);
            return {
              kind: 'tool',
              name: 'commitPriceImport',
              input: { supplierId: SUPPLIER_ID, fileHash: staged['fileHash'] },
            };
          }
          default:
            return { kind: 'text', text: 'Прайс записан сохранённым скриптом.' };
        }
      },
      THREAD_SECOND,
      'Разбери новый прайс',
    );
    const tools = allToolNames(llm.bodies());
    expect(tools).not.toContain('runDataScript');
    expect(tools).toContain('stagePriceRows');
    const items = await itemsByName(db, SUPPLIER_ID);
    expect(items.size).toBe(ROWS_TWO.length);
    for (const [, name, , right] of ROWS_TWO) expect(items.get(name)?.price).toBe(right);
    // Версия не выросла: запуск сохранённого скрипта заново его не пишет.
    expect((await savedScripts()).length).toBe(2);
  });

  test('ПДн шапки файла не дошли до модели ни на одном ходе', async () => {
    expect(allBodies.length).toBeGreaterThan(0);
    // Шапка файла до модели дошла, но маскированной: проверка утечек не пустая.
    expect(allBodies.join('\n')).toMatch(/\[PHONE_\d+\]/);
    await expectNoLeaks({ llm: allBodies, pii: FORM_PII, db });
  });
});

/** Сводка последнего runDataScript по телу запроса. */
function summaryFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const summary = lastResult(body, 'runDataScript')['summary'];
  if (!isRecord(summary)) throw new Error('нет сводки runDataScript');
  return summary;
}
