/** Запись истории импортов: файл с диска, из которого поставщик уже грузил прайс. */
export interface PriceFileImportRecord {
  supplierId: string;
  /** Путь файла на диске (как в `FileEntry.path`). */
  fileName: string;
}

/** Поставщик для сопоставления по имени. */
export interface SupplierNameRef {
  id: string;
  name: string;
}

/** Результат определения поставщика по пути файла. */
export type PriceFileSupplierMatch =
  | { kind: 'matched'; supplierId: string; by: 'history' | 'name' }
  | { kind: 'ambiguous'; supplierIds: string[] }
  | { kind: 'none' };

/** Минимальная длина нормализованного имени поставщика: короче - слишком много совпадений. */
const MIN_SUPPLIER_NAME_LENGTH = 4;

/** Организационно-правовые формы и служебные слова, не различающие поставщиков. */
const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'ооо',
  'ао',
  'пао',
  'оао',
  'зао',
  'нао',
  'ип',
  'тд',
  'тоо',
  'чп',
  'llc',
  'ltd',
  'inc',
]);

/** Всё, что не буква и не цифра (после приведения к нижнему регистру), - разделитель слов. */
const NON_WORD = /[^\p{L}\p{N}]+/gu;
/** Разделители сегментов пути. */
const PATH_SEPARATOR = /[\\/]+/;

/**
 * Нормализация имени для сравнения: нижний регистр, `ё` -> `е`, кавычки и пунктуация -> пробел,
 * юрформы (`ооо`, `ип`, ...) отброшены, пробелы схлопнуты.
 */
export function normalizeNameForPath(name: string): string {
  const cleaned = name.toLowerCase().replace(/ё/g, 'е').replace(NON_WORD, ' ');
  return cleaned
    .split(' ')
    .filter((token) => token !== '' && !LEGAL_FORM_TOKENS.has(token))
    .join(' ');
}

/** Сегменты пути в нормализованном виде: каталоги и имя файла без расширения. */
function pathSegments(path: string): string[] {
  const parts = path.split(PATH_SEPARATOR).filter((part) => part !== '');
  const last = parts.length - 1;
  return parts
    .map((part, index) => {
      if (index !== last) return part;
      const dot = part.lastIndexOf('.');
      return dot > 0 ? part.slice(0, dot) : part;
    })
    .map(normalizeNameForPath)
    .filter((segment) => segment !== '');
}

/** `needle` входит в `haystack` целыми словами (обе строки нормализованы). */
function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Определение поставщика по пути, построенное один раз (`createPriceFileSupplierMatcher`). */
export type PriceFileSupplierMatcher = (path: string) => PriceFileSupplierMatch;

/** Поставщик с нормализованным именем (элемент индекса по первому слову). */
interface NameEntry {
  id: string;
  name: string;
}

/**
 * Сопоставитель «путь файла -> поставщик» для обработки многих файлов за один запуск: история
 * импортов (`путь -> поставщики`) и нормализованные имена (`первое слово -> поставщики`)
 * строятся один раз, на файл остаётся работа по сегментам пути, а не по всей истории и всем
 * поставщикам. Результат тот же, что у `matchSupplierByPath`:
 *
 * 1. История импортов: записи с тем же путём. Один поставщик - `matched` (by `history`), разные -
 *    `ambiguous`.
 * 2. Имя: нормализованное имя поставщика (не короче `MIN_SUPPLIER_NAME_LENGTH`) входит целыми
 *    словами в нормализованный сегмент пути. Если имя одного совпавшего поставщика целиком
 *    входит в имя другого (`Альфа` и `Альфа Металл`), остаётся более длинное. Ровно один -
 *    `matched` (by `name`), несколько - `ambiguous`.
 * 3. Иначе `none`.
 */
export function createPriceFileSupplierMatcher(
  history: readonly PriceFileImportRecord[],
  suppliers: readonly SupplierNameRef[],
): PriceFileSupplierMatcher {
  const byPath = new Map<string, Set<string>>();
  for (const record of history) {
    const ids = byPath.get(record.fileName);
    if (ids === undefined) byPath.set(record.fileName, new Set([record.supplierId]));
    else ids.add(record.supplierId);
  }
  const byFirstWord = new Map<string, NameEntry[]>();
  for (const supplier of suppliers) {
    const name = normalizeNameForPath(supplier.name);
    if (name.length < MIN_SUPPLIER_NAME_LENGTH) continue;
    const firstWord = name.split(' ')[0] ?? '';
    const bucket = byFirstWord.get(firstWord);
    if (bucket === undefined) byFirstWord.set(firstWord, [{ id: supplier.id, name }]);
    else bucket.push({ id: supplier.id, name });
  }

  return (path) => {
    const fromHistory = uniqueSorted(byPath.get(path) ?? []);
    const [onlyHistory] = fromHistory;
    if (onlyHistory !== undefined) {
      return fromHistory.length === 1
        ? { kind: 'matched', supplierId: onlyHistory, by: 'history' }
        : { kind: 'ambiguous', supplierIds: fromHistory };
    }

    const candidates = new Map<string, NameEntry>();
    for (const segment of pathSegments(path)) {
      for (const word of new Set(segment.split(' '))) {
        for (const entry of byFirstWord.get(word) ?? []) {
          if (containsWords(segment, entry.name)) candidates.set(entry.id, entry);
        }
      }
    }
    const found = [...candidates.values()];
    const specific = found.filter(
      (a) => !found.some((b) => b.name !== a.name && containsWords(b.name, a.name)),
    );
    const ids = uniqueSorted(specific.map((candidate) => candidate.id));
    const [onlyName] = ids;
    if (onlyName === undefined) return { kind: 'none' };
    return ids.length === 1
      ? { kind: 'matched', supplierId: onlyName, by: 'name' }
      : { kind: 'ambiguous', supplierIds: ids };
  };
}

/**
 * Определить поставщика прайс-файла по пути (один файл; для многих файлов - один раз
 * `createPriceFileSupplierMatcher`). Правила - в описании сопоставителя.
 */
export function matchSupplierByPath(
  path: string,
  history: readonly PriceFileImportRecord[],
  suppliers: readonly SupplierNameRef[],
): PriceFileSupplierMatch {
  return createPriceFileSupplierMatcher(history, suppliers)(path);
}
