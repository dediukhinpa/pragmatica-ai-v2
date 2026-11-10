import { z } from 'zod';
import type { WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { baseName, readState, writeState } from '@business-ai/core';
import type { PricesDeps } from './deps';

/**
 * Итоги обработки файлов первичного импорта (решение владельца: после импорта ответственному -
 * сводка). Код, а не модель, записывает по каждому файлу, чем кончилась его обработка: записан,
 * пропущен (с причиной) или создана новая карточка. Запись по файлу (ключ - тред запуска
 * агента) заводит тик синхронизации, и только в первичном импорте: у обычной синхронизации
 * записей нет, инструменты в таком случае ничего не пишут.
 */

/** Пространство итогов обработки файлов первичного импорта. */
export const DISK_SYNC_OUTCOME_NAMESPACE = 'prices:disk-sync-outcome';
/** Страница обхода итогов. */
const OUTCOME_PAGE_SIZE = 200;
/** Предел страниц обхода (10 000 файлов): сверх него сводка неполна, о чём сказано. */
const OUTCOME_MAX_PAGES = 50;

const outcomeSchema = z.object({
  /** Метка запуска первичного импорта (`startedAt`): записи прошлых запусков не смешиваются. */
  run: z.string(),
  /** Подпись файла для сводки: имя файла без папок. */
  file: z.string(),
  status: z.enum(['queued', 'written', 'skipped']),
  /** Причина пропуска: код или короткая фраза, без свободного текста модели. */
  reason: z.string().optional(),
  /** Сколько позиций записано. */
  rows: z.number().int().nonnegative().optional(),
  /** Из них с ценой «от», диапазоном и тиражом из ячейки («от 100 шт 45 руб»). */
  fromRows: z.number().int().nonnegative().optional(),
  rangeRows: z.number().int().nonnegative().optional(),
  cellTierRows: z.number().int().nonnegative().optional(),
  /** Позиции файла разобраны скриптом в песочнице (этап 111): учитывается в сводке. */
  viaScript: z.boolean().optional(),
  /**
   * Карточка, в которую записан файл (и новая, и существующая), и путь файла от корня диска.
   * Из них складывается история файлов поставщика (`loadSupplierDiskFiles`): `file` - только
   * имя без папок, по нему поток файла не определить.
   */
  supplierId: z.string().optional(),
  path: z.string().optional(),
  /** Карточка, созданная (или найденная) для файла; имя поля историческое (хранится в состоянии). */
  draft: z.object({ supplierId: z.string(), name: z.string() }).optional(),
  /**
   * Номер догрузки (`price-import-retry.sh`), в которую файл поставлен повторно. Нет поля -
   * файл обработан в первый проход первичного импорта.
   */
  attempt: z.number().int().positive().optional(),
  /** Когда запись создана или обновлена. */
  at: z.string(),
});
export type DiskSyncOutcome = z.infer<typeof outcomeSchema>;

/** Данные, которыми инструмент дополняет запись. */
export type DiskSyncOutcomePatch = Partial<Omit<DiskSyncOutcome, 'run' | 'file' | 'at'>>;

/** Завести запись «в очереди» для файла, поставленного в работу первичным импортом. */
export async function queueDiskSyncOutcome(
  state: WorkflowStateStore,
  threadId: string,
  run: string,
  path: string,
  nowIso: string,
): Promise<void> {
  await writeState(state, DISK_SYNC_OUTCOME_NAMESPACE, threadId, {
    run,
    file: baseName(path),
    status: 'queued',
    at: nowIso,
  } satisfies DiskSyncOutcome);
}

/**
 * Дополнить запись файла. Записи нет (обычная синхронизация или не диск) - ничего не пишется,
 * возвращается `null`. Итог `written` или `skipped` не затирается позднейшим `queued`.
 */
export async function recordDiskSyncOutcome(
  deps: Pick<PricesDeps, 'state' | 'clock'>,
  threadId: string,
  patch: DiskSyncOutcomePatch,
): Promise<DiskSyncOutcome | null> {
  if (deps.state === undefined) return null;
  const current = await readState(deps.state, DISK_SYNC_OUTCOME_NAMESPACE, threadId, outcomeSchema);
  if (current === null) return null;
  const next: DiskSyncOutcome = { ...current, ...patch, at: deps.clock.now().toISOString() };
  await writeState(deps.state, DISK_SYNC_OUTCOME_NAMESPACE, threadId, next);
  return next;
}

/** Итог файла вместе с ключом записи (тред запуска агента на файл). */
export interface KeyedDiskSyncOutcome extends DiskSyncOutcome {
  threadId: string;
}

/** Прочитать запись итога файла по треду; `null` - записи нет. */
export function readDiskSyncOutcome(
  state: WorkflowStateStore,
  threadId: string,
): Promise<DiskSyncOutcome | null> {
  return readState(state, DISK_SYNC_OUTCOME_NAMESPACE, threadId, outcomeSchema);
}

/** Записать итог файла целиком (для догрузки: перевод в очередь). */
export function writeDiskSyncOutcome(
  state: WorkflowStateStore,
  threadId: string,
  outcome: DiskSyncOutcome,
): Promise<void> {
  return writeState(state, DISK_SYNC_OUTCOME_NAMESPACE, threadId, outcome);
}

/** Итоги запуска первичного импорта и признак «обход неполон» (упёрлись в предел страниц). */
export async function loadDiskSyncOutcomes(
  state: WorkflowStateStore,
  run: string,
): Promise<{ outcomes: DiskSyncOutcome[]; truncated: boolean }> {
  const { outcomes, truncated } = await loadKeyedDiskSyncOutcomes(state, run);
  return { outcomes, truncated };
}

/**
 * То же, что `loadDiskSyncOutcomes`, но с ключом записи (нужен догрузке). `run` не задан -
 * записи всех запусков (разовое заполнение `source_file` по истории).
 */
export async function loadKeyedDiskSyncOutcomes(
  state: WorkflowStateStore,
  run?: string,
): Promise<{ outcomes: KeyedDiskSyncOutcome[]; truncated: boolean }> {
  const outcomes: KeyedDiskSyncOutcome[] = [];
  let truncated = false;
  const entries = stateEntries(state, DISK_SYNC_OUTCOME_NAMESPACE, {
    pageSize: OUTCOME_PAGE_SIZE,
    maxPages: OUTCOME_MAX_PAGES,
    onLimit: () => {
      truncated = true;
    },
  });
  for await (const entry of entries) {
    const parsed = outcomeSchema.safeParse(entry.value);
    if (parsed.success && (run === undefined || parsed.data.run === run)) {
      outcomes.push({ ...parsed.data, threadId: entry.key });
    }
  }
  return { outcomes, truncated };
}
