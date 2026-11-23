import { SUPPLIER_FULL_KEYS } from '../../kit/domain/supplier-card-full';
import {
  normalizeSupplierCard,
  type SupplierCard,
  type SupplierTerms,
} from '../../kit/domain/supplier-card';
import { cardFromFields, type SupplierCardFields } from './card-fields';

/**
 * Расхождения сведений источника с карточкой (этап 218). Обогащение пишет только пустые поля;
 * если поле карточки уже заполнено другим значением, источник не прав и не неправ - решает
 * сотрудник, поэтому расхождение возвращается списком и не записывается.
 */

/** Расхождение: поле, значение в карточке и значение источника (для вопроса сотруднику). */
export interface EnrichmentConflict {
  field: string;
  current: string;
  proposed: string;
}

/** Простые поля карточки, у которых значение источника может расходиться с записанным. */
const SCALAR_KEYS = [
  'inn',
  'website',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
  'productionCity',
  'address',
  'strengths',
  'weaknesses',
  'defectRatePercent',
  ...SUPPLIER_FULL_KEYS,
] as const;

const TERM_KEYS: ReadonlyArray<keyof SupplierTerms> = [
  'payment',
  'delivery',
  'minBatch',
  'leadTime',
  'discounts',
];

/** Предел значения в расхождении: хватает, чтобы показать суть, не раздувая ответ модели. */
const MAX_SHOWN_LENGTH = 200;

/** Пустой контекст сборки: для приведения полей источника к виду карточки. */
const PROBE = { userId: '', nowIso: '', source: 'chat' } as const;

/** Хост сайта без протокола, пути и «www.»: «example.ru/shop» и «https://www.example.ru» равны. */
function siteKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** Текст для сравнения: регистр, пробелы и знаки препинания не различают значения. */
function textKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.slice(0, MAX_SHOWN_LENGTH);
}

/** Совпадают ли значения поля карточки (по правилам сравнения расхождений). */
export function sameValue(key: string, current: unknown, proposed: unknown): boolean {
  if (typeof current === 'string' && typeof proposed === 'string') {
    return key === 'website'
      ? siteKey(current) === siteKey(proposed)
      : textKey(current) === textKey(proposed);
  }
  if (Array.isArray(current) && Array.isArray(proposed)) {
    // Список источника, целиком входящий в записанный, ничего не меняет.
    const known = new Set(current.map((item: unknown) => JSON.stringify(item)));
    return proposed.every((item: unknown) => known.has(JSON.stringify(item)));
  }
  return JSON.stringify(current) === JSON.stringify(proposed);
}

/**
 * Поля источника, которые уже заполнены в карточке другим значением. Пустые поля карточки
 * расхождением не считаются (их заполнит обогащение).
 */
export function findEnrichmentConflicts(
  card: SupplierCard,
  fields: SupplierCardFields,
): EnrichmentConflict[] {
  const proposed = normalizeSupplierCard(cardFromFields(fields, PROBE, 'probe'));
  const current = normalizeSupplierCard(card);
  const result: EnrichmentConflict[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ...SCALAR_KEYS.map((key): [string, unknown, unknown] => [
      key,
      (current as unknown as Record<string, unknown>)[key],
      (proposed as unknown as Record<string, unknown>)[key],
    ]),
    ...TERM_KEYS.map((key): [string, unknown, unknown] => [
      `terms.${key}`,
      current.terms[key],
      proposed.terms[key],
    ]),
  ];
  for (const [field, was, wanted] of pairs) {
    if (was === undefined || wanted === undefined) continue;
    if (!sameValue(field, was, wanted)) {
      result.push({ field, current: shown(was), proposed: shown(wanted) });
    }
  }
  return result;
}
