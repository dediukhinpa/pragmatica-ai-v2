import { z } from 'zod';
import type {
  ChatMessage,
  ContentOmittedReason,
  InboxMessage,
  InboxSource,
  WorkflowStateStore,
} from '@business-ai/core';
import { DAY_MS } from '../../kit/domain/time';
import {
  HELD_MAX_REREADS,
  contentOmittedReasonSchema,
  isMailSenderTrusted,
  readState,
  toStoredJson,
  writeState,
} from '@business-ai/core';
import {
  buildSupplierEmailIndex,
  suppliersByAddress,
  type SupplierEmailIndex,
} from '../shared/supplier-email-index';
import {
  INBOX_CURSOR_NAMESPACE,
  INBOX_MAX_PAGES,
  INBOX_PAGE_SIZE,
  REPLY_WINDOW_DAYS,
  UNASSIGNED_FILES_NAMESPACE,
  UNASSIGNED_MAIL_NAMESPACE,
  type OrderCalcDeps,
} from './deps';
import { ensureMailIndex, heldMessageIdsFor, indexHeldMail, unindexHeldMail } from './mail-index';
import {
  UNVERIFIED_SENDER_NOTE,
  buildSentIndex,
  candidateNames,
  candidateSchema,
  holdForManager,
  loadAllSent,
  loadUnassignedBody,
  mailToken,
  routeMail,
  type MailRoute,
  type RouteCandidate,
  type SentIndex,
} from './reply-routing';
import { listOpenSelections } from './open-selections';
import {
  attachmentKey,
  mailAttachmentPartSchema,
  storeEmail,
  toMailParts,
  type MailParts,
} from './reply-store';
import { loadProposal, orderRecipient, type Selection, type SentRecord } from './state';
import { requestLabels } from './request-title';

/** Ящик, из которого читаются ответы, и ключ его курсора в состоянии. */
export interface InboxIngestSource {
  inbox: InboxSource;
  /** Ключ курсора в `INBOX_CURSOR_NAMESPACE`: id сотрудника - владельца ящика. */
  cursorKey: string;
  /**
   * Сотрудник - владелец ящика: письма привязываются только к его заявкам (`SentRecord.
   * mailboxOwnerId`).
   */
  ownerUserId: string;
}

/**
 * Причины, при которых письмо без содержимого можно перечитать по id (`getMessage`): список
 * отправителей адаптера или сбой скачивания, но не размер письма.
 */
const REREADABLE_REASONS: ReadonlySet<ContentOmittedReason> = new Set<ContentOmittedReason>([
  'sender_not_allowed',
  'allowlist_unavailable',
  'fetch_failed',
  'parse_failed',
  'preview_only',
]);

/**
 * Источник, который умеет отдать письмо целиком по id (ящик сотрудника). Тип ящика здесь
 * не нужен: проверяется только наличие чтения, отправка недоступна.
 */
interface RereadableInbox {
  getMessage?: (id: string) => Promise<InboxMessage | null>;
}

/** Что видит сотрудник: почему содержимое письма не получено. */
const OMITTED_REASON_TEXT: Readonly<Record<ContentOmittedReason, string>> = {
  too_large: 'письмо слишком большое, почтовый сервис его не загружает',
  sender_not_allowed: 'отправитель письма не найден в списке поставщиков ящика',
  allowlist_unavailable: 'список поставщиков ящика временно недоступен',
  fetch_failed: 'письмо не удалось загрузить с почтового сервера',
  parse_failed: 'письмо не удалось разобрать',
  preview_only: 'получено только начало письма',
};

/** Сколько писем одного ящика ждут повторного разбора (остальные только журналируются). */
const HELD_MAX_PENDING = 50;

/**
 * Письмо от поставщика из базы, которое пока нельзя разобрать (R6-10-01, R6-01-06): либо
 * содержимое не загружено (`contentOmitted`), либо запрос по заявке ещё не записан
 * (`candidates` пуст). Ответом оно НЕ сохраняется. Курсор почты уходит дальше, но письмо не
 * теряется: запись лежит в состоянии, повторный разбор идёт по списку ожидающих (`pending:`).
 * Ключ записи - `h:<id письма>` в пространстве писем без привязки.
 */
const heldSchema = z.object({
  messageId: z.string(),
  token: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.string(),
  attachments: z.array(mailAttachmentPartSchema),
  senderVerified: z.boolean().optional(),
  inReplyTo: z.string().optional(),
  /** Поставщики базы с адресом отправителя на момент получения. */
  supplierIds: z.array(z.string()),
  contentOmitted: contentOmittedReasonSchema.optional(),
  /** Заявки, к которым письмо может относиться; пусто - запрос ещё не записан. */
  candidates: z.array(candidateSchema),
  threadIds: z.array(z.string()),
  /** Треды, куда уведомление «содержимое не получено» уже отправлено. */
  notifiedThreadIds: z.array(z.string()).default([]),
  /** Сколько раз письмо перечитывали по id. */
  attempts: z.number().int().default(0),
  /** Письмо разобрано или устарело: запись больше не обрабатывается. */
  closedAt: z.string().optional(),
});
export type HeldMail = z.infer<typeof heldSchema>;

const pendingSchema = z.object({ ids: z.array(z.string()) });
const heldKey = (messageId: string): string => `h:${messageId}`;
const pendingKey = (cursorKey: string): string => `pending:${cursorKey}`;

/**
 * Письма без содержимого по заявке (причина «содержимое не получено», запись открыта, окно
 * ответа не истекло). Читаются указатели заявки и сами письма по ним, а не все записи `h:`;
 * при первом обращении старые записи однократно вносятся в индекс.
 */
export async function listHeldMailFor(
  deps: Pick<OrderCalcDeps, 'state' | 'clock' | 'log'>,
  requestId: string,
): Promise<HeldMail[]> {
  await ensureMailIndex(deps.state, deps.clock.now(), deps.log);
  const found: HeldMail[] = [];
  for await (const messageId of heldMessageIdsFor(deps.state, requestId)) {
    const mail = await readState(
      deps.state,
      UNASSIGNED_MAIL_NAMESPACE,
      heldKey(messageId),
      heldSchema,
    );
    if (mail === null || mail.closedAt !== undefined || mail.contentOmitted === undefined) {
      continue;
    }
    if (isHeldExpired(mail, deps.clock.now())) continue;
    if (mail.candidates.some((candidate) => candidate.requestId === requestId)) found.push(mail);
  }
  return found;
}

/** Окно ответа истекло: письмо больше не может быть ответом на запрос. */
function isHeldExpired(mail: HeldMail, now: Date): boolean {
  const received = Date.parse(mail.receivedAt);
  return Number.isNaN(received) || now.getTime() - received > REPLY_WINDOW_DAYS * DAY_MS;
}

/** Заявки, ответом по которым считается письмо при `assigned`/`ambiguous`. */
function candidatesOf(route: MailRoute): RouteCandidate[] {
  if (route.kind === 'assigned') return [route.candidate];
  return route.kind === 'ambiguous' ? route.candidates : [];
}

/** Тред-получатели уведомлений по заявкам-кандидатам. */
async function threadsFor(
  deps: OrderCalcDeps,
  candidates: readonly RouteCandidate[],
): Promise<string[]> {
  const threads = new Set<string>();
  for (const candidate of candidates) {
    const proposal = await loadProposal(deps, candidate.requestId);
    threads.add(await orderRecipient(deps, candidate.requestId, proposal));
  }
  return [...threads];
}

/** Уведомление менеджеру: содержимое письма не получено. Текст письма в него не входит. */
function buildOmittedMessage(
  mail: HeldMail,
  supplierNames: ReadonlyMap<string, string>,
): ChatMessage {
  const reason = mail.contentOmitted;
  const requests = [...new Set(mail.candidates.map((candidate) => candidate.requestId))];
  const who = [...new Set(mail.candidates.map((candidate) => candidate.supplierId))]
    .map((id) => `«${supplierNames.get(id) ?? id}»`)
    .join(', ');
  return {
    text:
      `Письмо поставщика ${who} (получено ${mail.receivedAt}) по заявке ${requests.join(', ')} ` +
      `получено не полностью: ${reason === undefined ? '' : OMITTED_REASON_TEXT[reason]}. ` +
      'Ответ не сохранён и в сравнение КП не попал; откройте письмо в почте.' +
      (mail.senderVerified === false ? ` ${UNVERIFIED_SENDER_NOTE}` : ''),
  };
}

/** Поставщики, которым наше письмо с таким id ушло (по квитанциям `SentRecord.messageIds`). */
function suppliersRepliedTo(sent: readonly SentRecord[], inReplyTo: string | undefined): string[] {
  if (inReplyTo === undefined || inReplyTo === '') return [];
  const found = new Set<string>();
  for (const record of sent) {
    for (const [supplierId, messageId] of Object.entries(record.messageIds)) {
      if (messageId === inReplyTo) found.add(supplierId);
    }
  }
  return [...found];
}

/** Записи отправки и выбранные менеджером заявки, нужные для привязки (грузятся лениво). */
interface RoutingData {
  sent: SentRecord[];
  /** Отправки по поставщикам: строится один раз за проход, письмо не перебирает все записи. */
  sentIndex: SentIndex;
  /** Поставщики, которым уходили запросы, в порядке записей (порядок кнопок разнесения). */
  sentSupplierIds: string[];
}

/** Результат разбора одного письма. */
type PlaceOutcome = 'stored' | 'held' | 'skipped';

/**
 * Один проход чтения ящика. Порядок надёжности: письмо сохраняется, потом помечается
 * обработанным, потом сдвигается курсор; сбой между шагами даёт повторное чтение, а не потерю.
 */
class InboxIngest {
  readonly added = new Map<string, number>();
  private routing: RoutingData | undefined;
  private openSelections: Selection[] | undefined;
  private pending: string[] = [];
  private pendingLoaded = false;

  constructor(
    private readonly deps: OrderCalcDeps,
    private readonly inbox: InboxSource,
    private readonly cursorKey: string,
    private readonly ownerUserId: string,
  ) {}

  /** Записи отправки (только заявки владельца ящика); грузятся один раз. */
  private async routingData(): Promise<RoutingData> {
    if (this.routing === undefined) {
      const loaded = await loadAllSent(this.deps.state, this.ownerUserId, this.deps.log);
      if (loaded.legacy > 0) {
        // Записи старого формата (без владельца ящика) в режиме ящиков не читаются.
        this.deps.log?.('order_reply_legacy_sent_skipped', { count: loaded.legacy });
      }
      const sentSupplierIds = [...new Set(loaded.records.flatMap((record) => record.supplierIds))];
      this.routing = {
        sent: loaded.records,
        sentIndex: buildSentIndex(loaded.records),
        sentSupplierIds,
      };
    }
    return this.routing;
  }

  /**
   * Выбор менеджера, по которому запрос ещё не записан ни у кого (R6-01-06): ответ на него
   * может прийти раньше записи об отправке (`partial`/`in_doubt`). Читается индекс открытых
   * выборов; за проход ящика список собирается один раз.
   */
  private async unsentSelections(): Promise<Selection[]> {
    this.openSelections ??= await listOpenSelections(this.deps);
    return this.openSelections;
  }

  /** Письмо может быть ответом на запрос, который выбран менеджером, но ещё не записан. */
  private async awaitsSentRecord(
    supplierIds: readonly string[],
    receivedAt: string,
  ): Promise<boolean> {
    const received = Date.parse(receivedAt);
    if (Number.isNaN(received) || supplierIds.length === 0) return false;
    const selections = await this.unsentSelections();
    return selections.some((selection) => {
      const created = Date.parse(selection.createdAt);
      return (
        !Number.isNaN(created) &&
        received >= created &&
        received - created <= REPLY_WINDOW_DAYS * DAY_MS &&
        selection.supplierIds.some((id) => supplierIds.includes(id))
      );
    });
  }

  /** Источник умеет отдавать письмо целиком по id (ящик сотрудника). */
  private canReread(): boolean {
    return typeof (this.inbox as RereadableInbox).getMessage === 'function';
  }

  /** Перечитать письмо по id; null - не удалось (сбой фиксируется в журнале без адресов). */
  private async reread(id: string): Promise<InboxMessage | null> {
    const box = this.inbox as RereadableInbox;
    if (typeof box.getMessage !== 'function') return null;
    try {
      return await box.getMessage(id);
    } catch {
      this.deps.log?.('order_reply_reread_failed', {});
      return null;
    }
  }

  private async loadPending(): Promise<void> {
    if (this.pendingLoaded) return;
    const state = this.deps.state;
    const key = pendingKey(this.cursorKey);
    const saved = await readState(state, INBOX_CURSOR_NAMESPACE, key, pendingSchema);
    this.pending = saved?.ids ?? [];
    this.pendingLoaded = true;
  }

  private async savePending(next: string[]): Promise<void> {
    const changed =
      next.length !== this.pending.length || next.some((id, i) => id !== this.pending[i]);
    this.pending = next;
    if (!changed) return;
    const key = pendingKey(this.cursorKey);
    await writeState(this.deps.state, INBOX_CURSOR_NAMESPACE, key, { ids: next });
  }

  /** Запись можно разбирать повторно: нет заявки либо письмо ещё можно перечитать. */
  private needsReplay(mail: HeldMail): boolean {
    if (mail.candidates.length === 0) return true;
    const reason = mail.contentOmitted;
    return (
      reason !== undefined &&
      REREADABLE_REASONS.has(reason) &&
      this.canReread() &&
      mail.attempts < HELD_MAX_REREADS
    );
  }

  /** Закрыть запись; `releaseFiles` - вложения больше не нужны (ответ сохранён или устарел). */
  private async close(mail: HeldMail, releaseFiles: boolean): Promise<void> {
    const state = this.deps.state;
    const closed: HeldMail = { ...mail, closedAt: this.deps.clock.now().toISOString() };
    await state.put(UNASSIGNED_MAIL_NAMESPACE, heldKey(mail.messageId), toStoredJson(closed), {
      done: true,
    });
    await unindexHeldMail(state, mail);
    if (!releaseFiles) return;
    for (const [index] of mail.attachments.entries()) {
      const key = attachmentKey(mail.messageId, index);
      const body = await state.get(UNASSIGNED_FILES_NAMESPACE, key);
      if (body !== null) await state.put(UNASSIGNED_FILES_NAMESPACE, key, body, { done: true });
    }
  }

  /** Части письма для сохранения: вложения берутся из отдельных записей. */
  private async partsOf(mail: HeldMail): Promise<MailParts> {
    const attachments: MailParts['attachments'] = [];
    for (const [index, file] of mail.attachments.entries()) {
      const body = await loadUnassignedBody(this.deps.state, mail.messageId, index);
      attachments.push({ ...file, ...(body === null ? {} : { base64: body.base64 }) });
    }
    return {
      id: mail.messageId,
      subject: mail.subject,
      body: mail.body,
      receivedAt: mail.receivedAt,
      attachments,
      ...(mail.senderVerified === undefined ? {} : { senderVerified: mail.senderVerified }),
    };
  }

  /** Дослать уведомление «содержимое не получено» в треды, где его ещё нет. */
  private async notifyOmitted(mail: HeldMail): Promise<void> {
    if (mail.contentOmitted === undefined || mail.candidates.length === 0) return;
    const names = await candidateNames(this.deps, mail.candidates);
    for (const threadId of mail.threadIds) {
      if (mail.notifiedThreadIds.includes(threadId)) continue;
      await this.deps.chat.reply(
        threadId,
        buildOmittedMessage(mail, names),
        `order-mail-omitted:${mail.token}:${threadId}`,
      );
      const fresh = await readState(
        this.deps.state,
        UNASSIGNED_MAIL_NAMESPACE,
        heldKey(mail.messageId),
        heldSchema,
      );
      if (fresh === null || fresh.closedAt !== undefined) return;
      const notified = [...new Set([...fresh.notifiedThreadIds, threadId])];
      await writeState(this.deps.state, UNASSIGNED_MAIL_NAMESPACE, heldKey(mail.messageId), {
        ...fresh,
        notifiedThreadIds: notified,
      });
    }
  }

  /** Сохранить письмо в «ожидающие» и, если известны заявки, предупредить менеджера. */
  private async hold(
    parts: MailParts,
    details: {
      omitted: ContentOmittedReason | undefined;
      supplierIds: string[];
      candidates: RouteCandidate[];
      inReplyTo: string | undefined;
    },
  ): Promise<void> {
    const state = this.deps.state;
    const key = heldKey(parts.id);
    const existing = await readState(state, UNASSIGNED_MAIL_NAMESPACE, key, heldSchema);
    const base: HeldMail =
      existing !== null && existing.closedAt === undefined
        ? existing
        : {
            messageId: parts.id,
            token: mailToken(parts.id),
            subject: parts.subject,
            body: parts.body,
            receivedAt: parts.receivedAt,
            // Содержимое вложений лежит отдельными записями: здесь только описание.
            attachments: parts.attachments.map(({ base64: _base64, ...rest }) => rest),
            ...(parts.senderVerified === undefined ? {} : { senderVerified: parts.senderVerified }),
            ...(details.inReplyTo === undefined ? {} : { inReplyTo: details.inReplyTo }),
            supplierIds: details.supplierIds,
            ...(details.omitted === undefined ? {} : { contentOmitted: details.omitted }),
            candidates: [],
            threadIds: [],
            notifiedThreadIds: [],
            attempts: 0,
          };
    if (existing === null || existing.closedAt !== undefined) {
      for (const [index, file] of parts.attachments.entries()) {
        if (file.base64 === undefined) continue;
        const body = { base64: file.base64 };
        await writeState(state, UNASSIGNED_FILES_NAMESPACE, attachmentKey(parts.id, index), body);
      }
    }
    const mail: HeldMail = {
      ...base,
      candidates: details.candidates,
      threadIds: await threadsFor(this.deps, details.candidates),
    };
    await writeState(state, UNASSIGNED_MAIL_NAMESPACE, key, mail);
    // Указатели по заявкам нужны только записям с причиной «содержимое не получено».
    if (mail.contentOmitted !== undefined) await indexHeldMail(state, mail);
    if (this.needsReplay(mail) && !this.pending.includes(parts.id)) {
      if (this.pending.length >= HELD_MAX_PENDING) {
        this.deps.log?.('order_reply_held_overflow', { limit: HELD_MAX_PENDING });
      } else {
        await this.savePending([...this.pending, parts.id]);
      }
    }
    await this.notifyOmitted(mail);
  }

  /**
   * Разобрать одно письмо: найти поставщика по любому адресу его контактов, привязать к
   * заявке и сохранить ответом либо отложить. `index` - адреса страницы из базы поставщиков.
   */
  private async place(message: InboxMessage, index: SupplierEmailIndex): Promise<PlaceOutcome> {
    const { sent, sentIndex, sentSupplierIds } = await this.routingData();
    const registryIds = suppliersByAddress(index, message.from).map((supplier) => supplier.id);
    let supplierIds = sentSupplierIds.filter((id) => registryIds.includes(id));
    // Адреса нет в базе (контакт удалён или сменён): ответ на НАШЕ письмо по `inReplyTo` всё
    // равно относится к поставщику, но отправитель не подтверждён.
    let forceUnverified = false;
    if (registryIds.length === 0) {
      supplierIds = suppliersRepliedTo(sent, message.inReplyTo);
      if (supplierIds.length === 0) return 'skipped';
      forceUnverified = true;
    }
    // Содержимое не загружено: перечитываем по id (список отправителей адаптера не спрашивается).
    let letter = message;
    const reason = message.contentOmitted;
    if (reason !== undefined && REREADABLE_REASONS.has(reason) && this.canReread()) {
      const full = await this.reread(message.id);
      if (full !== null && full.contentOmitted === undefined) letter = full;
    }
    const parts: MailParts = {
      // Адрес в карточке поставщика (registryIds) - основание доверия при включённой модели
      // (этап 233); цены из письма в базу не пишутся и так.
      ...toMailParts(
        letter,
        !forceUnverified && isMailSenderTrusted(letter, true, this.deps.senderTrust),
      ),
    };
    const omitted = letter.contentOmitted;
    const route =
      supplierIds.length === 0
        ? ({ kind: 'none' } as const)
        : routeMail(
            {
              subject: parts.subject,
              body: parts.body,
              receivedAt: letter.receivedAt,
              inReplyTo: letter.inReplyTo,
            },
            supplierIds,
            sentIndex,
          );
    const known = [...new Set([...registryIds, ...supplierIds])];
    if (route.kind === 'none') {
      // Запрос мог уйти, а запись об отправке ещё не появилась: письмо не теряется за курсором.
      if (!(await this.awaitsSentRecord(known, letter.receivedAt))) return 'skipped';
      await this.hold(parts, {
        omitted,
        supplierIds: known,
        candidates: [],
        inReplyTo: letter.inReplyTo,
      });
      return 'held';
    }
    if (omitted !== undefined) {
      // Пустое тело - не «письмо пустое»: ответ не сохраняется, менеджер видит причину.
      await this.hold(parts, {
        omitted,
        supplierIds: known,
        candidates: candidatesOf(route),
        inReplyTo: letter.inReplyTo,
      });
      return 'held';
    }
    if (route.kind === 'assigned') {
      const { requestId, supplierId } = route.candidate;
      if (await storeEmail(this.deps.state, requestId, parts, supplierId)) {
        this.added.set(requestId, (this.added.get(requestId) ?? 0) + 1);
      }
    } else {
      await holdForManager(this.deps, parts, candidatesOf(route));
    }
    return 'stored';
  }

  /** Повторный разбор ожидающих писем (запрос записан позже либо письмо удалось перечитать). */
  private async replay(): Promise<void> {
    await this.loadPending();
    const keep: string[] = [];
    for (const id of [...this.pending]) {
      const key = heldKey(id);
      const mail = await readState(this.deps.state, UNASSIGNED_MAIL_NAMESPACE, key, heldSchema);
      if (mail === null || mail.closedAt !== undefined) continue;
      if (isHeldExpired(mail, this.deps.clock.now())) {
        await this.close(mail, true);
        continue;
      }
      try {
        if (await this.replayOne(mail)) keep.push(id);
      } catch (error) {
        // Сбой одной записи не блокирует чтение ящика: id остаётся в ожидающих. В журнал -
        // только имя ошибки, без текста (в нём могут оказаться адреса и темы писем).
        keep.push(id);
        const code = error instanceof Error ? error.name : 'unknown';
        this.deps.log?.('order_reply_replay_failed', { code });
      }
    }
    await this.savePending(keep);
  }

  /** Разобрать одну ожидающую запись; true - оставить в списке ожидающих. */
  private async replayOne(record: HeldMail): Promise<boolean> {
    let mail = record;
    const reason = mail.contentOmitted;
    if (
      reason !== undefined &&
      REREADABLE_REASONS.has(reason) &&
      this.canReread() &&
      mail.attempts < HELD_MAX_REREADS
    ) {
      const full = await this.reread(mail.messageId);
      if (full !== null && full.contentOmitted === undefined) {
        // Письмо перечитано целиком и идёт как новое. Запись закрывается только после
        // успешного разбора: сбой `place` оставляет её открытой, и письмо не теряется.
        const index = await buildSupplierEmailIndex(this.deps.suppliers, [full.from]);
        const outcome = await this.place(full, index);
        // Не `stored` (отложено или пропущено): запись остаётся в ожидающих до следующего прохода.
        if (outcome !== 'stored') return true;
        await this.close(mail, true);
        await this.inbox.markProcessed(full.id);
        return false;
      }
      mail = { ...mail, attempts: mail.attempts + 1 };
      await writeState(this.deps.state, UNASSIGNED_MAIL_NAMESPACE, heldKey(mail.messageId), mail);
    }
    if (mail.candidates.length > 0) {
      await this.notifyOmitted(mail);
      return this.needsReplay(mail);
    }
    const { sent, sentIndex, sentSupplierIds } = await this.routingData();
    const known = sentSupplierIds.filter((id) => mail.supplierIds.includes(id));
    const replied = known.length > 0 ? known : suppliersRepliedTo(sent, mail.inReplyTo);
    if (replied.length === 0) return true;
    const route = routeMail(
      {
        subject: mail.subject,
        body: mail.body,
        receivedAt: mail.receivedAt,
        inReplyTo: mail.inReplyTo,
      },
      replied,
      sentIndex,
    );
    if (route.kind === 'none') return true;
    const candidates = candidatesOf(route);
    if (mail.contentOmitted !== undefined) {
      const threadIds = await threadsFor(this.deps, candidates);
      const updated: HeldMail = { ...mail, candidates, threadIds };
      const key = heldKey(mail.messageId);
      await writeState(this.deps.state, UNASSIGNED_MAIL_NAMESPACE, key, updated);
      await indexHeldMail(this.deps.state, updated);
      await this.notifyOmitted(updated);
      return this.needsReplay(updated);
    }
    const parts = await this.partsOf(mail);
    if (route.kind === 'assigned') {
      const { requestId, supplierId } = route.candidate;
      if (await storeEmail(this.deps.state, requestId, parts, supplierId)) {
        this.added.set(requestId, (this.added.get(requestId) ?? 0) + 1);
      }
      await this.close(mail, true);
    } else {
      // Копии вложений теперь нужны записи на разнесение: не освобождаем.
      await holdForManager(this.deps, parts, candidates);
      await this.close(mail, false);
    }
    await this.inbox.markProcessed(mail.messageId);
    return false;
  }

  /** Прочитать новые страницы ящика и разнести письма. */
  async run(): Promise<void> {
    const deps = this.deps;
    const cursorSchema = z.object({ cursor: z.string() });
    const saved = await readState(deps.state, INBOX_CURSOR_NAMESPACE, this.cursorKey, cursorSchema);
    let cursor = saved?.cursor ?? '';
    await this.loadPending();
    if (this.pending.length > 0) await this.replay();
    for (let pageNumber = 0; pageNumber < INBOX_MAX_PAGES; pageNumber += 1) {
      const page = await this.inbox.fetchNew(cursor, INBOX_PAGE_SIZE);
      const handled: string[] = [];
      // Поставщики по адресам страницы: правило «адрес - поставщик» общее для почтовых модулей
      // (любой контакт, без предела списка). На пустой странице к базе не обращаемся.
      const index =
        page.messages.length === 0
          ? new Map()
          : await buildSupplierEmailIndex(
              deps.suppliers,
              page.messages.map((message) => message.from),
            );
      for (const message of page.messages) {
        const outcome = await this.place(message, index);
        if (outcome === 'stored') handled.push(message.id);
      }
      for (const id of handled) await this.inbox.markProcessed(id);
      const moved = page.nextCursor !== cursor;
      cursor = page.nextCursor;
      await writeState(deps.state, INBOX_CURSOR_NAMESPACE, this.cursorKey, { cursor });
      if (page.messages.length < INBOX_PAGE_SIZE || !moved) break;
    }
  }
}

/**
 * Забрать новые письма и разнести их по заявкам. Курсор почты один на ящик: ящик не
 * перечитывается с начала для каждой заявки, и одно письмо привязывается не более чем к одной
 * заявке. Порядок надёжности: письмо сохраняется, потом помечается обработанным, потом
 * сдвигается курсор; сбой между шагами даёт повторное чтение, а не потерю письма. Письмо без
 * загруженного содержимого ответом не сохраняется и обработанным не помечается: оно
 * перечитывается по id либо менеджеру уходит причина (`readSupplierReplies.contentOmitted`).
 * Письмо от поставщика, чей запрос ещё не записан, ждёт записи. Возвращает число новых ответов
 * по заявкам. `source` - ящик сотрудника и ключ его курсора (id сотрудника).
 */
export async function ingestInbox(
  deps: OrderCalcDeps,
  source: InboxIngestSource,
): Promise<Map<string, number>> {
  const ingest = new InboxIngest(deps, source.inbox, source.cursorKey, source.ownerUserId);
  await ingest.run();
  return ingest.added;
}

