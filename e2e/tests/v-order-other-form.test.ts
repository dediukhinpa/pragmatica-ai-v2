import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import {
  BOT_ORDERS,
  startBitrixWorld,
  writeBitrixRules,
  type BitrixWorld,
} from '../lib/bitrix24-world';
import { DualLlmStub, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { ORDER_CALC_MODEL, resetHandoffTables } from '../lib/handoff-core';
import { expectNoLeaks } from '@business-ai/testing/e2e';
import { blocksOf, isRecord, toolResults, userTexts } from '@business-ai/testing/e2e';
import type { PiiSet } from '@business-ai/testing/e2e';

/**
 * Сценарий v1: заявка вне форм 11.1-11.4 - мягкая форма «прочее» (этап 104, тема 2).
 * Настоящая боевая сборка на заглушке портала Bitrix24 с включённой проверкой полноты
 * (`ORDER_CALC_COMPLETENESS_ENABLED`), настоящий pseudonymizer и pii-guard; модель - скрипт.
 *
 * С этапа 140 (коммит 0a891748, решение владельца 01.11.2026) проверка полноты - только
 * подсказка: поиск она не блокирует, ссылка на задачу не обязательна, инструмента отказа
 * «ищи так» нет. Недостающее напоминается один раз вместе с результатом поиска.
 *
 *  v1a - есть «что нужно, тираж, срок» и ссылка на задачу: вопроса о виде запроса нет, поиск
 *        стартует сразу, напоминать не о чем;
 *  v1b - не хватает срока: поиск стартует сразу, срок напоминается один раз; после ответа
 *        сотрудника форма заполнена и напоминания нет;
 *  v1c - не названы тираж и срок: поиск идёт по имеющимся данным, инструмента отказа нет;
 *  v1d - ссылка на задачу не обязательна: без неё поиск идёт и о ссылке не напоминают;
 *        чужая ссылка отбрасывается с предупреждением, поиск не откладывается.
 */

const USER = 1001;
const USER_NAME = { name: 'Алевтина', lastName: 'Сафонова' };
const TASK_ID = 91;
const RULES_NAME = 'v-order-other-form';
const ITEM = { name: 'Повербанки с логотипом', quantity: 300, unit: 'шт' };

/** Тексты скрипта «модели»; по ним тест находит ответ в диалоге. */
const SEARCH_STARTED = 'Поиск начат';
const CHECK_ERROR = 'Проверка отклонена';
/** Реплики сотрудника: разбираются скриптом по подстрокам. */
const ASK_MARK = 'Нужны повербанки';
/** Вопрос о виде запроса: заявка не подходит под формы, поэтому его быть не должно. */
const KIND_QUESTION = /вид запроса|какой вид|какая форма/i;

const PII: PiiSet = { names: [USER_NAME.name, USER_NAME.lastName], phones: [], emails: [] };

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

function parsed(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** Хвост запроса: последний результат инструмента (с именем) либо реплика сотрудника. */
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
    return {
      tool: names.get(String(block['tool_use_id'])) ?? '?',
      result: parsed(block['content']),
      human: '',
    };
  }
  return { tool: null, result: null, human: userTexts(body).at(-1) ?? '' };
}

function field(result: unknown, name: string): unknown {
  return isRecord(result) ? result[name] : undefined;
}

/** Номер заявки из последнего `saveIntakeRequest` истории. */
function requestIdOf(body: Record<string, unknown>): string {
  const saved = toolResults(body).get('saveIntakeRequest')?.at(-1);
  const id = field(saved, 'requestId');
  if (typeof id !== 'string') throw new Error('в истории нет результата saveIntakeRequest');
  return id;
}

/**
 * Значения формы «прочее» из реплики сотрудника: то, что сказано явно. В повторных
 * репликах только новое, прежнее код хранит сам.
 */
function valuesOf(text: string): Record<string, string> {
  const product = /Нужны ([^,.]+)/u.exec(text)?.[1];
  const quantity = /тираж (\d+)/u.exec(text)?.[1];
  const deadline = /срок до ([^.]+)\./u.exec(text)?.[1];
  const link = /https?:\/\/\S+/u.exec(text)?.[0];
  return {
    ...(product === undefined ? {} : { product }),
    ...(quantity === undefined ? {} : { quantity }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(link === undefined ? {} : { task_link: link }),
  };
}

/** Значения из всех реплик сотрудника; позднее значение заменяет раннее. */
function valuesOfAll(body: Record<string, unknown>): Record<string, string> {
  return Object.assign({}, ...userTexts(body).map(valuesOf));
}

/**
 * Ход «модели» агента «Поиск поставщика»: приём заявки -> форма «прочее» -> поиск. Прежние ходы
 * диалога модель видит только текстом (вызовы инструментов в историю не переносятся), поэтому
 * каждый ход начинается с приёма заявки (повтор даёт ту же заявку), а значения формы
 * собираются из всех реплик сотрудника: код дополняет сохранённое, а не затирает.
 */
const script: DualHandler = ({ model, body }) => {
  if (model !== ORDER_CALC_MODEL) throw new Error(`неизвестная модель ${model}`);
  const tail = tailOf(body);
  if (tail.tool === null) {
    return {
      kind: 'tool',
      name: 'saveIntakeRequest',
      input: { source: 'text', items: [ITEM] },
    };
  }
  switch (tail.tool) {
    case 'saveIntakeRequest':
      return {
        kind: 'tool',
        name: 'checkRequestCompleteness',
        input: { requestId: requestIdOf(body), kind: 'other', values: valuesOfAll(body) },
      };
    case 'checkRequestCompleteness': {
      if (isRecord(tail.result) && typeof tail.result['error'] === 'string') {
        return { kind: 'text', text: `${CHECK_ERROR}: ${tail.result['error']}` };
      }
      // Подсказка поиск не блокирует: ищем сразу, ответа сотрудника не ждём.
      return {
        kind: 'tool',
        name: 'searchKnowledgeSuppliers',
        input: { requestId: requestIdOf(body) },
      };
    }
    case 'searchKnowledgeSuppliers': {
      const error = isRecord(tail.result) ? tail.result['error'] : undefined;
      if (typeof error === 'string') return { kind: 'text', text: `Поиск не удался: ${error}` };
      // Вопрос формы собран кодом: модель напоминает о нём один раз вместе с итогом поиска.
      const check = toolResults(body).get('checkRequestCompleteness')?.at(-1);
      const question = field(check, 'question');
      const reminder = typeof question === 'string' ? `\n\n${question}` : '';
      return {
        kind: 'text',
        text: `${SEARCH_STARTED}: ${String(field(tail.result, 'status'))}${reminder}`,
      };
    }
    default:
      return { kind: 'text', text: `Неожиданный результат инструмента ${tail.tool}` };
  }
};

/** Мир с приёмом заявок и проверкой полноты запроса до поиска. */
async function start(): Promise<BitrixWorld> {
  const world = await startBitrixWorld({
    rules,
    flags: { intake: true },
    env: { ORDER_CALC_COMPLETENESS_ENABLED: 'true' },
  });
  worlds.push(world);
  world.portal.addUser({ id: USER, ...USER_NAME });
  return world;
}

/** Ссылка на задачу своего портала (проверяется только формат, задача не читается). */
function taskLink(world: BitrixWorld): string {
  return `http://${world.portal.host}/company/personal/user/1/tasks/task/view/${TASK_ID}/`;
}

/** Последний результат инструмента `name` в истории последнего запроса к модели. */
function lastToolResult(name: string): unknown {
  const raw = stub.requests.at(-1)?.raw ?? '{}';
  return toolResults(JSON.parse(raw) as Record<string, unknown>).get(name)?.at(-1);
}

/** Сколько раз за сценарий вызывался инструмент (по результатам в истории). */
function resultsOf(name: string): unknown[] {
  const raw = stub.requests.at(-1)?.raw ?? '{}';
  return toolResults(JSON.parse(raw) as Record<string, unknown>).get(name) ?? [];
}

async function expectClean(world: BitrixWorld): Promise<void> {
  expect(stub.errors).toEqual([]);
  await expectNoLeaks({
    llm: stub.bodies(),
    logs: world.logs,
    portal: world.portal,
    db,
    pii: PII,
    forbiddenTexts: [],
  });
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeBitrixRules(RULES_NAME, {
    [ORDER_CALC_AGENT_ID]: { users: [String(USER)] },
  });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('v1a: заявка вне форм 11.1-11.4, всё сказано', () => {
  test('о виде запроса не спрашиваем: форма «прочее», поиск стартует сразу', async () => {
    const world = await start();
    const employee = world.employee(USER);
    const ask =
      `${ASK_MARK} с логотипом, тираж ${ITEM.quantity} шт, срок до 15 ноября. ` +
      `Задача: ${taskLink(world)}`;
    await employee.say(BOT_ORDERS, ask);
    await employee.waitText(BOT_ORDERS, (text) => text.startsWith(SEARCH_STARTED));

    // Модель получила форму «прочее» как вид запроса, всё заполнено, предупреждений нет.
    const check = lastToolResult('checkRequestCompleteness');
    expect(field(check, 'kind')).toBe('other');
    expect(field(check, 'complete')).toBe(true);
    expect(field(check, 'missing')).toEqual([]);
    expect(field(check, 'question')).toBeUndefined();
    expect(field(check, 'warnings')).toBeUndefined();
    // Сотруднику ушёл только итог: ни вопроса о виде запроса, ни других вопросов.
    const replies = employee.replies(BOT_ORDERS);
    expect(replies).toHaveLength(1);
    expect(replies.join('\n')).not.toMatch(KIND_QUESTION);
    // Промпт агента велит не спрашивать вид запроса для заявки вне форм.
    expect(stub.requests[0]?.raw).toContain('о виде запроса сотрудника не спрашивай');
    expect(resultsOf('searchKnowledgeSuppliers')).toHaveLength(1);
    await expectClean(world);
  });
});

describe('v1b: не хватает срока', () => {
  test('поиск стартует сразу, срок напоминается один раз, после ответа - нет', async () => {
    const world = await start();
    const employee = world.employee(USER);
    const ask = `${ASK_MARK} с логотипом, тираж ${ITEM.quantity} шт. Задача: ${taskLink(world)}`;
    await employee.say(BOT_ORDERS, ask);
    const reply = await employee.waitText(BOT_ORDERS, (text) => text.startsWith(SEARCH_STARTED));
    // Поиск не ждал ответа: результат поиска есть, срок напомнен в том же сообщении.
    expect(resultsOf('searchKnowledgeSuppliers')).toHaveLength(1);
    expect(reply).toMatch(/срок/i);
    expect(reply).not.toMatch(KIND_QUESTION);
    // Вопрос начинается с блока «Уже понял: ...» (тираж там - как известный); спрашиваемая
    // часть после него тираж повторно не запрашивает.
    expect(reply).toContain('Уже понял:');
    const asked = reply.slice(reply.indexOf('Уже понял:')).split('\n\n').slice(1);
    expect(asked.join('\n\n')).not.toMatch(/тираж/i);
    expect(field(lastToolResult('checkRequestCompleteness'), 'complete')).toBe(false);
    expect(employee.replies(BOT_ORDERS)).toHaveLength(1);

    // Сотрудник дополняет срок: форма заполнена, напоминания нет.
    const before = employee.snapshot(BOT_ORDERS);
    await employee.say(BOT_ORDERS, 'срок до 20 ноября.');
    const next = await employee.waitText(BOT_ORDERS, (text) => text.startsWith(SEARCH_STARTED), {
      since: before,
    });
    expect(field(lastToolResult('checkRequestCompleteness'), 'complete')).toBe(true);
    expect(next).not.toMatch(/срок/i);
    expect(employee.replies(BOT_ORDERS).filter((text) => /срок/i.test(text))).toHaveLength(1);
    await expectClean(world);
  });
});

describe('v1c: не названы тираж и срок', () => {
  test('поиск идёт по имеющимся данным, отдельного отказа дополнять нет', async () => {
    const world = await start();
    const employee = world.employee(USER);
    // Сказано только «что нужно» и ссылка: тираж и срок не названы.
    await employee.say(BOT_ORDERS, `${ASK_MARK} с логотипом. Задача: ${taskLink(world)}`);
    const reply = await employee.waitText(BOT_ORDERS, (text) => text.startsWith(SEARCH_STARTED));
    expect(resultsOf('searchKnowledgeSuppliers')).toHaveLength(1);
    expect(reply).toMatch(/тираж|срок/i);
    // Недостающие поля остались пустыми: форма «прочее» их не выдумывает.
    const check = lastToolResult('checkRequestCompleteness');
    expect(field(check, 'complete')).toBe(false);
    expect(Array.isArray(field(check, 'missing'))).toBe(true);
    expect((field(check, 'missing') as unknown[]).length).toBeGreaterThan(0);
    // Инструмента «сотрудник отказался дополнять» у агента больше нет.
    expect(stub.requests[0]?.raw).not.toContain('recordCompletenessDecision');
    await expectClean(world);
  });
});

describe('v1d: ссылка на задачу Б24 не обязательна', () => {
  test('без ссылки поиск идёт и о ссылке не напоминают', async () => {
    const world = await start();
    const employee = world.employee(USER);
    // Всё, что просит форма, названо; ссылки на задачу нет.
    await employee.say(
      BOT_ORDERS,
      `${ASK_MARK} с логотипом, тираж ${ITEM.quantity} шт, срок до 15 ноября.`,
    );
    const reply = await employee.waitText(BOT_ORDERS, (text) => text.startsWith(SEARCH_STARTED));
    const check = lastToolResult('checkRequestCompleteness');
    expect(field(check, 'complete')).toBe(true);
    expect(field(check, 'missing')).toEqual([]);
    expect(field(check, 'question')).toBeUndefined();
    expect(reply).not.toMatch(/ссылк/i);
    expect(resultsOf('searchKnowledgeSuppliers')).toHaveLength(1);
    await expectClean(world);
  });

  test('чужая ссылка отбрасывается с предупреждением, поиск не откладывается', async () => {
    const world = await start();
    const employee = world.employee(USER);
    const form = `${ASK_MARK} с логотипом, тираж ${ITEM.quantity} шт, срок до 15 ноября.`;
    // Адрес не нашего портала: проверка формата убирает значение и предупреждает, не отказывает.
    await employee.say(BOT_ORDERS, `${form} Задача: https://example.test/tasks/task/view/5/`);
    await employee.waitText(BOT_ORDERS, (text) => text.startsWith(SEARCH_STARTED));
    const check = lastToolResult('checkRequestCompleteness');
    expect(field(check, 'error')).toBeUndefined();
    const warnings = field(check, 'warnings');
    expect(Array.isArray(warnings) && warnings.length === 1).toBe(true);
    expect(String(warnings)).toContain('не похоже на ссылку на задачу портала');
    expect(resultsOf('searchKnowledgeSuppliers')).toHaveLength(1);

    // Ссылка на задачу своего портала принимается без предупреждений.
    const before = employee.snapshot(BOT_ORDERS);
    const link = taskLink(world);
    await employee.say(BOT_ORDERS, `Вот задача: ${link}`);
    // Ответ второго хода: к нему последний запрос к модели уже несёт новую реплику со ссылкой
    // (прежнее сообщение бота могло быть лишь отредактировано и совпасть по тексту).
    await employee.waitText(
      BOT_ORDERS,
      (text) => text.startsWith(SEARCH_STARTED) && (stub.requests.at(-1)?.raw ?? '').includes(link),
      { since: before },
    );
    expect(field(lastToolResult('checkRequestCompleteness'), 'warnings')).toBeUndefined();
    await expectClean(world);
  });
});
