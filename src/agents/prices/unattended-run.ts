import { loadWorkOwner } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import type { PricesDeps } from './deps';
import { DISK_SYNC_THREAD_PREFIX } from './price-disk-sync';

/**
 * Плановый прогон синхронизации с диска, который никто из сотрудников не поручал. По таким
 * файлам сотруднику ничего не пишется, кроме сбоев: прайс уже на диске, а сообщения на каждый
 * файл ТЗ (раздел 7) не предусматривает - только еженедельный список устаревших прайсов.
 */
export async function isUnattendedDiskRun(
  deps: PricesDeps,
  threadId: string,
  fileHash: string,
): Promise<boolean> {
  if (!threadId.startsWith(DISK_SYNC_THREAD_PREFIX)) return false;
  return (await loadWorkOwner(deps.state, workSubject.import(fileHash))) === null;
}
