import type { WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { IMPORT_META_NAMESPACE } from './deps';
import { loadKeyedDiskSyncOutcomes } from './disk-sync-outcome';
import { importMetaSchema } from './price-state';

/**
 * История файлов поставщика: какие прайс-файлы с диска брались для него в импорт. Источник -
 * происхождение импортов (`prices:import-meta`, ключ `<поставщик>:<отпечаток>`, `fileName` -
 * путь от корня диска, как пишет код этапа 116). Нужна правилу строк без `source_file` и
 * разовому заполнению этого поля задним числом.
 */

const IMPORT_META_PAGE = 200;
/** Предел страниц полного обхода (10 000 импортов). */
const IMPORT_META_MAX_PAGES = 50;
const IMPORT_KEY_SEPARATOR = ':';

/**
 * Файлы одного поставщика. Источники сводятся вместе, потому что каждый неполон: import-meta
 * (по префиксу ключа - без обхода всего пространства), записанные итоги первичного импорта
 * (`disk-sync-outcome`: на бою 120 записанных файлов при 56 записях import-meta) и
 * `source_file` строк, уже лежащих в базе (`rowFiles`).
 */
export async function loadSupplierDiskFiles(
  state: WorkflowStateStore | undefined,
  supplierId: string,
  rowFiles: Iterable<string> = [],
): Promise<string[]> {
  const files = new Set<string>(rowFiles);
  if (state === undefined) return [...files];
  const prefix = `${supplierId}${IMPORT_KEY_SEPARATOR}`;
  const entries = stateEntries(state, IMPORT_META_NAMESPACE, {
    pageSize: IMPORT_META_PAGE,
    maxPages: IMPORT_META_MAX_PAGES,
    after: prefix,
    prefix,
  });
  for await (const entry of entries) {
    // Поставщик - всё до последнего «:», иначе чужой id с тем же началом попал бы в историю.
    if (entry.key.lastIndexOf(IMPORT_KEY_SEPARATOR) !== prefix.length - 1) continue;
    const meta = importMetaSchema.safeParse(entry.value);
    if (meta.success && meta.data.source === 'disk' && meta.data.fileName !== undefined) {
      files.add(meta.data.fileName);
    }
  }
  const { outcomes } = await loadKeyedDiskSyncOutcomes(state);
  for (const outcome of outcomes) {
    if (outcome.status === 'written' && outcome.supplierId === supplierId && outcome.path !== undefined) {
      files.add(outcome.path);
    }
  }
  return [...files];
}

/** Файлы всех поставщиков и признак «обход неполон» (для разового заполнения). */
export async function loadAllSupplierDiskFiles(
  state: WorkflowStateStore,
): Promise<{ bySupplier: Map<string, Set<string>>; truncated: boolean }> {
  const bySupplier = new Map<string, Set<string>>();
  let truncated = false;
  const entries = stateEntries(state, IMPORT_META_NAMESPACE, {
    pageSize: IMPORT_META_PAGE,
    maxPages: IMPORT_META_MAX_PAGES,
    onLimit: () => {
      truncated = true;
    },
  });
  for await (const entry of entries) {
    const meta = importMetaSchema.safeParse(entry.value);
    if (!meta.success || meta.data.source !== 'disk' || meta.data.fileName === undefined) continue;
    const separator = entry.key.lastIndexOf(IMPORT_KEY_SEPARATOR);
    if (separator <= 0) continue;
    const supplierId = entry.key.slice(0, separator);
    const files = bySupplier.get(supplierId) ?? new Set<string>();
    files.add(meta.data.fileName);
    bySupplier.set(supplierId, files);
  }
  return { bySupplier, truncated };
}
