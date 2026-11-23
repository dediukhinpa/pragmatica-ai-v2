import type { DealDocument, FieldSource } from './models';
import { REQUISITE_LABELS, type RequisiteField } from './requisites';
import { warningIssue } from '@business-ai/core';
import type { ValidationIssue } from '@business-ai/core';

/** Разделитель частей пути поля документа: `lines.0.quantity`. */
const PATH_SEPARATOR = '.';

/** Названия скалярных полей документа для сообщений людям. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  buyer: 'покупатель',
  seller: 'продавец',
  number: 'номер документа',
  issuedAt: 'дата документа',
  dueDate: 'срок оплаты',
  paymentTerms: 'условия оплаты',
  deliveryDays: 'срок поставки, дней',
  total: 'итого',
  vatRate: 'ставка НДС',
  vatAmount: 'сумма НДС',
};
const LINE_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'название',
  quantity: 'количество',
  unitPrice: 'цена',
  unit: 'единица',
  deliveryDays: 'срок поставки',
  sum: 'сумма строки',
};

/** Названия источников для чек-листа и сообщений. */
export const FIELD_SOURCE_LABELS: Readonly<Record<FieldSource, string>> = {
  employee: 'сотрудник (чат)',
  knowledge: 'база знаний',
  web: 'интернет',
};

/**
 * Пути существенных полей документа: стороны, реквизиты, позиции, количества, цены, суммы,
 * сроки, условия оплаты и поставки. Только заполненные необязательные поля.
 */
export function documentFieldPaths(doc: DealDocument): string[] {
  const paths = ['buyer', 'seller', 'total'];
  const optional: Array<[string, unknown]> = [
    ['dueDate', doc.dueDate],
    ['paymentTerms', doc.paymentTerms],
    ['deliveryDays', doc.deliveryDays],
    ['vatRate', doc.vatRate],
    ['vatAmount', doc.vatAmount],
  ];
  for (const [path, value] of optional) if (value !== undefined) paths.push(path);
  for (const [field, value] of Object.entries(doc.requisites ?? {})) {
    if (value.trim() !== '') paths.push(`requisites${PATH_SEPARATOR}${field}`);
  }
  for (const [field, value] of Object.entries(doc.templateFields ?? {})) {
    if (value.trim() !== '') paths.push(`templateFields${PATH_SEPARATOR}${field}`);
  }
  doc.lines.forEach((line, index) => {
    const prefix = `lines${PATH_SEPARATOR}${index}${PATH_SEPARATOR}`;
    paths.push(`${prefix}name`, `${prefix}quantity`, `${prefix}unitPrice`);
    if (line.unit !== undefined) paths.push(`${prefix}unit`);
    if (line.deliveryDays !== undefined) paths.push(`${prefix}deliveryDays`);
    if (line.sum !== undefined) paths.push(`${prefix}sum`);
  });
  return paths;
}

/** Значение по пути поля (для показа сотруднику); undefined, если пути нет. */
function valueAtPath(doc: DealDocument, path: string): string | undefined {
  const parts = path.split(PATH_SEPARATOR);
  const [head, second, third] = parts;
  if (head === 'requisites' && second !== undefined) return doc.requisites?.[second];
  if (head === 'templateFields' && second !== undefined) return doc.templateFields?.[second];
  if (head === 'lines' && second !== undefined && third !== undefined) {
    const line = doc.lines[Number(second)] as Record<string, unknown> | undefined;
    const value = line?.[third];
    return value === undefined ? undefined : String(value);
  }
  const value = (doc as unknown as Record<string, unknown>)[path];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** Человекочитаемое описание поля со значением: «ИНН поставщика = 7707083893». */
export function describeFieldPath(doc: DealDocument | undefined, path: string): string {
  const [head, second, third] = path.split(PATH_SEPARATOR);
  let label = FIELD_LABELS[path] ?? path;
  if (head === 'requisites' && second !== undefined) {
    const known = REQUISITE_LABELS[second as RequisiteField];
    label = `${known ?? second} (реквизит поставщика)`;
  } else if (head === 'templateFields' && second !== undefined) {
    label = `поле шаблона «${second}»`;
  } else if (head === 'lines' && second !== undefined && third !== undefined) {
    const ordinal = Number(second) + 1;
    label = `позиция ${ordinal}: ${LINE_FIELD_LABELS[third] ?? third}`;
  }
  const value = doc === undefined ? undefined : valueAtPath(doc, path);
  return value === undefined ? label : `${label} = ${value}`;
}

/** Ближайшая отметка: сам путь, затем родители (`lines.0.name` -> `lines.0` -> `lines`). */
function lookup<T>(map: Readonly<Record<string, T>> | undefined, path: string): T | undefined {
  if (map === undefined) return undefined;
  let current = path;
  for (;;) {
    const found = map[current];
    if (found !== undefined) return found;
    const cut = current.lastIndexOf(PATH_SEPARATOR);
    if (cut < 0) return undefined;
    current = current.slice(0, cut);
  }
}

/** Источник поля документа; undefined, если отметки нет. */
export function fieldSourceOf(doc: DealDocument, path: string): FieldSource | undefined {
  return lookup(doc.fieldSources, path);
}

/** Существенные поля без отметки источника. */
function fieldsWithoutSource(doc: DealDocument): string[] {
  return documentFieldPaths(doc).filter((path) => fieldSourceOf(doc, path) === undefined);
}

/**
 * Поля, взятые из интернета: отмеченные моделью как web и поля, чьё значение код опознал как
 * пришедшее из веб-поиска этого треда (`matched`), что бы ни отметила модель.
 */
export function webFieldPaths(
  doc: DealDocument,
  matched: ReadonlySet<string> = new Set(),
): string[] {
  return documentFieldPaths(doc).filter(
    (path) => fieldSourceOf(doc, path) === 'web' || matched.has(path),
  );
}

/** Минимальная длина значения (в значимых знаках) для сверки с текстом веб-поиска. */
const WEB_MATCH_MIN_CHARS = 5;

/** Значение для сверки: нижний регистр, пробелы схлопнуты. */
export function normalizeForWebMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Поля документа, значение которых встречается в тексте результатов веб-поиска этого треда.
 * Короткие значения (количества, ставки) не сверяются: совпадение случайно. Модель могла
 * пометить такое поле как employee или knowledge: код считает его веб-полем.
 */
export function webMatchedPaths(doc: DealDocument, normalizedWebText: string): string[] {
  if (normalizedWebText === '') return [];
  return documentFieldPaths(doc).filter((path) => {
    const value = valueAtPath(doc, path);
    if (value === undefined) return false;
    const needle = normalizeForWebMatch(value);
    const significant = needle.replace(/\s/gu, '').length;
    return significant >= WEB_MATCH_MIN_CHARS && normalizedWebText.includes(needle);
  });
}

/**
 * Каноническая подпись значений веб-полей: меняется при смене пути или значения. Подтверждение
 * сотрудника привязывается к её отпечатку.
 */
export function webValuesSignature(doc: DealDocument, paths: readonly string[]): string {
  const pairs = [...paths].sort().map((path) => [path, valueAtPath(doc, path) ?? ''] as const);
  return JSON.stringify(pairs);
}

/** Название поля без значения (для замечаний и ошибок: значения реквизитов в них не попадают). */
export function fieldLabelOf(path: string): string {
  return describeFieldPath(undefined, path);
}

/** Сколько полей без источника перечисляем в сообщении. */
const SOURCE_EXAMPLES = 8;

/** Замечания: у существенных полей нет отметки источника (employee | knowledge | web). */
export function checkFieldSources(doc: DealDocument): ValidationIssue[] {
  const missing = fieldsWithoutSource(doc);
  if (missing.length === 0) return [];
  const shown = missing.slice(0, SOURCE_EXAMPLES).join(', ');
  const rest = missing.length - SOURCE_EXAMPLES;
  return [
    // Отметка источника - подсказка для проверяющего, а не повод не выдавать документ:
    // подтверждение веб-значений (D17) от неё не зависит и остаётся блокирующим.
    warningIssue(
      'field_source_missing',
      `Не указан источник (fieldSources: employee, knowledge или web) у полей: ${shown}` +
        `${rest > 0 ? ` и ещё ${rest}` : ''}.`,
    ),
  ];
}

/** Сколько полей перечисляем в замечании о веб-данных. */
const WEB_ISSUE_EXAMPLES = 10;

/**
 * Поля из интернета без подтверждения сотрудника кнопкой: предупреждение, документ собирается
 * (решение владельца 03.11: у сотрудника нет ограничений, только предупреждения). Подтверждение
 * `confirmed` определяет код по состоянию кнопки, не модель. В тексте только имена полей:
 * значения (реквизиты) в замечания не попадают, их сотруднику показывает сообщение с кнопкой.
 */
export function checkWebConfirmation(
  webPaths: readonly string[],
  confirmed: 'confirmed' | 'rejected' | 'unconfirmed',
): ValidationIssue[] {
  if (webPaths.length === 0 || confirmed === 'confirmed') return [];
  const shown = webPaths.slice(0, WEB_ISSUE_EXAMPLES).map((path) => fieldLabelOf(path));
  const rest = webPaths.length - shown.length;
  const list = `${shown.join('; ')}${rest > 0 ? ` и ещё ${rest}` : ''}`;
  if (confirmed === 'rejected') {
    return [
      warningIssue(
        'web_fields_rejected',
        `Сотрудник не подтвердил данные из интернета (поля: ${list}). Они внесены в ` +
          'документ как есть: проверьте их по первичным документам.',
      ),
    ];
  }
  return [
    warningIssue(
      'web_fields_unconfirmed',
      `Взято из интернета (поля: ${list}) и не подтверждено кнопкой: проверьте эти поля по ` +
        'первичным документам.',
    ),
  ];
}
