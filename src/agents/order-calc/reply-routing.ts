import { z } from 'zod';
import type { ChatMessage, Clock, WorkflowStateEntry, WorkflowStateStore } from '@business-ai/core';
import { DAY_MS } from '../../kit/domain/time';
import { stateEntries } from '@business-ai/core';
import {
  hasPressIdentity,
  readState,
  stableHash,
  toStoredJson,
  writeState,
} from '@business-ai/core';
import {
  REPLY_WINDOW_DAYS,
  SENT_NAMESPACE,
  STATE_SCAN_MAX_PAGES,
  STATE_SCAN_PAGE,
  UNASSIGNED_FILES_NAMESPACE,
  UNASSIGNED_MAIL_NAMESPACE,
  type OrderCalcDeps,
} from './deps';
import {
  closeUnassignedIndex,
  ensureMailIndex,
  indexUnassignedMail,
  unassignedMessageIdByToken,
  unassignedMessageIdsFor,
} from './mail-index';
import {
  attachmentBodySchema,
  attachmentKey,
  mailAttachmentPartSchema,
  mailEntries,
  replyKey,
  storeEmail,
  type MailParts,
} from './reply-store';
import {
  loadProposal,
  orderRecipient,
  logScanLimit,
  sentAtFor,
  sentSchema,
  type SentRecord,
} from './state';
import { requestLabels } from './request-title';

/** Пометка для менеджера: адрес в письме мог быть подделан. */
export const UNVERIFIED_SENDER_NOTE =
  'Внимание: отправитель не подтверждён (нет SPF/DKIM/DMARC), адрес мог быть подделан.';

/** Префикс метки заявки в теме письма и префикс id кнопок разнесения письма. */
const REQUEST_TAG_PREFIX = 'RFQ-';
export const ROUTE_BUTTON_PREFIX = 'rfq';
/** Метка любой заявки в тексте письма (отпечаток - 16 шестнадцатеричных знаков). */
const ANY_REQUEST_TAG = /RFQ-[0-9a-f]{16}/i;

/**
 * Отпечаток заявки для метки и кнопок: его считает код, поставщику и модели сам номер заявки
 * для привязки не нужен.
 */
export function requestToken(requestId: string): string {
  return stableHash(['order-calc-request', requestId]);
}

/**
 * Метка заявки, которую код добавляет в тему и текст запроса поставщику. Ответ с этой меткой
 * (её сохраняют «Re:» и цитата исходного письма) привязывается к заявке однозначно.
 */
export function requestTag(requestId: string): string {
  return `[${REQUEST_TAG_PREFIX}${requestToken(requestId)}]`;
}

/** Заявка, ответом на запрос по которой может быть письмо поставщика. */
export interface RouteCandidate {
  requestId: string;
  supplierId: string;
}

/** Куда отнести письмо: в одну заявку, менеджеру на разнесение или никуда. */
export type MailRoute =
  | { kind: 'assigned'; candidate: RouteCandidate }
  | { kind: 'ambiguous'; candidates: RouteCandidate[] }
  | { kind: 'none' };

/** Что нужно знать о письме для привязки. */
export interface RoutedMail {
  subject: string;
  body: string;
  receivedAt: string;
  /** Id нашего письма, на которое это отвечает (если почтовый адаптер его заполняет). */
  inReplyTo?: string | undefined;
}

/** Отправка запроса поставщику по одной заявке: время разобрано заранее, один раз. */
interface SentEntry {
  requestId: string;
  supplierId: string;
  sentAtMs: number;
  /** Идентификатор отправленного поставщику сообщения (квитанция канала), если он известен. */
  messageId: string | undefined;
  /** Номер записи отправки в исходном списке: сохраняет порядок кандидатов. */
  recordOrder: number;
}

/** Отправки по поставщикам: письмо привязывается без перебора всех записей отправки. */
export type SentIndex = ReadonlyMap<string, readonly SentEntry[]>;

/**
 * Построить индекс отправок по поставщикам: время каждой пары «заявка - поставщик» разбирается
 * один раз. Поставщик попадает в индекс, если ему отправлено (общее или своё время отправки);
 * пары с неразборчивым временем в индекс не входят (письмо к ним привязать нельзя).
 */
export function buildSentIndex(sent: readonly SentRecord[]): SentIndex {
  const index = new Map<string, SentEntry[]>();
  for (const [recordOrder, record] of sent.entries()) {
    const supplierIds = new Set([...record.supplierIds, ...Object.keys(record.sentBySupplier)]);
    for (const supplierId of supplierIds) {
      const sentAtMs = Date.parse(sentAtFor(record, supplierId) ?? '');
      if (Number.isNaN(sentAtMs)) continue;
      const entry: SentEntry = {
        requestId: record.requestId,
        supplierId,
        sentAtMs,
        messageId: record.messageIds[supplierId],
        recordOrder,
      };
      const entries = index.get(supplierId);
      if (entries === undefined) index.set(supplierId, [entry]);
      else entries.push(entry);
    }
  }
  return index;
}

const isSentIndex = (sent: readonly SentRecord[] | SentIndex): sent is SentIndex =>
  sent instanceof Map;

/**
 * Привязать письмо отправителя к заявке. Кандидаты - только заявки, по которым ЭТОМУ
 * поставщику уже ушёл запрос, и только если письмо получено после отправки (и не позже окна
 * `REPLY_WINDOW_DAYS`): старое письмо ответом не считается. Дальше:
 * - письмо отвечает на наше сообщение (`inReplyTo` совпал с `SentRecord.messageIds`
 *   ровно одного кандидата) - письмо его заявки, метка не нужна;
 * - в письме метка ровно одной заявки-кандидата - письмо её;
 * - меток нет и кандидат один - письмо его;
 * - кандидатов несколько без однозначной метки, либо метка чужая - автоматически не
 *   разбирается, уходит менеджеру на разнесение.
 */
export function routeMail(
  mail: RoutedMail,
  supplierIds: readonly string[],
  sent: readonly SentRecord[] | SentIndex,
): MailRoute {
  const index = isSentIndex(sent) ? sent : buildSentIndex(sent);
  const received = Date.parse(mail.receivedAt);
  const matches: Array<{ entry: SentEntry; supplierOrder: number }> = [];
  for (const [supplierOrder, supplierId] of supplierIds.entries()) {
    for (const entry of index.get(supplierId) ?? []) {
      if (Number.isNaN(received) || received < entry.sentAtMs) continue;
      if (received - entry.sentAtMs > REPLY_WINDOW_DAYS * DAY_MS) continue;
      matches.push({ entry, supplierOrder });
    }
  }
  // Порядок кандидатов прежний: по записям отправки, внутри записи - по поставщикам письма.
  matches.sort(
    (left, right) =>
      left.entry.recordOrder - right.entry.recordOrder ||
      left.supplierOrder - right.supplierOrder,
  );
  const candidates: RouteCandidate[] = matches.map(({ entry }) => ({
    requestId: entry.requestId,
    supplierId: entry.supplierId,
  }));
  const messageIdOf = new Map(
    matches.map(({ entry }) => [`${entry.requestId}\n${entry.supplierId}`, entry.messageId]),
  );
  if (candidates.length === 0) return { kind: 'none' };
  if (mail.inReplyTo !== undefined && mail.inReplyTo !== '') {
    const replied = candidates.filter(
      (candidate) =>
        messageIdOf.get(`${candidate.requestId}\n${candidate.supplierId}`) === mail.inReplyTo,
    );
    const [onlyReplied] = replied;
    if (replied.length === 1 && onlyReplied !== undefined) {
      return { kind: 'assigned', candidate: onlyReplied };
    }
  }
  const text = `${mail.subject}\n${mail.body}`.toLowerCase();
  const tagged = candidates.filter((candidate) =>
    text.includes(requestTag(candidate.requestId).toLowerCase()),
  );
  const [onlyTagged] = tagged;
  if (tagged.length === 1 && onlyTagged !== undefined) {
    return { kind: 'assigned', candidate: onlyTagged };
  }
  const [only] = candidates;
  // Метка есть, но не наша (или сразу несколько): по одному адресу привязывать нельзя.
  const foreignTag = tagged.length === 0 && ANY_REQUEST_TAG.test(text);
  if (tagged.length === 0 && !foreignTag && candidates.length === 1 && only !== undefined) {
    return { kind: 'assigned', candidate: only };
  }
  return { kind: 'ambiguous', candidates: tagged.length > 1 ? tagged : candidates };
}

/**
 * Все отметки «запросы отправлены» (по ним строятся кандидаты привязки). С `ownerUserId` -
 * только заявки этого сотрудника; записи без владельца ящика пропускаются (число - в `legacy`).
 */
export async function loadAllSent(
  store: WorkflowStateStore,
  ownerUserId?: string,
  log?: OrderCalcDeps['log'],
): Promise<{ records: SentRecord[]; legacy: number }> {
  const records: SentRecord[] = [];
  let legacy = 0;
  const entries = stateEntries(store, SENT_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    maxPages: STATE_SCAN_MAX_PAGES,
    onLimit: () => logScanLimit(log, SENT_NAMESPACE),
  });
  for await (const entry of entries) {
    const parsed = sentSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    if (ownerUserId !== undefined && parsed.data.mailboxOwnerId !== ownerUserId) {
      if (parsed.data.mailboxOwnerId === undefined) legacy += 1;
      continue;
    }
    records.push(parsed.data);
  }
  return { records, legacy };
}

export const candidateSchema = z.object({ requestId: z.string(), supplierId: z.string() });
/** Письмо без однозначной привязки: кандидаты и куда ушёл вопрос менеджеру. */
const unassignedSchema = z.object({
  messageId: z.string(),
  token: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.string(),
  attachments: z.array(mailAttachmentPartSchema),
  /** Отправитель подтверждён (SPF/DKIM/DMARC); нет поля — запись старого формата. */
  senderVerified: z.boolean().optional(),
  candidates: z.array(candidateSchema),
  /** Треды, куда вопрос должен уйти: решение принимается только оттуда. */
  threadIds: z.array(z.string()),
  /**
   * Треды, куда вопрос уже отправлен и подтверждён каналом. Нет поля - запись старого формата,
   * вопрос в ней считается отправленным.
   */
  askedThreadIds: z.array(z.string()).optional(),
  /** Заявка, к которой письмо отнёс человек; пока её нет, письмо не разбирается. */
  assignedRequestId: z.string().optional(),
  assignedBy: z.string().optional(),
  assignedAt: z.string().optional(),
});
export type UnassignedMail = z.infer<typeof unassignedSchema>;

/** Отпечаток письма для кода в вопросе и id кнопок (сам id письма может быть длинным). */
export function mailToken(messageId: string): string {
  return stableHash(['order-calc-mail', messageId]);
}

/** Отпечаток поставщика для id кнопки, когда адрес у заявки общий для нескольких. */
function supplierToken(supplierId: string): string {
  return stableHash(['order-calc-supplier', supplierId]);
}

/** Треды, куда вопрос по письму ещё не отправлен. */
function pendingThreads(mail: UnassignedMail): string[] {
  const asked = mail.askedThreadIds;
  if (asked === undefined) return [];
  return mail.threadIds.filter((threadId) => !asked.includes(threadId));
}

/** Вопрос по письму отправлен во все треды (в записи старого формата - считается отправленным). */
export function isManagerNotified(mail: UnassignedMail): boolean {
  return pendingThreads(mail).length === 0;
}

/** Знаков кода письма в вопросе менеджеру: различает письма одного треда, читается глазами. */
const MAIL_CODE_CHARS = 6;
/** Приставка кода письма в тексте («письмо #a1b2c3»). */
const MAIL_CODE_MARK = '#';

/** Короткий код письма для текстового ответа: первые знаки отпечатка. */
export function mailCode(mail: Pick<UnassignedMail, 'token'>): string {
  return mail.token.slice(0, MAIL_CODE_CHARS);
}

/** Код письма из ответа: регистр и приставка `#` не важны. */
function normalizeMailCode(code: string): string {
  const trimmed = code.trim().toLowerCase();
  return trimmed.startsWith(MAIL_CODE_MARK) ? trimmed.slice(MAIL_CODE_MARK.length) : trimmed;
}

/** Кандидат с тем же адресом, что у других поставщиков этой заявки (нужен и поставщик). */
function isSharedCandidate(mail: UnassignedMail, candidate: RouteCandidate): boolean {
  return mail.candidates.filter((other) => other.requestId === candidate.requestId).length > 1;
}

/**
 * id прежних кнопок разнесения по кандидатам письма (`rfq:<письмо>:<заявка>[:<поставщик>]`).
 * Новые вопросы кнопок не несут (решение владельца 26.10.2026), но уже отправленные кнопки
 * обрабатываются чатом как раньше.
 */
export function routeButtonIds(mail: UnassignedMail): string[] {
  return mail.candidates.map((candidate) => {
    const base = `${ROUTE_BUTTON_PREFIX}:${mail.token}:${requestToken(candidate.requestId)}`;
    return isSharedCandidate(mail, candidate)
      ? `${base}:${supplierToken(candidate.supplierId)}`
      : base;
  });
}

/**
 * Вопрос менеджеру: к какой заявке отнести письмо. Текст собирает код, тело письма не входит.
 * Варианты нумерованы, ответ - текстом (кнопок нет): его записывает `routeSupplierMail`.
 */
function buildRouteMessage(
  mail: UnassignedMail,
  supplierNames: ReadonlyMap<string, string>,
  requestNames: ReadonlyMap<string, string>,
): ChatMessage {
  // Заявку сотрудник узнаёт по названию; id ему не показываем (этап 125).
  const labelOf = (requestId: string): string => requestNames.get(requestId) ?? 'заявка';
  const nameOf = (supplierId: string): string => supplierNames.get(supplierId) ?? supplierId;
  const supplierIds = [...new Set(mail.candidates.map((candidate) => candidate.supplierId))];
  // Общий адрес у нескольких поставщиков: письмо надо отнести к паре «заявка - поставщик».
  const shared = mail.candidates.some((candidate) => isSharedCandidate(mail, candidate));
  const who = supplierIds.map((id) => `«${nameOf(id)}»`).join(', ');
  const subject = supplierIds.length > 1 ? `поставщиков ${who}` : `поставщика ${who}`;
  const options = mail.candidates.map((candidate, index) =>
    isSharedCandidate(mail, candidate)
      ? `${index + 1}. Заявка «${labelOf(candidate.requestId)}»: ${nameOf(candidate.supplierId)}`
      : `${index + 1}. Заявка «${labelOf(candidate.requestId)}»`,
  );
  const first = mail.candidates[0]?.requestId ?? '';
  return {
    text: [
      `Письмо ${MAIL_CODE_MARK}${mailCode(mail)} от ${subject} (получено ${mail.receivedAt}) ` +
        'может относиться к нескольким заявкам. К какой его отнести? Пока вы не ответите, ' +
        'письмо не разбирается и в сравнение КП не попадает.' +
        (mail.senderVerified === false ? ` ${UNVERIFIED_SENDER_NOTE}` : '') +
        (shared ? ' Адрес общий у нескольких поставщиков: назовите заявку и поставщика.' : ''),
      ...options,
      'Ответьте своими словами, например: ' +
        `«отнеси к заявке ${labelOf(first)}» или номер заявки.`,
    ].join('\n'),
  };
}

/** Названия поставщиков-кандидатов для текста вопроса. */
export async function candidateNames(
  deps: OrderCalcDeps,
  candidates: readonly RouteCandidate[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const candidate of candidates) {
    const supplier = await deps.suppliers.get(candidate.supplierId);
    names.set(candidate.supplierId, supplier?.name ?? candidate.supplierId);
  }
  return names;
}

/**
 * Дослать вопрос в треды, куда он ещё не ушёл. После каждой подтверждённой отправки тред
 * записывается в письмо; ключ идемпотентности `chat.reply` не даёт задвоить вопрос, если сбой
 * случился между отправкой и записью.
 */
async function sendPendingQuestions(deps: OrderCalcDeps, mail: UnassignedMail): Promise<void> {
  const key = replyKey(mail.messageId);
  const names = await candidateNames(deps, mail.candidates);
  const requestNames = await requestLabels(
    deps,
    mail.candidates.map((candidate) => candidate.requestId),
  );
  for (const threadId of pendingThreads(mail)) {
    await deps.chat.reply(
      threadId,
      buildRouteMessage(mail, names, requestNames),
      `order-unassigned-mail:${mail.token}:${threadId}`,
    );
    const fresh = await readState(deps.state, UNASSIGNED_MAIL_NAMESPACE, key, unassignedSchema);
    if (fresh === null || fresh.assignedRequestId !== undefined) return;
    const asked = [...new Set([...(fresh.askedThreadIds ?? []), threadId])];
    await writeState(deps.state, UNASSIGNED_MAIL_NAMESPACE, key, {
      ...fresh,
      askedThreadIds: asked,
    });
  }
}

/** Сохранить письмо «на разнесение» и спросить менеджеров заявок-кандидатов (один раз). */
export async function holdForManager(
  deps: OrderCalcDeps,
  parts: MailParts,
  candidates: RouteCandidate[],
): Promise<void> {
  const key = replyKey(parts.id);
  const existing = await readState(deps.state, UNASSIGNED_MAIL_NAMESPACE, key, unassignedSchema);
  if (existing !== null) {
    // Повтор после сбоя: письмо уже записано, досылаем вопрос в треды, где его ещё нет.
    // Указатели могли не записаться (сбой между записями): вносим их повторно.
    if (existing.assignedRequestId === undefined) await indexUnassignedMail(deps.state, existing);
    await sendPendingQuestions(deps, existing);
    return;
  }
  const threads = new Set<string>();
  for (const candidate of candidates) {
    const proposal = await loadProposal(deps, candidate.requestId);
    threads.add(await orderRecipient(deps, candidate.requestId, proposal));
  }
  for (const [index, file] of parts.attachments.entries()) {
    if (file.base64 === undefined) continue;
    const key = attachmentKey(parts.id, index);
    await writeState(deps.state, UNASSIGNED_FILES_NAMESPACE, key, { base64: file.base64 });
  }
  const mail: UnassignedMail = {
    messageId: parts.id,
    token: mailToken(parts.id),
    subject: parts.subject,
    body: parts.body,
    receivedAt: parts.receivedAt,
    ...(parts.senderVerified === undefined ? {} : { senderVerified: parts.senderVerified }),
    // Содержимое вложений лежит отдельными записями: здесь только описание.
    attachments: parts.attachments.map(({ base64: _base64, ...rest }) => rest),
    candidates,
    threadIds: [...threads],
    // Письмо записано раньше вопроса: сбой отправки не теряет письмо, а пустой список говорит,
    // что менеджер вопроса ещё не получил.
    askedThreadIds: [],
  };
  await writeState(deps.state, UNASSIGNED_MAIL_NAMESPACE, key, mail);
  // Указатели пишутся после основной записи: без них письмо подберёт однократное внесение.
  await indexUnassignedMail(deps.state, mail);
  await sendPendingQuestions(deps, mail);
}

/** Записи писем без привязки (ключи `m:`) с общими размером и пределом страниц просмотра. */
function unassignedMailEntries(
  store: WorkflowStateStore,
  log?: OrderCalcDeps['log'],
): AsyncGenerator<WorkflowStateEntry> {
  return mailEntries(store, UNASSIGNED_MAIL_NAMESPACE, STATE_SCAN_PAGE, STATE_SCAN_MAX_PAGES, () =>
    logScanLimit(log, UNASSIGNED_MAIL_NAMESPACE),
  );
}

/** Письма, которые ждут разнесения менеджером (ещё ни к одной заявке не отнесены). */
export async function listUnassignedMail(store: WorkflowStateStore): Promise<UnassignedMail[]> {
  const found: UnassignedMail[] = [];
  const entries = unassignedMailEntries(store);
  for await (const entry of entries) {
    const parsed = unassignedSchema.safeParse(entry.value);
    if (parsed.success && parsed.data.assignedRequestId === undefined) found.push(parsed.data);
  }
  return found;
}

/**
 * Письма, которые ждут разнесения и относятся к заявке (она среди кандидатов). Читаются только
 * указатели этой заявки и сами письма по ним, а не всё пространство: при первом обращении
 * однократно вносятся в индекс записи, сделанные до его появления.
 */
export async function listUnassignedMailFor(
  deps: Pick<OrderCalcDeps, 'state' | 'clock' | 'log'>,
  requestId: string,
): Promise<UnassignedMail[]> {
  await ensureMailIndex(deps.state, deps.clock.now(), deps.log);
  const found: UnassignedMail[] = [];
  for await (const messageId of unassignedMessageIdsFor(deps.state, requestId)) {
    const mail = await readState(
      deps.state,
      UNASSIGNED_MAIL_NAMESPACE,
      replyKey(messageId),
      unassignedSchema,
    );
    if (mail === null || mail.assignedRequestId !== undefined) continue;
    if (mail.candidates.some((candidate) => candidate.requestId === requestId)) found.push(mail);
  }
  return found;
}

/**
 * Разобрать id кнопки разнесения письма; null, если это не она. Формат `rfq:<письмо>:<заявка>`
 * (поставщик у заявки один) или `rfq:<письмо>:<заявка>:<поставщик>` (общий адрес).
 */
export function parseRouteButton(
  buttonId: string,
): { mailToken: string; requestToken: string; supplierToken?: string } | null {
  const [prefix, mail, request, supplier, ...rest] = buttonId.split(':');
  if (prefix !== ROUTE_BUTTON_PREFIX || rest.length > 0) return null;
  if (mail === undefined || mail === '' || request === undefined || request === '') return null;
  if (supplier === '') return null;
  return supplier === undefined
    ? { mailToken: mail, requestToken: request }
    : { mailToken: mail, requestToken: request, supplierToken: supplier };
}

/** Нажатие кнопки разнесения. */
export interface RoutePress {
  mailToken: string;
  requestToken: string;
  /** Отпечаток поставщика: есть, когда у заявки несколько поставщиков с этим адресом. */
  supplierToken?: string | undefined;
  /** Кто нажал: идентификатор из канала, не из аргументов модели. */
  userId: string;
  /** Тред, где нажали. */
  threadId: string;
}

/** Итог обработки нажатия. */
export type RouteOutcome =
  | { kind: 'assigned'; requestId: string }
  | { kind: 'already_assigned'; requestId: string }
  | { kind: 'unknown_mail' }
  | { kind: 'unknown_request' }
  | { kind: 'wrong_thread' }
  | { kind: 'no_identity' };

/** Тело вложения письма на разнесении: новое пространство, затем прежнее (запасной путь). */
export async function loadUnassignedBody(
  state: WorkflowStateStore,
  messageId: string,
  index: number,
): Promise<{ base64: string } | null> {
  const key = attachmentKey(messageId, index);
  const current = await readState(state, UNASSIGNED_FILES_NAMESPACE, key, attachmentBodySchema);
  if (current !== null) return current;
  return readState(state, UNASSIGNED_MAIL_NAMESPACE, key, attachmentBodySchema);
}

/**
 * Письмо на разнесении по отпечатку из кнопки: сначала по указателю `t:`, без чтения
 * пространства. Нет указателя - запасной ограниченный обход (запись другой версии или сбой
 * между записями); упор в предел страниц попадает в журнал.
 */
async function findUnassigned(
  store: WorkflowStateStore,
  token: string,
  now: Date,
): Promise<UnassignedMail | null> {
  await ensureMailIndex(store, now);
  const messageId = await unassignedMessageIdByToken(store, token);
  if (messageId !== null) {
    const mail = await readState(
      store,
      UNASSIGNED_MAIL_NAMESPACE,
      replyKey(messageId),
      unassignedSchema,
    );
    if (mail !== null && mail.token === token) return mail;
  }
  const entries = unassignedMailEntries(store);
  for await (const entry of entries) {
    const parsed = unassignedSchema.safeParse(entry.value);
    if (parsed.success && parsed.data.token === token) return parsed.data;
  }
  return null;
}

/**
 * Отнести письмо к заявке по решению человека. Вызывается обработчиком старой кнопки в чате и
 * инструментом `routeSupplierMail` (только в ходе сотрудника в чате, автор - он). Нужны
 * личность решившего, известное письмо, заявка из числа кандидатов и тред, куда ушёл вопрос;
 * первое решение не меняется. После него письмо становится обычным ответом по заявке.
 */
export async function assignSupplierMail(
  state: WorkflowStateStore,
  clock: Clock,
  press: RoutePress,
): Promise<RouteOutcome> {
  if (!hasPressIdentity(press.userId)) return { kind: 'no_identity' };
  const mail = await findUnassigned(state, press.mailToken, clock.now());
  if (mail === null) return { kind: 'unknown_mail' };
  if (!mail.threadIds.includes(press.threadId)) return { kind: 'wrong_thread' };
  if (mail.assignedRequestId !== undefined) {
    return { kind: 'already_assigned', requestId: mail.assignedRequestId };
  }
  const matching = mail.candidates.filter(
    (item) =>
      requestToken(item.requestId) === press.requestToken &&
      (press.supplierToken === undefined || supplierToken(item.supplierId) === press.supplierToken),
  );
  // Заявка с несколькими поставщиками и кнопка без поставщика: гадать нельзя.
  const [candidate] = matching;
  if (candidate === undefined || matching.length > 1) return { kind: 'unknown_request' };
  const attachments: MailParts['attachments'] = [];
  for (const [index, file] of mail.attachments.entries()) {
    const body = await loadUnassignedBody(state, mail.messageId, index);
    attachments.push({ ...file, ...(body === null ? {} : { base64: body.base64 }) });
  }
  const parts: MailParts = {
    id: mail.messageId,
    subject: mail.subject,
    body: mail.body,
    receivedAt: mail.receivedAt,
    attachments,
    ...(mail.senderVerified === undefined ? {} : { senderVerified: mail.senderVerified }),
  };
  await storeEmail(state, candidate.requestId, parts, candidate.supplierId);
  const decided: UnassignedMail = {
    ...mail,
    assignedRequestId: candidate.requestId,
    assignedBy: press.userId,
    assignedAt: clock.now().toISOString(),
  };
  // Письмо разнесено: запись и копии вложений может удалить ретенция.
  const done = { done: true };
  await state.put(UNASSIGNED_MAIL_NAMESPACE, replyKey(mail.messageId), toStoredJson(decided), done);
  await closeUnassignedIndex(state, mail);
  for (const [index] of mail.attachments.entries()) {
    const key = attachmentKey(mail.messageId, index);
    // Тело лежит в новом пространстве или (записи до разделения) в пространстве писем.
    for (const namespace of [UNASSIGNED_FILES_NAMESPACE, UNASSIGNED_MAIL_NAMESPACE]) {
      const body = await state.get(namespace, key);
      if (body !== null) await state.put(namespace, key, body, done);
    }
  }
  return { kind: 'assigned', requestId: candidate.requestId };
}

/** Ответ менеджера текстом: к какой заявке (и поставщику) отнести письмо. */
export interface RouteAnswer {
  requestId: string;
  /** Поставщик: нужен, когда у заявки несколько поставщиков с адресом письма. */
  supplierId?: string | undefined;
  /** Код письма из вопроса: нужен, когда в треде ждут ответа несколько писем по заявке. */
  mailCode?: string | undefined;
  /** Автор решения: сотрудник, начавший ход (проверено предохранителем). */
  userId: string;
  threadId: string;
}

/** Итог текстового ответа о разнесении письма. */
export type RouteAnswerOutcome =
  | RouteOutcome
  /** В этом треде нет письма на разнесении, которое может относиться к этой заявке. */
  | { kind: 'no_pending' }
  /** Писем несколько: нужен код письма. */
  | { kind: 'ambiguous_mail'; mailCodes: string[] }
  /** У заявки несколько поставщиков с этим адресом: нужен поставщик. */
  | { kind: 'needs_supplier'; supplierIds: string[] };

/**
 * Отнести письмо к заявке по ответу менеджера текстом. Письмо ищется среди ждущих разнесения
 * по этой заявке, вопрос по которым ушёл в этот тред; неоднозначность не угадывается, а
 * возвращается (код письма, поставщик). Запись - тем же `assignSupplierMail`, что у кнопки.
 */
export async function routeMailByAnswer(
  deps: Pick<OrderCalcDeps, 'state' | 'clock' | 'log'>,
  answer: RouteAnswer,
): Promise<RouteAnswerOutcome> {
  if (!hasPressIdentity(answer.userId)) return { kind: 'no_identity' };
  const pending = (await listUnassignedMailFor(deps, answer.requestId)).filter((mail) =>
    mail.threadIds.includes(answer.threadId),
  );
  const wanted = answer.mailCode === undefined ? undefined : normalizeMailCode(answer.mailCode);
  const found = wanted === undefined ? pending : pending.filter((m) => mailCode(m) === wanted);
  const [mail] = found;
  if (mail === undefined) return { kind: 'no_pending' };
  if (found.length > 1) return { kind: 'ambiguous_mail', mailCodes: found.map(mailCode) };
  const own = mail.candidates.filter((candidate) => candidate.requestId === answer.requestId);
  const matching = own.filter(
    (candidate) => answer.supplierId === undefined || candidate.supplierId === answer.supplierId,
  );
  const [candidate] = matching;
  if (candidate === undefined || matching.length > 1) {
    return { kind: 'needs_supplier', supplierIds: own.map((item) => item.supplierId) };
  }
  return assignSupplierMail(deps.state, deps.clock, {
    mailToken: mail.token,
    requestToken: requestToken(candidate.requestId),
    ...(isSharedCandidate(mail, candidate)
      ? { supplierToken: supplierToken(candidate.supplierId) }
      : {}),
    userId: answer.userId,
    threadId: answer.threadId,
  });
}
