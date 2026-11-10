import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { base64Of, bytesOfBase64 } from '@business-ai/core';
import type { TemplateWorkbook } from '@business-ai/core';
import { readState, requirePort, stableHash, toStoredJson } from '@business-ai/core';
import type { SiteExportDeps } from './deps';
import { sizeUnresolvedEntrySchema } from './size-unresolved';

/**
 * Рабочие книги шаблона заказчика (этап 158). Байты xlsx лежат в хранилище состояния, а не в
 * контексте модели: модель оперирует только `workbookId`. Каждая правка кладёт в запись новую
 * копию книги, исходный файл (шаблон на диске, вложение чата) не меняется.
 */

/** Пространство имён рабочих книг. */
export const TEMPLATE_WORKBOOK_NAMESPACE = 'site-template-workbook.v1';
/**
 * Предел размера книги: сервис документов принимает JSON до 8 МиБ, а base64 даёт +33 %, то
 * есть около 6 МБ самого файла.
 */
export const TEMPLATE_WORKBOOK_MAX_BYTES = 6_000_000;
/** Приставка идентификатора рабочей книги. */
const WORKBOOK_ID_PREFIX = 'wb-';
/** Сколько знаков отпечатка идёт в идентификатор. */
const WORKBOOK_ID_HASH_CHARS = 12;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Откуда взята книга. */
export const WORKBOOK_SOURCES = ['disk_template', 'chat_file'] as const;
export type WorkbookSource = (typeof WORKBOOK_SOURCES)[number];

const workbookRecordSchema = z.object({
  fileName: z.string(),
  source: z.enum(WORKBOOK_SOURCES),
  base64: z.string(),
  headerRow: z.number().int().min(1),
  /** Число сохранений: по нему различаются версии файла при выдаче. */
  revision: z.number().int().nonnegative(),
  /**
   * Ячейки, записанные самим агентом (`лист!ссылка`): свои значения можно исправлять без
   * флага перезаписи, чужие - нет.
   */
  written: z.array(z.string()),
  /**
   * Позиции с размером, который не удалось определить (решение владельца 15): копится между
   * пакетами fillTemplateRows, повторяется в ответе sendTemplateFile. Старые записи без поля.
   */
  sizeUnresolved: z.array(sizeUnresolvedEntrySchema).optional(),
});
export type WorkbookRecord = z.infer<typeof workbookRecordSchema>;

/** Загруженная книга: запись и её байты. */
export interface LoadedWorkbook {
  id: string;
  record: WorkbookRecord;
  bytes: Uint8Array;
}

/** MIME-тип xlsx для выдачи файла. */
export const WORKBOOK_MIME = XLSX_MIME;

/** Порт книги обязателен для инструментов шаблона. */
export function requireWorkbook(deps: SiteExportDeps): TemplateWorkbook {
  return requirePort(deps.workbook, 'шаблон заказчика (сервис документов)');
}

/** Новый идентификатор рабочей книги: стабилен для повтора того же вызова. */
export function newWorkbookId(threadId: string, operationId: string): string {
  const hash = stableHash([threadId, operationId]).slice(0, WORKBOOK_ID_HASH_CHARS);
  return `${WORKBOOK_ID_PREFIX}${hash}`;
}

function toBase64(bytes: Uint8Array): string {
  return base64Of(bytes);
}

/** Сохранить книгу (создать или заменить). Запись `done`: ретенция уберёт её через 90 дней. */
export async function saveWorkbook(
  deps: SiteExportDeps,
  id: string,
  input: Omit<WorkbookRecord, 'base64'> & { bytes: Uint8Array },
  /**
   * Ревизия, на которой основана правка. Не совпала с хранимой - книгу успел изменить другой
   * вызов, и молча затирать его правку нельзя (оптимистичная блокировка).
   */
  expectedRevision?: number,
): Promise<void> {
  if (expectedRevision !== undefined) {
    const current = await readState(
      deps.state,
      TEMPLATE_WORKBOOK_NAMESPACE,
      id,
      workbookRecordSchema,
    );
    if (current !== null && current.revision !== expectedRevision) {
      throw new DomainError(
        'conflict',
        'Книгу успел изменить другой вызов, эта правка не сохранена. Повтори её: возьми ' +
          'актуальную версию (readTemplateStructure) и запиши позиции заново.',
      );
    }
  }
  if (input.bytes.length > TEMPLATE_WORKBOOK_MAX_BYTES) {
    throw new DomainError(
      'invalid_input',
      'Файл слишком большой для обработки (предел около 6 МБ). Попросите сотрудника прислать ' +
        'файл меньшего размера.',
    );
  }
  const { bytes, ...rest } = input;
  const record: WorkbookRecord = { ...rest, base64: toBase64(bytes) };
  await deps.state.put(TEMPLATE_WORKBOOK_NAMESPACE, id, toStoredJson(record), { done: true });
}

/** Прочитать рабочую книгу; нет такой - понятный отказ (идентификатор мог устареть). */
export async function loadWorkbook(deps: SiteExportDeps, id: string): Promise<LoadedWorkbook> {
  const record = await readState(deps.state, TEMPLATE_WORKBOOK_NAMESPACE, id, workbookRecordSchema);
  if (record === null) {
    throw new DomainError(
      'not_found',
      'Рабочей книги с таким workbookId нет (устарела или не создавалась). Вызови ' +
        'prepareCleanTemplate либо openChatTemplate и возьми новый workbookId.',
    );
  }
  return { id, record, bytes: bytesOfBase64(record.base64) };
}
