import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryMailboxDirectory, type PgClient } from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { MAIL_TRIGGER_NAMESPACE, PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { addDays, localDateKey, localHour, localWeekday, startOfLocalDay } from '@business-ai/core';
import type { InboxMessage } from '@business-ai/core';
import {
  BOT_PRICES,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { PRICES_MODEL, resetHandoffTables } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, userTexts } from '@business-ai/testing/e2e';
import { PRICE_FILE_PII } from '../lib/pii.owned';
import { type PiiSet } from '@business-ai/testing/e2e';
import { COLUMNS, headerRowCount } from '../lib/prices-flow';
import { advanceTo, waitFirstTick } from '../lib/time';
import { dumpWorkbook, isZip, sheetLines, type WorkbookDump } from '../lib/xlsx-read';

/**
 * Сценарий r-c: прайс с устаревшей датой в названии и письмо поставщика с триггером -> разбор
 * вложения -> файл изменений ответственному. Настоящий канал Bitrix24 (заглушка портала, бот
 * prices), Postgres, боевая сборка, pseudonymizer, pii-guard и сервис documents; модель -
 * скрипт, почта - `MemoryMailboxDirectory`.
 *
 * Часы: `FixedClock` стартует от реального «сейчас»; прыжки вперёд - не более трёх суток
 * (ретенция состояния 90 суток). Плановые обязанности идут по настоящей задаче
 * `monitoring.tick` из таблицы `jobs`.
 */

const TIMEZONE = 'Europe/Moscow';
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const TICK_MS = 15 * MS_PER_MINUTE;
const QUIET_MS = 1_500;
const TEST_TIMEOUT_MS = 300_000;
/** Насколько дата в названии файла старше порога в 3 месяца (дней): заведомо устарел. */
const STALE_MARGIN_DAYS = 120;
const WEEK_DAYS = 7;
/** День недели проверки файлов (понедельник) и час её начала по местному времени. */
const MONDAY = 1;
const DISK_CHECK_HOUR = 9;
/** Шаг поиска понедельника: начиная со следующих суток. */
const NEXT_DAY = 1;
/** Час проверок мониторинга (прайс-файлы и почта) по местному времени. */
const CHECK_HOUR = 10;
const BEFORE_CHECK_MINUTES = 30;
const AFTER_CHECK_MINUTES = 15;
const RULES_NAME = 'r-stale-price-and-mail-trigger';
/** Каталог файлов сценария внутри корня прайсов: чистится после каждого теста. */
const FILES_DIR = 'e2e-r-stale-price';
const FIXTURE_PRICE_FILE = 'Прайс поставщика.xlsx';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Сотрудник, писавший боту «Актуализация прайса (ИИ агент)»; владелец ящика с письмом поставщика.
 */
const EMPLOYEE = 1001;
const EMPLOYEE_NAME = { name: 'Валентина', lastName: 'Громова' };
const EMPLOYEE_ADDRESS = 'gromova.v@pragmatika-mail.test';
/** Сотрудник с ящиком, который боту не писал: его ящик всё равно проверяется (по его id). */
const SILENT = 1002;
const SILENT_NAME = { name: 'Станислав', lastName: 'Дроздов' };
const SILENT_ADDRESS = 'drozdov.s@pragmatika-mail.test';
/** Сотрудник с ящиком, но без права на бота прайсов по политике доступа: не уведомляется. */
const DENIED = 1004;
const DENIED_NAME = { name: 'Игорь', lastName: 'Воронцов' };
const DENIED_ADDRESS = 'vorontsov.i@pragmatika-mail.test';
/** Ответственный за прайсы (`PRICE_RESPONSIBLE_THREAD_ID`): список и запасной адрес файла. */
const RESPONSIBLE = 1003;
const RESPONSIBLE_NAME = { name: 'Ольга', lastName: 'Назарова' };
const RESPONSIBLE_THREAD = `${BOT_PRICES}/${RESPONSIBLE}`;

const SUPPLIER_ID = 'sup-e2e-r-c';
const SUPPLIER_NAME = 'ООО Металлопрокат Гамма';
const SUPPLIER_FOLDER = 'Металлопрокат Гамма';
const SUPPLIER_EMAIL = 'zakupki.rc@metalprom-gamma.test';
const OTHER_SUPPLIER_ID = 'sup-e2e-r-c-2';
const OTHER_SUPPLIER_NAME = 'ООО Болтовой Двор';
const OTHER_SUPPLIER_FOLDER = 'Болтовой Двор';
const OTHER_SUPPLIER_EMAIL = 'info.bd@boltovoy-dvor.test';
const STRANGER_EMAIL = 'promo.shop@random-shop.test';

const TRIGGER_SUBJECT = 'Повышение цен с 1 ноября';
const ATTACHMENT_NAME = 'Прайс ноябрь.xlsx';
const STALE_MARK = 'не обновлялись последние 3 месяца';
const UNDATED_MARK = 'Дата в названии не найдена';
const NOTICE_MARK = 'Найдено:';
/** Просьба сотрудника разобрать письмо: уведомление агента не запускает, это делает человек. */
const REQUEST_TEXT = 'Разбери письмо поставщика с новым прайсом';
// Имя файла изменений: «Прайс_<поставщик>_<ДД.ММ.ГГГГ>.xlsx» (коммит e96cc4f3); раньше был
// технический «price-changes-<id>-<дата>».
const CHANGES_PREFIX = 'Прайс_';
const CHANGES_MARK = 'подготовлено для внесения в корпоративный диск';
const DONE_TEXT = 'Разбор прайса завершён.';
/** Ответ скрипта, когда в почте нет письма для разбора. */
const NO_MAIL_TEXT = 'Письма с прайсом нет';
const RESEND_TEXT = 'Отправь файл изменений ещё раз';
const GREETING = 'Здравствуйте';
const CURSOR_NAMESPACE = 'bitrix24-cursor.v1';

/** Позиции файла-фикстуры (синхронно с fixtures/make_fixtures.py): артикул, название, цена. */
const FILE_ITEMS: Array<[string, string, number]> = [
  ['AR-001', 'Арматура А500С d12', 62_500.5],
  ['AR-002', 'Арматура А500С d16', 61_800],
  ['LS-010', 'Лист стальной 3 мм', 71_200],
  ['TR-020', 'Труба профильная 40x40', 68_900.25],
  ['UG-030', 'Уголок равнополочный 50', 64_300],
];
const SEED_DATE = '2026-09-01';
const REMOVED_SKU = 'OLD-999';
const REMOVED_NAME = 'Снятая позиция каталога';

/** ПДн, которых не должно быть в запросах к модели, журналах, аудите и очереди. */
const PII: PiiSet = {
  names: [
    ...PRICE_FILE_PII.names,
    EMPLOYEE_NAME.name,
    EMPLOYEE_NAME.lastName,
    SILENT_NAME.name,
    SILENT_NAME.lastName,
    RESPONSIBLE_NAME.name,
    RESPONSIBLE_NAME.lastName,
    DENIED_NAME.name,
    DENIED_NAME.lastName,
  ],
  phones: [...PRICE_FILE_PII.phones],
  emails: [
    ...PRICE_FILE_PII.emails,
    SUPPLIER_EMAIL,
    OTHER_SUPPLIER_EMAIL,
    STRANGER_EMAIL,
    EMPLOYEE_ADDRESS,
    SILENT_ADDRESS,
    DENIED_ADDRESS,
  ],
};
/** Тексты, которые не должны попадать в журналы, аудит и очередь. */
const FORBIDDEN_TEXTS = [TRIGGER_SUBJECT, ATTACHMENT_NAME];

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
let priceFile = new Uint8Array();
const worlds: BitrixWorld[] = [];

/** Что модель видит в хвосте запроса: результат инструмента или реплика человека. */
interface Tail {
  tool: string | null;
  result: unknown;
  human: string;
}

function parsedContent(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** Хвост запроса к модели: последний результат инструмента (с именем) либо реплика. */
function tailOf(body: Record<string, unknown>): Tail {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use') {
        names.set(String(block['id']), String(block['name']));
      }
    }
  }
  const blocks = blocksOf(messages.at(-1));
  for (const block of [...blocks].reverse()) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    return {
      tool: names.get(String(block['tool_use_id'])) ?? '?',
      result: parsedContent(block['content']),
      human: '',
    };
  }
  return { tool: null, result: null, human: userTexts(body).at(-1) ?? '' };
}

/** Поле объекта-результата; undefined, если результат не объект. */
function field(result: unknown, name: string): unknown {
  return isRecord(result) ? result[name] : undefined;
}

function text(result: unknown, name: string): string {
  const value = field(result, name);
  if (typeof value !== 'string') throw new Error(`в результате нет строкового поля ${name}`);
  return value;
}

/** Параметры, по которым собирается и повторно отправляется файл изменений. */
interface ChangeParams {
  supplierId: string;
  fileHash: string;
  diffHash: string;
}

/** Значения последнего сравнения: нужны сценарию «отправь файл ещё раз». */
let captured: ChangeParams | null = null;
/** Сколько раз скрипт вызвал `sendPriceChangeFile`. */
let sendCalls = 0;

/** Письмо поставщика с признаком цен из результата `readPriceMail`; undefined, если его нет. */
function triggerMailOf(result: unknown): unknown {
  const mails = field(result, 'mails');
  if (!Array.isArray(mails)) return undefined;
  return mails.find(
    (mail: unknown) =>
      field(mail, 'known') === true &&
      field(mail, 'senderVerified') === true &&
      field(mail, 'subject') === TRIGGER_SUBJECT,
  );
}

/** Первое вложение письма из результата `readPriceMail`. */
function firstAttachmentPath(mail: unknown): string {
  const attachments = field(mail, 'attachments');
  const first: unknown = Array.isArray(attachments) ? attachments[0] : undefined;
  return text(first, 'path');
}

/**
 * Ход «модели» агента «Актуализация прайса (ИИ агент)»: по просьбе сотрудника - прочитать почту
 * (`readPriceMail`) -> прочитать вложение -> staging -> сравнение -> (скачки: вопрос
 * ответственному) -> файл изменений -> закрыть письмо. Само уведомление о письме агента не
 * запускает.
 */
const script: DualHandler = ({ model, body }) => {
  if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
  const tail = tailOf(body);
  if (tail.tool === null) {
    if (tail.human.includes(REQUEST_TEXT)) {
      return { kind: 'tool', name: 'readPriceMail', input: {} };
    }
    if (tail.human.includes(RESEND_TEXT) && captured !== null) {
      sendCalls += 1;
      return { kind: 'tool', name: 'sendPriceChangeFile', input: { ...captured } };
    }
    return { kind: 'text', text: 'Принято.' };
  }
  switch (tail.tool) {
    case 'readPriceMail': {
      const mail = triggerMailOf(tail.result);
      if (mail === undefined || field(mail, 'attachments') === undefined) {
        return { kind: 'text', text: `Письма с прайсом нет: ${JSON.stringify(tail.result)}` };
      }
      return { kind: 'tool', name: 'readPriceFile', input: { path: firstAttachmentPath(mail) } };
    }
    case 'readPriceFile': {
      const opened = lastOpened(body);
      return {
        kind: 'tool',
        name: 'stagePriceRows',
        input: {
          path: text(tail.result, 'path'),
          supplierId: text(opened, 'supplierId'),
          tableIndex: 0,
          headerRows: headerRowCount(text(tail.result, 'markdown')),
          columns: COLUMNS,
          reset: true,
        },
      };
    }
    case 'stagePriceRows':
      return {
        kind: 'tool',
        name: 'previewPriceChanges',
        input: {
          supplierId: text(tail.result, 'supplierId'),
          fileHash: text(tail.result, 'fileHash'),
        },
      };
    case 'previewPriceChanges': {
      const staged = lastResultOf(body, 'stagePriceRows');
      const supplierId = text(staged, 'supplierId');
      const fileHash = text(staged, 'fileHash');
      const diffHash = text(tail.result, 'diffHash');
      captured = { supplierId, fileHash, diffHash };
      sendCalls += 1;
      return { kind: 'tool', name: 'sendPriceChangeFile', input: { ...captured } };
    }
    case 'sendPriceChangeFile': {
      if (field(tail.result, 'delivered') !== true) {
        return { kind: 'text', text: `Файл не отправлен: ${JSON.stringify(tail.result)}` };
      }
      const opened = lastOpened(body);
      if (opened === undefined) return { kind: 'text', text: DONE_TEXT };
      return {
        kind: 'tool',
        name: 'markPriceMailHandled',
        input: { messageId: text(opened, 'messageId'), outcome: 'staged' },
      };
    }
    case 'markPriceMailHandled':
      return { kind: 'text', text: DONE_TEXT };
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

/** Результаты инструмента `name` из истории запроса (последний вызов). */
function lastResultOf(body: Record<string, unknown>, name: string): unknown {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names = new Map<string, string>();
  let found: unknown;
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'tool_use') names.set(String(block['id']), String(block['name']));
      if (block['type'] === 'tool_result' && names.get(String(block['tool_use_id'])) === name) {
        found = parsedContent(block['content']);
      }
    }
  }
  if (found === undefined) throw new Error(`в истории нет результата ${name}`);
  return found;
}

/** Письмо с признаком цен из последнего `readPriceMail` хода; undefined, если почту не читали. */
function lastOpened(body: Record<string, unknown>): unknown {
  try {
    return triggerMailOf(lastResultOf(body, 'readPriceMail'));
  } catch {
    return undefined;
  }
}

/** Письмо поставщика с вложением-прайсом; отправитель подтверждён, если не сказано иное. */
function letter(
  id: string,
  from: string,
  subject: string,
  receivedAt: Date,
  extra: { senderAuth?: 'verified' | 'unverified'; attachment?: boolean } = {},
): InboxMessage {
  const withFile = extra.attachment ?? true;
  return {
    id,
    from,
    subject,
    body: 'Добрый день, просим учесть изменения с ближайшего месяца.',
    receivedAt: receivedAt.toISOString(),
    attachments: withFile
      ? [{ fileName: ATTACHMENT_NAME, mimeType: XLSX_MIME, bytes: priceFile }]
      : [],
    senderAuth: extra.senderAuth ?? 'verified',
  };
}

async function seedSuppliers(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  await suppliers.upsert({ id: SUPPLIER_ID, name: SUPPLIER_NAME, email: SUPPLIER_EMAIL });
  await suppliers.upsert({
    id: OTHER_SUPPLIER_ID,
    name: OTHER_SUPPLIER_NAME,
    email: OTHER_SUPPLIER_EMAIL,
  });
}

/**
 * Прайс поставщика в базе. `jumpy` - все цены вдвое ниже файла (скачки сверх порога); иначе
 * две позиции чуть ниже файла (изменения), две новые (в базе нет), одна снятая.
 */
async function seedPrices(jumpy: boolean): Promise<void> {
  const base = jumpy
    ? FILE_ITEMS.map(([sku, name, price]): [string, string, number] => [sku, name, price * 0.5])
    : [
        ['AR-001', 'Арматура А500С d12', 62_500.5 * 0.9] as [string, string, number],
        ['AR-002', 'Арматура А500С d16', 61_800] as [string, string, number],
        ['LS-010', 'Лист стальной 3 мм', 71_200 * 0.8] as [string, string, number],
        [REMOVED_SKU, REMOVED_NAME, 1_000] as [string, string, number],
      ];
  await new PostgresPriceRepository(db).saveImport(
    SUPPLIER_ID,
    base.map(([sku, productName, price]) => ({
      supplierId: SUPPLIER_ID,
      sku,
      productName,
      price,
      currency: 'RUB',
      date: SEED_DATE,
    })),
    `e2e-r-c-seed-${jumpy ? 'jumpy' : 'calm'}`,
  );
}

/** Час запуска по умолчанию: до часа проверок, чтобы первый тик не закрыл слот почты. */
const DEFAULT_START_HOUR = 9;

/**
 * Мир с мониторингом и ящиками; ответственный за прайсы - тред `prices/1003`. Ящики
 * проверяются все сразу после подключения, поэтому по умолчанию старт до 10:00: иначе первый
 * тик просмотрел бы пустые ящики и закрыл слот на 3 суток раньше, чем придёт письмо.
 */
async function start(
  at: Date = localTime(new Date(), DEFAULT_START_HOUR, 0),
): Promise<{ world: BitrixWorld; mailboxes: MemoryMailboxDirectory }> {
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(String(EMPLOYEE), EMPLOYEE_ADDRESS);
  mailboxes.connect(String(SILENT), SILENT_ADDRESS);
  mailboxes.connect(String(DENIED), DENIED_ADDRESS);
  const world = await startBitrixWorld({
    rules,
    flags: { monitoring: true },
    mailboxes,
    clock: new FixedClock(at),
    env: { PRICE_RESPONSIBLE_THREAD_ID: RESPONSIBLE_THREAD },
  });
  worlds.push(world);
  world.portal.addUser({ id: EMPLOYEE, ...EMPLOYEE_NAME });
  world.portal.addUser({ id: SILENT, ...SILENT_NAME });
  world.portal.addUser({ id: RESPONSIBLE, ...RESPONSIBLE_NAME });
  world.portal.addUser({ id: DENIED, ...DENIED_NAME });
  await waitFirstTick(world);
  return { world, mailboxes };
}

function clockOf(world: BitrixWorld): FixedClock {
  if (world.clock === undefined) throw new Error('мир запущен без FixedClock');
  return world.clock;
}

/** Местное время `hour:minute` того же дня, что и `at`. */
function localTime(at: Date, hour: number, minute: number): Date {
  const day = startOfLocalDay(localDateKey(at, TIMEZONE), TIMEZONE);
  return new Date(day.getTime() + hour * MS_PER_HOUR + minute * MS_PER_MINUTE);
}

/** Ближайший понедельник строго после `from`, 08:30 по местному времени (до проверки файлов). */
function nextMondayBeforeDiskCheck(from: Date): Date {
  let day = addDays(localDateKey(from, TIMEZONE), NEXT_DAY);
  while (localWeekday(startOfLocalDay(day, TIMEZONE), TIMEZONE) !== MONDAY) day = addDays(day, 1);
  return localTime(startOfLocalDay(day, TIMEZONE), DISK_CHECK_HOUR - 1, BEFORE_CHECK_MINUTES);
}

/** Имя файла с датой в названии `ДД.ММ.ГГГГ` за `days` суток до понедельника `monday`. */
function datedFileName(monday: Date, days: number): string {
  const [year, month, day] = addDays(localDateKey(monday, TIMEZONE), -days).split('-');
  return `прайс_${day}.${month}.${year}.xlsx`;
}

/** Часы переведены на рабочее время проверок (не раньше 10:00 по местному времени). */
async function toCheckHours(world: BitrixWorld): Promise<void> {
  const now = clockOf(world).now();
  if (localHour(now, TIMEZONE) >= CHECK_HOUR) return;
  await advanceTo(world, localTime(now, CHECK_HOUR, AFTER_CHECK_MINUTES));
}

/** Следующие сутки, 09:30 по местному времени (до часа проверок). */
function nextDayBeforeCheck(world: BitrixWorld): Date {
  const next = new Date(clockOf(world).now().getTime() + MS_PER_DAY);
  return localTime(next, CHECK_HOUR - 1, BEFORE_CHECK_MINUTES);
}

function dialogTexts(world: BitrixWorld, userId: number): string[] {
  return world.employee(userId).replies(BOT_PRICES);
}

function withMark(world: BitrixWorld, userId: number, mark: string): string[] {
  return dialogTexts(world, userId).filter((value) => value.includes(mark));
}

/** Файлы изменений, которые бот прислал за всё время теста. */
function changeFiles(world: BitrixWorld): Array<{ name: string; bytes: Uint8Array; to: string }> {
  return world.portal.uploads
    .filter((file) => file.name.startsWith(CHANGES_PREFIX))
    .map((file) => ({ name: file.name, bytes: file.bytes, to: file.dialogId }));
}

async function expectClean(
  world: BitrixWorld,
  options: { allowEmptyLlm?: boolean } = {},
): Promise<void> {
  expect(stub.errors).toEqual([]);
  expect(world.logs.filter((line) => line.startsWith('monitoring_duty_failed'))).toEqual([]);
  await expectNoLeaks({
    llm: stub.bodies(),
    allowEmptyLlm: options.allowEmptyLlm === true,
    logs: world.logs,
    portal: world.portal,
    db,
    pii: PII,
    workflowNamespaces: [CURSOR_NAMESPACE, MAIL_TRIGGER_NAMESPACE],
    forbiddenTexts: FORBIDDEN_TEXTS,
  });
}

/** Файл изменений: пять листов, ключевые строки; ПДн шапки прайса в файл не попали. */
async function expectChangesWorkbook(
  bytes: Uint8Array,
  expected: { jumpy: boolean },
): Promise<WorkbookDump> {
  expect(isZip(bytes)).toBe(true);
  const dump = await dumpWorkbook(bytes);
  expect(Object.keys(dump)).toEqual(['Изменения', 'Новые', 'Снятые', 'На проверку', 'Источник']);
  const source = sheetLines(dump, 'Источник').join('\n');
  expect(source).toContain(`Поставщик | ${SUPPLIER_NAME}`);
  expect(source).toContain('Источник | Письмо поставщика');
  expect(source).toContain(`Файл | ${ATTACHMENT_NAME}`);
  expect(source).toContain(`Тема письма | ${TRIGGER_SUBJECT}`);
  expect(source).toContain(`Отправитель | ${SUPPLIER_EMAIL}`);
  expect(source).not.toContain('отправитель не подтверждён');
  const changed = sheetLines(dump, 'Изменения').join('\n');
  const added = sheetLines(dump, 'Новые').join('\n');
  const removed = sheetLines(dump, 'Снятые').join('\n');
  const review = sheetLines(dump, 'На проверку').join('\n');
  if (expected.jumpy) {
    expect(changed).toContain('AR-001');
    expect(changed).toContain('Арматура А500С d12');
    expect(review).toContain('Скачок цены');
    expect(review).toContain('проверьте перед внесением');
  } else {
    expect(changed).toContain('AR-001');
    expect(changed).toContain('LS-010');
    expect(changed).not.toContain('AR-002');
    expect(added).toContain('TR-020');
    expect(added).toContain('UG-030');
    expect(removed).toContain(REMOVED_SKU);
  }
  const everything = JSON.stringify(dump);
  for (const value of [
    ...PRICE_FILE_PII.names,
    ...PRICE_FILE_PII.phones,
    ...PRICE_FILE_PII.emails,
  ]) {
    expect(everything).not.toContain(value);
  }
  return dump;
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  // SILENT боту не писал, но по политике допущен; DENIED допущен не будет.
  const everyone = { users: [String(EMPLOYEE), String(SILENT), String(RESPONSIBLE)] };
  rules = await writeBitrixRules(RULES_NAME, { [PRICES_AGENT_ID]: everyone });
  priceFile = new Uint8Array(await readFile(`${e2eEnv().pricesRoot}/${FIXTURE_PRICE_FILE}`));
});

beforeEach(async () => {
  await resetHandoffTables(db);
  captured = null;
  sendCalls = 0;
  stub.begin(script);
  await seedSuppliers();
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
  await rm(`${e2eEnv().pricesRoot}/${FILES_DIR}`, { recursive: true, force: true });
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('r-c1: прайсы на диске с устаревшей датой в названии', () => {
  test(
    'понедельник с 09:00: один список ответственному, без повтора в тот же понедельник, ' +
      'во вторник тишина, в следующий понедельник снова',
    async () => {
      const monday = nextMondayBeforeDiskCheck(new Date());
      const staleName = datedFileName(monday, STALE_MARGIN_DAYS + 90);
      const freshName = datedFileName(monday, 0);
      // Дата изменения у всех файлов свежая: решает только дата в названии.
      const names = [staleName, freshName];
      for (const folder of [SUPPLIER_FOLDER, OTHER_SUPPLIER_FOLDER]) {
        for (const name of names) {
          const path = `${e2eEnv().pricesRoot}/${FILES_DIR}/${folder}/${name}`;
          await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
          await writeFile(path, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
        }
      }
      const undated = `${e2eEnv().pricesRoot}/${FILES_DIR}/${SUPPLIER_FOLDER}/без даты.xlsx`;
      await writeFile(undated, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      const { world } = await start(monday);

      // До 09:00 в понедельник сообщения нет.
      await world.idle(QUIET_MS);
      expect(withMark(world, RESPONSIBLE, STALE_MARK)).toHaveLength(0);

      await advanceTo(world, localTime(monday, DISK_CHECK_HOUR, AFTER_CHECK_MINUTES));
      // Одним сообщением со списком обоих поставщиков и блоком «без даты», в тред ответственного.
      await world
        .employee(RESPONSIBLE)
        .waitText(BOT_PRICES, (value) => value.includes(STALE_MARK));
      const first = withMark(world, RESPONSIBLE, STALE_MARK);
      expect(first).toHaveLength(1);
      expect(first[0]).toContain('Металлопрокат Гамма');
      expect(first[0]).toContain('Болтовой Двор');
      expect(first[0]).toContain(staleName);
      expect(first[0]).not.toContain(freshName);
      expect(first[0]).toContain(UNDATED_MARK);

      // Тот же понедельник: следующий тик слот не открывает, сообщение остаётся одним.
      await advanceTo(world, new Date(clockOf(world).now().getTime() + TICK_MS));
      await world.idle(QUIET_MS);
      expect(withMark(world, RESPONSIBLE, STALE_MARK)).toHaveLength(1);

      // Вторник: проверка только по понедельникам.
      await advanceTo(world, new Date(clockOf(world).now().getTime() + MS_PER_DAY));
      await world.idle(QUIET_MS);
      expect(withMark(world, RESPONSIBLE, STALE_MARK)).toHaveLength(1);

      // Следующий понедельник: файлы всё ещё устарели - список приходит снова.
      const nextMonday = new Date(monday.getTime() + WEEK_DAYS * MS_PER_DAY);
      await advanceTo(world, localTime(nextMonday, DISK_CHECK_HOUR, AFTER_CHECK_MINUTES));
      await world.idle(QUIET_MS);
      expect(withMark(world, RESPONSIBLE, STALE_MARK)).toHaveLength(2);

      // Остальным сотрудникам ничего не ушло, модель по расписанию не вызывалась.
      expect(dialogTexts(world, EMPLOYEE)).toEqual([]);
      expect(dialogTexts(world, SILENT)).toEqual([]);
      expect(stub.requests).toHaveLength(0);
      // Плановая обязанность без модели: пустой список запросов к ней задуман.
      await expectClean(world, { allowEmptyLlm: true });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('r-c2: письмо поставщика с триггером -> разбор прайса -> файл изменений', () => {
  /**
   * Сотрудник пишет боту «Актуализация прайса (ИИ агент)»: насос заносит его в реестр обращений.
   */
  async function contactBot(world: BitrixWorld): Promise<void> {
    const employee = world.employee(EMPLOYEE);
    await employee.say(BOT_PRICES, GREETING);
    await employee.waitText(BOT_PRICES, 'Принято.');
  }

  /**
   * Письмо с признаком цен получено, проверка почты отработала: уведомление без кнопок.
   * `extras: false` - в ящике только нужное письмо (разбор читает почту целиком).
   */
  async function untilNotice(
    world: BitrixWorld,
    mailboxes: MemoryMailboxDirectory,
    options: { extras?: boolean } = {},
  ): Promise<void> {
    const extras = options.extras ?? true;
    await contactBot(world);
    const received = new Date(clockOf(world).now().getTime() - MS_PER_HOUR);
    mailboxes.deliver(
      String(EMPLOYEE),
      letter('m-trigger-1', SUPPLIER_EMAIL, TRIGGER_SUBJECT, received),
    );
    if (extras) {
      // Письма не от поставщика, без подтверждения отправителя, без триггера и в чужом ящике.
      mailboxes.deliver(
        String(EMPLOYEE),
        letter('m-stranger', STRANGER_EMAIL, 'Повышение цен на всё', received),
      );
      mailboxes.deliver(
        String(EMPLOYEE),
        letter('m-unverified', SUPPLIER_EMAIL, 'Новый прайс-лист', received, {
          senderAuth: 'unverified',
        }),
      );
      mailboxes.deliver(
        String(EMPLOYEE),
        letter('m-plain', SUPPLIER_EMAIL, 'Счёт на оплату', received, { attachment: false }),
      );
      mailboxes.deliver(
        String(SILENT),
        letter('m-silent', OTHER_SUPPLIER_EMAIL, TRIGGER_SUBJECT, received),
      );
      // Ящик сотрудника без права на бота прайсов не просматривается.
      mailboxes.deliver(
        String(DENIED),
        letter('m-denied', SUPPLIER_EMAIL, TRIGGER_SUBJECT, received),
      );
    }
    // Письма уже в ящиках: часы переводятся на время проверки, и первый просмотр их видит.
    await toCheckHours(world);
    await advanceTo(world, new Date(clockOf(world).now().getTime() + TICK_MS));
    const employee = world.employee(EMPLOYEE);
    await employee.waitText(BOT_PRICES, (value) => value.includes(NOTICE_MARK));
  }

  /** Нет уведомления о письме у сотрудников, кроме `except`. */
  function expectNoNoticeFor(world: BitrixWorld, users: readonly number[]): void {
    for (const userId of users) expect(withMark(world, userId, NOTICE_MARK)).toEqual([]);
  }

  test(
    'до 10:00 проверки нет; уведомление без кнопок; разбор по просьбе; повторы без дублей',
    async () => {
      await seedPrices(false);
      const { world, mailboxes } = await start();
      const employee = world.employee(EMPLOYEE);

      // До 10:00 по местному времени письма не просматриваются, даже при записи в реестре.
      await contactBot(world);
      const received = new Date(clockOf(world).now().getTime() - MS_PER_HOUR);
      mailboxes.deliver(
        String(EMPLOYEE),
        letter('m-trigger-1', SUPPLIER_EMAIL, TRIGGER_SUBJECT, received),
      );
      await advanceTo(world, nextDayBeforeCheck(world));
      await world.idle(QUIET_MS);
      expectNoNoticeFor(world, [EMPLOYEE, SILENT, RESPONSIBLE]);

      // 10:15: проверка идёт, сотрудник получает одно уведомление без кнопок.
      await advanceTo(world, localTime(clockOf(world).now(), CHECK_HOUR, AFTER_CHECK_MINUTES));
      await employee.waitText(BOT_PRICES, (value) => value.includes(NOTICE_MARK));
      await world.idle(QUIET_MS);
      const notice = withMark(world, EMPLOYEE, NOTICE_MARK);
      expect(notice).toHaveLength(1);
      expect(notice[0]).toContain(SUPPLIER_NAME);
      expect(notice[0]).toContain(TRIGGER_SUBJECT);
      // Готового «обновления прайса» агент не предлагает: у уведомления нет клавиатуры.
      const noticeMessage = employee
        .messages(BOT_PRICES)
        .find((message) => message.text.includes(NOTICE_MARK));
      expect(noticeMessage?.keyboard ?? null).toBeNull();
      // Просмотр только читает: письмо не помечено обработанным, модель не вызывалась.
      expect(mailboxes.processedIds(String(EMPLOYEE))).toEqual([]);
      // Уведомление агента не запускает: ни одного запроса к модели, кроме приветствия.
      const modelBeforeRequest = stub.requests.length;

      // Сотрудник сам просит разобрать письмо -> разбор вложения -> файл изменений.
      await employee.say(BOT_PRICES, REQUEST_TEXT);
      await employee.waitText(BOT_PRICES, DONE_TEXT, { timeoutMs: TEST_TIMEOUT_MS });
      const modelAfterRequest = stub.requests.length;
      expect(modelAfterRequest).toBeGreaterThan(modelBeforeRequest);
      expect(stub.errors).toEqual([]);

      const files = changeFiles(world);
      expect(files).toHaveLength(1);
      const [file] = files;
      // Файл получает сотрудник, который попросил разобрать письмо, а не ответственный.
      expect(file?.to).toBe(String(EMPLOYEE));
      expect(file?.name).toMatch(
        new RegExp(`^Прайс_${SUPPLIER_NAME}_\\d{2}\\.\\d{2}\\.\\d{4}\\.xlsx$`, 'u'),
      );
      await expectChangesWorkbook(file?.bytes ?? new Uint8Array(), { jumpy: false });
      // Сотруднику - сообщение с пометкой «подготовлено для внесения», ответственному - нет.
      expect(withMark(world, EMPLOYEE, CHANGES_MARK)).toHaveLength(1);
      expect(withMark(world, RESPONSIBLE, CHANGES_MARK)).toEqual([]);
      // Письмо закрыто в ящике сотрудника; в чужом ящике ничего не отмечено.
      expect(mailboxes.processedIds(String(EMPLOYEE))).toEqual(['m-trigger-1']);
      expect(mailboxes.processedIds(String(SILENT))).toEqual([]);
      // Письмо не от поставщика, неподтверждённое и без триггера: без уведомлений.
      expectNoNoticeFor(world, [SILENT, RESPONSIBLE]);
      expect(withMark(world, EMPLOYEE, NOTICE_MARK)).toHaveLength(1);

      // Повторная просьба: письмо уже разобрано и закрыто, нового файла нет.
      const beforeAgain = employee.snapshot(BOT_PRICES);
      await employee.say(BOT_PRICES, REQUEST_TEXT);
      await employee.waitText(BOT_PRICES, (value) => value.includes(NO_MAIL_TEXT), {
        since: beforeAgain,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      await world.idle(QUIET_MS);
      expect(changeFiles(world)).toHaveLength(1);

      // Повторная отправка файла того же сравнения: ключ идемпотентности, второго файла нет.
      const callsBefore = sendCalls;
      const since = employee.snapshot(BOT_PRICES);
      await employee.say(BOT_PRICES, RESEND_TEXT);
      await employee.waitText(BOT_PRICES, DONE_TEXT, { since, timeoutMs: TEST_TIMEOUT_MS });
      await world.idle(QUIET_MS);
      expect(sendCalls).toBe(callsBefore + 1);
      expect(changeFiles(world)).toHaveLength(1);
      expect(withMark(world, EMPLOYEE, CHANGES_MARK)).toHaveLength(1);

      // Следующие сутки: проверка почты раз в 3 суток, нового уведомления нет.
      await advanceTo(world, new Date(clockOf(world).now().getTime() + MS_PER_DAY));
      await world.idle(QUIET_MS);
      expect(withMark(world, EMPLOYEE, NOTICE_MARK)).toHaveLength(1);
      await expectClean(world);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'чужие письма уведомлений не дают; ящик не писавшего боту проверяется; агент не запускается',
    async () => {
      await seedPrices(false);
      const { world, mailboxes } = await start();
      const employee = world.employee(EMPLOYEE);
      await untilNotice(world, mailboxes);
      await world.idle(QUIET_MS);

      // По уведомлению на письмо: письмо с триггером и письмо поставщика с неподтверждённым
      // отправителем (подлинность не проверяется, решение владельца 30.10 - коммиты 2d14253c,
      // 3e694800); письмо не от поставщика и письмо без триггера отброшены.
      const notice = withMark(world, EMPLOYEE, NOTICE_MARK);
      expect(notice).toHaveLength(2);
      expect(notice.some((value) => value.includes(TRIGGER_SUBJECT))).toBe(true);
      expect(notice.some((value) => value.includes('Новый прайс-лист'))).toBe(true);
      for (const value of notice) {
        expect(value).not.toContain('Повышение цен на всё');
        expect(value).not.toContain('Счёт на оплату');
        expect(value).not.toContain(STRANGER_EMAIL);
      }
      expectNoNoticeFor(world, [RESPONSIBLE]);
      // Сотрудник, ни разу не писавший боту, тоже получает уведомление по своему письму:
      // ящик проверяется по списку ящиков, а тред строится по его id Bitrix24.
      await world.employee(SILENT).waitText(BOT_PRICES, (value) => value.includes(NOTICE_MARK));
      const silentNotice = withMark(world, SILENT, NOTICE_MARK);
      expect(silentNotice).toHaveLength(1);
      expect(silentNotice[0]).toContain(OTHER_SUPPLIER_NAME);
      // Без права по политике доступа уведомления нет, даже если ящик подключён.
      await world.idle(QUIET_MS);
      expect(withMark(world, DENIED, NOTICE_MARK)).toEqual([]);
      expect(world.employee(DENIED).messages(BOT_PRICES)).toEqual([]);

      // Уведомление агента не запускает: модель не вызывалась, файла и отметки в ящике нет.
      const modelCalls = stub.requests.length;
      await world.idle(QUIET_MS);
      expect(stub.requests).toHaveLength(modelCalls);
      expect(changeFiles(world)).toEqual([]);
      expect(mailboxes.processedIds(String(EMPLOYEE))).toEqual([]);
      await expectClean(world);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'скачки цен: прайс пишется без кнопки, файл изменений уходит сотруднику',
    async () => {
      await seedPrices(true);
      const { world, mailboxes } = await start();
      const employee = world.employee(EMPLOYEE);
      await untilNotice(world, mailboxes, { extras: false });

      // Скачки решения человека не требуют: разбор доходит до файла без вопроса и кнопок.
      await employee.say(BOT_PRICES, REQUEST_TEXT);
      await employee.waitText(BOT_PRICES, DONE_TEXT, { timeoutMs: TEST_TIMEOUT_MS });
      await world.idle(QUIET_MS);
      expect(stub.errors).toEqual([]);

      const files = changeFiles(world);
      expect(files).toHaveLength(1);
      expect(files[0]?.to).toBe(String(EMPLOYEE));
      await expectChangesWorkbook(files[0]?.bytes ?? new Uint8Array(), { jumpy: true });
      expect(withMark(world, RESPONSIBLE, CHANGES_MARK)).toEqual([]);
      expect(mailboxes.processedIds(String(EMPLOYEE))).toEqual(['m-trigger-1']);
      await expectClean(world);
    },
    TEST_TIMEOUT_MS,
  );
});
