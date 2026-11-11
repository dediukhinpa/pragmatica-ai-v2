import { afterEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryAuditRepository,
  MemoryScheduler,
  MemoryWorkflowStateStore,
  SequentialIdGenerator,
} from '@business-ai/adapters';
import { DomainError, lifecycleOf } from '@business-ai/core';
import type { AgentRunResult, ScheduledTask, ThreadState } from '@business-ai/core';
import {
  AGENT_RUN_JOB,
  JobWorker,
  MAX_JOB_ATTEMPTS,
  createJobHandlerRegistry,
  openScheduledWaits,
  registerDefaultJobs,
  type DefaultJobsOptions,
  type ProductionConfig,
} from '@business-ai/core/compose';
import { loadProductionConfig } from '@business-ai/testing';
import { pragmatikaProject } from '../../src';
import { PRICES_AGENT_ID } from '../../src/agents/prices';
import { NO_FINAL_ACTION_CODE } from '../../src/agents/prices/disk-sync-close';
import {
  queueDiskSyncOutcome,
  readDiskSyncOutcome,
  recordDiskSyncOutcome,
} from '../../src/agents/prices/disk-sync-outcome';
import { diskSyncThreadId } from '../../src/agents/prices/price-disk-sync';
import { diskSyncJobHooks, pricesWaitThreadOf } from '../../src/lifecycle-disk-sync';
import {
  clearPragmatikaRuntime,
  setPragmatikaRuntime,
  type PragmatikaRuntime,
} from '../../src/runtime';
import { pragmatikaEnv } from './support';

/**
 * Поведение SRC (`core/src/app/scheduled-run.ts:269` и `service.ts:535`): итог файла импорта с
 * диска, оставленный агентом «в очереди», закрывается сразу - когда ход закончился без записи
 * итога и когда воркер снял задачу, - а не через 2 часа ожидания. В 1.0.1 это штатные хуки
 * манифеста `jobHooks` (G-8), а тред вопросов агента прайсов задаёт `waitThreadByAgentOf`.
 */

const RUN = '2026-10-27T05:46:24.397Z';
const PATH = 'Поставщик/прайс шары.xlsx';
const HANDLER_TIMEOUT_CODE = 'handler_timeout';
const NO_DELAY_MS = 0;
const OPERATOR_THREAD = 'operator-thread';
const RESPONSIBLE_THREAD = 'responsible-thread';
const MANAGER_THREAD = 'manager-thread';
const OWNER_THREAD = 'owner-1';

afterEach(() => {
  clearPragmatikaRuntime();
});

type Scenario = (threadId: string) => Promise<AgentRunResult> | AgentRunResult;

/** Стенд: служба на памяти, агент прайсов заменён сценарием хода, жизненный цикл - из манифеста. */
async function stand(scenario: Scenario, envExtra: Record<string, string> = {}) {
  const clock = new FixedClock();
  const state = new MemoryWorkflowStateStore();
  const audit = new MemoryAuditRepository();
  const scheduler = new MemoryScheduler(new SequentialIdGenerator());
  const threads = new Map<string, ThreadState['status']>();
  const runtime = {
    getThread: async (threadId: string) =>
      threads.has(threadId)
        ? ({
            threadId,
            agentId: PRICES_AGENT_ID,
            status: threads.get(threadId),
            messages: [],
          } as ThreadState)
        : null,
    run: async (_spec: unknown, threadId: string) => {
      const result = await scenario(threadId);
      threads.set(threadId, result.status);
      return result;
    },
  };
  const registry = {
    get: () => ({ id: PRICES_AGENT_ID, prompt: '', tools: [], validators: [], model: 'm' }),
  };
  const config = loadProductionConfig(pragmatikaEnv(envExtra)) as unknown as ProductionConfig;
  const logged: string[] = [];
  const options = {
    app: { runtime, registry, workflowState: state, scheduler, audit },
    audit,
    clock,
    operatorThreadId: OPERATOR_THREAD,
    lifecycle: lifecycleOf(pragmatikaProject, config),
    log: (event: string) => logged.push(event),
  } as unknown as DefaultJobsOptions;
  setPragmatikaRuntime({ clock, state } as unknown as PragmatikaRuntime);
  const handlers = createJobHandlerRegistry();
  registerDefaultJobs(handlers, options);
  const threadId = diskSyncThreadId(PATH);
  await queueDiskSyncOutcome(state, threadId, RUN, PATH, clock.now().toISOString());
  return { clock, state, scheduler, options, handlers, threadId, logged };
}

function taskOf(threadId: string, attempts = 1, name: string = AGENT_RUN_JOB): ScheduledTask {
  return {
    id: 'task-1',
    name,
    payload: JSON.stringify({ agentId: PRICES_AGENT_ID, threadId, input: 'импорт' }),
    runAt: new Date(0).toISOString(),
    status: 'running',
    attempts,
  };
}

/** Платформенный обработчик `agent.run` (с хуками манифеста) на стенде. */
function agentRun(handlers: ReturnType<typeof createJobHandlerRegistry>) {
  const handler = handlers.get(AGENT_RUN_JOB);
  if (handler === undefined) throw new Error('нет обработчика agent.run');
  return handler;
}

const DONE: AgentRunResult = { threadId: '', status: 'completed', output: 'готово' };

describe('манифест: хуки закрытия итога файла вместо проектной задачи', () => {
  test('jobHooks манифеста - хуки диска, жизненный цикл их отдаёт службе', () => {
    expect(pragmatikaProject.jobHooks).toBe(diskSyncJobHooks);
    const config = loadProductionConfig(pragmatikaEnv()) as unknown as ProductionConfig;
    expect(lifecycleOf(pragmatikaProject, config).jobHooks).toBe(diskSyncJobHooks);
  });
});

describe('ход импорта закончился без итога файла (afterAgentRun)', () => {
  test('«в очереди» после завершённого хода -> skipped no_result:no_final_action', async () => {
    const { handlers, state, threadId } = await stand(() => DONE);
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect(await readDiskSyncOutcome(state, threadId)).toMatchObject({
      status: 'skipped',
      reason: `no_result:${NO_FINAL_ACTION_CODE}`,
      run: RUN,
    });
  });

  test('итог, записанный агентом, не затирается', async () => {
    const { handlers, state, clock, threadId } = await stand(async (id) => {
      await recordDiskSyncOutcome({ state, clock }, id, { status: 'written', rows: 3 });
      return DONE;
    });
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('written');
  });

  test('ход приостановлен (ждёт сотрудника) - итог остаётся «в очереди»', async () => {
    const { handlers, state, threadId } = await stand(() => ({ ...DONE, status: 'suspended' }));
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });

  test('тред не из синхронизации диска не трогается', async () => {
    const { handlers, state, threadId } = await stand(() => DONE);
    await agentRun(handlers)(taskOf('chat-1'), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });

  test('сбой хука не роняет ход: платформа пишет его в журнал', async () => {
    const { handlers, state, threadId, logged } = await stand(() => DONE);
    // Хранилище, которое падает на любом обращении: закрытие итога не удаётся.
    const broken = new Proxy({}, { get: () => () => Promise.reject(new Error('сбой хранилища')) });
    const runtime = { clock: new FixedClock(), state: broken };
    setPragmatikaRuntime(runtime as unknown as PragmatikaRuntime);
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect(logged).toContain('job_hook_failed');
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });

  test('приложение не собрано (нет состояния проекта) - хук ничего не делает', async () => {
    const { handlers, state, threadId } = await stand(() => DONE);
    clearPragmatikaRuntime();
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });
});

describe('PRICE_RESPONSIBLE_THREAD_ID: тред вопросов планового запуска прайсов', () => {
  const suspended: Scenario = () => ({ ...DONE, status: 'suspended' });
  const waitsIn = async (state: MemoryWorkflowStateStore, thread: string) =>
    (await openScheduledWaits(state, thread)).map((wait) => wait.agentId);

  test('приостановленный запуск ждёт ответа в треде ответственного', async () => {
    const { handlers, state, threadId } = await stand(suspended, {
      MANAGER_THREAD_ID: MANAGER_THREAD,
      PRICE_RESPONSIBLE_THREAD_ID: RESPONSIBLE_THREAD,
    });
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect(await waitsIn(state, RESPONSIBLE_THREAD)).toEqual([PRICES_AGENT_ID]);
    expect(await waitsIn(state, OPERATOR_THREAD)).toEqual([]);
  });

  test('ответственный не задан - тред менеджера (запасной адресат SRC)', async () => {
    const { handlers, state, threadId } = await stand(suspended, {
      MANAGER_THREAD_ID: MANAGER_THREAD,
    });
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect(await waitsIn(state, MANAGER_THREAD)).toEqual([PRICES_AGENT_ID]);
  });

  test('ни ответственного, ни менеджера - тред владельца платформы', async () => {
    const { handlers, state, threadId } = await stand(suspended);
    await agentRun(handlers)(taskOf(threadId), new Date(0));
    expect(await waitsIn(state, OWNER_THREAD)).toEqual([PRICES_AGENT_ID]);
  });
});

describe('waitThreadByAgentOf: тред ожиданий агента прайсов из конфигурации', () => {
  const configOf = (envExtra: Record<string, string>): ProductionConfig =>
    loadProductionConfig(pragmatikaEnv(envExtra)) as unknown as ProductionConfig;

  test('манифест подключает функцию', () => {
    expect(pragmatikaProject.waitThreadByAgentOf).toBe(pricesWaitThreadOf);
  });

  test('ответственный, иначе менеджер, иначе владелец платформы', () => {
    const env = {
      MANAGER_THREAD_ID: MANAGER_THREAD,
      PRICE_RESPONSIBLE_THREAD_ID: RESPONSIBLE_THREAD,
    };
    expect(pricesWaitThreadOf(configOf(env))).toEqual({ [PRICES_AGENT_ID]: RESPONSIBLE_THREAD });
    const manager = { MANAGER_THREAD_ID: MANAGER_THREAD };
    expect(pricesWaitThreadOf(configOf(manager))).toEqual({ [PRICES_AGENT_ID]: MANAGER_THREAD });
    expect(pricesWaitThreadOf(configOf({}))).toEqual({ [PRICES_AGENT_ID]: OWNER_THREAD });
  });

  test('пустая переменная ответственного считается незаданной', () => {
    const env = { PRICE_RESPONSIBLE_THREAD_ID: '  ', MANAGER_THREAD_ID: MANAGER_THREAD };
    const config = configOf(env);
    expect(pricesWaitThreadOf(config)).toEqual({ [PRICES_AGENT_ID]: MANAGER_THREAD });
  });
});

describe('задача снята воркером после сбоя (onJobGivenUp)', () => {
  const failing: Scenario = () => {
    throw new DomainError('external_failure', 'шлюз недоступен', { retryable: true });
  };

  test('снятая задача запуска на файл диска закрывает итог кодом причины', async () => {
    const { state, threadId } = await stand(() => DONE);
    await diskSyncJobHooks.onJobGivenUp?.({ task: taskOf(threadId), code: 'external_failure' });
    expect(await readDiskSyncOutcome(state, threadId)).toMatchObject({
      status: 'skipped',
      reason: 'no_result:external_failure',
      run: RUN,
    });
  });

  test('код таймаута доходит до причины без изменений', async () => {
    const { state, threadId } = await stand(() => DONE);
    const event = { task: taskOf(threadId), code: HANDLER_TIMEOUT_CODE };
    await diskSyncJobHooks.onJobGivenUp?.(event);
    expect((await readDiskSyncOutcome(state, threadId))?.reason).toBe(
      `no_result:${HANDLER_TIMEOUT_CODE}`,
    );
  });

  test('чужие задачи, чужие треды и битый payload не трогаются', async () => {
    const { state, threadId } = await stand(() => DONE);
    const hook = diskSyncJobHooks.onJobGivenUp;
    await hook?.({ task: taskOf(threadId, 1, 'prices.disk-sync'), code: 'x' });
    await hook?.({ task: taskOf('chat-1'), code: 'x' });
    await hook?.({ task: { ...taskOf(threadId), payload: 'не json' }, code: 'x' });
    await hook?.({ task: { ...taskOf(threadId), payload: '[1]' }, code: 'x' });
    await hook?.({ task: { ...taskOf(threadId), payload: '{"threadId":7}' }, code: 'x' });
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });

  test('итог, записанный агентом, не затирается', async () => {
    const { state, clock, threadId } = await stand(() => DONE);
    await recordDiskSyncOutcome({ state, clock }, threadId, { status: 'written', rows: 3 });
    await diskSyncJobHooks.onJobGivenUp?.({ task: taskOf(threadId), code: 'external_failure' });
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('written');
  });

  test('вместе с воркером: семь сбоев подряд, итог закрыт только после последнего', async () => {
    // Состояние итога на входе в каждую попытку: до последней он должен оставаться «в очереди».
    const seen: string[] = [];
    let readStatus: () => Promise<string | undefined> = async () => undefined;
    const { options, state, scheduler, clock, handlers, threadId } = await stand(async () => {
      seen.push((await readStatus()) ?? 'нет');
      throw new DomainError('external_failure', 'шлюз недоступен', { retryable: true });
    });
    readStatus = async () => (await readDiskSyncOutcome(state, threadId))?.status;
    const givenUp = options.lifecycle?.jobHooks?.onJobGivenUp;
    const worker = new JobWorker({
      scheduler,
      clock,
      audit: new MemoryAuditRepository(),
      handlers,
      log: () => undefined,
      retryBaseDelayMs: NO_DELAY_MS,
      random: () => 0.5,
      // Как служба: хук проекта вызывается, когда воркер снял задачу.
      notifyFailure: async ({ task, code }) => givenUp?.({ task, code }),
    });
    const payload = JSON.stringify({ agentId: PRICES_AGENT_ID, threadId, input: 'импорт' });
    const queued = await scheduler.schedule(AGENT_RUN_JOB, payload, clock.now(), 'k:hash');
    await worker.tick();
    expect(seen).toEqual(Array.from({ length: MAX_JOB_ATTEMPTS }, () => 'queued'));
    expect(await readDiskSyncOutcome(state, threadId)).toMatchObject({
      status: 'skipped',
      reason: 'no_result:external_failure',
    });
    const after = await scheduler.schedule(AGENT_RUN_JOB, payload, clock.now(), 'k:hash');
    expect(after.id).toBe(queued.id);
    expect(after.status).toBe('failed');
  });

  test('неповторяемая ошибка снимает задачу сразу и закрывает итог кодом ошибки', async () => {
    const { options, state, scheduler, clock, handlers, threadId } = await stand(() => {
      throw new DomainError('invalid_input', 'плохой ввод');
    });
    const givenUp = options.lifecycle?.jobHooks?.onJobGivenUp;
    const worker = new JobWorker({
      scheduler,
      clock,
      audit: new MemoryAuditRepository(),
      handlers,
      log: () => undefined,
      retryBaseDelayMs: NO_DELAY_MS,
      random: () => 0.5,
      notifyFailure: async ({ task, code }) => givenUp?.({ task, code }),
    });
    const payload = JSON.stringify({ agentId: PRICES_AGENT_ID, threadId, input: 'импорт' });
    await scheduler.schedule(AGENT_RUN_JOB, payload, clock.now(), 'k:hash2');
    await worker.tick();
    expect((await readDiskSyncOutcome(state, threadId))?.reason).toBe('no_result:invalid_input');
  });

  test('повторяемый сбой до последней попытки итог не закрывает', async () => {
    const { handlers, state, threadId } = await stand(failing);
    const run = agentRun(handlers)(taskOf(threadId, MAX_JOB_ATTEMPTS - 1), new Date(0));
    await expect(run).rejects.toThrow('шлюз недоступен');
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });
});
