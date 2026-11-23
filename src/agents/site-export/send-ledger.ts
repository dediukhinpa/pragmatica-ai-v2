import { z } from 'zod';
import { readState, writeState } from '@business-ai/core';
import type { SiteExportDeps } from './deps';

/**
 * Журнал выдач рабочей книги сотруднику. Нужен, чтобы в одном ходе сотрудника файл одной и той
 * же версии не уходил в чат дважды: ход различается номером реплики человека (`turnNumber`).
 * Хранится отдельно от самой книги: правка книги пересохраняет её запись целиком.
 */
export const TEMPLATE_SEND_NAMESPACE = 'site-template-send.v1';

const sendRecordSchema = z.object({
  /** Номер реплики сотрудника, в ходе которой шла последняя выдача. */
  turnNumber: z.number().int(),
  /** Версия книги, выданная последней. */
  revision: z.number().int(),
  /** Сколько файлов выдано в этом ходе. */
  sends: z.number().int().nonnegative(),
});
export type SendRecord = z.infer<typeof sendRecordSchema>;

/** Выдачи этой книги в текущем ходе; в другом ходе (или без выдач) - null. */
export async function readTurnSends(
  deps: SiteExportDeps,
  workbookId: string,
  turnNumber: number,
): Promise<SendRecord | null> {
  const record = await readState(deps.state, TEMPLATE_SEND_NAMESPACE, workbookId, sendRecordSchema);
  return record !== null && record.turnNumber === turnNumber ? record : null;
}

/** Запомнить выдачу версии в ходе. */
export async function recordSend(
  deps: SiteExportDeps,
  workbookId: string,
  record: SendRecord,
): Promise<void> {
  await writeState(deps.state, TEMPLATE_SEND_NAMESPACE, workbookId, record);
}
