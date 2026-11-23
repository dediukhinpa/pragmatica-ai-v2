import type { PricesDeps } from './deps';
import { loadMail, parseMailPath, saveImportMeta, saveMail, type ImportMeta } from './price-state';

/** Идентификатор импорта: один файл одного поставщика = один импорт (повторы безопасны). */
export function stagingImportId(supplierId: string, fileHash: string): string {
  return `${supplierId}:${fileHash}`;
}

/**
 * Запомнить, откуда импорт (диск, чат, письмо); для вложения письма отметить, что оно
 * разобрано в импорт: только после этого письмо можно пометить обработанным.
 */
export async function recordSource(
  deps: PricesDeps,
  importId: string,
  path: string,
  meta: ImportMeta,
): Promise<void> {
  await saveImportMeta(deps, importId, meta);
  const mail = parseMailPath(path);
  if (mail === null || deps.state === undefined) return;
  const record = await loadMail(deps, mail.messageId);
  const attachments = record.attachments.map((item) =>
    item.index === mail.index ? { ...item, stagedImportId: importId } : item,
  );
  await saveMail(deps, { ...record, attachments });
}
