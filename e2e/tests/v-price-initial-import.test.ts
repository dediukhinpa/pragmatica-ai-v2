import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, type PgClient } from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { PRICE_DISK_SYNC_INTERVAL_MS } from '../../src/agents/prices/price-disk-sync';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  BOT_PRICES,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb, requireEnv } from '../lib/project-env';
import { PRICES_MODEL, resetHandoffTables, waitFor } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, userTexts } from '@business-ai/testing/e2e';
import type { PiiSet } from '@business-ai/testing/e2e';
import { COLUMNS, headerRowCount } from '../lib/prices-flow';
import { makeInn } from '../lib/supplier-xlsx';

/**
 * Сценарий v3: первичный импорт прайсов с диска (этап 104, тема 4,
 * `PRICE_DISK_INITIAL_IMPORT_ENABLED`). Боевая сборка на заглушке портала Bitrix24, настоящие
 * Postgres, documents, pseudonymizer и pii-guard; модель - скрипт. Корень прайсов у сценария
 * свой (общий содержит фикстуру других тестов). Тик синхронизации идёт по расписанию службы:
 * часы `FixedClock` переводятся на интервал вперёд.
 *
 *  v3a - поставщик известен: цены записаны на его карточку; неизвестный: создана карточка
 *        (сразу боевая) с реквизитами из шапки и цены записаны на него; файл из «Архива» не
 *        импортируется; ответственному один раз уходит сводка;
 *  v3b - без флага первичного импорта первый тик только запоминает диск;
 *  v3c - флаг первичного импорта без `PRICE_DISK_SYNC_ENABLED` ничего не запускает;
 *  v3e - цены - формулы с кэшем-«хвостом» (266.666666666667):
 *        12-значный хвост шлюз ПДн считает ИНН/телефоном; импорт не отклоняется
 *        (`pii_request_rejected`), модель видит и записываются округлённые цены;
 *  v3d - сложная таблица: агент сообщает `structure_changed`, а в итогах она идёт как
 *        `needs_review` с кодом `complex_table` (прежнего прайса нет, структура не менялась).
 */

const RESPONSIBLE = 1003;
const RESPONSIBLE_NAME = { name: 'Ольга', lastName: 'Назарова' };
const RESPONSIBLE_THREAD = `${BOT_PRICES}/${RESPONSIBLE}`;
const RULES_NAME = 'v-price-initial-import';
const ROOT_DIR = 'v-initial-import-prices';

/** Известный поставщик базы и поставщик, которого в базе нет. */
const KNOWN_ID = 'sup-e2e-v3-known';
const KNOWN_NAME = 'ООО Металлист Север';
const UNKNOWN_NAME = 'ООО Ромашка Опт';
/** Ядро названия папки поставщика `Ромашка Опт`: по нему код тика называет карточку. */
const UNKNOWN_FOLDER_CORE = 'Ромашка';
const UNKNOWN_INN = makeInn('781234567');
const UNKNOWN_PHONE = '+7 (843) 555-01-77';
/** Телефон в карточке хранится нормализованным. */
const UNKNOWN_CITY = 'Казань';
/** Настоящая карточка, с которой потом сливается черновик. */
const REAL_ID = 'sup-e2e-v3-real';
const SEED_DATE = '2026-09-01';

const KNOWN_FILE = 'Металлист Север/Прайс.xlsx';
const UNKNOWN_FILE = 'Ромашка Опт/Прайс.xlsx';
const ARCHIVE_FILE = 'Архив_цены неактуальные/Старый прайс.xlsx';
/** Файл со сложной таблицей: агент называет его «структура изменилась». */
const COMPLEX_FILE = 'Сложный Поставщик/Сложная таблица.xlsx';
const COMPLEX_MARK = 'Сложная таблица';

const KNOWN_ROWS: Array<[string, string, number, string]> = [
  ['KN-001', 'Швеллер 10П', 71_000, 'RUB'],
  ['KN-002', 'Балка двутавровая 20Б1', 78_500, 'RUB'],
];
const UNKNOWN_ROWS: Array<[string, string, number, string]> = [
  ['RM-001', 'Профнастил С8', 640, 'RUB'],
  ['RM-002', 'Профнастил НС35', 790, 'RUB'],
  ['RM-003', 'Саморез кровельный', 4.5, 'RUB'],
];
const ARCHIVE_ROWS: Array<[string, string, number, string]> = [
  ['AR-900', 'Позиция из архива', 1_000, 'RUB'],
];

/** Поставщик с ценами-формулами: кэш формулы несёт 15 значащих цифр, как у Excel. */
const FORMULA_ID = 'sup-e2e-v3-formula';
const FORMULA_NAME = 'ООО Формула Трейд';
const FORMULA_FILE = 'Формула Трейд/Прайс.xlsx';
const FORMULA_ROWS: Array<[string, string, FormulaCell, string]> = [
  ['FM-001', 'Лист оцинкованный 0.5', { f: '800/3', v: '266.666666666667' }, 'RUB'],
  ['FM-002', 'Лист оцинкованный 0.7', { f: '1000/3', v: '333.333333333333' }, 'RUB'],
];
/** Ожидаемые цены после округления по формату ячейки (General: не более 4 знаков). */
const FORMULA_PRICES: Record<string, number> = {
  'Лист оцинкованный 0.5': 266.6667,
  'Лист оцинкованный 0.7': 333.3333,
};
const PII_REJECTED_EVENT = 'pii_request_rejected';

/** Файлов в первичном импорте v3d: известный, неизвестный поставщик и сложная таблица. */
const EXPECTED_OUTCOMES = 3;
const SUMMARY_HEAD = 'Первичный импорт прайсов с диска завершён.';
const DONE_TEXT = 'Файл импортирован.';
const FIRST_TICK_STATUS = 'price_disk_sync';

const PII: PiiSet = {
  names: [RESPONSIBLE_NAME.name, RESPONSIBLE_NAME.lastName],
  phones: [UNKNOWN_PHONE],
  emails: [],
};

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
let rootPath = '';
const worlds: BitrixWorld[] = [];
/** Пути, по которым агент получал поручение: архивный файл среди них быть не должен. */
let runPaths: string[] = [];

/** Цена-формула: сама формула и значение, закэшированное Excel в файле (с полным «хвостом»). */
interface FormulaCell {
  f: string;
  v: string;
}

/** Книга xlsx с шапкой поставщика и позициями (openpyxl из окружения documents). */
function buildPrice(
  relative: string,
  header: string[],
  rows: ReadonlyArray<readonly [string, string, number | FormulaCell, string]>,
): void {
  const python = `${requireEnv('E2E_ROOT')}/services/documents/.venv/bin/python`;
  const script = `${requireEnv('E2E_PROJECT_ROOT')}/e2e/fixtures/make_disk_price.py`;
  const result = spawnSync(
    python,
    ['-I', script, `${rootPath}/${relative}`, JSON.stringify({ header, rows })],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`сборка прайса не удалась: ${result.stderr}`);
}

/** Диск: известный поставщик, неизвестный с реквизитами в шапке и файл из архива. */
function buildDisk(): void {
  buildPrice(KNOWN_FILE, [`Прайс-лист ${KNOWN_NAME}`], KNOWN_ROWS);
  buildPrice(
    UNKNOWN_FILE,
    [
      `Прайс-лист ${UNKNOWN_NAME}`,
      `ИНН ${UNKNOWN_INN}`,
      `Тел. ${UNKNOWN_PHONE}`,
      `Город: ${UNKNOWN_CITY}`,
    ],
    UNKNOWN_ROWS,
  );
  buildPrice(ARCHIVE_FILE, [`Прайс-лист ${KNOWN_NAME}`], ARCHIVE_ROWS);
}

/** Последний результат инструмента в хвосте запроса и его имя. */
function tailOf(body: Record<string, unknown>): { tool: string | null; result: unknown } {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use') {
        names.set(String(block['id']), String(block['name']));
      }
    }
  }
  for (const block of [...blocksOf(messages.at(-1))].reverse()) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    const raw = block['content'];
    let result: unknown = raw;
    if (typeof raw === 'string') {
      try {
        result = JSON.parse(raw);
      } catch {
        result = raw;
      }
    }
    return { tool: names.get(String(block['tool_use_id'])) ?? '?', result };
  }
  return { tool: null, result: null };
}

function str(source: unknown, name: string): string {
  const value = isRecord(source) ? source[name] : undefined;
  if (typeof value !== 'string') throw new Error(`нет строкового поля ${name}`);
  return value;
}

/**
 * Файл из поручения последней реплики: с этапа 107 - идентификатор `fileref:<hex>` (путь с
 * фамилией модель искажала), прежние поручения - путь «файл «...»».
 */
function pathOfAssignment(body: Record<string, unknown>): string {
  const text = userTexts(body).at(-1) ?? '';
  // Модель видит hex идентификатора в буквенном алфавите кодека (identifier-codec), инструмент
  // получает обратно настоящее значение.
  const match = /(fileref:[0-9a-z]+)/.exec(text) ?? /файл «([^»]+)»/.exec(text);
  if (match?.[1] === undefined) throw new Error('в поручении нет файла');
  return match[1];
}

/** Идентификатор поставщика из строки поручения `supplierId=...`. */
function supplierOfAssignment(body: Record<string, unknown>): string {
  const text = userTexts(body).at(-1) ?? '';
  const match = /supplierId=(\S+?)\.?(?:\s|$)/.exec(text);
  if (match?.[1] === undefined) throw new Error('в поручении нет supplierId');
  return match[1];
}

/**
 * Ход «модели» агента прайсов на файл с диска: чтение -> запись цен на поставщика из
 * поручения (`supplierId=...`, его определил код тика).
 */
const script: DualHandler = ({ model, body }) => {
  if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
  const { tool, result } = tailOf(body);
  switch (tool) {
    case null: {
      return { kind: 'tool', name: 'readPriceFile', input: { path: pathOfAssignment(body) } };
    }
    case 'readPriceFile': {
      // Реальный путь виден только в ответе инструмента: поручение несёт идентификатор.
      runPaths.push(str(result, 'path'));
      if (str(result, 'path').includes(COMPLEX_MARK)) {
        // Модель называет сложную таблицу «изменилась структура»: код обязан это поправить.
        return {
          kind: 'tool',
          name: 'reportToManager',
          input: {
            kind: 'structure_changed',
            path: str(result, 'path'),
            fileHash: str(result, 'hash'),
          },
        };
      }
      // Поставщика (в том числе новый черновик) определил и завёл код тика (этап 145):
      // модель берёт supplierId из строки поручения и сама никого не ищет и не заводит.
      return saveReply(body, supplierOfAssignment(body));
    }
    case 'savePriceImport':
    case 'reportToManager':
      return { kind: 'text', text: DONE_TEXT };
    default:
      throw new Error(`нет реплики после ${String(tool)}`);
  }
};

/** Результат последнего вызова инструмента `tool` из истории запроса. */
function lastOf(body: Record<string, unknown>, tool: string): unknown {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const ids = new Set<string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use' && block['name'] === tool) {
        ids.add(String(block['id']));
      }
    }
  }
  let found: unknown;
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      const isMine = isRecord(block) && ids.has(String(block['tool_use_id']));
      if (isRecord(block) && block['type'] === 'tool_result' && isMine) {
        const raw = block['content'];
        found = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
    }
  }
  if (found === undefined) throw new Error(`в истории нет результата ${tool}`);
  return found;
}

function saveReply(body: Record<string, unknown>, supplierId: string) {
  const read = lastOf(body, 'readPriceFile');
  return {
    kind: 'tool' as const,
    name: 'savePriceImport',
    input: {
      path: str(read, 'path'),
      supplierId,
      tableIndex: 0,
      headerRows: headerRowCount(str(read, 'markdown')),
      columns: COLUMNS,
      fileHash: str(read, 'hash'),
    },
  };
}

interface Options {
  sync: boolean;
  initial: boolean;
}

/** Мир с корнем прайсов сценария; часы - от реального «сейчас». */
async function start(options: Options): Promise<{ world: BitrixWorld; clock: FixedClock }> {
  const clock = new FixedClock(new Date());
  const world = await startBitrixWorld({
    rules,
    clock,
    env: {
      PRICES_FILES_ROOT: rootPath,
      PRICE_DISK_SYNC_ENABLED: String(options.sync),
      PRICE_DISK_INITIAL_IMPORT_ENABLED: String(options.initial),
      PRICE_RESPONSIBLE_THREAD_ID: RESPONSIBLE_THREAD,
    },
  });
  worlds.push(world);
  world.portal.addUser({ id: RESPONSIBLE, ...RESPONSIBLE_NAME });
  return { world, clock };
}

function syncLogs(world: BitrixWorld): string[] {
  return world.logs.filter((line) => line.startsWith(FIRST_TICK_STATUS));
}

/** Пространство итогов обработки файлов первичного импорта (`DISK_SYNC_OUTCOME_NAMESPACE`). */
const OUTCOME_NAMESPACE = 'prices:disk-sync-outcome';
/** Статус итога файла, поставленного в работу и ещё не обработанного. */
const OUTCOME_QUEUED = 'queued';
/**
 * Запас на очередь запусков: воркер берёт по два запуска за раз, шаг агента идёт через
 * обезличивание всей истории, под нагрузкой машины файл ждёт своей очереди дольше обычного.
 */
const OUTCOMES_WAIT_MS = 120_000;

/** Сколько итогов файлов ещё «в очереди» и сколько записей итогов всего. */
async function outcomeCounts(): Promise<{ queued: number; total: number }> {
  const rows = await db.query(
    `SELECT count(*) FILTER (WHERE value::jsonb->>'status' = $2)::int AS queued, count(*)::int AS total
       FROM workflow_state WHERE namespace = $1`,
    [OUTCOME_NAMESPACE, OUTCOME_QUEUED],
  );
  const row: unknown = rows[0];
  if (!isRecord(row)) throw new Error('нет строки подсчёта итогов');
  return { queued: Number(row['queued']), total: Number(row['total']) };
}

/**
 * Ждёт, пока агент закончит все поставленные в работу файлы (итог записан, не «в очереди»).
 * Сводку шлёт тот тик, который видит все итоги записанными; тик раньше записи итога сводку
 * не пошлёт, а следующего тика в тесте нет. Путь файла в журнале запусков (`runPaths`) такой
 * гарантии не даёт: он появляется на чтении файла, до записи итога.
 */
async function waitOutcomesRecorded(expected: number): Promise<void> {
  await waitFor(
    'итоги всех файлов первичного импорта',
    async () => {
      const { queued, total } = await outcomeCounts();
      return total >= expected && queued === 0;
    },
    OUTCOMES_WAIT_MS,
  );
}

/**
 * Тик синхронизации по расписанию: часы вперёд на интервал, ждём ещё одну запись журнала.
 * Перед переводом часов ждёт, пока не останется файлов «в очереди» (иначе сводка не уйдёт).
 */
async function nextSyncTick(world: BitrixWorld, clock: FixedClock): Promise<void> {
  await waitOutcomesRecorded(0);
  const before = syncLogs(world).length;
  clock.advance(PRICE_DISK_SYNC_INTERVAL_MS + 1_000);
  await waitFor('тик синхронизации цен', () => syncLogs(world).length > before);
}

function summaries(world: BitrixWorld): string[] {
  return world
    .employee(RESPONSIBLE)
    .replies(BOT_PRICES)
    .filter((value) => value.includes(SUMMARY_HEAD));
}

async function seedKnown(): Promise<void> {
  await new PostgresSupplierRepository(db).saveCard(card(KNOWN_ID, KNOWN_NAME));
}

function card(id: string, name: string): SupplierCard {
  return {
    id,
    name,
    status: 'active',
    contacts: [],
    supplies: { categories: ['металлопрокат'], brands: [], regions: ['Москва'] },
    terms: {},
    notes: [],
    createdBy: 'seed',
    createdAt: `${SEED_DATE}T09:00:00.000Z`,
    updatedBy: 'seed',
    updatedAt: `${SEED_DATE}T09:00:00.000Z`,
    source: 'chat',
  };
}

async function expectClean(world: BitrixWorld): Promise<void> {
  expect(stub.errors).toEqual([]);
  await expectNoLeaks({ llm: stub.bodies(), logs: world.logs, portal: world.portal, pii: PII });
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeBitrixRules(RULES_NAME, {
    [PRICES_AGENT_ID]: { users: [String(RESPONSIBLE)] },
  });
  rootPath = `${e2eEnv().work}/files/${ROOT_DIR}`;
});

beforeEach(async () => {
  await resetHandoffTables(db);
  runPaths = [];
  await mkdir(rootPath, { recursive: true });
  buildDisk();
  stub.begin(script);
  await seedKnown();
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
  await rm(rootPath, { recursive: true, force: true });
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('v3a: первичный импорт прайсов с диска', () => {
  test(
    'известный и неизвестный поставщик, архив пропущен, сводка один раз',
    async () => {
      const { world, clock } = await start({ sync: true, initial: true });
      const suppliers = new PostgresSupplierRepository(db);
      const prices = new PostgresPriceRepository(db);

      // Первый тик ставит в работу оба прайса (архив исключён областью проверки).
      await waitFor('цены обоих поставщиков', async () => {
        const draft = (await suppliers.searchCards({ query: UNKNOWN_FOLDER_CORE, limit: 5 }))[0];
        return (
          (await prices.listBySupplier(KNOWN_ID)).length === KNOWN_ROWS.length &&
          draft !== undefined &&
          (await prices.listBySupplier(draft.id)).length === UNKNOWN_ROWS.length
        );
      });
      expect(summaries(world)).toEqual([]);

      // Следующий тик по расписанию: все итоги записаны, уходит сводка ответственному.
      await nextSyncTick(world, clock);
      const text = await world
        .employee(RESPONSIBLE)
        .waitText(BOT_PRICES, (value) => value.includes(SUMMARY_HEAD));
      const total = KNOWN_ROWS.length + UNKNOWN_ROWS.length;
      expect(text).toContain('Записано: 2');
      expect(text).toContain(`позиций: ${total}`);
      expect(text).toContain('Созданы новые карточки поставщиков');
      expect(text).not.toContain(KNOWN_NAME);
      // Повторные тики сводку не дублируют, архив в работу не берётся.
      await nextSyncTick(world, clock);
      expect(summaries(world)).toHaveLength(1);
      expect(runPaths).toHaveLength(2);
      expect(runPaths.some((path) => path.includes('Архив'))).toBe(false);

      // Известный поставщик: цены на его карточке, новых карточек для него нет.
      const known = (await prices.listBySupplier(KNOWN_ID)).map((item) => item.productName);
      expect(known.sort()).toEqual(KNOWN_ROWS.map((row) => row[1]).sort());
      expect(await suppliers.searchCards({ query: KNOWN_NAME, limit: 5 })).toHaveLength(1);

      // Неизвестный: непроверенная карточка, цены записаны на неё. С этапа 145 карточку заводит
      // код тика: название - из папки поставщика, ИНН - из шапки (RUNBOOK, «Непроверенные
      // карточки из прайсов»); телефон и город из шапки код не переносит.
      const drafts = await suppliers.searchCards({ query: UNKNOWN_FOLDER_CORE, limit: 5 });
      expect(drafts).toHaveLength(1);
      const draft = drafts[0];
      if (draft === undefined) throw new Error('непроверенная карточка не создана');
      expect(draft).not.toHaveProperty('isDraft');
      expect(draft.name).toContain(UNKNOWN_FOLDER_CORE);
      expect(draft.inn).toBe(UNKNOWN_INN);
      expect(text).toContain(draft.name);
      const draftItems = await prices.listBySupplier(draft.id);
      expect(draftItems.map((item) => item.productName).sort()).toEqual(
        UNKNOWN_ROWS.map((row) => row[1]).sort(),
      );

      await expectClean(world);
    },
    180_000,
  );
});

describe('v3b-v3c: первичный импорт включается только явным флагом', () => {
  test('без флага импорта первый тик только запоминает диск', async () => {
    const { world, clock } = await start({ sync: true, initial: false });
    await waitFor('первый тик синхронизации', () => syncLogs(world).length >= 1);
    expect(syncLogs(world)[0]).toContain('baseline');
    await nextSyncTick(world, clock);
    expect(runPaths).toEqual([]);
    expect(await new PostgresPriceRepository(db).listBySupplier(KNOWN_ID)).toEqual([]);
    expect(summaries(world)).toEqual([]);
    expect(stub.errors).toEqual([]);
  });

  test('флаг импорта без синхронизации ничего не запускает', async () => {
    const { world, clock } = await start({ sync: false, initial: true });
    clock.advance(PRICE_DISK_SYNC_INTERVAL_MS + 1_000);
    await Bun.sleep(1_500);
    expect(syncLogs(world)).toEqual([]);
    expect(runPaths).toEqual([]);
    expect(await new PostgresPriceRepository(db).listBySupplier(KNOWN_ID)).toEqual([]);
    expect(stub.errors).toEqual([]);
  });
});

describe('v3e: цены-формулы с кэшем-«хвостом»', () => {
  test(
    'импорт не отклоняется проверкой ПДн, цены записаны округлёнными',
    async () => {
      // Без округления в parser.py «266.666666666667» похоже на ИНН/телефон, цена заменяется
      // токеном, и ход агента отклоняется (pii_request_rejected).
      buildPrice(FORMULA_FILE, [`Прайс-лист ${FORMULA_NAME}`], FORMULA_ROWS);
      await new PostgresSupplierRepository(db).saveCard(card(FORMULA_ID, FORMULA_NAME));
      const { world } = await start({ sync: true, initial: true });
      const prices = new PostgresPriceRepository(db);
      await waitFor('цены поставщика с формулами', async () =>
        (await prices.listBySupplier(FORMULA_ID)).length === FORMULA_ROWS.length,
      );
      const saved = Object.fromEntries(
        (await prices.listBySupplier(FORMULA_ID)).map((item) => [item.productName, item.price]),
      );
      expect(saved).toEqual(FORMULA_PRICES);
      expect(world.logs.filter((line) => line.includes(PII_REJECTED_EVENT))).toEqual([]);
      // Модель видит в таблице округлённые цены, а не токены вместо «хвостов».
      const seen = JSON.stringify(stub.bodies());
      for (const price of Object.values(FORMULA_PRICES)) expect(seen).toContain(String(price));
      await expectClean(world);
    },
    180_000,
  );
});

describe('v3d: сложная таблица при первичном импорте', () => {
  test(
    'structure_changed заменяется на needs_review с кодом complex_table',
    async () => {
      // Содержимое обязано отличаться от «Металлист Север/Прайс.xlsx»: задача на файл ставится
      // с ключом идемпотентности по хэшу содержимого, а openpyxl пишет в книгу время создания с
      // точностью до секунды. Одинаковые строки, собранные в одну секунду, дают побайтно
      // одинаковые файлы, и задачу на сложную таблицу планировщик отбрасывал как дубль.
      buildPrice(
        COMPLEX_FILE,
        [`Прайс-лист ${KNOWN_NAME}`, 'Сложная форма: объединённые ячейки, несколько таблиц'],
        KNOWN_ROWS,
      );
      const { world, clock } = await start({ sync: true, initial: true });
      const prices = new PostgresPriceRepository(db);
      await waitFor('цены обоих поставщиков', async () => {
        const draft = (await new PostgresSupplierRepository(db).searchCards({
          query: UNKNOWN_FOLDER_CORE,
          limit: 5,
        }))[0];
        return (
          (await prices.listBySupplier(KNOWN_ID)).length === KNOWN_ROWS.length &&
          draft !== undefined &&
          (await prices.listBySupplier(draft.id)).length === UNKNOWN_ROWS.length
        );
      });
      await waitFor('поручение по сложному файлу', () =>
        runPaths.some((path) => path.includes(COMPLEX_MARK)),
      );
      // Все три файла (два прайса и сложная таблица) должны получить итог до тика со сводкой.
      await waitOutcomesRecorded(EXPECTED_OUTCOMES);
      await nextSyncTick(world, clock);
      const text = await world
        .employee(RESPONSIBLE)
        .waitText(BOT_PRICES, (value) => value.includes(SUMMARY_HEAD));
      expect(text).toContain('Пропущено');
      expect(text).toContain('Сложная таблица.xlsx');
      // Подпись кода по-человечески; «изменилась структура» первичному импорту не подходит.
      expect(text).toContain('сложная таблица');
      expect(text).not.toContain('structure_changed');
      expect(text).not.toContain('структур');
      // Отдельное сообщение по файлу не шлётся: он идёт только в сводку.
      const direct = world
        .employee(RESPONSIBLE)
        .replies(BOT_PRICES)
        .filter((value) => value.includes('изменилась структура'));
      expect(direct).toEqual([]);
      expect(stub.errors).toEqual([]);
    },
    180_000,
  );
});
