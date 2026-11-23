import { beforeEach, describe, expect, test } from 'bun:test';
import { SUPPLIER_REPLY_WAIT_HOURS, hoursToMs } from '../../src/kit/domain/time';
import {
  ORDER_CALC_DIGEST_PROMPT,
  ORDER_CALC_MAIL_PROMPT,
  ORDER_CALC_PROMPT,
} from '../../src/agents/order-calc/prompt';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { saveSent } from '../../src/agents/order-calc/state';
import { scheduleReminder } from '../../src/agents/order-calc/schedule-reminder';
import { type AgentDeclaration, FILE_TOOL_PROMPT } from '@business-ai/core';
import { SESSION_SUMMARY_PROMPT } from '../../src/agents/shared/legacy-prompts.owned';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const MODEL = 'test-model';
const DEADLINE = Date.parse(ORDER_REQUEST.createdAt);

let deps: OrderTestDeps;
beforeEach(async () => {
  deps = await buildOrderDeps();
  const now = deps.clock.now().toISOString();
  await saveSent(deps, {
    requestId: REQUEST_ID,
    supplierIds: ['s1'],
    sentAt: now,
    sentBySupplier: { s1: now },
  });
});

/** Все задачи планировщика (в далёком будущем), ввод каждой. */
async function allTasks(): Promise<Array<{ input: string; direct?: unknown; runAt: string }>> {
  const horizon = new Date(DEADLINE + hoursToMs(24 * 30));
  const tasks = await deps.scheduler.claimDue(horizon);
  return tasks.map((task) => ({
    ...(JSON.parse(task.payload) as { input: string; direct?: unknown }),
    runAt: task.runAt,
  }));
}

function toolOf(declaration: AgentDeclaration, name: string) {
  const tool = declaration.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`инструмента ${name} нет в декларации`);
  return tool;
}

describe('Напоминание +24 ч: проверок срока ответа не ставит', () => {
  test('ставит одну суточную задачу, повтор не плодит', async () => {
    const out = await scheduleReminder.execute({ requestId: REQUEST_ID }, deps, CTX);
    await scheduleReminder.execute({ requestId: REQUEST_ID }, deps, CTX);
    const expected = deps.clock.now().getTime() + hoursToMs(SUPPLIER_REPLY_WAIT_HOURS);
    expect(out).toEqual({ taskId: expect.any(String), runAt: new Date(expected).toISOString() });
    const tasks = await allTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.input).toContain('прошли сутки');
    expect(tasks[0]?.direct).toBeUndefined();
  });
});

describe('Формулировки напоминаний: запросы подготовлены, а не «ушли»', () => {
  test('ORDER_CALC_DIGEST_PROMPT: текст по ТЗ, без «запросы ушли»', () => {
    expect(ORDER_CALC_DIGEST_PROMPT).toContain('ВСЕМ открытым заказам');
    expect(ORDER_CALC_DIGEST_PROMPT).toContain('запросы подготовлены');
    expect(ORDER_CALC_DIGEST_PROMPT).toContain('Это не зависит от почты');
    expect(ORDER_CALC_DIGEST_PROMPT).not.toMatch(/ушли(?!»)|ушёл/);
  });

  test('+24 ч (режим без сводки): ввод и описание без «отправили», про подготовку', async () => {
    expect(scheduleReminder.description).not.toMatch(/отправк[иа] (письма|запрос)/);
    expect(scheduleReminder.description).toContain('подготовки');
    await scheduleReminder.execute({ requestId: REQUEST_ID }, deps, CTX);
    const reminder = (await allTasks()).find((task) => task.input.includes('прошли сутки'));
    expect(reminder?.input).toContain('после подготовки запросов');
    expect(reminder?.input).not.toContain('отправк');
  });
});

describe('Декларация: опция dailyDigest (только вместе с почтой сотрудников)', () => {
  test('без почты промпт базовый, а сводка и напоминание не объявляются', () => {
    for (const dailyDigest of [false, true]) {
      const declaration = createOrderCalcAgent({ model: MODEL, dailyDigest });
      expect(declaration.prompt).toBe(
        ORDER_CALC_PROMPT + SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT,
      );
      expect(declaration.tools.map((tool) => tool.name)).not.toContain('scheduleReminder');
    }
  });

  test('с почтой без опции промпт и инструмент прежние', () => {
    const declaration = createOrderCalcAgent({ model: MODEL, mailbox: true });
    expect(declaration.prompt).toBe(
      ORDER_CALC_MAIL_PROMPT + SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT,
    );
    expect(toolOf(declaration, 'scheduleReminder').execute).toBe(scheduleReminder.execute);
  });

  test('dailyDigest: дописан ORDER_CALC_DIGEST_PROMPT, основной текст не тронут', () => {
    const declaration = createOrderCalcAgent({
      model: MODEL,
      mailbox: true,
      dailyDigest: true,
    });
    expect(declaration.prompt).toBe(
      ORDER_CALC_MAIL_PROMPT +
        ORDER_CALC_DIGEST_PROMPT +
        SESSION_SUMMARY_PROMPT +
        FILE_TOOL_PROMPT,
    );
    // Суточного напоминания в режиме сводки нет, а ставить больше нечего: инструмента нет.
    expect(declaration.tools.map((tool) => tool.name)).not.toContain('scheduleReminder');
  });

  test('remindManager остаётся в обоих режимах сводки', () => {
    for (const dailyDigest of [false, true]) {
      const declaration = createOrderCalcAgent({ model: MODEL, mailbox: true, dailyDigest });
      expect(declaration.tools.map((tool) => tool.name)).toContain('remindManager');
      expect(declaration.tools.map((tool) => tool.name)).not.toContain('trackSla');
    }
  });
});
