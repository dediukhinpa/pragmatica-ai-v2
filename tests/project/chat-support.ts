import {
  FixedClock,
  MemoryAuditRepository,
  MemoryIdempotencyStore,
  MemoryWorkflowStateStore,
  SystemIdGenerator,
} from '@business-ai/adapters';
import type {
  AgentRunResult,
  AgentRunSpec,
  AccessPolicy,
  AgentRuntime,
  AuditRepository,
  ChatChannel,
  ChatEvent,
  ChatEventHandler,
  ChatFile,
  ChatMessage,
  ThreadState,
  WorkflowStateStore,
} from '@business-ai/core';
import {
  ChatPump,
  type ChatButtonHandler,
  type ChatIncomingHook,
  type ServiceLog,
} from '@business-ai/core/compose';

/** Тред и сотрудник тестов чата. */
export const TEST_USER_ID = 'u-100';

/** Канал без черновиков и «печатает»: насос идёт простым путём `runtime.run`. */
export class RecordingChannel implements ChatChannel {
  readonly handlers: ChatEventHandler[] = [];
  readonly texts: Array<{ threadId: string; text: string }> = [];

  onEvent(handler: ChatEventHandler): void {
    this.handlers.push(handler);
  }

  async reply(threadId: string, message: ChatMessage): Promise<void> {
    this.texts.push({ threadId, text: message.text });
  }

  async sendFile(_threadId: string, _file: ChatFile): Promise<void> {
    // Файлы тестам чата не нужны.
  }

  /** Подать событие подписчикам, как канал: отказ обработчика бросается наружу. */
  async emit(event: ChatEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }
}

/** Что агент получил на вход: тред, агент, текст и то, что лежало в состоянии к этому моменту. */
export interface AgentInput {
  threadId: string;
  agentId: string;
  input: string;
}

/** Рантайм-заглушка: запоминает входы и отвечает «готово». */
export function recordingRuntime(
  onRun?: (input: AgentInput) => Promise<void>,
): { runtime: AgentRuntime; inputs: AgentInput[]; suspended: Set<string> } {
  const inputs: AgentInput[] = [];
  const suspended = new Set<string>();
  const result = (threadId: string): AgentRunResult => ({
    threadId,
    status: 'completed',
    output: 'готово',
  });
  const note = async (threadId: string, agentId: string, input: string): Promise<void> => {
    const entry = { threadId, agentId, input };
    inputs.push(entry);
    await onRun?.(entry);
  };
  const runtime: AgentRuntime = {
    async run(spec, threadId, input) {
      await note(threadId, spec.id, input);
      return result(threadId);
    },
    async resume(threadId, input) {
      await note(threadId, 'resumed', input);
      suspended.delete(threadId);
      return result(threadId);
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('поток в тестах не используется');
    },
    // eslint-disable-next-line require-yield
    async *streamResume() {
      throw new Error('поток в тестах не используется');
    },
    async suspend(threadId) {
      suspended.add(threadId);
    },
    async getThread(threadId): Promise<ThreadState | null> {
      return suspended.has(threadId)
        ? { threadId, agentId: 'x', status: 'suspended', messages: [] }
        : null;
    },
  };
  return { runtime, inputs, suspended };
}

/** Спецификация агента для насоса. */
export function runSpec(id: string): AgentRunSpec {
  return { id, prompt: '', model: 'test-model', tools: [] };
}

/** Насос чата на заглушках: подписан на канал, все права выданы. */
export function buildPump(options: {
  channel: ChatChannel;
  runtime: AgentRuntime;
  state?: WorkflowStateStore;
  agent?: string;
  bots?: Readonly<Record<string, string>>;
  buttons?: readonly ChatButtonHandler[];
  access?: AccessPolicy;
  audit?: AuditRepository;
  /** Хук входящего сообщения (манифест `chat.onIncoming`). */
  onIncoming?: ChatIncomingHook;
  /** Журнал службы; по умолчанию молчит. */
  log?: ServiceLog;
}): ChatPump {
  const pump = new ChatPump({
    channel: options.channel,
    access: options.access ?? { isAllowed: async () => true },
    runtime: options.runtime,
    ...(options.agent === undefined ? {} : { agent: runSpec(options.agent) }),
    ...(options.bots === undefined
      ? {}
      : {
          bots: Object.fromEntries(
            Object.entries(options.bots).map(([botId, agentId]) => [botId, runSpec(agentId)]),
          ),
        }),
    audit: options.audit ?? new MemoryAuditRepository(),
    clock: new FixedClock(),
    ids: new SystemIdGenerator(),
    log: options.log ?? (() => undefined),
    state: options.state ?? new MemoryWorkflowStateStore(),
    idempotency: new MemoryIdempotencyStore(),
    ...(options.buttons === undefined ? {} : { buttonHandlers: options.buttons }),
    ...(options.onIncoming === undefined ? {} : { onIncoming: options.onIncoming }),
  });
  pump.attach();
  return pump;
}

/** Событие-сообщение сотрудника. */
export function messageEvent(
  text: string,
  extra: { threadId?: string; userId?: string; botId?: string } = {},
): ChatEvent {
  return {
    kind: 'message',
    threadId: extra.threadId ?? 'thread-1',
    userId: extra.userId ?? TEST_USER_ID,
    ...(extra.botId === undefined ? {} : { botId: extra.botId }),
    text,
  };
}
