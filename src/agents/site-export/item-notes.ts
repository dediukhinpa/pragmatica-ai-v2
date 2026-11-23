import { z } from 'zod';
import { findItemConflicts, type ItemConflict, type ItemValue } from '../../kit/domain/item-data';
import { stateEntries } from '@business-ai/core';
import { stableHash, writeState } from '@business-ai/core';
import { listByPrefix } from './cards';
import { notesNamespace, type SiteExportDeps } from './deps';

/** Страница чтения заметок набора. */
const NOTES_PAGE_SIZE = 200;

const itemValueSchema = z.object({
  itemKey: z.string().min(1),
  field: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  source: z.string().min(1),
});

/** Ключ записи значения в общем списке: хэш по (позиция, поле, источник). */
function valueKey(item: ItemValue): string {
  return `val:${stableHash([item.itemKey, item.field, item.source])}`;
}

/**
 * Ключ записи в индексе по позиции: префикс (хэш позиции) позволяет прочитать значения одной
 * позиции диапазоном ключей, а не весь набор (R5-CORE-6).
 */
function itemIndexPrefix(itemKey: string): string {
  return `item:${stableHash(itemKey)}:`;
}

function itemIndexKey(item: ItemValue): string {
  return `${itemIndexPrefix(item.itemKey)}${stableHash([item.field, item.source])}`;
}

/** Служебная запись: индекс по позиции построен для всех значений набора. */
const ITEM_INDEX_MARKER_KEY = 'meta:item-index';

/**
 * Сохранить значения из источников; повтор того же источника для поля заменяет значение.
 * Пишется в общий список (`val:`, как прежде) и в индекс по позиции (`item:`).
 */
export async function saveItemValues(
  deps: SiteExportDeps,
  exportId: string,
  values: readonly ItemValue[],
): Promise<void> {
  for (const item of values) {
    await writeState(deps.state, notesNamespace(exportId), valueKey(item), item);
    await writeState(deps.state, notesNamespace(exportId), itemIndexKey(item), item);
  }
}

/** Все сохранённые значения набора. */
async function loadItemValues(deps: SiteExportDeps, exportId: string): Promise<ItemValue[]> {
  const result: ItemValue[] = [];
  const entries = stateEntries(deps.state, notesNamespace(exportId), {
    pageSize: NOTES_PAGE_SIZE,
  });
  for await (const entry of entries) {
    const parsed = itemValueSchema.safeParse(entry.value);
    if (entry.key.startsWith('val:') && parsed.success) result.push(parsed.data);
  }
  return result;
}

/**
 * Значения, записанные до появления индекса по позиции, в нём отсутствуют: при первом
 * чтении по позициям индекс достраивается из общего списка и ставится отметка (один полный
 * просмотр на набор). Дальше значения позиции читаются диапазоном ключей.
 */
async function ensureItemIndex(deps: SiteExportDeps, exportId: string): Promise<void> {
  const namespace = notesNamespace(exportId);
  if ((await deps.state.get(namespace, ITEM_INDEX_MARKER_KEY)) !== null) return;
  for (const item of await loadItemValues(deps, exportId)) {
    await writeState(deps.state, namespace, itemIndexKey(item), item);
  }
  await writeState(deps.state, namespace, ITEM_INDEX_MARKER_KEY, { version: 1 });
}

/** Значения заданных позиций набора (по индексу, без чтения значений остальных позиций). */
async function loadItemValuesFor(
  deps: SiteExportDeps,
  exportId: string,
  itemKeys: ReadonlySet<string>,
): Promise<ItemValue[]> {
  await ensureItemIndex(deps, exportId);
  const result: ItemValue[] = [];
  for (const itemKey of itemKeys) {
    const prefix = itemIndexPrefix(itemKey);
    const entries = await listByPrefix(deps.state, notesNamespace(exportId), prefix);
    for (const entry of entries) {
      const parsed = itemValueSchema.safeParse(entry.value);
      // Хэш позиции мог совпасть у другой позиции: сверяем сам ключ.
      if (parsed.success && parsed.data.itemKey === itemKey) result.push(parsed.data);
    }
  }
  return result;
}

/** Противоречия по сохранённым значениям набора (можно ограничить списком позиций). */
export async function loadConflicts(
  deps: SiteExportDeps,
  exportId: string,
  itemKeys?: ReadonlySet<string>,
): Promise<ItemConflict[]> {
  if (itemKeys === undefined) return findItemConflicts(await loadItemValues(deps, exportId));
  return findItemConflicts(await loadItemValuesFor(deps, exportId, itemKeys));
}

export const conflictSchema = z.object({
  itemKey: z.string(),
  field: z.string(),
  values: z.array(
    z.object({ value: z.union([z.string(), z.number()]), sources: z.array(z.string()) }),
  ),
});
