import { z } from 'zod';
import { DomainError, isMailboxNotConnectedError } from '@business-ai/core';
import type { InboxSource, MailboxDirectory } from '@business-ai/core';
import { defineTool, type ToolContext } from '@business-ai/core';
import {
  assertMailboxReadable,
  contentOmittedReasonSchema,
  mailboxThreadScope,
  predecessorOf,
  requirePort,
  tablesToMarkdown,
} from '@business-ai/core';
import { MAX_ATTACHMENT_TEXT_CHARS, MAX_REPLY_TEXT_CHARS, type OrderCalcDeps } from './deps';
import { offerQuoteReplacements } from './quote-replacement';
import { ingestInbox, listHeldMailFor, type InboxIngestSource } from './reply-ingest';
import { isManagerNotified, listUnassignedMailFor, mailCode } from './reply-routing';
import { REPLY_CHANNELS, loadAttachmentBody, loadReplies } from './reply-store';
import { loadSelection, loadSent } from './state';

/** Куда смотреть за ответами по заявке в ящиках сотрудников. */
type MailboxReading =
  | { kind: 'mailbox'; source: InboxIngestSource }
  /** Читать нечего: заявка ещё не отправлена, запись старого формата или ящик не подключён. */
  | { kind: 'unavailable' };

/**
 * Ящик владельца заявки (`SentRecord.mailboxOwnerId`) и курсор по его id. Записи старого
 * формата (без владельца) пропускаются с меткой в журнале: чей ящик читать, неизвестно.
 */
async function resolveOwnerMailbox(
  deps: OrderCalcDeps,
  mailboxes: MailboxDirectory,
  requestId: string,
): Promise<MailboxReading> {
  const sent = await loadSent(deps, requestId);
  if (sent === null) return { kind: 'unavailable' };
  const owner = sent.mailboxOwnerId;
  if (owner === undefined) {
    deps.log?.('order_reply_legacy_sent_skipped', { count: 1 });
    return { kind: 'unavailable' };
  }
  let inbox: InboxSource;
  try {
    inbox = await mailboxes.forEmployee(owner);
  } catch (error) {
    if (isMailboxNotConnectedError(error)) {
      deps.log?.('order_reply_mailbox_not_connected', {});
      return { kind: 'unavailable' };
    }
    throw error;
  }
  return { kind: 'mailbox', source: { inbox, cursorKey: owner, ownerUserId: owner } };
}

/**
 * Ответы заявки лежат в ящике её владельца (`SentRecord.mailboxOwnerId`), и читает их только
 * он. Сотрудник другого ящика, даже зная requestId, получает отказ без данных. Заявка без
 * записи об отправке или старого формата доступ не ограничивает: в ней нет чужого ящика.
 * @throws DomainError('access_denied')
 */
async function assertRequestMailboxAccess(
  deps: OrderCalcDeps,
  requestId: string,
  context: Pick<ToolContext, 'initiator' | 'threadId'>,
): Promise<void> {
  const sent = await loadSent(deps, requestId);
  if (sent === null) return;
  assertMailboxReadable(context, sent.mailboxOwnerId);
}

/** Окно, в пределах которого повторное чтение ответов считается тем же вызовом, мс. */
const READ_REPLIES_SLOT_MS = 60_000;

const replyViewSchema = z.object({
  replyId: z.string(),
  supplierId: z.string(),
  channel: z.enum(REPLY_CHANNELS),
  subject: z.string().optional(),
  text: z.string(),
  textTruncated: z.boolean(),
  receivedAt: z.string().optional(),
  /** false: отправитель письма не подтверждён (SPF/DKIM/DMARC); менеджеру это показывается. */
  senderVerified: z.boolean(),
  /** Ответ записал сотрудник со слов поставщика (телефон, мессенджер), а не пришло письмо. */
  recordedByEmployee: z.boolean().optional(),
  /** Поставщик отказался давать КП. */
  declined: z.boolean().optional(),
  attachments: z.array(
    z.object({
      attachmentId: z.string(),
      fileName: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int(),
      readable: z.boolean(),
    }),
  ),
});
const readRepliesOutputSchema = z.object({
  requestId: z.string(),
  replies: z.array(replyViewSchema),
  /** Сколько ответов появилось в этом вызове. */
  newCount: z.number().int(),
  /** Выбранные менеджером поставщики, от которых ответов ещё нет. */
  notRepliedSupplierIds: z.array(z.string()),
  /** Поставщики, чьё КП уже разобрано (recordQuote). */
  quotedSupplierIds: z.array(z.string()),
  /**
   * Письма, которые могут относиться к этой заявке, но однозначно не привязаны: менеджер
   * получит вопрос текстом (отправлен, когда managerNotified=true), его ответ записывает
   * routeSupplierMail. Текста письма здесь нет: до решения человека оно не разбирается.
   */
  unassigned: z.array(
    z.object({
      /** Код письма из вопроса менеджеру (для routeSupplierMail, если писем несколько). */
      mailCode: z.string(),
      supplierId: z.string(),
      receivedAt: z.string(),
      candidateRequestIds: z.array(z.string()),
      /** Вопрос менеджеру отправлен и подтверждён каналом; пока false - он ещё не получен. */
      managerNotified: z.boolean(),
    }),
  ),
  /**
   * Письма поставщика по этой заявке, чьё содержимое НЕ получено (слишком большое, отправитель
   * не в списке и т.п.): ответом они не сохранены, текста и вложений нет. Это не «пустое
   * письмо»: сообщи менеджеру причину и попроси открыть письмо в почте; цену не домысливай.
   */
  contentOmitted: z.array(
    z.object({
      supplierId: z.string(),
      receivedAt: z.string(),
      reason: contentOmittedReasonSchema,
      /** Менеджеру отправлено уведомление с причиной и подтверждено каналом. */
      managerNotified: z.boolean(),
    }),
  ),
  inboxConnected: z.boolean(),
});
type ReadRepliesOutput = z.infer<typeof readRepliesOutputSchema>;

/**
 * Прочитать ответы выбранных поставщиков по заявке: письма из ящика владельца заявки.
 * Эффекты есть: письма помечаются обработанными, курсор сдвигается, менеджеру уходят вопросы
 * (разнесение писем, замена КП). Поэтому инструмент с `sideEffect` (аудит, ключ операции);
 * сами эффекты идемпотентны: сохранение по id ответа, ключи сообщений канала стабильны.
 */
export const readSupplierReplies = defineTool<
  { requestId: string },
  ReadRepliesOutput,
  OrderCalcDeps
>({
  name: 'readSupplierReplies',
  description:
    'Прочитать ответы поставщиков по заявке requestId: ответы на запросы и письма из почты ' +
    '(только от поставщиков, которым по этой заявке ушёл запрос, и только полученные после ' +
    'отправки). Возвращает тексты, вложения (читаются readReplyAttachment), поставщиков без ' +
    'ответа и тех, чьё КП уже разобрано. unassigned: письма поставщика, у которого открыто ' +
    'несколько заявок, без однозначной привязки; к какой заявке отнести, решает менеджер ' +
    'ответом на вопрос (ушёл, только если managerNotified=true), его ответ запиши ' +
    'routeSupplierMail. До этого не разбирай и не угадывай заявку.',
  sideEffect: true,
  idempotencyKey: (input) => `order-read-replies:${input.requestId}`,
  // Чтение повторяется по мере прихода писем: ключ меняется с минутой, составом сохранённых
  // ответов и КП (кэш не должен скрывать новое письмо). В режиме ящиков в ключ входит тред:
  // рантайм отдаёт кэш ДО проверки доступа, и без треда сотрудник B в ту же минуту получил бы
  // сохранённый результат чтения сотрудника A.
  idempotencyPredecessor: async (input, deps, threadId) => {
    const replies = await loadReplies(deps.state, input.requestId);
    const quoted = await deps.quotes.listByRequest(input.requestId);
    return predecessorOf({
      slot: Math.floor(deps.clock.now().getTime() / READ_REPLIES_SLOT_MS),
      scope: mailboxThreadScope(deps.mailboxes !== undefined, threadId),
      replies: replies.map((reply) => reply.id).sort(),
      quotes: quoted.map((quote) => `${quote.supplierId}:${quote.sourceRef ?? ''}`).sort(),
    });
  },
  inputSchema: z.object({ requestId: z.string().min(1) }),
  outputSchema: readRepliesOutputSchema,
  async execute(input, deps, context) {
    await assertRequestMailboxAccess(deps, input.requestId, context);
    const selection = await loadSelection(deps, input.requestId);
    if (selection === null) {
      throw new DomainError(
        'not_found',
        'Менеджер ещё не выбрал поставщиков по заявке: читать ответы рано.',
      );
    }
    // Ответы читаются из ящика владельца заявки; без ящиков сотрудников почты нет.
    const mailboxes = requirePort(deps.mailboxes, 'почта сотрудников');
    const reading = await resolveOwnerMailbox(deps, mailboxes, input.requestId);
    const added =
      reading.kind === 'mailbox'
        ? ((await ingestInbox(deps, reading.source)).get(input.requestId) ?? 0)
        : 0;
    const inboxConnected = reading.kind === 'mailbox';
    // Новый ответ после записанного КП: менеджеру уходит вопрос о замене КП (R4-AGT-5).
    await offerQuoteReplacements(deps, input.requestId);
    const replies = await loadReplies(deps.state, input.requestId);
    // Письма заявки читаются по вторичным ключам, а не просмотром всего пространства писем.
    const unassigned = await listUnassignedMailFor(deps, input.requestId);
    const omitted = await listHeldMailFor(deps, input.requestId);
    const quoted = (await deps.quotes.listByRequest(input.requestId)).map((q) => q.supplierId);
    const answered = new Set(replies.map((reply) => reply.supplierId));
    return {
      requestId: input.requestId,
      replies: replies.map((reply) => ({
        replyId: reply.id,
        supplierId: reply.supplierId,
        channel: reply.channel,
        ...(reply.subject === undefined ? {} : { subject: reply.subject }),
        text: reply.text.slice(0, MAX_REPLY_TEXT_CHARS),
        textTruncated: reply.text.length > MAX_REPLY_TEXT_CHARS,
        ...(reply.receivedAt === undefined ? {} : { receivedAt: reply.receivedAt }),
        senderVerified: reply.senderUnverified !== true,
        ...(reply.recordedBy === undefined ? {} : { recordedByEmployee: true }),
        ...(reply.declined === true ? { declined: true } : {}),
        attachments: reply.attachments.map((file) => ({
          attachmentId: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          readable: file.stored,
        })),
      })),
      newCount: added,
      notRepliedSupplierIds: selection.supplierIds.filter((id) => !answered.has(id)),
      quotedSupplierIds: quoted,
      unassigned: unassigned.map((mail) => ({
        mailCode: mailCode(mail),
        supplierId:
          mail.candidates.find((item) => item.requestId === input.requestId)?.supplierId ??
          mail.candidates[0]?.supplierId ??
          '',
        receivedAt: mail.receivedAt,
        candidateRequestIds: [...new Set(mail.candidates.map((item) => item.requestId))],
        managerNotified: isManagerNotified(mail),
      })),
      contentOmitted: omitted.flatMap((mail) => {
        const reason = mail.contentOmitted;
        const own = mail.candidates.find((item) => item.requestId === input.requestId);
        if (reason === undefined || own === undefined) return [];
        const notified = mail.threadIds.every((id) => mail.notifiedThreadIds.includes(id));
        const { supplierId } = own;
        return [{ supplierId, receivedAt: mail.receivedAt, reason, managerNotified: notified }];
      }),
      inboxConnected,
    };
  },
});

interface ReadAttachmentInput {
  requestId: string;
  attachmentId: string;
}
interface ReadAttachmentOutput {
  fileName: string;
  text: string;
  tables: string;
  textTruncated: boolean;
  needsOcr: boolean;
  parserTruncated: boolean;
  warnings: string[];
}

/** Вложение ответа поставщика: имя и содержимое (после проверки доступа к ящику заявки). */
export interface ReplyAttachmentContent {
  file: { fileName: string };
  bytes: Uint8Array;
}

/**
 * Прочитать сохранённое вложение ответа по `requestId` и `attachmentId` (из readSupplierReplies).
 * Доступ проверяется так же, как у чтения ответов: чужой ящик - `access_denied`.
 * @throws DomainError('access_denied' | 'not_found' | 'invalid_input')
 */
export async function loadReplyAttachment(
  deps: OrderCalcDeps,
  requestId: string,
  attachmentId: string,
  context: ToolContext,
): Promise<ReplyAttachmentContent> {
  await assertRequestMailboxAccess(deps, requestId, context);
  const hash = attachmentId.lastIndexOf('#');
  const replyId = attachmentId.slice(0, hash);
  const index = Number(attachmentId.slice(hash + 1));
  const reply = (await loadReplies(deps.state, requestId)).find((r) => r.id === replyId);
  const file = reply?.attachments[index];
  if (hash < 0 || file === undefined) {
    throw new DomainError('not_found', `Вложение ${attachmentId} не найдено.`);
  }
  if (!file.stored) {
    throw new DomainError(
      'invalid_input',
      `Вложение «${file.fileName}» слишком большое и не сохранено: попросите менеджера.`,
    );
  }
  const body = await loadAttachmentBody(deps.state, requestId, replyId, index);
  if (body === null) {
    throw new DomainError('not_found', `Содержимое вложения ${attachmentId} потеряно.`);
  }
  return { file, bytes: Buffer.from(body.base64, 'base64') };
}

/** Прочитать вложение ответа поставщика (прайс или КП файлом) через разбор документов. */
export const readReplyAttachment = defineTool<
  ReadAttachmentInput,
  ReadAttachmentOutput,
  OrderCalcDeps
>({
  name: 'readReplyAttachment',
  readsFile: true,
  description:
    'Прочитать вложение ответа поставщика: requestId и attachmentId из readSupplierReplies. ' +
    'Возвращает текст и таблицы файла. needsOcr=true: это скан, содержимое не извлечено, ' +
    'ничего не домысливай, сообщи менеджеру.',
  inputSchema: z.object({ requestId: z.string().min(1), attachmentId: z.string().min(1) }),
  outputSchema: z.object({
    fileName: z.string(),
    text: z.string(),
    tables: z.string(),
    textTruncated: z.boolean(),
    needsOcr: z.boolean(),
    parserTruncated: z.boolean(),
    warnings: z.array(z.string()),
  }),
  async execute(input, deps, context) {
    const { requestId, attachmentId } = input;
    const attachment = await loadReplyAttachment(deps, requestId, attachmentId, context);
    const parser = requirePort(deps.parser, 'разбор документов');
    const { file } = attachment;
    const parsed = await parser.parse(file.fileName, attachment.bytes);
    return {
      fileName: file.fileName,
      text: parsed.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
      tables: tablesToMarkdown(parsed.tables).slice(0, MAX_ATTACHMENT_TEXT_CHARS),
      textTruncated: parsed.text.length > MAX_ATTACHMENT_TEXT_CHARS,
      needsOcr: parsed.needsOcr,
      parserTruncated: parsed.truncated,
      warnings: parsed.warnings,
    };
  },
});
