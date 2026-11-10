import { z } from 'zod';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../kit/domain/monitoring';
import { DomainError, localDateKey } from '@business-ai/core';
import { hoursToMs } from '../../kit/domain/time';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { predecessorOf, readState, stableHash, writeState } from '@business-ai/core';
import { ORDER_CLOSE_PENDING_NAMESPACE, REPLY_PENDING_TTL_HOURS, type OrderCalcDeps } from './deps';
import {
  CHANNEL_NAMES,
  closeOrderRecord,
  isOrderClosed,
  loadOrderProgress,
  sentSupplierIds,
  type OrderProgress,
  type SupplierProgress,
} from './order-progress';
import { assertOrderOwner } from './order-access';
import { loadSelection, loadSent } from './state';
import { requestLabel } from './request-title';

/** Окно, в пределах которого повторный вопрос о статусе считается тем же вызовом, мс. */
const STATUS_SLOT_MS = 60_000;

const supplierViewSchema = z.object({
  supplierId: z.string(),
  requestState: z.enum(['not_prepared', 'prepared', 'sent']),
  requestAt: z.string().optional(),
  answered: z.boolean(),
  replyChannels: z.array(z.enum(['email', 'phone', 'messenger', 'other'])),
  lastReplyAt: z.string().optional(),
  declined: z.boolean(),
  quoteRecorded: z.boolean(),
  /** Чего не хватает: request_not_prepared, no_reply, no_quote. */
  missing: z.array(z.enum(['request_not_prepared', 'no_reply', 'no_quote'])),
});
const statusOutputSchema = z.object({
  requestId: z.string(),
  closed: z.boolean(),
  suppliers: z.array(supplierViewSchema),
  /** Статус показан сотруднику сообщением кода (с названиями поставщиков). */
  delivered: z.boolean(),
});
type StatusOutput = z.infer<typeof statusOutputSchema>;

/** `дд.мм` из ISO-момента по поясу бизнеса. */
function shortDay(iso: string | undefined): string {
  if (iso === undefined) return 'дата неизвестна';
  const dateKey = localDateKey(new Date(iso), DEFAULT_BUSINESS_TIMEZONE);
  const [, month = '', day = ''] = dateKey.split('-');
  return `${day}.${month}`;
}

/** Что не хватает по поставщику. */
function missingOf(supplier: SupplierProgress): StatusOutput['suppliers'][number]['missing'] {
  const missing: StatusOutput['suppliers'][number]['missing'] = [];
  if (supplier.requestAt === undefined) missing.push('request_not_prepared');
  else if (supplier.replies.length === 0) missing.push('no_reply');
  if (!supplier.quoteRecorded && !supplier.declined) missing.push('no_quote');
  return missing;
}

/** Строка по поставщику для сотрудника (названия подставляет код). */
function supplierLine(supplier: SupplierProgress, legacySent: boolean): string {
  const parts: string[] = [];
  if (supplier.requestAt === undefined) parts.push('запрос не подготовлен');
  else {
    const verb = legacySent ? 'запрос отправлен' : 'запрос подготовлен';
    parts.push(`${verb} ${shortDay(supplier.requestAt)}`);
  }
  if (supplier.replies.length > 0) {
    const last = supplier.replies[supplier.replies.length - 1];
    const channels = [...new Set(supplier.replies.map((reply) => CHANNEL_NAMES[reply.channel]))];
    parts.push(`ответил (${channels.join(', ')}, ${shortDay(last?.at)})`);
  } else if (supplier.requestAt !== undefined) {
    parts.push('ответа нет');
  }
  if (supplier.declined) parts.push('отказался давать КП');
  parts.push(supplier.quoteRecorded ? 'КП записано' : 'КП не записано');
  return `- ${supplier.name}: ${parts.join('; ')}.`;
}

/** Статус заказа, по которому менеджер ещё не выбрал поставщиков. */
const NO_SUPPLIERS_CHOSEN_TEXT = 'Поставщики по заявке ещё не выбраны.';

/** Текст статуса сотруднику. */
function statusText(progress: OrderProgress, label: string): string {
  const lines = [`Статус заказа «${label}»${progress.closed ? ' (закрыт)' : ''}:`];
  if (progress.suppliers.length === 0) lines.push(NO_SUPPLIERS_CHOSEN_TEXT);
  for (const supplier of progress.suppliers) {
    lines.push(supplierLine(supplier, progress.legacySent));
  }
  return lines.join('\n');
}

/** Данные статуса: из системы, не из почты. */
async function collectProgress(deps: OrderCalcDeps, requestId: string): Promise<OrderProgress> {
  const request = await deps.requests.get(requestId);
  if (request === null) throw new DomainError('not_found', `Заявка ${requestId} не найдена.`);
  const selection = await loadSelection(deps, requestId);
  const sent = await loadSent(deps, requestId);
  const ids = [
    ...new Set([
      ...(selection?.supplierIds ?? []),
      ...(sent === null ? [] : sentSupplierIds(sent)),
    ]),
  ].sort();
  // Выбора ещё нет - это тоже статус («поставщики не выбраны»), а не ошибка (этап 177).
  return loadOrderProgress(deps, requestId, sent, ids);
}

/**
 * Статус заказа без почты: по каждому выбранному поставщику - запрос подготовлен/отправлен
 * (когда), ответ получен (канал, когда) или нет, КП записано, чего не хватает.
 * Источник - данные системы (ответы любого канала, КП), почтовый ящик не читается.
 */
export const orderStatus = defineTool<{ requestId: string }, StatusOutput, OrderCalcDeps>({
  name: 'orderStatus',
  description:
    'Показать статус заказа по заявке requestId: по каждому выбранному поставщику - запрос ' +
    'подготовлен или отправлен (когда), ответил ли (канал и дата: почта, телефон, ' +
    'мессенджер), записано ли КП, чего не хватает; срок ответа менеджеру по продажам. ' +
    'Работает без почты, по данным системы. Подробный текст со всеми названиями код ' +
    'отправляет сотруднику сам; тебе приходят идентификаторы и признаки.',
  // Сообщение сотруднику в чат - внешний эффект: вызов попадает в аудит и защищён ключом.
  sideEffect: true,
  inputSchema: z.object({ requestId: z.string().min(1) }),
  outputSchema: statusOutputSchema,
  idempotencyKey: (input) => `order-status:${input.requestId}`,
  // Статус меняется с ответами и КП, а вопрос повторяют: ключ зависит от состояния и минуты.
  idempotencyPredecessor: async (input, deps, threadId) => {
    const progress = await collectProgress(deps, input.requestId).catch(() => null);
    return predecessorOf({
      slot: Math.floor(deps.clock.now().getTime() / STATUS_SLOT_MS),
      thread: threadId,
      state:
        progress === null
          ? null
          : stableHash({
              closed: progress.closed,
              suppliers: progress.suppliers.map((s) => [
                s.supplierId,
                s.requestAt ?? null,
                s.replies.map((reply) => reply.replyId),
                s.quoteRecorded,
              ]),
            }),
    });
  },
  async execute(input, deps, context) {
    const progress = await collectProgress(deps, input.requestId);
    const suppliers = progress.suppliers.map((supplier) => {
      const last = supplier.replies[supplier.replies.length - 1];
      return {
        supplierId: supplier.supplierId,
        requestState:
          supplier.requestAt === undefined
            ? ('not_prepared' as const)
            : progress.legacySent
              ? ('sent' as const)
              : ('prepared' as const),
        ...(supplier.requestAt === undefined ? {} : { requestAt: supplier.requestAt }),
        answered: supplier.replies.length > 0,
        replyChannels: [...new Set(supplier.replies.map((reply) => reply.channel))],
        ...(last?.at === undefined ? {} : { lastReplyAt: last.at }),
        declined: supplier.declined,
        quoteRecorded: supplier.quoteRecorded,
        missing: missingOf(supplier),
      };
    });
    const state = stableHash(suppliers);
    await deps.chat.reply(
      context.threadId,
      { text: statusText(progress, await requestLabel(deps, input.requestId)) },
      `order-status:${input.requestId}:${state}:` +
        `${Math.floor(deps.clock.now().getTime() / STATUS_SLOT_MS)}`,
    );
    return {
      requestId: input.requestId,
      closed: progress.closed,
      suppliers,
      delivered: true,
    };
  },
});

const closeInputSchema = z.object({
  requestId: z.string().min(1),
  confirmed: z
    .boolean()
    .optional()
    .describe(
      'Не передавай при первом вызове; true - только после явного согласия сотрудника ' +
        '(«да», «закрывай», «хорошо», «ок») сразу в ответ на показанный вопрос',
    ),
});
type CloseInput = z.infer<typeof closeInputSchema>;

const closeOutputSchema = z.object({
  status: z.enum(['needs_confirmation', 'closed', 'already_closed']),
  message: z.string(),
});

const closePendingSchema = z.object({
  userId: z.string().min(1),
  threadId: z.string().min(1),
  turnNumber: z.number().int(),
  createdAt: z.string(),
});

/**
 * Момент показа вопроса о закрытии, ждущего «да» сотрудника; null - вопроса нет. Нужен
 * инструменту ответа на напоминание (этап 226): он идёт тем же двухшаговым протоколом.
 */
export async function closePendingAt(
  deps: OrderCalcDeps,
  requestId: string,
): Promise<string | null> {
  const pending = await readState(
    deps.state,
    ORDER_CLOSE_PENDING_NAMESPACE,
    requestId,
    closePendingSchema,
  );
  return pending?.createdAt ?? null;
}

/**
 * Закрыть заказ («заказ закрыт»): утренняя сводка его больше не показывает. Два шага, как у
 * записи ответа: показ сотруднику, затем (его «да» в следующей реплике) закрытие.
 */
export const closeOrder = defineTool<
  CloseInput,
  z.infer<typeof closeOutputSchema>,
  OrderCalcDeps
>({
  name: 'closeOrder',
  description:
    'Закрыть заказ по заявке requestId, когда сотрудник сказал, что заказ закрыт (КП больше ' +
    'не нужны). Первый вызов (без confirmed) показывает вопрос сотруднику: закончи ход и жди ' +
    'ответа. Согласие свободное («да», «закрывай», «хорошо», «давай», «ок»), но только как ' +
    'явный ответ на показанный вопрос в его следующем сообщении: тогда вызови с ' +
    'confirmed=true. Те же слова вне этого вопроса, отказ («отмена», «не надо», «нет») или ' +
    'неясный ответ - confirmed не ставь (неясно - один раз коротко переспроси). Закрытый ' +
    'заказ пропадает из утренней сводки.',
  sideEffect: true,
  inputSchema: closeInputSchema,
  outputSchema: closeOutputSchema,
  idempotencyKey: (input) =>
    `order-close:${input.requestId}:${input.confirmed === true ? 'confirm' : 'show'}`,
  idempotencyPredecessor: async (input, deps) => {
    const pending = await readState(
      deps.state,
      ORDER_CLOSE_PENDING_NAMESPACE,
      input.requestId,
      closePendingSchema,
    );
    return predecessorOf({
      pending: pending?.createdAt ?? null,
      closed: await isOrderClosed(deps, input.requestId),
    });
  },
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    const request = await deps.requests.get(input.requestId);
    if (request === null) {
      throw new DomainError('not_found', `Заявка ${input.requestId} не найдена.`);
    }
    await assertOrderOwner(deps, input.requestId, context);
    if (await isOrderClosed(deps, input.requestId)) {
      return { status: 'already_closed', message: 'Заказ уже закрыт.' };
    }
    if (input.confirmed !== true) {
      const now = deps.clock.now();
      await writeState(deps.state, ORDER_CLOSE_PENDING_NAMESPACE, input.requestId, {
        userId,
        threadId: context.threadId,
        turnNumber: context.turnNumber,
        createdAt: now.toISOString(),
      });
      await deps.chat.reply(
        context.threadId,
        {
          text:
            `Закрыть заказ «${await requestLabel(deps, input.requestId)}»? Он пропадёт из утренней сводки. ` +
            'Например: «да, закрывай», «закрывай» или «отмена», «не надо».',
        },
        `order-close-show:${input.requestId}:${now.getTime()}`,
      );
      return {
        status: 'needs_confirmation',
        message: 'Вопрос показан сотруднику. Ничего не закрыто: закончи ход и жди ответа.',
      };
    }
    const pending = await readState(
      deps.state,
      ORDER_CLOSE_PENDING_NAMESPACE,
      input.requestId,
      closePendingSchema,
    );
    if (pending === null) {
      throw new DomainError('conflict', 'Закрытие не показывали сотруднику: сначала покажи его.');
    }
    if (pending.userId !== userId || pending.threadId !== context.threadId) {
      throw new DomainError(
        'access_denied',
        'Закрытие показывали другому сотруднику или в другом чате.',
      );
    }
    if (pending.turnNumber >= context.turnNumber) {
      throw new DomainError(
        'conflict',
        'Подтверждение возможно только отдельным сообщением сотрудника после показа вопроса.',
      );
    }
    const expiresAt = Date.parse(pending.createdAt) + hoursToMs(REPLY_PENDING_TTL_HOURS);
    if (deps.clock.now().getTime() > expiresAt) {
      throw new DomainError('conflict', 'Показ устарел: покажи вопрос заново.');
    }
    await closeOrderRecord(deps, input.requestId, userId);
    await deps.state.delete(ORDER_CLOSE_PENDING_NAMESPACE, input.requestId);
    return { status: 'closed', message: 'Заказ закрыт, в утренней сводке его больше не будет.' };
  },
});
