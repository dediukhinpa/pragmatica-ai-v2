import { z } from 'zod';

/**
 * Позиции, у которых размер упаковки есть в источнике, но записать его нельзя (решение владельца
 * 15: порядок Ш×В×Г неясен). Список копится в записи рабочей книги между вызовами
 * fillTemplateRows (пакетов может быть несколько) и повторяется в ответе sendTemplateFile:
 * итоговое сообщение пишет модель, и кодовая гарантия предупреждения - в том, что инструмент
 * выдачи файла сам отдаёт готовую строку, не полагаясь на память модели о прошлых вызовах.
 */

/** Начало предупреждения; дальше - позиции. */
export const SIZE_UNRESOLVED_WARNING = 'Размеры не удалось определить для:';
/** Конец того же предупреждения: просьба прислать данные. */
export const SIZE_SEND_DATA = 'Пришлите данные — дополню';

/** Запись в книге: строка листа (если известна) и подпись позиции. */
export const sizeUnresolvedEntrySchema = z.object({
  row: z.number().int().nullable(),
  label: z.string(),
});
export type SizeUnresolvedEntry = z.infer<typeof sizeUnresolvedEntrySchema>;

/** Позиция вызова, у которой размер не определён: название из ячейки «Название» либо null. */
export interface FreshUnresolved {
  itemIndex: number;
  name: string | null;
}

/** Готовая строка предупреждения для итогового сообщения. */
export function sizeUnresolvedWarning(entries: readonly SizeUnresolvedEntry[]): string {
  const labels = entries.map((entry) => entry.label);
  return `${SIZE_UNRESOLVED_WARNING} ${labels.join(', ')}. ${SIZE_SEND_DATA}`;
}

/** Подписи записей без повторов, в порядке накопления. */
export function sizeUnresolvedLabels(entries: readonly SizeUnresolvedEntry[]): string[] {
  return entries.map((entry) => entry.label);
}

/**
 * Обновить накопленный список после вызова. Подпись уникальна между пакетами: без названия
 * позиция называется по строке листа («строка 15»), а не по номеру внутри вызова («позиция 1»,
 * который в каждом пакете свой); одинаковое название у разных строк уточняется строкой.
 * Позиция, которую исправили (размер записан), из списка уходит; повторный отказ той же строки
 * заменяет прежнюю запись.
 */
export function mergeSizeUnresolved(input: {
  stored: readonly SizeUnresolvedEntry[];
  fresh: readonly FreshUnresolved[];
  rows: ReadonlyArray<number | null>;
  /** Позиции вызова, чей размер теперь разобран: их строки из списка убираются. */
  resolvedItems: readonly number[];
  /** Номер пакета для позиции без названия и без строки (строки нет - различать нечем). */
  batchTag: number;
}): SizeUnresolvedEntry[] {
  const dropRows = new Set<number>();
  for (const item of input.resolvedItems) {
    const row = input.rows[item] ?? null;
    if (row !== null) dropRows.add(row);
  }
  for (const item of input.fresh) {
    const row = input.rows[item.itemIndex] ?? null;
    if (row !== null) dropRows.add(row);
  }
  const kept = input.stored.filter((entry) => entry.row === null || !dropRows.has(entry.row));
  const taken = new Set(kept.map((entry) => entry.label));
  const added: SizeUnresolvedEntry[] = [];
  for (const item of input.fresh) {
    const row = input.rows[item.itemIndex] ?? null;
    let label: string;
    if (item.name !== null) label = item.name;
    else if (row !== null) label = `строка ${row}`;
    else label = `позиция ${item.itemIndex + 1} (пакет ${input.batchTag})`;
    if (taken.has(label)) {
      if (row === null) continue;
      label = `${label} (строка ${row})`;
      if (taken.has(label)) continue;
    }
    taken.add(label);
    added.push({ row, label });
  }
  return [...kept, ...added];
}
