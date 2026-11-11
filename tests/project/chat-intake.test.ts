import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryChatChannel,
  MemoryIdempotencyStore,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { ChatEventNotAcceptedError, type ChatChannel, type ChatEvent } from '@business-ai/core';
import type { ChatChannelPorts } from '@business-ai/core/compose';
import { startKit, type Bitrix24Kit } from '@business-ai/testing';
import { DOCUMENTS_AGENT_ID } from '../../src/agents/documents/deps';
import { readEmployeeText } from '../../src/agents/documents/employee-messages';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import { pragmatikaProject } from '../../src/project';
import {
  bridgeChatFromPorts,
  installChatBridge,
  interceptEmployeeMessage,
  resolveEventAgent,
  wrapChatChannel,
  type AgentTable,
  type ChatIntakeDeps,
} from '../../src/chat-intake';
import { clearChatLauncher } from '../../src/chat-launch';
import {
  buildPump,
  messageEvent,
  recordingRuntime,
  RecordingChannel,
  TEST_USER_ID,
} from './chat-support';

afterEach(() => {
  clearChatLauncher();
});

/** Один бот на документы, второй на заказы; агент по умолчанию - заказы. */
const TABLE: AgentTable = {
  chatAgentId: ORDER_CALC_AGENT_ID,
  chatBots: { docs: DOCUMENTS_AGENT_ID, orders: ORDER_CALC_AGENT_ID },
};
const DOCS_THREAD = `docs/${TEST_USER_ID}`;
const ORDERS_THREAD = `orders/${TEST_USER_ID}`;

function deps(state = new MemoryWorkflowStateStore()) {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const intake: ChatIntakeDeps = {
    state,
    agents: TABLE,
    log: (event, fields) => {
      logs.push({ event, fields });
    },
  };
  return { intake, state, logs };
}

describe('resolveEventAgent: агент события так же, как в насосе чата', () => {
  test('таблицы ботов нет: всегда агент по умолчанию', () => {
    const single: AgentTable = { chatAgentId: DOCUMENTS_AGENT_ID };
    expect(resolveEventAgent(messageEvent('x', { threadId: 't1' }), single)).toBe(
      DOCUMENTS_AGENT_ID,
    );
    expect(resolveEventAgent(messageEvent('x', { threadId: 't1', botId: 'any' }), single)).toBe(
      DOCUMENTS_AGENT_ID,
    );
  });

  test('несколько ботов: агент по botId, без botId - по умолчанию', () => {
    const docs = messageEvent('x', { threadId: DOCS_THREAD, botId: 'docs' });
    expect(resolveEventAgent(docs, TABLE)).toBe(DOCUMENTS_AGENT_ID);
    const plain = messageEvent('x', { threadId: 't1' });
    expect(resolveEventAgent(plain, TABLE)).toBe(ORDER_CALC_AGENT_ID);
  });

  test('неизвестный бот, чужой бот в треде и чужой сотрудник в треде: агента нет', () => {
    const unknown = messageEvent('x', { threadId: 'ghost/u-100', botId: 'ghost' });
    expect(resolveEventAgent(unknown, TABLE)).toBeUndefined();
    const mismatch = messageEvent('x', { threadId: ORDERS_THREAD, botId: 'docs' });
    expect(resolveEventAgent(mismatch, TABLE)).toBeUndefined();
    const stranger = messageEvent('x', { threadId: DOCS_THREAD, botId: 'docs', userId: 'u-999' });
    expect(resolveEventAgent(stranger, TABLE)).toBeUndefined();
    // Несколько ботов, а тред не в формате связки: насос такой тред не принимает.
    const loose = messageEvent('x', { threadId: 'flat-thread', botId: 'docs' });
    expect(resolveEventAgent(loose, TABLE)).toBeUndefined();
  });
});

describe('interceptEmployeeMessage: текст сотрудника для агента документов', () => {
  test('сообщение агенту документов запоминается в состоянии треда', async () => {
    const { intake, state } = deps();
    const text = 'Подписант у них Сидоров Сергей Петрович';
    await interceptEmployeeMessage(
      messageEvent(text, { threadId: DOCS_THREAD, botId: 'docs' }),
      intake,
    );
    const stored = await readEmployeeText(state, DOCS_THREAD);
    expect(stored).toBe(text.toLowerCase());
  });

  test('пустой userId, не агент документов, не сообщение, пустой текст: записи нет', async () => {
    const { intake, state } = deps();
    const docs = { threadId: DOCS_THREAD, botId: 'docs' };
    await interceptEmployeeMessage(messageEvent('текст', { ...docs, userId: '' }), intake);
    await interceptEmployeeMessage(
      messageEvent('текст', { threadId: ORDERS_THREAD, botId: 'orders' }),
      intake,
    );
    const button: ChatEvent = { kind: 'button', buttonId: 'x', userId: TEST_USER_ID, ...docs };
    await interceptEmployeeMessage(button, intake);
    await interceptEmployeeMessage(messageEvent('   ', docs), intake);
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('');
    expect(await readEmployeeText(state, ORDERS_THREAD)).toBe('');
  });

  test('сбой хранилища не бросается: в журнал уходит только код', async () => {
    const failing = new MemoryWorkflowStateStore();
    failing.get = async () => {
      throw new TypeError('секретный текст сбоя');
    };
    const { intake, logs } = deps(failing);
    const event = messageEvent('Подписант Иванов', { threadId: DOCS_THREAD, botId: 'docs' });
    await interceptEmployeeMessage(event, intake);
    expect(logs).toEqual([{ event: 'chat_employee_text_failed', fields: { code: 'TypeError' } }]);
  });
});

/** Канал-основа с признаком типа: проверяет, что обёртка не подменяет экземпляр. */
class TaggedChannel extends RecordingChannel {
  readonly tag = 'bitrix-like';
}

describe('wrapChatChannel: перехват перед насосом', () => {
  test('экземпляр и его класс сохраняются, насос получает то же событие', async () => {
    const { intake, state } = deps();
    const channel = new TaggedChannel();
    const wrapped = wrapChatChannel(channel, intake);
    expect(wrapped).toBe(channel);
    expect(wrapped instanceof TaggedChannel).toBe(true);
    const received: ChatEvent[] = [];
    let noteBeforePump = '';
    wrapped.onEvent(async (event) => {
      // К моменту вызова насоса текст уже записан: агент видит его на первом же вызове.
      noteBeforePump = await readEmployeeText(state, DOCS_THREAD);
      received.push(event);
    });
    const event = messageEvent('ИНН 7707083893', { threadId: DOCS_THREAD, botId: 'docs' });
    await channel.emit(event);
    expect(received).toEqual([event]);
    expect(noteBeforePump).toBe('инн 7707083893');
  });

  test('отказ насоса принять событие доходит до канала без изменений', async () => {
    const { intake } = deps();
    const channel = new RecordingChannel();
    wrapChatChannel(channel, intake).onEvent(async () => {
      throw new ChatEventNotAcceptedError('busy');
    });
    const event = messageEvent('текст', { threadId: DOCS_THREAD, botId: 'docs' });
    await expect(channel.emit(event)).rejects.toMatchObject({ reason: 'busy' });
  });

  test('сбой перехвата не мешает насосу получить событие', async () => {
    const failing = new MemoryWorkflowStateStore();
    failing.get = async () => {
      throw new Error('нет базы');
    };
    const { intake } = deps(failing);
    const channel = new RecordingChannel();
    const received: ChatEvent[] = [];
    wrapChatChannel(channel, intake).onEvent(async (event) => {
      received.push(event);
    });
    await channel.emit(messageEvent('текст', { threadId: DOCS_THREAD, botId: 'docs' }));
    expect(received).toHaveLength(1);
  });

  test('повторная установка на тот же канал не удваивает запись', async () => {
    const { intake, state } = deps();
    const channel = new RecordingChannel();
    wrapChatChannel(channel, intake);
    wrapChatChannel(channel, intake);
    channel.onEvent(async () => undefined);
    await channel.emit(messageEvent('раз', { threadId: DOCS_THREAD, botId: 'docs' }));
    await channel.emit(messageEvent('два', { threadId: DOCS_THREAD, botId: 'docs' }));
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('раз\nдва');
  });
});

describe('installChatBridge: подмена фабрики канала в интеграциях портала', () => {
  test('фабрика отдаёт тот же класс канала, состояние берётся из портов сборки', async () => {
    const created: MemoryChatChannel[] = [];
    const portal = {
      chat: (_ports: ChatChannelPorts): MemoryChatChannel => {
        const channel = new MemoryChatChannel();
        created.push(channel);
        return channel;
      },
    };
    installChatBridge(portal, { agents: TABLE });
    const state = new MemoryWorkflowStateStore();
    const channel = portal.chat({ state, idempotency: new MemoryIdempotencyStore() });
    expect(created).toEqual([channel]);
    expect(channel instanceof MemoryChatChannel).toBe(true);
    const received: ChatEvent[] = [];
    channel.onEvent(async (event) => {
      received.push(event);
    });
    await channel.emit(messageEvent('Директор Петров', { threadId: DOCS_THREAD, botId: 'docs' }));
    expect(received).toHaveLength(1);
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('директор петров');
  });
});

describe('канал Bitrix24 на заглушке портала', () => {
  let kit: Bitrix24Kit | undefined;
  afterEach(async () => {
    await kit?.close();
    kit = undefined;
  });

  test('сообщение сотрудника из портала: запись в состоянии, насос получает событие', async () => {
    kit = await startKit();
    const [first, second] = kit.stub.botKeys();
    if (first === undefined || second === undefined) throw new Error('в заглушке нет ботов');
    const table: AgentTable = {
      chatAgentId: ORDER_CALC_AGENT_ID,
      chatBots: { [first]: DOCUMENTS_AGENT_ID, [second]: ORDER_CALC_AGENT_ID },
    };
    const factory = installBitrixFactory(kit, table);
    const channel = factory({ state: kit.state, idempotency: kit.idempotency });
    const received: ChatEvent[] = [];
    channel.onEvent(async (event) => {
      received.push(event);
    });
    const text = 'Подписант: Сидоров Сергей Петрович';
    kit.stub.enqueueMessage(first, { userId: 501, text });
    kit.stub.enqueueMessage(second, { userId: 501, text: 'про заказ' });
    await channel.pollOnce();
    expect(received.map((event) => event.kind)).toEqual(['message', 'message']);
    expect(await readEmployeeText(kit.state, `${first}/501`)).toBe(text.toLowerCase());
    // Чат другого агента в записи не нужен.
    expect(await readEmployeeText(kit.state, `${second}/501`)).toBe('');
  });
});

/** Фабрика канала Bitrix24 набора, установленная через `installChatBridge`. */
function installBitrixFactory(kit: Bitrix24Kit, table: AgentTable) {
  const portal = { chat: (_ports: ChatChannelPorts) => kit.channel() };
  installChatBridge(portal, { agents: table });
  return portal.chat;
}

describe('насос чата: агент видит записанный текст уже на первом вызове', () => {
  test('сообщение агенту документов: запись до хода, другому агенту записи нет', async () => {
    const state = new MemoryWorkflowStateStore();
    const channel: ChatChannel & RecordingChannel = new RecordingChannel();
    wrapChatChannel(channel, { state, agents: TABLE, log: () => undefined });
    const seenByAgent: Record<string, string> = {};
    const { runtime, inputs } = recordingRuntime(async ({ threadId }) => {
      seenByAgent[threadId] = await readEmployeeText(state, threadId);
    });
    const pump = buildPump({
      channel,
      runtime,
      state,
      agent: ORDER_CALC_AGENT_ID,
      bots: TABLE.chatBots ?? {},
    });
    const text = 'Подготовь договор, ИНН 7707083893';
    await channel.emit(messageEvent(text, { threadId: DOCS_THREAD, botId: 'docs' }));
    await channel.emit(messageEvent('про заказ', { threadId: ORDERS_THREAD, botId: 'orders' }));
    await pump.whenIdle();
    expect(inputs.map((item) => item.agentId).sort()).toEqual(
      [DOCUMENTS_AGENT_ID, ORDER_CALC_AGENT_ID].sort(),
    );
    expect(seenByAgent[DOCS_THREAD]).toBe(text.toLowerCase());
    expect(seenByAgent[ORDERS_THREAD]).toBe('');
  });
});

describe('bridgeChatFromPorts: установка из ports(env) манифеста', () => {
  /** Проверка типов: функция принимает то, что платформа передаёт в `ports`. */
  const accepted: (env: Parameters<NonNullable<typeof pragmatikaProject.ports>>[0]) => void =
    bridgeChatFromPorts;

  test('таблица агентов берётся из конфигурации службы', async () => {
    expect(typeof accepted).toBe('function');
    const state = new MemoryWorkflowStateStore();
    const portal = { chat: (_ports: ChatChannelPorts) => new MemoryChatChannel() };
    bridgeChatFromPorts({
      portal,
      config: { service: { chatAgentId: undefined, chatBots: { docs: DOCUMENTS_AGENT_ID } } },
    });
    const channel = portal.chat({ state, idempotency: new MemoryIdempotencyStore() });
    channel.onEvent(async () => undefined);
    await channel.emit(messageEvent('Директор Петров', { threadId: DOCS_THREAD, botId: 'docs' }));
    expect(await readEmployeeText(state, DOCS_THREAD)).toBe('директор петров');
  });

  test('портал не настроен: ничего не происходит', () => {
    expect(() =>
      bridgeChatFromPorts({ portal: undefined, config: { service: { chatAgentId: 'x' } } }),
    ).not.toThrow();
  });
});
