import { PriceBaseChangedError } from '../../kit/domain/errors.owned';
import { type PriceItem } from '../../kit/domain/models';
import type { PriceRepository, SupplierRepository } from '../../kit/ports/repositories.owned';
import type { WorkflowStateStore } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { loadKeyedDiskSyncOutcomes, readDiskSyncOutcome } from './disk-sync-outcome';
import { priceListHash } from './employee-updates';
import { diskSyncThreadId } from './price-disk-sync';
import { loadAllSupplierDiskFiles } from './supplier-file-history';

/**
 * Разовое заполнение `source_file` у строк, загруженных до этапа 116. Таких строк нет файла, и
 * импорт нового файла поставщика мог принять их за свои и затереть (чужая прайс-линия). Файл
 * восстанавливается по истории импортов: если у поставщика со строками без файла в истории
 * ровно один записанный файл - он и проставляется. Ноль или несколько файлов - не трогаем,
 * угадывать нельзя.
 */

/** Страница обхода поставщиков. */
const SUPPLIER_PAGE_SIZE = 200;

/** Почему поставщик не обрабатывается. */
export type BackfillSkipReason =
  /** В истории нет записанных файлов. */
  | 'no_history'
  /** В истории несколько файлов: неизвестно, из какого строки без файла. */
  | 'several_files'
  /** Строки с файлом уже есть: строки без файла - не его прежняя версия, а лишний слой. */
  | 'has_file_rows';

/** Решение по одному поставщику со строками без файла. */
export interface BackfillEntry {
  supplierId: string;
  /** Строк без файла. */
  nullRows: number;
  /** Файл для проставления; нет - поставщик пропущен по `skip`. */
  file?: string;
  skip?: BackfillSkipReason;
  /** Сколько файлов в истории (для плана). */
  historyFiles: number;
}

/** План заполнения. */
export interface BackfillPlan {
  entries: BackfillEntry[];
  /** История прочитана не целиком (предел страниц): план может быть неполным. */
  truncated: boolean;
}

/** Зависимости заполнения. */
export interface BackfillDeps {
  state: WorkflowStateStore;
  suppliers: Pick<SupplierRepository, 'listPage'>;
  prices: Pick<PriceRepository, 'listBySupplier' | 'saveImport'>;
}

/**
 * Файлы истории поставщиков, по которым запись не `written` (пропущены или не завершены), из
 * списка не берутся: строки такого файла в базу не попадали. Файл без записи итога (обычная
 * синхронизация, итоги ведутся только в первичном импорте) принимается.
 */
async function writtenFilesBySupplier(
  state: WorkflowStateStore,
  diskPaths: readonly string[],
): Promise<{ bySupplier: Map<string, Set<string>>; truncated: boolean }> {
  const { bySupplier, truncated } = await loadAllSupplierDiskFiles(state);
  const pathByThread = new Map(diskPaths.map((path) => [diskSyncThreadId(path), path]));
  // Непроверенные карточки: поставщик известен из итога файла, даже если происхождения импорта нет.
  const outcomes = await loadKeyedDiskSyncOutcomes(state);
  for (const outcome of outcomes.outcomes) {
    const path = pathByThread.get(outcome.threadId);
    const supplierId = outcome.draft?.supplierId;
    if (path === undefined || supplierId === undefined || outcome.status !== 'written') continue;
    bySupplier.set(supplierId, (bySupplier.get(supplierId) ?? new Set<string>()).add(path));
  }
  for (const files of bySupplier.values()) {
    for (const path of [...files]) {
      const outcome = await readDiskSyncOutcome(state, diskSyncThreadId(path));
      if (outcome !== null && outcome.status !== 'written') files.delete(path);
    }
  }
  return { bySupplier, truncated: truncated || outcomes.truncated };
}

/** Только чтение: кому и какой файл будет проставлен, кого пропустят и почему. */
export async function planSourceFileBackfill(
  deps: BackfillDeps,
  diskPaths: readonly string[],
): Promise<BackfillPlan> {
  const { bySupplier, truncated } = await writtenFilesBySupplier(deps.state, diskPaths);
  const entries: BackfillEntry[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await deps.suppliers.listPage(after, SUPPLIER_PAGE_SIZE);
    if (page.length === 0) break;
    for (const supplier of page) {
      const items = await deps.prices.listBySupplier(supplier.id);
      const nullRows = items.filter((item) => item.sourceFile === undefined).length;
      if (nullRows === 0) continue;
      entries.push(decide(supplier.id, nullRows, items, bySupplier.get(supplier.id)));
    }
    after = page[page.length - 1]?.id ?? null;
    if (after === null || page.length < SUPPLIER_PAGE_SIZE) break;
  }
  return { entries, truncated };
}

function decide(
  supplierId: string,
  nullRows: number,
  items: readonly PriceItem[],
  history: ReadonlySet<string> | undefined,
): BackfillEntry {
  const files = [...(history ?? [])];
  const base = { supplierId, nullRows, historyFiles: files.length };
  const [file] = files;
  if (file === undefined) return { ...base, skip: 'no_history' };
  if (files.length > 1) return { ...base, skip: 'several_files' };
  if (items.some((item) => item.sourceFile !== undefined)) return { ...base, skip: 'has_file_rows' };
  return { ...base, file };
}

/** Итог записи. */
export interface BackfillResult {
  /** Поставщиков, у которых строки получили файл. */
  updated: number;
  /** Строк без файла, получивших файл. */
  rows: number;
  /** Поставщиков, у которых прайс изменился за время работы: пропущены, повторите запуск. */
  changed: number;
}

/**
 * Записать файл строкам без файла по плану. Идёт через `saveImport` (блокировка по поставщику,
 * сверка базы, ключ идемпотентности от файла и состояния прайса): повторный запуск находит уже
 * заполненных поставщиков без строк без файла и ничего не делает. Остальные строки сохраняют
 * свой `sourceFile` (без `options.sourceFile` замена идёт целиком, файл у строк свой).
 */
export async function applySourceFileBackfill(
  deps: Pick<BackfillDeps, 'prices'>,
  plan: BackfillPlan,
): Promise<BackfillResult> {
  const result: BackfillResult = { updated: 0, rows: 0, changed: 0 };
  for (const entry of plan.entries) {
    if (entry.file === undefined) continue;
    const { file } = entry;
    const items = await deps.prices.listBySupplier(entry.supplierId);
    const empty = items.filter((item) => item.sourceFile === undefined).length;
    if (empty === 0 || items.some((item) => item.sourceFile !== undefined)) continue;
    const filled = items.map((item): PriceItem => ({ ...item, sourceFile: file }));
    const hash = priceListHash(items);
    const key = `source-file-backfill:${entry.supplierId}:${stableHash([file])}:${hash}:${items.length}`;
    try {
      await deps.prices.saveImport(entry.supplierId, filled, key, {
        isExpectedBase: (current) =>
          current.length === items.length && priceListHash(current) === hash,
      });
    } catch (error) {
      // Прайс изменился между чтением и записью: поставщик пропускается, остальные идут дальше.
      if (!(error instanceof PriceBaseChangedError)) throw error;
      result.changed += 1;
      continue;
    }
    result.updated += 1;
    result.rows += empty;
  }
  return result;
}
