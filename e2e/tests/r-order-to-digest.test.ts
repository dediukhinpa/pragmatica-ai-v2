import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import {
  FixedClock,
  MemoryEmployeeMailbox,
  MemoryMailboxDirectory,
  type PgClient,
} from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { ORDER_CALC_AGENT_ID, type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { loadSent, saveSent, type SentRecord } from '../../src/agents/order-calc/state';
import { requestTag } from '../../src/agents/order-calc/reply-routing';
import { addDays, localDateKey, localWeekday, startOfLocalDay } from '@business-ai/core';
import {
  BOT_ORDERS,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import {
  DIGEST_HEADLINE,
  DIGEST_STATUS_FOOTER,
  SHORTLIST_FILE_NAME,
  SHORTLIST_TITLE,
} from '../lib/employee';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { ORDER_CALC_MODEL, resetHandoffTables, settle, waitFor } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, toolResults, userTexts } from '@business-ai/testing/e2e';
import { BUYER_PII } from '../lib/pii.owned';
import { REAL_PERSON, REAL_PHONE, type PiiSet } from '@business-ai/testing/e2e';
import { advanceTo, beforeDigest, nextWorkday0900, waitFirstTick } from '../lib/time';

/**
 * Сценарий r-b: заявка -> шорт-лист -> выбор поставщика текстом -> текст запроса в чате
 * (агент письма не отправляет) -> сотрудник отправляет сам -> ответ поставщика -> сводка в 9:00
 * следующего рабочего дня. Всё на настоящем канале Bitrix24 (заглушка портала, бот orders),
 * Postgres, боевой сборкой, pseudonymizer и pii-guard; модель - скрипт, почта -
 * `MemoryMailboxDirectory`.
 *
 * Часы: `FixedClock` стартует от реального «сейчас», потому что сервис черновиков и сборка
 * записи об отправке используют `SystemClock` (время отправки письма - реальное). Прыжки
 * вперёд - не более недели (ретенция состояния 90 суток).
 */

const TIMEZONE = 'Europe/Moscow';
/** Пустой корень прайсов сценария (внутри рабочего каталога прогона, вне общих файлов). */
const EMPTY_PRICES_DIR = 'r-order-empty-prices';
const OWNER = 1001;
const OWNER_ID = String(OWNER);
/** Второй сотрудник: допущен к боту, у него свой ящик, но заявка и письма не его. */
const OTHER = 1002;
const OTHER_ID = String(OTHER);
const OWNER_NAME = { name: 'Евгения', lastName: 'Лаврентьева' };
const OTHER_NAME = { name: 'Тимофей', lastName: 'Охлопков' };
const OWNER_ADDRESS = 'lavrentieva.b@pragmatika-mail.test';
const OTHER_ADDRESS = 'ohlopkov.b@pragmatika-mail.test';

const SUPPLIER_A = 'sup-e2e-r-b-a';
const SUPPLIER_B = 'sup-e2e-r-b-b';
const NAME_A = 'ООО МеталлТорг Бета';
const NAME_B = 'ООО Арматурный Двор';
const EMAIL_A = 'sales@metalltorg-beta.test';
const EMAIL_B = 'info@armdvor-beta.test';

const ITEM = { name: 'Арматура А500С d12', quantity: 100, unit: 'м' };
const TASK_ID = 77;
const TASK_TITLE = 'Заказать арматуру';
const SUBJECT = 'Запрос на расчёт';
const REPLY_TEXT = 'Арматура А500С d12: 62 500 руб. за тонну, в наличии.';
const REPLY_ID = 'reply-e2e-r-b-1';

/** Реплики сотрудника: по ним скрипт модели понимает, что делать на первом шаге. */
const ASK_TEXT = 'Нужна арматура А500С d12, 100 м';
const ASK_TASK = 'Заявка в задаче';
const ASK_READ = 'Прочитай ответы по заявке';
/** Тексты кода (подстроки). */
const SENT_TEXT = 'Письмо отправлено (получателей: 1).';
const READY_FINAL = 'Текст запроса подготовлен, письмо отправит сотрудник.';
const NOT_SENT_NOTE = 'Письма я не отправляю';
/** Ответ менеджера на шорт-лист: «берём N» (номер подставляет тест). */
const ASK_PICK = 'Берём поставщика под номером';
const DIGEST_MARK = DIGEST_HEADLINE;
const BTN_SEND = 'Отправить';

const QUIET_MS = 1_500;
const TEST_TIMEOUT_MS = 300_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const TICK_MS = 15 * MS_PER_MINUTE;
const REPLY_AFTER_MS = MS_PER_MINUTE;
/** День недели «пятница» у `localWeekday` (0 - воскресенье). */
const FRIDAY = 5;
const FRIDAY_HOUR = 15;
const SATURDAY_REPLY_HOUR = 10;
const SUNDAY_NOON_HOUR = 12;
const RULES_NAME = 'r-order-to-digest';
const CURSOR_NAMESPACE = 'bitrix24-cursor.v1';
/** Сколько тиков подряд после сводки проверяем «без дублей». */
const REPEAT_TICKS = 2;

/** ПДн, которых не должно быть в запросах к модели, журналах, аудите и очереди. */
const PII: PiiSet = {
  names: [
    ...BUYER_PII.names,
    OWNER_NAME.lastName,
    OWNER_NAME.name,
    OTHER_NAME.lastName,
    OTHER_NAME.name,
  ],
  phones: [...BUYER_PII.phones],
  emails: [EMAIL_A, EMAIL_B, OWNER_ADDRESS, OTHER_ADDRESS],
};
const TYPED_TEXTS = [ASK_TEXT, ASK_TASK, REAL_PERSON, REAL_PHONE];

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
const worlds: BitrixWorld[] = [];

/** Что модель видит в хвосте запроса: результат инструмента или реплика человека. */
interface Tail {
  tool: string | null;
  result: unknown;
  human: string;
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
  const lastMessage: unknown = messages.at(-1);
  const blocks = blocksOf(lastMessage);
  for (const block of [...blocks].reverse()) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    let parsed: unknown = block['content'];
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // Строка не JSON: остаётся как есть.
      }
    }
    return { tool: names.get(String(block['tool_use_id'])) ?? '?', result: parsed, human: '' };
  }
  return { tool: null, result: null, human: userTexts(body).at(-1) ?? '' };
}

/** Поле результата инструмента из истории (последний вызов), строкой. */
function fieldOf(body: Record<string, unknown>, tool: string, field: string): string {
  const last = toolResults(body).get(tool)?.at(-1);
  const value = isRecord(last) ? last[field] : undefined;
  if (typeof value !== 'string') throw new Error(`в результате ${tool} нет поля ${field}`);
  return value;
}

/** Токен имени покупателя: настоящее имя модель не видит, в письме его восстановит код. */
function personToken(raw: string): string {
  const token = /\[PERSON_\d+\]/.exec(raw)?.[0];
  if (token === undefined) throw new Error('модель не увидела токен имени покупателя');
  return token;
}

/** Номер единственной заявки теста: берётся из базы (модель видит его не в исходном виде). */
async function requestIdFromDb(): Promise<string> {
  const rows = await db.query('SELECT id FROM purchase_requests');
  expect(rows).toHaveLength(1);
  return String(rows[0]?.['id']);
}

/**
 * Номер заявки из просьбы «Прочитай ответы по заявке <номер>»: модель видит то, что осталось
 * после обезличивания, и передаёт это в инструмент как есть (подстановку делает обёртка).
 */
function requestIdIn(text: string): string {
  const rest = text.slice(text.indexOf(ASK_READ) + ASK_READ.length).trim();
  const found = rest.split(/\s+/)[0];
  if (found === undefined || found === '') throw new Error(`в реплике нет номера заявки: ${text}`);
  return found;
}

/** Номер заявки, названный в реплике сразу после слова-маркера. */
function requestIdAfter(text: string, marker: string): string {
  const rest = text.slice(text.lastIndexOf(marker) + marker.length).trim();
  const found = rest.split(/\s+/)[0];
  if (found === undefined || found === '') throw new Error(`в реплике нет номера заявки: ${text}`);
  return found;
}

const script: DualHandler = ({ model, raw, body }) => {
  if (model !== ORDER_CALC_MODEL) throw new Error(`неизвестная модель ${model}`);
  const tail = tailOf(body);
  if (tail.tool === null) {
    const text = tail.human;
    if (text.includes(ASK_READ)) {
      return { kind: 'tool', name: 'readSupplierReplies', input: { requestId: requestIdIn(text) } };
    }
    if (text.includes(ASK_PICK)) {
      // Ответ менеджера текстом: номер из шорт-листа модель передаёт в инструмент как есть.
      const pick = /\d+/.exec(text.slice(text.indexOf(ASK_PICK)))?.[0];
      if (pick === undefined) throw new Error(`в реплике нет номера: ${text}`);
      return {
        kind: 'tool',
        name: 'recordManagerChoice',
        // Этап 164: смысл ответа определяет модель, инструмент требует decision.
        input: { requestId: requestIdAfter(text, 'заявка'), decision: 'picked', picks: [pick] },
      };
    }
    if (text.includes(ASK_TASK)) {
      const link = /https?:\/\/\S+/.exec(text)?.[0];
      if (link === undefined) throw new Error('в реплике нет ссылки на задачу');
      return { kind: 'tool', name: 'readIntakeSource', input: { link } };
    }
    if (text.includes(ASK_TEXT)) {
      return {
        kind: 'tool',
        name: 'saveIntakeRequest',
        input: { source: 'text', items: [ITEM] },
      };
    }
    return { kind: 'text', text: 'Принято.' };
  }
  // Ответ менеджера начинает новый ход: результата saveIntakeRequest в истории уже нет,
  // номер заявки берётся из его реплики (модель видит его после обезличивания).
  const requestId = (): string => {
    const pickText = userTexts(body).find((t) => t.includes(ASK_PICK));
    return pickText === undefined
      ? fieldOf(body, 'saveIntakeRequest', 'requestId')
      : requestIdAfter(pickText, 'заявка');
  };
  switch (tail.tool) {
    case 'readIntakeSource': {
      const asked = userTexts(body).find((t) => t.includes(ASK_TASK)) ?? '';
      const link = /https?:\/\/\S+/.exec(asked)?.[0];
      if (link === undefined) throw new Error('в реплике нет ссылки на задачу');
      return {
        kind: 'tool',
        name: 'saveIntakeRequest',
        input: { source: 'task', link, items: [ITEM] },
      };
    }
    case 'saveIntakeRequest':
      return { kind: 'tool', name: 'searchKnowledgeSuppliers', input: { requestId: requestId() } };
    case 'searchKnowledgeSuppliers':
      return { kind: 'tool', name: 'buildShortlist', input: { requestId: requestId() } };
    case 'buildShortlist':
      return {
        kind: 'tool',
        name: 'askManagerToChoose',
        input: { requestId: requestId(), version: fieldOf(body, 'buildShortlist', 'version') },
      };
    case 'askManagerToChoose':
      // Вопрос менеджеру задан, ход закончен: ответ менеджера придёт отдельным сообщением.
      return { kind: 'text', text: 'Жду выбор менеджера.' };
    case 'recordManagerChoice': {
      // Выбор записан кодом по тексту менеджера; без него дальше не идём.
      const status = isRecord(tail.result) ? tail.result['status'] : null;
      if (status !== 'recorded') {
        return { kind: 'text', text: `Выбор не записан: ${JSON.stringify(tail.result)}` };
      }
      return { kind: 'tool', name: 'recordSelection', input: { requestId: requestId() } };
    }
    case 'recordSelection':
      return {
        kind: 'tool',
        name: 'prepareSupplierRequestText',
        input: { requestId: requestId() },
      };
    case 'prepareSupplierRequestText':
      // Этап 179: ход заканчивает сам инструмент; этот шаг - страховка на случай продолжения.
      return { kind: 'text', text: READY_FINAL };
    case 'readSupplierReplies':
      return { kind: 'text', text: `Ответы: ${JSON.stringify(tail.result)}` };
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

/** Поставщики с прайсом на арматуру: оба попадут в шорт-лист, менеджер выберет одного. */
async function seedSuppliers(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  const prices = new PostgresPriceRepository(db);
  const rows: Array<[string, string, string, string, number]> = [
    [SUPPLIER_A, NAME_A, EMAIL_A, 'AR-B-001', 62_500],
    [SUPPLIER_B, NAME_B, EMAIL_B, 'AR-B-002', 63_100],
  ];
  for (const [id, name, email, sku, price] of rows) {
    await suppliers.upsert({ id, name, email });
    await prices.saveImport(
      id,
      [
        {
          supplierId: id,
          sku,
          productName: ITEM.name,
          price,
          currency: 'RUB',
          date: '2026-09-01',
        },
      ],
      `e2e-r-b-${id}`,
    );
  }
}

/** Мир с мониторингом, приёмом заявок из портала, ящиками и часами от реального «сейчас». */
async function start(): Promise<{ world: BitrixWorld; mailboxes: MemoryMailboxDirectory }> {
  // Проверка прайсов на диске в понедельник смотрит весь корень: общий корень e2e несёт файл без
  // даты в названии, а сообщение о нём ушло бы в тред менеджера, не пригодный для Bitrix24.
  // Сценарию про сводку по заказам нужен пустой корень.
  const emptyPricesRoot = `${e2eEnv().work}/${EMPTY_PRICES_DIR}`;
  await mkdir(emptyPricesRoot, { recursive: true });
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(OWNER_ID, OWNER_ADDRESS);
  mailboxes.connect(OTHER_ID, OTHER_ADDRESS);
  const world = await startBitrixWorld({
    rules,
    flags: { monitoring: true, intake: true },
    mailboxes,
    clock: new FixedClock(new Date()),
    env: { PRICES_FILES_ROOT: emptyPricesRoot },
  });
  worlds.push(world);
  world.portal.addUser({ id: OWNER, ...OWNER_NAME });
  world.portal.addUser({ id: OTHER, ...OTHER_NAME });
  await waitFirstTick(world);
  return { world, mailboxes };
}

/** Зависимости агента «Поиск поставщика (ИИ агент)» боевой сборки (репозиторий заявок и
 * состояние). */
function orderDeps(world: BitrixWorld): OrderCalcDeps {
  return world.app.agentDeps[ORDER_CALC_AGENT_ID] as OrderCalcDeps;
}

function clockOf(world: BitrixWorld): FixedClock {
  if (world.clock === undefined) throw new Error('мир запущен без FixedClock');
  return world.clock;
}

/** Сообщения бота «orders» в диалоге сотрудника, содержащие метку. */
function messagesWith(world: BitrixWorld, userId: number, mark: string): string[] {
  return world.employee(userId).texts(BOT_ORDERS).filter((text) => text.includes(mark));
}

/** Тексты сообщений бота с текстом запроса поставщику (в них есть строка «Кому:»). */
function requestTexts(world: BitrixWorld): string[] {
  return world
    .employee(OWNER)
    .texts(BOT_ORDERS)
    .filter((text) => text.includes('Кому:'));
}

/** Нет ли ошибок скрипта и утечек ПДн и секретов по всем поверхностям. */
async function expectClean(
  world: BitrixWorld,
  options: { allowEmptyLlm?: boolean } = {},
): Promise<void> {
  expect(stub.errors).toEqual([]);
  await expectNoLeaks({
    llm: stub.bodies(),
    allowEmptyLlm: options.allowEmptyLlm === true,
    logs: world.logs,
    portal: world.portal,
    db,
    pii: PII,
    workflowNamespaces: [CURSOR_NAMESPACE],
    forbiddenTexts: TYPED_TEXTS,
  });
}

/** Ящик сотрудника в памяти (адрес «от кого» проверяется по нему). */
async function boxOf(
  mailboxes: MemoryMailboxDirectory,
  userId: string,
): Promise<MemoryEmployeeMailbox> {
  const box = await mailboxes.forEmployee(userId);
  if (!(box instanceof MemoryEmployeeMailbox)) throw new Error('ящик не из памяти');
  return box;
}

/** Заявка принята и ушла в шорт-лист: менеджер отвечает текстом, кого берём (поставщик A). */
async function placeOrder(world: BitrixWorld, how: 'text' | 'task'): Promise<void> {
  const employee = world.employee(OWNER);
  const buyer = `Покупатель: ${REAL_PERSON}, ${REAL_PHONE}.`;
  if (how === 'text') {
    await employee.say(BOT_ORDERS, `${ASK_TEXT}. ${buyer}`);
  } else {
    world.portal.addTask({
      id: TASK_ID,
      title: TASK_TITLE,
      description: 'Нужна арматура для объекта',
    });
    world.portal.addChecklistItem(TASK_ID, {
      title: `${ITEM.name} - ${ITEM.quantity} ${ITEM.unit}`,
    });
    const link = `http://${world.portal.host}/company/personal/user/1/tasks/task/view/${TASK_ID}/`;
    await employee.say(BOT_ORDERS, `${ASK_TASK} ${link} ${buyer}`);
  }
  // Шорт-лист нумерованным текстом без кнопок; до ответа менеджера ничего не готовится.
  await employee.waitText(BOT_ORDERS, (text) => text.includes(SHORTLIST_TITLE));
  const shortlist = employee.shortlistText(BOT_ORDERS);
  // Этап 113: ушли карточки (вложение с GRID и разделителями) и файл Excel шорт-листа.
  const cardBlocks = employee.attachBlocks(BOT_ORDERS);
  expect(cardBlocks.some((block) => 'GRID' in block)).toBe(true);
  expect(cardBlocks.some((block) => 'DELIMITER' in block)).toBe(true);
  const xlsx = await employee.waitShortlistFile(BOT_ORDERS);
  expect(xlsx.name).toMatch(SHORTLIST_FILE_NAME);
  expect(new TextDecoder().decode(xlsx.bytes.slice(0, 2))).toBe('PK');
  expect(Object.keys(employee.lastButtons(BOT_ORDERS))).toEqual([]);
  expect(shortlist).toContain(NAME_A);
  expect(shortlist).toContain(NAME_B);
  // Шорт-лист показывает контакты поставщиков (коммит 8e3f8fc); адреса ушли не в модель.
  expect(shortlist).toContain(EMAIL_A);
  // Номер поставщика A берётся из самого шорт-листа («1. ООО ...»).
  const line = shortlist.split('\n').find((row) => row.includes(NAME_A)) ?? '';
  const number = /^\s*(\d+)[.)]/.exec(line)?.[1];
  if (number === undefined) throw new Error(`в шорт-листе нет номера поставщика A: ${shortlist}`);
  const requestId = await requestIdFromDb();
  await employee.say(BOT_ORDERS, `${ASK_PICK} ${number}, заявка ${requestId}`);
}

/**
 * Текст запроса показан в чате без кнопок, письма агент не отправляет; в учёте запись
 * «подготовлено». Возвращает номер заявки.
 */
async function showRequestText(
  world: BitrixWorld,
  mailboxes: MemoryMailboxDirectory,
): Promise<string> {
  const employee = world.employee(OWNER);
  // Этап 179: prepareSupplierRequestText заканчивает ход сам, итога модели (READY_FINAL) нет:
  // ждём то, что показал код, - текст письма с пометкой «Письма я не отправляю».
  await employee.waitText(BOT_ORDERS, (text) => text.includes(NOT_SENT_NOTE));
  await world.idle(QUIET_MS);
  const shown = requestTexts(world).at(-1) ?? '';
  const requestId = await requestIdFromDb();
  expect(shown).toContain(`Кому: ${EMAIL_A}`);
  expect(shown).not.toContain(EMAIL_B);
  expect(shown).toContain(`${SUBJECT}`);
  expect(shown).toContain(requestTag(requestId));
  expect(employee.texts(BOT_ORDERS).some((text) => text.includes(NOT_SENT_NOTE))).toBe(true);
  // Кнопок отправки нет, письма нет ни у кого, в учёте только «подготовлено».
  const labels = Object.keys(employee.lastButtons(BOT_ORDERS));
  for (const label of [BTN_SEND, 'Изменить', 'Отмена']) expect(labels).not.toContain(label);
  expect(mailboxes.sentBy(OWNER_ID)).toHaveLength(0);
  expect(mailboxes.sentBy(OTHER_ID)).toHaveLength(0);
  expect(mailboxes.sentCopies(OWNER_ID)).toHaveLength(0);
  const record = await loadSent({ state: world.app.workflowState }, requestId);
  expect(record?.state).toBe('prepared');
  expect(record?.mailboxOwnerId).toBe(OWNER_ID);
  // Выбран только поставщик A.
  expect(record?.supplierIds).toEqual([SUPPLIER_A]);
  expect((await boxOf(mailboxes, OWNER_ID)).address).toBe(OWNER_ADDRESS);
  return requestId;
}

/** Поставщик A отвечает на письмо, которое сотрудник отправил сам: метка заявки в теме. */
async function supplierReplies(
  world: BitrixWorld,
  mailboxes: MemoryMailboxDirectory,
  requestId: string,
  receivedAt: Date,
): Promise<void> {
  mailboxes.deliver(OWNER_ID, {
    id: REPLY_ID,
    from: EMAIL_A,
    subject: `Re: ${SUBJECT} ${requestTag(requestId)}`,
    body: REPLY_TEXT,
    receivedAt: receivedAt.toISOString(),
    attachments: [],
    senderAuth: 'verified',
  });
}

/** Второй сотрудник не видит ни заявку, ни письмо, ни ответ: чтение отказано кодом. */
async function expectOtherCannotRead(world: BitrixWorld, requestId: string): Promise<void> {
  const other = world.employee(OTHER);
  await other.say(BOT_ORDERS, `${ASK_READ} ${requestId}`);
  const answer = await other.waitText(BOT_ORDERS, (text) => text.startsWith('Ответы:'));
  expect(answer).not.toContain(REPLY_TEXT);
  expect(answer).not.toContain(EMAIL_A);
  expect(answer).not.toContain('"replies":[');
  expect(answer).toContain('access_denied');
  expectOtherDialogIsEmpty(world, requestId);
}

/** В диалоге второго сотрудника нет заявки, шорт-листа, черновика, письма и сводки. */
function expectOtherDialogIsEmpty(world: BitrixWorld, requestId: string): void {
  const other = world.employee(OTHER);
  for (const text of other.replies(BOT_ORDERS)) {
    expect(text).not.toContain(NAME_A);
    expect(text).not.toContain(NAME_B);
    expect(text).not.toContain(EMAIL_A);
    expect(text).not.toContain(REPLY_TEXT);
    expect(text).not.toContain(DIGEST_MARK);
    expect(text).not.toContain(SHORTLIST_TITLE);
    expect(text).not.toContain(SENT_TEXT);
    expect(text).not.toContain(OWNER_ADDRESS);
  }
  expect(other.lastButtons(BOT_ORDERS)).toEqual({});
  expect(other.files(BOT_ORDERS)).toEqual([]);
  // Номер заявки в чужом диалоге допустим только в самом отказе доступа, не в содержимом.
  const mentioning = other.messages(BOT_ORDERS).filter((m) => m.text.includes(requestId));
  for (const message of mentioning) expect(message.text).toContain('access_denied');
}

/** Сводка владельцу: одно сообщение с заявкой, названием поставщика и «ответил (почта …)». */
function expectDigest(world: BitrixWorld, requestId: string): string {
  const digests = messagesWith(world, OWNER, DIGEST_MARK);
  expect(digests).toHaveLength(1);
  const digest = digests[0] ?? '';
  // Сводка называет заявку по названию, внутренний id в ней не показывается (d3fa423f).
  expect(digest).not.toContain(requestId);
  expect(digest).toContain(`• ${ITEM.name}: подготовили запросы`);
  expect(digest).toContain(`${NAME_A}: ответил (почта`);
  expect(digest).not.toContain(NAME_B);
  // Формулировки ТЗ разд. 6: запросы подготовлены в чате, статус просят проверить.
  expect(digest.split('\n')[0]).toBe(DIGEST_HEADLINE);
  expect(digest).toContain('подготовили запросы');
  expect(digest).toContain(DIGEST_STATUS_FOOTER);
  expect(digest).not.toMatch(/ушли|отправили/);
  // Шаблон кода: ни адресов, ни имён сотрудников и покупателя.
  for (const needle of [EMAIL_A, OWNER_ADDRESS, OWNER_NAME.lastName, ...BUYER_PII.names]) {
    expect(digest).not.toContain(needle);
  }
  return digest;
}

/** Сводка 9:00 следующего рабочего дня: до 8:45 её нет, в 9:00 - одна, повторы не дублируют. */
async function expectDigestAtNextWorkday(world: BitrixWorld, requestId: string): Promise<void> {
  // Отсчёт от времени отправки письма (оно реальное), а не от часов теста: так сводка
  // «следующего рабочего дня» не зависит от перехода через полночь внутри прогона.
  const record = await loadSent({ state: world.app.workflowState }, requestId);
  if (record === null) throw new Error('нет записи об отправке');
  const target = nextWorkday0900(new Date(record.sentAt), TIMEZONE);
  const modelCalls = stub.requests.length;

  await advanceTo(world, beforeDigest(target));
  await world.idle(QUIET_MS);
  expect(messagesWith(world, OWNER, DIGEST_MARK)).toHaveLength(0);

  await advanceTo(world, target);
  await waitFor('сводка в диалоге владельца', () =>
    messagesWith(world, OWNER, DIGEST_MARK).length === 1,
  );
  const digest = expectDigest(world, requestId);

  // Повторные тики того же дня ничего не добавляют.
  for (let tick = 1; tick <= REPEAT_TICKS; tick += 1) {
    await advanceTo(world, new Date(target.getTime() + tick * TICK_MS));
  }
  await settle(QUIET_MS);
  expect(messagesWith(world, OWNER, DIGEST_MARK)).toHaveLength(1);
  const lastTick = world.logs.filter((line) => line.startsWith('monitoring_tick ')).at(-1) ?? '';
  expect(lastTick).toContain('"orders_digest":"already_done"');
  expect(lastTick).not.toContain(requestId);

  // Модель по расписанию не вызывалась; второй сотрудник сводку не получал.
  expect(stub.requests).toHaveLength(modelCalls);
  expect(world.employee(OTHER).texts(BOT_ORDERS).join('\n')).not.toContain(DIGEST_MARK);
  const otherDialog = world.portal.sent(BOT_ORDERS, OTHER_ID);
  expect(otherDialog.every((message) => !message.text.includes(requestId))).toBe(true);
}

/** Ближайшая пятница строго после даты `from`, `FRIDAY_HOUR`:00 по местному времени. */
function nextFriday(from: Date): Date {
  let day = addDays(localDateKey(from, TIMEZONE), 1);
  while (localWeekday(startOfLocalDay(day, TIMEZONE), TIMEZONE) !== FRIDAY) day = addDays(day, 1);
  return new Date(startOfLocalDay(day, TIMEZONE).getTime() + FRIDAY_HOUR * MS_PER_HOUR);
}

/** Момент `hour`:00 по местному времени на сутки `days` позже даты `base`. */
function localAt(base: Date, days: number, hour: number): Date {
  const day = addDays(localDateKey(base, TIMEZONE), days);
  return new Date(startOfLocalDay(day, TIMEZONE).getTime() + hour * MS_PER_HOUR);
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  const both = { users: [OWNER_ID, OTHER_ID] };
  rules = await writeBitrixRules(RULES_NAME, { [ORDER_CALC_AGENT_ID]: both });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
  await seedSuppliers();
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('r-b1: заявка из текста до сводки', () => {
  test(
    'текст -> шорт-лист -> выбор текстом -> черновик -> письмо -> ответ -> сводка в 9:00',
    async () => {
      const { world, mailboxes } = await start();
      await placeOrder(world, 'text');
      const requestId = await showRequestText(world, mailboxes);
      // Заявка из текста: позиции из реплики, сделки портала нет, к задачам не обращались.
      const request = await orderDeps(world).requests.get(requestId);
      expect(request?.items).toEqual([ITEM]);
      expect(request?.dealRef.startsWith('text-')).toBe(true);
      expect(world.portal.requestsOf('tasks.task.get')).toHaveLength(0);

      const replyAt = new Date(Date.now() + REPLY_AFTER_MS);
      await supplierReplies(world, mailboxes, requestId, replyAt);
      await expectOtherCannotRead(world, requestId);
      await expectDigestAtNextWorkday(world, requestId);
      await expectClean(world);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('r-b2: заявка из задачи портала', () => {
  test(
    'ссылка на задачу -> шорт-лист -> письмо -> ответ прочитан владельцем -> сводка в 9:00',
    async () => {
      const { world, mailboxes } = await start();
      await placeOrder(world, 'task');
      const requestId = await showRequestText(world, mailboxes);
      // Заявка записана по задаче: задача перечитана с портала, сделки нет.
      const request = await orderDeps(world).requests.get(requestId);
      expect(request?.items).toEqual([ITEM]);
      expect(request?.dealRef).toBe(`task-${TASK_ID}`);
      expect(world.portal.requestsOf('tasks.task.get').length).toBeGreaterThan(0);

      const replyAt = new Date(Date.now() + REPLY_AFTER_MS);
      await supplierReplies(world, mailboxes, requestId, replyAt);
      // Владелец читает ответ сам: виден ему, не виден второму сотруднику.
      const owner = world.employee(OWNER);
      await owner.say(BOT_ORDERS, `${ASK_READ} ${requestId}`);
      const answer = await owner.waitText(BOT_ORDERS, (text) => text.startsWith('Ответы:'));
      expect(answer).toContain(REPLY_TEXT);
      expect(answer).toContain(SUPPLIER_A);
      expect(mailboxes.processedIds(OWNER_ID)).toEqual([REPLY_ID]);
      expect(mailboxes.processedIds(OTHER_ID)).toEqual([]);
      await expectOtherCannotRead(world, requestId);
      await expectDigestAtNextWorkday(world, requestId);
      await expectClean(world);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('r-b3: письмо в пятницу', () => {
  test(
    'сводка в понедельник в 9:00, не в субботу и не в воскресенье',
    async () => {
      const { world, mailboxes } = await start();
      await placeOrder(world, 'text');
      const requestId = await showRequestText(world, mailboxes);

      // Сервис черновиков пишет реальное «сейчас», поэтому время отправки в записи переносится
      // на пятницу 15:00; часы теста переводятся туда же (раньше - ни одной проверки).
      const clock = clockOf(world);
      const friday = nextFriday(clock.now());
      const deps = { state: world.app.workflowState };
      const record = await loadSent(deps, requestId);
      if (record === null) throw new Error('нет записи об отправке');
      const moved: SentRecord = {
        ...record,
        sentAt: friday.toISOString(),
        sentBySupplier: { [SUPPLIER_A]: friday.toISOString() },
      };
      await saveSent(deps, moved);
      await supplierReplies(world, mailboxes, requestId, localAt(friday, 1, SATURDAY_REPLY_HOUR));

      await advanceTo(world, friday);
      const saturday = localAt(friday, 1, SATURDAY_REPLY_HOUR);
      await advanceTo(world, saturday);
      await world.idle(QUIET_MS);
      expect(messagesWith(world, OWNER, DIGEST_MARK)).toHaveLength(0);
      await advanceTo(world, localAt(friday, 2, SUNDAY_NOON_HOUR));
      await world.idle(QUIET_MS);
      expect(messagesWith(world, OWNER, DIGEST_MARK)).toHaveLength(0);

      const monday = nextWorkday0900(localAt(friday, 2, SUNDAY_NOON_HOUR), TIMEZONE);
      expect(localWeekday(monday, TIMEZONE)).toBe(1);
      await advanceTo(world, beforeDigest(monday));
      await world.idle(QUIET_MS);
      expect(messagesWith(world, OWNER, DIGEST_MARK)).toHaveLength(0);
      await advanceTo(world, monday);
      await waitFor('сводка в понедельник', () =>
        messagesWith(world, OWNER, DIGEST_MARK).length === 1,
      );
      const digest = expectDigest(world, requestId);
      await advanceTo(world, new Date(monday.getTime() + TICK_MS));
      await settle(QUIET_MS);
      expect(messagesWith(world, OWNER, DIGEST_MARK)).toHaveLength(1);
      await expectClean(world);
    },
    TEST_TIMEOUT_MS,
  );
});
