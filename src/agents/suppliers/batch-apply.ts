import { isDomainError } from '@business-ai/core';
import { validateSupplierCard, type SupplierCard } from '../../kit/domain/supplier-card';
import { sanitizeSupplierCard } from './card-sanitize';
import { applyFieldsToCard, cardFromFields, newCardId, type CardBuildContext } from './card-fields';
import type { SupplierBatchRequest, SupplierBatchRow } from './card-request';
import type { SupplierCardsDeps } from './deps';

/** Строка пачки, не попавшая в запись, и код причины (без значений полей). */
export interface BatchRowResult {
  row: number;
  code: string;
}

/** Итог записи пачки: ошибка одной строки не валит остальные. */
export interface BatchApplyResult {
  created: number;
  updated: number;
  /** Не записаны по решению (дубль в базе без обновления, дубль появился после показа). */
  skipped: BatchRowResult[];
  /** Не удалось записать (нет названия, сбой хранилища). */
  failed: BatchRowResult[];
  /** Что очищено или обрезано в записанных строках: «строка N: ...» (этап 177). */
  warnings: string[];
}

/** Коды причин для отчёта. */
const BATCH_CODE_EXISTING = 'existing';
const BATCH_CODE_DUPLICATE_APPEARED = 'duplicate_appeared';
const BATCH_CODE_ALREADY_EXISTS = 'already_exists';
const BATCH_CODE_INVALID = 'invalid';
const BATCH_CODE_TARGET_MISSING = 'target_missing';
const BATCH_CODE_CARD_CHANGED = 'card_changed';
const CONFLICT_ERROR_CODE = 'conflict';
const BATCH_CODE_UNEXPECTED = 'unexpected';
const BATCH_CODE_EXTERNAL_FAILURE = 'external_failure';

/** Сбой хранилища (а не решение по строке): строку можно записать повторным нажатием. */
export function isRetryableBatchCode(code: string): boolean {
  return code === BATCH_CODE_UNEXPECTED || code === BATCH_CODE_EXTERNAL_FAILURE;
}

/** Номера строк (файла), которые не записаны из-за сбоя хранилища и ждут повтора. */
export interface BatchRetryRows {
  rows: Set<number>;
  duplicates: Set<number>;
  /**
   * Карточки, обновлённые самой пачкой (в том числе прежним нажатием): id -> `updatedAt` после
   * её записи. На входе - то, что сохранено в запросе, на выходе - дополнено этим проходом.
   */
  ownWritten?: Map<string, string>;
}

function errorCode(error: unknown): string {
  return isDomainError(error) ? error.code : BATCH_CODE_UNEXPECTED;
}

function candidateOf(card: SupplierCard): {
  name: string;
  inn?: string;
  contacts: SupplierCard['contacts'];
} {
  return {
    name: card.name,
    ...(card.inn === undefined ? {} : { inn: card.inn }),
    contacts: card.contacts,
  };
}

/** Предупреждения строки в общий список с номером строки. */
function addRowWarnings(into: string[], row: number, warnings: readonly string[]): void {
  for (const warning of warnings) into.push(`строка ${row}: ${warning}`);
}

/** Записать новую строку: повторная проверка и поиск дублей на момент записи. */
async function createRow(
  deps: SupplierCardsDeps,
  row: SupplierBatchRow,
  context: CardBuildContext,
  warnings: string[],
): Promise<BatchRowResult | 'created'> {
  const id = newCardId(row.fields);
  // Этап 177: неверные значения очищаются, строка записывается с предупреждением.
  const sanitized = sanitizeSupplierCard(cardFromFields(row.fields, context, id));
  const card = sanitized.card;
  if (validateSupplierCard(card).length > 0) {
    return { row: row.row, code: BATCH_CODE_INVALID };
  }
  // Кандидат без id: запись с тем же id тоже должна считаться дублем.
  const duplicates = await deps.suppliers.findDuplicates(candidateOf(card));
  if (duplicates.length > 0) return { row: row.row, code: BATCH_CODE_DUPLICATE_APPEARED };
  if ((await deps.suppliers.getCard(id)) !== null) {
    return { row: row.row, code: BATCH_CODE_ALREADY_EXISTS };
  }
  try {
    // Создание не заменяет карточку, появившуюся между проверкой и записью.
    await deps.suppliers.saveCard(card, { createOnly: true });
  } catch (error) {
    if (errorCode(error) === CONFLICT_ERROR_CODE) {
      return { row: row.row, code: BATCH_CODE_ALREADY_EXISTS };
    }
    throw error;
  }
  addRowWarnings(warnings, row.row, sanitized.warnings);
  return 'created';
}

/** Обновить существующую карточку полями строки-дубля. */
async function updateRow(
  deps: SupplierCardsDeps,
  row: SupplierBatchRow,
  context: CardBuildContext,
  shownAt: string | undefined,
  ownWrites: Map<string, string>,
  warnings: string[],
): Promise<BatchRowResult | 'updated'> {
  const existing =
    row.targetId === undefined ? null : await deps.suppliers.getCard(row.targetId);
  if (existing === null) return { row: row.row, code: BATCH_CODE_TARGET_MISSING };
  // Карточку правили после показа пачки (чужая правка, не запись этой же пачки): не затираем.
  if (
    shownAt !== undefined &&
    row.targetId !== undefined &&
    ownWrites.get(row.targetId) !== existing.updatedAt &&
    isAfter(existing.updatedAt, shownAt)
  ) {
    return { row: row.row, code: BATCH_CODE_CARD_CHANGED };
  }
  const sanitized = sanitizeSupplierCard(applyFieldsToCard(existing, row.fields, context));
  const card = sanitized.card;
  if (validateSupplierCard(card).length > 0) {
    return { row: row.row, code: BATCH_CODE_INVALID };
  }
  let saved: SupplierCard;
  try {
    saved = await deps.suppliers.saveCard(
      card,
      existing.updatedAt === undefined ? {} : { expectedUpdatedAt: existing.updatedAt },
    );
  } catch (error) {
    if (errorCode(error) === CONFLICT_ERROR_CODE) {
      return { row: row.row, code: BATCH_CODE_CARD_CHANGED };
    }
    throw error;
  }
  if (row.targetId !== undefined) {
    // Версия карточки после нашей записи: на повторе она не считается чужой правкой.
    if (saved.updatedAt !== undefined) ownWrites.set(row.targetId, saved.updatedAt);
  }
  addRowWarnings(warnings, row.row, sanitized.warnings);
  return 'updated';
}

/** `value` строго позже `shownAt` (обе - ISO-момент; непонятное значение - не позже). */
function isAfter(value: string | undefined, shownAt: string): boolean {
  if (value === undefined) return false;
  const left = Date.parse(value);
  const right = Date.parse(shownAt);
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}

/**
 * Записать пачку после подтверждения. `save` - только новые строки (дубли базы пропущены),
 * `update` - новые и обновление существующих карточек по строкам-дублям. Каждая строка
 * проверяется заново; сбой одной строки попадает в итог и не останавливает остальные.
 *
 * `shownAt` - момент показа пачки: карточка-дубль, изменённая позже (не этой пачкой), не
 * обновляется (`card_changed`). `retry` (необязательно) собирает номера строк, не записанных
 * из-за сбоя хранилища: вызывающий оставляет по ним запрос открытым.
 */
export async function applySupplierBatch(
  deps: SupplierCardsDeps,
  request: Pick<SupplierBatchRequest, 'rows' | 'duplicates'>,
  action: 'save' | 'update',
  context: CardBuildContext,
  retry?: BatchRetryRows,
  shownAt?: string,
): Promise<BatchApplyResult> {
  const result: BatchApplyResult = {
    created: 0,
    updated: 0,
    skipped: [],
    failed: [],
    warnings: [],
  };
  const ownWrites = retry?.ownWritten ?? new Map<string, string>();
  const record = (row: number, error: unknown, into: Set<number> | undefined): void => {
    const code = errorCode(error);
    result.failed.push({ row, code });
    if (isRetryableBatchCode(code)) into?.add(row);
  };
  // Первая повторяемая ошибка (таймаут БД, временный сбой) означает, что хранилище лежит:
  // без этого каждая из сотен оставшихся строк ждала бы свой клиентский таймаут (по 35 с).
  let outage: string | undefined;
  let notTried = 0;
  const abort = (error: unknown): void => {
    if (outage === undefined && isDomainError(error) && error.retryable) outage = error.code;
  };
  // Строка не обработана и в БД не ходила: ждёт повторного нажатия.
  const deferRow = (row: number, into: Set<number> | undefined): void => {
    result.failed.push({ row, code: outage ?? BATCH_CODE_EXTERNAL_FAILURE });
    into?.add(row);
    notTried += 1;
  };
  for (const row of request.rows) {
    if (outage !== undefined) {
      deferRow(row.row, retry?.rows);
      continue;
    }
    try {
      const outcome = await createRow(deps, row, context, result.warnings);
      if (outcome === 'created') result.created += 1;
      else if (outcome.code === BATCH_CODE_INVALID) result.failed.push(outcome);
      else result.skipped.push(outcome);
    } catch (error) {
      record(row.row, error, retry?.rows);
      abort(error);
    }
  }
  for (const row of request.duplicates) {
    if (action === 'save') {
      result.skipped.push({ row: row.row, code: BATCH_CODE_EXISTING });
      continue;
    }
    if (outage !== undefined) {
      deferRow(row.row, retry?.duplicates);
      continue;
    }
    try {
      const outcome = await updateRow(deps, row, context, shownAt, ownWrites, result.warnings);
      if (outcome === 'updated') result.updated += 1;
      else result.failed.push(outcome);
    } catch (error) {
      record(row.row, error, retry?.duplicates);
      abort(error);
    }
  }
  // Один лог на пачку: код причины и сколько строк осталось без обращения к БД.
  if (outage !== undefined) {
    deps.log?.('supplier_batch_storage_unavailable', { code: outage, notTried });
  }
  return result;
}
