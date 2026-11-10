import { z } from 'zod';

/** Длина ISO-кода валюты. */
export const CURRENCY_CODE_LENGTH = 3;

import { isoDateOrInstantSchema, isoDeadlineSchema, isoInstantSchema } from './iso-datetime';
import { allowedVatRatesText } from './vat';

/**
 * Момент события (создание заявки, получение ответа): ISO 8601 с обязательным часовым поясом.
 * Дата без времени и «01.02.2026» не принимаются (R4-ALG-2): Date.parse читал их по-разному.
 */
const isoDateSchema = isoInstantSchema;
/** Дата позиции прайса: дата без времени или момент с поясом. */
const priceDateSchema = isoDateOrInstantSchema;
const currencySchema = z.string().length(CURRENCY_CODE_LENGTH);
const idSchema = z.string().min(1);
/** Верхняя граница ставки НДС в КП поставщика, % (допустимые ставки документа - `vat.ts`). */
export const MAX_VAT_RATE_PERCENT = 100;
/** Описание ставки НДС документа для модели: действующие ставки, без ставки «по умолчанию». */
const VAT_RATE_DESCRIPTION =
  `Ставка НДС, % - одна из действующих: ${allowedVatRatesText()}. Только из источника ` +
  '(КП, счёт, договор, сообщение сотрудника); не заменяй её другой и не подставляй сама.';

/** Сколько коротких поисковых запросов хранит позиция заявки. */
export const REQUEST_ITEM_SEARCH_QUERIES_MAX = 3;
/** Предел длины одного короткого запроса: это товарная фраза, а не пересказ позиции. */
export const REQUEST_ITEM_SEARCH_QUERY_MAX_CHARS = 80;
/** Предел длины требований к позиции: свойства товара, а не пересказ задачи; лишнее обрезается. */
export const REQUEST_ITEM_REQUIREMENTS_MAX_CHARS = 500;

/** Позиция заявки на расчёт. */
export interface RequestItem {
  name: string;
  sku?: string | undefined;
  /** Нет количества в источнике - поля нет: ничего не выдумываем, итоги по позиции не считаются. */
  quantity?: number | undefined;
  unit: string;
  /**
   * Короткие запросы к базе цен (1-3 слова товара, без количества и признаков нанесения),
   * которые выделяет модель при приёме. Нужны, потому что полное название позиции в векторном
   * поиске даёт лишь половину поставщиков. Старые заявки их не имеют - тогда ищется по названию.
   */
  searchQueries?: string[] | undefined;
  /**
   * Характеристики товара из задачи (материал, размер, формат, нанесение, комплектация и т. п.).
   * Без них все шаги после приёма видят одно слово названия и принимают чужой товар за свой.
   * Старые заявки поля не имеют - тогда шаги работают по названию.
   */
  requirements?: string | undefined;
}
const requestItemSchema: z.ZodType<RequestItem, z.ZodTypeDef, unknown> = z.object({
  name: z.string().min(1),
  sku: z.string().min(1).optional(),
  quantity: z.number().positive().optional(),
  unit: z.string().min(1),
  searchQueries: z
    .array(z.string().min(1).max(REQUEST_ITEM_SEARCH_QUERY_MAX_CHARS))
    .max(REQUEST_ITEM_SEARCH_QUERIES_MAX)
    .optional(),
  requirements: z.string().min(1).max(REQUEST_ITEM_REQUIREMENTS_MAX_CHARS).optional(),
});

/** Заявка на расчёт. */
export interface PurchaseRequest {
  id: string;
  dealRef: string;
  items: RequestItem[];
  createdAt: string;
}
export const purchaseRequestSchema: z.ZodType<PurchaseRequest, z.ZodTypeDef, unknown> = z.object({
  id: idSchema,
  dealRef: idSchema,
  items: z.array(requestItemSchema).min(1),
  createdAt: isoDateSchema,
  // Срок ответа (прежнее поле slaDeadline) не хранится: в старых сохранённых заявках он
  // встречается, но схема не строгая - лишнее поле молча отбрасывается при разборе.
});

/**
 * Поставщик. Реквизиты необязательны: их полноту и контрольные суммы проверяет
 * `checkSupplierRequisites` (domain/requisites.ts), а не схема, чтобы агент получал список
 * замечаний, а не первую ошибку разбора.
 */
export interface Supplier {
  id: string;
  name: string;
  email?: string | undefined;
  contactName?: string | undefined;
  /** ИНН: 10 цифр (юрлицо) или 12 (ИП). */
  inn?: string | undefined;
  kpp?: string | undefined;
  ogrn?: string | undefined;
  legalAddress?: string | undefined;
  bankName?: string | undefined;
  bik?: string | undefined;
  /** Расчётный счёт. */
  settlementAccount?: string | undefined;
  correspondentAccount?: string | undefined;
  /** Подписант со стороны поставщика (ФИО). */
  directorName?: string | undefined;
}
export const supplierSchema: z.ZodType<Supplier, z.ZodTypeDef, unknown> = z.object({
  id: idSchema,
  name: z.string().min(1),
  email: z.string().email().optional(),
  contactName: z.string().min(1).optional(),
  inn: z.string().min(1).optional(),
  kpp: z.string().min(1).optional(),
  ogrn: z.string().min(1).optional(),
  legalAddress: z.string().min(1).optional(),
  bankName: z.string().min(1).optional(),
  bik: z.string().min(1).optional(),
  settlementAccount: z.string().min(1).optional(),
  correspondentAccount: z.string().min(1).optional(),
  directorName: z.string().min(1).optional(),
});

/** Сколько тиражей (ценовых порогов) хранит одна позиция; совпадает с CHECK миграций 032/033. */
export const MAX_PRICE_TIERS = 8;
/**
 * Основание тиража: от чего считается порог `minQuantity` у тиражей позиции. 'quantity' -
 * от количества штук (по умолчанию), 'order_sum' - от суммы заказа в рублях («цена от
 * 62 000 / 102 000»). Для 'order_sum' `minQuantity` - сумма заказа, а не штуки.
 */
export const PRICE_TIER_BASES = ['quantity', 'order_sum'] as const;
export type PriceTierBasis = (typeof PRICE_TIER_BASES)[number];
/**
 * Тираж: цена за штуку при заказе от `minQuantity` штук (при основании 'order_sum' позиции -
 * от суммы заказа `minQuantity` рублей). `qualifier`/`max` - как у позиции:
 * «500-600» в ячейке тиража хранится как price=500, qualifier='range', max=600 (расширение
 * элемента jsonb-массива, схема CHECK не меняется).
 */
export interface PriceTier {
  minQuantity: number;
  price: number;
  qualifier?: PriceQualifier | undefined;
  max?: number | undefined;
}
/**
 * Признак цены, написанной словами: «от 500» ('from') - минимальная цена, «500-700» ('range') -
 * диапазон. Нет признака - точная цена. Основная цена `price` при признаке - НИЖНЯЯ граница.
 */
export const PRICE_QUALIFIERS = ['from', 'range'] as const;
export type PriceQualifier = (typeof PRICE_QUALIFIERS)[number];
export const priceTierSchema: z.ZodType<PriceTier, z.ZodTypeDef, unknown> = z
  .object({
    minQuantity: z.number().int().positive(),
    price: z.number().positive(),
    qualifier: z.enum(PRICE_QUALIFIERS).optional(),
    max: z.number().positive().optional(),
  })
  // Верхняя граница бывает только у диапазона и строго больше нижней.
  .refine(
    (tier) =>
      tier.max === undefined || (tier.qualifier === 'range' && tier.max > tier.price),
    { message: 'max допустим только у диапазона и должен быть больше price' },
  );

/**
 * Строка прайс-листа поставщика. Основная цена `price` у позиции с тиражами - цена
 * МИНИМАЛЬНОГО тиража (первый элемент `priceTiers`); тиражи нужны для показа и сравнения.
 */
/**
 * Как цена указана в прайсе (миграция 039): с НДС, без НДС, поставщик без НДС (УСН), из файла не
 * видно. Нет значения у строк, загруженных до миграции: признак не размечен.
 */
export const PRICE_VAT_VALUES = ['included', 'excluded', 'none', 'unknown'] as const;
export type PriceVat = (typeof PRICE_VAT_VALUES)[number];

export interface PriceItem {
  supplierId: string;
  productName: string;
  sku?: string | undefined;
  price: number;
  currency: string;
  date: string;
  /**
   * Цены по тиражам по возрастанию тиража; нет - у позиции одна цена. Один элемент - тираж из
   * одной ячейки («от 100 шт 45 руб»): минимальный тираж терять нельзя.
   */
  priceTiers?: PriceTier[] | undefined;
  /**
   * Основание порогов `priceTiers`; нет - 'quantity' (штуки). Хранится только 'order_sum':
   * по умолчанию поле опускается, чтобы прежние позиции и их хэши не менялись.
   */
  priceTierBasis?: PriceTierBasis | undefined;
  /** Цена «от» или диапазон; нет - точная цена. */
  priceQualifier?: PriceQualifier | undefined;
  /** Верхняя граница диапазона; только при `priceQualifier = 'range'`, строго больше `price`. */
  priceMax?: number | undefined;
  /**
   * Файл прайса (путь от корня диска), из которого строка записана; нет - строка без файла
   * (прайс до этой версии, правка сотрудника, чат/почта). Замена и сравнение при импорте идут в
   * пределах файла (`planSourceReplacement`).
   */
  sourceFile?: string | undefined;
  /**
   * Признак НДС цены (`price_vat`). Только читается из базы для показа в шорт-листе; нет -
   * не размечен. Поле опускается, пока значения нет: прежние позиции и их сравнение не меняются.
   */
  priceVat?: PriceVat | undefined;
  /**
   * Момент записи строки в базу (`created_at`). Только читается поиском цен: нужен, чтобы при
   * равной дате прайса выбрать более позднюю запись (этап 161). Нет - строка из других путей.
   */
  createdAt?: string | undefined;
}
export const priceItemSchema: z.ZodType<PriceItem, z.ZodTypeDef, unknown> = z
  .object({
    supplierId: idSchema,
    productName: z.string().min(1),
    sku: z.string().min(1).optional(),
    price: z.number().positive(),
    currency: currencySchema,
    date: priceDateSchema,
    priceTiers: z.array(priceTierSchema).min(1).max(MAX_PRICE_TIERS).optional(),
    priceTierBasis: z.enum(PRICE_TIER_BASES).optional(),
    priceQualifier: z.enum(PRICE_QUALIFIERS).optional(),
    priceMax: z.number().positive().optional(),
    sourceFile: z.string().min(1).optional(),
    priceVat: z.enum(PRICE_VAT_VALUES).optional(),
  })
  // Как CHECK миграции 034: основание суммы заказа без тиражей ничего не значит.
  .refine((item) => item.priceTierBasis !== 'order_sum' || item.priceTiers !== undefined, {
    message: 'priceTierBasis=order_sum допустим только вместе с priceTiers',
  })
  // Как CHECK миграции 033: верхняя граница бывает только у диапазона и больше нижней.
  .refine(
    (item) =>
      item.priceMax === undefined ||
      (item.priceQualifier === 'range' && item.priceMax > item.price),
    { message: 'priceMax допустим только для диапазона и должен быть больше price' },
  );

/** Сколько позиций записано с ценой словами и с тиражом из одной ячейки (для сводок). */
export interface PriceFormCounts {
  from: number;
  range: number;
  cellTier: number;
}

/** Посчитать позиции с признаком «от», диапазоном и тиражом из ячейки (один элемент тиражей). */
export function countPriceForms(items: readonly PriceItem[]): PriceFormCounts {
  const counts: PriceFormCounts = { from: 0, range: 0, cellTier: 0 };
  for (const item of items) {
    if (item.priceQualifier === 'from') counts.from += 1;
    if (item.priceQualifier === 'range') counts.range += 1;
    if (item.priceTiers?.length === 1) counts.cellTier += 1;
  }
  return counts;
}

/** Шорт-лист: поставщики, которым разрешено рассылать запросы по заявке. */
export interface ShortList {
  requestId: string;
  supplierIds: string[];
  createdAt: string;
}

/**
 * Позиция ответа поставщика. Всё, кроме названия, необязательно: чего поставщик не указал,
 * остаётся пустым и попадает в пометки «чего не хватает» (QuoteGap), а не выдумывается.
 */
export interface QuoteLine {
  productName: string;
  unitPrice?: number | undefined;
  quantity?: number | undefined;
  unit?: string | undefined;
  /** Срок поставки по позиции, дней. */
  deliveryDays?: number | undefined;
  /** Поставщик предлагает замену позиции заявки (в сравнение по позиции не входит). */
  isReplacement?: boolean | undefined;
  notes?: string | undefined;
  /**
   * Цена включает НДС: true - с НДС, false - без НДС, не задано - в ответе не сказано
   * (R4-ALG-4). Цены «с НДС» и «без НДС» несопоставимы, поэтому признак не угадывается.
   */
  vatIncluded?: boolean | undefined;
  /**
   * Ставка НДС, % (0..100) как в ответе поставщика, без сверки с `VAT_RATES_PERCENT`: КП
   * фиксирует сказанное, НДС из него не считается. 0 - поставщик без НДС, цена итоговая.
   */
  vatRate?: number | undefined;
  /** Фасовка (кратность отгрузки) в единицах заявки: количество должно делиться на неё. */
  packSize?: number | undefined;
  /** Минимальная партия в единицах заявки. */
  minOrder?: number | undefined;
}
export const quoteLineSchema: z.ZodType<QuoteLine, z.ZodTypeDef, unknown> = z.object({
  productName: z.string().min(1),
  unitPrice: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  unit: z.string().min(1).optional(),
  deliveryDays: z.number().int().nonnegative().optional(),
  isReplacement: z.boolean().optional(),
  notes: z.string().min(1).optional(),
  vatIncluded: z.boolean().optional(),
  vatRate: z.number().min(0).max(MAX_VAT_RATE_PERCENT).optional(),
  packSize: z.number().positive().optional(),
  minOrder: z.number().positive().optional(),
});

/** Чего не хватает в ответе поставщика. */
const QUOTE_GAP_CODES = [
  'no_price',
  'no_quantity',
  'no_delivery',
  'no_payment_terms',
  'no_validity',
  'item_not_covered',
] as const;
type QuoteGapCode = (typeof QUOTE_GAP_CODES)[number];

/** Пометка «чего не хватает у этого поставщика»; `productName` — если про конкретную позицию. */
export interface QuoteGap {
  code: QuoteGapCode;
  productName?: string | undefined;
}
export const quoteGapSchema: z.ZodType<QuoteGap, z.ZodTypeDef, unknown> = z.object({
  code: z.enum(QUOTE_GAP_CODES),
  productName: z.string().min(1).optional(),
});

/** Ответ поставщика на запрос (разобранное КП). */
export interface SupplierQuote {
  id: string;
  requestId: string;
  supplierId: string;
  lines: QuoteLine[];
  currency: string;
  receivedAt: string;
  validUntil?: string | undefined;
  /** Общий срок поставки, дней (если не задан по позициям). */
  deliveryDays?: number | undefined;
  paymentTerms?: string | undefined;
  notes?: string | undefined;
  /** Откуда разобрано: идентификатор ответа или письма. */
  sourceRef?: string | undefined;
  gaps: QuoteGap[];
}
export const supplierQuoteSchema: z.ZodType<SupplierQuote, z.ZodTypeDef, unknown> = z.object({
  id: idSchema,
  requestId: idSchema,
  supplierId: idSchema,
  lines: z.array(quoteLineSchema).min(1),
  currency: currencySchema,
  receivedAt: isoDateSchema,
  validUntil: isoDeadlineSchema.optional(),
  deliveryDays: z.number().int().nonnegative().optional(),
  paymentTerms: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  sourceRef: z.string().min(1).optional(),
  gaps: z.array(quoteGapSchema).default([]),
});

/** Вид документа по сделке (`closing` — закрывающие: УПД, акт, накладная). */
export const DOCUMENT_KINDS = ['commercial_offer', 'invoice', 'contract', 'closing'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Строка документа. */
export interface DocumentLine {
  name: string;
  quantity: number;
  unitPrice: number;
  /** Единица, за которую дана цена; сверяется с КП (цена за упаковку и за штуку - разные). */
  unit?: string | undefined;
  /** Срок поставки по строке, дней; без него действует срок документа. */
  deliveryDays?: number | undefined;
  /** Сумма строки, если её указал источник: код сверяет её с количество × цена. */
  sum?: number | undefined;
  /** Характеристики позиции (из КП); без них в шаблоне пусто, сотрудника спрашивают. */
  characteristics?: string | undefined;
  /** Срок по позиции текстом («10 рабочих дней»); без него пусто, сотрудника спрашивают. */
  term?: string | undefined;
}
const documentLineSchema: z.ZodType<DocumentLine, z.ZodTypeDef, unknown> = z.object({
  name: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  unit: z.string().optional(),
  deliveryDays: z.number().optional(),
  sum: z.number().optional(),
  characteristics: z.string().optional(),
  term: z.string().optional(),
});

/** Откуда взято значение поля документа: сотрудник (чат), база знаний, веб-поиск. */
const FIELD_SOURCES = ['employee', 'knowledge', 'web'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];
const fieldSourceSchema = z.enum(FIELD_SOURCES);

/**
 * Документ с контрагентом или клиенту. Схема намеренно мягкая (без min/positive): полноту и
 * корректность проверяет `validateDocumentFields`, чтобы вернуть список замечаний, а не
 * первую ошибку. Сделки в CRM у документа нет: данные из чата, базы знаний и веб-поиска.
 */
export interface DealDocument {
  id: string;
  kind: DocumentKind;
  number: string;
  buyer: string;
  seller: string;
  lines: DocumentLine[];
  total: number;
  currency: string;
  issuedAt: string;
  dueDate?: string | undefined;
  /** Документ с поставщиком: id поставщика в базе (сверка реквизитов). */
  supplierId?: string | undefined;
  /** Заявка, по КП которой составлен документ (сверка сумм и условий). */
  requestId?: string | undefined;
  paymentTerms?: string | undefined;
  deliveryDays?: number | undefined;
  /** Реквизиты поставщика как в документе: ключи — поля Supplier (inn, kpp, bik...). */
  requisites?: Record<string, string> | undefined;
  /**
   * Поля шаблона договора, которые называет сотрудник (номер спецификации, срок гарантии,
   * контакты и т. п.): ключ - метка шаблона `{{метка}}`. Список допустимых меток держит код
   * агента документов; лишние ключи в шаблон не попадают.
   */
  templateFields?: Record<string, string> | undefined;
  /**
   * Ставка НДС, %: одна из `VAT_RATES_PERCENT`; вместе с `vatAmount` сверяется арифметикой
   * (НДС входит в итог).
   */
  vatRate?: number | undefined;
  /** Сумма НДС, входящая в итог. */
  vatAmount?: number | undefined;
  /**
   * Источник существенных полей: ключ - путь поля (`buyer`, `seller`, `requisites.inn`,
   * `lines.0.quantity`, `total`...); ключ родителя (`lines`, `requisites`) покрывает вложенные.
   */
  fieldSources?: Record<string, FieldSource> | undefined;
}
export const dealDocumentSchema: z.ZodType<DealDocument, z.ZodTypeDef, unknown> = z.object({
  // Служебный id не нужен для выдачи (ключи идемпотентности его исключают): забытый моделью
  // id не должен останавливать сборку договора.
  id: z.string().default(''),
  kind: z.enum(DOCUMENT_KINDS),
  // Пропуск не отказ по схеме: пустые значения превращаются в замечания-предупреждения
  // (`missing_field`, `no_lines`) и маркеры «[ЗАПОЛНИТЬ: ...]» в файле. Пустая валюта тоже
  // только предупреждение: значение (например RUB) молча не подставляется.
  number: z.string().default(''),
  buyer: z.string().default(''),
  seller: z.string().default(''),
  lines: z.array(documentLineSchema).default([]),
  total: z.number().default(0),
  currency: z.string().default(''),
  // Пустая дата = «сегодня»: подставляет слой приложения по часам (`withIssueDate`), схема
  // часов не знает.
  issuedAt: z.string().default(''),
  dueDate: z.string().optional(),
  supplierId: z.string().optional(),
  requestId: z.string().optional(),
  paymentTerms: z.string().optional(),
  deliveryDays: z.number().optional(),
  requisites: z.record(z.string()).optional(),
  templateFields: z.record(z.string()).optional(),
  // Ставку проверяет validateDocumentFields (vat_rate_invalid с перечнем); описание - модели.
  vatRate: z.number().optional().describe(VAT_RATE_DESCRIPTION),
  vatAmount: z.number().optional(),
  fieldSources: z.record(fieldSourceSchema).optional(),
});
