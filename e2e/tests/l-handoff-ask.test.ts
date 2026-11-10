import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { handoffThreadId } from '@business-ai/core';
import { SCHEDULED_RESUME_INPUT } from '@business-ai/core/compose';
import { DualLlmStub, humanTurns, stepInTurn, type DualHandler } from '@business-ai/testing/e2e';
import { e2eEnv, MANAGER_THREAD, openDb } from '../lib/project-env';
import {
  ORDER_CALC_MODEL,
  PRICES_MODEL,
  agentRunJobs,
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
import { userTexts } from '@business-ai/testing/e2e';
import { BUYER_PII, PRICE_FILE_PII } from '../lib/pii.owned';
import { findLeaks, REAL_PERSON, REAL_PHONE } from '@business-ai/testing/e2e';
import { JUMP_FLOW_STEPS, jumpFlowReply, seedJumpyPrices } from '../lib/prices-flow';

/**
 * Сценарий l: вопрос дочернего агента «Актуализация прайса (ИИ агент)» уходит инициатору
 * (HANDOFF_ASK_ENABLED), его
 * ответ (кнопкой или текстом) возобновляет дочерний тред; ядро перезапускается между
 * вопросом и ответом. Вопрос возникает на настоящем инструменте агента «Актуализация прайса (ИИ
 * агент)» - запросе решения по прайсу неподтверждённого отправителя
 * (`askToConfirmUnverifiedPrice`, снят 26.10.2026: сценарий отключён), прайс разбирается
 * настоящим сервисом документов.
 */

const EMPLOYEE = 'emp-e2e-l';
const CHAT_THREAD = 'e2e-l-chat';
const REQUEST_ID = 'req-e2e-l';
const POSITION = 'Арматура А500С d12';
const EMPLOYEE_TEXT = `Освежи цены по заявке ${REQUEST_ID}: ${POSITION} для ${REAL_PERSON}`;
const PARENT_FINAL = 'Передал задачу агенту «Актуализация прайса (ИИ агент)».';
const CHILD_FINAL = 'Скачки приняты в расчёт, цены по позиции подтверждены.';
const QUESTION_MARK = 'просит уточнить';
const RESULT_MARK = 'выполнил переданную задачу';
const QUIET_MS = 2_000;
const YES_LABEL = 'Да';
/** Ответы дочернего агента: пять шагов инструментов и итог после возобновления. */
const CHILD_ANSWERED = JUMP_FLOW_STEPS + 1;

const stub = new DualLlmStub();
let db: PgClient;
let accessFile = '';
const cores: Core[] = [];

const script: DualHandler = ({ model, raw, body }) => {
  if (model === ORDER_CALC_MODEL) {
    if (stepInTurn(body) > 0) return { kind: 'text', text: PARENT_FINAL };
    return parentHandoffReply(raw, 'handoffToPrices', REQUEST_ID, POSITION);
  }
  if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
  // Вторая реплика человека в дочернем треде - ответ инициатора: даём итог.
  if (humanTurns(body) >= 2) return { kind: 'text', text: CHILD_FINAL };
  return jumpFlowReply(stepInTurn(body), body, db);
};

async function start(chat?: Core['chat']): Promise<Core> {
  const core = await startCore({
    accessFile,
    env: { HANDOFF_ASK_ENABLED: 'true' },
    ...(chat === undefined ? {} : { chat }),
  });
  cores.push(core);
  return core;
}

/** Довести сценарий до вопроса человеку; возвращает ядро, id передачи и кнопки вопроса. */
async function untilQuestion(core: Core): Promise<{ id: string; buttons: Record<string, string> }> {
  await sendText(core.chat, CHAT_THREAD, EMPLOYEE, EMPLOYEE_TEXT);
  await waitForText('вопрос дочернего агента в чате', core.chat, CHAT_THREAD, QUESTION_MARK);
  const [record] = await handoffRecords(db);
  expect(record).toMatchObject({ status: 'awaiting_human', round: 1, userId: EMPLOYEE });
  expect(record?.questionThreadId).toBe(CHAT_THREAD);
  // Вопрос ушёл с кнопками; сам тред дочернего агента приостановлен, а не закрыт.
  const buttons = lastButtons(core.chat, CHAT_THREAD);
  expect(Object.keys(buttons).sort()).toEqual(['Да', 'Нет']);
  const child = await core.app.runtime.getThread(handoffThreadId(record?.id ?? ''));
  expect(child?.status).toBe('suspended');
  expect(stub.ofModel(PRICES_MODEL).filter((request) => request.answered)).toHaveLength(
    JUMP_FLOW_STEPS,
  );
  // Итога ещё нет: инициатору обещано только ожидание ответа.
  const early = textsTo(core.chat, CHAT_THREAD).filter((text) => text.includes(RESULT_MARK));
  expect(early).toEqual([]);
  return { id: record?.id ?? '', buttons };
}

/** Проверки после завершения: один итог, один возобновлённый ход, нет ПДн в трафике и очереди. */
async function expectResumedOnce(
  chats: Core['chat'][],
  id: string,
  answerText: string,
): Promise<void> {
  const results = chats
    .flatMap((chat) => textsTo(chat, CHAT_THREAD))
    .filter((text) => text.includes(RESULT_MARK));
  expect(results).toHaveLength(1);
  expect(results[0]).toContain(CHILD_FINAL);
  const [record] = await handoffRecords(db);
  expect(record).toMatchObject({ id, status: 'done', round: 1, notified: true });
  expect(record?.output).toBe(CHILD_FINAL);
  const child = await cores.at(-1)?.app.runtime.getThread(handoffThreadId(id));
  expect(child?.status).toBe('completed');

  // Дочерний ход после ответа продолжен, а не начат заново: пять инструментов и один итог.
  const childRequests = stub.ofModel(PRICES_MODEL);
  expect(childRequests.filter((request) => request.answered)).toHaveLength(CHILD_ANSWERED);
  expect(childRequests).toHaveLength(CHILD_ANSWERED);
  const last = JSON.parse(childRequests.at(-1)?.raw ?? '{}') as Record<string, unknown>;
  expect(userTexts(last).at(-1)).toContain(answerText);

  const audit = await handoffAudit(db);
  expect(audit.map((entry) => `${entry.stage}:${entry.result}`)).toEqual([
    'queued:queued',
    'awaiting:awaiting_human',
    'answered:answered',
    'finished:done',
  ]);

  // Очередь: стартовая задача, таймер срока ответа и возобновление; только идентификаторы.
  const jobs = await agentRunJobs(db);
  expect(jobs.length).toBeGreaterThanOrEqual(2);
  expect(jobs.filter((job) => job.status === 'failed')).toEqual([]);
  for (const job of jobs) {
    // Ввод в задаче пуст либо общая фраза возобновления: текст ответа в очередь не попадает.
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    expect(payload['agentId']).toBe('prices');
    expect(['', SCHEDULED_RESUME_INPUT]).toContain(String(payload['input']));
    for (const secret of ['Сидоров', '555', POSITION, REQUEST_ID]) {
      expect(job.payload).not.toContain(secret);
    }
  }
  // Текст ответа стёрт после использования: в состоянии остаётся только отметка.
  const answers = await db.query(
    "SELECT value::text AS value FROM workflow_state WHERE namespace = 'handoff-answer.v1'",
  );
  expect(answers).toHaveLength(1);
  const stored = JSON.parse(String(answers[0]?.['value'])) as Record<string, unknown>;
  expect(stored['text']).toBe('');
  expect(stored['consumedAt']).toBeDefined();
  expect(String(answers[0]?.['value'])).not.toContain('Сидоров');

  // Исходящий трафик к модели: ни ПДн клиента и ответа, ни ПДн из файла прайса.
  expect(stub.errors).toEqual([]);
  expect(findLeaks(stub.bodies(), BUYER_PII)).toEqual([]);
  expect(findLeaks(stub.bodies(), PRICE_FILE_PII)).toEqual([]);
  expect(stub.bodies().join('\n')).not.toContain('555-12-34');
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  accessFile = await writeAccessRules('l', { 'order-calc': [EMPLOYEE], prices: [EMPLOYEE] });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  await seedJumpyPrices(db);
  stub.begin(script);
});

afterEach(async () => {
  for (const core of cores.splice(0)) await core.dispose();
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

// Вопрос дочернего агента задавал инструмент askToConfirmUnverifiedPrice; подтверждение прайса
// снято (решение владельца 26.10.2026), других инструментов-вопросов у агента «Актуализация
// прайса (ИИ агент)» нет. Сценарий ждёт переноса на вопрос другого агента.
describe.skip('сценарий l: вопрос дочернего агента человеку и возобновление', () => {
  test('кнопка «Да» после перезапуска ядра между вопросом и ответом', async () => {
    const first = await start();
    const { id, buttons } = await untilQuestion(first);
    // Вопрос ждёт ответа сутки: таймер срока стоит в очереди, а не исполняется сразу.
    const timers = (await agentRunJobs(db)).filter((job) => job.status === 'pending');
    expect(timers).toHaveLength(1);

    await first.stop(); // штатный перезапуск: приложение пересобирается на той же БД
    const second = await start();
    const [reread] = await handoffRecords(db);
    expect(reread).toMatchObject({ id, status: 'awaiting_human', round: 1 });

    const buttonId = buttons[YES_LABEL] ?? '';
    await pressButton(second.chat, CHAT_THREAD, EMPLOYEE, buttonId);
    await waitForText('итог после ответа кнопкой', second.chat, CHAT_THREAD, RESULT_MARK);
    // Повторное нажатие той же кнопки второго хода не запускает.
    await pressButton(second.chat, CHAT_THREAD, EMPLOYEE, buttonId);
    await settle(QUIET_MS);
    await expectResumedOnce([first.chat, second.chat], id, YES_LABEL);
    // Нажавшему сказано, что ответ принят; о повторе - «принят ранее» либо «закрыта».
    const replies = textsTo(second.chat, CHAT_THREAD);
    expect(replies.some((text) => text.includes('Ответ'))).toBe(true);
    // Запрос решения по прайсу неподтверждённого отправителя ушёл владельцу импорта (сотрудник,
    // чья передача начала работу, - тред CHAT_THREAD) один раз; менеджеру он не уходит.
    const isAsk = (text: string): boolean => text.includes('неподтверждённого отправителя');
    const asked = textsTo(first.chat, CHAT_THREAD).filter(isAsk);
    expect(asked).toHaveLength(1);
    const toManager = textsTo(first.chat, MANAGER_THREAD).filter(isAsk);
    expect(toManager).toEqual([]);
  });

  test('текстовый ответ с ПДн после падения процесса: текст не течёт в очередь', async () => {
    const first = await start();
    const { id } = await untilQuestion(first);
    await first.crash(); // процесс умер: ожидание ответа живёт только в БД

    const second = await start();
    const answer = `Да, согласовано с ${REAL_PERSON}, тел. ${REAL_PHONE}`;
    await sendText(second.chat, CHAT_THREAD, EMPLOYEE, answer);
    await waitForText('итог после текстового ответа', second.chat, CHAT_THREAD, RESULT_MARK);
    await settle(QUIET_MS);
    await expectResumedOnce([first.chat, second.chat], id, 'Да');
    // Ответ ушёл дочернему агенту, а не родителю: родитель отвечал только на исходную просьбу.
    expect(stub.ofModel(ORDER_CALC_MODEL)).toHaveLength(2);
  });
});
