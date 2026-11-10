/** Значение характеристики позиции из одного источника. */
export interface ItemValue {
  /** Позиция: артикул, а без него нормализованное название. */
  itemKey: string;
  field: string;
  value: string | number;
  /** Подпись источника для людей: «прайс s1», «письмо m-1», «сайт https://...». */
  source: string;
}

/** Расходящиеся значения одного поля позиции. Не усредняются: решает человек. */
export interface ItemConflict {
  itemKey: string;
  field: string;
  values: Array<{ value: string | number; sources: string[] }>;
}

function comparable(value: string | number): string {
  return typeof value === 'number'
    ? String(value)
    : value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/** Порядок значений в расхождении не зависит от порядка источников: числа, затем строки. */
function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Ключ позиции для сопоставления данных из разных источников. */
export function itemKeyOf(sku: string | undefined, name: string): string {
  const trimmed = sku?.trim() ?? '';
  return trimmed === '' ? `name:${comparable(name)}` : `sku:${comparable(trimmed)}`;
}

/**
 * Найти противоречия: одно поле одной позиции с разными значениями в разных источниках.
 * Чистая функция; порядок результата — по позиции и полю.
 */
export function findItemConflicts(values: readonly ItemValue[]): ItemConflict[] {
  const groups = new Map<string, ItemValue[]>();
  for (const item of values) {
    const key = JSON.stringify([item.itemKey, item.field]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const conflicts: ItemConflict[] = [];
  for (const group of groups.values()) {
    const byValue = new Map<string, { value: string | number; sources: string[] }>();
    for (const item of group) {
      const normal = comparable(item.value);
      const known = byValue.get(normal);
      if (known === undefined) byValue.set(normal, { value: item.value, sources: [item.source] });
      else if (!known.sources.includes(item.source)) known.sources.push(item.source);
    }
    const first = group[0];
    if (byValue.size > 1 && first !== undefined) {
      const values = [...byValue.values()]
        .map((entry) => ({ value: entry.value, sources: [...entry.sources].sort() }))
        .sort((a, b) => compareValues(a.value, b.value));
      conflicts.push({ itemKey: first.itemKey, field: first.field, values });
    }
  }
  return conflicts.sort(
    (a, b) => a.itemKey.localeCompare(b.itemKey) || a.field.localeCompare(b.field),
  );
}

/** Текст расхождения для людей: «price: 50 (прайс s1) / 55 (письмо m-1)». */
export function describeConflict(conflict: ItemConflict): string {
  const parts = conflict.values.map((entry) => `${entry.value} (${entry.sources.join(', ')})`);
  return `${conflict.field}: ${parts.join(' / ')}`;
}
