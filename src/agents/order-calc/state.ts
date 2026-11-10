import { z } from 'zod';
import { REQUEST_VALUE_MAX_CHARS, requestKindSchema } from '../../kit/domain/request-forms';
import {
  shortlistProposalSchema,
  sourceResultSchema,
  type ShortlistProposal,
  type SourceResult,
  type SupplierSource,
} from '../../kit/domain/shortlist';
import {
  COMPLETENESS_NAMESPACE,
  PROPOSAL_NAMESPACE,
  REQUEST_TEXT_RESHOW_NAMESPACE,
  OPEN_SELECTION_NAMESPACE,
  SELECTION_NAMESPACE,
  SENT_NAMESPACE,
  SOURCE_NAMESPACE,
  STATE_SCAN_MAX_PAGES,
  STATE_SCAN_PAGE,
  type OrderCalcDeps,
} from './deps';
import { readState, resolveRecipientThread, writeState } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';

/** Выбранный менеджером шорт-лист: единственный допустимый список адресатов. */
export const selectionSchema = z.object({
  requestId: z.string().min(1),
  supplierIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string(),
});
export type Selection = z.infer<typeof selectionSchema>;

/** Состояние записи: запрос подготовлен для отправки сотрудником либо отправлен кодом. */
const SENT_STATES = ['sent', 'prepared'] as const;

/**
 * Отметка «запросы по заявке»: нужна для напоминания и для привязки ответов. С ТЗ (разд. 5)
 * агент письма не отправляет: код записывает момент, когда текст запроса подготовлен и показан
 * сотруднику (`state: 'prepared'`), а письмо отправляет сам сотрудник. Записи прежнего формата
 * (письмо ушло через ящик, есть id сообщений) читаются как `state: 'sent'`.
 */
export const sentSchema = z.object({
  requestId: z.string().min(1),
  supplierIds: z.array(z.string().min(1)),
  /** Время последней рассылки (для `prepared` - последней подготовки текста) по заявке. */
  sentAt: z.string(),
  /**
   * Когда запрос впервые ушёл каждому поставщику (поставщик -> ISO-время); для `prepared` -
   * когда его текст впервые подготовлен и показан сотруднику.
   */
  sentBySupplier: z.record(z.string()).default({}),
  /** Идентификаторы отправленных сообщений из квитанций канала (поставщик -> id). */
  messageIds: z.record(z.string()).default({}),
  /**
   * `prepared` - текст подготовлен, письмо отправляет сотрудник сам (id сообщений нет);
   * `sent` - письмо ушло из системы (записи прежнего формата). Нет поля - `sent`. Запись, в
   * которой уже есть `sent`, остаётся `sent`.
   */
  state: z.enum(SENT_STATES).default('sent'),
  /**
   * Сотрудник, с ящика которого уходят запросы: ответы читаются из его ящика. Нет поля - запись
   * старого формата (отправка без ящиков сотрудников), в режиме ящиков она пропускается.
   */
  mailboxOwnerId: z.string().min(1).optional(),
});
export type SentRecord = z.infer<typeof sentSchema>;

/**
 * Когда запрос по заявке ушёл поставщику; undefined, если ему не отправляли. У записей,
 * сделанных до появления времени по поставщикам, берётся общее время рассылки.
 */
export function sentAtFor(record: SentRecord, supplierId: string): string | undefined {
  const own = record.sentBySupplier[supplierId];
  if (own !== undefined) return own;
  return record.supplierIds.includes(supplierId) ? record.sentAt : undefined;
}

type StateDeps = Pick<OrderCalcDeps, 'state'>;

/** Журнал упора обхода в предел страниц: часть записей пространства не прочитана. */
export function logScanLimit(log: OrderCalcDeps['log'], namespace: string): void {
  log?.('order_state_scan_limit', {
    namespace,
    limit: STATE_SCAN_PAGE * STATE_SCAN_MAX_PAGES,
  });
}

const sourceKey = (requestId: string, source: SupplierSource): string => `${requestId}:${source}`;

export function loadSourceResult(
  deps: StateDeps,
  requestId: string,
  source: SupplierSource,
): Promise<SourceResult | null> {
  return readState(deps.state, SOURCE_NAMESPACE, sourceKey(requestId, source), sourceResultSchema);
}

export function saveSourceResult(
  deps: StateDeps,
  requestId: string,
  result: SourceResult,
): Promise<void> {
  return writeState(deps.state, SOURCE_NAMESPACE, sourceKey(requestId, result.source), result);
}

export function loadProposal(
  deps: StateDeps,
  requestId: string,
): Promise<ShortlistProposal | null> {
  return readState(deps.state, PROPOSAL_NAMESPACE, requestId, shortlistProposalSchema);
}

/**
 * Адресат сообщений менеджеру по заявке: владелец заявки (сотрудник, начавший её в чате), иначе
 * тред из шорт-листа (записан при сборке; так хранятся и записи, сделанные до учёта владельцев),
 * иначе менеджер по умолчанию. Запасной адрес срабатывает только когда нет ни владельца, ни
 * шорт-листа.
 */
export function orderRecipient(
  deps: Pick<OrderCalcDeps, 'state' | 'managerThreadId'>,
  requestId: string,
  proposal: ShortlistProposal | null,
): Promise<string> {
  const fallback = proposal?.managerThreadId ?? deps.managerThreadId;
  return resolveRecipientThread(deps.state, workSubject.order(requestId), fallback);
}

export function saveProposal(deps: StateDeps, proposal: ShortlistProposal): Promise<void> {
  return writeState(deps.state, PROPOSAL_NAMESPACE, proposal.requestId, proposal);
}

export function loadSelection(deps: StateDeps, requestId: string): Promise<Selection | null> {
  return readState(deps.state, SELECTION_NAMESPACE, requestId, selectionSchema);
}

/**
 * Записать выбор и внести его в индекс открытых выборов (его читает приём писем). Индекс пишется
 * после самого выбора: сбой между записями оставляет выбор без индекса, а такие выборы подбирает
 * однократное внесение старых записей.
 */
export async function saveSelection(deps: StateDeps, selection: Selection): Promise<void> {
  await writeState(deps.state, SELECTION_NAMESPACE, selection.requestId, selection);
  await writeState(deps.state, OPEN_SELECTION_NAMESPACE, selection.requestId, selection);
}

export function loadSent(deps: StateDeps, requestId: string): Promise<SentRecord | null> {
  return readState(deps.state, SENT_NAMESPACE, requestId, sentSchema);
}

export function saveSent(deps: StateDeps, record: z.input<typeof sentSchema>): Promise<void> {
  return writeState(deps.state, SENT_NAMESPACE, record.requestId, sentSchema.parse(record));
}

/**
 * Полнота запроса по заявке: вид, характеристики заказа (ключ поля формы -> значение, в
 * пределах длины) и отказ сотрудника дополнять. Значения нужны для письма поставщику, поэтому
 * лежат только в состоянии заявки: в журналы и задачи они не попадают.
 */
const completenessSchema = z.object({
  requestId: z.string().min(1),
  kind: requestKindSchema,
  values: z.record(z.string().max(REQUEST_VALUE_MAX_CHARS)),
  /** Сотрудник отказался дополнять: поиск разрешён по имеющимся данным. */
  declined: z.boolean(),
  /**
   * Ключи полей, ответ на которые отложен («позже», «пока не знаем»). Нет поля - запись
   * прежнего формата: ничего не отложено.
   */
  deferred: z.array(z.string()).default([]),
  /**
   * Номер хода (`turnNumber`), в котором сотруднику ушёл вопрос о недостающем. Нет - вопроса
   * ещё не было (или запись прежнего формата).
   */
  askedTurn: z.number().int().positive().optional(),
  updatedAt: z.string(),
});
export type CompletenessRecord = z.infer<typeof completenessSchema>;

export function loadCompleteness(
  deps: StateDeps,
  requestId: string,
): Promise<CompletenessRecord | null> {
  return readState(deps.state, COMPLETENESS_NAMESPACE, requestId, completenessSchema);
}

export function saveCompleteness(
  deps: StateDeps,
  record: z.input<typeof completenessSchema>,
): Promise<void> {
  return writeState(
    deps.state,
    COMPLETENESS_NAMESPACE,
    record.requestId,
    completenessSchema.parse(record),
  );
}

/** Сколько раз по заявке уже повторно показывали текст запроса (нет записи - ни разу). */
const reshowSchema = z.object({ count: z.number().int().nonnegative() });

export async function loadReshowCount(deps: StateDeps, requestId: string): Promise<number> {
  const stored = await readState(
    deps.state,
    REQUEST_TEXT_RESHOW_NAMESPACE,
    requestId,
    reshowSchema,
  );
  return stored?.count ?? 0;
}

export function saveReshowCount(deps: StateDeps, requestId: string, count: number): Promise<void> {
  return writeState(deps.state, REQUEST_TEXT_RESHOW_NAMESPACE, requestId, { count });
}
