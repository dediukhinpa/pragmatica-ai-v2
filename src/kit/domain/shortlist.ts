import { z } from 'zod';
import {
  computeMarketAverage,
  dropPriceOutliers,
  marketAverageSchema,
  marketPriceSampleSchema,
  type MarketAverage,
  type MarketPriceSample,
} from './market-price';
import {
  SHORTLIST_COMPARE_POOL,
  SHORTLIST_ORDER_METHODS,
  SHORTLIST_REASON_MAX_CHARS,
  orderShortlistByRule,
  shortlistTierOf,
  type ShortlistOrderMethod,
} from './shortlist-compare';
import { locationIndexOf } from './shortlist-location';
import { SUPPLIER_RATING_RATIONALE_MAX_LENGTH } from './supplier-rating-verdict';
import { supplierEnrichmentSchema, type SupplierEnrichment } from './supplier-enrichment';
import {
  TELEGRAM_FIELDS,
  TELEGRAM_MAX_SHORTLIST_PLACES,
  TELEGRAM_SOURCE_MARK,
  type TelegramField,
} from './telegram-source';
import { PRICE_VAT_VALUES } from './models';
import { normalizeUnit } from './units';
import type { WebPrice } from './web-candidate';
import type { ValidationIssue } from '@business-ai/core';

/**
 * Источники поиска поставщиков (параллельно, по ТЗ процесса 1). `telegram` - закрытый
 * Telegram-канал (этап 216): ранжируется на уровне базы знаний, источник включается флагом.
 */
export const SUPPLIER_SOURCES = ['knowledge', 'web', 'telegram'] as const;
export type SupplierSource = (typeof SUPPLIER_SOURCES)[number];

/** Названия источников для сообщений менеджеру. */
export const SOURCE_LABELS: Record<SupplierSource, string> = {
  knowledge: 'база знаний',
  web: 'веб',
  telegram: TELEGRAM_SOURCE_MARK,
};

/**
 * Поля строки шорт-листа, которые могут быть взяты из интернета. Происхождение хранится по
 * полю (`webFields`), а не угадывается при показе: у строки после слияния базы и веба часть
 * сведений своя, часть найдена на сайте. Цены (`webPrice`, `webPrices`) в перечне нет: эти
 * поля по определению только из интернета и помечаются всегда.
 */
export const WEB_FIELDS = ['city', 'address', 'contacts', 'email', 'leadTime', 'site'] as const;
export type WebField = (typeof WEB_FIELDS)[number];

/** Является ли значение поддерживаемым источником (старые записи могли хранить другие). */
function isSupplierSource(value: unknown): value is SupplierSource {
  return SUPPLIER_SOURCES.some((source) => source === value);
}

/** Максимальный размер шорт-листа по умолчанию (менеджеру нужен обозримый список). */
export const SHORTLIST_MAX_SIZE = 10;

/** Юридические формы, которые не отличают одного поставщика от другого при дедупликации. */
const LEGAL_FORMS: ReadonlySet<string> = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'тоо']);
const NAME_TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * Статус поставщика из карточки (значения совпадают с `SupplierStatus` карточки; тип свой,
 * чтобы не зависеть от модуля карточки, который сам использует нормализацию названий).
 */
const CANDIDATE_STATUSES = ['active', 'new', 'inactive'] as const;
type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Вес статуса при ранжировании: действующий выше нового и поставщика без карточки. */
const STATUS_RANK: Readonly<Record<CandidateStatus, number>> = {
  active: 1,
  new: 0,
  inactive: 0,
};

/** Наименьшая оценка рейтинга и наибольшая (рейтинг из карточки: число 1..5 либо нет оценки). */
const CANDIDATE_RATING_MIN = 1;
const CANDIDATE_RATING_MAX = 5;

/**
 * Пометка рейтинга, полученного от модели. У оценки по запасному правилу пометки нет: так
 * считались все прежние записи, а её отсутствие не меняет отпечаток сохранённого шорт-листа.
 */
const MODEL_RATING_SOURCE = 'model';
type RatingSource = typeof MODEL_RATING_SOURCE;

/**
 * Сведения о поставщике для строки шорт-листа (ТЗ, разд. 4). Все поля необязательны: старые
 * сохранённые записи их не содержат, а веб-кандидат знает только название и адрес страницы.
 * Контакты (ФИО, телефон, email) лежат только в состоянии и в сообщении менеджеру, их строит
 * код; модели они не отдаются.
 */
interface SupplierDetails {
  /** Город производства из карточки. */
  city?: string | undefined;
  /** Фактический адрес склада и производства из карточки. */
  address?: string | undefined;
  /** Краткая строка контактов основного контакта: ФИО, телефон, email - только то, что есть. */
  contacts?: string | undefined;
  /** Лучшие цены поставщика из прайса базы знаний, по позициям заявки; из веба цен нет. */
  prices?: MarketPriceSample[] | undefined;
  /**
   * Цена веб-кандидата со страницы поставщика: число, валюта, единица. Нарочно НЕ в `prices`:
   * там цены прайсов «по нашей базе», а «среднюю по интернету» считают по этому полю.
   */
  webPrice?: WebPrice | undefined;
  /**
   * Цены веб-кандидата со страницы по позициям заявки (с 28.10; `webPrice` - у прежних
   * записей). Тоже НЕ в `prices`: средняя по интернету считается отдельно от базы.
   */
  webPrices?: MarketPriceSample[] | undefined;
  /** Срок поставки текстом из условий карточки (у веб-кандидата - со страницы). */
  leadTime?: string | undefined;
  /** Сайт из карточки: нужен ранжированию (чем занимается поставщик), в показ не идёт. */
  website?: string | undefined;
  /** Категории и бренды из карточки одной строкой - специализация для ранжирования. */
  specialization?: string | undefined;
  /** Рейтинг 1..5 по карточке; `null` и отсутствие - «нет оценки» (не ноль). */
  rating?: number | null | undefined;
  /** `model` - оценка модели; нет пометки при наличии оценки - запасное правило. */
  ratingSource?: RatingSource | undefined;
  /** Короткое обоснование оценки модели (проверено кодом); у оценки по правилу его нет. */
  ratingRationale?: string | undefined;
  /**
   * Устарело (28.10): пометка «нет контактов» больше не ставится и не показывается; поле
   * оставлено, чтобы читались сохранённые раньше предложения.
   */
  noContacts?: true | undefined;
  /**
   * Сведения, найденные в интернете для поставщика базы с неполной карточкой. В карточку без
   * подтверждения сотрудника не записываются; в списке идут с пометкой «из интернета».
   */
  webEnrichment?: SupplierEnrichment | undefined;
  /**
   * Какие из полей строки (город, адрес, контакты, почта, срок, сайт) взяты из интернета; в
   * показе у них пометка «ИЗ ИНТЕРНЕТА». Нет поля - ничего не из интернета (так читаются и
   * записи, сохранённые до появления поля).
   */
  webFields?: WebField[] | undefined;
  /**
   * Какие из полей строки взяты из Telegram-канала (город, контакты, почта, срок, цены); в
   * показе у них пометка «из Telegram-канала». Нет поля - ничего не из канала (так читаются и
   * записи, сохранённые до появления источника).
   */
  telegramFields?: TelegramField[] | undefined;
}
const supplierDetailsShape = {
  city: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  contacts: z.string().min(1).optional(),
  prices: z.array(marketPriceSampleSchema).optional(),
  webPrice: z
    .object({
      amount: z.number().positive(),
      currency: z.string().min(1),
      unit: z.string().min(1).optional(),
      note: z.string().min(1).optional(),
      vat: z.enum(PRICE_VAT_VALUES).optional(),
    })
    .optional(),
  webPrices: z.array(marketPriceSampleSchema).optional(),
  leadTime: z.string().min(1).optional(),
  website: z.string().min(1).optional(),
  specialization: z.string().min(1).optional(),
  rating: z.number().min(CANDIDATE_RATING_MIN).max(CANDIDATE_RATING_MAX).nullable().optional(),
  ratingSource: z.literal(MODEL_RATING_SOURCE).optional(),
  ratingRationale: z.string().min(1).max(SUPPLIER_RATING_RATIONALE_MAX_LENGTH).optional(),
  noContacts: z.literal(true).optional(),
  webEnrichment: supplierEnrichmentSchema.optional(),
  webFields: z.array(z.enum(WEB_FIELDS)).min(1).optional(),
  telegramFields: z.array(z.enum(TELEGRAM_FIELDS)).min(1).optional(),
};

/** Поставщик-кандидат, найденный одним источником. */
export interface SupplierCandidate extends SupplierDetails {
  name: string;
  /** Есть только у поставщиков из базы. У найденных вовне id присваивается при слиянии. */
  supplierId?: string | undefined;
  email?: string | undefined;
  /** Статус из карточки; нет - поставщик без карточки. `inactive` исключается из шорт-листа. */
  status?: CandidateStatus | undefined;
  /** Откуда взят кандидат: адрес страницы, id сообщения, id документа. Без текста с ПДн. */
  reference?: string | undefined;
  /** Релевантность по версии источника, от 0 до 1. */
  score: number;
}
const supplierCandidateSchema: z.ZodType<SupplierCandidate, z.ZodTypeDef, unknown> =
  z.object({
    name: z.string().min(1),
    supplierId: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    status: z.enum(CANDIDATE_STATUSES).optional(),
    reference: z.string().min(1).optional(),
    score: z.number().min(0).max(1),
    ...supplierDetailsShape,
  });

/** Итог поиска по одному источнику: недоступность источника — не ошибка всего поиска. */
export interface SourceResult {
  source: SupplierSource;
  status: 'ok' | 'unavailable';
  /** Код причины недоступности (не текст с деталями). */
  reason?: string | undefined;
  candidates: SupplierCandidate[];
}
export const sourceResultSchema: z.ZodType<SourceResult, z.ZodTypeDef, unknown> = z.object({
  source: z.enum(SUPPLIER_SOURCES),
  status: z.enum(['ok', 'unavailable']),
  reason: z.string().optional(),
  candidates: z.array(supplierCandidateSchema),
});

/** Строка шорт-листа: поставщик, источники, по которым он найден, и оценка. */
export interface ShortlistEntry extends SupplierDetails {
  supplierId: string;
  name: string;
  email?: string | undefined;
  sources: SupplierSource[];
  score: number;
  references: string[];
  /**
   * Поставщика назвал сотрудник в заявке или сообщении: строка добавлена вне лимита
   * ранжирования (иначе дорогой названный поставщик вытеснялся дешёвыми и его нельзя было
   * выбрать, бой 29.10). В списке идёт первой с пометкой «вы указали».
   */
  namedByManager?: true | undefined;
  /**
   * Карточка названного сотрудником поставщика со статусом «не работаем»: автоматически такие
   * исключаются, но по прямому указанию сотрудника строка остаётся, с пометкой в списке.
   */
  namedInactive?: true | undefined;
  /**
   * К какой из названных локаций отнесён поставщик (как назвал сотрудник); нет поля - локацию
   * не называли или поставщик в неё не попал. Ставит код при сборке шорт-листа.
   */
  locationGroup?: string | undefined;
  /** Почему модель взяла поставщика в список (коротко); нет - порядок дало правило. */
  rankReason?: string | undefined;
}
const shortlistEntrySchema: z.ZodType<ShortlistEntry, z.ZodTypeDef, unknown> = z.object({
  supplierId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().min(1).optional(),
  sources: z.array(z.enum(SUPPLIER_SOURCES)).min(1),
  score: z.number(),
  references: z.array(z.string()),
  namedByManager: z.literal(true).optional(),
  namedInactive: z.literal(true).optional(),
  locationGroup: z.string().min(1).optional(),
  rankReason: z.string().min(1).max(SHORTLIST_REASON_MAX_CHARS).optional(),
  ...supplierDetailsShape,
});

/** Запись, у которой есть массив по ключу (для тихой чистки устаревших источников). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Чистка сохранённого шорт-листа от источников, которых больше нет (например, прежний
 * «community»): такие статусы отбрасываются, из строк убираются устаревшие источники, а строки,
 * найденные только ими, пропускаются. Остальные данные не меняются.
 */
function dropLegacySources(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const cleaned: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.sources)) {
    cleaned.sources = raw.sources.filter(
      (item) => !isRecord(item) || isSupplierSource(item.source),
    );
  }
  if (Array.isArray(raw.entries)) {
    cleaned.entries = raw.entries.flatMap((entry: unknown) => {
      if (!isRecord(entry) || !Array.isArray(entry.sources)) return [entry];
      const sources = entry.sources.filter(isSupplierSource);
      return sources.length === 0 ? [] : [{ ...entry, sources }];
    });
  }
  return cleaned;
}

/** Состояние источника в шорт-листе: ok, недоступен или вообще не запрашивался. */
export interface SourceStatus {
  source: SupplierSource;
  status: 'ok' | 'unavailable' | 'not_searched';
  reason?: string | undefined;
}
const sourceStatusSchema: z.ZodType<SourceStatus, z.ZodTypeDef, unknown> = z.object({
  source: z.enum(SUPPLIER_SOURCES),
  status: z.enum(['ok', 'unavailable', 'not_searched']),
  reason: z.string().optional(),
});

/** Предложенный менеджеру шорт-лист по заявке (из него менеджер выбирает адресатов). */
export interface ShortlistProposal {
  requestId: string;
  /** Отпечаток состава: меняется, если состав или статусы источников изменились. */
  version: string;
  createdAt: string;
  /** Тред менеджера по закупу, куда уходят вопрос, напоминание. */
  managerThreadId: string;
  entries: ShortlistEntry[];
  /** Сколько кандидатов не вошло из-за ограничения размера. */
  truncated: number;
  sources: SourceStatus[];
  /**
   * Средняя стоимость по рынку, посчитанная кодом при сборке. Нет в записях, сохранённых до
   * появления поля: тогда в сообщении менеджеру «не рассчитывалась», а не «цен нет».
   */
  market?: MarketAverage | undefined;
  /**
   * Средняя по интернету: по ценам обогащённых веб-кандидатов (`webPrice`). Нет в записях,
   * сохранённых до появления поля.
   */
  webMarket?: MarketAverage | undefined;
  /**
   * Средняя по цен закрытого Telegram-канала (этап 216): отдельно от базы и интернета, без
   * выбросов по медиане. Нет поля - у канала цен не нашлось (или источник выключен).
   */
  telegramMarket?: MarketAverage | undefined;
  /**
   * Сколько цен со страниц веб-кандидатов не усреднено, потому что в заявке несколько позиций,
   * а цена страницы не привязана к позиции. Нет поля - такого не было.
   */
  webPricesUnmatched?: number | undefined;
  /**
   * Сколько кандидатов сравнивалось по критериям (срок, цена, рейтинг) и чем упорядочен
   * список: `model` - порядок дала модель, `rule` - правило кода. Нет в записях, сохранённых
   * до появления полей.
   */
  compared?: number | undefined;
  orderMethod?: ShortlistOrderMethod | undefined;
}
export const shortlistProposalSchema: z.ZodType<ShortlistProposal, z.ZodTypeDef, unknown> =
  z.preprocess(
    dropLegacySources,
    z.object({
      requestId: z.string().min(1),
      version: z.string().min(1),
      createdAt: z.string(),
      managerThreadId: z.string().min(1),
      entries: z.array(shortlistEntrySchema),
      truncated: z.number().int().nonnegative(),
      sources: z.array(sourceStatusSchema),
      market: marketAverageSchema.optional(),
      webMarket: marketAverageSchema.optional(),
      telegramMarket: marketAverageSchema.optional(),
      webPricesUnmatched: z.number().int().positive().optional(),
      compared: z.number().int().positive().optional(),
      orderMethod: z.enum(SHORTLIST_ORDER_METHODS).optional(),
    }),
  );

/** Название для сравнения: без регистра, знаков, кавычек и юридической формы. */
export function normalizeSupplierName(name: string): string {
  const tokens = (name.toLowerCase().replaceAll('ё', 'е').match(NAME_TOKEN) ?? []).filter(
    (token) => token !== '',
  );
  const significant = tokens.filter((token) => !LEGAL_FORMS.has(token));
  return (significant.length > 0 ? significant : tokens).join(' ');
}

/** Параметры слияния кандидатов. */
export interface MergeOptions {
  /** Сколько строк оставить в шорт-листе. */
  limit: number;
  /** Идентификатор для кандидата не из базы: детерминированный по нормализованному названию. */
  externalId: (normalizedName: string) => string;
  /**
   * Сколько позиций в заявке. Нет значения - позиция одна. Цена веб-страницы к позиции не
   * привязана, поэтому «средняя по интернету» считается только для заявки из одной позиции.
   */
  positionCount?: number | undefined;
  /** Сколько кандидатов сравнивать; по умолчанию `SHORTLIST_COMPARE_POOL`. */
  poolSize?: number | undefined;
  /** Названные сотрудником локации по порядку упоминания: их поставщики идут первыми. */
  locations?: readonly string[] | undefined;
}

interface Group {
  supplierId: string;
  name: string;
  email: string | undefined;
  status: CandidateStatus | undefined;
  sources: Set<SupplierSource>;
  score: number;
  /** Найден ли поставщик в нашей базе (есть `supplierId` у одного из кандидатов). */
  fromBase: boolean;
  references: string[];
  city: string | undefined;
  address: string | undefined;
  contacts: string | undefined;
  prices: Map<string, MarketPriceSample>;
  webPrice: WebPrice | undefined;
  webPrices: MarketPriceSample[] | undefined;
  leadTime: string | undefined;
  website: string | undefined;
  specialization: string | undefined;
  rating: number | null | undefined;
  ratingSource: RatingSource | undefined;
  ratingRationale: string | undefined;
  noContacts: true | undefined;
  /** Поля, чьё значение взято у веб-кандидата (см. `webFields` строки). */
  webFields: Set<WebField>;
  /** Поля, чьё значение взято у кандидата из Telegram-канала (см. `telegramFields` строки). */
  telegramFields: Set<TelegramField>;
}

/** Результат слияния. */
export interface MergeOutcome {
  /** Показанные строки: пул, упорядоченный правилом кода (без модели), не больше `limit`. */
  entries: ShortlistEntry[];
  /**
   * Пул для сравнения (до `poolSize` кандидатов, с гарантированными местами веба) в порядке
   * ярусного ранжирования; нет поля - кандидатов нет. Модель упорядочивает именно его.
   */
  pool?: ShortlistEntry[] | undefined;
  /** Сколько активных кандидатов не показано (из пула и сверх него). */
  truncated: number;
  /**
   * Средняя стоимость по ценам всех найденных поставщиков, кроме «не работаем». Нет поля -
   * цен не нашлось вовсе (то же, что `{ status: 'none' }`).
   */
  market?: MarketAverage | undefined;
  /**
   * Средняя по интернету: цены `webPrice` веб-кандидатов, кроме «не работаем». Нет поля -
   * веб-цен не нашлось. Валюты не смешиваются: у каждой валюты своя группа.
   */
  webMarket?: MarketAverage | undefined;
  /** Средняя по ценам Telegram-канала (без выбросов); нет поля - у канала цен нет. */
  telegramMarket?: MarketAverage | undefined;
  /** Цен веб-кандидатов, не вошедших в среднюю из-за нескольких позиций заявки (нет - 0). */
  webPricesUnmatched?: number | undefined;
  /** Сколько поставщиков исключено, потому что у карточки статус «не работаем» (нет - 0). */
  excludedInactive?: number | undefined;
}

/**
 * Объединить кандидатов источников в шорт-лист без участия модели: дедупликация по поставщику
 * (id из базы либо нормализованное название), у каждого перечислены источники. Ярусное
 * ранжирование (база с ценами, база по карточке, веб; внутри яруса - больше источников,
 * «действующий» выше «нового», оценка, e-mail, название) только отбирает пул сравнения до
 * `poolSize` с гарантированными `webMinSlots` местами веба. Показ упорядочен по критериям
 * владельца (`compareByCriteria`: срок, цена, рейтинг), при равенстве - по ярусу; модель
 * может переупорядочить `pool` сама. Поставщик, у которого хоть один источник назвал статус
 * «не работаем», в шорт-лист не попадает (и не вытесняется внешним кандидатом с тем же
 * названием); число таких - в `excludedInactive`. Недоступные источники кандидатов не дают.
 * Результат ограничен `limit`.
 */
export function mergeCandidates(
  results: readonly SourceResult[],
  options: MergeOptions,
): MergeOutcome {
  const groups = new Map<string, Group>();
  const byName = new Map<string, Group>();
  const pairs = results
    .filter((result) => result.status === 'ok')
    .flatMap((result) =>
      result.candidates.map((candidate) => ({ source: result.source, candidate })),
    );
  // Сначала поставщики из базы: внешние кандидаты с тем же названием присоединяются к ним.
  const fromBase = (pair: { candidate: SupplierCandidate }): number =>
    Number(pair.candidate.supplierId !== undefined);
  pairs.sort((a, b) => fromBase(b) - fromBase(a));
  for (const { source, candidate } of pairs) {
    const normalized = normalizeSupplierName(candidate.name);
    const supplierId =
      candidate.supplierId ??
      byName.get(normalized)?.supplierId ??
      options.externalId(normalized);
    let group = groups.get(supplierId);
    if (group === undefined) {
      group = {
        supplierId,
        name: candidate.name,
        // Почта берётся ниже вместе с происхождением (`adoptField`): прежний `??=` тот же.
        email: undefined,
        status: undefined,
        sources: new Set(),
        score: 0,
        fromBase: false,
        references: [],
        city: undefined,
        address: undefined,
        contacts: undefined,
        prices: new Map(),
        webPrice: undefined,
        webPrices: undefined,
        leadTime: undefined,
        website: undefined,
        specialization: undefined,
        rating: undefined,
        ratingSource: undefined,
        ratingRationale: undefined,
        noContacts: undefined,
        webFields: new Set(),
        telegramFields: new Set(),
      };
      groups.set(supplierId, group);
    }
    byName.set(normalized, group);
    group.sources.add(source);
    group.score = Math.max(group.score, candidate.score);
    // Кандидат канала ранжируется как поставщик базы знаний (решение владельца, этап 216): его
    // берёт в пул то же правило «сначала база», что и карточки с `supplierId`.
    group.fromBase ||= candidate.supplierId !== undefined || source === 'telegram';
    // Происхождение полей: пометка «ИЗ ИНТЕРНЕТА» ставится только тем полям, значение которых
    // группа взяла именно у веб-кандидата (у базы поле уже есть - остаётся без пометки);
    // «из Telegram-канала» - по тому же правилу для кандидата канала.
    const fromWeb = candidateWebFields(source, candidate);
    const fromTelegram = candidateTelegramFields(source, candidate);
    const origin = (field: AdoptedField): FieldOrigin => {
      if ((fromWeb as ReadonlySet<string>).has(field)) return 'web';
      return (fromTelegram as ReadonlySet<string>).has(field) ? 'telegram' : undefined;
    };
    adoptField(group, 'email', candidate.email, origin('email'));
    adoptField(group, 'city', candidate.city, origin('city'));
    adoptField(group, 'address', candidate.address, origin('address'));
    adoptField(group, 'contacts', candidate.contacts, origin('contacts'));
    group.webPrice ??= candidate.webPrice;
    group.webPrices ??= candidate.webPrices;
    group.noContacts ??= candidate.noContacts;
    adoptField(group, 'leadTime', candidate.leadTime, origin('leadTime'));
    // Сайт и специализация идут только из карточки базы: у них нет пометки происхождения, а
    // веб-кандидат их и не ставит (сайт веб-кандидата - `reference`, поле `site` в `webFields`).
    if (source !== 'web') {
      group.website ??= candidate.website;
      group.specialization ??= candidate.specialization;
    }
    // Рейтинг, источник и обоснование берутся вместе из одного кандидата. Условие прежнее
    // (`??=`): пока оценки нет (undefined или null), её занимает следующий кандидат, в том
    // числе пустым значением; от этого зависит состав записи и отпечаток шорт-листа.
    if (group.rating === undefined || group.rating === null) {
      group.rating = candidate.rating;
      group.ratingSource = candidate.ratingSource;
      group.ratingRationale = candidate.ratingRationale;
    }
    // Происхождение цены хранится у самой цены: цены канала несут признак, даже если
    // источник его не поставил (кандидат источника `telegram` целиком из канала).
    for (const price of candidate.prices ?? []) {
      addPrice(group.prices, source === 'telegram' ? { ...price, fromTelegram: true } : price);
    }
    group.status = mergeStatus(group.status, candidate.status);
    if (candidate.reference !== undefined && !group.references.includes(candidate.reference)) {
      group.references.push(candidate.reference);
      if (fromWeb.has('site')) group.webFields.add('site');
    }
  }
  const all = [...groups.values()];
  const cappedOut = capTelegramPlaces(all);
  const active = all.filter((group) => group.status !== 'inactive' && !cappedOut.has(group));
  const entryOf = new Map(active.map((group) => [group.supplierId, toEntry(group)]));
  const tierOf = (group: Group): number => {
    const entry = entryOf.get(group.supplierId);
    return entry === undefined ? 0 : shortlistTierOf(entry);
  };
  // Порядок набора пула - по ярусам цен (база с подходящей ценой, веб с ценой, похожие товары,
  // без цены): фиксированных мест веба нет, он добирает то, чего не хватило базе (решение
  // владельца, этап 135). Внутри яруса - больше источников, «действующий» выше «нового».
  const locations = options.locations ?? [];
  const ranked = active.sort(
    (a, b) =>
      // Топ собирается из базы, интернет только добирает места (этап 143): база в пул первой,
      // внутри неё - названные локации, чтобы их поставщики не отсеялись при обрезке пула.
      Number(b.fromBase) - Number(a.fromBase) ||
      locationIndexOf(a, locations) - locationIndexOf(b, locations) ||
      tierOf(b) - tierOf(a) ||
      // Внутри яруса поставщик с карточкой в базе выше веб-кандидата (в хвосте без цен тоже).
      Number(b.fromBase) - Number(a.fromBase) ||
      b.sources.size - a.sources.size ||
      statusRank(b.status) - statusRank(a.status) ||
      b.score - a.score ||
      Number(b.email !== undefined) - Number(a.email !== undefined) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  // Рынок - все найденные цены, а не только показанных строк; «не работаем» не ориентир.
  // Цены канала в среднюю по базе не входят (у них своя средняя ниже): они не проходят отбор
  // прайсов базы и искажали бы «среднюю по нашей базе».
  const allPrices = active.flatMap((group) => [...group.prices.values()]);
  const market = computeMarketAverage(allPrices.filter((price) => price.fromTelegram !== true));
  // Канал: цены прошли проверку соответствия при разборе постов, но выбросы по медиане
  // отсекаются и здесь (как у интернета): одна цена за другую фасовку не должна двигать среднюю.
  const telegramMarket = computeMarketAverage(
    dropPriceOutliers(allPrices.filter((price) => price.fromTelegram === true)),
  );
  // Интернет - отдельная средняя по ценам со страниц. Цены по позициям (`webPrices`, с 28.10)
  // усредняются по позициям, как база. Прежняя одна цена без позиции (`webPrice`) при
  // нескольких позициях заявки не усредняется: цены разных товаров смешались бы в одно число.
  // Цены со страниц не проходят проверку соответствия товара, поэтому явные выбросы по медиане
  // (8,63 ₽ за часы) отсекаются здесь, а не попадают в среднюю.
  const singlePosition = (options.positionCount ?? 1) <= 1;
  const itemPrices = active.flatMap((group) => group.webPrices ?? []);
  const legacyPrices = active.flatMap((group) =>
    group.webPrices === undefined && group.webPrice !== undefined ? [group.webPrice] : [],
  );
  const webMarket = computeMarketAverage(
    dropPriceOutliers(singlePosition ? [...itemPrices, ...legacyPrices] : itemPrices),
  );
  const webPricesUnmatched = singlePosition ? 0 : legacyPrices.length;
  const poolLimit = options.poolSize ?? SHORTLIST_COMPARE_POOL;
  const pool = ranked
    .slice(0, poolLimit)
    .map((group) => entryOf.get(group.supplierId) ?? toEntry(group));
  // Без модели порядок даёт правило; с моделью шорт-лист пересоберёт её ответ (по тем же ярусам).
  const kept = orderShortlistByRule(pool, options.limit, locations, poolLimit);
  return {
    entries: kept,
    ...(pool.length === 0 ? {} : { pool }),
    ...(market.status === 'none' ? {} : { market }),
    ...(webMarket.status === 'none' ? {} : { webMarket }),
    ...(telegramMarket.status === 'none' ? {} : { telegramMarket }),
    ...(webPricesUnmatched === 0 ? {} : { webPricesUnmatched }),
    truncated: ranked.length - kept.length + cappedOut.size,
    ...(all.length - cappedOut.size > active.length
      ? { excludedInactive: all.length - cappedOut.size - active.length }
      : {}),
  };
}

/** Строка шорт-листа из группы слияния. */
function toEntry(group: Group): ShortlistEntry {
  return {
    supplierId: group.supplierId,
    name: group.name,
    ...(group.email === undefined ? {} : { email: group.email }),
    sources: SUPPLIER_SOURCES.filter((source) => group.sources.has(source)),
    score: group.score,
    references: group.references,
    ...(group.city === undefined ? {} : { city: group.city }),
    ...(group.address === undefined ? {} : { address: group.address }),
    ...(group.contacts === undefined ? {} : { contacts: group.contacts }),
    ...(group.prices.size === 0 ? {} : { prices: [...group.prices.values()] }),
    ...(group.webPrice === undefined ? {} : { webPrice: group.webPrice }),
    ...(group.webPrices === undefined ? {} : { webPrices: group.webPrices }),
    ...(group.leadTime === undefined ? {} : { leadTime: group.leadTime }),
    ...(group.website === undefined ? {} : { website: group.website }),
    ...(group.specialization === undefined ? {} : { specialization: group.specialization }),
    ...(group.rating === undefined ? {} : { rating: group.rating }),
    ...(group.ratingSource === undefined ? {} : { ratingSource: group.ratingSource }),
    ...(group.ratingRationale === undefined ? {} : { ratingRationale: group.ratingRationale }),
    ...(group.noContacts === undefined ? {} : { noContacts: group.noContacts }),
    ...(group.webFields.size === 0
      ? {}
      : { webFields: WEB_FIELDS.filter((field) => group.webFields.has(field)) }),
    ...(telegramFieldsOfGroup(group).length === 0
      ? {}
      : { telegramFields: telegramFieldsOfGroup(group) }),
  };
}

/** Поля группы из канала в порядке перечня; «цены» - если хоть одна цена группы из канала. */
function telegramFieldsOfGroup(group: Group): TelegramField[] {
  return TELEGRAM_FIELDS.filter((field) =>
    field === 'prices'
      ? [...group.prices.values()].some((price) => price.fromTelegram === true)
      : group.telegramFields.has(field),
  );
}

/** Есть ли у группы цена, которую не отнести к приблизительной (проверенная). */
function hasVerifiedPrice(group: Group): boolean {
  return [...group.prices.values()].some((price) => price.approximate !== true);
}

/**
 * Группы канала без карточки в базе, не уместившиеся в `TELEGRAM_MAX_SHORTLIST_PLACES`: канал
 * ранжируется на уровне базы, но не вытесняет её целиком. Остаются лучшие: с проверенной ценой,
 * затем по оценке и названию. Поставщик, найденный и в базе, под предел не попадает.
 */
function capTelegramPlaces(groups: readonly Group[]): Set<Group> {
  const channelOnly = groups
    .filter(
      (group) =>
        group.status !== 'inactive' &&
        group.sources.has('telegram') &&
        !group.sources.has('knowledge'),
    )
    .sort(
      (a, b) =>
        Number(hasVerifiedPrice(b)) - Number(hasVerifiedPrice(a)) ||
        b.score - a.score ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  return new Set(channelOnly.slice(TELEGRAM_MAX_SHORTLIST_PLACES));
}

/** Строковые поля группы, которые берутся у кандидата «первое непустое» и помечаются. */
type AdoptedField = 'email' | 'city' | 'address' | 'contacts' | 'leadTime';

/** Откуда взято значение поля: из интернета, из Telegram-канала или своё (база). */
type FieldOrigin = 'web' | 'telegram' | undefined;

/**
 * Взять значение у кандидата, если у группы его ещё нет (прежнее `??=`), и запомнить, откуда
 * оно: из интернета или из канала, когда кандидат отнёс поле к своим помеченным полям.
 */
function adoptField(
  group: Group,
  field: AdoptedField,
  value: string | undefined,
  origin: FieldOrigin,
): void {
  if (group[field] !== undefined || value === undefined) return;
  group[field] = value;
  if (origin === 'web') group.webFields.add(field);
  if (origin === 'telegram' && isTelegramField(field)) group.telegramFields.add(field);
}

/** Является ли поле одним из полей, которые помечаются как взятые из канала. */
function isTelegramField(field: string): field is TelegramField {
  return TELEGRAM_FIELDS.some((known) => known === field);
}

/** Абсолютная ссылка: только такая годится как «Сайт» (в `references` бывают и id документов). */
const SITE_URL = /^https?:\/\/\S+$/u;

/**
 * Поля веб-кандидата, взятые со страницы: заполненные город, адрес, контакты, почта, срок и
 * сайт (ссылка в `reference`). Вызывает тот, кто создаёт веб-кандидата, один раз; слияние и
 * показ только читают результат.
 */
export function webFieldsOfCandidate(candidate: SupplierCandidate): WebField[] {
  return presentWebFields(candidate, candidate.reference);
}

/** Какие из веб-полей заполнены у сведений; сайт - если дана абсолютная ссылка. */
function presentWebFields(
  details: Pick<SupplierCandidate, 'city' | 'address' | 'contacts' | 'email' | 'leadTime'>,
  siteReference: string | undefined,
): WebField[] {
  const present: Record<WebField, boolean> = {
    city: details.city !== undefined,
    address: details.address !== undefined,
    contacts: details.contacts !== undefined,
    email: details.email !== undefined,
    leadTime: details.leadTime !== undefined,
    site: siteReference !== undefined && SITE_URL.test(siteReference),
  };
  return WEB_FIELDS.filter((field) => present[field]);
}

/**
 * Веб-поля строки шорт-листа при показе. Явные `webFields` - как сохранены. Запись, сохранённая
 * до появления поля, у которой единственный источник - «web», выводится из заполненных сведений
 * (всё, что есть у веб-кандидата, найдено в сети; так же читает старые записи `mergeCandidates`).
 * Старая запись с базой и вебом вместе остаётся без вывода: чьё значение, не восстановить, а
 * пометить сведения базы как интернет было бы неверно.
 */
export function webFieldsOfEntry(entry: ShortlistEntry): readonly WebField[] {
  if (entry.webFields !== undefined) return entry.webFields;
  const webOnly = entry.sources.length > 0 && entry.sources.every((source) => source === 'web');
  if (!webOnly) return [];
  return presentWebFields(entry, entry.references.find((item) => SITE_URL.test(item)));
}

/**
 * Веб-поля кандидата при слиянии: явные `webFields`; запись источника «web», сохранённая до
 * появления поля, - выводится из заполненных сведений (всё, что у веб-кандидата есть, найдено
 * в интернете); кандидат базы - пусто.
 */
function candidateWebFields(
  source: SupplierSource,
  candidate: SupplierCandidate,
): ReadonlySet<WebField> {
  if (candidate.webFields !== undefined) return new Set(candidate.webFields);
  return new Set(source === 'web' ? webFieldsOfCandidate(candidate) : []);
}

/**
 * Поля кандидата из Telegram-канала: заполненные город, контакты, почта, срок и цены. Вызывает
 * тот, кто создаёт кандидата канала, один раз; слияние и показ только читают результат.
 */
export function telegramFieldsOfCandidate(
  candidate: Pick<SupplierCandidate, 'city' | 'contacts' | 'email' | 'leadTime' | 'prices'>,
): TelegramField[] {
  const present: Record<TelegramField, boolean> = {
    city: candidate.city !== undefined,
    contacts: candidate.contacts !== undefined,
    email: candidate.email !== undefined,
    leadTime: candidate.leadTime !== undefined,
    prices: (candidate.prices ?? []).length > 0,
  };
  return TELEGRAM_FIELDS.filter((field) => present[field]);
}

/**
 * Поля кандидата из канала при слиянии: явные `telegramFields`; запись источника «telegram»
 * без поля - выводится из заполненных сведений (всё, что у кандидата канала есть, найдено в
 * канале); кандидат другого источника - пусто.
 */
function candidateTelegramFields(
  source: SupplierSource,
  candidate: SupplierCandidate,
): ReadonlySet<TelegramField> {
  if (candidate.telegramFields !== undefined) return new Set(candidate.telegramFields);
  return new Set(source === 'telegram' ? telegramFieldsOfCandidate(candidate) : []);
}

/** Есть ли среди цен хоть одна точная (не приблизительная). */
export function hasExactPrice(prices: readonly MarketPriceSample[] | undefined): boolean {
  return (prices ?? []).some((price) => price.approximate !== true);
}

/** Ключ цены поставщика: позиция, валюта, единица (без регистра). */
function priceKey(price: MarketPriceSample): string {
  const unit = price.unit === undefined ? '' : normalizeUnit(price.unit);
  const parts = [price.item ?? '', price.currency, unit];
  return JSON.stringify(parts.map((part) => part.trim().toLowerCase()));
}

/**
 * Добавить цену поставщика; для одной позиции, валюты и единицы остаётся одна. Точная цена
 * важнее приблизительной, даже если та ниже: иначе чужой товар вытеснил бы нашу. Среди равных по
 * точности цена базы важнее цены канала даже при большей сумме (канал не подменяет базу и
 * её среднюю); затем самая низкая. Признак происхождения едет вместе с выигравшей ценой.
 */
function addPrice(prices: Map<string, MarketPriceSample>, price: MarketPriceSample): void {
  const key = priceKey(price);
  const known = prices.get(key);
  if (known === undefined) {
    prices.set(key, price);
    return;
  }
  const knownApproximate = known.approximate === true;
  const priceApproximate = price.approximate === true;
  const knownChannel = known.fromTelegram === true;
  const priceChannel = price.fromTelegram === true;
  const better =
    knownApproximate !== priceApproximate
      ? knownApproximate
      : knownChannel !== priceChannel
        ? knownChannel
        : price.amount < known.amount;
  if (better) prices.set(key, price);
}

function statusRank(status: CandidateStatus | undefined): number {
  return status === undefined ? 0 : STATUS_RANK[status];
}

/** «Не работаем» сильнее всего; затем «действующий»; «новый» - если других сведений нет. */
function mergeStatus(
  current: CandidateStatus | undefined,
  next: CandidateStatus | undefined,
): CandidateStatus | undefined {
  if (current === 'inactive' || next === 'inactive') return 'inactive';
  if (current === 'active' || next === 'active') return 'active';
  return current ?? next;
}

/** Выбор менеджера должен быть непустым подмножеством предложенного шорт-листа. */
export function validateShortlistSelection(
  selectedSupplierIds: readonly string[],
  proposal: ShortlistProposal,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (selectedSupplierIds.length === 0) {
    issues.push({ code: 'no_selection', message: 'Не выбран ни один поставщик.' });
  }
  const proposed = new Set(proposal.entries.map((entry) => entry.supplierId));
  for (const id of new Set(selectedSupplierIds)) {
    if (!proposed.has(id)) {
      issues.push({
        code: 'not_in_proposal',
        message: `Поставщик ${id} не предлагался в шорт-листе заявки ${proposal.requestId}.`,
      });
    }
  }
  return issues;
}

/**
 * Цены веб-кандидата со страницы для показа и сравнения: по позициям (`webPrices`), у прежних
 * записей - одна цена без позиции (`webPrice`).
 */
export function webPricesOf(
  entry: Pick<SupplierDetails, 'webPrice' | 'webPrices'>,
): MarketPriceSample[] {
  if (entry.webPrices !== undefined) return entry.webPrices;
  return entry.webPrice === undefined ? [] : [entry.webPrice];
}
