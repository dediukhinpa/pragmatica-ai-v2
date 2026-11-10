import { z } from 'zod';
import type { FileEntry, Scheduler, WorkflowStateStore } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import { PRICES_AGENT_ID, responsibleThread, type PricesDeps } from './deps';
import {
  loadKeyedDiskSyncOutcomes,
  readDiskSyncOutcome,
  writeDiskSyncOutcome,
  type KeyedDiskSyncOutcome,
} from './disk-sync-outcome';
import {
  INITIAL_IMPORT_RESULT_TIMEOUT_MS,
  NO_RESULT_REASON,
  buildRetrySummary,
  pendingOutcomes,
} from './initial-import-summary';
import {
  PRICE_DISK_SYNC_MAX_FILES,
  PRICE_DISK_SYNC_RUN_TASK,
  diskSyncThreadId,
  initialImportState,
  priceDiskSyncInput,
} from './price-disk-sync';
import { requireState } from './price-state';

/**
 * Догрузка отложенных файлов первичного импорта (этап 106). Явное действие владельца
 * (`deploy/scripts/price-import-retry.sh --apply`), не автоматика. Скрипт только пишет очередь
 * догрузки (`plan` -> `applyPriceImportRetry`); в очередь агента файлы ставит тик синхронизации
 * пачками с прежним пределом `PRICE_DISK_SYNC_MAX_FILES`. Инвариант владельца: файл со статусом
 * `written` не ставится повторно ни при каком выборе причины - это проверяется и в плане, и при
 * записи очереди, и при постановке задачи (итог перечитывается непосредственно перед ней).
 */

/** Пространство очереди догрузки и ключ текущей попытки. */
export const PRICE_RETRY_NAMESPACE = 'prices:disk-sync-retry';
const CURRENT_KEY = 'current';
/** Префикс ключа задачи: файл + номер попытки, поэтому повтор той же попытки дублей не даёт. */
const RETRY_TASK_KEY_PREFIX = 'prices-disk-retry';

const retrySchema = z.object({
  /** Метка запуска первичного импорта, к которому относится догрузка. */
  run: z.string(),
  attempt: z.number().int().positive(),
  createdAt: z.string(),
  /** Файлы, ещё не поставленные в очередь агента (пачками по тикам). */
  pending: z.array(z.object({ threadId: z.string(), path: z.string() })),
  /** Все файлы попытки (треды): по ним ждётся итог перед сводкой. */
  threadIds: z.array(z.string()),
  summarySent: z.boolean().optional(),
});
type RetryMark = z.infer<typeof retrySchema>;

/** Файл-кандидат догрузки. */
export interface RetryCandidate {
  threadId: string;
  path: string;
  file: string;
  /** Причина пропуска (`needs_review:...`) или `no_result` для просроченного `queued`. */
  reason: string;
}

/** План догрузки. */
export interface RetryPlan {
  /** Догрузка невозможна: причина словами; остальные поля пусты. */
  blocked?: string | undefined;
  run: string;
  attempt: number;
  candidates: RetryCandidate[];
  /** Файлы со статусом written: пропускаются всегда. */
  alreadyWritten: number;
  /** Файлы в работе у агента (queued, срок не вышел): не трогаются. */
  inFlight: number;
  /** Кандидаты, которых уже нет на диске (удалены, в архиве): пропускаются. */
  missingOnDisk: number;
  /** Пропущенные, не подошедшие под выбранную причину. */
  otherReasons: number;
  /** Подошли, но не вошли в эту пачку из-за `limit`: уйдут следующей попыткой. */
  overLimit: number;
  truncated: boolean;
}

/** Файл без результата агента: просроченный `queued` или закрытый кодом `no_result:<код>`. */
const isNoResult = (reason: string): boolean => reason.split(':')[0] === NO_RESULT_REASON;

/** Подходит ли причина под выбор: код файла или любой из кодов замечаний. */
function matchesReason(reason: string, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  const [code = '', details = ''] = reason.split(':');
  return code === wanted || details.split(',').includes(wanted);
}

const emptyPlan = (blocked: string, attempt = 0): RetryPlan => ({
  blocked,
  run: '',
  attempt,
  candidates: [],
  alreadyWritten: 0,
  inFlight: 0,
  missingOnDisk: 0,
  otherReasons: 0,
  overLimit: 0,
  truncated: false,
});

/**
 * План догрузки (только чтение). `onDisk` - прайсы, которые сейчас проходят отбор первичного
 * импорта: по ним восстанавливается путь файла (тред - хэш пути). `reason` - код причины
 * пропуска или кода замечания; без него берутся все пропущенные. Просроченные `queued` (агент
 * не ответил за `INITIAL_IMPORT_RESULT_TIMEOUT_MS`) попадают в план без выбора причины или с
 * `reason = no_result`. `limit` - размер пачки: сначала файлы без результата агента (их чаще
 * всего чинят новые версии кода), затем остальные по пути; не вошедшие считаются в `overLimit`.
 * `files` - точные имена файлов (без папки): только они, прочие считаются в `otherReasons`.
 * Нужен, когда догружать стоит не всю причину, а отобранные файлы (например, после разбора
 * формы таблиц: формат уже поддерживается, а у соседних по причине - ещё нет).
 */
export async function planPriceImportRetry(
  state: WorkflowStateStore,
  onDisk: readonly FileEntry[],
  now: Date,
  reason?: string,
  limit?: number,
  files?: readonly string[],
): Promise<RetryPlan> {
  const wantedFiles = files === undefined || files.length === 0 ? undefined : new Set(files);
  const mark = await initialImportState(state);
  const previous = await readState(state, PRICE_RETRY_NAMESPACE, CURRENT_KEY, retrySchema);
  const attempt = (previous?.attempt ?? 0) + 1;
  if (mark === null) return emptyPlan('первичный импорт не запускался: догружать нечего');
  if (!mark.scanComplete) {
    return emptyPlan('первичный импорт ещё идёт: дождитесь его сводки, затем догружайте');
  }
  if (previous !== null && previous.summarySent !== true) {
    return emptyPlan(
      `догрузка ${previous.attempt} ещё идёт (сводка не отправлена): повторно не ставится`,
      previous.attempt,
    );
  }
  const paths = new Map(onDisk.map((entry): [string, string] => [diskSyncThreadId(entry.path), entry.path]));
  const { outcomes, truncated } = await loadKeyedDiskSyncOutcomes(state, mark.startedAt);
  const plan: RetryPlan = { ...emptyPlan('', attempt), run: mark.startedAt, truncated };
  delete plan.blocked;
  for (const item of outcomes) {
    if (item.status === 'written') {
      plan.alreadyWritten += 1;
      continue;
    }
    const stale =
      item.status === 'queued' &&
      now.getTime() - Date.parse(item.at) >= INITIAL_IMPORT_RESULT_TIMEOUT_MS;
    if (item.status === 'queued' && !stale) {
      plan.inFlight += 1;
      continue;
    }
    const itemReason = item.status === 'queued' ? NO_RESULT_REASON : (item.reason ?? NO_RESULT_REASON);
    const fileWanted = wantedFiles === undefined || wantedFiles.has(item.file);
    if (!matchesReason(itemReason, reason) || !fileWanted) {
      plan.otherReasons += 1;
      continue;
    }
    const path = paths.get(item.threadId);
    if (path === undefined) {
      plan.missingOnDisk += 1;
      continue;
    }
    plan.candidates.push({ threadId: item.threadId, path, file: item.file, reason: itemReason });
  }
  plan.candidates.sort(
    (a, b) =>
      Number(isNoResult(b.reason)) - Number(isNoResult(a.reason)) ||
      a.path.localeCompare(b.path),
  );
  if (limit !== undefined && plan.candidates.length > limit) {
    plan.overLimit = plan.candidates.length - limit;
    plan.candidates = plan.candidates.slice(0, limit);
  }
  return plan;
}

/** Итог записи очереди догрузки. */
export interface RetryApplyResult {
  queued: number;
  /** Отсеяно в последний момент: итог файла оказался `written`. */
  skippedWritten: number;
  attempt: number;
  blocked?: string | undefined;
}

/**
 * Записать очередь догрузки по плану. Итог каждого файла перечитывается: `written` в очередь не
 * попадает, даже если план его включил. Если попытка уже идёт, ничего не пишется.
 */
export async function applyPriceImportRetry(
  state: WorkflowStateStore,
  plan: RetryPlan,
  now: Date,
): Promise<RetryApplyResult> {
  const none = (blocked?: string): RetryApplyResult => ({
    queued: 0,
    skippedWritten: 0,
    attempt: plan.attempt,
    blocked,
  });
  if (plan.blocked !== undefined) return none(plan.blocked);
  const previous = await readState(state, PRICE_RETRY_NAMESPACE, CURRENT_KEY, retrySchema);
  if (previous !== null && previous.summarySent !== true) {
    return none(`догрузка ${previous.attempt} ещё идёт`);
  }
  if ((previous?.attempt ?? 0) + 1 !== plan.attempt) return none('план устарел: повторите запуск');
  const pending: RetryMark['pending'] = [];
  let skippedWritten = 0;
  for (const candidate of plan.candidates) {
    const current = await readDiskSyncOutcome(state, candidate.threadId);
    if (current === null || current.run !== plan.run) continue;
    if (current.status === 'written') {
      skippedWritten += 1;
      continue;
    }
    pending.push({ threadId: candidate.threadId, path: candidate.path });
  }
  if (pending.length === 0) return { ...none(), skippedWritten };
  await writeState(state, PRICE_RETRY_NAMESPACE, CURRENT_KEY, {
    run: plan.run,
    attempt: plan.attempt,
    createdAt: now.toISOString(),
    pending,
    threadIds: pending.map((item) => item.threadId),
  } satisfies RetryMark);
  return { queued: pending.length, skippedWritten, attempt: plan.attempt };
}

/** Поручение агенту при догрузке: прежнее, плюс подсказка про варианты, группы и тиражи. */
export function priceRetryInput(
  path: string,
  attempt: number,
  fileRefSecret: string,
): string {
  return (
    `${priceDiskSyncInput(path, fileRefSecret)} Это повторная догрузка (попытка ${attempt}): файл уже ` +
    'откладывался. Сначала попробуй варианты товара (variantColumns), заголовки групп ' +
    '(groupHeaderRows) и цены по тиражам (priceTiers); откладывай только если замечания остались.'
  );
}

/** Итог тика догрузки: только счётчики. */
export interface RetryTickResult {
  enqueued: number;
  /** Не поставлено: итог файла `written` (или записи нет). */
  skippedWritten: number;
  remaining: number;
  summarySent: boolean;
}

/**
 * Тик догрузки: ставит в очередь агента не больше `PRICE_DISK_SYNC_MAX_FILES` файлов попытки.
 * Ключ задачи - файл и номер попытки. Когда очередь пуста и по всем файлам есть итог (или вышел
 * срок ожидания), ответственному уходит одна сводка с разделением «первый проход / догрузка».
 */
export async function runPriceRetryTick(
  deps: PricesDeps,
  scheduler: Pick<Scheduler, 'schedule'>,
): Promise<RetryTickResult> {
  const state = requireState(deps);
  const idle: RetryTickResult = { enqueued: 0, skippedWritten: 0, remaining: 0, summarySent: false };
  const mark = await readState(state, PRICE_RETRY_NAMESPACE, CURRENT_KEY, retrySchema);
  if (mark === null || mark.summarySent === true) return idle;
  const now = deps.clock.now();
  const batch = mark.pending.slice(0, PRICE_DISK_SYNC_MAX_FILES);
  let enqueued = 0;
  let skippedWritten = 0;
  const dropped = new Set<string>();
  for (const item of batch) {
    const current = await readDiskSyncOutcome(state, item.threadId);
    // Инвариант владельца: записанный файл повторно не ставится, что бы ни лежало в очереди.
    if (current === null || current.run !== mark.run || current.status === 'written') {
      dropped.add(item.threadId);
      if (current?.status === 'written') skippedWritten += 1;
      continue;
    }
    const { reason: _reason, rows: _rows, ...kept } = current;
    await writeDiskSyncOutcome(state, item.threadId, {
      ...kept,
      status: 'queued',
      attempt: mark.attempt,
      at: now.toISOString(),
    });
    await scheduler.schedule(
      PRICE_DISK_SYNC_RUN_TASK,
      JSON.stringify({
        agentId: PRICES_AGENT_ID,
        threadId: item.threadId,
        input: priceRetryInput(item.path, mark.attempt, deps.fileRefSecret),
      }),
      now,
      `${RETRY_TASK_KEY_PREFIX}:${item.threadId}:${mark.attempt}`,
    );
    enqueued += 1;
  }
  const next: RetryMark = {
    ...mark,
    pending: mark.pending.slice(batch.length),
    threadIds: mark.threadIds.filter((id) => !dropped.has(id)),
  };
  await writeState(state, PRICE_RETRY_NAMESPACE, CURRENT_KEY, next);
  const summarySent = next.pending.length === 0 && (await sendRetrySummary(deps, next));
  return { enqueued, skippedWritten, remaining: next.pending.length, summarySent };
}

/** Сводка догрузки; `false`, если часть файлов ещё ждёт итога агента. */
async function sendRetrySummary(deps: PricesDeps, mark: RetryMark): Promise<boolean> {
  const state = requireState(deps);
  const { outcomes, truncated } = await loadKeyedDiskSyncOutcomes(state, mark.run);
  const own = new Set(mark.threadIds);
  const retried: KeyedDiskSyncOutcome[] = outcomes.filter((item) => own.has(item.threadId));
  if (pendingOutcomes(retried, deps.clock.now()) > 0) return false;
  await deps.chat.reply(
    responsibleThread(deps),
    { text: buildRetrySummary(outcomes, mark.attempt, truncated) },
    `prices-retry-summary:${mark.run}:${mark.attempt}`,
  );
  await writeState(state, PRICE_RETRY_NAMESPACE, CURRENT_KEY, { ...mark, summarySent: true });
  return true;
}

