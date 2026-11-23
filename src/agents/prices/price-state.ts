import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import type { WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import {
  assertMailboxReadable,
  contentOmittedReasonSchema,
  readState,
  requirePort,
  toStoredJson,
  writeState,
} from '@business-ai/core';
import {
  IMPORT_META_NAMESPACE,
  MAIL_FILE_NAMESPACE,
  MAIL_NAMESPACE,
  PRICE_UPLOAD_NAMESPACE,
  type PricesDeps,
} from './deps';

/** Откуда пришло обновление цен. */
const PRICE_SOURCE_KINDS = ['disk', 'intake', 'mail', 'employee'] as const;
export type PriceSourceKind = (typeof PRICE_SOURCE_KINDS)[number];

/**
 * Происхождение импорта. Хранилище staging (порт) источник не знает, поэтому он лежит рядом,
 * по тому же importId. Заполняет код, а не модель: подделать автора или отправителя нельзя.
 */
export const importMetaSchema = z.object({
  source: z.enum(PRICE_SOURCE_KINDS),
  fileName: z.string().optional(),
  /** Кто передал данные: тред сотрудника (для `employee`). */
  author: z.string().optional(),
  /** Адрес отправителя письма (для `mail`). */
  sender: z.string().optional(),
  /** Отправитель подтверждён SPF/DKIM/DMARC (для `mail`); false или нет поля - не подтверждён. */
  senderVerified: z.boolean().optional(),
  subject: z.string().optional(),
  receivedAt: z.string().optional(),
  /** Отпечаток прайса, поверх которого собран импорт сотрудника (для проверки при фиксации). */
  baseHash: z.string().optional(),
  /** Позиции разобраны скриптом (этап 111): обычный разбор по столбцам этот импорт не дополняет. */
  viaScript: z.boolean().optional(),
  /** Что сотрудник написал к своим правкам (для листа «Источник»). */
  notes: z.array(z.string()).default([]),
});
export type ImportMeta = z.infer<typeof importMetaSchema>;

/** Состояние обязательно для этого инструмента. */
export function requireState(deps: PricesDeps): WorkflowStateStore {
  return requirePort(deps.state, 'состояние сценариев');
}

export async function loadImportMeta(
  deps: PricesDeps,
  importId: string,
): Promise<ImportMeta | null> {
  if (deps.state === undefined) return null;
  return readState(deps.state, IMPORT_META_NAMESPACE, importId, importMetaSchema);
}

/**
 * Записать происхождение импорта; без состояния молча ничего не делает (импорт возможен).
 * Не-дисковые источники (в них тексты заметок) помечаются `done`, чтобы ретенция их убрала;
 * история импортов с диска нужна суточной проверке старых файлов и хранится дольше срока.
 */
export async function saveImportMeta(
  deps: PricesDeps,
  importId: string,
  meta: ImportMeta,
): Promise<void> {
  if (deps.state === undefined) return;
  const done = meta.source !== 'disk';
  await deps.state.put(IMPORT_META_NAMESPACE, importId, toStoredJson(meta), { done });
}

/** Вложение письма с прайсом. */
const mailAttachmentSchema = z.object({
  index: z.number().int().nonnegative(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  isScan: z.boolean(),
  /** Содержимое сохранено (не скан и не слишком большое). */
  stored: z.boolean(),
  /** Импорт, в который разобрано вложение (ставит код при stagePriceRows). */
  stagedImportId: z.string().optional(),
});
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

/** Статус письма: новое, от неизвестного, о неизвестном сообщили, обработано, пропущено. */
const MAIL_STATUSES = ['new', 'unknown', 'unknown_reported', 'handled', 'skipped'] as const;
type MailStatus = (typeof MAIL_STATUSES)[number];

export const mailRecordSchema = z.object({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  receivedAt: z.string(),
  bodyExcerpt: z.string(),
  /** Отправитель подтверждён SPF/DKIM/DMARC; нет поля (старая запись) = не подтверждён. */
  senderVerified: z.boolean().optional(),
  supplierId: z.string().optional(),
  /**
   * Чей ящик содержит письмо. Нет поля - запись старого формата (общий ящик, которого больше
   * нет): она никому не показывается. `id` записи составной (`<владелец>:<id в ящике>`),
   * поэтому одинаковые id писем в разных ящиках не пересекаются.
   */
  mailboxOwnerId: z.string().optional(),
  /** Id письма внутри ящика владельца: по нему письмо помечается обработанным. */
  mailboxMessageId: z.string().optional(),
  status: z.enum(MAIL_STATUSES),
  attachments: z.array(mailAttachmentSchema),
  /**
   * Содержимое письма не загружено (`too_large`: перечитыванием не лечится). Пустые вложения
   * здесь - не «в письме нет прайса»: менеджер видит причину и открывает письмо в почте.
   */
  contentOmitted: contentOmittedReasonSchema.optional(),
  /**
   * Письмо от адреса вне базы поставщиков, сохранённое потому, что сотрудник сам попросил
   * прочитать почту. Только такие записи без поставщика показываются; прежние (личные) нет.
   */
  readOnRequest: z.boolean().optional(),
});
export type MailRecord = z.infer<typeof mailRecordSchema>;

export const mailFileSchema = z.object({ base64: z.string() });

/** Префикс идентификатора вложения письма в аргументах инструментов чтения. */
const MAIL_PATH_PREFIX = 'mail:';
const MAIL_INDEX_SEPARATOR = '#';

export const mailKey = (messageId: string): string => `m:${messageId}`;
export const mailFileKey = (messageId: string, index: number): string =>
  `a:${messageId}${MAIL_INDEX_SEPARATOR}${index}`;

/** Идентификатор вложения письма: `mail:<id письма>#<номер>`. */
export function mailPath(messageId: string, index: number): string {
  return `${MAIL_PATH_PREFIX}${messageId}${MAIL_INDEX_SEPARATOR}${index}`;
}

/** Разобрать идентификатор вложения; null, если это не он. */
export function parseMailPath(path: string): { messageId: string; index: number } | null {
  if (!path.startsWith(MAIL_PATH_PREFIX)) return null;
  const rest = path.slice(MAIL_PATH_PREFIX.length);
  const cut = rest.lastIndexOf(MAIL_INDEX_SEPARATOR);
  const index = Number(rest.slice(cut + 1));
  if (cut <= 0 || !Number.isInteger(index) || index < 0) return null;
  return { messageId: rest.slice(0, cut), index };
}

/** Кто просит письмо: сотрудник чужого ящика его записи не получает. */
export type MailAccess = Pick<ToolContext, 'initiator' | 'threadId' | 'turnNumber'>;

/**
 * Запись письма. С `access` письмо чужого ящика (составной id другого сотрудника) не
 * отдаётся: отказ без ПДн. Плановый и неизвестный инициатор не ограничиваются.
 * @throws DomainError('access_denied')
 */
export async function loadMail(
  deps: PricesDeps,
  messageId: string,
  access?: MailAccess,
): Promise<MailRecord> {
  const record = await readState(
    requireState(deps),
    MAIL_NAMESPACE,
    mailKey(messageId),
    mailRecordSchema,
  );
  if (record === null) throw new DomainError('not_found', `Письмо ${messageId} не найдено.`);
  if (access !== undefined) assertMailboxReadable(access, record.mailboxOwnerId);
  return record;
}

/** Письмо закрыто: запись и вложения можно удалять ретенцией состояния. */
const CLOSED_MAIL_STATUSES: readonly MailStatus[] = ['handled', 'skipped', 'unknown_reported'];

export async function saveMail(deps: PricesDeps, record: MailRecord): Promise<void> {
  const done = CLOSED_MAIL_STATUSES.includes(record.status);
  await requireState(deps).put(MAIL_NAMESPACE, mailKey(record.id), toStoredJson(record), { done });
  if (!done) return;
  // Содержимое вложений закрытого письма тоже больше не нужно: помечаем его завершённым.
  // Только флаг (markDone): читать и писать обратно base64 по 10 МБ на вложение не нужно.
  // Записи, которых уже нет, пропускаются - как раньше при get === null.
  for (const item of record.attachments.filter((attachment) => attachment.stored)) {
    await requireState(deps).markDone(MAIL_FILE_NAMESPACE, mailFileKey(record.id, item.index));
  }
}

const uploadSchema = z.object({ at: z.string() });

/** Дата последней загрузки файла прайса поставщика; null, если не записана. */
export async function loadPriceUpload(
  deps: PricesDeps,
  supplierId: string,
): Promise<string | null> {
  if (deps.state === undefined) return null;
  const record = await readState(deps.state, PRICE_UPLOAD_NAMESPACE, supplierId, uploadSchema);
  return record?.at ?? null;
}

/** Записей дат загрузки за одно обращение к хранилищу при чтении всех поставщиков. */
const PRICE_UPLOAD_PAGE = 200;
/** Предел страниц при чтении всех дат загрузки (по записи на поставщика: с большим запасом). */
const PRICE_UPLOAD_MAX_PAGES = 100;

/**
 * Даты загрузки прайсов всех поставщиков за один проход по пространству (вместо `get` на
 * каждого поставщика). Возвращает поиск по id поставщика: дату или null, если не записана.
 * Повреждённая запись даёт `external_failure` при обращении к этому поставщику - как у
 * {@link loadPriceUpload}.
 */
export async function loadAllPriceUploads(
  deps: PricesDeps,
): Promise<(supplierId: string) => string | null> {
  const uploads = new Map<string, string | null>();
  if (deps.state !== undefined) {
    const entries = stateEntries(deps.state, PRICE_UPLOAD_NAMESPACE, {
      pageSize: PRICE_UPLOAD_PAGE,
      maxPages: PRICE_UPLOAD_MAX_PAGES,
    });
    for await (const entry of entries) {
      const parsed = uploadSchema.safeParse(entry.value);
      uploads.set(entry.key, parsed.success ? parsed.data.at : null);
    }
  }
  const corrupt = new Set([...uploads].filter(([, at]) => at === null).map(([key]) => key));
  return (supplierId) => {
    if (corrupt.has(supplierId)) {
      throw new DomainError(
        'external_failure',
        `Состояние ${PRICE_UPLOAD_NAMESPACE}/${supplierId} повреждено.`,
      );
    }
    return uploads.get(supplierId) ?? null;
  };
}

/** Записать дату загрузки файла; без хранилища состояния ничего не делает. */
export async function savePriceUpload(
  deps: PricesDeps,
  supplierId: string,
  at: string,
): Promise<void> {
  if (deps.state === undefined) return;
  await writeState(deps.state, PRICE_UPLOAD_NAMESPACE, supplierId, { at });
}
