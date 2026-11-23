import {
  SHORTLIST_MAX_SIZE,
  mergeCandidates,
  normalizeSupplierName,
  type ShortlistEntry,
  type SourceResult,
} from '../../kit/domain/shortlist';
import { isStalePrice, latestPerLine } from '../../kit/domain/latest-price';
import { priceDateNotInFuture } from '../../kit/domain/lead-time';
import {
  productQueryWithoutPackaging,
  significantProductTokens,
  wordStartShare,
} from '../../kit/domain/product-search';
import { type MarketPriceSample } from '../../kit/domain/market-price';
import { type PriceItem } from '../../kit/domain/models';
import { type SupplierCard } from '../../kit/domain/supplier-card';
import { stableHash } from '@business-ai/core';
import { EXTERNAL_SUPPLIER_PREFIX, type OrderCalcDeps } from './deps';
import { candidateOfCard } from './search-sources';
import { rateSupplierCards } from './supplier-rating';

/**
 * Поставщики, которых сотрудник явно назвал в заявке или сообщении («подготовь запрос ТЕСТ
 * Поставщик А»). Такие карточки базы добавляются в шорт-лист вне лимита ранжирования: иначе
 * дорогой поставщик вытеснялся дешёвыми, а выбрать можно только из шорт-листа (бой 29.10).
 * Ранжирование остальных не меняется.
 */

/** Сколько названных поставщиков принимается за одну сборку. */
export const NAMED_SUPPLIERS_MAX = SHORTLIST_MAX_SIZE;
/** Наибольшая длина одного названия или id (длиннее - не название, а текст). */
export const NAMED_SUPPLIER_MAX_LENGTH = 200;
/** Сколько карточек показывается модели для уточнения неоднозначного названия. */
export const NAMED_SUPPLIER_CANDIDATES_MAX = 10;
/** Оценка релевантности строки, добавленной не поиском: место ей даёт не оценка. */
const NAMED_CARD_SCORE = 0;

/** Итог по одному названию для модели. */
export interface NamedSupplierOutcome {
  /** Название или id, как передала модель. */
  name: string;
  /**
   * `added` - строка в шорт-листе; `not_found` - карточки нет; `ambiguous` - подходят
   * несколько карточек (см. `candidates`), не угадываем. Карточка «не работаем», названная
   * сотрудником, тоже `added`, но с `inactive: true` (решение владельца, этап 181).
   */
  status: 'added' | 'not_found' | 'ambiguous';
  /** Карточка названного поставщика со статусом «не работаем»; строка всё равно добавлена. */
  inactive?: true | undefined;
  supplierId?: string | undefined;
  candidates?: Array<{ supplierId: string; name: string }> | undefined;
}

/** Строки названных поставщиков и итоги по каждому названию. */
export interface NamedSuppliers {
  /** Строки в порядке названий, без повторов, с пометкой `namedByManager`. */
  entries: ShortlistEntry[];
  /** Сколько строк собрано не из результатов поиска (их не было среди найденных). */
  outsideResults: number;
  /**
   * Сколько названных «не работаем» автоматический отбор уже посчитал исключёнными: из
   * `excludedInactive` их надо вычесть (счётчик - только про автоматически исключённых).
   */
  inactiveInResults: number;
  outcomes: NamedSupplierOutcome[];
}

export type CardMatch =
  | { kind: 'card'; card: SupplierCard }
  | { kind: 'none' }
  | { kind: 'ambiguous'; cards: SupplierCard[] };

/** Карточки по подстроке названия: сначала как написано, затем без формы и кавычек. */
async function searchByName(
  deps: Pick<OrderCalcDeps, 'suppliers'>,
  name: string,
): Promise<SupplierCard[]> {
  // На один больше предела: так видно, что карточек больше, чем покажем.
  const limit = NAMED_SUPPLIER_CANDIDATES_MAX + 1;
  const found = await deps.suppliers.searchCards({ query: name, limit });
  if (found.length > 0) return found;
  // «ООО ТЕСТ Поставщик А» не входит подстрокой в «ООО «ТЕСТ Поставщик А»»: кавычки и
  // юридическая форма мешают, нормализованное название - входит.
  const normalized = normalizeSupplierName(name);
  if (normalized === '' || normalized === name.trim().toLowerCase()) return found;
  return deps.suppliers.searchCards({ query: normalized, limit });
}

/**
 * Карточка по id либо по названию существующим поиском карточек. Одна карточка с тем же
 * нормализованным названием - она; иначе единственная найденная; несколько - неоднозначно.
 */
// Нужны только карточки: общий поиск (suppliers/supplier-lookup.ts) зовёт без deps заказа.
export async function findCard(
  deps: Pick<OrderCalcDeps, 'suppliers'>,
  name: string,
): Promise<CardMatch> {
  const byId = await deps.suppliers.getCard(name);
  if (byId !== null) return { kind: 'card', card: byId };
  const found = await searchByName(deps, name);
  const wanted = normalizeSupplierName(name);
  const exact = found.filter((card) => normalizeSupplierName(card.name) === wanted);
  const [onlyExact] = exact;
  if (exact.length === 1 && onlyExact !== undefined) return { kind: 'card', card: onlyExact };
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { kind: 'card', card: only };
  if (found.length === 0) return { kind: 'none' };
  const cards = (exact.length > 1 ? exact : found).slice(0, NAMED_SUPPLIER_CANDIDATES_MAX);
  return { kind: 'ambiguous', cards };
}

/** Цена строки прайса в форме шорт-листа (как у поиска по базе). */
function sampleOf(item: string, price: PriceItem, now: Date): MarketPriceSample {
  return {
    item,
    offer: price.productName,
    amount: price.price,
    currency: price.currency,
    ...(price.priceTiers === undefined ? {} : { tiers: price.priceTiers }),
    ...(price.priceTierBasis === undefined ? {} : { tierBasis: price.priceTierBasis }),
    ...(price.priceVat === undefined ? {} : { vat: price.priceVat }),
    ...(price.priceQualifier === undefined ? {} : { qualifier: price.priceQualifier }),
    ...(price.priceMax === undefined ? {} : { max: price.priceMax }),
    ...(priceDateNotInFuture(price.date, now) === undefined ? {} : { priceDate: price.date }),
    ...(isStalePrice(price.date, now) ? { priceStale: true as const } : {}),
  };
}

/**
 * Цены поставщика по позициям заявки из его прайса: строки, где совпали ВСЕ значимые слова
 * позиции по началу слова (без тары), лучшая - самая дешёвая в каждой валюте. Нужны, когда
 * поиск по базе поставщика не вернул: он берёт по позиции только самых дешёвых.
 */
async function pricesOfCard(
  deps: OrderCalcDeps,
  supplierId: string,
  positions: readonly string[],
): Promise<MarketPriceSample[]> {
  if (positions.length === 0) return [];
  // Этап 161: по каждой позиции прайса - строка самого свежего прайса, не минимум по истории.
  const rows = latestPerLine(await deps.prices.listBySupplier(supplierId), (row) => row);
  const samples: MarketPriceSample[] = [];
  for (const position of positions) {
    const tokens = significantProductTokens(productQueryWithoutPackaging(position));
    if (tokens.length === 0) continue;
    const best = new Map<string, PriceItem>();
    for (const row of rows) {
      if (wordStartShare(tokens, row.productName, row.sku) < 1) continue;
      const current = best.get(row.currency);
      if (current === undefined || row.price < current.price) best.set(row.currency, row);
    }
    for (const row of best.values()) samples.push(sampleOf(position, row, deps.clock.now()));
  }
  return samples;
}

/**
 * Строка шорт-листа для карточки тем же слиянием, что и у остальных: кандидаты поиска этого
 * поставщика (и веб с тем же названием), а не найден поиском - кандидат из карточки с ценами
 * его прайса. Карточка «не работаем» названа сотрудником самим, поэтому слияние её не
 * исключает: статус кандидатов подменяется на действующий, строка получает `namedInactive`.
 */
async function entryOfCard(
  deps: OrderCalcDeps,
  card: SupplierCard,
  results: readonly SourceResult[],
  positions: readonly string[],
): Promise<{ entry: ShortlistEntry | null; inResults: boolean; countedInactive: boolean }> {
  const wanted = normalizeSupplierName(card.name);
  const isInactive = card.status === 'inactive';
  const own = results.map((result) => ({
    ...result,
    candidates: result.candidates
      .filter(
        (candidate) =>
          candidate.supplierId === card.id ||
          (candidate.supplierId === undefined && normalizeSupplierName(candidate.name) === wanted),
      )
      .map((candidate) =>
        isInactive && candidate.status === 'inactive'
          ? { ...candidate, status: 'active' as const }
          : candidate,
      ),
  }));
  const inResults = own.some((result) =>
    result.candidates.some((candidate) => candidate.supplierId === card.id),
  );
  // Автоотбор в `mergeCandidates` посчитал эту карточку исключённой, только если её кандидат
  // пришёл из успешного источника.
  const countedInactive =
    isInactive &&
    results.some(
      (result) =>
        result.status === 'ok' &&
        result.candidates.some((candidate) => candidate.supplierId === card.id),
    );
  const extra: SourceResult[] = [];
  if (!inResults) {
    const rating = (await rateSupplierCards(deps, [card])).get(card.id) ?? { value: null };
    const prices = await pricesOfCard(deps, card.id, positions);
    extra.push({
      source: 'knowledge',
      status: 'ok',
      candidates: [candidateOfCard(
          card,
          NAMED_CARD_SCORE,
          rating,
          prices,
          undefined,
          deps.clock.now(),
        )].map((candidate) =>
          isInactive ? { ...candidate, status: 'active' as const } : candidate,
        ),
    });
  }
  const merged = mergeCandidates([...extra, ...own], {
    limit: 1,
    positionCount: positions.length,
    externalId: (normalized) => `${EXTERNAL_SUPPLIER_PREFIX}${stableHash(normalized)}`,
  });
  const [entry] = merged.entries;
  if (entry === undefined) return { entry: null, inResults, countedInactive };
  // Найден, но без цены (через базу знаний или карточку, а не прайс): цены берутся из его
  // прайса. Иначе у «ТЕСТ Поставщик А» с прайсом 310 ₽ в шорт-листе было «нет данных» (29.10).
  const hasPrices = (entry.prices ?? []).length > 0;
  const prices = inResults && !hasPrices ? await pricesOfCard(deps, card.id, positions) : [];
  return {
    entry: {
      ...entry,
      ...(prices.length > 0 ? { prices } : {}),
      namedByManager: true,
      ...(isInactive ? { namedInactive: true as const } : {}),
    },
    inResults,
    countedInactive,
  };
}

/**
 * Найти карточки названных сотрудником поставщиков и собрать их строки. Карточка «не работаем» тоже
 * добавляется, с пометкой. Названия без карточки
 * и неоднозначные не добавляются: модель уточняет у сотрудника по `outcomes`.
 */
export async function namedSupplierEntries(
  deps: OrderCalcDeps,
  names: readonly string[],
  results: readonly SourceResult[],
  positions: readonly string[],
): Promise<NamedSuppliers> {
  const entries: ShortlistEntry[] = [];
  const outcomes: NamedSupplierOutcome[] = [];
  let outsideResults = 0;
  let inactiveInResults = 0;
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === '') continue;
    const match = await findCard(deps, name);
    if (match.kind === 'none') {
      outcomes.push({ name, status: 'not_found' });
      continue;
    }
    if (match.kind === 'ambiguous') {
      const candidates = match.cards.map((card) => ({ supplierId: card.id, name: card.name }));
      outcomes.push({ name, status: 'ambiguous', candidates });
      continue;
    }
    const { card } = match;
    if (seen.has(card.id)) {
      outcomes.push({ name, status: 'added', supplierId: card.id });
      continue;
    }
    seen.add(card.id);
    const { entry, inResults, countedInactive } = await entryOfCard(deps, card, results, positions);
    if (entry === null) {
      outcomes.push({ name, status: 'not_found', supplierId: card.id });
      continue;
    }
    entries.push(entry);
    if (!inResults) outsideResults += 1;
    if (countedInactive) inactiveInResults += 1;
    outcomes.push({
      name,
      status: 'added',
      supplierId: card.id,
      ...(entry.namedInactive === true ? { inactive: true as const } : {}),
    });
  }
  return { entries, outsideResults, inactiveInResults, outcomes };
}
