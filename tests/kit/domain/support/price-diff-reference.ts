// Эталон: реализация до этапа 30 (R5), без оптимизаций. Нужна только тестам эквивалентности.
// R9-A1-05 (намеренная смена поведения, внесена в эталон): позиция без пары по ключу
// сверяется только с прежней версией среди одноимённых, чей артикул ушёл из нового прайса;
// новая позиция - с одноимёнными оставшимися только вне их диапазона цен (ближайшая граница).
import { deviationExceeds, fromMinorUnits, toMinorUnits } from './money-reference';
import type { PriceItem } from '../../../../src/kit/domain/models';
import type {
  PriceChange,
  PriceDiff,
  PriceReviewReason,
} from '../../../../src/kit/domain/price-diff';

/** Порог скачка цены по умолчанию (0.5 = ±50%); синхронен с `PRICE_JUMP_THRESHOLD`. */
const DEFAULT_JUMP_THRESHOLD = 0.5;
/** Перевод доли в проценты и знаков после запятой в проценте изменения. */
const PERCENT = 100;
const PERCENT_DECIMALS = 2;
/** Доля позиций поставщика, потеря которой за один импорт требует подтверждения человеком. */
const MASS_REMOVAL_THRESHOLD = 0.3;
/** Меньше позиций в базе - доля потери не считается (нет статистики), но обнуление ловится. */
const MASS_REMOVAL_MIN_ITEMS = 5;

/** Виды тире и минуса, которые в прайсах пишут вместо дефиса. */
const DASH_VARIANTS = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
/** Пробелы вокруг дефиса: «AB - 1» и «AB-1» - одна запись. */
const SPACED_HYPHEN = / ?- ?/g;
const SKU_KEY_PREFIX = 'sku:';
const NAME_KEY_PREFIX = 'name:';

/** Общая часть нормализации: NFKC, единый дефис, без регистра, пробелы схлопнуты. */
function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DASH_VARIANTS, '-')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(SPACED_HYPHEN, '-');
}

/**
 * Артикул для сравнения. Правило: Unicode NFKC (полноширинные и совместимые знаки), любые
 * тире приводятся к дефису, регистр не учитывается, пробелы по краям и вокруг дефиса
 * убираются, серии пробелов схлопываются в один. Сами дефисы, пробелы внутри, точки, косые
 * черты и подчёркивания НЕ удаляются, буквы разных алфавитов не приравниваются: «AB-1»,
 * «AB1», «AB 1» и кириллическое «АВ-1» остаются разными артикулами (для таких случаев есть
 * сверка по названию).
 */
export function normalizeSku(sku: string): string {
  return normalizeText(sku);
}

/** Название для сравнения: правило артикула плюс «ё» = «е». */
export function normalizeProductName(name: string): string {
  return normalizeText(name).replace(/ё/g, 'е');
}

function skuKeyOf(item: Pick<PriceItem, 'sku'>): string | undefined {
  const sku = item.sku === undefined ? '' : normalizeSku(item.sku);
  return sku === '' ? undefined : `${SKU_KEY_PREFIX}${sku}`;
}

function nameKeyOf(item: Pick<PriceItem, 'productName'>): string {
  return `${NAME_KEY_PREFIX}${normalizeProductName(item.productName)}`;
}

/**
 * Ключ позиции внутри прайса одного поставщика: нормализованный артикул, иначе нормализованное
 * название. Пространства ключей разные: артикул «болт» и название «болт» не совпадают.
 */
export function priceItemKey(item: Pick<PriceItem, 'sku' | 'productName'>): string {
  return skuKeyOf(item) ?? nameKeyOf(item);
}

/** Последняя по дате цена каждой позиции (в базе может лежать история). */
export function latestPrices(items: readonly PriceItem[]): Map<string, PriceItem> {
  const sorted = [...items].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = new Map<string, PriceItem>();
  for (const item of sorted) latest.set(priceItemKey(item), item);
  return latest;
}

/** Прайс, подготовленный к сопоставлению: по ключу и по названию. */
interface PriceIndex {
  byKey: Map<string, PriceItem>;
  byName: Map<string, PriceItem[]>;
}

function indexPrices(items: readonly PriceItem[]): PriceIndex {
  const byKey = latestPrices(items);
  const byName = new Map<string, PriceItem[]>();
  for (const item of byKey.values()) {
    const name = nameKeyOf(item);
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  return { byKey, byName };
}

/** Позиции прайса с тем же названием (любой артикул). */
function sameNameItems(item: PriceItem, index: PriceIndex): PriceItem[] {
  return index.byName.get(nameKeyOf(item)) ?? [];
}

/**
 * С чем сверять цену позиции: с прежней версией по ключу (артикул, без артикула - название);
 * если по ключу её нет - с прежней версией среди одноимённых, чей артикул ушёл из нового
 * прайса (наибольшее отклонение); если и таких нет (позиция новая) - с одноимёнными, только
 * когда цена вне их диапазона той же валюты: с ближайшей по отклонению. `sibling` - эталон
 * взят среди одноимённых с оставшимися артикулами.
 */
function priceReference(
  item: PriceItem,
  index: PriceIndex,
  skuKeys: ReadonlySet<string>,
): { reference?: PriceItem | undefined; sibling: boolean } {
  const exact = index.byKey.get(priceItemKey(item));
  if (exact !== undefined) return { reference: exact, sibling: false };
  const sameName = sameNameItems(item, index);
  const renamed = sameName.filter((candidate) => {
    const sku = skuKeyOf(candidate);
    return sku === undefined || !skuKeys.has(sku);
  });
  if (renamed.length > 0) return { reference: worstReference(item, renamed), sibling: false };
  if (sameName.length === 0) return { sibling: false };
  const sameCurrency = sameName.filter((candidate) => candidate.currency === item.currency);
  if (sameCurrency.length === 0) return { reference: sameName[0], sibling: true };
  const positive = sameCurrency.filter((candidate) => candidate.price > 0);
  if (positive.length === 0) return { sibling: false };
  const prices = positive.map((candidate) => candidate.price);
  if (item.price >= Math.min(...prices) && item.price <= Math.max(...prices)) {
    return { sibling: false };
  }
  let nearest = positive[0] as PriceItem;
  for (const candidate of positive) {
    if (deviation(item, candidate) < deviation(item, nearest)) nearest = candidate;
  }
  return { reference: nearest, sibling: true };
}

/** Отклонение новой цены от прежней; смена валюты - бесконечное (скачок при любом числе). */
function deviation(item: PriceItem, old: PriceItem): number {
  if (old.currency !== item.currency) return Number.POSITIVE_INFINITY;
  return old.price <= 0 ? 0 : Math.abs(item.price - old.price) / old.price;
}

/** Отклонение новой цены от прежней больше порога (в целых, без ошибки двоичной дроби). */
function exceedsThreshold(item: PriceItem, old: PriceItem, threshold: number): boolean {
  if (old.currency !== item.currency) return true;
  return old.price > 0 && deviationExceeds(old.price, item.price, threshold);
}

/** Прежняя версия с наибольшим отклонением (сверка с каждой из одноимённых). */
function worstReference(item: PriceItem, references: readonly PriceItem[]): PriceItem | undefined {
  let worst: PriceItem | undefined;
  for (const candidate of references) {
    if (worst === undefined || deviation(item, candidate) > deviation(item, worst)) {
      worst = candidate;
    }
  }
  return worst;
}

/** Новая позиция, её прежняя версия и цены, с которыми сверяется скачок. */
interface PricePair {
  item: PriceItem;
  /**
   * Прежняя версия позиции: по ключу, иначе по названию среди позиций, чей артикул НЕ остался
   * в новом прайсе (иначе это отдельная новая позиция, а не переименование артикула).
   */
  old?: PriceItem | undefined;
  /** Прежняя версия найдена по названию: артикул появился, пропал или сменился. */
  byName: boolean;
  /** Цена в базе для сверки скачка (`priceReference`). */
  worstExisting?: PriceItem | undefined;
  /** Подтверждённая человеком цена для сверки скачка. */
  worstConfirmed?: PriceItem | undefined;
  existingSibling: boolean;
  confirmedSibling: boolean;
}

function pairPrices(
  incoming: readonly PriceItem[],
  existing: readonly PriceItem[],
  confirmed: readonly PriceItem[],
): PricePair[] {
  const existingIndex = indexPrices(existing);
  const confirmedIndex = indexPrices(confirmed);
  const skuKeys = new Set<string>();
  for (const item of incoming) {
    const sku = skuKeyOf(item);
    if (sku !== undefined) skuKeys.add(sku);
  }
  return incoming.map((item) => {
    const exact = existingIndex.byKey.get(priceItemKey(item));
    const renamed = sameNameItems(item, existingIndex).filter((candidate) => {
      const sku = skuKeyOf(candidate);
      return sku === undefined || !skuKeys.has(sku);
    });
    const existingRef = priceReference(item, existingIndex, skuKeys);
    const confirmedRef = priceReference(item, confirmedIndex, skuKeys);
    return {
      item,
      old: exact ?? worstReference(item, renamed),
      byName: exact === undefined && renamed.length > 0,
      worstExisting: existingRef.reference,
      worstConfirmed: confirmedRef.reference,
      existingSibling: existingRef.sibling,
      confirmedSibling: confirmedRef.sibling,
    };
  });
}

/** Позиция «на проверку». */
interface PriceReviewEntry {
  key: string;
  productName: string;
  sku?: string | undefined;
  reason: PriceReviewReason;
}

function roundPct(value: number): number {
  return fromMinorUnits(toMinorUnits(value, PERCENT_DECIMALS), PERCENT_DECIMALS);
}

/**
 * Позиции, снятые при резком сокращении прайса. Состав, от которого считается потеря, - все
 * известные позиции поставщика: текущие в базе и подтверждённые (в них остаются позиции,
 * пропавшие прошлыми импортами), поэтому нарезка снятия на файлы по ≤30% не обходит порог.
 * Каждая снятая позиция - отдельная запись набора скачков, которую подтверждает человек.
 * Подтверждаемым считается: потеря больше `MASS_REMOVAL_THRESHOLD` известного состава или
 * полное обнуление непустого прайса (пустой файл) при любом размере базы.
 */
function massRemovals(
  incoming: readonly PriceItem[],
  existing: readonly PriceItem[],
  confirmed: readonly PriceItem[],
): PriceChange[] {
  // Текущая цена важнее подтверждённой: подтверждённая нужна только для пропавших позиций.
  const known = new Map([...latestPrices(confirmed), ...latestPrices(existing)]);
  if (known.size === 0) return [];
  const matched = new Set<string>();
  for (const pair of pairPrices(incoming, [...known.values()], confirmed)) {
    if (pair.old !== undefined) matched.add(priceItemKey(pair.old));
  }
  const removed = [...known].filter(([key]) => !matched.has(key)).map(([, item]) => item);
  if (removed.length === 0) return [];
  const wipedOut = incoming.length === 0;
  const tooMany =
    known.size >= MASS_REMOVAL_MIN_ITEMS && removed.length / known.size > MASS_REMOVAL_THRESHOLD;
  if (!wipedOut && !tooMany) return [];
  return removed.map((old) => ({
    key: priceItemKey(old),
    productName: old.productName,
    ...(old.sku === undefined ? {} : { sku: old.sku }),
    oldPrice: old.price,
    newPrice: 0,
    currency: old.currency,
    oldCurrency: old.currency,
    changePct: -PERCENT,
    removed: true,
  }));
}

/**
 * Изменения цены сверх порога. Единственное место, где определяется «скачок»: им пользуются
 * проверка импорта, запрос подтверждения и файл изменений. Скачком считается:
 * - смена валюты, каким бы ни было число;
 * - отклонение сверх порога от прежней цены в базе (позиция ищется по нормализованному
 *   артикулу, иначе по названию);
 * - отклонение сверх порога от последней цены, подтверждённой человеком (`confirmed`): серия
 *   импортов по 49% не уводит цену дальше порога без подтверждения, а снятая и возвращённая
 *   позиция сверяется с ценой, которая была до снятия;
 * - снятие позиции при потере больше `MASS_REMOVAL_THRESHOLD` известного состава прайса или
 *   при полном обнулении непустого прайса (`removed`).
 */
export function findPriceJumps(
  incoming: readonly PriceItem[],
  existing: readonly PriceItem[],
  threshold: number = DEFAULT_JUMP_THRESHOLD,
  confirmed: readonly PriceItem[] = [],
): PriceChange[] {
  const jumps: PriceChange[] = [];
  for (const pair of pairPrices(incoming, existing, confirmed)) {
    const { item, worstExisting, worstConfirmed } = pair;
    const fromExisting =
      worstExisting !== undefined && exceedsThreshold(item, worstExisting, threshold);
    const fromConfirmed =
      worstConfirmed !== undefined && exceedsThreshold(item, worstConfirmed, threshold);
    const reference = fromExisting ? worstExisting : (pair.old ?? worstExisting ?? worstConfirmed);
    if ((fromExisting || fromConfirmed) && reference !== undefined) {
      const change = toChange(item, reference, worstConfirmed);
      const sibling =
        reference === worstExisting && pair.old === undefined
          ? pair.existingSibling
          : reference !== pair.old && reference === worstConfirmed && pair.confirmedSibling;
      jumps.push(sibling ? { ...change, newItem: true } : change);
    }
  }
  return [...jumps, ...massRemovals(incoming, existing, confirmed)];
}

/** Подтверждённая позиция под новым названием и артикулом (цена и валюта прежние). */
function renamedLike(confirmed: PriceItem, item: PriceItem): PriceItem {
  const { sku: _oldSku, ...rest } = confirmed;
  return {
    ...rest,
    productName: item.productName,
    ...(item.sku === undefined ? {} : { sku: item.sku }),
  };
}

/**
 * Подтверждённые цены после фиксации импорта. Позиция из набора скачков, принятого человеком
 * (`approvedKeys`), получает новую подтверждённую цену. Для позиций базы, у которых
 * подтверждённой цены ещё не было, запоминается цена ДО импорта - в том числе для снятых этим
 * импортом: возврат позиции дороже сверяется с ценой до снятия. Совсем новая позиция
 * запоминает свою первую цену. Остальные подтверждённые цены не меняются.
 */
export function nextConfirmedPrices(
  confirmed: readonly PriceItem[],
  existing: readonly PriceItem[],
  committed: readonly PriceItem[],
  approvedKeys: ReadonlySet<string>,
): PriceItem[] {
  const next = latestPrices(confirmed);
  for (const [key, item] of latestPrices(existing)) {
    if (!next.has(key)) next.set(key, item);
  }
  const base = [...next.values()];
  const baseIndex = indexPrices(base);
  const committedSkus = new Set<string>();
  for (const item of committed) {
    const sku = skuKeyOf(item);
    if (sku !== undefined) committedSkus.add(sku);
  }
  for (const pair of pairPrices(committed, [], base)) {
    const key = priceItemKey(pair.item);
    // Смена артикула: подтверждённая цена жила под старым ключом, а старый артикул из прайса
    // ушёл. Переносим её под новый ключ (принятый скачок - уже новой ценой) и убираем старый,
    // иначе старая цена навсегда остаётся «подтверждённой» и даёт ложные скачки (R3-ALG-17).
    const stale = baseIndex.byKey.has(key)
      ? []
      : sameNameItems(pair.item, baseIndex).filter((candidate) => {
          const sku = skuKeyOf(candidate);
          return sku === undefined || !committedSkus.has(sku);
        });
    const carried = worstReference(pair.item, stale);
    if (carried !== undefined) {
      for (const old of stale) next.delete(priceItemKey(old));
      next.set(key, approvedKeys.has(key) ? pair.item : renamedLike(carried, pair.item));
    } else if (approvedKeys.has(key) || pair.worstConfirmed === undefined) {
      next.set(key, pair.item);
    }
  }
  // Снятие позиции, принятое человеком, закрепляет новый состав: иначе каждый следующий импорт
  // снова считал бы её потерянной. Неподтверждённые мелкие потери в составе остаются.
  const committedKeys = new Set(committed.map(priceItemKey));
  for (const key of approvedKeys) {
    if (!committedKeys.has(key)) next.delete(key);
  }
  return [...next.values()];
}

function toChange(item: PriceItem, old: PriceItem, confirmed?: PriceItem): PriceChange {
  const differs =
    confirmed !== undefined &&
    (confirmed.price !== old.price || confirmed.currency !== old.currency);
  return {
    key: priceItemKey(item),
    productName: item.productName,
    ...(item.sku === undefined ? {} : { sku: item.sku }),
    oldPrice: old.price,
    newPrice: item.price,
    currency: item.currency,
    oldCurrency: old.currency,
    changePct: old.price <= 0 ? 0 : roundPct(((item.price - old.price) / old.price) * PERCENT),
    ...(differs ? { confirmedPrice: confirmed.price, confirmedCurrency: confirmed.currency } : {}),
  };
}

function reviewEntry(item: PriceItem, reason: PriceReviewReason): PriceReviewEntry {
  return {
    key: priceItemKey(item),
    productName: item.productName,
    ...(item.sku === undefined ? {} : { sku: item.sku }),
    reason,
  };
}

/** Позиции с одним названием, но разными артикулами: непонятно, одна это позиция или две. */
function sameNameDifferentSku(items: readonly PriceItem[]): Set<string> {
  const skus = new Map<string, Set<string>>();
  for (const item of items) {
    const sku = skuKeyOf(item);
    if (sku === undefined) continue;
    const name = nameKeyOf(item);
    skus.set(name, (skus.get(name) ?? new Set<string>()).add(sku));
  }
  return new Set([...skus].filter(([, set]) => set.size > 1).map(([name]) => name));
}

/**
 * Сравнить новый прайс поставщика с текущим до фиксации. «На проверку» попадают скачки,
 * дубли и неоднозначные позиции нового прайса, позиции, найденные только по названию
 * (артикул сменился), а также новые или изменившиеся позиции без артикула. Позиция, которая
 * нашлась по артикулу или названию, - изменение, а не «снята» и «добавлена» по отдельности.
 */
export function diffPrices(
  existing: readonly PriceItem[],
  incoming: readonly PriceItem[],
  threshold: number = DEFAULT_JUMP_THRESHOLD,
  confirmed: readonly PriceItem[] = [],
): PriceDiff {
  const previous = latestPrices(existing);
  const added: PriceItem[] = [];
  const changed: PriceChange[] = [];
  const review: PriceReviewEntry[] = [];
  const seen = new Set<string>();
  const matched = new Set<string>();
  const ambiguousNames = sameNameDifferentSku(incoming);
  let unchanged = 0;
  for (const pair of pairPrices(incoming, existing, confirmed)) {
    const { item, old } = pair;
    const key = priceItemKey(item);
    if (seen.has(key)) review.push(reviewEntry(item, 'duplicate'));
    seen.add(key);
    if (ambiguousNames.has(nameKeyOf(item))) {
      review.push(reviewEntry(item, 'same_name_different_sku'));
    }
    if (old === undefined) {
      added.push(item);
      if (item.sku === undefined) review.push(reviewEntry(item, 'no_sku'));
      continue;
    }
    matched.add(priceItemKey(old));
    if (pair.byName) review.push(reviewEntry(item, 'sku_changed'));
    if (old.price === item.price && old.currency === item.currency) {
      unchanged += 1;
      continue;
    }
    changed.push(toChange(item, old, pair.worstConfirmed));
    if (item.sku === undefined) review.push(reviewEntry(item, 'no_sku'));
    if (old.currency !== item.currency) review.push(reviewEntry(item, 'currency_changed'));
  }
  const jumps = findPriceJumps(incoming, existing, threshold, confirmed);
  for (const jump of jumps) {
    review.push({
      key: jump.key,
      productName: jump.productName,
      ...(jump.sku === undefined ? {} : { sku: jump.sku }),
      reason: 'price_jump',
    });
  }
  const removed = [...previous].filter(([key]) => !matched.has(key)).map(([, item]) => item);
  return { added, removed, changed, jumps, review, unchanged };
}
