import { z } from 'zod';
import {
  isSenderVerified,
  type InboxMessage,
  type WorkflowStateEntry,
  type WorkflowStateStore,
} from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import {
  INBOX_PAGE_SIZE,
  MAX_ATTACHMENT_BYTES,
  REPLIES_NAMESPACE_PREFIX,
  REPLY_FILES_NAMESPACE_PREFIX,
} from './deps';
import { base64Of } from '@business-ai/core';

const attachmentRefSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  stored: z.boolean(),
});
/**
 * Каналы ответа поставщика: письмо читается из ящика, остальные записывает сотрудник со своих
 * слов (`recordSupplierReply`): телефон, мессенджер, другое.
 */
export const REPLY_CHANNELS = ['email', 'phone', 'messenger', 'other'] as const;
export type ReplyChannel = (typeof REPLY_CHANNELS)[number];
/** Каналы, которые записывает сотрудник (почта читается кодом из ящика). */
export const MANUAL_REPLY_CHANNELS = ['phone', 'messenger', 'other'] as const;
const storedReplySchema = z.object({
  id: z.string(),
  channel: z.enum(REPLY_CHANNELS),
  supplierId: z.string(),
  subject: z.string().optional(),
  text: z.string(),
  receivedAt: z.string().optional(),
  attachments: z.array(attachmentRefSchema),
  /** Письмо пришло без подтверждения отправителя (SPF/DKIM/DMARC): цену проверять отдельно. */
  senderUnverified: z.boolean().optional(),
  /** Ответ записал сотрудник со слов поставщика (не почта): его идентификатор. */
  recordedBy: z.string().min(1).optional(),
  /** Поставщик отказался давать КП (явный отказ): заказ по нему закрыт. */
  declined: z.boolean().optional(),
});
export type StoredReply = z.infer<typeof storedReplySchema>;
export const attachmentBodySchema = z.object({ base64: z.string() });

/** Вложение письма в виде, пригодном для хранения; `base64` нет у слишком большого файла. */
export const mailAttachmentPartSchema = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  base64: z.string().optional(),
});
/** Письмо поставщика, разобранное на части для хранения. */
export interface MailParts {
  id: string;
  subject: string;
  body: string;
  receivedAt: string;
  attachments: Array<z.infer<typeof mailAttachmentPartSchema>>;
  /** Отправитель подтверждён почтовой аутентификацией; нет поля — запись старого формата. */
  senderVerified?: boolean;
}

/** Префикс ключей записей-писем; вложения (`a:`) в списке по ключу стоят раньше них. */
const MAIL_KEY_PREFIX = 'm:';
export const replyKey = (id: string): string => `${MAIL_KEY_PREFIX}${id}`;
export const attachmentKey = (id: string, index: number): string => `a:${id}#${index}`;
export const repliesNamespace = (requestId: string): string =>
  `${REPLIES_NAMESPACE_PREFIX}${requestId}`;
/** Пространство имён тел вложений ответов по заявке (отдельно от записей ответов). */
export const replyFilesNamespace = (requestId: string): string =>
  `${REPLY_FILES_NAMESPACE_PREFIX}${requestId}`;

/**
 * Записи-письма пространства (ключи `m:`) по порядку ключа, постранично. Чтение начинается
 * сразу за префиксом `m:`, а не с начала: вложения прежнего формата (`a:`, тела до 5 МБ в
 * том же пространстве) пропускаются переходом по ключу и не читаются (R5-CORE-7). Не больше
 * `maxPages` страниц.
 */
export async function* mailEntries(
  store: WorkflowStateStore,
  namespace: string,
  pageSize: number,
  maxPages: number = Number.POSITIVE_INFINITY,
  onLimit?: () => void,
): AsyncGenerator<WorkflowStateEntry> {
  yield* stateEntries(store, namespace, {
    pageSize,
    maxPages,
    ...(onLimit === undefined ? {} : { onLimit }),
    after: MAIL_KEY_PREFIX,
    prefix: MAIL_KEY_PREFIX,
  });
}
/** Идентификатор сохранённого ответа-письма по id письма в ящике. */
const emailReplyId = (messageId: string): string => `in:${messageId}`;

/** Письмо из ящика в части для хранения: крупные вложения остаются без содержимого. */
export function toMailParts(
  message: InboxMessage,
  senderVerified: boolean = isSenderVerified(message),
): MailParts {
  return {
    id: message.id,
    subject: message.subject,
    body: message.body,
    receivedAt: message.receivedAt,
    senderVerified,
    attachments: message.attachments.map((file) => ({
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.length,
      ...(file.bytes.length <= MAX_ATTACHMENT_BYTES
        ? { base64: base64Of(file.bytes) }
        : {}),
    })),
  };
}

/** Сохранить ответ, если его ещё нет; true, если запись новая. */
export async function storeReply(
  store: WorkflowStateStore,
  requestId: string,
  reply: StoredReply,
): Promise<boolean> {
  const known = await store.get(repliesNamespace(requestId), replyKey(reply.id));
  if (known !== null) return false;
  await writeState(store, repliesNamespace(requestId), replyKey(reply.id), reply);
  return true;
}

/** Сохранить письмо поставщика ответом по заявке (вложения отдельными записями). */
export async function storeEmail(
  store: WorkflowStateStore,
  requestId: string,
  mail: MailParts,
  supplierId: string,
): Promise<boolean> {
  const id = emailReplyId(mail.id);
  const attachments = [];
  for (const [index, file] of mail.attachments.entries()) {
    const stored = file.base64 !== undefined;
    if (file.base64 !== undefined) {
      const body = { base64: file.base64 };
      await writeState(store, replyFilesNamespace(requestId), attachmentKey(id, index), body);
    }
    attachments.push({
      id: `${id}#${index}`,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      stored,
    });
  }
  return storeReply(store, requestId, {
    id,
    channel: 'email',
    supplierId,
    subject: mail.subject,
    text: mail.body,
    receivedAt: mail.receivedAt,
    attachments,
    ...(mail.senderVerified === false ? { senderUnverified: true } : {}),
  });
}

/** Все сохранённые ответы по заявке. */
export async function loadReplies(
  store: WorkflowStateStore,
  requestId: string,
): Promise<StoredReply[]> {
  const result: StoredReply[] = [];
  for await (const entry of mailEntries(store, repliesNamespace(requestId), INBOX_PAGE_SIZE)) {
    const parsed = storedReplySchema.safeParse(entry.value);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

/**
 * Содержимое сохранённого вложения ответа; null, если записи нет. Новые вложения лежат в
 * отдельном пространстве; нет там - читаем из прежнего (записи до разделения).
 */
export async function loadAttachmentBody(
  store: WorkflowStateStore,
  requestId: string,
  replyId: string,
  index: number,
): Promise<{ base64: string } | null> {
  const key = attachmentKey(replyId, index);
  const current = await readState(
    store,
    replyFilesNamespace(requestId),
    key,
    attachmentBodySchema,
  );
  if (current !== null) return current;
  return readState(store, repliesNamespace(requestId), key, attachmentBodySchema);
}
