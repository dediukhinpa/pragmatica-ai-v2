import {
  FixedClock,
  MemoryAgentRuntime,
  MemoryAuditRepository,
  MemoryChatChannel,
  MemoryScheduler,
  SequentialIdGenerator,
  type PgClient,
  type PgRow,
} from '@business-ai/adapters';
import { MemoryCrm } from '../../../src/kit/adapters/memory/crm.owned';
import { MemoryImportStaging } from '../../../src/kit/adapters/memory/import-staging';
import {
  createAgentRegistry,
  toRunSpec,
  type AgentDeclaration,
  type AgentRegistry,
} from '@business-ai/core';
import {
  ChatPump,
  JobWorker,
  createJobHandlerRegistry,
  type ChatPumpOptions,
  type JobFailure,
  type JobHandler,
  type JobWorkerOptions,
  type ServiceApp,
} from '@business-ai/core/compose';
import type { ChatEvent, Scheduler } from '@business-ai/core';

export const CHAT_AGENT = 'buyer';

export const declaration: AgentDeclaration = {
  id: CHAT_AGENT,
  prompt: 'Помощник',
  model: 'test-model',
  tools: [],
  validators: [],
};

/** Журнал службы для проверок: события в порядке появления. */
export function collectLog(): {
  events: Array<{ event: string; fields: Record<string, unknown> }>;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
} {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return { events, log: (event, fields = {}) => void events.push({ event, fields }) };
}

const WORKER_RETRY_BASE_MS = 1_000;
const WORKER_NO_JITTER = 0.5;
const WORKER_LOOP_INTERVAL_MS = 1;

/**
 * Воркер задач на заглушках: часы, аудит, журнал и собранные `failures`. По умолчанию без
 * джиттера и с короткой сеткой: тесты проверяют порядок повторов, а не длину сетки.
 * `scheduler` задают, когда очередь общая для нескольких воркеров или это Postgres.
 */
export function setupWorker(
  handlers: Record<string, JobHandler>,
  overrides: Partial<JobWorkerOptions> = {},
  scheduler: Scheduler = new MemoryScheduler(new SequentialIdGenerator()),
) {
  const clock = new FixedClock();
  const audit = new MemoryAuditRepository();
  const registry = createJobHandlerRegistry();
  for (const [name, handler] of Object.entries(handlers)) registry.register(name, handler);
  const { events, log } = collectLog();
  const failures: JobFailure[] = [];
  const worker = new JobWorker({
    scheduler,
    clock,
    audit,
    handlers: registry,
    log,
    notifyFailure: async (failure) => void failures.push(failure),
    retryBaseDelayMs: WORKER_RETRY_BASE_MS,
    random: () => WORKER_NO_JITTER,
    intervalMs: WORKER_LOOP_INTERVAL_MS,
    ...overrides,
  });
  const names = (): string[] => events.map((e) => e.event);
  return { clock, scheduler, audit, worker, events, failures, names };
}

/** Служба на заглушках в памяти. */
export function memoryServiceApp(overrides: Partial<ServiceApp> = {}): ServiceApp & {
  clock: FixedClock;
  scheduler: MemoryScheduler;
  audit: MemoryAuditRepository;
  staging: MemoryImportStaging;
  registry: AgentRegistry;
} {
  const registry = createAgentRegistry();
  registry.register(declaration);
  const base = {
    clock: new FixedClock(),
    scheduler: new MemoryScheduler(new SequentialIdGenerator()),
    audit: new MemoryAuditRepository(),
    staging: new MemoryImportStaging(),
    registry,
    runtime: new MemoryAgentRuntime(),
    pingDatabase: async (): Promise<void> => undefined,
  };
  return { ...base, ...overrides } as typeof base & Partial<ServiceApp>;
}

/** Насос на заглушках в памяти: общие зависимости по умолчанию, остальное задаёт тест. */
export function buildPump(
  overrides: Pick<ChatPumpOptions, 'channel' | 'access' | 'runtime'> & Partial<ChatPumpOptions>,
): ChatPump {
  return new ChatPump({
    agent: toRunSpec(declaration),
    audit: new MemoryAuditRepository(),
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
    log: collectLog().log,
    // Окно склейки файла и подписи (этап 172) работает и без журнала. Тесты приёма файлов его не
    // проверяют: монотонные часы прыгают на час за вызов, окно закрывается сразу, без реальных
    // 15 с. Тесты склейки задают свои часы и таймер.
    monotonicNow: fastMergeClock(),
    ...overrides,
  });
}

function fastMergeClock(): () => number {
  let now = 0;
  return () => {
    now += 3_600_000;
    return now;
  };
}

/** Текстовое сообщение сотрудника в чате. */
export const chatMessage = (text: string, threadId = 't1', userId = 'u1'): ChatEvent => ({
  kind: 'message',
  threadId,
  userId,
  text,
});

export { deferred } from '@business-ai/testing';

const POLL_MS = 2;
const POLL_LIMIT_MS = 2_000;

/** Дождаться условия (реальные таймеры, короткий опрос). */
export async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось вовремя');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const PRODUCTION_ENV: Record<string, string> = {
  PSEUDONYMIZER_URL: 'http://pseudonymizer.test',
  PSEUDONYMIZER_API_TOKEN: 'test-pseudonymizer-token',
  LITELLM_BASE_URL: 'http://litellm.test',
  LITELLM_API_KEY: 'k',
  DATABASE_URL: 'postgres://app:pw@db.test:5432/pragmatika',
  DOCUMENTS_URL: 'http://documents.test',
  EMBEDDINGS_URL: 'http://embeddings.test',
  PRICES_FILES_ROOT: '/tmp',
  TEMPLATES_FILES_ROOT: '/tmp',
  INTAKE_ROOT: '/tmp',
  MANAGER_THREAD_ID: 'manager-1',
  OWN_COMPANY_NAMES: 'ООО Прагматика',
  PRICES_MODEL: 'a',
  DOCUMENTS_MODEL: 'b',
  ORDER_CALC_MODEL: 'c',
  SITE_EXPORT_MODEL: 'd',
};

/** Минимальное боевое окружение; `overrides` заменяют или добавляют переменные. */
export const productionEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ...PRODUCTION_ENV,
  ...overrides,
});

/** PgClient, который ничего не хранит: сеть и настоящая база не нужны. */
export function nullDb(): PgClient {
  const client: PgClient = {
    async query(): Promise<PgRow[]> {
      return [];
    },
    transaction: async (run) => run(client),
    close: async () => undefined,
  };
  return client;
}
