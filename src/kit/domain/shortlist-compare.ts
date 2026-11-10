import type { MarketPriceSample } from './market-price';
import { REQUEST_ITEM_REQUIREMENTS_MAX_CHARS } from './models';
import { webPricesOf, type ShortlistEntry } from './shortlist';
import { groupByLocation, prioritizeByLocation } from './shortlist-location';
import { normalizeUnit } from './units';

/**
 * Сравнение кандидатов шорт-листа по критериям владельца (решение 29.10): сначала те, у кого
 * цена есть по большему числу позиций заявки (точная лучше цены «похожего товара»), при равном
 * покрытии - наименьшая стоимость, затем наличие контактов, город и срок (наименее критичны),
 * рейтинг - последним (он может быть необъективен). Порядок предлагает модель по фактам, а код
 * его проверяет; при сбое модели тот же порядок строит `compareByCriteria`. Здесь только чистые
 * функции.
 */

/** Сколько кандидатов из базы и веба вместе сравнивается (пул). */
export const SHORTLIST_COMPARE_POOL = 20;
/** Самая длинная причина выбора от модели в шорт-листе (знаки). */
export const SHORTLIST_REASON_MAX_CHARS = 160;

/** Чем упорядочен шорт-лист: ответом модели либо правилом кода. */
export const SHORTLIST_ORDER_METHODS = ['model', 'rule'] as const;
export type ShortlistOrderMethod = (typeof SHORTLIST_ORDER_METHODS)[number];

/** Сутки в сроке, выраженном неделями и месяцами. */
const DAYS_IN_WEEK = 7;
const DAYS_IN_MONTH = 30;
/** Единица срока из текста: приставка слова -> число суток. */
const LEAD_UNIT_DAYS: ReadonlyArray<readonly [string, number]> = [
  ['дн', 1],
  ['ден', 1],
  ['сут', 1],
  ['нед', DAYS_IN_WEEK],
  ['мес', DAYS_IN_MONTH],
];
/** «3», «3-5», «3–5 рабочих дней», «2 недели»: число, необязательный конец диапазона, единица. */
const LEAD_NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const LEAD_RANGE_END = String.raw`(?:\s*[-\u2013\u2014]\s*(\d+(?:[.,]\d+)?))?`;
const LEAD_WORKING_WORD = String.raw`(?:(?:рабоч|календарн)\p{L}*\s+)?`;
const LEAD_TIME_PATTERN = new RegExp(
  `${LEAD_NUMBER}${LEAD_RANGE_END}\\s*${LEAD_WORKING_WORD}(\\p{L}+)`,
  'giu',
);

/**
 * Срок поставки текстом -> сутки. «N дней» -> N, «N-M дней» -> M (по худшему случаю: срок
 * важен как гарантия), «N недель» -> 7N, «N месяцев» -> 30N. Не разобрано - `undefined`.
 */
export function parseLeadTimeDays(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  // Первое число с единицей срока: «от 100 шт, срок 5 дней» - это 5 дней, а не «100 шт».
  for (const match of text.matchAll(LEAD_TIME_PATTERN)) {
    const unit = (match[3] ?? '').toLowerCase();
    const days = LEAD_UNIT_DAYS.find(([prefix]) => unit.startsWith(prefix))?.[1];
    if (days === undefined) continue;
    const amount = Number((match[2] ?? match[1] ?? '').replace(',', '.'));
    if (Number.isFinite(amount)) return amount * days;
  }
  return undefined;
}

/** Точная цена: не приблизительная, не «от»/диапазон и не скидка от суммы заказа. */
function isExactPrice(price: MarketPriceSample): boolean {
  return (
    price.approximate !== true && price.qualifier === undefined && price.tierBasis !== 'order_sum'
  );
}

/** Ключ позиции заявки: без регистра, «ё» как «е»; цена без позиции - общий пустой ключ. */
function positionKey(item: string | undefined): string {
  return (item ?? '').trim().toLowerCase().replaceAll('ё', 'е');
}

/**
 * Ключ позиции, валюты и единицы: цены сравнимы только внутри одного ключа. Единица
 * нормализуется, чтобы «кг» и «килограмм» с разных сайтов попадали в одну группу.
 */
function comparableKey(price: Pick<MarketPriceSample, 'item' | 'currency' | 'unit'>): string {
  const unit = price.unit === undefined ? '' : normalizeUnit(price.unit);
  return JSON.stringify([positionKey(price.item), price.currency.trim().toLowerCase(), unit]);
}

/** Все цены кандидата: из прайсов базы и со страницы сайта (у базы и веба одинаково). */
function allPricesOf(entry: ShortlistEntry): MarketPriceSample[] {
  return [...(entry.prices ?? []), ...webPricesOf(entry)];
}

/** Все точные цены кандидата. */
function exactPricesOf(entry: ShortlistEntry): MarketPriceSample[] {
  return allPricesOf(entry).filter(isExactPrice);
}

/** Покрытие позиций заявки ценами: сколько позиций с любой ценой и сколько - с точной. */
export interface PriceCoverage {
  covered: number;
  exact: number;
}

/**
 * Покрытие позиций ценами: считается одинаково для кандидатов базы и веба (по ключу позиции
 * из прайсов и цен страницы), поэтому у «Тайгарики» с ценами по обеим позициям покрытие 2.
 */
export function priceCoverageOf(entry: ShortlistEntry): PriceCoverage {
  const all = new Set(allPricesOf(entry).map((price) => positionKey(price.item)));
  const exact = new Set(exactPricesOf(entry).map((price) => positionKey(price.item)));
  return { covered: all.size, exact: exact.size };
}

/** Оценка цены группы из одного кандидата: сравнить не с кем, поэтому нейтрально. */
const LONE_PRICE_SCORE = 0.5;

/**
 * «Дороговизна» каждого кандидата от 0 (дешевле всех) до 1 (дороже всех): средний нормированный
 * ранг его точных цен в группах «позиция + валюта + единица». Ранг, а не доля от минимума, чтобы
 * один выброс (цена за другую фасовку) не ломал масштаб; группа из одного кандидата получает
 * нейтральную оценку, а не «самый дешёвый». Нет точных цен - нет и значения.
 */
export function priceIndexes(entries: readonly ShortlistEntry[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const entry of entries) {
    for (const price of exactPricesOf(entry)) {
      const key = comparableKey(price);
      groups.set(key, [...(groups.get(key) ?? []), price.amount]);
    }
  }
  const scoreOf = (price: MarketPriceSample): number => {
    const amounts = [...new Set(groups.get(comparableKey(price)) ?? [])].sort((a, b) => a - b);
    if (amounts.length < 2) return LONE_PRICE_SCORE;
    return amounts.indexOf(price.amount) / (amounts.length - 1);
  };
  const indexes = new Map<string, number>();
  for (const entry of entries) {
    const scores = exactPricesOf(entry).map(scoreOf);
    if (scores.length === 0) continue;
    indexes.set(entry.supplierId, scores.reduce((sum, score) => sum + score, 0) / scores.length);
  }
  return indexes;
}

/** Сравнение чисел по возрастанию, отсутствующее значение - после известных. */
function ascendingKnownFirst(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return Number(a === undefined) - Number(b === undefined);
  return a - b;
}

function ratingValue(entry: ShortlistEntry): number | undefined {
  return typeof entry.rating === 'number' ? entry.rating : undefined;
}

/** Отрицание известного значения: по возрастанию это порядок «выше - лучше». */
function negated(value: number | undefined): number | undefined {
  return value === undefined ? undefined : -value;
}

/** Есть ли у кандидата контакты: почта, строка контактов или найденное в интернете. */
export function hasContactsOf(entry: ShortlistEntry): boolean {
  const found = entry.webEnrichment;
  return (
    entry.email !== undefined ||
    entry.contacts !== undefined ||
    found?.phone !== undefined ||
    found?.email !== undefined
  );
}

/** Известен ли город кандидата (своя карточка или найденное в интернете). */
export function hasCityOf(entry: ShortlistEntry): boolean {
  return entry.city !== undefined || entry.webEnrichment?.city !== undefined;
}

/** Сколько из «город, срок» известно: эти сведения наименее критичны. */
function minorDataCount(entry: ShortlistEntry): number {
  return Number(hasCityOf(entry)) + Number(entry.leadTime !== undefined);
}

/**
 * Порядок по критериям владельца (29.10): больше позиций заявки с ценой, при равном числе -
 * больше точных цен, затем меньшая стоимость (нормированный ранг), контакты, город и срок
 * (наименее критичны; при равной полноте - срок короче), рейтинг последним (выше - лучше).
 * Без единой цены - в конце. Равные остаются в исходном порядке (сортировка устойчива): им
 * предшествует ярусное ранжирование слияния.
 */
export function compareByCriteria(entries: readonly ShortlistEntry[]): ShortlistEntry[] {
  const prices = priceIndexes(entries);
  const coverage = new Map(entries.map((entry) => [entry.supplierId, priceCoverageOf(entry)]));
  const days = new Map(
    entries.map((entry) => [entry.supplierId, parseLeadTimeDays(entry.leadTime)]),
  );
  const coveredOf = (entry: ShortlistEntry): PriceCoverage =>
    coverage.get(entry.supplierId) ?? { covered: 0, exact: 0 };
  return [...entries].sort(
    (a, b) =>
      coveredOf(b).covered - coveredOf(a).covered ||
      coveredOf(b).exact - coveredOf(a).exact ||
      ascendingKnownFirst(prices.get(a.supplierId), prices.get(b.supplierId)) ||
      Number(hasContactsOf(b)) - Number(hasContactsOf(a)) ||
      minorDataCount(b) - minorDataCount(a) ||
      ascendingKnownFirst(days.get(a.supplierId), days.get(b.supplierId)) ||
      ascendingKnownFirst(negated(ratingValue(a)), negated(ratingValue(b))),
  );
}

/**
 * Подозрительная «цена от»: во сколько раз она должна превышать медиану точных цен остальных
 * кандидатов той же позиции. «От 30 000 ₽» за услугу рядом с товаром по 400-900 ₽ - это не цена
 * товара, а запись о другом (товар лишь упомянут в тексте услуги).
 */
export const SUSPICIOUS_FROM_PRICE_MEDIAN_RATIO = 20;
/** Сколько точных цен у остальных нужно, чтобы медиане можно было верить (меньше - не судим). */
export const SUSPICIOUS_MIN_REFERENCE_PRICES = 3;

/** Медиана непустого списка чисел. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : ((sorted[middle - 1] ?? high) + high) / 2;
}

/**
 * Кандидаты, чья единственная цена - «от N» (нижняя граница) на порядки выше медианы точных цен
 * остальных по той же позиции и валюте, и при этом нет ни контактов, ни города. Такая запись
 * чаще всего про услугу, а не про товар: на тир-ярусе она выглядит «точной» (не помечена
 * приблизительной) и вытеснила бы нормальных кандидатов. Общее правило по структуре цен, без
 * слов вроде «дизайн». Единица не сравнивается: у услуги её обычно нет.
 */
export function suspiciousFromPriceIds(entries: readonly ShortlistEntry[]): Set<string> {
  const referenceKey = (price: MarketPriceSample): string =>
    JSON.stringify([positionKey(price.item), price.currency.trim().toLowerCase()]);
  const suspicious = new Set<string>();
  for (const entry of entries) {
    const own = allPricesOf(entry);
    const onlyFrom = own.length > 0 && own.every((price) => price.qualifier === 'from');
    if (!onlyFrom || hasContactsOf(entry) || hasCityOf(entry)) continue;
    const outlier = own.every((price) => {
      const key = referenceKey(price);
      const others = entries
        .filter((other) => other.supplierId !== entry.supplierId)
        .flatMap(exactPricesOf)
        .filter((other) => referenceKey(other) === key)
        .map((other) => other.amount);
      if (others.length < SUSPICIOUS_MIN_REFERENCE_PRICES) return false;
      return price.amount >= medianOf(others) * SUSPICIOUS_FROM_PRICE_MEDIAN_RATIO;
    });
    if (outlier) suspicious.add(entry.supplierId);
  }
  return suspicious;
}

/**
 * Найден только в вебе: карточки и подсказок из базы нет и в закрытом Telegram-канале не
 * найден. Кандидат канала ранжируется и сравнивается моделью как поставщик базы (решение
 * владельца, этап 216), поэтому «только веб» он не считается.
 */
export function isWebOnlyEntry(entry: Pick<ShortlistEntry, 'sources'>): boolean {
  return !entry.sources.some((source) => source === 'knowledge' || source === 'telegram');
}

/**
 * Ярусы набора шорт-листа (решение владельца, этап 135): сначала поставщики базы с подходящей
 * (точной) ценой; если их меньше `limit` - веб-кандидаты с ценой; затем те, у кого цена только
 * приблизительная («похожий товар»); кандидаты без цены - только в остаток. Фиксированных мест
 * веба нет: он занимает столько мест, сколько не хватило базе.
 */
export const SHORTLIST_TIERS = {
  none: 1,
  approximate: 2,
  webExact: 3,
  baseExact: 4,
} as const;
export type ShortlistTier = (typeof SHORTLIST_TIERS)[keyof typeof SHORTLIST_TIERS];

/** Точная ли цена в смысле яруса: не помечена приблизительной (`approximate`/`similar`). */
function isTierExact(price: MarketPriceSample): boolean {
  return price.approximate !== true;
}

/** Ярус кандидата по его ценам и источнику. */
export function shortlistTierOf(
  entry: Pick<ShortlistEntry, 'sources' | 'prices' | 'webPrice' | 'webPrices'>,
): ShortlistTier {
  const base = entry.prices ?? [];
  const web = webPricesOf(entry);
  if (!isWebOnlyEntry(entry) && base.some(isTierExact)) return SHORTLIST_TIERS.baseExact;
  if (web.some(isTierExact)) return SHORTLIST_TIERS.webExact;
  return base.length + web.length > 0 ? SHORTLIST_TIERS.approximate : SHORTLIST_TIERS.none;
}

/**
 * Состав шорт-листа по ярусам: `required` входят в любом случае (их ярусы целиком помещаются в
 * `limit`), из `contested` - кандидатов пограничного яруса - модель или правило выбирают `slots`
 * мест. Порядок внутри групп - как в `ordered`.
 */
export interface TierSelection {
  required: ShortlistEntry[];
  contested: ShortlistEntry[];
  slots: number;
}

/**
 * Разбить упорядоченный пул на обязательных и спорных по ярусам. Пограничный ярус - первый, что
 * не помещается в остаток мест; спорных не больше `poolSize` минус обязательные.
 */
export function selectByTiers(
  ordered: readonly ShortlistEntry[],
  limit: number,
  poolSize: number = SHORTLIST_COMPARE_POOL,
  demoted: ReadonlySet<string> = new Set(),
): TierSelection {
  const size = Math.max(0, limit);
  const required: ShortlistEntry[] = [];
  const tiers = [
    SHORTLIST_TIERS.baseExact,
    SHORTLIST_TIERS.webExact,
    SHORTLIST_TIERS.approximate,
    SHORTLIST_TIERS.none,
  ];
  // Подозрительные записи («от N» за услугу) идут отдельной группой после всех ярусов:
  // места достаются им, только если иначе список короче нужного.
  const groups = [
    ...tiers.map((tier) =>
      ordered.filter((e) => !demoted.has(e.supplierId) && shortlistTierOf(e) === tier),
    ),
    ordered.filter((entry) => demoted.has(entry.supplierId)),
  ];
  for (const group of groups) {
    if (required.length + group.length <= size) {
      required.push(...group);
      continue;
    }
    const slots = size - required.length;
    const room = Math.max(slots, poolSize - required.length);
    return { required, contested: group.slice(0, room), slots };
  }
  return { required, contested: [], slots: 0 };
}

/**
 * Итоговый шорт-лист: обязательные плюс первые `slots` спорных по порядку `ranked` (ответ
 * модели либо правило). Порядок показа - как в `ranked`: модель ранжирует внутри отобранного.
 */
export function applyTierSelection(
  selection: TierSelection,
  ranked: readonly ShortlistEntry[],
): ShortlistEntry[] {
  const contested = new Set(selection.contested.map((entry) => entry.supplierId));
  const chosen = ranked
    .filter((entry) => contested.has(entry.supplierId))
    .slice(0, selection.slots)
    .map((entry) => entry.supplierId);
  const keep = new Set([...selection.required.map((entry) => entry.supplierId), ...chosen]);
  return ranked.filter((entry) => keep.has(entry.supplierId));
}

/**
 * Разбор по ярусам с приоритетом локации: группы локаций берутся по очереди (первая локация,
 * вторая, остальные), в каждой действует прежний ярусный отбор на оставшиеся места. Так
 * поставщик названной локации не вытесняется более выгодным из другого города.
 */
export function selectByTiersGrouped(
  groups: readonly (readonly ShortlistEntry[])[],
  limit: number,
  poolSize: number = SHORTLIST_COMPARE_POOL,
  demoted: ReadonlySet<string> = new Set(),
): TierSelection {
  const required: ShortlistEntry[] = [];
  for (const group of groups) {
    const part = selectByTiers(group, Math.max(0, limit) - required.length, poolSize, demoted);
    required.push(...part.required);
    if (part.contested.length > 0) {
      return { required, contested: part.contested, slots: part.slots };
    }
  }
  return { required, contested: [], slots: 0 };
}

/**
 * Единый порядок шорт-листа (этап 143): топ `limit` собирается из базы; интернет добирает
 * только недостающие места (в порядке правила). Внутри базы первой идёт группа названной
 * локации, затем остальные; порядок внутри групп - как в `baseRanked`.
 */
export interface ShortlistPlan {
  /** Отбор из базы: модель (или правило) выбирает и упорядочивает именно его. */
  baseSelection: TierSelection;
  /** Остальные кандидаты (пул) в порядке правила: база, не вошедшая в отбор, не нужна. */
  webRule: ShortlistEntry[];
  /** Кандидаты с подозрительной «ценой от»: берутся в последнюю очередь (по всему пулу). */
  demoted: ReadonlySet<string>;
}

/** План: отбор из базы с учётом локаций и интернет-кандидаты для добора. */
export function planShortlist(
  byRule: readonly ShortlistEntry[],
  limit: number,
  locations: readonly string[] = [],
  poolSize: number = SHORTLIST_COMPARE_POOL,
): ShortlistPlan {
  const base = byRule.filter((entry) => !isWebOnlyEntry(entry));
  // Медиана считается по всему пулу, а не по группе локации: в группе из пары записей её нет.
  const demoted = suspiciousFromPriceIds(byRule);
  return {
    baseSelection: selectByTiersGrouped(groupByLocation(base, locations), limit, poolSize, demoted),
    webRule: byRule.filter(isWebOnlyEntry),
    demoted,
  };
}

/**
 * Итоговый список по плану: база (в порядке `baseRanked`), затем недостающие места занимает
 * интернет. Состав решает этап 143; порядок по локации (этап 169) действует на ВЕСЬ список,
 * включая интернет-кандидатов: иначе москвич из интернета стоял ниже поставщиков другого города
 * и без города. Внутри группы локации база остаётся раньше интернета. Единственная функция
 * порядка: её вызывают слияние кандидатов и ранжирование с моделью, поэтому выдачи не расходятся.
 */
export function arrangeShortlist(
  plan: ShortlistPlan,
  baseRanked: readonly ShortlistEntry[],
  limit: number,
  locations: readonly string[] = [],
): ShortlistEntry[] {
  const base = applyTierSelection(plan.baseSelection, baseRanked);
  const room = Math.max(0, limit) - base.length;
  if (room <= 0) return prioritizeByLocation(base, locations).slice(0, Math.max(0, limit));
  const webSelection = selectByTiers(plan.webRule, room, SHORTLIST_COMPARE_POOL, plan.demoted);
  const web = applyTierSelection(webSelection, plan.webRule);
  return prioritizeByLocation([...base, ...web], locations);
}

/**
 * Повторная группировка по локации после обогащения из интернета (этапы 161 и 169). Город
 * находят платным поиском только у показанных, то есть уже после отбора; без этой группировки
 * «Москва (из интернета)» попадала в хвостовую группу вместе с поставщиком другого города.
 * Состав не меняется: переставляется весь список, порядок внутри групп прежний.
 */
export function regroupByLocation(
  entries: readonly ShortlistEntry[],
  locations: readonly string[],
): ShortlistEntry[] {
  return prioritizeByLocation(entries, locations);
}

/** Порядок по правилу (без модели): тот же план и та же сборка, что с моделью. */
export function orderShortlistByRule(
  pool: readonly ShortlistEntry[],
  limit: number,
  locations: readonly string[] = [],
  poolSize: number = SHORTLIST_COMPARE_POOL,
): ShortlistEntry[] {
  const byRule = compareByCriteria(pool);
  const plan = planShortlist(byRule, limit, locations, poolSize);
  return arrangeShortlist(plan, byRule, limit, locations);
}

/** Сведения кандидата для модели: только факты сравнения, без названий и контактов. */
export interface CompareFactsCandidate {
  /** Короткий код вида `c3`: по нему модель называет кандидата в ответе. */
  id: string;
  source: 'база' | 'веб' | 'база и веб';
  /** По скольким позициям заявки есть цена (любая) и по скольким - точная; считает код. */
  pricedPositions: number;
  exactPositions: number;
  /**
   * Ярус набора по ценам (считает код): `base_exact` - база с подходящей ценой, `web_exact` -
   * веб с ценой, `analog_only` - цены только «похожих товаров», `no_price` - цен нет.
   */
  priceTier: 'base_exact' | 'web_exact' | 'analog_only' | 'no_price';
  /** Код входит в шорт-лист в любом случае (его ярус целиком помещается); модель лишь ранжирует. */
  required?: true | undefined;
  /** Сайт (только домен) и специализация из карточки: чем занимается поставщик. */
  site?: string | undefined;
  specialization?: string | undefined;
  city?: string | undefined;
  /** Лучшая цена по каждой позиции (точная раньше приблизительной, затем меньшая). */
  prices: Array<{
    /** Код позиции заявки вида `p1`; без позиции - не указан. */
    position?: string | undefined;
    amount: number;
    currency: string;
    unit?: string | undefined;
    /** Товар страницы сайта («Крем-мёд, 500 г»): помогает привести фасовку; без контактов. */
    offer?: string | undefined;
    exact: boolean;
    /** Оценка соответствия товара позиции заявки (проверка цен): `exact` или `analog`. */
    grade: 'exact' | 'analog';
    /** Короткая причина оценки от проверки цен. */
    gradeReason?: string | undefined;
  }>;
  leadTime?: string | undefined;
  rating: number | null;
  hasContacts: boolean;
  hasCity: boolean;
  hasLeadTime: boolean;
}

/** Позиция заявки с кодом для модели. */
export interface ComparePosition {
  id: string;
  name: string;
  quantity?: number | undefined;
  unit?: string | undefined;
  /** Характеристики позиции из задачи (без контактов): под них модель оценивает кандидатов. */
  requirements?: string | undefined;
}

/** Вход модели-сравнителя. */
export interface ShortlistCompareFacts {
  /** Позиции заявки с кодами: сколько их всего, по стольким и считается покрытие. */
  positions: ComparePosition[];
  positionsTotal: number;
  /** Требования заявки из полей формы (срок, тираж, материал, нанесение...), без контактов. */
  requirements?: Record<string, string> | undefined;
  /** Сколько поставщиков нужно в шорт-листе; модель выбирает не больше. */
  limit?: number | undefined;
  candidates: CompareFactsCandidate[];
}

/** Не меньше стольких цен одного кандидата уходит модели (и не меньше числа позиций заявки). */
const COMPARE_PRICES_PER_CANDIDATE_MIN = 6;
/** Самая длинная строка срока для модели (знаки). */
const COMPARE_LEAD_TIME_MAX_CHARS = 60;
/** Самые длинные название позиции и товар страницы для модели (знаки). */
const COMPARE_NAME_MAX_CHARS = 80;
/** Самые длинные специализация, город и значение требования заявки для модели (знаки). */
const COMPARE_SPECIALIZATION_MAX_CHARS = 160;
const COMPARE_CITY_MAX_CHARS = 40;
const COMPARE_REQUIREMENT_MAX_CHARS = 160;
/** Сколько полей требований заявки уходит модели. */
const COMPARE_REQUIREMENTS_MAX = 12;
const COMPARE_ID_PREFIX = 'c';
const COMPARE_POSITION_PREFIX = 'p';
/** Контакты и ссылки в тексте срока (веб-страница): модели не отдаются. */
const LEAD_CONTACT_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/g,
  /(?:https?:\/\/|www\.)\S+/gi,
  /\+?\d[\d\s().-]{7,}\d/g,
];

/** Текст для модели: без контактов, схлопнутые пробелы, ограниченная длина. */
function textForModel(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined;
  const clean = LEAD_CONTACT_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ' '), text)
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '');
  if (clean === '') return undefined;
  return Array.from(clean).slice(0, maxChars).join('');
}

/** Оценка товара для модели: похожий товар (по оценке проверки цен или по словам) - `analog`. */
function gradeOf(price: MarketPriceSample): 'exact' | 'analog' {
  return price.similar === true || price.approximate === true ? 'analog' : 'exact';
}

/** Источник кандидата словами для модели. */
function sourceLabel(entry: ShortlistEntry): CompareFactsCandidate['source'] {
  // Канал для модели - «база»: тот же приоритет, что у карточек, отдельной подписи нет.
  const web = entry.sources.includes('web');
  const base = entry.sources.some((source) => source !== 'web');
  if (web && base) return 'база и веб';
  return web ? 'веб' : 'база';
}

/** Лучшая из двух цен одной позиции: точная раньше приблизительной, затем меньшая сумма. */
function betterPrice(a: MarketPriceSample, b: MarketPriceSample): MarketPriceSample {
  if (isExactPrice(a) !== isExactPrice(b)) return isExactPrice(a) ? a : b;
  return b.amount < a.amount ? b : a;
}

/** Позиция заявки на входе фактов: название, а также количество и единица, если известны. */
export type CompareFactsPosition =
  | string
  | {
      name: string;
      quantity?: number | undefined;
      unit?: string | undefined;
      requirements?: string | undefined;
    };

/** Параметры сборки фактов. */
export interface CompareFactsOptions {
  /** Позиции заявки; нет - позиции берутся из цен кандидатов. */
  positions?: readonly CompareFactsPosition[] | undefined;
  /** Поля формы заявки (ключ -> значение): уходят очищенными от контактов. */
  requirements?: Readonly<Record<string, string>> | undefined;
  /** Сколько мест в шорт-листе. */
  limit?: number | undefined;
  /** Поставщики, входящие в шорт-лист в любом случае (`TierSelection.required`). */
  requiredSupplierIds?: ReadonlySet<string> | undefined;
}

/** Домен сайта без схемы, `www.` и пути: контакты и адреса страниц модели не нужны. */
function siteHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = parsed.hostname.replace(/^www\./i, '');
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Адрес сайта кандидата: из карточки, найденный в интернете либо ссылка источника. */
function siteOf(entry: ShortlistEntry): string | undefined {
  const link = entry.references.find((reference) => /^https?:\/\//i.test(reference));
  return siteHost(entry.website ?? entry.webEnrichment?.site ?? link);
}

const PRICE_TIER_LABELS: Readonly<Record<ShortlistTier, CompareFactsCandidate['priceTier']>> = {
  [SHORTLIST_TIERS.baseExact]: 'base_exact',
  [SHORTLIST_TIERS.webExact]: 'web_exact',
  [SHORTLIST_TIERS.approximate]: 'analog_only',
  [SHORTLIST_TIERS.none]: 'no_price',
};

/** Факты для модели и соответствие кодов `c1..cN` поставщикам шорт-листа. */
export function buildCompareFacts(
  entries: readonly ShortlistEntry[],
  options: CompareFactsOptions = {},
): {
  facts: ShortlistCompareFacts;
  supplierIdByCode: Map<string, string>;
} {
  const supplierIdByCode = new Map<string, string>();
  // Код позиции по ключу; сначала позиции заявки, затем встреченные только в ценах.
  const positions = new Map<string, ComparePosition>();
  const registerPosition = (
    name: string | undefined,
    amount?: {
      quantity?: number | undefined;
      unit?: string | undefined;
      requirements?: string | undefined;
    },
  ): ComparePosition | undefined => {
    const shown = textForModel(name, COMPARE_NAME_MAX_CHARS);
    if (shown === undefined) return undefined;
    const key = positionKey(name);
    const known = positions.get(key);
    if (known !== undefined) return known;
    const needs = textForModel(amount?.requirements, REQUEST_ITEM_REQUIREMENTS_MAX_CHARS);
    const created: ComparePosition = {
      id: `${COMPARE_POSITION_PREFIX}${positions.size + 1}`,
      name: shown,
      ...(needs === undefined ? {} : { requirements: needs }),
      ...(amount?.quantity === undefined ? {} : { quantity: amount.quantity }),
      ...(amount?.unit === undefined ? {} : { unit: amount.unit }),
    };
    positions.set(key, created);
    return created;
  };
  for (const position of options.positions ?? []) {
    if (typeof position === 'string') registerPosition(position);
    else registerPosition(position.name, position);
  }
  const candidates = entries.map((entry, index): CompareFactsCandidate => {
    const id = `${COMPARE_ID_PREFIX}${index + 1}`;
    supplierIdByCode.set(id, entry.supplierId);
    // По одной лучшей цене на позицию: у базы и веба покрытие позиций считается одинаково.
    const bestByPosition = new Map<string, MarketPriceSample>();
    for (const price of allPricesOf(entry)) {
      const key = positionKey(price.item);
      const known = bestByPosition.get(key);
      bestByPosition.set(key, known === undefined ? price : betterPrice(known, price));
    }
    const prices = [...bestByPosition.values()].map((price) => {
      const offer = textForModel(price.offer, COMPARE_NAME_MAX_CHARS);
      const reason = textForModel(price.gradeReason, COMPARE_NAME_MAX_CHARS);
      return {
        position: registerPosition(price.item)?.id,
        amount: price.amount,
        currency: price.currency,
        unit: price.unit,
        ...(offer === undefined ? {} : { offer }),
        exact: isExactPrice(price),
        grade: gradeOf(price),
        ...(reason === undefined ? {} : { gradeReason: reason }),
      };
    });
    const coverage = priceCoverageOf(entry);
    const leadTime = textForModel(entry.leadTime, COMPARE_LEAD_TIME_MAX_CHARS);
    const site = siteOf(entry);
    const specialization = textForModel(entry.specialization, COMPARE_SPECIALIZATION_MAX_CHARS);
    const city = textForModel(entry.city ?? entry.webEnrichment?.city, COMPARE_CITY_MAX_CHARS);
    return {
      id,
      source: sourceLabel(entry),
      priceTier: PRICE_TIER_LABELS[shortlistTierOf(entry)],
      ...(options.requiredSupplierIds?.has(entry.supplierId) === true
        ? { required: true as const }
        : {}),
      ...(site === undefined ? {} : { site }),
      ...(specialization === undefined ? {} : { specialization }),
      ...(city === undefined ? {} : { city }),
      pricedPositions: coverage.covered,
      exactPositions: coverage.exact,
      prices,
      ...(leadTime === undefined ? {} : { leadTime }),
      rating: ratingValue(entry) ?? null,
      hasContacts: hasContactsOf(entry),
      hasCity: hasCityOf(entry),
      hasLeadTime: leadTime !== undefined,
    };
  });
  const list = [...positions.values()];
  // Всего позиций - по заявке; цены «чужих» позиций (свой запрос) число не увеличивают.
  const requested = options.positions?.length ?? 0;
  const positionsTotal = requested > 0 ? requested : list.length;
  const limit = Math.max(COMPARE_PRICES_PER_CANDIDATE_MIN, list.length + 1);
  const requirements = Object.entries(options.requirements ?? {})
    .flatMap(([key, value]): Array<[string, string]> => {
      const text = textForModel(value, COMPARE_REQUIREMENT_MAX_CHARS);
      return text === undefined ? [] : [[key, text]];
    })
    .slice(0, COMPARE_REQUIREMENTS_MAX);
  return {
    facts: {
      positions: list,
      positionsTotal,
      ...(requirements.length === 0 ? {} : { requirements: Object.fromEntries(requirements) }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        prices: candidate.prices.slice(0, limit),
      })),
    },
    supplierIdByCode,
  };
}

/** Сырой ответ сравнителя: текст модели и признак обрыва по лимиту токенов. */
export interface RawCompareAnswer {
  text: string;
  /** Ответ оборван лимитом токенов (`stopReason: max_tokens`). */
  truncated: boolean;
}

/** Подкоды причин отказа от ответа модели (идут в журнал вместо текста ответа). */
export const COMPARE_FAILURE_REASONS = [
  'not_json',
  'wrong_shape',
  'unknown_codes',
  'missing_codes',
  'duplicate_codes',
  'truncated',
] as const;
export type CompareFailureReason = (typeof COMPARE_FAILURE_REASONS)[number];

/** Итог разбора ответа: принятый порядок либо причина отказа; числа - без текста ответа. */
export type ModelOrderOutcome =
  | {
      ok: true;
      entries: ShortlistEntry[];
      /** Сколько разных известных кодов вернула модель и сколько кандидатов в пуле. */
      known: number;
      total: number;
      /** Причины выбора от модели по поставщикам (только у ответа вида `{id, reason}`). */
      reasons: Map<string, string>;
    }
  | {
      ok: false;
      reason: CompareFailureReason;
      /** Сколько элементов списка вернула модель, сколько из них разных известных. */
      returned: number;
      known: number;
      total: number;
    };

/**
 * Доля пула, начиная с которой частичный ответ принимается: недостающие кандидаты дописываются
 * по правилу. Меньшая доля - ответ недостоверен (скорее всего оборван или перепутан).
 */
export const COMPARE_MIN_ANSWERED_SHARE = 0.5;
/** Ограда блока кода вокруг JSON. */
const CODE_FENCE_PATTERN = /```[a-zA-Z]*\s*([\s\S]*?)```/;
/** Код кандидата в оборванном тексте: `"c12"` и подобное. */
const CODE_TOKEN_PATTERN = /\bc\s*\d+\b/gi;
/** Номер вместо кода: «3», «#3», «c 3». */
const CODE_NUMBER_PATTERN = /^[#№]?\s*(?:c\s*)?(\d+)$/i;

/** Значение JSON из текста: сам текст, содержимое ограды либо первый `{...}` / `[...]`. */
function parseJsonLoose(text: string): unknown {
  const fenced = CODE_FENCE_PATTERN.exec(text)?.[1];
  const candidates: string[] = [text.trim()];
  if (fenced !== undefined) candidates.push(fenced.trim());
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // следующий вариант
    }
  }
  return undefined;
}

/** Список кодов из оборванного ответа: всё, что похоже на код, после слова `order`. */
function salvageCodes(text: string): string[] {
  const from = text.indexOf('[');
  return from === -1 ? [] : (text.slice(from).match(CODE_TOKEN_PATTERN) ?? []);
}

/** Привести элемент ответа к коду `cN`: регистр, пробелы, номер вместо кода. */
function normalizeCode(item: unknown, total: number): string {
  const text = typeof item === 'number' ? String(item) : typeof item === 'string' ? item : '';
  const clean = text.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '').toLowerCase();
  const number = CODE_NUMBER_PATTERN.exec(clean)?.[1];
  if (number !== undefined) {
    const index = Number(number);
    return index >= 1 && index <= total ? `${COMPARE_ID_PREFIX}${index}` : clean;
  }
  return clean;
}

/**
 * Достать список выбора из разобранного значения: `{picks:[...]}`, `{order:[...]}` (прежний
 * вид) либо голый массив. Элемент - код либо объект `{id, reason}`.
 */
function orderListOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value as unknown[];
  if (typeof value !== 'object' || value === null) return null;
  const list: unknown = 'picks' in value ? value.picks : 'order' in value ? value.order : undefined;
  return Array.isArray(list) ? (list as unknown[]) : null;
}

/** Код кандидата в элементе ответа: сам элемент либо поле `id` объекта. */
function codeFieldOf(item: unknown): unknown {
  if (typeof item === 'object' && item !== null && 'id' in item) return item.id;
  return item;
}

/** Причина выбора из элемента ответа: однострочная, не длиннее `SHORTLIST_REASON_MAX_CHARS`. */
function reasonFieldOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || !('reason' in item)) return undefined;
  if (typeof item.reason !== 'string') return undefined;
  const text = item.reason.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : Array.from(text).slice(0, SHORTLIST_REASON_MAX_CHARS).join('');
}

/** Дополнительные условия разбора ответа. */
export interface ParseOrderOptions {
  /**
   * Сколько кандидатов модель должна была назвать (не больше мест в шорт-листе). Нет - весь
   * пул, как при полном упорядочении. Принимается ответ от половины этого числа.
   */
  need?: number | undefined;
}

/**
 * Разбор ответа модели `{"order":["c3","c1",...]}` терпимо к оформлению: JSON в ограде или с
 * текстом вокруг, регистр и пробелы в кодах, номера вместо кодов, повторы (отбрасываются).
 * Частичный ответ - не меньше половины пула - принимается, остальные дописываются в конце по
 * правилу (`fallback`). Иначе отказ с подкодом причины и числами (для журнала).
 */
export function parseModelOrder(
  raw: unknown,
  supplierIdByCode: ReadonlyMap<string, string>,
  fallback: readonly ShortlistEntry[],
  options: ParseOrderOptions = {},
): ModelOrderOutcome {
  const total = fallback.length;
  const fail = (
    reason: CompareFailureReason,
    returned = 0,
    known = 0,
  ): ModelOrderOutcome => ({ ok: false, reason, returned, known, total });
  let truncated = false;
  let items: unknown[] | null;
  if (typeof raw === 'string' || isRawCompareAnswer(raw)) {
    const text = typeof raw === 'string' ? raw : raw.text;
    truncated = typeof raw !== 'string' && raw.truncated;
    const value = parseJsonLoose(text);
    if (value === undefined || value === null) {
      const salvaged = truncated ? salvageCodes(text) : [];
      if (salvaged.length === 0) return fail(truncated ? 'truncated' : 'not_json');
      items = salvaged;
    } else {
      items = orderListOf(value);
    }
  } else {
    items = orderListOf(raw);
  }
  if (items === null) return fail('wrong_shape');
  const byId = new Map(fallback.map((entry) => [entry.supplierId, entry]));
  const used = new Set<string>();
  const result: ShortlistEntry[] = [];
  const reasons = new Map<string, string>();
  let unknown = 0;
  let duplicates = 0;
  for (const item of items) {
    const supplierId = supplierIdByCode.get(normalizeCode(codeFieldOf(item), total));
    const entry = supplierId === undefined ? undefined : byId.get(supplierId);
    if (entry === undefined) unknown += 1;
    else if (used.has(entry.supplierId)) duplicates += 1;
    else {
      used.add(entry.supplierId);
      result.push(entry);
      const reason = reasonFieldOf(item);
      if (reason !== undefined) reasons.set(entry.supplierId, reason);
    }
  }
  const needed = Math.min(total, options.need ?? total);
  if (result.length < needed * COMPARE_MIN_ANSWERED_SHARE || result.length === 0) {
    const reason: CompareFailureReason = truncated
      ? 'truncated'
      : unknown > 0
        ? 'unknown_codes'
        : duplicates > 0
          ? 'duplicate_codes'
          : 'missing_codes';
    return fail(reason, items.length, result.length);
  }
  const rest = fallback.filter((entry) => !used.has(entry.supplierId));
  return { ok: true, entries: [...result, ...rest], known: result.length, total, reasons };
}

function isRawCompareAnswer(value: unknown): value is RawCompareAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string' &&
    'truncated' in value &&
    typeof value.truncated === 'boolean'
  );
}

/** Совместимая обёртка: порядок либо `null`, если ответ отклонён. */
export function applyModelOrder(
  raw: unknown,
  supplierIdByCode: ReadonlyMap<string, string>,
  fallback: readonly ShortlistEntry[],
): ShortlistEntry[] | null {
  const outcome = parseModelOrder(raw, supplierIdByCode, fallback);
  return outcome.ok ? outcome.entries : null;
}
