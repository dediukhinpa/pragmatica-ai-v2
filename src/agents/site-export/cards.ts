import { z } from 'zod';
import { DomainError, type ValidationIssue } from '@business-ai/core';
import { type ExportCard } from '../../kit/domain/site-export';
import type { WorkflowStateEntry, WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { stableHash, toStoredJson } from '@business-ai/core';
import {
  EXPORT_MAX_ISSUES_LISTED,
  PUBLISH_BATCH_SIZE,
  exportNamespace,
  skuIndexNamespace,
  type SiteExportDeps,
} from './deps';

/** Карточка в хранилище: значения только примитивы (как в шаблоне). */
const cardSchema: z.ZodType<ExportCard, z.ZodTypeDef, unknown> = z.record(
  z.union([z.string(), z.number(), z.boolean()]),
);

/** Запись набора: ключ внутри набора и карточка. */
export interface StoredCard {
  key: string;
  card: ExportCard;
}

function parseCard(entry: WorkflowStateEntry): StoredCard {
  const parsed = cardSchema.safeParse(entry.value);
  if (!parsed.success) {
    throw new DomainError('external_failure', `Карточка ${entry.key} в наборе повреждена.`);
  }
  return { key: entry.key, card: parsed.data };
}

/** Страница набора после `afterKey`. */
export async function listCards(
  deps: SiteExportDeps,
  exportId: string,
  afterKey: string | null,
  limit: number,
): Promise<StoredCard[]> {
  const entries = await deps.state.list(exportNamespace(exportId), afterKey, limit);
  return entries.map(parseCard);
}

/** Весь набор по порядку ключей (постранично). */
export async function loadAllCards(deps: SiteExportDeps, exportId: string): Promise<StoredCard[]> {
  const all: StoredCard[] = [];
  const entries = stateEntries(deps.state, exportNamespace(exportId), {
    pageSize: PUBLISH_BATCH_SIZE,
  });
  for await (const entry of entries) all.push(parseCard(entry));
  return all;
}

/** Размер страницы при чтении записей по префиксу: под префиксом обычно единицы записей. */
const PREFIX_PAGE_SIZE = 25;

/**
 * Записи пространства, ключи которых начинаются с `prefix`. Список упорядочен по ключу, поэтому
 * выборка читает только нужный диапазон (после префикса), а не всё пространство. Ключи должны
 * быть строго длиннее префикса: сам префикс «строго после» не попадает.
 */
export async function listByPrefix(
  state: WorkflowStateStore,
  namespace: string,
  prefix: string,
): Promise<WorkflowStateEntry[]> {
  const found: WorkflowStateEntry[] = [];
  const entries = stateEntries(state, namespace, {
    pageSize: PREFIX_PAGE_SIZE,
    after: prefix,
    prefix,
  });
  for await (const entry of entries) found.push(entry);
  return found;
}

/** Артикул для сравнения карточек: без пробелов по краям и без учёта регистра. */
function normalizedCardSku(card: ExportCard, skuField: string): string {
  return String(card[skuField] ?? '').trim().toLowerCase();
}

/** Префикс записей индекса артикулов для одного нормализованного артикула. */
function skuIndexPrefix(normalizedSku: string): string {
  return `${stableHash(normalizedSku)}:`;
}

/**
 * Отметка «индекс артикулов полный»: набор начат после появления индекса, и каждая его
 * карточка внесена в индекс до записи самой карточки. Ключ вне пространства префиксов
 * артикулов (они - hex-отпечаток и `:`), поэтому поиск по префиксу его не видит.
 */
const SKU_INDEX_COMPLETE_KEY = '~complete';

/**
 * Отметить, что индекс артикулов набора полный. Ставится только новому набору (сброс или
 * пустой набор): у набора, начатого до индекса, часть карточек в индексе отсутствует.
 */
export async function markSkuIndexComplete(deps: SiteExportDeps, exportId: string): Promise<void> {
  await deps.state.put(skuIndexNamespace(exportId), SKU_INDEX_COMPLETE_KEY, { complete: true });
}

/** Внести карточку в индекс артикулов (одна запись на пару артикул - ключ карточки). */
export async function indexCardSku(
  deps: SiteExportDeps,
  exportId: string,
  cardKeyValue: string,
  card: ExportCard,
): Promise<void> {
  const prefix = skuIndexPrefix(normalizedCardSku(card, deps.template.skuField));
  await deps.state.put(
    skuIndexNamespace(exportId),
    `${prefix}${cardKeyValue}`,
    toStoredJson({ key: cardKeyValue }),
  );
}

const indexEntrySchema = z.object({ key: z.string() });

/**
 * Карточки набора с данным артикулом (сравнение как в draftDescription: trim и регистр).
 * Идёт по индексу и проверяет каждую найденную карточку по её содержимому (устаревшая запись
 * индекса безвредна). Ни одна не подтвердилась: у набора с полным индексом это честный промах
 * (артикула нет), у набора, созданного до индекса, - полный просмотр набора, как раньше.
 * Раньше полный просмотр шёл на каждый промах: 10 промахов по набору из 2000 карточек читали
 * 20 тыс. записей (R9-A2-08).
 */
export async function findCardsBySku(
  deps: SiteExportDeps,
  exportId: string,
  wantedSku: string,
): Promise<StoredCard[]> {
  const skuField = deps.template.skuField;
  const entries = await listByPrefix(
    deps.state,
    skuIndexNamespace(exportId),
    skuIndexPrefix(wantedSku),
  );
  const verified: StoredCard[] = [];
  for (const entry of entries) {
    const indexed = indexEntrySchema.safeParse(entry.value);
    if (!indexed.success) continue;
    const raw = await deps.state.get(exportNamespace(exportId), indexed.data.key);
    if (raw === null) continue;
    const stored = parseCard({ key: indexed.data.key, value: raw });
    if (normalizedCardSku(stored.card, skuField) === wantedSku) verified.push(stored);
  }
  if (verified.length > 0) return verified;
  const complete = await deps.state.get(skuIndexNamespace(exportId), SKU_INDEX_COMPLETE_KEY);
  if (complete !== null) return [];
  const all = await loadAllCards(deps, exportId);
  return all.filter((item) => normalizedCardSku(item.card, skuField) === wantedSku);
}

/** Ширина номера части и позиции в ключе карточки. */
const CARD_KEY_WIDTH = 6;

/** Префикс ключей карточек одной части набора. */
export function partKeyPrefix(part: number): string {
  return `p${String(part).padStart(CARD_KEY_WIDTH, '0')}:`;
}

/** Ключ карточки в наборе: номер части и позиция в ней (сортируется как строка). */
export function cardKey(part: number, index: number): string {
  return `${partKeyPrefix(part)}${String(index).padStart(CARD_KEY_WIDTH, '0')}`;
}

/** Отпечаток набора: ключи и содержимое всех карточек. Меняется при любой правке. */
export function setHashOf(cards: readonly StoredCard[]): string {
  return stableHash(cards.map((item) => [item.key, item.card]));
}

/** Не более `EXPORT_MAX_ISSUES_LISTED` замечаний; остальные сводятся в одно. */
export function limitExportIssues(issues: ValidationIssue[]): ValidationIssue[] {
  if (issues.length <= EXPORT_MAX_ISSUES_LISTED) return issues;
  const rest = issues.length - EXPORT_MAX_ISSUES_LISTED;
  return [
    ...issues.slice(0, EXPORT_MAX_ISSUES_LISTED),
    { code: 'more_issues', message: `Ещё ${rest} замечаний не показано.` },
  ];
}
