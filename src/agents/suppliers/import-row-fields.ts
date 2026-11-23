import {
  DOCUMENT_FLOW_LABELS,
  DOCUMENT_FLOWS,
  PACKAGING_KIND_LABELS,
  PACKAGING_KINDS,
  PACKAGING_PRICING_LABELS,
  PACKAGING_PRICINGS,
  SUPPLIER_KIND_LABELS,
  SUPPLIER_KINDS,
  TRAINING_FORMAT_LABELS,
  TRAINING_FORMATS,
  type MaterialKind,
} from '../../kit/domain/supplier-card-full';
import {
  normalizeOkved,
  parseDiscountPercent,
  parsePackagingKind,
  parseTurnoverByYear,
  parseTurnoverRub,
  parseVat,
} from '../../kit/domain/supplier-card-values';
import type { SupplierCardFields } from './card-fields';
import type { SupplierColumnKey, SupplierTemplateColumn } from './supplier-template';
import { SUPPLIER_TEMPLATE_COLUMNS } from './supplier-template';

/**
 * Разбор колонок шаблона, добавленных по разделу 10 ТЗ (все, кроме названия, ИНН, сайта,
 * статуса, контакта, категорий, брендов, регионов, условий и заметки). Файл разбирает код, без
 * модели. Замечания не содержат значений ячеек: только название колонки.
 */

/** Значение ячейки по ключу колонки: пусто - undefined. */
export type CellGetter = (key: SupplierColumnKey) => string | undefined;

/** Результат: поля карточки из этих колонок и замечания по ним. */
export interface ExtraRowFields {
  fields: Partial<SupplierCardFields>;
  issues: string[];
}

/** Ключи колонок -> поля карточки с тем же названием (текстовые, без разбора). */
const PLAIN_TEXT_KEYS = [
  'logoRef',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
  'minOrderAmount',
  'samplesTerms',
  'paymentNotes',
  'freeDelivery',
  'contractNotes',
  'technicalRequirements',
  'pragmatikaPortfolio',
  'productionCity',
  'address',
  'transportInfo',
  'marketingSupport',
  'exclusivity',
  'designServices',
  'additionalServices',
  'strengths',
  'weaknesses',
  'claimsHandling',
  'competitiveAdvantages',
  'customers',
] as const satisfies readonly (SupplierColumnKey & keyof SupplierCardFields)[];

/** Подсказки о формате для замечаний по колонкам с разбором значения (без самого значения). */
const FORMAT_HINTS: Partial<Record<SupplierColumnKey, string>> = {
  agencyDiscount: 'ожидается процент от 0 до 100, например 5 или 5,5%.',
  vat: 'ожидается ставка числом (например 20 или 22%) либо «без НДС» / «УСН».',
  turnover:
    'ожидается «год: сумма» через «;», например 2025: 150 млн; 2024: 120 млн; ' +
    '2023: 100 млн (или одна сумма в рублях).',
  okved: 'ожидается код ОКВЭД 2, например 32.99 или 47.19.1.',
  packaging: 'ожидается одно значение: нет, транспортная или подарочная.',
};

/** Целые числа в ячейках: год основания, образцы, численность. */
const INTEGER_KEYS = [
  'foundedYear',
  'samplesQuantity',
  'employeeCount',
] as const satisfies readonly (SupplierColumnKey & keyof SupplierCardFields)[];

/** Да/нет в ячейках. */
const BOOLEAN_KEYS = [
  'samplesAvailable',
  'hasOwnDesigners',
  'hasQualityControl',
] as const satisfies readonly (SupplierColumnKey & keyof SupplierCardFields)[];

const YES_WORDS: readonly string[] = ['да', 'yes', 'true', '1', '+', 'есть'];
const NO_WORDS: readonly string[] = ['нет', 'no', 'false', '0', '-', 'нету'];
const INTEGER_PATTERN = /^\d+$/;
/** Пробелы внутри числа («1 200») и неразрывные пробелы. */
const NUMBER_SPACES = /[\s ]/g;
/** Разделители пунктов: точка с запятой и перевод строки (запятая бывает в названиях). */
const ITEM_SPLIT = /[;\n]+/;
const LIST_SPLIT = /[;,\n]+/;
/** ИНН в конце записи организации: 10 или 12 цифр, перед ними не цифра (без вложенных `*`). */
const INN_AT_END = /(?<!\d)(\d{12}|\d{10})$/;
/** Знаки между названием и ИНН: пробелы, скобка, запятая, двоеточие, номер, дефис. */
const NAME_TAIL_CHARS = /[\s,:(№-]/u;
/** Слово «ИНН» перед номером, регистр не важен. */
const INN_WORD = 'инн';
/**
 * Предел длины пункта-организации. Реальные названия короче; длинную строку (в том числе из
 * одних пробелов) не разбираем, чтобы разбор не зависел от ввода.
 */
const ENTITY_ITEM_MAX_LENGTH = 300;

const foldWord = (value: string): string => value.trim().toLowerCase().replaceAll('ё', 'е');

function headerOf(key: SupplierColumnKey): string {
  const found: SupplierTemplateColumn | undefined = SUPPLIER_TEMPLATE_COLUMNS.find(
    (item) => item.key === key,
  );
  return found === undefined ? 'поле' : found.header.replace('*', '');
}

/** Значение перечисления по коду или подписи; нет совпадения - 'unknown'. */
function enumOf<K extends string>(
  value: string,
  codes: readonly K[],
  labels: Readonly<Record<K, string>>,
): K | 'unknown' {
  const wanted = foldWord(value);
  return codes.find((code) => code === wanted || foldWord(labels[code]) === wanted) ?? 'unknown';
}

function splitItems(value: string, pattern: RegExp): string[] {
  return value
    .split(pattern)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Название без хвоста из разделителей и слова «ИНН» (линейный проход, без регулярки). */
function trimNameTail(head: string): string {
  let end = head.length;
  for (;;) {
    while (end > 0 && NAME_TAIL_CHARS.test(head.charAt(end - 1))) end -= 1;
    const word = head.slice(Math.max(0, end - INN_WORD.length), end).toLowerCase();
    const before = end > INN_WORD.length ? head.charAt(end - INN_WORD.length - 1) : ' ';
    // «инн» отбрасывается только как отдельное слово: «Ларинн» остаётся названием.
    if (word !== INN_WORD || !NAME_TAIL_CHARS.test(before)) return head.slice(0, end);
    end -= INN_WORD.length;
  }
}

/** Организация из записи «Название ИНН»: ИНН - последняя группа из 10 или 12 цифр. */
function parseEntity(item: string): { name: string; inn?: string } {
  const text = item.trim();
  if (text.length > ENTITY_ITEM_MAX_LENGTH) return { name: text };
  const body = text.endsWith(')') ? text.slice(0, -1) : text;
  const match = INN_AT_END.exec(body);
  const inn = match?.[1];
  if (match === null || inn === undefined) return { name: text };
  const name = trimNameTail(body.slice(0, match.index)).trim();
  return name === '' ? { name: text } : { name, inn };
}

/** Ссылки колонки в материалы указанного вида. */
function materialsOf(
  value: string | undefined,
  kind: MaterialKind,
): Array<{ kind: MaterialKind; ref: string }> {
  return value === undefined ? [] : splitItems(value, ITEM_SPLIT).map((ref) => ({ kind, ref }));
}

/** Процент: допускает запятую и знак «%». */
function percentOf(value: string): number {
  return Number(value.replace('%', '').replace(',', '.').replace(NUMBER_SPACES, ''));
}

/**
 * Прочитать колонки раздела 10 одной строки. Неверное значение даёт замечание с названием
 * колонки и в поля не попадает; пустая ячейка означает «не указано».
 */
export function parseExtraRowFields(get: CellGetter): ExtraRowFields {
  const fields: Record<string, unknown> = {};
  const issues: string[] = [];
  const bad = (key: SupplierColumnKey): void => {
    const hint = FORMAT_HINTS[key];
    issues.push(
      `Колонка «${headerOf(key)}»: значение не распознано${hint === undefined ? '.' : `, ${hint}`}`,
    );
  };
  for (const key of PLAIN_TEXT_KEYS) {
    const value = get(key);
    if (value !== undefined) fields[key] = value;
  }
  for (const key of INTEGER_KEYS) {
    const value = get(key)?.replace(NUMBER_SPACES, '');
    if (value === undefined) continue;
    if (INTEGER_PATTERN.test(value)) fields[key] = Number(value);
    else bad(key);
  }
  for (const key of BOOLEAN_KEYS) {
    const value = get(key);
    if (value === undefined) continue;
    const word = foldWord(value);
    if (YES_WORDS.includes(word)) fields[key] = true;
    else if (NO_WORDS.includes(word)) fields[key] = false;
    else bad(key);
  }
  const percent = get('defectRatePercent');
  if (percent !== undefined) {
    const number = percentOf(percent);
    if (Number.isFinite(number)) fields['defectRatePercent'] = number;
    else bad('defectRatePercent');
  }
  const discount = get('agencyDiscount');
  if (discount !== undefined) {
    const parsed = parseDiscountPercent(discount);
    if (parsed.ok) fields['agencyDiscountPercent'] = parsed.value;
    else bad('agencyDiscount');
  }
  const vat = get('vat');
  if (vat !== undefined) {
    const parsed = parseVat(vat);
    if (parsed.ok) {
      fields['vatMode'] = parsed.mode;
      if (parsed.ratePercent !== undefined) fields['vatRatePercent'] = parsed.ratePercent;
    } else {
      bad('vat');
    }
  }
  const turnover = get('turnover');
  if (turnover !== undefined) {
    // Сначала «год: сумма» (оборот по годам, разд. 10.9), затем прежняя запись одной суммой.
    const byYear = parseTurnoverByYear(turnover);
    const parsed = byYear.ok ? undefined : parseTurnoverRub(turnover);
    if (byYear.ok) fields['turnoverByYear'] = byYear.years;
    else if (parsed?.ok === true) fields['turnoverRub'] = parsed.value;
    else bad('turnover');
  }
  const okved = get('okved');
  if (okved !== undefined) {
    const parsed = normalizeOkved(okved);
    if (parsed.ok) fields['okved'] = parsed.code;
    else bad('okved');
  }
  const enums = [
    ['supplierKind', SUPPLIER_KINDS, SUPPLIER_KIND_LABELS],
    ['documentFlow', DOCUMENT_FLOWS, DOCUMENT_FLOW_LABELS],
    ['packaging', PACKAGING_KINDS, PACKAGING_KIND_LABELS],
    ['packagingPricing', PACKAGING_PRICINGS, PACKAGING_PRICING_LABELS],
  ] as const;
  for (const [key, codes, labels] of enums) {
    const value = get(key);
    if (value === undefined) continue;
    const code = enumOf(value, codes as readonly string[], labels as Record<string, string>);
    if (code !== 'unknown') {
      fields[key] = code;
      continue;
    }
    // Прежние записи упаковки словами («подарочная упаковка», «без упаковки»).
    const legacy = key === 'packaging' ? parsePackagingKind(value) : undefined;
    if (legacy?.status === 'ok') fields[key] = legacy.kind;
    else bad(key);
  }
  const training = get('trainingFormats');
  if (training !== undefined) {
    const codes = splitItems(training, LIST_SPLIT).map((item) =>
      enumOf(item, TRAINING_FORMATS, TRAINING_FORMAT_LABELS),
    );
    if (codes.includes('unknown')) bad('trainingFormats');
    else fields['trainingFormats'] = codes;
  }
  for (const key of ['technologies', 'personalizationTypes'] as const) {
    const value = get(key);
    if (value !== undefined) fields[key] = splitItems(value, LIST_SPLIT);
  }
  const entities = get('legalEntities');
  if (entities !== undefined) {
    fields['legalEntities'] = splitItems(entities, ITEM_SPLIT).map(parseEntity);
  }
  const materials = [
    ...materialsOf(get('presentations'), 'presentation'),
    ...materialsOf(get('portfolioLinks'), 'portfolio'),
  ];
  if (materials.length > 0) fields['materials'] = materials;
  return { fields: fields as Partial<SupplierCardFields>, issues };
}

/** Поле карточки -> колонка шаблона: для замечаний схемы (названия различаются у контакта). */
export function columnKeyOfField(field: string): SupplierColumnKey | undefined {
  const renamed: Record<string, SupplierColumnKey> = {
    fullName: 'contactName',
    position: 'contactPosition',
    presentations: 'presentations',
    materials: 'presentations',
  };
  const direct = SUPPLIER_TEMPLATE_COLUMNS.find((column) => column.key === field);
  return direct?.key ?? renamed[field];
}
