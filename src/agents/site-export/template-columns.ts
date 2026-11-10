import type { TemplateCellValue, TemplateHeader } from '@business-ai/core';

/**
 * Правила про колонки шаблона заказчика. Колонки находятся по тексту заголовка и заливке из
 * файла, а не по буквам: у другой версии шаблона буквы могут сместиться.
 */

/** Роль колонки в правилах владельца. */
export type ColumnRole =
  /** «Оператор» (AI): не меняется никогда. */
  | 'operator'
  /** «Месяц первичной загрузки» (AF): по умолчанию не заполняется. */
  | 'first_load'
  /** «Менеджер» (AD): имя сотрудника из разрешения личности. */
  | 'manager'
  /** «Последняя корректировка» (AE): текущая дата. */
  | 'last_correction'
  | 'plain';

const OPERATOR_HEADER = /^\s*оператор/i;
const FIRST_LOAD_HEADER = /первичной\s+загрузки/i;
const MANAGER_HEADER = /^\s*менеджер/i;
const LAST_CORRECTION_HEADER = /последн\S*\s+корректировк/i;
const NAME_HEADER = /^\s*название/i;
const SKU_HEADER = /^\s*артикул/i;
const PRICE_RANGE_HEADER = /^\s*по\s+цене/i;

/** Роль колонки по тексту заголовка. */
export function columnRole(header: Pick<TemplateHeader, 'text'>): ColumnRole {
  const text = header.text;
  if (OPERATOR_HEADER.test(text)) return 'operator';
  if (FIRST_LOAD_HEADER.test(text)) return 'first_load';
  if (MANAGER_HEADER.test(text)) return 'manager';
  if (LAST_CORRECTION_HEADER.test(text)) return 'last_correction';
  return 'plain';
}

/** Колонка свободного текста с проверками кода (этап 225). */
export type TextColumnKind = 'description' | 'size';

/** «Описание» словом целиком: «Описание», «Описание / Легенда»; не «Описания» и не «Описанием». */
const DESCRIPTION_HEADER = /^\s*описание(?![а-яёa-z])/i;
/** «Размер упаковки ...» - основной признак размера. */
const SIZE_HEADER = /^\s*размер\s+упаковк/i;
/** Запасной признак размера: подсказка формата «(ш-в-г)» в шапке без слов «Размер упаковки». */
const SIZE_HINT_HEADER = /ш\s*[-x×х*]\s*в\s*[-x×х*]\s*г/i;

/** Роли текстовых колонок по шапке книги. */
export interface TextColumnKinds {
  /** Буква колонки -> вид; только однозначные. */
  kinds: Map<string, TextColumnKind>;
  /** Виды, которым подходит несколько колонок: роль не назначена никому, проверок нет. */
  ambiguous: TextColumnKind[];
}

/**
 * Роли колонок «Описание ...» (предел длины) и «Размер упаковки ...» (единица из шапки) по
 * строке шапки книги. Колонка получает роль, только если подходит ЕДИНСТВЕННАЯ колонка вида:
 * две «Описание ...» или две «Размер упаковки ...» - неоднозначность, ролей нет (угадывать, где
 * предел 1500 знаков, нельзя). Подсказка «(ш-в-г)» работает, только когда колонок «Размер
 * упаковки» в шапке нет. Отдельно от `columnRole`: роль в правилах владельца не меняется.
 */
export function textColumnKinds(headers: readonly TemplateHeader[]): TextColumnKinds {
  const kinds = new Map<string, TextColumnKind>();
  const ambiguous: TextColumnKind[] = [];
  const pick = (kind: TextColumnKind, found: readonly TemplateHeader[]): void => {
    const [only] = found;
    if (found.length === 1 && only !== undefined) kinds.set(only.letter, kind);
    else if (found.length > 1) ambiguous.push(kind);
  };
  pick(
    'description',
    headers.filter((header) => DESCRIPTION_HEADER.test(header.text)),
  );
  const primary = headers.filter((header) => SIZE_HEADER.test(header.text));
  pick(
    'size',
    primary.length > 0
      ? primary
      : headers.filter((header) => SIZE_HINT_HEADER.test(header.text)),
  );
  return { kinds, ambiguous };
}

/** Колонка «Название» / «Артикул» / «по цене» по тексту заголовка. */
export function findHeader(
  headers: readonly TemplateHeader[],
  kind: 'name' | 'sku' | 'price_range',
): TemplateHeader | undefined {
  const pattern =
    kind === 'name' ? NAME_HEADER : kind === 'sku' ? SKU_HEADER : PRICE_RANGE_HEADER;
  return headers.find((header) => pattern.test(header.text));
}

/** Колонка с заданной ролью. */
export function findByRole(
  headers: readonly TemplateHeader[],
  role: ColumnRole,
): TemplateHeader | undefined {
  return headers.find((header) => columnRole(header) === role);
}

/** Текст для сравнения: без регистра, лишних пробелов и неразрывных пробелов. */
export function normalizeText(value: string | number): string {
  return String(value).replace(/[\s ]+/g, ' ').trim().toLowerCase();
}

/** Короче этого имя колонки по началу или вхождению не ищется (только точно или буквой). */
const PARTIAL_NAME_MIN_CHARS = 2;
const LETTERS_ONLY = /^[A-Za-z]{1,3}$/;

/** Результат поиска колонки по имени, которое назвала модель. */
export type ColumnLookup =
  | { status: 'ok'; header: TemplateHeader }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: string[] };

/**
 * Найти колонку по имени: точный заголовок, затем буква, затем единственный заголовок, где имя
 * встречается в начале или внутри. Несколько подходящих - `ambiguous`: угадывать нельзя.
 */
export function lookupColumn(headers: readonly TemplateHeader[], raw: string): ColumnLookup {
  const wanted = normalizeText(raw);
  if (wanted === '') return { status: 'not_found' };
  const exact = headers.filter((header) => normalizeText(header.text) === wanted);
  if (exact.length === 1 && exact[0] !== undefined) return { status: 'ok', header: exact[0] };
  if (LETTERS_ONLY.test(raw.trim())) {
    const letter = raw.trim().toUpperCase();
    const byLetter = headers.find((header) => header.letter === letter);
    if (byLetter !== undefined) return { status: 'ok', header: byLetter };
  }
  // Одна буква - не название: «Д» не должна молча совпасть с «Дополнительная информация».
  if (wanted.length < PARTIAL_NAME_MIN_CHARS) return { status: 'not_found' };
  const starts = headers.filter((header) => normalizeText(header.text).startsWith(wanted));
  const pool =
    starts.length > 0
      ? starts
      : headers.filter((header) => normalizeText(header.text).includes(wanted));
  if (pool.length === 1 && pool[0] !== undefined) return { status: 'ok', header: pool[0] };
  if (pool.length === 0) return { status: 'not_found' };
  return { status: 'ambiguous', candidates: pool.map((header) => header.text) };
}

/** Значение списка, совпавшее с введённым без учёта регистра и пробелов; иначе null. */
export function matchListValue(
  allowed: readonly TemplateCellValue[],
  value: string | number,
): TemplateCellValue | null {
  const wanted = normalizeText(value);
  return allowed.find((item) => normalizeText(item) === wanted) ?? null;
}

/** Сколько допустимых значений показываем в подсказке. */
export const LIST_HINT_LIMIT = 10;

/** Подсказка: ближайшие по тексту значения списка, затем начало списка. */
export function listHints(
  allowed: readonly TemplateCellValue[],
  value: string | number,
): TemplateCellValue[] {
  const wanted = normalizeText(value);
  const near = allowed.filter((item) => {
    const text = normalizeText(item);
    return wanted !== '' && (text.includes(wanted) || wanted.includes(text));
  });
  const rest = allowed.filter((item) => !near.includes(item));
  return [...near, ...rest].slice(0, LIST_HINT_LIMIT);
}

/** Ячейка пуста: нет значения или одни пробелы. */
export function isBlank(value: string | number | boolean | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}
