import { z } from 'zod';
import { readState, stableHash, writeState } from '@business-ai/core';
import type { WorkflowStateStore } from '@business-ai/core';
import type { PurchaseRequest } from './kit/domain/models';
import { SHORTLIST_MAX_SIZE, sourceResultSchema } from './kit/domain/shortlist';

/**
 * Состояние выдачи «ещё 10» (этап 8z): что уже показано менеджеру по заявке, где остановилась
 * страница и что найдено, но ещё не показано. Лежит в своём пространстве имён и не пересекается
 * с состоянием шорт-листа (`order-calc:source`, `order-calc:proposal`).
 */

/** Пространство состояния; ключ записи - заявка. */
export const SHORTLIST_PAGE_NAMESPACE = 'order-calc:shortlist-page';

const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const PAGE_TTL_HOURS = 6;
/**
 * Срок жизни состояния от последней записи, мс. Шесть часов покрывают рабочую сессию с заявкой;
 * дольше список устаревает (цены, карточки), и «ещё» начинает от текущего шорт-листа заново.
 */
export const SHORTLIST_PAGE_TTL_MS = PAGE_TTL_HOURS * SECONDS_PER_HOUR * MS_PER_SECOND;

/** Сколько страниц (включая первую выдачу) можно показать по одному состоянию. */
export const SHORTLIST_PAGES_MAX = 5;
/** Сколько платных поисков в интернете разрешено на одно состояние (без обогащения). */
export const SHORTLIST_WEB_SEARCHES_MAX = 6;
/** Сколько запросов уходит за один шаг свежего поиска (один суффикс на все запросы шага). */
export const SHORTLIST_WEB_QUERIES_PER_STEP = 2;
/** Сколько шагов свежего поиска допустимо за один вызов «ещё» (против всплеска запросов). */
export const SHORTLIST_WEB_STEPS_PER_CALL = 2;
/**
 * Суффиксы запросов свежего поиска по порядку шагов. Платформа отдаёт не больше десяти хитов
 * на поиск, поэтому новые кандидаты берутся другой формулировкой, а не большим пределом выдачи.
 */
export const SHORTLIST_WEB_QUERY_SUFFIXES = ['оптом', 'производитель', 'поставщик'] as const;
/** Предел кандидатов на позицию заявки при повторном поиске по базе (прежний - 10). */
export const SHORTLIST_BASE_RESEARCH_LIMIT = 50;
/** Сколько кандидатов базы и интернета хранится в состоянии (против разрастания записи). */
export const SHORTLIST_CACHE_MAX = 60;
/** Размер страницы по умолчанию и наибольший: как у первой выдачи. */
export const SHORTLIST_PAGE_SIZE = SHORTLIST_MAX_SIZE;

/** Состояние выдачи по заявке. */
export const shortlistPageStateSchema = z.object({
  requestId: z.string().min(1),
  /** Версия шорт-листа, на которой стоит состояние: другая версия - состояние начинается заново. */
  proposalVersion: z.string().min(1),
  /** Отпечаток критериев (позиции, требования, поля формы): сменился - выдача устарела. */
  criteriaKey: z.string().min(1),
  /** Ключи идентичности показанных поставщиков (`SupplierIdentitySet.toKeys()`). */
  shownKeys: z.array(z.string()),
  /** Идентификаторы показанных строк шорт-листа (карточки базы и `ext-…` из интернета). */
  shownIds: z.array(z.string()),
  /** Сколько страниц показано (первая выдача - страница 1). */
  page: z.number().int().positive(),
  /** База не заполнила страницу: дальше она не запрашивается, страницы идут из интернета. */
  baseExhausted: z.boolean(),
  /** Свежий поиск в интернете больше ничего не даст (формулировки или бюджет поисков вышли). */
  webExhausted: z.boolean(),
  /** Сколько платных поисков уже выполнено по этому состоянию. */
  webSearchesDone: z.number().int().nonnegative(),
  /** Номер следующего суффикса запроса (`SHORTLIST_WEB_QUERY_SUFFIXES`). */
  webStep: z.number().int().nonnegative(),
  /** Базовые веб-запросы по заявке, спланированные один раз (без суффикса). */
  webQueries: z.array(z.string()).optional(),
  /** Локация, названная сотрудником (как для `buildShortlist`); нет - без приоритета. */
  location: z.string().optional(),
  /** Результат повторного поиска по базе с большим пределом; нет - ещё не искали. */
  baseExtra: sourceResultSchema.optional(),
  /** Найденные свежим поиском, но ещё не показанные кандидаты из интернета. */
  webCache: sourceResultSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ShortlistPageState = z.infer<typeof shortlistPageStateSchema>;

/** Позиция заявки для отпечатка критериев: название и требования (количество не влияет). */
interface CriteriaItem {
  name: string;
  requirements: string | undefined;
}

/**
 * Отпечаток критериев заявки: номер заявки, названия позиций и требования к ним, поля формы
 * (срок, тираж, материал). Не зависит от порядка полей формы. Сменился - прежняя выдача
 * построена по другим критериям и продолжать её нельзя.
 */
export function criteriaKeyOf(
  request: Pick<PurchaseRequest, 'id' | 'items'>,
  fields: Readonly<Record<string, string>> = {},
): string {
  const items: CriteriaItem[] = request.items.map((item) => ({
    name: item.name.trim().toLowerCase(),
    requirements: item.requirements?.trim().toLowerCase(),
  }));
  const sortedFields = Object.keys(fields)
    .sort()
    .map((key) => [key, (fields[key] ?? '').trim().toLowerCase()]);
  return stableHash({ requestId: request.id, items, fields: sortedFields });
}

/** Состояние живо: срок не вышел. Битая дата срока - состояние не используется. */
export function isPageStateAlive(state: ShortlistPageState, now: Date): boolean {
  const expires = Date.parse(state.expiresAt);
  return Number.isFinite(expires) && expires > now.getTime();
}

/** Срок состояния, записываемого в момент `now`: отсчёт от последней записи. */
export function pageStateExpiry(now: Date): string {
  return new Date(now.getTime() + SHORTLIST_PAGE_TTL_MS).toISOString();
}

/** Прочитать состояние выдачи по заявке; нет записи - null. */
export function loadPageState(
  state: WorkflowStateStore,
  requestId: string,
): Promise<ShortlistPageState | null> {
  return readState(state, SHORTLIST_PAGE_NAMESPACE, requestId, shortlistPageStateSchema);
}

/**
 * Записать состояние выдачи (ключ - заявка). Запись помечена `done`: срок жизни выдачи задаёт
 * `SHORTLIST_PAGE_TTL_MS`, а забытую запись уберёт ретенция состояния через
 * `WORKFLOW_STATE_RETENTION_DAYS`, отдельно вносить пространство в её список не нужно.
 */
export function savePageState(
  state: WorkflowStateStore,
  value: ShortlistPageState,
): Promise<void> {
  return writeState(state, SHORTLIST_PAGE_NAMESPACE, value.requestId, value, { done: true });
}

/** Забыть состояние выдачи по заявке (критерии сменились или запись устарела). */
export function deletePageState(state: WorkflowStateStore, requestId: string): Promise<void> {
  return state.delete(SHORTLIST_PAGE_NAMESPACE, requestId);
}
