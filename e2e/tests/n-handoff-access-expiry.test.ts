import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { handoffThreadId } from '@business-ai/core';
import { CHAT_HANDOFF_CLOSED_TEXT, CHAT_HANDOFF_EXPIRED_TEXT } from '../lib/project-env';
import { DualLlmStub, humanTurns, stepInTurn, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, openDb } from '../lib/project-env';
import {
  ORDER_CALC_MODEL,
  PRICES_MODEL,
  agentRunJobs,
  expireHandoffRecord,
  handoffAudit,
  handoffRecords,
  lastButtons,
  parentHandoffReply,
  pressButton,
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
import { toolResults } from '@business-ai/testing/e2e';
import { BUYER_PII, PRICE_FILE_PII } from '../lib/pii.owned';
import { findLeaks, REAL_PERSON, REAL_PHONE } from '@business-ai/testing/e2e';
import { JUMP_FLOW_STEPS, jumpFlowReply, seedJumpyPrices } from '../lib/prices-flow';

/**
 * Сценарий n: отказ по правам и просроченная передача. Сотрудник без доступа к агенту «Актуализация
 * прайса (ИИ агент)» не
 * может вызвать их через «Поиск поставщика (ИИ агент)»; право отзывается между постановкой и
 * исполнением;
 * срок годности и срок ответа человека истекают.
 *
 * Время: `composeProduction` строит `SystemClock` без внедрения часов, поэтому «просрочка»
 * делается честно через состояние: срок в записи передачи (`workflow_state`) и срок задачи
 * (`jobs.due_at`) переводятся на несколько часов назад, как после простоя службы. Сами
 * проверки срока исполняет боевой код ядра.
 */

const OK_USER = 'emp-e2e-n-ok';
const NO_PRICES_USER = 'emp-e2e-n-noprices';
const CHAT_THREAD = 'e2e-n-chat';
const REQUEST_ID = 'req-e2e-n';
const POSITION = 'Арматура А500С d12';
const TEXT = `Освежи цены по заявке ${REQUEST_ID}: ${POSITION} для ${REAL_PERSON}, ${REAL_PHONE}`;
const RESULT_MARK = 'выполнил переданную задачу';
const CHILD_FINAL = 'Цены по позициям актуальны.';
const ANSWER_FINAL = 'Скачки приняты, цены подтверждены.';
const QUESTION_MARK = 'просит уточнить';
const QUIET_MS = 2_000;
/** Интервал воркера, при котором задача не исполняется в рамках теста (первый проход пуст). */
const PARKED_WORKER_MS = 3_600_000;
const ACCESS_DENIED_CODE = 'handoff_access_denied';

const stub = new DualLlmStub();
let db: PgClient;
const cores: Core[] = [];
let rulesAll = '';
let rulesRevoked = '';

/** Текст результата последнего инструмента, каким его видит модель. */
function lastToolText(body: Record<string, unknown>, tool: string): string {
  const list = toolResults(body).get(tool) ?? [];
  return JSON.stringify(list.at(-1) ?? null);
}

const script: DualHandler = ({ model, raw, body }) => {
  if (model === ORDER_CALC_MODEL) {
    if (stepInTurn(body) > 0) {
      const seen = lastToolText(body, 'handoffToPrices');
      // Причину отказа модель берёт из текста замечания и говорит её человеку.
      if (seen.includes(ACCESS_DENIED_CODE)) {
        const reason = /У сотрудника нет доступа к этому помощнику[^"\\]*/.exec(seen)?.[0];
        if (reason === undefined) throw new Error(`в отказе нет текста причины: ${seen}`);
        return { kind: 'text', text: `Передача не выполнена. ${reason}` };
      }
      return { kind: 'text', text: 'Передал задачу агенту «Актуализация прайса (ИИ агент)».' };
    }
    return parentHandoffReply(raw, 'handoffToPrices', REQUEST_ID, POSITION);
  }
  if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
  if (humanTurns(body) >= 2) return { kind: 'text', text: ANSWER_FINAL };
  // Режим вопроса (есть засеянный прайс со скачками): полный путь до запроса решения.
  if (process.env['E2E_N_ASK'] === '1') return jumpFlowReply(stepInTurn(body), body, db);
  return { kind: 'text', text: CHILD_FINAL };
};

async function start(rules: string, options: { parked?: boolean; ask?: boolean } = {}) {
  const core = await startCore({
    accessFile: rules,
    ...(options.ask === true ? { env: { HANDOFF_ASK_ENABLED: 'true' } } : {}),
    ...(options.parked === true ? { workerIntervalMs: PARKED_WORKER_MS } : {}),
  });
  cores.push(core);
  return core;
}

async function say(core: Core, userId: string, text = TEXT, thread = CHAT_THREAD): Promise<void> {
  await sendText(core.chat, thread, userId, text);
}

function expectClean(): void {
  expect(stub.errors).toEqual([]);
  expect(findLeaks(stub.bodies(), BUYER_PII)).toEqual([]);
  expect(findLeaks(stub.bodies(), PRICE_FILE_PII)).toEqual([]);
  expect(stub.bodies().join('\n')).not.toContain('555-12-34');
}

/** В очереди нет содержимого передачи: только идентификаторы. */
async function expectQueueClean(): Promise<void> {
  for (const job of await agentRunJobs(db)) {
    for (const secret of ['Сидоров', '555', POSITION, REQUEST_ID]) {
      expect(job.payload).not.toContain(secret);
    }
  }
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rulesAll = await writeAccessRules('n-all', {
    'order-calc': [OK_USER, NO_PRICES_USER],
    prices: [OK_USER],
  });
  rulesRevoked = await writeAccessRules('n-revoked', { 'order-calc': [OK_USER], prices: [] });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
  delete process.env['E2E_N_ASK'];
});

afterEach(async () => {
  delete process.env['E2E_N_ASK'];
  for (const core of cores.splice(0)) await core.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('сценарий n1: отказ по правам при вызове', () => {
  test('сотрудник без доступа получает причину, дочерний ход не запускался', async () => {
    const core = await start(rulesAll);
    await say(core, NO_PRICES_USER);
    await waitFor('ответ с причиной отказа', () =>
      textsTo(core.chat, CHAT_THREAD).some((text) => text.includes('нет доступа')),
    );
    await settle(QUIET_MS);
    const reply = textsTo(core.chat, CHAT_THREAD).join('\n');
    expect(reply).toContain('Передача не выполнена');
    expect(reply).toContain('У сотрудника нет доступа к этому помощнику');
    // Ничего не поставлено и не запускалось: ни записи, ни задачи, ни запроса к агенту
    // «Актуализация прайса (ИИ агент)».
    expect(await handoffRecords(db)).toEqual([]);
    expect(await agentRunJobs(db)).toEqual([]);
    expect(stub.ofModel(PRICES_MODEL)).toEqual([]);
    expect((await handoffAudit(db)).filter((entry) => entry.stage === 'queued')).toEqual([]);
    expectClean();
  });

  test('контроль: сотрудник с доступом в том же ядре передачу получает', async () => {
    const core = await start(rulesAll);
    await say(core, NO_PRICES_USER, TEXT, 'e2e-n-chat-denied');
    await say(core, OK_USER, TEXT, 'e2e-n-chat-ok');
    await waitFor('итог у сотрудника с доступом', () =>
      textsTo(core.chat, 'e2e-n-chat-ok').some((text) => text.includes(RESULT_MARK)),
    );
    await settle(QUIET_MS);
    const records = await handoffRecords(db);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'done', userId: OK_USER, notified: true });
    // Отказанному итог не приходит: он получил только причину отказа.
    const denied = textsTo(core.chat, 'e2e-n-chat-denied').join('\n');
    expect(denied).toContain('нет доступа');
    expect(denied).not.toContain(RESULT_MARK);
    await expectQueueClean();
    expectClean();
  });
});

describe('сценарий n2: право отозвано между постановкой и исполнением', () => {
  test('исполнение закрывает передачу access_denied, дочерний ход не запускался', async () => {
    // Ядро «припарковано»: задача ставится, но воркер её не берёт до перезапуска.
    const first = await start(rulesAll, { parked: true });
    await say(first, OK_USER);
    await waitFor('передача поставлена', async () => (await handoffRecords(db)).length === 1);
    await waitFor('родитель ответил', () =>
      textsTo(first.chat, CHAT_THREAD).some((text) => text.includes('Передал')),
    );
    const [queued] = await handoffRecords(db);
    expect(queued?.status).toBe('queued');
    await first.stop();

    // Сотрудника исключили из агента «Актуализация прайса (ИИ агент)» (новый файл правил); после
    // перезапуска задача идёт.
    const second = await start(rulesRevoked);
    await waitFor('сообщение инициатору об отказе', () =>
      textsTo(second.chat, CHAT_THREAD).some((text) => text.includes('не выполнена')),
    );
    await settle(QUIET_MS);
    const [record] = await handoffRecords(db);
    expect(record).toMatchObject({ status: 'failed', errorCode: 'access_denied', notified: true });
    const texts = textsTo(second.chat, CHAT_THREAD).filter((text) => text.includes('не выполнена'));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('access_denied');
    expect(stub.ofModel(PRICES_MODEL)).toEqual([]);
    const audit = await handoffAudit(db);
    expect(audit.filter((entry) => entry.stage === 'finished')).toHaveLength(1);
    expect(audit.at(-1)?.result).toBe('failed:access_denied');
    const child = await second.app.runtime.getThread(handoffThreadId(record?.id ?? ''));
    expect(child).toBeNull();
    await expectQueueClean();
    expectClean();
  });
});

describe('сценарий n3: просроченная передача', () => {
  test('срок годности вышел: expired, итог один, повторная просьба выполняется', async () => {
    const first = await start(rulesAll, { parked: true });
    await say(first, OK_USER);
    await waitFor('передача поставлена', async () => (await handoffRecords(db)).length === 1);
    await first.stop();
    // Служба простояла дольше срока годности передачи (час): срок в записи уже в прошлом.
    await expireHandoffRecord(db, 'expiresAt');

    const second = await start(rulesAll);
    await waitFor('сообщение о просрочке', () =>
      textsTo(second.chat, CHAT_THREAD).some((text) => text.includes('просрочена')),
    );
    await settle(QUIET_MS);
    const [record] = await handoffRecords(db);
    expect(record).toMatchObject({
      status: 'expired',
      errorCode: 'handoff_expired',
      notified: true,
    });
    const notices = textsTo(second.chat, CHAT_THREAD).filter((t) => t.includes('просрочена'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Повторите просьбу');
    expect(stub.ofModel(PRICES_MODEL)).toEqual([]); // просроченное не исполняется

    // Повторная такая же просьба после просрочки выполняется заново, а не возвращает старое.
    await say(second, OK_USER);
    await waitForText('итог повторной просьбы', second.chat, CHAT_THREAD, RESULT_MARK);
    const records = await handoffRecords(db);
    expect(records).toHaveLength(2);
    expect(records.map((entry) => entry.status).sort()).toEqual(['done', 'expired']);
    expect(stub.ofModel(PRICES_MODEL).filter((request) => request.answered)).toHaveLength(1);
    await expectQueueClean();
    expectClean();
  });
});

// Вопрос дочернего агента задавал снятый инструмент askToConfirmUnverifiedPrice (подтверждение
// прайса снято 26.10.2026): сценарий ждёт переноса на вопрос другого агента.
describe.skip('сценарий n4: срок ответа человека на вопрос дочернего агента', () => {
  /** До вопроса человеку на ядре с включённым флагом; возвращает ядро и id передачи. */
  async function untilQuestion(): Promise<{ core: Core; id: string }> {
    process.env['E2E_N_ASK'] = '1';
    await seedJumpyPrices(db);
    const core = await start(rulesAll, { ask: true });
    await say(core, OK_USER);
    await waitForText('вопрос в чате', core.chat, CHAT_THREAD, QUESTION_MARK);
    const [record] = await handoffRecords(db);
    expect(record?.status).toBe('awaiting_human');
    return { core, id: record?.id ?? '' };
  }

  test('таймер срока ответа закрывает передачу, поздняя кнопка не возобновляет', async () => {
    const { core, id } = await untilQuestion();
    const buttons = lastButtons(core.chat, CHAT_THREAD);
    const answeredBefore = stub.ofModel(PRICES_MODEL).filter((request) => request.answered);
    expect(answeredBefore).toHaveLength(JUMP_FLOW_STEPS);

    // Сутки ожидания прошли: срок ответа в записи и срок задачи-таймера - в прошлом.
    await expireHandoffRecord(db, 'answerDeadline');
    await db.query(
      "UPDATE jobs SET due_at = now() - interval '3 hours' " +
        "WHERE name = 'agent.run' AND status = 'pending'",
    );
    await waitFor('сообщение об истёкшем сроке ответа', () =>
      textsTo(core.chat, CHAT_THREAD).some((text) => text.includes('Срок ответа')),
    );
    const [record] = await handoffRecords(db);
    expect(record).toMatchObject({
      id,
      status: 'expired',
      errorCode: 'answer_expired',
      notified: true,
    });
    // Позднее нажатие кнопки: передача закрыта, дочерний тред не возобновляется.
    await pressButton(core.chat, CHAT_THREAD, OK_USER, buttons['Да'] ?? '');
    await settle(QUIET_MS);
    const texts = textsTo(core.chat, CHAT_THREAD);
    expect(
      texts.some((t) => t === CHAT_HANDOFF_CLOSED_TEXT || t === CHAT_HANDOFF_EXPIRED_TEXT),
    ).toBe(true);
    expect(stub.ofModel(PRICES_MODEL)).toHaveLength(JUMP_FLOW_STEPS);
    expect(texts.filter((t) => t.includes('Срок ответа на вопрос помощника'))).toHaveLength(1);
    const child = await core.app.runtime.getThread(handoffThreadId(id));
    expect(child?.status).toBe('suspended'); // тред остался на вопросе и больше не ждёт
    expect((await handoffAudit(db)).filter((e) => e.stage === 'finished')).toHaveLength(1);
    await expectQueueClean();
    expectClean();
  });

  test('ответ после срока, но раньше таймера: отказ «срок истёк», возобновления нет', async () => {
    const { core, id } = await untilQuestion();
    const buttons = lastButtons(core.chat, CHAT_THREAD);
    await expireHandoffRecord(db, 'answerDeadline'); // таймер в очереди ещё не наступил
    const jobsBefore = (await agentRunJobs(db)).length;

    await pressButton(core.chat, CHAT_THREAD, OK_USER, buttons['Да'] ?? '');
    await waitFor('отказ по сроку ответа', () =>
      textsTo(core.chat, CHAT_THREAD).includes(CHAT_HANDOFF_EXPIRED_TEXT),
    );
    await settle(QUIET_MS);
    // Возобновление в очередь не ставилось, ответ не записан, второго хода нет.
    expect((await agentRunJobs(db)).length).toBe(jobsBefore);
    const answers = await db.query(
      "SELECT 1 FROM workflow_state WHERE namespace = 'handoff-answer.v1'",
    );
    expect(answers).toEqual([]);
    expect(stub.ofModel(PRICES_MODEL)).toHaveLength(JUMP_FLOW_STEPS);
    const [record] = await handoffRecords(db);
    expect(record?.id).toBe(id);
    expect(record?.status).toBe('awaiting_human');
    expectClean();
  });
});
