import { validateOutreachRecipients } from '../../kit/domain/validators.owned';
import { type ValidationIssue } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { requestTag } from './reply-routing';
import { loadSelection, loadSent, saveSent, sentAtFor } from './state';

/** Просьба сохранить метку заявки в ответе (дописывается к тексту запроса кодом). */
const REPLY_TAG_NOTE = 'Пожалуйста, сохраните в теме ответа метку запроса:';

/**
 * Тема и текст запроса с меткой заявки. Метку добавляет код: по ней ответ поставщика
 * привязывается к заявке. Метка остаётся в письме, которое сотрудник отправляет сам.
 */
export function withRequestTag(
  requestId: string,
  subject: string,
  body: string,
): { subject: string; body: string } {
  const tag = requestTag(requestId);
  return { subject: `${subject} ${tag}`, body: `${body}\n\n${REPLY_TAG_NOTE} ${tag}` };
}

/** Что проверяет {@link checkSupplierRequest}: заявка, адресаты (необязательно) и текст. */
export interface SupplierRequestCheckInput {
  requestId: string;
  /** Нет - все выбранные менеджером; может только сузить набор. */
  recipientSupplierIds?: readonly string[] | undefined;
  subject: string;
  body: string;
}

/**
 * Общая проверка перед подготовкой запроса: выбор менеджера есть, адресаты
 * только из него, в тексте нет неподставленных токенов псевдонимизации.
 */
export async function checkSupplierRequest(
  input: SupplierRequestCheckInput,
  deps: Pick<OrderCalcDeps, 'state'>,
): Promise<ValidationIssue[]> {
  const selection = await loadSelection(deps, input.requestId);
  if (selection === null) {
    return [
      {
        code: 'no_selection',
        message: 'Менеджер ещё не выбрал поставщиков по заявке (askManagerToChoose).',
      },
    ];
  }
  return validateOutreachRecipients(
    {
      recipientSupplierIds: [...(input.recipientSupplierIds ?? selection.supplierIds)],
      subject: input.subject,
      body: input.body,
    },
    {
      requestId: selection.requestId,
      supplierIds: selection.supplierIds,
      createdAt: selection.createdAt,
    },
  );
}

/** Что записать в учёт подготовленных запросов. */
export interface SupplierRequestsPreparedRecord {
  requestId: string;
  /** Поставщики, чей текст запроса подготовлен и показан сотруднику. */
  supplierIds: readonly string[];
  /** Момент подготовки, ISO. Время первой подготовки поставщику повтором не сдвигается. */
  at: string;
  /** Сотрудник, который отправит письма со своего ящика; уже записанный не меняется. */
  mailboxOwnerId?: string | undefined;
}

/**
 * Учёт подготовленных запросов (`SentRecord` с `state: 'prepared'`): поставщики, время и
 * владелец ящика, id сообщений нет - письмо отправляет сам сотрудник. Идемпотентна: повтор с
 * теми же данными ничего не пишет, ни время первой подготовки, ни владелец не сдвигаются.
 * Запись, где письма уже уходили из системы (`sent`), остаётся `sent`. Пустой набор ничего
 * не пишет.
 */
export async function recordSupplierRequestsPrepared(
  deps: Pick<OrderCalcDeps, 'state'>,
  record: SupplierRequestsPreparedRecord,
): Promise<void> {
  if (record.supplierIds.length === 0) return;
  const previous = await loadSent(deps, record.requestId);
  const sentBySupplier = { ...(previous?.sentBySupplier ?? {}) };
  let added = false;
  for (const supplierId of record.supplierIds) {
    // Время первой подготовки не сдвигается повтором: от него отсчитываются ответы.
    const firstAt = previous === null ? undefined : sentAtFor(previous, supplierId);
    if (firstAt === undefined) added = true;
    sentBySupplier[supplierId] ??= firstAt ?? record.at;
  }
  const mailboxOwnerId = previous?.mailboxOwnerId ?? record.mailboxOwnerId;
  const ownerAdded = previous?.mailboxOwnerId === undefined && mailboxOwnerId !== undefined;
  if (previous !== null && !added && !ownerAdded) return;
  await saveSent(deps, {
    requestId: record.requestId,
    supplierIds: [...new Set([...(previous?.supplierIds ?? []), ...record.supplierIds])],
    sentAt: added || previous === null ? record.at : previous.sentAt,
    sentBySupplier,
    messageIds: { ...(previous?.messageIds ?? {}) },
    state: previous?.state ?? 'prepared',
    ...(mailboxOwnerId === undefined ? {} : { mailboxOwnerId }),
  });
}
