import type { PricesDeps } from './deps';
import { readDiskSyncOutcome, recordDiskSyncOutcome } from './disk-sync-outcome';
import { NO_RESULT_REASON } from './initial-import-summary';
import { DISK_SYNC_THREAD_PREFIX } from './price-disk-sync';

/** Код замечания: ход импорта закончился, а агент так и не записал итог файла. */
export const NO_FINAL_ACTION_CODE = 'no_final_action';

/**
 * Закрыть итог файла импорта с диска, который агент оставил «в очереди»: ход закончился (или
 * задача снята после сбоя), а ни записи цен, ни отчёта нет. Без этого файл ждал срока
 * `INITIAL_IMPORT_RESULT_TIMEOUT_MS` (2 ч), и столько же ждали сводка и следующая пачка
 * догрузки. Итог - `skipped` с причиной `no_result:<код>`: догрузка его подберёт снова.
 * Не диск, нет записи или итог уже записан - ничего не меняется; возвращает, закрыт ли итог.
 */
export async function closeUnreportedDiskSyncRun(
  deps: Pick<PricesDeps, 'state' | 'clock'>,
  threadId: string,
  code: string,
): Promise<boolean> {
  if (deps.state === undefined || !threadId.startsWith(DISK_SYNC_THREAD_PREFIX)) return false;
  const current = await readDiskSyncOutcome(deps.state, threadId);
  if (current === null || current.status !== 'queued') return false;
  await recordDiskSyncOutcome(deps, threadId, {
    status: 'skipped',
    reason: `${NO_RESULT_REASON}:${code}`,
  });
  return true;
}
