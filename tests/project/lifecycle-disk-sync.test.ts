import { describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryAuditRepository,
  MemoryScheduler,
  MemoryWorkflowStateStore,
  SequentialIdGenerator,
} from '@business-ai/adapters';
import { DomainError } from '@business-ai/core';
import type { AgentRunResult, ScheduledTask, ThreadState } from '@business-ai/core';
import {
  JobWorker,
  MAX_JOB_ATTEMPTS,
  openScheduledWaits,
  createJobHandlerRegistry,
  type DefaultJobsOptions,
} from '@business-ai/core/compose';
import { PRICES_AGENT_ID } from '../../src/agents/prices';
import { NO_FINAL_ACTION_CODE } from '../../src/agents/prices/disk-sync-close';
import {
  queueDiskSyncOutcome,
  readDiskSyncOutcome,
  recordDiskSyncOutcome,
} from '../../src/agents/prices/disk-sync-outcome';
import {
  PRICE_DISK_SYNC_RUN_TASK,
  diskSyncThreadId,
} from '../../src/agents/prices/price-disk-sync';
import {
  DISK_SYNC_RUN_JOB,
  diskSyncRunHandler,
  diskSyncRunScheduler,
} from '../../src/lifecycle-disk-sync';

/**
 * Поведение SRC (`core/src/app/scheduled-run.ts:269` и `service.ts:535`): итог файла импорта с
 * диска, оставленный агентом «в очереди», закрывается сразу - когда ход закончился без записи
 * итога и когда воркер снял задачу после всех попыток, - а не через 2 часа ожидания.
 */

const RUN = '2026-10-27T05:46:24.397Z';
const PATH = 'Поставщик/прайс шары.xlsx';
const HANDLER_TIMEOUT_CODE = 'handler_timeout';
const NO_DELAY_MS = 0;
const OPERATOR_THREAD = 'operator-thread';
const RESPONSIBLE_THREAD = 'responsible-thread';
const MANAGER_THREAD = 'manager-thread';

type Scenario = (threadId: string) => Promise<AgentRunResult> | AgentRunResult;

/** Стенд: служба на памяти, агент прайсов заменён сценарием хода. */
async function stand(scenario: Scenario, pricesDeps: Record<string, string> = {}) {
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
  const options = {
    app: {
      runtime,
      registry,
      workflowState: state,
      scheduler,
      audit,
      agentDeps: { [PRICES_AGENT_ID]: pricesDeps },
    },
    audit,
    clock,
    operatorThreadId: OPERATOR_THREAD,
    log: () => undefined,
  } as unknown as DefaultJobsOptions;
  const threadId = diskSyncThreadId(PATH);
  await queueDiskSyncOutcome(state, threadId, RUN, PATH, clock.now().toISOString());
  return { clock, state, scheduler, options, threadId };
}

function taskOf(threadId: string, attempts = 1): ScheduledTask {
  return {
    id: 'task-1',
    name: DISK_SYNC_RUN_JOB,
    payload: JSON.stringify({ agentId: PRICES_AGENT_ID, threadId, input: 'импорт' }),
    runAt: new Date(0).toISOString(),
    status: 'running',
    attempts,
  };
}

const DONE: AgentRunResult = { threadId: '', status: 'completed', output: 'готово' };

describe('постановка запуска на файл диска', () => {
  test('запуск на файл с диска идёт отдельной задачей проекта, ключ тот же', async () => {
    const { scheduler, threadId } = await stand(() => DONE);
    const decorated = diskSyncRunScheduler(scheduler);
    const payload = JSON.stringify({ agentId: PRICES_AGENT_ID, threadId, input: 'x' });
    const task = await decorated.schedule(PRICE_DISK_SYNC_RUN_TASK, payload, new Date(0), 'k-1');
    expect(task.name).toBe(DISK_SYNC_RUN_JOB);
    // Повтор с тем же ключом новую задачу не создаёт.
    const again = await decorated.schedule(PRICE_DISK_SYNC_RUN_TASK, payload, new Date(0), 'k-1');
    expect(again.id).toBe(task.id);
  });

  test('чужие запуски агента и прочие задачи не переименовываются', async () => {
    const { scheduler } = await stand(() => DONE);
    const decorated = diskSyncRunScheduler(scheduler);
    const agentId = PRICES_AGENT_ID;
    const chatPayload = JSON.stringify({ agentId, threadId: 'chat-1', input: 'x' });
    const run = PRICE_DISK_SYNC_RUN_TASK;
    const chat = await decorated.schedule(run, chatPayload, new Date(0), 'k-2');
    expect(chat.name).toBe(PRICE_DISK_SYNC_RUN_TASK);
    const other = await decorated.schedule('prices.other', '{}', new Date(0), 'k-3');
    expect(other.name).toBe('prices.other');
    const broken = await decorated.schedule(run, 'не json', new Date(0), 'k-4');
    expect(broken.name).toBe(PRICE_DISK_SYNC_RUN_TASK);
  });
});

describe('ход импорта закончился без итога файла', () => {
  test('«в очереди» после завершённого хода -> skipped no_result:no_final_action', async () => {
    const { options, state, threadId } = await stand(() => DONE);
    await diskSyncRunHandler(options)(taskOf(threadId), new Date(0));
    expect(await readDiskSyncOutcome(state, threadId)).toMatchObject({
      status: 'skipped',
      reason: `no_result:${NO_FINAL_ACTION_CODE}`,
      run: RUN,
    });
  });

  test('итог, записанный агентом, не затирается', async () => {
    const { options, state, clock, threadId } = await stand(async (id) => {
      await recordDiskSyncOutcome({ state, clock }, id, { status: 'written', rows: 3 });
      return DONE;
    });
    await diskSyncRunHandler(options)(taskOf(threadId), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('written');
  });

  test('ход приостановлен (ждёт сотрудника) - итог остаётся «в очереди»', async () => {
    const { options, state, threadId } = await stand(() => ({ ...DONE, status: 'suspended' }));
    await diskSyncRunHandler(options)(taskOf(threadId), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });

  test('тред не из синхронизации диска не трогается', async () => {
    const { options, state, threadId } = await stand(() => DONE);
    await diskSyncRunHandler(options)(taskOf('chat-1'), new Date(0));
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });
});

describe('PRICE_RESPONSIBLE_THREAD_ID: тред вопросов планового запуска прайсов', () => {
  const suspended: Scenario = () => ({ ...DONE, status: 'suspended' });
  const waitsIn = async (state: MemoryWorkflowStateStore, thread: string) =>
    (await openScheduledWaits(state, thread)).map((wait) => wait.agentId);

  test('приостановленный запуск ждёт ответа в треде ответственного', async () => {
    const { options, state, threadId } = await stand(suspended, {
      managerThreadId: MANAGER_THREAD,
      responsibleThreadId: RESPONSIBLE_THREAD,
    });
    await diskSyncRunHandler(options)(taskOf(threadId), new Date(0));
    expect(await waitsIn(state, RESPONSIBLE_THREAD)).toEqual([PRICES_AGENT_ID]);
    expect(await waitsIn(state, OPERATOR_THREAD)).toEqual([]);
  });

  test('ответственный не задан - тред менеджера (запасной адресат SRC)', async () => {
    const { options, state, threadId } = await stand(suspended, {
      managerThreadId: MANAGER_THREAD,
    });
    await diskSyncRunHandler(options)(taskOf(threadId), new Date(0));
    expect(await waitsIn(state, MANAGER_THREAD)).toEqual([PRICES_AGENT_ID]);
  });
});

describe('задача снята воркером после сбоя', () => {
  const failing: Scenario = () => {
    throw new DomainError('external_failure', 'шлюз недоступен', { retryable: true });
  };

  test('повторяемый сбой до последней попытки итог не закрывает', async () => {
    const { options, state, threadId } = await stand(failing);
    const run = diskSyncRunHandler(options)(taskOf(threadId, MAX_JOB_ATTEMPTS - 1), new Date(0));
    await expect(run).rejects.toThrow('шлюз недоступен');
    expect((await readDiskSyncOutcome(state, threadId))?.status).toBe('queued');
  });

  test('последняя попытка закрывает итог кодом сбоя, ошибка уходит воркеру', async () => {
    const { options, state, threadId } = await stand(failing);
    const run = diskSyncRunHandler(options)(taskOf(threadId, MAX_JOB_ATTEMPTS), new Date(0));
    await expect(run).rejects.toThrow('шлюз недоступен');
    expect(await readDiskSyncOutcome(state, threadId)).toMatchObject({
      status: 'skipped',
      reason: 'no_result:external_failure',
    });
  });

  test('неповторяемая ошибка закрывает итог сразу (воркер снимет задачу)', async () => {
    const { options, state, threadId } = await stand(() => {
      throw new DomainError('invalid_input', 'плохой ввод');
    });
    await expect(diskSyncRunHandler(options)(taskOf(threadId), new Date(0))).rejects.toThrow();
    expect((await readDiskSyncOutcome(state, threadId))?.reason).toBe('no_result:invalid_input');
  });

  test('таймаут обработчика на последней попытке закрывает итог кодом таймаута', async () => {
    const controller = new AbortController();
    const { options, state, threadId } = await stand(() => {
      controller.abort();
      throw new Error('прервано');
    });
    const run = diskSyncRunHandler(options)(
      taskOf(threadId, MAX_JOB_ATTEMPTS),
      new Date(0),
      controller.signal,
    );
    await expect(run).rejects.toThrow();
    expect((await readDiskSyncOutcome(state, threadId))?.reason).toBe(
      `no_result:${HANDLER_TIMEOUT_CODE}`,
    );
  });
});

describe('вместе с воркером платформы', () => {
  test('семь сбоев подряд: итог файла закрыт только после последнего', async () => {
    // Состояние итога на входе в каждую попытку: до последней он должен оставаться «в очереди».
    const seen: string[] = [];
    let readState: () => Promise<string | undefined> = async () => undefined;
    const { options, state, scheduler, clock, threadId } = await stand(async () => {
      seen.push((await readState()) ?? 'нет');
      throw new DomainError('external_failure', 'шлюз недоступен', { retryable: true });
    });
    readState = async () => (await readDiskSyncOutcome(state, threadId))?.status;
    const handlers = createJobHandlerRegistry();
    handlers.register(DISK_SYNC_RUN_JOB, diskSyncRunHandler(options));
    const worker = new JobWorker({
      scheduler,
      clock,
      audit: new MemoryAuditRepository(),
      handlers,
      log: () => undefined,
      retryBaseDelayMs: NO_DELAY_MS,
      random: () => 0.5,
    });
    const payload = JSON.stringify({ agentId: PRICES_AGENT_ID, threadId, input: 'импорт' });
    const queued = await diskSyncRunScheduler(scheduler).schedule(
      PRICE_DISK_SYNC_RUN_TASK,
      payload,
      clock.now(),
      'prices-disk-sync:hash',
    );
    await worker.tick();
    expect(seen).toEqual(Array.from({ length: MAX_JOB_ATTEMPTS }, () => 'queued'));
    expect(await readDiskSyncOutcome(state, threadId)).toMatchObject({
      status: 'skipped',
      reason: 'no_result:external_failure',
    });
    const after = await diskSyncRunScheduler(scheduler).schedule(
      PRICE_DISK_SYNC_RUN_TASK,
      payload,
      clock.now(),
      'prices-disk-sync:hash',
    );
    expect(after.id).toBe(queued.id);
    expect(after.status).toBe('failed');
  });
});
