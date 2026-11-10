import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { handoffThreadId } from '@business-ai/core';
import {
  ORDER_CALC_MODEL,
  PRICES_MODEL,
  ageRunningJobLocks,
  agentRunJobs,
  handoffAudit,
  handoffRecords,
  parentHandoffReply,
  resetHandoffTables,
  sendText,
  settle,
  startCore,
  textsTo,
  waitFor,
  waitForText,
  writeAccessRules,
  type Core,
} from '../lib/handoff-core';
import {
  DualLlmStub,
  createGate,
  firstToken,
  stepInTurn,
  type DualHandler,
  type Gate,
} from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import { BUYER_PII } from '../lib/pii.owned';
import { findLeaks, REAL_PERSON, REAL_PHONE } from '@business-ai/testing/e2e';

/**
 * Сценарий k: асинхронная передача «Поиск поставщика (ИИ агент)» -> «Актуализация прайса (ИИ
 * агент)» от сообщения сотрудника в
 * чате до итога инициатору, с перезапуском ядра посреди дочернего хода. Всё на настоящих
 * Postgres, pseudonymizer и pii-guard; ядро поднято как в `main.ts` (служба = воркер + насос).
 */

const EMPLOYEE = 'emp-e2e-k';
const CHAT_THREAD = 'e2e-k-chat';
const REQUEST_ID = 'req-e2e-k';
const POSITION = 'Арматура А500С d12';
const EMPLOYEE_TEXT =
  `Освежи цены по заявке ${REQUEST_ID}: ${POSITION} для клиента ${REAL_PERSON}, ` +
  `тел. ${REAL_PHONE}`;
const PARENT_FINAL = 'Передал задачу агенту «Актуализация прайса (ИИ агент)»: итог придёт ' +
  'отдельным сообщением.';
const RESULT_MARK = 'выполнил переданную задачу';
/** Сколько ждать, чтобы убедиться, что повторного эффекта нет, мс. */
const QUIET_MS = 2_500;
/**
 * Сколько запросов агента «Актуализация прайса (ИИ агент)» ответили: инструмент и итог (подвешенный
 * не в счёт).
 */
const CHILD_ANSWERED = 2;

const stub = new DualLlmStub();
let db: PgClient;
let accessFile = '';
const cores: Core[] = [];
let gate: Gate;

/** Родитель: ход 0 - передача с именем клиента в позиции, ход 1 - итоговая фраза. */
function scriptFor(hangFirstChild: boolean): DualHandler {
  gate = createGate();
  let hung = false;
  return async ({ model, raw, body }) => {
    const step = stepInTurn(body);
    if (model === ORDER_CALC_MODEL) {
      if (step > 0) return { kind: 'text', text: PARENT_FINAL };
      return parentHandoffReply(raw, 'handoffToPrices', REQUEST_ID, POSITION);
    }
    if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
    if (hangFirstChild && !hung) {
      hung = true;
      await gate.promise;
    }
    if (step === 0) return { kind: 'tool', name: 'listStalePriceSuppliers', input: {} };
    const person = firstToken(raw, 'PERSON');
    if (person === null) throw new Error('ввод дочернему агенту дошёл без токена имени');
    return { kind: 'text', text: `Цены по позиции актуальны для ${person}.` };
  };
}

/** Сколько запросов агента «Актуализация прайса (ИИ агент)» уже получили ответ заглушки. */
function answeredChild(): number {
  return stub.ofModel(PRICES_MODEL).filter((request) => request.answered).length;
}

async function start(chat?: Core['chat']): Promise<Core> {
  const core = await startCore({ accessFile, ...(chat === undefined ? {} : { chat }) });
  cores.push(core);
  return core;
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  accessFile = await writeAccessRules('k', {
    'order-calc': [EMPLOYEE],
    prices: [EMPLOYEE],
  });
});

afterEach(async () => {
  gate?.open();
  for (const core of cores.splice(0)) await core.dispose();
  await resetHandoffTables(db);
});

afterAll(async () => {
  await db.close();
  await stub.stop();
});

/** Общие проверки итога: ровно одно сообщение инициатору, дочерний ход один, нет утечек. */
async function expectFinishedOnce(chats: Core['chat'][], childAnswered: number): Promise<void> {
  const results = chats
    .flatMap((chat) => textsTo(chat, CHAT_THREAD))
    .filter((text) => text.includes(RESULT_MARK));
  expect(results).toHaveLength(1);
  expect(results[0]).toContain(REAL_PERSON); // итог человеку - с настоящим именем

  const records = await handoffRecords(db);
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record?.status).toBe('done');
  expect(record?.notified).toBe(true);
  expect(record?.userId).toBe(EMPLOYEE);
  // Ввод дочернему агенту в состоянии (не в очереди) несёт настоящее имя.
  expect(record?.input).toContain(REAL_PERSON);

  const audit = await handoffAudit(db);
  expect(audit.filter((entry) => entry.stage === 'queued')).toHaveLength(1);
  expect(audit.filter((entry) => entry.stage === 'finished')).toHaveLength(1);
  expect(audit.map((entry) => entry.details).join('\n')).not.toContain(REAL_PERSON);

  const jobs = await agentRunJobs(db);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.status).toBe('done');
  // В очереди только идентификаторы: ни ПДн, ни текста позиций.
  for (const job of jobs) {
    expect(job.payload).not.toContain(POSITION);
    expect(job.payload).not.toContain(REAL_PERSON);
    expect(job.payload).not.toContain('Сидоров');
    expect(job.payload).not.toContain('555');
    expect(JSON.parse(job.payload)).toMatchObject({ agentId: 'prices', input: '' });
  }

  // Дочерний ход завершён один раз.
  const child = await cores.at(-1)?.app.runtime.getThread(handoffThreadId(record?.id ?? ''));
  expect(child?.status).toBe('completed');
  // Модель агента «Актуализация прайса (ИИ агент)» ответила ровно на инструмент и итог (число снято
  // до «оживания» хвоста).
  expect(childAnswered).toBe(CHILD_ANSWERED);

  // Исходящий трафик к модели: ни имени, ни телефона клиента, включая дочерний ход.
  expect(stub.errors).toEqual([]);
  expect(findLeaks(stub.bodies(), BUYER_PII)).toEqual([]);
  expect(stub.bodies().join('\n')).not.toContain('555-12-34');
  const childBodies = stub.ofModel(PRICES_MODEL).map((request) => request.raw);
  expect(childBodies.length).toBeGreaterThan(0);
  expect(childBodies.every((raw) => /\[PERSON_\d+\]/.test(raw))).toBe(true);
}

describe('сценарий k: передача «Поиск поставщика (ИИ агент)» -> «Актуализация прайса (ИИ агент)» ' +
  'и перезапуск ядра', () => {
  test('без перезапуска: сообщение сотрудника -> итог ровно один раз', async () => {
    stub.begin(scriptFor(false));
    const core = await start();
    await sendText(core.chat, CHAT_THREAD, EMPLOYEE, EMPLOYEE_TEXT);
    await waitForText('итог передачи в чате', core.chat, CHAT_THREAD, RESULT_MARK);
    // Сообщение родителя пришло раньше итога: передача не блокировала ход чата.
    const texts = textsTo(core.chat, CHAT_THREAD);
    const parentAt = texts.findIndex((text) => text.includes('Передал задачу'));
    const resultAt = texts.findIndex((text) => text.includes(RESULT_MARK));
    expect(parentAt).toBeGreaterThanOrEqual(0);
    expect(parentAt).toBeLessThan(resultAt);
    await settle(QUIET_MS);
    await expectFinishedOnce([core.chat], answeredChild());
  });

  test('падение процесса посреди дочернего хода: новое ядро доводит один раз', async () => {
    stub.begin(scriptFor(true));
    const first = await start();
    await sendText(first.chat, CHAT_THREAD, EMPLOYEE, EMPLOYEE_TEXT);
    await waitFor('первый запрос дочернего агента завис', () =>
      stub.ofModel(PRICES_MODEL).some((request) => !request.answered),
    );
    const [midway] = await handoffRecords(db);
    expect(midway?.status).toBe('running');
    expect((await agentRunJobs(db))[0]?.status).toBe('running');

    // Процесс умер: БД для него закрыта, захват задачи «протухает» по таймауту видимости.
    await first.crash();
    expect(await ageRunningJobLocks(db)).toBe(1);

    const second = await start();
    await waitForText('итог передачи после перезапуска', second.chat, CHAT_THREAD, RESULT_MARK);
    await settle(QUIET_MS);
    const answered = answeredChild();
    // Хвост прежнего процесса «оживает» (ответ модели пришёл) - второго итога быть не должно.
    gate.open();
    await settle(QUIET_MS);
    expect((await agentRunJobs(db))[0]?.attempts).toBe(2);
    await expectFinishedOnce([first.chat, second.chat], answered);
    // Итог ушёл уже из нового экземпляра, а в чат прежнего его не писали.
    expect(textsTo(first.chat, CHAT_THREAD).some((text) => text.includes(RESULT_MARK))).toBe(
      false,
    );
  });

  test('штатная остановка посреди дочернего хода: задача возвращается в очередь', async () => {
    stub.begin(scriptFor(true));
    const first = await start();
    await sendText(first.chat, CHAT_THREAD, EMPLOYEE, EMPLOYEE_TEXT);
    await waitFor('первый запрос дочернего агента завис', () =>
      stub.ofModel(PRICES_MODEL).some((request) => !request.answered),
    );
    const report = await first.stop();
    expect(report.drained).toBe(false); // ход не уложился в срок остановки
    const [released] = await agentRunJobs(db);
    expect(released?.status).toBe('pending'); // вернулась в очередь без ожидания 20 минут
    expect(released?.attempts).toBe(0); // возврат при остановке попытку не тратит

    const second = await start();
    await waitForText('итог передачи после перезапуска', second.chat, CHAT_THREAD, RESULT_MARK);
    await settle(QUIET_MS);
    const answered = answeredChild();
    gate.open();
    await settle(QUIET_MS);
    expect((await agentRunJobs(db))[0]?.attempts).toBe(1);
    await expectFinishedOnce([first.chat, second.chat], answered);
  });
});
