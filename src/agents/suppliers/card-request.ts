import { z } from 'zod';
import { PAIR_NOTE_KINDS } from '@business-ai/core';
import { SUPPLIER_CARD_SOURCES } from '../../kit/domain/supplier-card';
import type { WorkflowStateStore } from '@business-ai/core';
import {
  approvalButtonId,
  parseApprovalButton,
  readState,
  writeState,
  type ApprovalButtonSpec,
  type ApprovalRequestSpec,
} from '@business-ai/core';
import { supplierCardFieldsSchema } from './card-fields';
import {
  SUPPLIER_BATCH_NAMESPACE,
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  SUPPLIER_PENDING_NAMESPACE,
} from './deps';

/** Решение сотрудника по показу (раньше - нажатая кнопка, теперь - и ответ текстом). */
export type SupplierCardAction = 'save' | 'create' | 'update' | 'edit' | 'cancel';

/** Префикс id кнопок: `scard:<ok|cr|up|ed|no>:<токен>`. */
const SUPPLIER_CARD_BUTTON_PREFIX = 'scard';

/** Формат id кнопок карточки и пачки (общий разбор в shared/button-approval). */
const SUPPLIER_CARD_BUTTON_SPEC: ApprovalButtonSpec<SupplierCardAction> = {
  prefix: SUPPLIER_CARD_BUTTON_PREFIX,
  actions: { ok: 'save', cr: 'create', up: 'update', ed: 'edit', no: 'cancel' },
};

/**
 * Подсказки ответа жирным вместо кнопок (решение владельца 26.10.2026): сотрудник отвечает
 * текстом, модель записывает решение `confirmSupplierRequest`. Старые кнопки (`scard:*`)
 * по-прежнему разбираются обработчиком чата.
 */
export const SUPPLIER_DECISION_HINTS: Readonly<Record<SupplierCardAction, string>> = {
  save: 'да, сохраняй',
  create: 'создай новую',
  update: 'обнови существующую',
  edit: 'исправь …',
  cancel: 'отмена',
};

/** Подсказки ответа на вопрос о личной заметке и заметке к карточке. */
export const YES_NO_HINTS = { save: 'да', cancel: 'нет' } as const;

/**
 * Строка-подсказка с примерами ответа: «Например: «a», «b» или «c».» Это образцы, а не
 * единственно допустимые слова (этап 164): смысл ответа определяет модель. `extra` -
 * отдельное предложение про ответ с поправкой.
 */
export function decisionHintLine(labels: readonly string[], extra?: string): string {
  const quoted = labels.map((label) => `«${label}»`);
  const last = quoted.pop() ?? '';
  const examples = quoted.length === 0 ? last : `${quoted.join(', ')} или ${last}`;
  return `Например: ${examples}.${extra === undefined ? '' : ` ${extra}`}`;
}

/** Разобрать id кнопки карточки или пачки; null, если это не она. */
export function parseSupplierCardButton(
  buttonId: string,
): { action: SupplierCardAction; token: string } | null {
  return parseApprovalButton(SUPPLIER_CARD_BUTTON_SPEC, buttonId);
}

/** Собрать id кнопки (токен берётся из запроса). */
export function supplierCardButtonId(action: SupplierCardAction, token: string): string {
  return approvalButtonId(SUPPLIER_CARD_BUTTON_SPEC, action, token);
}

/** Состояние запроса. `shown` - ждёт нажатия, остальное терминально (данные стёрты). */
const REQUEST_STATUSES = [
  'shown',
  'saved',
  'cancelled',
  'edit_requested',
  'expired',
  'blocked',
] as const;
export type SupplierRequestStatus = (typeof REQUEST_STATUSES)[number];

const requestBase = {
  token: z.string().min(1),
  /** Агент, чей инструмент (или обработчик файла) показал запрос: сценарий-владелец. */
  agentId: z.string().min(1),
  /** Сотрудник, подготовивший запрос: только он может нажать кнопку. */
  ownerUserId: z.string().min(1),
  /** Тред, куда ушёл запрос: нажатие принимается только оттуда. */
  threadId: z.string().min(1),
  requestedAt: z.string().min(1),
  status: z.enum(REQUEST_STATUSES),
  /** Запрос закрыт (применён, отменён, просрочен): кнопка по нему ничего не записывает. */
  closedAt: z.string().optional(),
};

/**
 * Запрос подтверждения карточки или заметки. Поля с данными (`fields`, `noteText`) стираются
 * в терминальном статусе. `mode`: `create` - новая карточка, `edit` - правка существующей
 * (`targetId`). У новой карточки с дублями `targetId` - тот, кого обновит «Обновить
 * существующую»; `duplicateIds` - дубли на момент показа (на нажатии новых быть не должно).
 */
export const cardRequestSchema = z.object({
  ...requestBase,
  // `draft_merge` и `draft_confirm` - прежние виды (этап 240): остаются в схеме, чтобы показанные
  // до обновления запросы читались; нажатие по ним закрывает запрос без записи.
  kind: z.enum(['card', 'note', 'pair_note', 'draft_merge', 'draft_confirm']),
  mode: z.enum(['create', 'edit']),
  targetId: z.string().min(1).optional(),
  /** Только для прежнего вида `draft_merge`; новые запросы его не заполняют. */
  draftId: z.string().min(1).optional(),
  /**
   * `updatedAt` карточки `targetId` в момент показа. На нажатии другое значение означает,
   * что карточку изменили после показа: запись не делается (оптимистичная проверка версии).
   */
  baseUpdatedAt: z.string().min(1).optional(),
  duplicateIds: z.array(z.string()),
  fields: supplierCardFieldsSchema.optional(),
  noteText: z.string().optional(),
  /** Только для `pair_note`: вид личной записи (предпочтение или заметка). */
  pairNoteKind: z.enum(PAIR_NOTE_KINDS).optional(),
  source: z.enum(SUPPLIER_CARD_SOURCES),
});
export type SupplierCardRequest = z.infer<typeof cardRequestSchema>;

/** Строка пачки: номер строки файла и разобранные поля. */
const batchRowSchema = z.object({
  row: z.number().int().positive(),
  fields: supplierCardFieldsSchema,
  /** Для строк-дублей базы: карточка, которую обновит «Записать и обновить дубли». */
  targetId: z.string().min(1).optional(),
});
export type SupplierBatchRow = z.infer<typeof batchRowSchema>;

/** Запрос подтверждения пачки из файла: новые строки и строки-дубли базы. */
export const batchRequestSchema = z.object({
  ...requestBase,
  kind: z.literal('batch'),
  rows: z.array(batchRowSchema),
  duplicates: z.array(batchRowSchema),
  /**
   * Карточки, уже обновлённые этой пачкой при частичном сбое: id и `updatedAt` после её записи.
   * Повторное нажатие не принимает такой `updatedAt` за чужую правку после показа (иначе
   * строка получила бы ложный card_changed); любая более поздняя правка по-прежнему чужая.
   */
  ownWritten: z.record(z.string(), z.string()).optional(),
});
export type SupplierBatchRequest = z.infer<typeof batchRequestSchema>;

/** Где лежат запросы и как их проверять: для общего «тройного предохранителя». */
export const CARD_REQUEST_SPEC: ApprovalRequestSpec<SupplierCardRequest> = {
  requestNamespace: SUPPLIER_CARD_REQUEST_NAMESPACE,
  requestSchema: cardRequestSchema,
};
export const BATCH_REQUEST_SPEC: ApprovalRequestSpec<SupplierBatchRequest> = {
  requestNamespace: SUPPLIER_BATCH_NAMESPACE,
  requestSchema: batchRequestSchema,
};

/**
 * Последний показ, ждущий ответа сотрудника в треде чата: по нему `confirmSupplierRequest` без
 * явного id находит запрос (пачку из файла показывает код, модель её токена не видит).
 * `actions` - какие решения предложены в подсказке.
 */
export const pendingRequestSchema = z.object({
  token: z.string().min(1),
  actions: z.array(z.enum(['save', 'create', 'update', 'edit', 'cancel'])),
});
export type PendingSupplierRequest = z.infer<typeof pendingRequestSchema>;

/** Запомнить показ как ждущий ответа в треде (прежний ждущий вытесняется). */
export async function notePendingSupplierRequest(
  state: WorkflowStateStore,
  threadId: string,
  pending: PendingSupplierRequest,
): Promise<void> {
  await writeState(state, SUPPLIER_PENDING_NAMESPACE, threadId, pending);
}

/** Ждущий ответа показ треда; null - нет. */
export async function pendingSupplierRequest(
  state: WorkflowStateStore,
  threadId: string,
): Promise<PendingSupplierRequest | null> {
  return readState(state, SUPPLIER_PENDING_NAMESPACE, threadId, pendingRequestSchema);
}
