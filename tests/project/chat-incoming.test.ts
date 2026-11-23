import { describe, expect, test } from 'bun:test';
import { MemoryAuditRepository, MemoryWorkflowStateStore } from '@business-ai/adapters';
import type { AccessPolicy, ChatEvent } from '@business-ai/core';
import type { ChatIncomingServices } from '@business-ai/core/compose';
import { DOCUMENTS_AGENT_ID } from '../../src/agents/documents/deps';
import { readEmployeeText } from '../../src/agents/documents/employee-messages';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import { projectOnIncoming } from '../../src/chat-hooks';
import { pragmatikaProject } from '../../src/project';
import {
  RecordingChannel,
  TEST_USER_ID,
  buildPump,
  messageEvent,
  recordingRuntime,
} from './chat-support';

/** Один бот на документы, второй на заказы. */
const BOTS = { docs: DOCUMENTS_AGENT_ID, orders: ORDER_CALC_AGENT_ID };
const DOCS_THREAD = `docs/${TEST_USER_ID}`;
const ORDERS_THREAD = `orders/${TEST_USER_ID}`;
const DOCS = { threadId: DOCS_THREAD, botId: 'docs' } as const;

/** Что хук получает от насоса: хранилище, агент и журнал. */
function services(agentId: string, state = new MemoryWorkflowStateStore()) {
  const logs: string[] = [];
  const given: ChatIncomingServices = {
    state,
    agentId,
    log: (event) => {
      logs.push(event);
    },
  };
  return { given, state, logs };
}

/** Событие-сообщение для хука (тип сужен до `message`). */
function incoming(text: string, extra: Parameters<typeof messageEvent>[1] = {}) {
  return messageEvent(text, extra) as Extract<ChatEvent, { kind: 'message' }>;
}

describe('манифест: текст сотрудника через chat.onIncoming', () => {
  test('хук подключён в манифесте, моста канала в портах нет', () => {
    expect(pragmatikaProject.chat.onIncoming).toBe(projectOnIncoming);
  });
});

describe('projectOnIncoming: текст сотрудника для агента документов', () => {
  test('сообщение агенту документов запоминается в состоянии треда', async () => {
    const { given, state } = services(DOCUMENTS_AGENT_ID);
    const text = 'Подписант у них Сидоров Сергей Петрович';
    await projectOnIncoming(incoming(text, DOCS), given);
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe(text.toLowerCase());
  });

  test('другой агент, пустой userId, пустой текст: записи нет', async () => {
    const other = services(ORDER_CALC_AGENT_ID);
    await projectOnIncoming(incoming('текст', DOCS), other.given);
    expect(await readEmployeeText(other.state, DOCS_THREAD)).toBe('');
    const docs = services(DOCUMENTS_AGENT_ID);
    await projectOnIncoming(incoming('текст', { ...DOCS, userId: '' }), docs.given);
    await projectOnIncoming(incoming('   ', DOCS), docs.given);
    expect(await readEmployeeText(docs.state, DOCS_THREAD)).toBe('');
  });

  test('сбой хранилища не ловится хуком: это делает платформа', async () => {
    const failing = new MemoryWorkflowStateStore();
    failing.get = async () => {
      throw new TypeError('секретный текст сбоя');
    };
    const { given, logs } = services(DOCUMENTS_AGENT_ID, failing);
    await expect(projectOnIncoming(incoming('Подписант Иванов', DOCS), given)).rejects.toThrow(
      TypeError,
    );
    expect(logs).toEqual([]);
  });
});

describe('насос чата: агент видит записанный текст уже на первом вызове', () => {
  test('сообщение агенту документов: запись до хода, другому агенту записи нет', async () => {
    const state = new MemoryWorkflowStateStore();
    const channel = new RecordingChannel();
    const seenByAgent: Record<string, string> = {};
    const { runtime, inputs } = recordingRuntime(async ({ threadId }) => {
      seenByAgent[threadId] = await readEmployeeText(state, threadId);
    });
    const pump = buildPump({
      channel,
      runtime,
      state,
      agent: ORDER_CALC_AGENT_ID,
      bots: BOTS,
      onIncoming: projectOnIncoming,
    });
    const text = 'Подготовь договор, ИНН 7707083893';
    await channel.emit(messageEvent(text, DOCS));
    await channel.emit(messageEvent('про заказ', { threadId: ORDERS_THREAD, botId: 'orders' }));
    await pump.whenIdle();
    expect(inputs.map((item) => item.agentId).sort()).toEqual(
      [DOCUMENTS_AGENT_ID, ORDER_CALC_AGENT_ID].sort(),
    );
    expect(seenByAgent[DOCS_THREAD]).toBe(text.toLowerCase());
    expect(seenByAgent[ORDERS_THREAD]).toBe('');
  });

  test('агент треда определяет платформа: бот по умолчанию без таблицы ботов', async () => {
    const state = new MemoryWorkflowStateStore();
    const channel = new RecordingChannel();
    const { runtime } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      state,
      agent: DOCUMENTS_AGENT_ID,
      onIncoming: projectOnIncoming,
    });
    await channel.emit(messageEvent('Директор Петров', { threadId: DOCS_THREAD }));
    await pump.whenIdle();
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('директор петров');
  });

  test('отказ в доступе: текст не записывается (раньше запись шла до проверки)', async () => {
    const state = new MemoryWorkflowStateStore();
    const channel = new RecordingChannel();
    const { runtime, inputs } = recordingRuntime();
    const closed: AccessPolicy = {
      isAllowed: async () => false,
      decide: async () => ({ allowed: false, reason: 'not_in_allow_list', message: '' }),
    };
    const pump = buildPump({
      channel,
      runtime,
      state,
      audit: new MemoryAuditRepository(),
      access: closed,
      agent: ORDER_CALC_AGENT_ID,
      bots: BOTS,
      onIncoming: projectOnIncoming,
    });
    await channel.emit(messageEvent('Подписант Иванов', DOCS));
    await pump.whenIdle();
    expect(inputs).toEqual([]);
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('');
  });

  test('чужой сотрудник в треде связки не записывается', async () => {
    const state = new MemoryWorkflowStateStore();
    const channel = new RecordingChannel();
    const { runtime } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      state,
      agent: ORDER_CALC_AGENT_ID,
      bots: BOTS,
      onIncoming: projectOnIncoming,
    });
    await channel.emit(messageEvent('текст', { ...DOCS, userId: 'u-999' }));
    await pump.whenIdle();
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('');
  });

  test('кнопка не попадает в хук и текст не записывает', async () => {
    const state = new MemoryWorkflowStateStore();
    const channel = new RecordingChannel();
    const { runtime } = recordingRuntime();
    const calls: string[] = [];
    const pump = buildPump({
      channel,
      runtime,
      state,
      agent: ORDER_CALC_AGENT_ID,
      bots: BOTS,
      onIncoming: async (event, given) => {
        calls.push(event.kind);
        await projectOnIncoming(event, given);
      },
    });
    await channel.emit({ kind: 'button', userId: TEST_USER_ID, buttonId: 'x', ...DOCS });
    await pump.whenIdle();
    expect(calls).toEqual([]);
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('');
  });

  test('сбой записи: платформа пишет chat_hook_failed с кодом, ход идёт', async () => {
    const state = new MemoryWorkflowStateStore();
    const realGet = state.get.bind(state);
    state.get = async (namespace, key) => {
      if (namespace === 'documents:employee-text') throw new TypeError('секретный текст сбоя');
      return realGet(namespace, key);
    };
    const logs: Array<{ event: string; fields: unknown }> = [];
    const channel = new RecordingChannel();
    const { runtime, inputs } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      state,
      agent: ORDER_CALC_AGENT_ID,
      bots: BOTS,
      onIncoming: projectOnIncoming,
      log: (event, fields) => {
        logs.push({ event, fields });
      },
    });
    await channel.emit(messageEvent('Подписант Иванов', DOCS));
    await pump.whenIdle();
    expect(inputs).toHaveLength(1);
    const failed = logs.filter((item) => item.event === 'chat_hook_failed');
    expect(failed).toEqual([
      { event: 'chat_hook_failed', fields: { hook: 'onIncoming', code: 'unexpected' } },
    ]);
    expect(JSON.stringify(logs)).not.toContain('секретный');
  });
});
