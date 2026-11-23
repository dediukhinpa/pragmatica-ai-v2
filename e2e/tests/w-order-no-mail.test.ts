import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { FixedClock, type PgClient } from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import { loadReplies } from '../../src/agents/order-calc/reply-store';
import { loadSent } from '../../src/agents/order-calc/state';
import {
  BOT_ORDERS,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DIGEST_HEADLINE, DIGEST_STATUS_FOOTER, SHORTLIST_TITLE } from '../lib/employee';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { ORDER_CALC_MODEL, resetHandoffTables, waitFor } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, toolResults, userTexts } from '@business-ai/testing/e2e';
import { BUYER_PII } from '../lib/pii.owned';
import { REAL_PERSON, REAL_PHONE, type PiiSet } from '@business-ai/testing/e2e';
import { advanceTo, beforeDigest, nextWorkday0900, waitFirstTick } from '../lib/time';

/**
 * Сценарий w1 (этап 105, тема 3): заказ без почты. Боевая сборка на заглушке портала Bitrix24 БЕЗ
 * ящиков сотрудников (`mailboxes` не передаются): заявка -> шорт-лист -> выбор двух поставщиков
 * -> тексты запросов -> ответ поставщика А по телефону (`recordSupplierReply`: показ, «да»,
 * запись) -> КП по этому ответу -> статус заказа (`orderStatus`) -> сравнение и сводка КП ->
 * утренняя сводка по заказам в 9:00. Модель - скрипт, pseudonymizer и pii-guard настоящие.
 */

const TIMEZONE = 'Europe/Moscow';
const EMPTY_PRICES_DIR = 'w-order-empty-prices';
const OWNER = 1001;
const OWNER_ID = String(OWNER);
const OWNER_NAME = { name: 'Дарья', lastName: 'Мельникова' };
const RULES_NAME = 'w-order-no-mail';

const SUPPLIER_A = 'sup-e2e-w-a';
const SUPPLIER_B = 'sup-e2e-w-b';
const NAME_A = 'ООО МеталлТорг Омега';
const NAME_B = 'ООО Арматурный Двор Омега';
const EMAIL_A = 'sales@metalltorg-omega.test';
const EMAIL_B = 'info@armdvor-omega.test';
const ITEM = { name: 'Арматура А500С d12', quantity: 100, unit: 'м' };
const PHONE_SUMMARY = 'Арматура в наличии, цена шестьдесят две тысячи за тонну, срок три дня';
const UNIT_PRICE = 62;

/** Реплики сотрудника: по подстрокам скрипт понимает, что делать на первом шаге хода. */
const ASK_TEXT = 'Нужна арматура А500С d12, 100 м';
const ASK_PICK = 'Берём поставщиков под номерами';
const ASK_PHONE = 'Поставщик А ответил по телефону';
const ASK_YES = 'да, записывай';
const ASK_QUOTE = 'Запиши КП по ответу';
const ASK_STATUS = 'Покажи статус заказа';
const ASK_SUMMARY = 'Сравни КП и отправь сводку';

/** Тексты скрипта «модели» - по ним тест ждёт конца хода. */
const NOT_SENT_NOTE = 'Письма я не отправляю';
const READY_FINAL = 'Тексты запросов подготовлены.';
const PHONE_SHOWN = 'Запись ответа показана.';
const PHONE_DONE = 'Ответ записан.';
const QUOTE_DONE = 'КП записано.';
const STATUS_DONE = 'Статус показан.';
const SUMMARY_DONE = 'Сводка отправлена.';
const DIGEST_MARK = DIGEST_HEADLINE;

const QUIET_MS = 1_500;
const TEST_TIMEOUT_MS = 300_000;
const NO_MAILBOX_NOTE = 'Почта не подключена';

const PII: PiiSet = {
  names: [...BUYER_PII.names, OWNER_NAME.lastName, OWNER_NAME.name],
  phones: [...BUYER_PII.phones],
  emails: [EMAIL_A, EMAIL_B],
};
const TYPED_TEXTS = [ASK_TEXT, REAL_PERSON, REAL_PHONE];

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
const worlds: BitrixWorld[] = [];
/** Идентификатор записанного ответа по телефону: скрипт передаёт его в recordQuote. */
let phoneReplyId = '';

interface Tail {
  tool: string | null;
  result: unknown;
  human: string;
}

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
  for (const block of [...blocksOf(messages.at(-1))].reverse()) {
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

function fieldOf(body: Record<string, unknown>, tool: string, field: string): string {
  const last = toolResults(body).get(tool)?.at(-1);
  const value = isRecord(last) ? last[field] : undefined;
  if (typeof value !== 'string') throw new Error(`в результате ${tool} нет поля ${field}`);
  return value;
}

/** Номер заявки, названный в реплике после слова «заявка». */
function requestIdIn(text: string): string {
  const found = text.slice(text.lastIndexOf('заявка') + 'заявка'.length).trim().split(/\s+/)[0];
  if (found === undefined || found === '') throw new Error(`в реплике нет номера заявки: ${text}`);
  return found;
}

/** Номер заявки из последней реплики, где он назван (ходы диалога независимы). */
function requestIdOf(body: Record<string, unknown>): string {
  const texts = userTexts(body).filter((text) => text.includes('заявка'));
  const last = texts.at(-1);
  if (last !== undefined) return requestIdIn(last);
  return fieldOf(body, 'saveIntakeRequest', 'requestId');
}

const phoneFields = (body: Record<string, unknown>): Record<string, unknown> => ({
  requestId: requestIdOf(body),
  supplierId: SUPPLIER_A,
  channel: 'phone',
  summary: PHONE_SUMMARY,
});

const script: DualHandler = ({ model, body }) => {
  if (model !== ORDER_CALC_MODEL) throw new Error(`неизвестная модель ${model}`);
  const tail = tailOf(body);
  if (tail.tool === null) {
    const text = tail.human;
    if (text.includes(ASK_PICK)) {
      const numbers = (text.slice(text.indexOf(ASK_PICK)).split(', заявка')[0] ?? '').match(/\d+/g);
      return {
        kind: 'tool',
        name: 'recordManagerChoice',
        // Этап 164: смысл ответа определяет модель, инструмент требует decision.
        input: { requestId: requestIdIn(text), decision: 'picked', picks: numbers ?? [] },
      };
    }
    if (text.includes(ASK_PHONE)) {
      return { kind: 'tool', name: 'recordSupplierReply', input: phoneFields(body) };
    }
    if (text.includes(ASK_YES)) {
      return {
        kind: 'tool',
        name: 'recordSupplierReply',
        input: { ...phoneFields(body), confirmed: true },
      };
    }
    if (text.includes(ASK_QUOTE)) {
      return {
        kind: 'tool',
        name: 'recordQuote',
        input: {
          requestId: requestIdOf(body),
          supplierId: SUPPLIER_A,
          sourceRef: phoneReplyId,
          currency: 'RUB',
          lines: [
            { productName: ITEM.name, unitPrice: UNIT_PRICE, quantity: ITEM.quantity, unit: 't' },
          ],
        },
      };
    }
    if (text.includes(ASK_STATUS)) {
      return { kind: 'tool', name: 'orderStatus', input: { requestId: requestIdOf(body) } };
    }
    if (text.includes(ASK_SUMMARY)) {
      return { kind: 'tool', name: 'compareQuotes', input: { requestId: requestIdOf(body) } };
    }
    if (text.includes(ASK_TEXT)) {
      return { kind: 'tool', name: 'saveIntakeRequest', input: { source: 'text', items: [ITEM] } };
    }
    return { kind: 'text', text: 'Принято.' };
  }
  const requestId = (): string => requestIdOf(body);
  switch (tail.tool) {
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
      return { kind: 'text', text: 'Жду выбор менеджера.' };
    case 'recordManagerChoice':
      return { kind: 'tool', name: 'recordSelection', input: { requestId: requestId() } };
    case 'recordSelection':
      return { kind: 'tool', name: 'prepareSupplierRequestText', input: { requestId: requestId() } };
    case 'prepareSupplierRequestText':
      // Этап 179: ход заканчивает сам инструмент; этот шаг - страховка на случай продолжения.
      return { kind: 'text', text: READY_FINAL };
    case 'recordSupplierReply': {
      const status = isRecord(tail.result) ? tail.result['status'] : null;
      return { kind: 'text', text: status === 'recorded' ? PHONE_DONE : PHONE_SHOWN };
    }
    case 'recordQuote':
      return { kind: 'text', text: QUOTE_DONE };
    case 'orderStatus':
      return { kind: 'text', text: STATUS_DONE };
    case 'compareQuotes':
      return {
        kind: 'tool',
        name: 'sendQuoteSummary',
        input: { requestId: requestId(), quotesHash: fieldOf(body, 'compareQuotes', 'quotesHash') },
      };
    case 'sendQuoteSummary':
      return { kind: 'text', text: SUMMARY_DONE };
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

async function seedSuppliers(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  const prices = new PostgresPriceRepository(db);
  const rows: Array<[string, string, string, string, number]> = [
    [SUPPLIER_A, NAME_A, EMAIL_A, 'AR-W-001', 62_500],
    [SUPPLIER_B, NAME_B, EMAIL_B, 'AR-W-002', 63_100],
  ];
  for (const [id, name, email, sku, price] of rows) {
    await suppliers.upsert({ id, name, email });
    await prices.saveImport(
      id,
      [{ supplierId: id, sku, productName: ITEM.name, price, currency: 'RUB', date: '2026-09-01' }],
      `e2e-w-${id}`,
    );
  }
}

/** Мир БЕЗ ящиков: мониторинг и приём заявок включены, почты у агента нет. */
async function start(): Promise<BitrixWorld> {
  const emptyPricesRoot = `${e2eEnv().work}/${EMPTY_PRICES_DIR}`;
  await mkdir(emptyPricesRoot, { recursive: true });
  const world = await startBitrixWorld({
    rules,
    flags: { monitoring: true, intake: true },
    clock: new FixedClock(new Date()),
    env: { PRICES_FILES_ROOT: emptyPricesRoot },
  });
  worlds.push(world);
  world.portal.addUser({ id: OWNER, ...OWNER_NAME });
  await waitFirstTick(world);
  return world;
}

function messagesWith(world: BitrixWorld, mark: string): string[] {
  return world.employee(OWNER).texts(BOT_ORDERS).filter((text) => text.includes(mark));
}

async function requestIdFromDb(): Promise<string> {
  const rows = await db.query('SELECT id FROM purchase_requests');
  expect(rows).toHaveLength(1);
  return String(rows[0]?.['id']);
}

/** Реплика сотрудника и ожидание финальной фразы модели этого хода. */
async function turn(world: BitrixWorld, text: string, done: string): Promise<void> {
  const employee = world.employee(OWNER);
  const before = employee.texts(BOT_ORDERS).filter((t) => t === done).length;
  await employee.say(BOT_ORDERS, text);
  await waitFor(`ответ «${done}»`, () =>
    employee.texts(BOT_ORDERS).filter((t) => t === done).length > before,
  );
}

/** Заявка, шорт-лист, выбор обоих поставщиков, тексты запросов. Возвращает номер заявки. */
async function placeOrderOfTwo(world: BitrixWorld): Promise<string> {
  const employee = world.employee(OWNER);
  await employee.say(BOT_ORDERS, `${ASK_TEXT}. Покупатель: ${REAL_PERSON}, ${REAL_PHONE}.`);
  await employee.waitText(BOT_ORDERS, (text) => text.includes(SHORTLIST_TITLE));
  const shortlist = employee.shortlistText(BOT_ORDERS);
  const numberOf = (name: string): string => {
    const line = shortlist.split('\n').find((row) => row.includes(name)) ?? '';
    const found = /^\s*(\d+)[.)]/.exec(line)?.[1];
    if (found === undefined) throw new Error(`в шорт-листе нет номера «${name}»: ${shortlist}`);
    return found;
  };
  const requestId = await requestIdFromDb();
  await employee.say(
    BOT_ORDERS,
    `${ASK_PICK} ${numberOf(NAME_A)} и ${numberOf(NAME_B)}, заявка ${requestId}`,
  );
  // Этап 179: prepareSupplierRequestText заканчивает ход сам, итога модели (READY_FINAL) нет:
  // ждём то, что показал код, - тексты запросов обоим поставщикам и пометку «письма не шлю».
  await waitFor('тексты запросов обоим поставщикам', () => {
    const shown = employee.texts(BOT_ORDERS);
    const notSent = shown.some((text) => text.includes(NOT_SENT_NOTE));
    const shownTo = (mail: string): boolean => shown.some((t) => t.includes(`Кому: ${mail}`));
    return notSent && shownTo(EMAIL_A) && shownTo(EMAIL_B);
  });
  await world.idle(QUIET_MS);
  return requestId;
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeBitrixRules(RULES_NAME, { [ORDER_CALC_AGENT_ID]: { users: [OWNER_ID] } });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
  phoneReplyId = '';
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

describe('w1: заказ без почты', () => {
  test(
    'ответ по телефону -> КП -> статус -> сводка КП -> утренняя сводка по заказам',
    async () => {
      const world = await start();
      const requestId = await placeOrderOfTwo(world);
      const deps = { state: world.app.workflowState };
      // Запросы только подготовлены (письма агент не шлёт), ящиков у сотрудника нет.
      expect((await loadSent(deps, requestId))?.state).toBe('prepared');

      // Статус до ответа: оба поставщика без ответа, чего не хватает - названо кодом.
      await turn(world, `${ASK_STATUS}, заявка ${requestId}`, STATUS_DONE);
      const before = messagesWith(world, 'Статус заказа').at(-1) ?? '';
      expect(before).toContain(`${NAME_A}: запрос подготовлен`);
      expect(before).toContain('ответа нет');
      expect(before).toContain('КП не записано');

      // Ответ по телефону: показ без записи, затем «да» отдельной репликой.
      await turn(world, `${ASK_PHONE}, заявка ${requestId}`, PHONE_SHOWN);
      expect(await loadReplies(world.app.workflowState, requestId)).toEqual([]);
      const shown = messagesWith(world, 'по телефону').at(-1) ?? '';
      expect(shown).toContain(NAME_A);
      expect(shown).toContain(PHONE_SUMMARY);
      await turn(world, `${ASK_YES}, заявка ${requestId}`, PHONE_DONE);
      const replies = await loadReplies(world.app.workflowState, requestId);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        channel: 'phone',
        supplierId: SUPPLIER_A,
        recordedBy: OWNER_ID,
      });
      phoneReplyId = replies[0]?.id ?? '';

      // КП принимает replyId телефонного ответа как источник.
      await turn(world, `${ASK_QUOTE}, заявка ${requestId}`, QUOTE_DONE);

      // Статус после: А ответил по телефону и КП записано, Б по-прежнему без ответа.
      await turn(world, `${ASK_STATUS}, заявка ${requestId}`, STATUS_DONE);
      const after = messagesWith(world, 'Статус заказа').at(-1) ?? '';
      expect(after).toContain(`${NAME_A}: запрос подготовлен`);
      expect(after).toContain('ответил (телефон');
      expect(after).toContain('КП записано');
      expect(after).toContain(`${NAME_B}: запрос подготовлен`);
      expect(after.split('\n').find((row) => row.includes(NAME_B))).toContain('ответа нет');

      // Сводка КП: ответивший по телефону учтён, неответивший назван.
      await turn(world, `${ASK_SUMMARY}, заявка ${requestId}`, SUMMARY_DONE);
      const texts = world.employee(OWNER).texts(BOT_ORDERS).join('\n');
      expect(texts).toContain(`Ответили (1 из 2): ${NAME_A}`);
      expect(texts).toContain(`Не ответили: ${NAME_B}`);

      // Утренняя сводка в 9:00 следующего рабочего дня уходит без почты.
      const sent = await loadSent(deps, requestId);
      if (sent === null) throw new Error('нет записи об отправке');
      const target = nextWorkday0900(new Date(sent.sentAt), TIMEZONE);
      await advanceTo(world, beforeDigest(target));
      await world.idle(QUIET_MS);
      expect(messagesWith(world, DIGEST_MARK)).toHaveLength(0);
      await advanceTo(world, target);
      await waitFor('утренняя сводка', () => messagesWith(world, DIGEST_MARK).length === 1);
      const digest = messagesWith(world, DIGEST_MARK)[0] ?? '';
      // Заявка названа по названию, id в сводке нет (d3fa423f).
      expect(digest).not.toContain(requestId);
      expect(digest).toContain(`${NAME_A}: ответил (телефон`);
      expect(digest).toContain('КП записано');
      expect(digest).toContain(`${NAME_B}: нет ответа`);
      expect(digest).toContain(NO_MAILBOX_NOTE);
      expect(digest).toContain(DIGEST_STATUS_FOOTER);
      for (const needle of [EMAIL_A, EMAIL_B, OWNER_NAME.lastName, ...BUYER_PII.names]) {
        expect(digest).not.toContain(needle);
      }

      expect(stub.errors).toEqual([]);
      await expectNoLeaks({
        llm: stub.bodies(),
        allowEmptyLlm: false,
        logs: world.logs,
        portal: world.portal,
        db,
        pii: PII,
        workflowNamespaces: [],
        forbiddenTexts: TYPED_TEXTS,
      });
    },
    TEST_TIMEOUT_MS,
  );
});
