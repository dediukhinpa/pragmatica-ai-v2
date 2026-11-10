import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import {
  MemoryChatChannel,
  MemoryDepartmentHeads,
  SystemClock,
  SystemIdGenerator,
  type PgClient,
} from '@business-ai/adapters';
import { PostgresSupplierRepository } from '../../src/kit/adapters/postgres/supplier-repository';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { createService, type ProductionApp, type Service } from '@business-ai/core/compose';
import { DualLlmStub, firstToken, stepInTurn, type DualHandler } from '@business-ai/testing/e2e';
import { buildApp, e2eEnv, openDb } from '../lib/project-env';
import {
  E2E_SHUTDOWN_MS,
  E2E_WORKER_INTERVAL_MS,
  resetHandoffTables,
  settle,
  textsTo,
  waitFor,
} from '../lib/handoff-core';
import { blocksOf, isRecord, userTexts } from '@business-ai/testing/e2e';
import { breakInn, makeInn, supplierTemplatePath } from '../lib/supplier-xlsx';

/**
 * Сценарий r-s: «добавь поставщика ООО Ромашка ИНН ...» при умолчании
 * `PSEUDONYMIZER_MASK_LEGAL_ENTITY=false` на ОБЩЕМ настоящем сервисе прогона и настоящем
 * pii-guard перед заглушкой модели (этап 55). Числовые реквизиты маскируются всегда:
 *  - модель видит токен `[INN_n]`, настоящего ИНН в телах запросов нет;
 *  - инструмент карточки получает настоящий ИНН, контрольная сумма проверена;
 *  - в ответе сотруднику настоящий ИНН, pii-guard запрос не отклоняет;
 *  - результаты инструментов отдают ИНН строкой (последние четыре цифры), числом - нигде;
 *  - название организации при `false` уходит модели открытым.
 */

const USER_A = 'emp-e2e-rs-a';
const BOT = 'prices';
const CARD_SHOWN = 'как будет сохранена';
const CARD_SAVED = 'Карточка поставщика сохранена.';
const DUPLICATE_MARK = 'Похоже на существующего';
const ECHO_PREFIX = 'Итог ';
const REQUEST_ECHO = 'ИНН в запросе: ';
const QUIET_MS = 1_000;
/** Минимальная длина серии цифр, которую guard считает ИНН/счётом. */
const MIN_NUMBER_DIGITS = 10;

const INN_NEW = makeInn('781234777');
const NEW_NAME = 'ООО Ромашка-Новая';
const OTHER_NAME = 'ООО Лютик-Новый';

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';

interface Running {
  app: ProductionApp;
  chat: MemoryChatChannel;
  service: Service;
  dispose(): Promise<void>;
}
const running: Running[] = [];

/** Реплика сотрудника без блока личных заметок. */
function humanOf(body: Record<string, unknown>): string {
  const text = userTexts(body).at(-1) ?? '';
  const cut = text.lastIndexOf('\n\n');
  return cut < 0 ? text : text.slice(cut + 2);
}

/** Последний результат инструмента в истории: имя и разобранное значение. */
function lastToolResult(body: Record<string, unknown>): { name: string; value: unknown } | null {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names = new Map<string, string>();
  let found: { name: string; value: unknown } | null = null;
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use') {
        names.set(String(block['id']), String(block['name']));
      }
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      let value: unknown = block['content'];
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          // Оставляем строку как есть.
        }
      }
      found = { name: names.get(String(block['tool_use_id'])) ?? '?', value };
    }
  }
  return found;
}

/** Ход «модели»: имя и ИНН берутся ровно из того, что она видит в реплике. */
const script: DualHandler = ({ raw, body }) => {
  const text = humanOf(body);
  const inn = /ИНН\s*(\d{10,12}|\[INN_\d+\])/.exec(text)?.[1] ?? '';
  if (stepInTurn(body) > 0) {
    const last = lastToolResult(body);
    if (last === null) throw new Error('нет результата инструмента');
    // Токен из запроса модель возвращает в тексте: сотрудник должен увидеть настоящий ИНН.
    return {
      kind: 'text',
      text:
        `${ECHO_PREFIX}${last.name}: ${JSON.stringify(last.value)}. ` +
        `${REQUEST_ECHO}${inn === '' ? (firstToken(raw, 'INN') ?? '-') : inn}`,
    };
  }
  // Ответ сотрудника текстом (кнопок подтверждения нет): решение записывает код.
  if (text.startsWith('да, сохраняй')) {
    return { kind: 'tool', name: 'confirmSupplierRequest', input: { decision: 'save' } };
  }
  if (text.includes('добавь поставщика')) {
    const name = /поставщика\s+(.+?),/.exec(text)?.[1] ?? '';
    return {
      kind: 'tool',
      name: 'prepareSupplierCard',
      input: { ...(name === '' ? {} : { name }), ...(inn === '' ? {} : { inn }) },
    };
  }
  return { kind: 'text', text: 'Принято.' };
};

async function start(): Promise<Running> {
  // Запись карточек - только руководителям отделов (этап 234): сотрудник A - руководитель.
  const heads = new MemoryDepartmentHeads();
  heads.set(USER_A);
  const { app, chat, config } = buildApp(
    new Map(),
    {
      CHAT_BOTS: JSON.stringify({ [BOT]: PRICES_AGENT_ID }),
      ACCESS_POLICY_FILE: rules,
      SUPPLIER_CARDS_ENABLED: 'true',
      SUPPLIER_TEMPLATE_PATH: supplierTemplatePath(),
    },
    { heads },
  );
  const service = createService({
    app,
    chat,
    access: app.access,
    clock: new SystemClock(),
    ids: new SystemIdGenerator(),
    healthPort: 0,
    chatAgentId: config.service.chatAgentId,
    chatBots: config.service.chatBots,
    chatGreetingEnabled: config.service.chatGreetingEnabled,
    chatTurnTimeoutMs: config.service.chatTurnTimeoutMs,
    workerIntervalMs: E2E_WORKER_INTERVAL_MS,
    shutdownTimeoutMs: E2E_SHUTDOWN_MS,
    log: () => undefined,
  });
  await service.start();
  const instance: Running = {
    app,
    chat,
    service,
    async dispose() {
      await service.stop().catch(() => undefined);
      await app.close().catch(() => undefined);
    },
  };
  running.push(instance);
  return instance;
}

const THREAD = `${BOT}/${USER_A}`;

async function say(run: Running, text: string): Promise<void> {
  await run.chat.emit({
    kind: 'message',
    threadId: THREAD,
    userId: USER_A,
    botId: BOT,
    text,
  });
}

function countText(run: Running, mark: string): number {
  return textsTo(run.chat, THREAD).filter((text) => text.includes(mark)).length;
}

async function waitCount(run: Running, mark: string, count = 1): Promise<void> {
  await waitFor(`«${mark}» x${count}`, () => countText(run, mark) >= count);
}

function lastWith(run: Running, mark: string): string {
  return textsTo(run.chat, THREAD).filter((text) => text.includes(mark)).at(-1) ?? '';
}

async function supplierCount(): Promise<number> {
  const rows = await db.query('SELECT count(*)::int AS n FROM suppliers');
  return Number(rows[0]?.['n']);
}

/** Настоящий ИНН (в любом виде записи) ни в одном теле запроса к модели. */
function bodiesWithDigits(digits: string): number {
  return stub.bodies().filter((raw) => raw.replace(/\D/g, '').includes(digits)).length;
}

/** Числа JSON длиной от 10 цифр в значении (guard отклонил бы такой запрос). */
function longJsonNumbers(value: unknown): number[] {
  if (typeof value === 'number') {
    return String(Math.trunc(Math.abs(value))).length >= MIN_NUMBER_DIGITS ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(longJsonNumbers);
  if (isRecord(value)) return Object.values(value).flatMap(longJsonNumbers);
  return [];
}

function echoedResult(run: Running, tool: string): Record<string, unknown> {
  const line = lastWith(run, `${ECHO_PREFIX}${tool}: `);
  const start = `${ECHO_PREFIX}${tool}: `.length;
  const end = line.lastIndexOf(`. ${REQUEST_ECHO}`);
  const parsed: unknown = JSON.parse(line.slice(start, end < 0 ? undefined : end));
  if (!isRecord(parsed)) throw new Error(`результат ${tool} не объект`);
  return parsed;
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = `${e2eEnv().work}/out/access-rs.json`;
  await writeFile(
    rules,
    JSON.stringify({
      version: 1,
      bots: { [PRICES_AGENT_ID]: { allow: { users: [USER_A] } } },
    }),
    'utf8',
  );
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
});

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('сценарий r-s: ИНН организации при умолчании флага маскирования названий', () => {
  test('модель видит токен, инструмент получает настоящий ИНН, ответ с настоящим ИНН', async () => {
    const run = await start();
    await say(run, `добавь поставщика ${NEW_NAME}, ИНН ${INN_NEW}, поставляют крепёж.`);
    await waitCount(run, CARD_SHOWN);
    await waitCount(run, `${ECHO_PREFIX}prepareSupplierCard`);
    await settle(QUIET_MS);

    // Модель вызвана, guard не отклонял, ИНН в телах запросов нет, есть токен.
    expect(stub.errors).toEqual([]);
    expect(stub.bodies().length).toBeGreaterThan(0);
    expect(bodiesWithDigits(INN_NEW)).toBe(0);
    expect(stub.bodies().some((raw) => raw.includes('[INN_'))).toBe(true);
    // Флаг `false`: название организации уходит модели как есть.
    expect(stub.bodies().some((raw) => raw.includes(NEW_NAME))).toBe(true);

    // Инструмент получил настоящий ИНН: карточка с ним показана, проверка суммы прошла.
    const shown = lastWith(run, CARD_SHOWN);
    expect(shown).toContain(`Название: ${NEW_NAME}`);
    expect(shown).toContain(`ИНН: ${INN_NEW}`);
    expect(await supplierCount()).toBe(0);
    expect(stub.ofModel('e2e-prices').length).toBe(stub.requests.length);

    // В ответе модели токен восстановлен до настоящего ИНН.
    const reply = lastWith(run, `${ECHO_PREFIX}prepareSupplierCard`);
    expect(reply).toContain(`${REQUEST_ECHO}${INN_NEW}`);
    expect(reply).not.toContain('[INN_');

    // Результат инструмента для модели: статус, ИНН нигде числом и не целиком.
    const result = echoedResult(run, 'prepareSupplierCard');
    expect(result['status']).toBe('shown');
    expect(JSON.stringify(result)).not.toContain(INN_NEW);
    expect(longJsonNumbers(result)).toEqual([]);

    // «да, сохраняй» текстом (кнопок нет): в базе настоящий ИНН.
    await say(run, 'да, сохраняй');
    await waitCount(run, CARD_SAVED);
    expect(await supplierCount()).toBe(1);
    const rows = await db.query('SELECT inn, name FROM suppliers');
    expect(rows[0]?.['inn']).toBe(INN_NEW);
    expect(typeof rows[0]?.['inn']).toBe('string');

    // Тот же ИНН под другим названием: дубль найден по ИНН, модель снова видит токен.
    await say(run, `добавь поставщика ${OTHER_NAME}, ИНН ${INN_NEW}, поставляют крепёж.`);
    await waitCount(run, DUPLICATE_MARK);
    expect(lastWith(run, DUPLICATE_MARK)).toContain('совпадает ИНН');
    expect(bodiesWithDigits(INN_NEW)).toBe(0);
    expect(stub.errors).toEqual([]);

    // Поиск через репозиторий отдаёт ИНН строкой.
    const found = await new PostgresSupplierRepository(db).searchCards({
      query: 'Ромашка',
      limit: 5,
    });
    expect(found[0]?.inn).toBe(INN_NEW);
  });

  test('ИНН с неверной контрольной суммой после слова «ИНН»: токен, предупреждение', async () => {
    const run = await start();
    const broken = breakInn(INN_NEW);
    await say(run, `добавь поставщика ${NEW_NAME}, ИНН ${broken}, поставляют крепёж.`);
    await waitCount(run, `${ECHO_PREFIX}prepareSupplierCard`);
    await settle(QUIET_MS);

    expect(stub.errors).toEqual([]);
    // Реплика сотрудника: ИНН после слова «ИНН» заменён токеном и при неверной сумме.
    // Дальше по ходу тот же номер возвращается в аргументе инструмента голой строкой без суммы
    // и без слова: такие числа маскер не трогает намеренно (артикулы), поэтому проверяем
    // первый запрос, а не всю историю.
    const first = stub.bodies()[0] ?? '';
    expect(first.replace(/\D/g, '')).not.toContain(broken);
    expect(first).toContain('[INN_');
    // Настоящее значение восстановлено, и проверка суммы в коде его не принимает. С этапа 177
    // (коммит bec7e8d5) это не отказ: ИНН очищается, карточка показывается сотруднику с
    // предупреждением, записи в базу до подтверждения нет.
    const result = echoedResult(run, 'prepareSupplierCard');
    expect(result['status']).toBe('shown');
    expect(JSON.stringify(result)).toContain('контрольная сумма');
    expect(JSON.stringify(result)).toContain('ИНН не указан');
    expect(countText(run, CARD_SHOWN)).toBe(1);
    // Неверный ИНН в показанной карточке не остаётся.
    expect(lastWith(run, CARD_SHOWN)).not.toContain(broken);
    expect(await supplierCount()).toBe(0);
    expect(lastWith(run, REQUEST_ECHO)).toContain(`${REQUEST_ECHO}${broken}`);
  });
});
