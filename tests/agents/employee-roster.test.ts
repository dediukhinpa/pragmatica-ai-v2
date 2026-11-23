import { describe, expect, test } from 'bun:test';
import { FixedClock, MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  CHAT_ROSTER_NAMESPACE,
  ROSTER_REWRITE_INTERVAL_MS,
  listEmployees,
  recordEmployeeContact,
} from '@business-ai/core';

const START = new Date('2026-10-12T09:00:00.000Z');
const EVENT = { threadId: 'bot/u1', userId: 'u1', botId: 'bot' };

describe('реестр обращений', () => {
  test('записывает идентификаторы и показывает сотрудника агента', async () => {
    const state = new MemoryWorkflowStateStore();
    const clock = new FixedClock(START);
    await recordEmployeeContact(state, clock, EVENT, 'prices');
    expect(await state.get(CHAT_ROSTER_NAMESPACE, 'bot/u1')).toEqual({
      agentId: 'prices',
      userId: 'u1',
      botId: 'bot',
      firstSeenAt: START.toISOString(),
      lastSeenAt: START.toISOString(),
    });
    expect(await listEmployees(state, 'prices')).toEqual([
      {
        threadId: 'bot/u1',
        agentId: 'prices',
        userId: 'u1',
        botId: 'bot',
        firstSeenAt: START.toISOString(),
        lastSeenAt: START.toISOString(),
      },
    ]);
    expect(await listEmployees(state, 'order-calc')).toEqual([]);
  });

  test('перезапись не чаще суток, firstSeenAt сохраняется', async () => {
    const state = new MemoryWorkflowStateStore();
    const clock = new FixedClock(START);
    await recordEmployeeContact(state, clock, EVENT, 'prices');
    clock.advance(ROSTER_REWRITE_INTERVAL_MS - 1);
    await recordEmployeeContact(state, clock, EVENT, 'prices');
    expect((await listEmployees(state, 'prices'))[0]?.lastSeenAt).toBe(START.toISOString());
    clock.advance(1);
    await recordEmployeeContact(state, clock, EVENT, 'prices');
    const [entry] = await listEmployees(state, 'prices');
    expect(entry?.firstSeenAt).toBe(START.toISOString());
    expect(entry?.lastSeenAt).toBe(clock.now().toISOString());
  });

  test('событие без сотрудника или треда не записывается', async () => {
    const state = new MemoryWorkflowStateStore();
    const clock = new FixedClock(START);
    await recordEmployeeContact(state, clock, { threadId: 't', userId: '' }, 'prices');
    await recordEmployeeContact(state, clock, { threadId: ' ', userId: 'u1' }, 'prices');
    expect(await listEmployees(state, 'prices')).toEqual([]);
  });

  test('повреждённая запись не мешает остальным', async () => {
    const state = new MemoryWorkflowStateStore();
    const clock = new FixedClock(START);
    await state.put(CHAT_ROSTER_NAMESPACE, 'a-broken', { agentId: 1 });
    await recordEmployeeContact(state, clock, EVENT, 'prices');
    expect((await listEmployees(state, 'prices')).map((e) => e.userId)).toEqual(['u1']);
  });

  test('тред сменил агента: запись переписывается сразу', async () => {
    const state = new MemoryWorkflowStateStore();
    const clock = new FixedClock(START);
    await recordEmployeeContact(state, clock, EVENT, 'prices');
    await recordEmployeeContact(state, clock, EVENT, 'order-calc');
    expect(await listEmployees(state, 'prices')).toEqual([]);
    expect((await listEmployees(state, 'order-calc')).map((e) => e.userId)).toEqual(['u1']);
  });
});
