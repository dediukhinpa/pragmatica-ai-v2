import { z } from 'zod';
import { SUPPLIER_REPLY_WAIT_HOURS, hoursToMs } from '../../kit/domain/time';
import { type ValidationIssue } from '@business-ai/core';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { predecessorOf } from '@business-ai/core';
import {
  AGENT_RUN_TASK_NAME,
  ORDER_CALC_AGENT_ID,
  reminderThreadId,
  type OrderCalcDeps,
} from './deps';
import { assertOrderOwner } from './order-access';
import { loadSent, type SentRecord } from './state';

interface ScheduleInput {
  requestId: string;
}
interface ScheduleOutput {
  taskId: string;
  runAt: string;
}

const inputSchema = z.object({ requestId: z.string().min(1) });

/** Текст ввода для агента при срабатывании напоминания. */
function reminderInput(requestId: string): string {
  return (
    `Напоминание: по заявке ${requestId} прошли сутки после подготовки запросов поставщикам. ` +
    `Вызови remindManager с requestId=${requestId}.`
  );
}

/** Напоминание имеет смысл только после подготовки запросов. */
export const reminderValidator: AgentValidator<OrderCalcDeps> = schemaValidator({
  name: 'reminder-after-send',
  tool: 'scheduleReminder',
  schema: inputSchema,
  async check(input, deps) {
    const sent = await loadSent(deps, input.requestId);
    if (sent === null) {
      return [
        {
          code: 'requests_not_sent',
          message: 'Запросы поставщикам по заявке ещё не подготовлены: напоминать не о чем.',
        },
      ];
    }
    return [];
  },
});

const outputSchema = z.object({ taskId: z.string(), runAt: z.string() });

/** Запланировать напоминание менеджеру через сутки после подготовки запросов. */
export const scheduleReminder = defineTool<ScheduleInput, ScheduleOutput, OrderCalcDeps>({
  name: 'scheduleReminder',
  description:
    'Запланировать на +24 часа напоминание менеджеру по закупу проверить статус ответов ' +
    'поставщиков по заявке requestId. Вызывай после подготовки текста запроса поставщикам. ' +
    'Повтор не создаёт вторую задачу.',
  sideEffect: true,
  inputSchema,
  outputSchema,
  idempotencyKey: (input) => reminderKey(input.requestId),
  idempotencyPredecessor: async (input, deps) =>
    predecessorOf(reminderRound(await loadSent(deps, input.requestId))),
  async execute(input, deps, context) {
    await assertOrderOwner(deps, input.requestId, context);
    const round = reminderRound(await loadSent(deps, input.requestId));
    const runAt = new Date(deps.clock.now().getTime() + hoursToMs(SUPPLIER_REPLY_WAIT_HOURS));
    const payload = JSON.stringify({
      agentId: ORDER_CALC_AGENT_ID,
      threadId: reminderThreadId(input.requestId),
      input: reminderInput(input.requestId),
    });
    const task = await deps.scheduler.schedule(
      AGENT_RUN_TASK_NAME,
      payload,
      runAt,
      reminderKey(input.requestId, round),
    );
    return { taskId: task.id, runAt: task.runAt };
  },
});

/**
 * Раунд рассылки: кому и когда ушёл первый запрос. Новый адресат после появления контакта -
 * новый раунд и новое напоминание; повтор вызова в том же раунде задачу не плодит.
 */
export function reminderRound(sent: SentRecord | null): unknown {
  return sent === null ? null : sent.sentBySupplier;
}

function reminderKey(requestId: string, round?: unknown): string {
  const base = `order-reminder:${requestId}`;
  return round === undefined ? base : `${base}:${predecessorOf(round)}`;
}
