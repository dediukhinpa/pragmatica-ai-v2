import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { type PgClient } from '@business-ai/adapters';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import { createAutoSupplierCard } from '../../src/agents/suppliers/draft-card';
import { loadSent } from '../../src/agents/order-calc/state';
import {
  BOT_ORDERS,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { SHORTLIST_FILE_NAME } from '../lib/employee';
import { ORDER_CALC_MODEL, resetHandoffTables } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, toolResults, userTexts } from '@business-ai/testing/e2e';
import type { PiiSet } from '@business-ai/testing/e2e';

/**
 * Сценарий x1 (этап 105, тема 2): карточки-черновики в шорт-листе. Боевая сборка на заглушке
 * портала Bitrix24 с `SUPPLIER_CARDS_ENABLED`; в базе настоящий поставщик и два черновика
 * (один с телефоном, второй без контактов). В шорт-листе пометок черновика нет (решение
 * владельца 28.10); пометки «не проверено» нет нигде (этап 240: черновиков нет), а запрос к
 * карточке без контактов готовится с пометкой «адрес не найден».
 */

const USER = 1001;
const USER_NAME = { name: 'Эльвира', lastName: 'Зайцева' };
const RULES_NAME = 'x-shortlist-draft';
const ITEM = { name: 'Квазарит Х7', quantity: 40, unit: 'шт' };
const REAL_ID = 'sup-e2e-x-real';
const REAL_NAME = 'ООО Квазар Настоящий';
const REAL_EMAIL = 'sales@kvazar-real.test';
const DRAFT_PHONE_NAME = 'ООО Квазар Черновик Телефон';
const DRAFT_BARE_NAME = 'ООО Квазар Черновик Пустой';
const DRAFT_PHONE = '+7 (921) 600-11-22';
const PRICE_DATE = '2026-09-01';

const ASK_TEXT = 'Нужен квазарит Х7, 40 шт';
const ASK_PICK = 'Берём поставщика под номером';
/**
 * Этап 179: askManagerToChoose заканчивает ход сам (endsTurn), итога модели нет. Ждём то, что
 * показал код: вопрос менеджеру «Кому готовить запросы?».
 */
const SHOWN = 'Кому готовить запросы?';
const NOT_PREPARED = 'Запрос не подготовлен';
const NO_CONTACTS_TEXT = 'нет контактов: дополните карточку, чтобы отправить запрос';
const NO_ADDRESS_TEXT = 'Кому: адрес не найден, уточните контакт';
const DRAFT_MARK = 'не проверено, создана автоматически';
const QUIET_MS = 1_500;
const TEST_TIMEOUT_MS = 300_000;

const PII: PiiSet = { names: [USER_NAME.name, USER_NAME.lastName], phones: [], emails: [] };

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
const worlds: BitrixWorld[] = [];

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
  if (typeof value !== 'string') throw new Error(`в результате ${tool} нет поля ${field}: ${JSON.stringify(last)}`);
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


const script: DualHandler = ({ model, body }) => {
  if (model !== ORDER_CALC_MODEL) throw new Error(`неизвестная модель ${model}`);
  const tail = tailOf(body);
  if (tail.tool === null) {
    const text = tail.human;
    if (text.includes(ASK_PICK)) {
      const pick = /\d+/.exec(text.slice(text.indexOf(ASK_PICK)))?.[0];
      return {
        kind: 'tool',
        name: 'recordManagerChoice',
        // Этап 164: смысл ответа определяет модель, инструмент требует decision.
        input: { requestId: requestIdIn(text), decision: 'picked', picks: [pick ?? ''] },
      };
    }
    return { kind: 'tool', name: 'saveIntakeRequest', input: { source: 'text', items: [ITEM] } };
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
      // Этап 179: ход заканчивает сам инструмент, до этого шага модель не доходит.
      return { kind: 'text', text: 'Шорт-лист показан.' };
    case 'recordManagerChoice':
      return { kind: 'tool', name: 'recordSelection', input: { requestId: requestId() } };
    case 'recordSelection':
      return { kind: 'tool', name: 'prepareSupplierRequestText', input: { requestId: requestId() } };
    case 'prepareSupplierRequestText':
      return { kind: 'text', text: `Результат запроса: ${JSON.stringify(tail.result)}` };
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

/** Настоящий поставщик и два черновика с ценой на позицию заявки. */
async function seedSuppliers(): Promise<void> {
  const suppliers = new PostgresSupplierRepository(db);
  const prices = new PostgresPriceRepository(db);
  await suppliers.upsert({ id: REAL_ID, name: REAL_NAME, email: REAL_EMAIL });
  const ids = [REAL_ID];
  for (const input of [{ name: DRAFT_PHONE_NAME, phone: DRAFT_PHONE }, { name: DRAFT_BARE_NAME }]) {
    const { card } = await createAutoSupplierCard(suppliers, input, {
      userId: 'price-agent',
      nowIso: PRICE_DATE,
      origin: 'прайс.xlsx',
    });
    ids.push(card.id);
  }
  for (const id of ids) {
    await prices.saveImport(
      id,
      [{ supplierId: id, productName: ITEM.name, price: 100, currency: 'RUB', date: PRICE_DATE }],
      `e2e-x-${id}`,
    );
  }
}

/** Строки поставщика в шорт-листе: от «Поставщик: <название>» до следующего пункта. */
function blockOf(shortlist: string, title: string): string {
  const lines = shortlist.split('\n');
  const at = lines.findIndex((line) => line.includes(`Поставщик: ${title}`));
  if (at < 0) throw new Error(`в шорт-листе нет поставщика «${title}»`);
  const next = lines.findIndex((line, index) => index > at && line.includes('Поставщик: '));
  return lines.slice(at, next < 0 ? undefined : next).join('\n');
}

async function start(): Promise<BitrixWorld> {
  const world = await startBitrixWorld({ rules, flags: { supplierCards: true, intake: true } });
  worlds.push(world);
  world.portal.addUser({ id: USER, ...USER_NAME });
  return world;
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeBitrixRules(RULES_NAME, { [ORDER_CALC_AGENT_ID]: { users: [String(USER)] } });
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

describe('x1: черновики в шорт-листе', () => {
  test(
    'в шорт-листе карточки без пометок; запрос к карточке без контактов готовится с «адрес не найден»',
    async () => {
      const world = await start();
      const employee = world.employee(USER);
      await employee.say(BOT_ORDERS, ASK_TEXT);
      await employee.waitText(BOT_ORDERS, SHOWN);
      const shortlist = employee.shortlistText(BOT_ORDERS);
      // Этап 113: ушли карточки (вложение с GRID и разделителями) и файл Excel шорт-листа.
      const cardBlocks = employee.attachBlocks(BOT_ORDERS);
      expect(cardBlocks.some((block) => 'GRID' in block)).toBe(true);
      expect(cardBlocks.some((block) => 'DELIMITER' in block)).toBe(true);
      const xlsx = await employee.waitShortlistFile(BOT_ORDERS);
      expect(xlsx.name).toMatch(SHORTLIST_FILE_NAME);
      expect(new TextDecoder().decode(xlsx.bytes.slice(0, 2))).toBe('PK');

      // Решение владельца 28.10 (коммит 863768af): в шорт-листе нет ни пометки «не проверено»,
      // ни «нет контактов» ни у одной карточки; пометка живёт только в тексте запроса поставщику.
      for (const name of [REAL_NAME, DRAFT_PHONE_NAME, DRAFT_BARE_NAME]) {
        const block = blockOf(shortlist, name);
        expect(block).not.toContain(DRAFT_MARK);
        expect(block).not.toContain(NO_CONTACTS_TEXT);
      }

      // Менеджер выбирает карточку без контактов: текст запроса готовится и без контакта (шаблон
      // контактов не требует), адрес не назван. Пометки черновика в тексте запроса больше нет:
      // все карточки сразу боевые (78052fb4, миграция 042).
      const line = shortlist.split('\n').find((row) => row.includes(DRAFT_BARE_NAME)) ?? '';
      const number = /^\s*(\d+)[.)]/.exec(line)?.[1];
      if (number === undefined) throw new Error(`в шорт-листе нет номера черновика: ${shortlist}`);
      const requestId = String((await db.query('SELECT id FROM purchase_requests'))[0]?.['id']);
      await employee.say(BOT_ORDERS, `${ASK_PICK} ${number}, заявка ${requestId}`);
      // Этап 179: prepareSupplierRequestText заканчивает ход сам, итога модели («Результат
      // запроса: ...» с withoutContact) нет: ждём текст запроса, который показал код, а
      // «запрос подготовлен без контакта» проверяем по тексту («адрес не найден») и по учёту.
      await employee.waitText(BOT_ORDERS, (text) => text.includes(`Поставщик: ${DRAFT_BARE_NAME}`));
      await world.idle(QUIET_MS);
      expect(employee.texts(BOT_ORDERS).some((text) => text.includes(NOT_PREPARED))).toBe(false);
      const record = await loadSent({ state: world.app.workflowState }, requestId);
      expect(record?.state).toBe('prepared');
      const requestText = employee
        .messages(BOT_ORDERS)
        .map((message) => message.text)
        .find(
          (text) =>
            text.includes(`Поставщик: ${DRAFT_BARE_NAME}`) && text.includes(NO_ADDRESS_TEXT),
        );
      expect(requestText).toBeDefined();
      expect(requestText).not.toContain(DRAFT_MARK);

      expect(stub.errors).toEqual([]);
      await expectNoLeaks({
        llm: stub.bodies(),
        allowEmptyLlm: false,
        logs: world.logs,
        portal: world.portal,
        db,
        pii: PII,
        workflowNamespaces: [],
        forbiddenTexts: [],
      });
    },
    TEST_TIMEOUT_MS,
  );
});
