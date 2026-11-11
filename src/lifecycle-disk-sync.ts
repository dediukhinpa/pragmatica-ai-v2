import type { ScheduledTask, Scheduler } from '@business-ai/core';
import {
  JOB_CODE_TIMEOUT,
  MAX_JOB_ATTEMPTS,
  createAgentRunHandler,
  errorCode,
  isRetryable,
  type DefaultJobsOptions,
  type JobHandler,
} from '@business-ai/core/compose';
import { PRICES_AGENT_ID, type PricesDeps } from './agents/prices';
import { responsibleThread } from './agents/prices/deps';
import {
  NO_FINAL_ACTION_CODE,
  closeUnreportedDiskSyncRun,
} from './agents/prices/disk-sync-close';
import { DISK_SYNC_THREAD_PREFIX, PRICE_DISK_SYNC_RUN_TASK } from './agents/prices/price-disk-sync';
import { pragmatikaRuntime } from './runtime';

/**
 * Закрытие «неотчитанного» итога файла при импорте с диска (`closeUnreportedDiskSyncRun`).
 *
 * В прежней сборке два места платформенного кода закрывали итог файла, который агент оставил
 * «в очереди»: конец хода планового запуска (`scheduled-run.ts`) и снятие задачи воркером после
 * всех попыток (`notifyFailure` службы). Манифест проекта этих хуков не даёт, а обработчик
 * `agent.run` платформы подменить нельзя (имя занято). Поэтому запуск агента на файл диска идёт
 * отдельной задачей проекта: её обработчик исполняет платформенный обработчик запуска агента
 * (`createAgentRunHandler`, тот же, что регистрирует служба) и закрывает итог до и после.
 */

/** Задача запуска агента прайсов на файл с диска (проектная; платформенная - `agent.run`). */
export const DISK_SYNC_RUN_JOB = 'prices.disk-sync-run';

/** Что нужно от payload задачи запуска агента. */
interface RunPayload {
  threadId: string;
}

/** Тред запуска из payload; `undefined`, если payload не разбирается. */
function threadIdOf(payload: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { threadId } = parsed as Partial<RunPayload>;
    return typeof threadId === 'string' ? threadId : undefined;
  } catch {
    return undefined;
  }
}

/** Запуск на файл с диска: задача запуска агента с тредом синхронизации диска. */
function isDiskSyncRun(name: string, payload: string): boolean {
  if (name !== PRICE_DISK_SYNC_RUN_TASK) return false;
  return threadIdOf(payload)?.startsWith(DISK_SYNC_THREAD_PREFIX) === true;
}

/**
 * Планировщик, который ставит запуск на файл диска задачей проекта (`DISK_SYNC_RUN_JOB`), а не
 * платформенной `agent.run`. Ключ идемпотентности и срок не меняются; прочие задачи и вызовы
 * идут как есть. Нужен только местам постановки синхронизации диска и догрузки.
 */
export function diskSyncRunScheduler(base: Scheduler): Scheduler {
  return {
    schedule: (name, payload, runAt, key) =>
      base.schedule(isDiskSyncRun(name, payload) ? DISK_SYNC_RUN_JOB : name, payload, runAt, key),
    scheduleRecurring: (name, payload, firstRunAt, everyMs, key) =>
      base.scheduleRecurring(name, payload, firstRunAt, everyMs, key),
    claimDue: (now, options) => base.claimDue(now, options),
    complete: (taskId, owner, now) => base.complete(taskId, owner, now),
    retry: (taskId, owner, retryAt, code) => base.retry(taskId, owner, retryAt, code),
    fail: (taskId, owner, now, code) => base.fail(taskId, owner, now, code),
    release: (taskId, owner, notBefore) => base.release(taskId, owner, notBefore),
    cancel: (taskId) => base.cancel(taskId),
    purgeFinished: (now) => base.purgeFinished(now),
    queueStats: (now, visibilityTimeoutMs) => base.queueStats(now, visibilityTimeoutMs),
  };
}

/**
 * Треды вопросов плановых запусков по агентам: агент прайсов спрашивает и напоминает в треде
 * ответственного (`PRICE_RESPONSIBLE_THREAD_ID`, иначе менеджера) - как в прежней сборке
 * (`notifications.waitThreadByAgent`). Заданное манифестом сохраняется, кроме агента прайсов.
 * Зависимости агента берутся у службы (`app.agentDeps`), иначе из состояния приложения.
 */
function waitThreadsOf(options: DefaultJobsOptions): Readonly<Record<string, string>> {
  const base = options.lifecycle?.waitThreadByAgent ?? {};
  const prices =
    (options.app.agentDeps?.[PRICES_AGENT_ID] as PricesDeps | undefined) ??
    pragmatikaRuntime()?.prices;
  if (prices === undefined || prices.managerThreadId === undefined) return base;
  return { ...base, [PRICES_AGENT_ID]: responsibleThread(prices) };
}

/**
 * Воркер снимет задачу после этой ошибки: она не повторяемая либо попытки кончились (условие
 * `JobWorker.failed`). Число попыток воркера службы - `MAX_JOB_ATTEMPTS` (служба его не меняет).
 */
function workerWillGiveUp(task: ScheduledTask, error: unknown): boolean {
  return !isRetryable(error) || task.attempts >= MAX_JOB_ATTEMPTS;
}

/**
 * Обработчик запуска агента на файл диска. Ход закончился (тред не приостановлен), а итог файла
 * остался «в очереди» - закрыть сразу кодом `no_final_action`, а не ждать 2 часа. Ход упал и
 * воркер снимет задачу - закрыть кодом сбоя; ошибка уходит воркеру без изменений (повторы,
 * аудит и сообщение оператору - его дело). Закрытие - вторичное действие: сбой записи итога не
 * подменяет исход хода.
 */
export function diskSyncRunHandler(options: DefaultJobsOptions): JobHandler {
  const { app, clock } = options;
  const run = createAgentRunHandler({
    runtime: app.runtime,
    registry: app.registry,
    audit: options.audit,
    clock,
    log: options.log ?? ((): void => undefined),
    state: app.workflowState,
    chat: options.chat,
    notifications: {
      operatorThreadId: options.operatorThreadId,
      // Читается при каждом запуске: состояние приложения появляется после сборки агентов.
      get waitThreadByAgent() {
        return waitThreadsOf(options);
      },
    },
    access: options.access,
    scheduler: app.scheduler,
    handoffAskEnabled: app.handoffAskEnabled,
    retiredThreads: new Set(options.lifecycle?.retiredThreads ?? []),
  });
  const close = async (threadId: string, code: string): Promise<void> => {
    try {
      await closeUnreportedDiskSyncRun({ state: app.workflowState, clock }, threadId, code);
    } catch (error) {
      options.log?.('disk_sync_close_failed', { code: errorCode(error) });
    }
  };
  return async (task, now, signal) => {
    const threadId = threadIdOf(task.payload);
    try {
      await run(task, now, signal);
    } catch (error) {
      if (threadId !== undefined && workerWillGiveUp(task, error)) {
        await close(threadId, signal?.aborted === true ? JOB_CODE_TIMEOUT : errorCode(error));
      }
      throw error;
    }
    if (threadId === undefined) return;
    const thread = await app.runtime.getThread(threadId);
    if (thread?.status !== 'suspended') await close(threadId, NO_FINAL_ACTION_CODE);
  };
}
