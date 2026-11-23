import {
  arrangeShortlist,
  buildCompareFacts,
  compareByCriteria,
  isWebOnlyEntry,
  parseModelOrder,
  planShortlist,
  type CompareFactsPosition,
  type ShortlistOrderMethod,
} from '../../kit/domain/shortlist-compare';
import { type ShortlistEntry } from '../../kit/domain/shortlist';
import type { ShortlistComparer } from '../../kit/ports/shortlist-comparer';
import type { OrderCalcDeps } from './deps';

/**
 * Отбор и ранжирование шорт-листа (этап 135). Состав по ярусам цен определяет код (база с
 * подходящей ценой, затем веб с ценой, затем без цены - в остаток); модель видит требования
 * заявки, названия найденных товаров с оценками соответствия, сайт и специализацию поставщика,
 * выбирает и ранжирует кандидатов пограничного яруса и пишет короткую причину по каждому.
 * Код проверяет ключи (свои, без повторов). Любой сбой, таймаут или мусор в ответе - правило
 * кода. Сборка шорт-листа от модели не зависит: исключение наружу не выходит.
 */

/**
 * Предел ожидания ответа модели, мс: по истечении запрос отменяется, берётся правило. Равен
 * таймауту одного запроса к модели (120 с, решение владельца 09.11), прежние 20 с отменяли
 * часть вызовов, которые ещё отвечали.
 */
export const SHORTLIST_COMPARE_TIMEOUT_MS = 120_000;
/** Код отмены по таймауту (в журнал идёт только он). */
const TIMEOUT_CODE = 'shortlist_compare_timeout';
const INVALID_ANSWER_CODE = 'shortlist_compare_invalid_answer';
/** Подкоды сбоя вне разбора ответа. */
const REASON_TIMEOUT = 'timeout';
const REASON_MODEL_ERROR = 'model_error';

/** Сравнитель и предел ожидания; без сравнителя порядок даёт правило. */
export interface ShortlistCompareDeps {
  comparer: ShortlistComparer;
  /** Предел ожидания, мс; по умолчанию `SHORTLIST_COMPARE_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/** Итог упорядочения. */
export interface OrderedShortlist {
  entries: ShortlistEntry[];
  /** Сколько кандидатов сравнивалось. */
  compared: number;
  method: ShortlistOrderMethod;
}

/** Код ошибки для журнала: имя класса либо код таймаута, без текста (в нём могли быть факты). */
function failureCode(error: unknown): string {
  if (error instanceof Error && error.message === TIMEOUT_CODE) return TIMEOUT_CODE;
  if (error instanceof Error && error.message === INVALID_ANSWER_CODE) return INVALID_ANSWER_CODE;
  return error instanceof Error ? error.name : 'unexpected';
}

/** Подкод причины сбоя вызова (не разбора): таймаут либо ошибка модели/сети. */
function failureReason(error: unknown): string {
  return error instanceof Error && error.message === TIMEOUT_CODE
    ? REASON_TIMEOUT
    : REASON_MODEL_ERROR;
}

/** Вызов сравнителя с пределом ожидания; по таймауту запрос к модели отменяется. */
async function compareWithTimeout(
  comparer: ShortlistComparer,
  facts: Parameters<ShortlistComparer['compare']>[0],
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(TIMEOUT_CODE)), timeoutMs);
  const onOuter = (): void => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuter, { once: true });
  try {
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    return await Promise.race([comparer.compare(facts, { signal: controller.signal }), aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}

/** Что модель знает о заявке: позиции с количеством и поля формы (срок, тираж, материал...). */
export interface ShortlistRequestContext {
  positions?: readonly CompareFactsPosition[] | undefined;
  requirements?: Readonly<Record<string, string>> | undefined;
  /** Названные сотрудником локации по порядку упоминания: их поставщики идут первыми. */
  locations?: readonly string[] | undefined;
}

/**
 * Отобрать `limit` кандидатов из пула и упорядочить. Состав обязательных ярусов не зависит от
 * модели; из пограничного яруса модель (или правило) берёт оставшиеся места. Пул из одного
 * кандидата не сравнивается (модель не вызывается). Событие журнала `shortlist_ranked` пишет
 * вызывающий код: он знает, что показано.
 */
export async function orderShortlistPool(
  host: Pick<OrderCalcDeps, 'log'> & { shortlistCompare?: ShortlistCompareDeps | undefined },
  pool: readonly ShortlistEntry[],
  limit: number,
  signal: AbortSignal | undefined,
  /** Позиции и требования заявки: модель видит, что нужно заказчику. */
  request: ShortlistRequestContext = {},
): Promise<OrderedShortlist> {
  const locations = request.locations ?? [];
  const byRule = compareByCriteria(pool);
  // Одна функция порядка на правило и на модель (этап 143): топ из базы с локациями вперёд,
  // интернет добирает недостающие места. Модель упорядочивает только базу.
  const plan = planShortlist(byRule, limit, locations);
  const selection = plan.baseSelection;
  const rule = (): OrderedShortlist => ({
    entries: arrangeShortlist(plan, byRule, limit, locations),
    compared: pool.length,
    method: 'rule',
  });
  const compare = host.shortlistCompare;
  // Модели достаётся то, что отобрал код: обязательные и пограничный ярус базы (по правилу).
  const inSelection = new Set(
    [...selection.required, ...selection.contested].map((entry) => entry.supplierId),
  );
  const forModel = byRule.filter((entry) => inSelection.has(entry.supplierId));
  if (compare === undefined || forModel.length < 2) return rule();
  const required = new Set(selection.required.map((entry) => entry.supplierId));
  const { facts, supplierIdByCode } = buildCompareFacts(forModel, {
    positions: request.positions,
    requirements: request.requirements,
    limit,
    requiredSupplierIds: required,
  });
  const need = Math.min(limit, forModel.length);
  try {
    const answer = await compareWithTimeout(
      compare.comparer,
      facts,
      compare.timeoutMs ?? SHORTLIST_COMPARE_TIMEOUT_MS,
      signal,
    );
    const outcome = parseModelOrder(answer, supplierIdByCode, forModel, { need });
    if (!outcome.ok) {
      // Только подкод и числа: текст ответа в журнал не идёт (в нём могут быть факты).
      host.log?.('shortlist_compare_failed', {
        code: INVALID_ANSWER_CODE,
        reason: outcome.reason,
        returned: outcome.returned,
        known: outcome.known,
        total: outcome.total,
      });
      return rule();
    }
    // Частичный ответ принят, недостающих дописало правило: это стоит видеть в журнале.
    if (outcome.known < need) {
      host.log?.('shortlist_compare_partial', { known: outcome.known, total: need });
    }
    const ranked = outcome.entries.map((entry) => {
      const reason = outcome.reasons.get(entry.supplierId);
      return reason === undefined ? entry : { ...entry, rankReason: reason };
    });
    const entries = arrangeShortlist(plan, ranked, limit, locations);
    return { entries, compared: forModel.length, method: 'model' };
  } catch (error) {
    host.log?.('shortlist_compare_failed', {
      code: failureCode(error),
      reason: failureReason(error),
      total: forModel.length,
    });
    return rule();
  }
}

/** Сколько веб-кандидатов в показанном списке (для журнала). */
export function webShownCount(entries: readonly ShortlistEntry[]): number {
  return entries.filter(isWebOnlyEntry).length;
}
