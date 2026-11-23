import { z } from 'zod';
import { hoursToMs } from '../../kit/domain/time';
import type { Clock, WorkflowStateStore } from '@business-ai/core';
import {
  checkApprovalPress,
  joinKey,
  readState,
  stableHash,
  toStoredJson,
  writeState,
  type ApprovalRequestSpec,
} from '@business-ai/core';
import {
  QUOTE_REPLACE_NAMESPACE,
  QUOTE_REPLACE_OFFER_NAMESPACE,
  QUOTE_REPLACE_TTL_HOURS,
  type OrderCalcDeps,
} from './deps';
import { UNVERIFIED_SENDER_NOTE } from './reply-routing';
import { loadReplies, type StoredReply } from './reply-store';
import { loadProposal, orderRecipient } from './state';
import { requestLabel } from './request-title';

/**
 * Замена КП поставщика ответом, пришедшим позже (R4-AGT-5). Решает менеджер ответом в чате
 * (кнопок нет, решение владельца 26.10.2026): подтверждение пишет `confirmQuoteReplacement`
 * только в ходе сотрудника в чате, либо обработчик прежней кнопки. `recordQuote`
 * принимает другой источник КП только при действующем подтверждении: оно привязано к заявке,
 * поставщику и конкретному ответу, живёт `QUOTE_REPLACE_TTL_HOURS` и расходуется одним
 * сохранением.
 */

/** Префикс id кнопки «заменить КП на этот ответ»: `qrepl:<отпечаток предложения>`. */
const QUOTE_REPLACE_BUTTON_PREFIX = 'qrepl';

const offerSchema = z.object({
  requestId: z.string().min(1),
  supplierId: z.string().min(1),
  replyId: z.string().min(1),
  /** Тред, куда ушёл вопрос: решение принимается только оттуда. */
  threadId: z.string().min(1),
  offeredAt: z.string(),
  /**
   * Решение по предложению принято или вытеснено более поздним (R6-10-03): новое нажатие этой
   * кнопки ничего не записывает. Нет поля - предложение открыто.
   */
  closedAt: z.string().optional(),
});
type QuoteReplaceOffer = z.infer<typeof offerSchema>;

const approvalSchema = z.object({
  requestId: z.string().min(1),
  supplierId: z.string().min(1),
  replyId: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
  threadId: z.string().min(1),
  /** Подтверждение израсходовано сохранением КП. */
  consumed: z.boolean().default(false),
  /** Предложение, нажатием по которому оно записано (закрывается при вытеснении и расходе). */
  offerToken: z.string().min(1).optional(),
});
export type QuoteReplaceApproval = z.infer<typeof approvalSchema>;

/**
 * Отпечаток предложения: заявка + поставщик + ответ. `generation` - номер повторного
 * предложения по тому же ответу после истечения срока (R6-02-06); нулевой - прежний отпечаток.
 */
export function quoteReplaceToken(
  requestId: string,
  supplierId: string,
  replyId: string,
  generation = 0,
): string {
  const parts = ['order-calc-quote-replace', requestId, supplierId, replyId];
  return stableHash(generation === 0 ? parts : [...parts, String(generation)]);
}

/** Сколько раз подряд можно переоформить предложение по одному ответу (по одному в срок). */
const QUOTE_REPLACE_MAX_GENERATIONS = 60;
/** Предложение открыто: не закрыто решением и срок (`QUOTE_REPLACE_TTL_HOURS`) не истёк. */
const isOfferLive = (offer: QuoteReplaceOffer, nowMs: number): boolean =>
  offer.closedAt === undefined &&
  nowMs - Date.parse(offer.offeredAt) <= hoursToMs(QUOTE_REPLACE_TTL_HOURS);

/** id кнопки замены. */
export function quoteReplaceButtonId(token: string): string {
  return `${QUOTE_REPLACE_BUTTON_PREFIX}:${token}`;
}

/** Отпечаток предложения из id кнопки; null, если это не она. */
export function parseQuoteReplaceButton(buttonId: string): string | null {
  const [prefix, token, ...rest] = buttonId.split(':');
  if (prefix !== QUOTE_REPLACE_BUTTON_PREFIX || rest.length > 0) return null;
  return token === undefined || token === '' ? null : token;
}

const approvalKey = (requestId: string, supplierId: string): string =>
  joinKey(requestId, supplierId);

/** Время ответа: у ответа без даты считаем неизвестным (NaN не проходит сравнение). */
function timeOf(reply: StoredReply): number {
  return reply.receivedAt === undefined ? Number.NaN : Date.parse(reply.receivedAt);
}

/**
 * Предложить менеджеру заменить КП поставщика, если от него пришёл более поздний ответ, чем
 * тот, из которого записано КП. Сообщение уходит один раз на пару (поставщик, ответ): ключ
 * канала стабильный. Возвращает число отправленных вопросов.
 */
export async function offerQuoteReplacements(
  deps: OrderCalcDeps,
  requestId: string,
): Promise<number> {
  const quotes = await deps.quotes.listByRequest(requestId);
  if (quotes.length === 0) return 0;
  const replies = await loadReplies(deps.state, requestId);
  const proposal = await loadProposal(deps, requestId);
  const threadId = await orderRecipient(deps, requestId, proposal);
  let offered = 0;
  for (const quote of quotes) {
    const source = replies.find((reply) => reply.id === quote.sourceRef);
    const sourceTime = source === undefined ? Number.NaN : timeOf(source);
    const since = Number.isNaN(sourceTime) ? Date.parse(quote.receivedAt) : sourceTime;
    const newer = replies
      .filter((reply) => reply.supplierId === quote.supplierId && reply.id !== quote.sourceRef)
      .filter((reply) => timeOf(reply) > since)
      .sort((a, b) => timeOf(a) - timeOf(b))
      .at(-1);
    if (newer === undefined) continue;
    // Действующее решение менеджера по этому ответу уже есть: нового вопроса не нужно.
    const decided = await loadQuoteReplacement(
      deps.state,
      deps.clock,
      requestId,
      quote.supplierId,
      newer.id,
    );
    if (decided !== null) continue;
    // R6-02-06: предложение с истёкшим сроком не может быть принято и не отправится повторно
    // (ключ канала стабилен), поэтому по тому же ответу открывается новое с новым токеном.
    const nowMs = deps.clock.now().getTime();
    let token = '';
    let known: QuoteReplaceOffer | null = null;
    for (let generation = 0; generation < QUOTE_REPLACE_MAX_GENERATIONS; generation += 1) {
      token = quoteReplaceToken(requestId, quote.supplierId, newer.id, generation);
      known = await readState(deps.state, QUOTE_REPLACE_OFFER_NAMESPACE, token, offerSchema);
      if (known === null || isOfferLive(known, nowMs)) break;
      token = '';
    }
    // Все допустимые повторы исчерпаны: менеджер молча не отвечал два месяца.
    if (token === '') continue;
    const offer: QuoteReplaceOffer = {
      requestId,
      supplierId: quote.supplierId,
      replyId: newer.id,
      threadId,
      offeredAt: deps.clock.now().toISOString(),
    };
    if (known === null) await writeState(deps.state, QUOTE_REPLACE_OFFER_NAMESPACE, token, offer);
    const supplier = await deps.suppliers.get(quote.supplierId);
    const number = replies.filter((reply) => reply.supplierId === quote.supplierId).indexOf(newer);
    // Текст письма в сообщение не входит (как в вопросе о разнесении): только факты о письме.
    const facts = [
      newer.receivedAt === undefined ? null : `получен ${newer.receivedAt}`,
      newer.attachments.length === 0 ? 'без вложений' : `вложений: ${newer.attachments.length}`,
    ].filter((part): part is string => part !== null);
    await deps.chat.reply(
      threadId,
      {
        text:
          `Заявка «${await requestLabel(deps, requestId)}»: поставщик «${supplier?.name ?? quote.supplierId}» прислал ` +
          `новый ответ (№${number + 1}; ${facts.join(', ')}) после записанного КП. Сводка ` +
          'остаётся на прежних ценах.' +
          (newer.senderUnverified === true ? ` ${UNVERIFIED_SENDER_NOTE}` : '') +
          ' Заменить КП данными нового ответа? Если да, напишите, например, ' +
          `**замени КП ${supplier?.name ?? quote.supplierId}**.`,
      },
      `order-quote-replace:${token}`,
    );
    offered += 1;
  }
  return offered;
}

/** Нажатие кнопки замены. */
export interface QuoteReplacePress {
  token: string;
  /** Кто нажал: идентификатор из канала, не из аргументов модели. */
  userId: string;
  threadId: string;
}

/** Итог нажатия кнопки замены. */
export type QuoteReplaceOutcome =
  | { kind: 'approved'; requestId: string; supplierId: string; replyId: string }
  | { kind: 'already_approved'; requestId: string; supplierId: string; replyId: string }
  | { kind: 'unknown_offer' }
  | { kind: 'wrong_thread' }
  | { kind: 'expired' }
  | { kind: 'no_identity' };

/**
 * Решение менеджера «заменить КП»: пишет код чата. Нужны личность нажавшего, известное
 * предложение, тред, куда оно ушло, и срок (`QUOTE_REPLACE_TTL_HOURS` от предложения).
 * Повторное нажатие решения не меняет.
 */
export async function approveQuoteReplacement(
  state: WorkflowStateStore,
  clock: Clock,
  press: QuoteReplacePress,
): Promise<QuoteReplaceOutcome> {
  // Общая проверка нажатия: личность, известное открытое предложение, тот же тред (R6-10-03).
  const spec: ApprovalRequestSpec<QuoteReplaceOffer & { token: string }> = {
    requestNamespace: QUOTE_REPLACE_OFFER_NAMESPACE,
    requestSchema: offerSchema.transform((offer) => ({ ...offer, token: press.token })),
  };
  const checked = await checkApprovalPress(state, spec, press);
  if (checked.kind === 'no_identity' || checked.kind === 'wrong_thread') {
    return { kind: checked.kind };
  }
  if (checked.kind !== 'ok') {
    // Нет предложения - неизвестное; закрытое решением - повтор того же нажатия либо устаревшая
    // кнопка: решение по более раннему ответу не возвращается.
    const closed = await readState(state, QUOTE_REPLACE_OFFER_NAMESPACE, press.token, offerSchema);
    if (closed === null) return { kind: 'unknown_offer' };
    const own = await readState(
      state,
      QUOTE_REPLACE_NAMESPACE,
      approvalKey(closed.requestId, closed.supplierId),
      approvalSchema,
    );
    if (own !== null && own.offerToken === press.token) {
      const { requestId, supplierId, replyId } = closed;
      return { kind: 'already_approved', requestId, supplierId, replyId };
    }
    return { kind: 'expired' };
  }
  const offer = checked.request;
  const now = clock.now();
  if (now.getTime() - Date.parse(offer.offeredAt) > hoursToMs(QUOTE_REPLACE_TTL_HOURS)) {
    return { kind: 'expired' };
  }
  const { requestId, supplierId, replyId } = offer;
  const key = approvalKey(requestId, supplierId);
  const known = await readState(state, QUOTE_REPLACE_NAMESPACE, key, approvalSchema);
  if (known !== null && known.replyId === replyId && !known.consumed) {
    return { kind: 'already_approved', requestId, supplierId, replyId };
  }
  const approval: QuoteReplaceApproval = {
    requestId,
    supplierId,
    replyId,
    approvedBy: press.userId,
    approvedAt: now.toISOString(),
    threadId: press.threadId,
    consumed: false,
    offerToken: press.token,
  };
  await writeState(state, QUOTE_REPLACE_NAMESPACE, key, approval);
  // Прежнее решение по другому ответу вытеснено: его кнопка больше ничего не записывает.
  if (known?.offerToken !== undefined && known.offerToken !== press.token) {
    await closeOffer(state, known.offerToken, now);
  }
  return { kind: 'approved', requestId, supplierId, replyId };
}

/** Закрыть предложение (решение принято или вытеснено); завершённое состояние для ретенции. */
async function closeOffer(state: WorkflowStateStore, token: string, now: Date): Promise<void> {
  const offer = await readState(state, QUOTE_REPLACE_OFFER_NAMESPACE, token, offerSchema);
  if (offer === null || offer.closedAt !== undefined) return;
  const closed = { ...offer, closedAt: now.toISOString() };
  await state.put(QUOTE_REPLACE_OFFER_NAMESPACE, token, toStoredJson(closed), { done: true });
}

/** Действующее (не израсходованное, не просроченное) подтверждение замены на этот ответ. */
export async function loadQuoteReplacement(
  state: WorkflowStateStore,
  clock: Clock,
  requestId: string,
  supplierId: string,
  replyId: string,
): Promise<QuoteReplaceApproval | null> {
  const key = approvalKey(requestId, supplierId);
  const approval = await readState(state, QUOTE_REPLACE_NAMESPACE, key, approvalSchema);
  if (approval === null || approval.consumed || approval.replyId !== replyId) return null;
  const age = clock.now().getTime() - Date.parse(approval.approvedAt);
  return age > hoursToMs(QUOTE_REPLACE_TTL_HOURS) ? null : approval;
}

/** Израсходовать подтверждение: следующая замена потребует нового решения менеджера. */
export async function consumeQuoteReplacement(
  state: WorkflowStateStore,
  clock: Clock,
  requestId: string,
  supplierId: string,
): Promise<void> {
  const key = approvalKey(requestId, supplierId);
  const approval = await readState(state, QUOTE_REPLACE_NAMESPACE, key, approvalSchema);
  if (approval === null || approval.consumed) return;
  const consumed = { ...approval, consumed: true };
  // Израсходованное - завершённое состояние: ретенция может его убрать.
  await state.put(QUOTE_REPLACE_NAMESPACE, key, toStoredJson(consumed), { done: true });
  // Решение исполнено: кнопка этого предложения больше не возвращает подтверждение.
  if (approval.offerToken !== undefined) await closeOffer(state, approval.offerToken, clock.now());
}

/** Решение менеджера «заменить КП» текстом: поставщик назван, ответ находит код. */
export interface QuoteReplaceAnswer {
  requestId: string;
  supplierId: string;
  /** Автор решения: сотрудник, начавший ход (проверено предохранителем). */
  userId: string;
  threadId: string;
}

/**
 * Записать решение «заменить КП» по ответу менеджера в чате. Берётся самое позднее открытое
 * предложение по этому поставщику и заявке, ушедшее в этот тред; дальше - те же проверки,
 * что у кнопки (`approveQuoteReplacement`): срок, тред, одноразовость.
 */
export async function approveQuoteReplacementByAnswer(
  deps: Pick<OrderCalcDeps, 'state' | 'clock'>,
  answer: QuoteReplaceAnswer,
): Promise<QuoteReplaceOutcome> {
  const replies = (await loadReplies(deps.state, answer.requestId))
    .filter((reply) => reply.supplierId === answer.supplierId)
    .sort((a, b) => timeOf(b) - timeOf(a));
  const nowMs = deps.clock.now().getTime();
  // Самый поздний ответ, по которому в этот тред уходило предложение, решает исход: открытое
  // предложение одобряется, закрытое даёт «уже одобрено» или «истекло» (как старая кнопка).
  for (const reply of replies) {
    let last: string | null = null;
    for (let generation = 0; generation < QUOTE_REPLACE_MAX_GENERATIONS; generation += 1) {
      const token = quoteReplaceToken(answer.requestId, answer.supplierId, reply.id, generation);
      const offer = await readState(deps.state, QUOTE_REPLACE_OFFER_NAMESPACE, token, offerSchema);
      if (offer === null) break;
      if (offer.threadId !== answer.threadId) continue;
      last = token;
      if (isOfferLive(offer, nowMs)) break;
    }
    if (last !== null) {
      return approveQuoteReplacement(deps.state, deps.clock, {
        token: last,
        userId: answer.userId,
        threadId: answer.threadId,
      });
    }
  }
  return { kind: 'unknown_offer' };
}
