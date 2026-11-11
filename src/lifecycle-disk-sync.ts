import {
  AGENT_RUN_JOB,
  type ProductionConfig,
  type ProjectJobHooks,
} from '@business-ai/core/compose';
import { PRICES_AGENT_ID } from './agents/prices';
import { NO_FINAL_ACTION_CODE, closeUnreportedDiskSyncRun } from './agents/prices/disk-sync-close';
import type { PragmatikaConfig } from './config';
import { pragmatikaRuntime } from './runtime';

/**
 * Закрытие «неотчитанного» итога файла при импорте с диска (`closeUnreportedDiskSyncRun`) и тред
 * вопросов агента прайсов - через штатные точки платформы 1.0.1 (G-8): хуки манифеста
 * `jobHooks` и `waitThreadByAgentOf`. Запуск агента на файл диска - обычная задача `agent.run`.
 */

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

/**
 * Закрыть итог файла по треду. Хранилище и часы берутся у собранного приложения; пока оно не
 * собрано, закрывать нечего. Сбой уходит платформе: она пишет его в журнал (`job_hook_failed`) и
 * не даёт ему подменить исход задачи.
 */
async function closeRun(threadId: string, code: string): Promise<void> {
  const runtime = pragmatikaRuntime();
  if (runtime === undefined) return;
  await closeUnreportedDiskSyncRun({ state: runtime.state, clock: runtime.clock }, threadId, code);
}

/**
 * Хуки конца задач (манифест `jobHooks`). Ход закончился (тред не приостановлен), а итог файла
 * остался «в очереди» - закрыть сразу кодом `no_final_action`, а не ждать 2 часа. Воркер снял
 * задачу запуска агента (попытки кончились, ошибка неповторяемая, таймаут) - закрыть кодом
 * причины. Чужие задачи и треды (не диска) `closeUnreportedDiskSyncRun` не трогает.
 */
export const diskSyncJobHooks: ProjectJobHooks = {
  afterAgentRun: ({ threadId }) => closeRun(threadId, NO_FINAL_ACTION_CODE),
  onJobGivenUp: async ({ task, code }) => {
    if (task.name !== AGENT_RUN_JOB) return;
    const threadId = threadIdOf(task.payload);
    if (threadId !== undefined) await closeRun(threadId, code);
  },
};

/**
 * Треды вопросов плановых запусков (манифест `waitThreadByAgentOf`): агент прайсов спрашивает и
 * напоминает в треде ответственного (`PRICE_RESPONSIBLE_THREAD_ID`), иначе менеджера
 * (`MANAGER_THREAD_ID`), иначе владельца платформы - как `responsibleThread` зависимостей агента.
 */
export function pricesWaitThreadOf(config: ProductionConfig): Readonly<Record<string, string>> {
  const project = (config.project ?? {}) as Partial<PragmatikaConfig>;
  const thread =
    project.PRICE_RESPONSIBLE_THREAD_ID ??
    project.MANAGER_THREAD_ID ??
    config.agents.ownerThreadId;
  return { [PRICES_AGENT_ID]: thread };
}
