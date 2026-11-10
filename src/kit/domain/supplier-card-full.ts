import { z } from 'zod';
import { isValidInn } from './requisites';
import {
  MAX_PERCENT,
  MAX_TURNOVER_RUB,
  MIN_PERCENT,
  OKVED_PATTERN,
  VAT_MODES,
  normalizeOkved,
  roundPercent,
  roundRubles,
  type VatMode,
} from './supplier-card-values';
import type { ValidationIssue } from '@business-ai/core';

/**
 * Полная структура карточки поставщика по разделам 10.1-10.9 ТЗ заказчика (миграция 024).
 * Все поля необязательные: у карточек, созданных раньше, их нет, и они читаются как раньше.
 * Пределы длины совпадают с CHECK миграции 024. Логотип и презентации хранятся ссылкой на
 * файл в базе знаний, а не самим файлом. Тексты замечаний значений полей не содержат.
 */

/** Вид поставщика (разд. 10.1): что делает с продукцией. */
export const SUPPLIER_KINDS = [
  'production_only',
  'production_and_branding',
  'branding_only',
] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];
export const SUPPLIER_KIND_LABELS: Readonly<Record<SupplierKind, string>> = {
  production_only: 'только изготавливает',
  production_and_branding: 'изготавливает и наносит',
  branding_only: 'только наносит',
};

/** Документооборот (разд. 10.5): через ЭДО или нет. */
export const DOCUMENT_FLOWS = ['edo', 'none'] as const;
export type DocumentFlow = (typeof DOCUMENT_FLOWS)[number];
export const DOCUMENT_FLOW_LABELS: Readonly<Record<DocumentFlow, string>> = {
  edo: 'ЭДО',
  none: 'нет',
};

/** Наличие упаковки (разд. 10.6): нет, транспортная или подарочная. */
export const PACKAGING_KINDS = ['none', 'transport', 'gift'] as const;
export type PackagingKind = (typeof PACKAGING_KINDS)[number];
export const PACKAGING_KIND_LABELS: Readonly<Record<PackagingKind, string>> = {
  none: 'нет',
  transport: 'транспортная',
  gift: 'подарочная',
};

/** Упаковка входит в стоимость или предусмотрен отдельный прайс (разд. 10.6). */
export const PACKAGING_PRICINGS = ['included', 'separate_price'] as const;
export type PackagingPricing = (typeof PACKAGING_PRICINGS)[number];
export const PACKAGING_PRICING_LABELS: Readonly<Record<PackagingPricing, string>> = {
  included: 'входит в стоимость',
  separate_price: 'отдельный прайс',
};

/** Форматы обучения менеджеров (разд. 10.8). */
export const TRAINING_FORMATS = ['online', 'offline'] as const;
export type TrainingFormat = (typeof TRAINING_FORMATS)[number];
export const TRAINING_FORMAT_LABELS: Readonly<Record<TrainingFormat, string>> = {
  online: 'онлайн',
  offline: 'офлайн',
};

/** Вид материала поставщика (разд. 10.6): презентация или портфолио. */
export const MATERIAL_KINDS = ['presentation', 'portfolio'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export const MATERIAL_KIND_LABELS: Readonly<Record<MaterialKind, string>> = {
  presentation: 'презентация',
  portfolio: 'портфолио',
};

/** Пределы длины и числа записей (совпадают с CHECK в миграции 024). */
export const MAX_REF_LENGTH = 500;
export const MAX_FULL_TERM_LENGTH = 300;
export const MAX_FULL_TEXT_LENGTH = 1000;
export const MAX_FULL_LONG_TEXT_LENGTH = 2000;
/** Длина каноничного ОКВЭД `NN.NN.NN`; на входе допустима запись длиннее (с названием). */
export const MAX_OKVED_LENGTH = 8;
const MAX_OKVED_INPUT_LENGTH = 200;
export const MAX_LEGAL_ENTITIES = 50;
export const MAX_LEGAL_ENTITY_NAME_LENGTH = 300;
export const MAX_MATERIALS = 50;
export const MAX_MATERIAL_TITLE_LENGTH = 200;
export const MAX_FULL_LIST_ITEMS = 50;
export const MAX_FULL_LIST_ITEM_LENGTH = 100;
/** Год основания и число сотрудников: разумные границы, чтобы отсечь опечатки. */
export const MIN_FOUNDED_YEAR = 1700;
export const MAX_FOUNDED_YEAR = 2100;
export const MAX_EMPLOYEE_COUNT = 1_000_000;
/** Сколько лет оборота хранит карточка (ТЗ 10.9: «за последние два-три года», с запасом). */
export const MAX_TURNOVER_YEARS = 5;
/** Границы года оборота: отсекают опечатки («2204»), верхняя совпадает с годом основания. */
export const MIN_TURNOVER_YEAR = 1990;
export const MAX_TURNOVER_YEAR = MAX_FOUNDED_YEAR;
export const MAX_SAMPLES_QUANTITY = 1_000_000;
/** Предел длины ИНН на входе: цифры с пробелами и дефисами (проверка - после нормализации). */
const MAX_LEGAL_ENTITY_INN_INPUT_LENGTH = 32;

/** Ссылка на файл, который целиком лежит в карточке (data:), не принимается. */
const INLINE_DATA_PREFIX = /^data:/i;
const NOT_DIGIT = /\D/g;

/** Организация поставщика (разд. 10.5): название и ИНН. */
export interface SupplierLegalEntity {
  name: string;
  inn?: string | undefined;
}

/** Оборот поставщика за один календарный год (разд. 10.9). */
export interface SupplierTurnoverYear {
  year: number;
  /** Сумма в рублях, 0..`MAX_TURNOVER_RUB`. */
  rub: number;
}

/** Материал поставщика (разд. 10.6): ссылка на файл в базе знаний. */
export interface SupplierMaterial {
  kind: MaterialKind;
  /** Ссылка или путь файла в базе знаний; сам файл в карточке не хранится. */
  ref: string;
  title?: string | undefined;
}

/** Необязательные поля полной карточки (разд. 10.1-10.9), кроме уже существовавших. */
export interface SupplierFullParts {
  /** Ссылка на файл логотипа в базе знаний (10.1). */
  logoRef?: string | undefined;
  supplierKind?: SupplierKind | undefined;
  foundedYear?: number | undefined;
  /** Размер скидки от цены поставщика для рекламного агентства, % (0-100) (10.3). */
  agencyDiscountPercent?: number | undefined;
  minOrderAmount?: string | undefined;
  samplesAvailable?: boolean | undefined;
  samplesQuantity?: number | undefined;
  samplesTerms?: string | undefined;
  paymentNotes?: string | undefined;
  /**
   * НДС (10.3): режим и ставка в процентах (0-100). `no_vat` - без НДС (УСН и др.), ставки
   * нет; `with_vat` - плательщик, ставка может быть не названа.
   */
  vatMode?: VatMode | undefined;
  vatRatePercent?: number | undefined;
  /** Условия бесплатной доставки (10.4). */
  freeDelivery?: string | undefined;
  documentFlow?: DocumentFlow | undefined;
  contractNotes?: string | undefined;
  legalEntities?: SupplierLegalEntity[] | undefined;
  packaging?: PackagingKind | undefined;
  packagingPricing?: PackagingPricing | undefined;
  technologies?: string[] | undefined;
  personalizationTypes?: string[] | undefined;
  materials?: SupplierMaterial[] | undefined;
  technicalRequirements?: string | undefined;
  pragmatikaPortfolio?: string | undefined;
  transportInfo?: string | undefined;
  marketingSupport?: string | undefined;
  trainingFormats?: TrainingFormat[] | undefined;
  exclusivity?: string | undefined;
  hasOwnDesigners?: boolean | undefined;
  designServices?: string | undefined;
  hasQualityControl?: boolean | undefined;
  additionalServices?: string | undefined;
  claimsHandling?: string | undefined;
  competitiveAdvantages?: string | undefined;
  customers?: string | undefined;
  /**
   * Оборот одной суммой, руб. (10.9): прежнее поле, год не известен. Новые данные пишутся
   * по годам (`turnoverByYear`); сумма без года остаётся для карточек, заведённых раньше.
   */
  turnoverRub?: number | undefined;
  /** Оборот по годам за 2-3 последних года (10.9), от новых лет к старым, год не повторяется. */
  turnoverByYear?: SupplierTurnoverYear[] | undefined;
  okved?: string | undefined;
  employeeCount?: number | undefined;
}

/** Ключи всех полей полной карточки (порядок - как в ТЗ). */
export const SUPPLIER_FULL_KEYS = [
  'logoRef',
  'supplierKind',
  'foundedYear',
  'agencyDiscountPercent',
  'minOrderAmount',
  'samplesAvailable',
  'samplesQuantity',
  'samplesTerms',
  'paymentNotes',
  'vatMode',
  'vatRatePercent',
  'freeDelivery',
  'documentFlow',
  'contractNotes',
  'legalEntities',
  'packaging',
  'packagingPricing',
  'technologies',
  'personalizationTypes',
  'materials',
  'technicalRequirements',
  'pragmatikaPortfolio',
  'transportInfo',
  'marketingSupport',
  'trainingFormats',
  'exclusivity',
  'hasOwnDesigners',
  'designServices',
  'hasQualityControl',
  'additionalServices',
  'claimsHandling',
  'competitiveAdvantages',
  'customers',
  'turnoverRub',
  'turnoverByYear',
  'okved',
  'employeeCount',
] as const satisfies ReadonlyArray<keyof SupplierFullParts>;
export type SupplierFullKey = (typeof SUPPLIER_FULL_KEYS)[number];

/** Текстовые поля: предельная длина и название для сообщений людям. */
export const SUPPLIER_FULL_TEXT_FIELDS = {
  logoRef: { limit: MAX_REF_LENGTH, label: 'Логотип (ссылка на файл)' },
  minOrderAmount: { limit: MAX_FULL_TERM_LENGTH, label: 'Минимальная сумма заказа' },
  samplesTerms: { limit: MAX_FULL_TERM_LENGTH, label: 'Условия бесплатных образцов' },
  paymentNotes: { limit: MAX_FULL_TEXT_LENGTH, label: 'Комментарии по видам оплат' },
  freeDelivery: { limit: MAX_FULL_TERM_LENGTH, label: 'Бесплатная доставка' },
  contractNotes: { limit: MAX_FULL_TEXT_LENGTH, label: 'Договор и соглашения' },
  technicalRequirements: { limit: MAX_FULL_LONG_TEXT_LENGTH, label: 'Технические требования' },
  pragmatikaPortfolio: {
    limit: MAX_FULL_LONG_TEXT_LENGTH,
    label: 'Портфолио заказов в Прагматике',
  },
  transportInfo: { limit: MAX_FULL_TEXT_LENGTH, label: 'Информация для транспортных компаний' },
  marketingSupport: { limit: MAX_FULL_TEXT_LENGTH, label: 'Маркетинговая поддержка' },
  exclusivity: { limit: MAX_FULL_TEXT_LENGTH, label: 'Эксклюзивное партнёрство' },
  designServices: { limit: MAX_FULL_TEXT_LENGTH, label: 'Дизайн: виды работ и условия' },
  additionalServices: { limit: MAX_FULL_TEXT_LENGTH, label: 'Дополнительные услуги' },
  claimsHandling: { limit: MAX_FULL_TEXT_LENGTH, label: 'Работа с рекламациями' },
  competitiveAdvantages: { limit: MAX_FULL_TEXT_LENGTH, label: 'Конкурентные преимущества' },
  customers: { limit: MAX_FULL_TEXT_LENGTH, label: 'Заказчики' },
} as const satisfies Partial<
  Record<SupplierFullKey, { limit: number; label: string }>
>;
export type SupplierFullTextKey = keyof typeof SUPPLIER_FULL_TEXT_FIELDS;
const TEXT_KEYS = Object.keys(SUPPLIER_FULL_TEXT_FIELDS) as SupplierFullTextKey[];

const shortText = (max: number): z.ZodString => z.string().trim().min(1).max(max);
const listItems = z.array(shortText(MAX_FULL_LIST_ITEM_LENGTH)).max(MAX_FULL_LIST_ITEMS);

/**
 * Поля полной карточки на входе (инструменты модели, запрос подтверждения, импорт файла).
 * Каждое поле необязательно; значение заменяет прежнее целиком, списки тоже.
 */
export const supplierFullFieldsShape = {
  logoRef: shortText(MAX_REF_LENGTH).optional(),
  supplierKind: z.enum(SUPPLIER_KINDS).optional(),
  foundedYear: z.number().int().min(MIN_FOUNDED_YEAR).max(MAX_FOUNDED_YEAR).optional(),
  agencyDiscountPercent: z.number().min(MIN_PERCENT).max(MAX_PERCENT).optional(),
  minOrderAmount: shortText(MAX_FULL_TERM_LENGTH).optional(),
  samplesAvailable: z.boolean().optional(),
  samplesQuantity: z.number().int().min(0).max(MAX_SAMPLES_QUANTITY).optional(),
  samplesTerms: shortText(MAX_FULL_TERM_LENGTH).optional(),
  paymentNotes: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  vatMode: z.enum(VAT_MODES).optional(),
  vatRatePercent: z.number().min(MIN_PERCENT).max(MAX_PERCENT).optional(),
  freeDelivery: shortText(MAX_FULL_TERM_LENGTH).optional(),
  documentFlow: z.enum(DOCUMENT_FLOWS).optional(),
  contractNotes: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  legalEntities: z
    .array(
      z.object({
        name: shortText(MAX_LEGAL_ENTITY_NAME_LENGTH),
        inn: shortText(MAX_LEGAL_ENTITY_INN_INPUT_LENGTH).optional(),
      }),
    )
    .max(MAX_LEGAL_ENTITIES)
    .optional(),
  packaging: z.enum(PACKAGING_KINDS).optional(),
  packagingPricing: z.enum(PACKAGING_PRICINGS).optional(),
  technologies: listItems.optional(),
  personalizationTypes: listItems.optional(),
  materials: z
    .array(
      z.object({
        kind: z.enum(MATERIAL_KINDS),
        ref: shortText(MAX_REF_LENGTH),
        title: shortText(MAX_MATERIAL_TITLE_LENGTH).optional(),
      }),
    )
    .max(MAX_MATERIALS)
    .optional(),
  technicalRequirements: shortText(MAX_FULL_LONG_TEXT_LENGTH).optional(),
  pragmatikaPortfolio: shortText(MAX_FULL_LONG_TEXT_LENGTH).optional(),
  transportInfo: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  marketingSupport: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  trainingFormats: z.array(z.enum(TRAINING_FORMATS)).max(TRAINING_FORMATS.length).optional(),
  exclusivity: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  hasOwnDesigners: z.boolean().optional(),
  designServices: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  hasQualityControl: z.boolean().optional(),
  additionalServices: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  claimsHandling: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  competitiveAdvantages: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  customers: shortText(MAX_FULL_TEXT_LENGTH).optional(),
  // Верхний предел (MAX_TURNOVER_RUB) проверяет `validateFullParts`: 14-значное число в схеме
  // инструмента попало бы к модели и сработало бы правило шлюза на длинные серии цифр.
  turnoverRub: z.number().min(0).optional(),
  // Сумма каждого года проверяется в `validateFullParts` (по той же причине, что выше).
  turnoverByYear: z
    .array(
      z.object({
        year: z.number().int().min(MIN_TURNOVER_YEAR).max(MAX_TURNOVER_YEAR),
        rub: z.number().min(0),
      }),
    )
    .max(MAX_TURNOVER_YEARS)
    .optional(),
  okved: shortText(MAX_OKVED_INPUT_LENGTH).optional(),
  employeeCount: z.number().int().min(0).max(MAX_EMPLOYEE_COUNT).optional(),
} satisfies Record<SupplierFullKey, z.ZodTypeAny>;

/** Скопировать из источника заданные (не undefined) поля полной карточки; массивы копируются. */
export function pickFullParts(source: SupplierFullParts): SupplierFullParts {
  const result: Record<string, unknown> = {};
  for (const key of SUPPLIER_FULL_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.map((item: unknown) => cloneItem(item)) : value;
  }
  return result as SupplierFullParts;
}

function cloneItem(item: unknown): unknown {
  return typeof item === 'object' && item !== null ? { ...item } : item;
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function roundedOrSame(
  value: number | undefined,
  round: (input: number) => number,
): number | undefined {
  return value === undefined || !Number.isFinite(value) ? value : round(value);
}

function cleanUnique<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const raw of values) {
    const value = raw.trim() as T;
    const key = value.toLowerCase();
    if (value === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/**
 * Оборот по годам в каноническом виде: суммы округлены до копейки, год не повторяется (при
 * повторе остаётся последняя запись), порядок - от нового года к старому.
 */
export function normalizeTurnoverYears(
  years: readonly SupplierTurnoverYear[] | undefined,
): SupplierTurnoverYear[] | undefined {
  if (years === undefined) return undefined;
  const byYear = new Map<number, number>();
  for (const item of years) {
    byYear.set(item.year, Number.isFinite(item.rub) ? roundRubles(item.rub) : item.rub);
  }
  return [...byYear.entries()]
    .map(([year, rub]): SupplierTurnoverYear => ({ year, rub }))
    .sort((a, b) => b.year - a.year);
}

/**
 * Привести поля полной карточки к каноническому виду: строки обрезаны, пустые и пустые
 * списки отброшены, ИНН организаций - цифры, списки без повторов. Значения не проверяет.
 */
export function normalizeFullParts(card: SupplierFullParts): SupplierFullParts {
  const result: Record<string, unknown> = {};
  const set = (key: SupplierFullKey, value: unknown): void => {
    if (value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    result[key] = value;
  };
  for (const key of TEXT_KEYS) set(key, cleanText(card[key]));
  const okved = cleanText(card.okved);
  if (okved !== undefined) {
    const parsed = normalizeOkved(okved);
    // Нераспознанный код остаётся как есть: его отклонит проверка формата.
    set('okved', parsed.ok ? parsed.code : okved);
  }
  set('agencyDiscountPercent', roundedOrSame(card.agencyDiscountPercent, roundPercent));
  set('turnoverRub', roundedOrSame(card.turnoverRub, roundRubles));
  set('turnoverByYear', normalizeTurnoverYears(card.turnoverByYear));
  const vatRate = roundedOrSame(card.vatRatePercent, roundPercent);
  set('vatRatePercent', vatRate);
  // Ставка без режима означает плательщика НДС.
  set('vatMode', card.vatMode ?? (vatRate === undefined ? undefined : 'with_vat'));
  for (const key of [
    'supplierKind',
    'foundedYear',
    'samplesAvailable',
    'samplesQuantity',
    'documentFlow',
    'packaging',
    'packagingPricing',
    'hasOwnDesigners',
    'hasQualityControl',
    'employeeCount',
  ] as const) {
    set(key, card[key]);
  }
  set('technologies', card.technologies === undefined ? undefined : cleanUnique(card.technologies));
  set(
    'personalizationTypes',
    card.personalizationTypes === undefined ? undefined : cleanUnique(card.personalizationTypes),
  );
  set(
    'trainingFormats',
    card.trainingFormats === undefined ? undefined : [...new Set(card.trainingFormats)],
  );
  const entities = (card.legalEntities ?? [])
    .map((entity): SupplierLegalEntity => {
      const inn = cleanText(entity.inn)?.replace(NOT_DIGIT, '');
      return { name: entity.name.trim(), ...(inn === undefined || inn === '' ? {} : { inn }) };
    })
    .filter((entity) => entity.name !== '' || entity.inn !== undefined);
  set('legalEntities', entities);
  const materials = (card.materials ?? [])
    .map((item): SupplierMaterial => {
      const title = cleanText(item.title);
      return { kind: item.kind, ref: item.ref.trim(), ...(title === undefined ? {} : { title }) };
    })
    .filter((item) => item.ref !== '');
  set('materials', materials);
  return result as SupplierFullParts;
}

function checkLimit(
  issues: ValidationIssue[],
  value: string | undefined,
  max: number,
  code: string,
  label: string,
): void {
  if (value !== undefined && value.length > max) {
    issues.push({ code, message: `${label}: не длиннее ${max} знаков.` });
  }
}

function checkInteger(
  issues: ValidationIssue[],
  value: number | undefined,
  range: { min: number; max: number },
  code: string,
  label: string,
): void {
  if (value === undefined) return;
  const ok = Number.isInteger(value) && value >= range.min && value <= range.max;
  if (!ok) {
    issues.push({ code, message: `${label}: целое число от ${range.min} до ${range.max}.` });
  }
}

function checkNumber(
  issues: ValidationIssue[],
  value: number | undefined,
  range: { min: number; max: number },
  code: string,
  label: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    issues.push({ code, message: `${label}: число от ${range.min} до ${range.max}.` });
  }
}

function checkEnum(
  issues: ValidationIssue[],
  value: string | undefined,
  allowed: readonly string[],
  code: string,
  label: string,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    issues.push({ code, message: `${label}: недопустимое значение.` });
  }
}

function checkList(
  issues: ValidationIssue[],
  values: readonly string[] | undefined,
  code: string,
  label: string,
): void {
  if (values === undefined) return;
  if (values.length > MAX_FULL_LIST_ITEMS) {
    const message = `${label}: не больше ${MAX_FULL_LIST_ITEMS}.`;
    issues.push({ code: `${code}_too_many`, message });
  }
  if (values.some((value) => value.length > MAX_FULL_LIST_ITEM_LENGTH)) {
    issues.push({
      code: `${code}_item_too_long`,
      message: `${label}: каждая позиция не длиннее ${MAX_FULL_LIST_ITEM_LENGTH} знаков.`,
    });
  }
}

/**
 * Замечания к полям полной карточки (пусто = можно записывать). Карточку нужно предварительно
 * привести `normalizeFullParts`. Тексты замечаний значений (в том числе ИНН) не содержат.
 */
export function validateFullParts(card: SupplierFullParts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of TEXT_KEYS) {
    const { limit, label } = SUPPLIER_FULL_TEXT_FIELDS[key];
    checkLimit(issues, card[key], limit, `${key}_too_long`, label);
  }
  if (card.logoRef !== undefined && INLINE_DATA_PREFIX.test(card.logoRef)) {
    issues.push({
      code: 'logoRef_inline',
      message: 'Логотип: нужна ссылка на файл в базе знаний, а не само содержимое.',
    });
  }
  checkEnum(issues, card.supplierKind, SUPPLIER_KINDS, 'supplier_kind_invalid', 'Вид поставщика');
  checkEnum(issues, card.documentFlow, DOCUMENT_FLOWS, 'document_flow_invalid', 'Документооборот');
  checkEnum(issues, card.packaging, PACKAGING_KINDS, 'packaging_invalid', 'Упаковка');
  checkEnum(
    issues,
    card.packagingPricing,
    PACKAGING_PRICINGS,
    'packaging_pricing_invalid',
    'Упаковка: стоимость',
  );
  for (const format of card.trainingFormats ?? []) {
    checkEnum(issues, format, TRAINING_FORMATS, 'training_format_invalid', 'Формат обучения');
  }
  checkInteger(
    issues,
    card.foundedYear,
    { min: MIN_FOUNDED_YEAR, max: MAX_FOUNDED_YEAR },
    'founded_year_invalid',
    'Год основания',
  );
  checkInteger(
    issues,
    card.samplesQuantity,
    { min: 0, max: MAX_SAMPLES_QUANTITY },
    'samples_quantity_invalid',
    'Количество образцов',
  );
  checkInteger(
    issues,
    card.employeeCount,
    { min: 0, max: MAX_EMPLOYEE_COUNT },
    'employee_count_invalid',
    'Численность сотрудников',
  );
  if (card.okved !== undefined && !OKVED_PATTERN.test(card.okved)) {
    issues.push({
      code: 'okved_invalid',
      message: 'Основной ОКВЭД: код ОКВЭД 2 вида 62, 62.0, 62.01, 62.01.1 или 62.01.11.',
    });
  }
  checkEnum(issues, card.vatMode, VAT_MODES, 'vat_mode_invalid', 'НДС: режим');
  checkNumber(issues, card.vatRatePercent, { min: MIN_PERCENT, max: MAX_PERCENT },
    'vat_rate_invalid', 'Ставка НДС, %');
  if (card.vatMode === 'no_vat' && card.vatRatePercent !== undefined) {
    issues.push({
      code: 'vat_conflict',
      message: 'НДС: при режиме «без НДС» ставка не задаётся.',
    });
  }
  checkNumber(issues, card.agencyDiscountPercent, { min: MIN_PERCENT, max: MAX_PERCENT },
    'agency_discount_invalid', 'Скидка для агентства, %');
  const turnover = card.turnoverRub;
  if (turnover !== undefined && !(Number.isFinite(turnover) && turnover >= 0 &&
      turnover <= MAX_TURNOVER_RUB)) {
    // Без числа предела в тексте: сообщение может уйти модели (правило длинных серий цифр).
    issues.push({ code: 'turnover_invalid', message: 'Оборот: сумма в рублях от 0 до 10 трлн.' });
  }
  const turnoverYears = card.turnoverByYear ?? [];
  if (turnoverYears.length > MAX_TURNOVER_YEARS) {
    issues.push({
      code: 'turnover_years_too_many',
      message: `Оборот по годам: не больше ${MAX_TURNOVER_YEARS} лет.`,
    });
  }
  const seenYears = new Set<number>();
  for (const item of turnoverYears) {
    const yearOk = Number.isInteger(item.year) && item.year >= MIN_TURNOVER_YEAR &&
      item.year <= MAX_TURNOVER_YEAR;
    const rubOk = Number.isFinite(item.rub) && item.rub >= 0 && item.rub <= MAX_TURNOVER_RUB;
    if (!yearOk || !rubOk || seenYears.has(item.year)) {
      issues.push({
        code: 'turnover_year_invalid',
        message: 'Оборот по годам: год и сумма в рублях (от 0 до 10 трлн), год не повторяется.',
      });
      break;
    }
    seenYears.add(item.year);
  }
  checkList(issues, card.technologies, 'technologies', 'Технологии производства');
  checkList(issues, card.personalizationTypes, 'personalization', 'Виды персонификации');
  const entities = card.legalEntities ?? [];
  if (entities.length > MAX_LEGAL_ENTITIES) {
    issues.push({
      code: 'legal_entities_too_many',
      message: `Юридических лиц не больше ${MAX_LEGAL_ENTITIES}.`,
    });
  }
  entities.forEach((entity, index) => {
    const label = `Юридическое лицо ${index + 1}`;
    if (entity.name === '') {
      issues.push({ code: 'legal_entity_name_required', message: `${label}: нет названия.` });
    }
    checkLimit(issues, entity.name, MAX_LEGAL_ENTITY_NAME_LENGTH, 'legal_entity_name_too_long',
      label);
    if (entity.inn !== undefined && !isValidInn(entity.inn)) {
      issues.push({
        code: 'legal_entity_inn_invalid',
        message: `${label}: ИНН - неверная длина или контрольная сумма.`,
      });
    }
  });
  const materials = card.materials ?? [];
  if (materials.length > MAX_MATERIALS) {
    issues.push({ code: 'materials_too_many', message: `Материалов не больше ${MAX_MATERIALS}.` });
  }
  materials.forEach((item, index) => {
    const label = `Материал ${index + 1}`;
    checkEnum(issues, item.kind, MATERIAL_KINDS, 'material_kind_invalid', label);
    checkLimit(issues, item.ref, MAX_REF_LENGTH, 'material_ref_too_long', label);
    checkLimit(issues, item.title, MAX_MATERIAL_TITLE_LENGTH, 'material_title_too_long', label);
    if (INLINE_DATA_PREFIX.test(item.ref)) {
      issues.push({
        code: 'material_ref_inline',
        message: `${label}: нужна ссылка на файл в базе знаний, а не само содержимое.`,
      });
    }
  });
  return issues;
}
