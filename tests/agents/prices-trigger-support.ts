import { FixedClock } from '@business-ai/adapters';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { createToolContext, recordEmployeeContact, type ToolContext } from '@business-ai/core';
import type { InboxMessage } from '@business-ai/core';
import {
  SUPPLIER_EMAIL,
  USER_1,
  USER_2,
  USER_THREAD_1,
  USER_THREAD_2,
  buildMailboxPricesDeps,
  employeeContext,
  mailMessage,
} from './prices-support';

/** Пояс бизнеса в тестах. */
export const BUSINESS_ZONE = 'Europe/Moscow';
/** Понедельник 12:00 по Москве: после часа проверки. */
export const MONDAY_NOON = new Date('2026-10-12T09:00:00.000Z');
/** Письмо, полученное накануне (моложе предела возраста). */
export const RECENT_RECEIVED_AT = '2026-10-11T10:00:00.000Z';
/** Бот «Актуализация прайса (ИИ агент)» в тестах (режим нескольких ботов). */
export const PRICES_BOT_ID = 'prices-bot';

export type TriggerDeps = Awaited<ReturnType<typeof buildTriggerDeps>>;

/**
 * Зависимости агента «Актуализация прайса (ИИ агент)» с ящиками двух сотрудников, часами
 * `FixedClock` и реестром: оба
 * сотрудника уже писали боту «Актуализация прайса (ИИ агент)».
 */
export async function buildTriggerDeps(start: Date = MONDAY_NOON) {
  const base = await buildMailboxPricesDeps();
  const clock = new FixedClock(start);
  const deps = { ...base, clock };
  for (const [userId, threadId] of [
    [USER_1, USER_THREAD_1],
    [USER_2, USER_THREAD_2],
  ] as const) {
    await recordEmployeeContact(
      deps.state,
      clock,
      { threadId, userId, botId: PRICES_BOT_ID },
      PRICES_AGENT_ID,
    );
  }
  return deps;
}

/** Письмо поставщика с подтверждённым отправителем и словом-триггером в теме. */
export function triggerMail(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return mailMessage({
    id,
    from: SUPPLIER_EMAIL,
    subject: 'Повышение цен с 1 ноября',
    body: 'Уважаемые партнёры, сообщаем об изменении условий.',
    receivedAt: RECENT_RECEIVED_AT,
    senderAuth: 'verified',
    ...overrides,
  });
}

/** Контексты ходов сотрудников. */
export const ctxOf = (userId: string, threadId: string): ToolContext =>
  employeeContext(userId, threadId);

/** Контекст планового запуска. */
export const schedulerContext = (): ToolContext =>
  createToolContext({
    threadId: 'prices-monitoring',
    agentId: PRICES_AGENT_ID,
    operationId: 'op-monitoring',
    initiator: { kind: 'scheduler' },
  });
