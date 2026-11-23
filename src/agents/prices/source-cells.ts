import { z } from 'zod';
import { readState, writeState } from '@business-ai/core';
import { SOURCE_CELLS_NAMESPACE, type PricesDeps } from './deps';
import type { PriceCellRef } from './table-rows';

/**
 * Где лежит цена позиции в исходном файле. Поле `refs` у позиции - несколько мест, если ключ
 * (артикул или название) повторяется в таблице: правка касается всех.
 */
const cellPlaceSchema = z.object({
  table: z.number().int().nonnegative(),
  sheet: z.string().optional(),
  row: z.number().int().nonnegative(),
  cols: z.array(z.number().int().nonnegative()),
});
export type CellPlace = z.infer<typeof cellPlaceSchema>;

/**
 * Координаты цен импорта. Хранятся в состоянии рядом с метаданными импорта, а не в PriceItem:
 * миграций БД нет, старые импорты просто не имеют записи (правка на месте для них недоступна).
 */
export const sourceCellsSchema = z.object({
  /** Идентификатор исходного файла для инструментов чтения (путь диска, id приёма, письмо). */
  path: z.string(),
  fileName: z.string(),
  items: z.record(z.string(), z.array(cellPlaceSchema)).default({}),
});
export type SourceCells = z.infer<typeof sourceCellsSchema>;

/** Прочитать координаты импорта; null - записи нет (старый импорт или нет состояния). */
export async function loadSourceCells(
  deps: PricesDeps,
  importId: string,
): Promise<SourceCells | null> {
  if (deps.state === undefined) return null;
  return readState(deps.state, SOURCE_CELLS_NAMESPACE, importId, sourceCellsSchema);
}

/** Сбросить координаты импорта (reset разбора): прежние строки больше не актуальны. */
export async function discardSourceCells(deps: PricesDeps, importId: string): Promise<void> {
  await deps.state?.delete(SOURCE_CELLS_NAMESPACE, importId);
}

/** Куда в файле относятся координаты куска: файл и таблица. */
export interface SourceCellsTarget {
  path: string;
  fileName: string;
  table: number;
  sheet?: string | undefined;
}

/**
 * Добавить координаты куска таблицы. Повтор того же куска не дублирует места (строка и таблица
 * уже записаны); ошибка записи не должна ронять разбор прайса, поэтому вызывающий её гасит.
 */
export async function appendSourceCells(
  deps: PricesDeps,
  importId: string,
  target: SourceCellsTarget,
  cells: readonly PriceCellRef[],
): Promise<void> {
  if (deps.state === undefined) return;
  const current = (await loadSourceCells(deps, importId)) ?? {
    path: target.path,
    fileName: target.fileName,
    items: {},
  };
  const items: Record<string, CellPlace[]> = { ...current.items };
  for (const cell of cells) {
    const places = [...(items[cell.key] ?? [])];
    const known = places.some((place) => place.table === target.table && place.row === cell.row);
    if (known) continue;
    places.push({
      table: target.table,
      ...(target.sheet === undefined ? {} : { sheet: target.sheet }),
      row: cell.row,
      cols: cell.cols,
    });
    items[cell.key] = places;
  }
  await writeState(deps.state, SOURCE_CELLS_NAMESPACE, importId, {
    path: current.path,
    fileName: current.fileName,
    items,
  });
}
