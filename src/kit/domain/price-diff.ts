import { deviationExceeds, fromMinorUnits, toMinorUnits } from './money';
import type { PriceItem, PriceQualifier } from './models';
import {
  EMPTY_PRICE_GROUP,
  nearestSiblingOutsideRange,
  priceGroup,
  worstInGroup,
  type PriceGroup,
} from './price-groups';

/** Порог скачка цены по умолчанию (0.5 = ±50%); синхронен с `PRICE_JUMP_THRESHOLD`. */
export const DEFAULT_JUMP_THRESHOLD = 0.5;
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
/**
 * Печатные ASCII без пробела. Для них NFKC, замена тире, `trim` и правила пробелов ничего не
 * меняют: нормализация сводится к `toLowerCase` (обычный артикул «TP-123»).
 */
const PLAIN_ASCII = /^[\x21-\x7e]*$/;
/**
 * Предел записей каждого кэша ключей по тексту: прайс поставщика целиком (два листа по 50 тыс.
 * строк) с запасом. При переполнении кэш очищается: память ограничена, результат тот же.
 */
const KEY_CACHE_LIMIT = 120_000;

/** Общая часть нормализации: NFKC, единый дефис, без регистра, пробелы схлопнуты. */
function normalizeText(text: string): string {
  if (PLAIN_ASCII.test(text)) return text.toLowerCase();
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

/**
 * Ключи позиций считаются один раз на текст артикула и названия: на полном пути фиксации
 * прайса одни и те же позиции проходят через десяток функций, и нормализация (NFKC +
 * регулярки) доминировала. Кэш - по тексту, а не по объекту позиции (R9-A1-01): база,
 * подтверждённые цены и staging приходят свежими копиями, и мемо по объекту всегда было
 * холодным, а строки в копиях те же. Ключ зависит только от текста, поэтому правка поля
 * позиции на месте сразу даёт новый ключ.
 */
const skuKeyByText = new Map<string, string | undefined>();
const nameKeyByText = new Map<string, string>();

function rememberKey<T>(cache: Map<string, T>, text: string, key: T): T {
  if (cache.size >= KEY_CACHE_LIMIT) cache.clear();
  cache.set(text, key);
  return key;
}

function skuKeyOfText(sku: string): string | undefined {
  const cached = skuKeyByText.get(sku);
  // undefined в кэше - артикул из одних пробелов; такой проверяется вторым поиском.
  if (cached !== undefined || skuKeyByText.has(sku)) return cached;
  const normalized = normalizeSku(sku);
  const key = normalized === '' ? undefined : `${SKU_KEY_PREFIX}${normalized}`;
  return rememberKey(skuKeyByText, sku, key);
}

function nameKeyOfText(name: string): string {
  const cached = nameKeyByText.get(name);
  if (cached !== undefined) return cached;
  return rememberKey(nameKeyByText, name, `${NAME_KEY_PREFIX}${normalizeProductName(name)}`);
}

function skuKeyOf(item: Pick<PriceItem, 'sku'>): string | undefined {
  return item.sku === undefined ? undefined : skuKeyOfText(item.sku);
}

function nameKeyOf(item: Pick<PriceItem, 'productName'>): string {
  return nameKeyOfText(item.productName);
}

/**
 * Ключ позиции внутри прайса одного поставщика: нормализованный артикул, иначе нормализованное
 * название. Пространства ключей разные: артикул «болт» и название «болт» не совпадают.
 */
export function priceItemKey(item: Pick<PriceItem, 'sku' | 'productName'>): string {
  return skuKeyOf(item) ?? nameKeyOf(item);
}

/** Позиций между уступками управления в пошаговом расчёте (единицы-десятки мс работы). */
const STEP_ITEMS = 2_000;

/**
 * Пошаговый расчёт (R9-A1-01): генератор отдаёт управление (`yield`) каждые `STEP_ITEMS`
 * позиций. Синхронная обёртка (`runPriceSteps`) проходит его целиком, прикладной слой - с
 * уступками циклу событий: сверка прайса в 100 тыс. позиций не замораживает процесс ядра (чат,
 * опрос портала, планировщик) на секунды. Результат один и тот же: это одна реализация.
 */
export type PriceSteps<T> = Generator<undefined, T, undefined>;

/** Пройти пошаговый расчёт целиком, без уступок. */
function runPriceSteps<T>(steps: PriceSteps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

/** Пора отдать управление: позиция с номером `index` (с нуля) закрывает шаг. */
function stepEnds(index: number): boolean {
  return (index + 1) % STEP_ITEMS === 0;
}

/** Последняя по дате цена каждой позиции (в базе может лежать история). */
export function latestPrices(items: readonly PriceItem[]): Map<string, PriceItem> {
  return runPriceSteps(latestPricesSteps(items));
}

function* latestPricesSteps(items: readonly PriceItem[]): PriceSteps<Map<string, PriceItem>> {
  // Дата разбирается один раз на позицию, а не дважды на каждое сравнение сортировки.
  const times = items.map((item) => Date.parse(item.date));
  // Обычно у всех позиций одна дата или они уже по порядку: устойчивая сортировка такого
  // массива его не меняет, и проход проверки дешевле сортировки (R9-A1-01).
  const ordered = isChronological(times) ? items : sortedByTime(items, times);
  const latest = new Map<string, PriceItem>();
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index] as PriceItem;
    latest.set(priceItemKey(item), item);
    if (stepEnds(index)) yield;
  }
  return latest;
}

/** Позиции по возрастанию даты; устойчиво: при равной дате порядок исходный. */
function sortedByTime(items: readonly PriceItem[], times: readonly number[]): PriceItem[] {
  const dated = items.map((item, index) => ({ item, time: times[index] ?? Number.NaN }));
  dated.sort((a, b) => a.time - b.time);
  return dated.map(({ item }) => item);
}

/**
 * Даты без пропусков (NaN) и не убывают. С NaN сравнение сортировки несогласованно, и
 * результат сортировки не обязан совпасть с исходным порядком: такой массив сортируется.
 */
function isChronological(times: readonly number[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    if (!(time >= previous)) return false;
    previous = time;
  }
  return true;
}

/** Прайс, подготовленный к сопоставлению: по ключу и по названию. */
interface PriceIndex {
  byKey: Map<string, PriceItem>;
  /**
   * Группы по названию (`nameGroups`) строятся при первом обращении: они нужны только
   * позициям без пары по ключу, а при артикулах на месте их нет, и названия базы не
   * нормализуются вовсе.
   */
  byName?: Map<string, PriceItem[]> | undefined;
}

function* indexPricesSteps(items: readonly PriceItem[]): PriceSteps<PriceIndex> {
  return { byKey: yield* latestPricesSteps(items) };
}

/** Группы индекса по названию; порядок внутри группы - порядок `byKey`. */
function* nameGroups(index: PriceIndex): PriceSteps<ReadonlyMap<string, PriceItem[]>> {
  if (index.byName !== undefined) return index.byName;
  const byName = new Map<string, PriceItem[]>();
  let position = 0;
  for (const item of index.byKey.values()) {
    const name = nameKeyOf(item);
    const group = byName.get(name);
    if (group === undefined) byName.set(name, [item]);
    else group.push(item);
    if (stepEnds(position)) yield;
    position += 1;
  }
  index.byName = byName;
  return byName;
}

/** Ключи артикулов набора; считаются при первом обращении (нужны только при переименовании). */
function lazySkuKeys(items: readonly PriceItem[]): () => ReadonlySet<string> {
  let keys: Set<string> | undefined;
  return () => (keys ??= new Set(items.map(skuKeyOf).filter((key) => key !== undefined)));
}

/** Одноимённые позиции прайса для позиции нового прайса без пары по ключу. */
interface NameMatches {
  /**
   * Одноимённые, чей артикул НЕ остался в новом прайсе: кандидаты в прежнюю версию (артикул
   * появился, пропал или сменился). Пустая группа - позиция новая.
   */
  renamed: PriceGroup;
  /** Все одноимённые позиции (в том числе с оставшимися артикулами). */
  sameName: PriceGroup;
  /**
   * Ключ одноимённых позиций без артикула (у всех он один - ключ названия), если такие есть
   * среди `renamed`: только такой ключ может снова появиться в наборе после снятия.
   */
  namelessKey?: string | undefined;
}

const NO_MATCHES: NameMatches = { renamed: EMPTY_PRICE_GROUP, sameName: EMPTY_PRICE_GROUP };

/**
 * Поиск одноимённых в индексе для позиций одного нового прайса (`skuKeys` - его артикулы).
 * Группа фильтруется один раз на название, а не на каждую позицию (R9-A1-05: при смене формата
 * артикулов это был перебор группы на каждую позицию, O(n·g)).
 */
function nameMatcher(
  index: PriceIndex,
  skuKeys: () => ReadonlySet<string>,
): (item: PriceItem) => PriceSteps<NameMatches> {
  const memo = new Map<string, NameMatches>();
  return function* matchesOf(item) {
    // Пустой индекс (сверка подтверждённых цен без базы): название не нормализуется зря.
    if (index.byKey.size === 0) return NO_MATCHES;
    const name = nameKeyOf(item);
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const sameName = (yield* nameGroups(index)).get(name) ?? [];
    // Ключи артикула с префиксом, поэтому '' (нет артикула) в наборе не встречается.
    const renamed = sameName.filter((c) => !skuKeys().has(skuKeyOf(c) ?? ''));
    const matches: NameMatches = {
      renamed: priceGroup(renamed),
      sameName: priceGroup(sameName),
      ...(renamed.some((c) => skuKeyOf(c) === undefined) ? { namelessKey: name } : {}),
    };
    memo.set(name, matches);
    return matches;
  };
}

/**
 * С чем сверять скачок позиции без пары по ключу: с прежней версией среди переименованных, а
 * если позиция новая - с одноимёнными только вне их диапазона цен (R9-A1-05).
 */
function referenceByName(item: PriceItem, matches: NameMatches): PriceItem | undefined {
  return matches.renamed.items.length > 0
    ? worstInGroup(item, matches.renamed)
    : nearestSiblingOutsideRange(item, matches.sameName);
}

/**
 * Цена, валюта и признак цены («от», диапазон, верхняя граница) совпадают. Смена признака -
 * изменение цены, даже если число то же: точная 500 -> «от 500» уже другая договорённость, а
 * «500-700» -> «500-800» меняет вилку. Тиражи здесь по-прежнему не сравниваются (этап 106).
 */
function samePrice(old: PriceItem, item: PriceItem): boolean {
  return (
    old.price === item.price &&
    old.currency === item.currency &&
    old.priceQualifier === item.priceQualifier &&
    old.priceMax === item.priceMax
  );
}

/** Отклонение новой цены от прежней больше порога (в целых, без ошибки двоичной дроби). */
function exceedsThreshold(item: PriceItem, old: PriceItem, threshold: number): boolean {
  if (old.currency !== item.currency) return true;
  // Тираж сравнивается с тиражом того же минимума; нет общих тиражей - основные цены.
  const shared = sharedTiers(item, old);
  if (shared.length > 0) {
    return shared.some(
      ([now, before]) => before > 0 && deviationExceeds(before, now, threshold),
    );
  }
  return old.price > 0 && deviationExceeds(old.price, item.price, threshold);
}

/** Пары цен (новая, прежняя) тиражей с одним и тем же минимумом у двух версий позиции. */
function sharedTiers(item: PriceItem, old: PriceItem): Array<[number, number]> {
  if (item.priceTiers === undefined || old.priceTiers === undefined) return [];
  // Порог в штуках и порог в рублях заказа - разные величины: 100 шт и 100 ₽ не одно и то же.
  if ((item.priceTierBasis ?? 'quantity') !== (old.priceTierBasis ?? 'quantity')) return [];
  const pairs: Array<[number, number]> = [];
  for (const tier of item.priceTiers) {
    const before = old.priceTiers.find((other) => other.minQuantity === tier.minQuantity);
    if (before !== undefined) pairs.push([tier.price, before.price]);
  }
  return pairs;
}

/** Новая позиция, её прежняя версия и цены, с которыми сверяется скачок. */
interface PricePair {
  item: PriceItem;
  /** `priceItemKey(item)`: считается один раз на пару (R9-A1-01). */
  key: string;
  /**
   * Прежняя версия позиции: по ключу, иначе по названию среди позиций, чей артикул НЕ остался
   * в новом прайсе (иначе это отдельная новая позиция, а не переименование артикула).
   */
  old?: PriceItem | undefined;
  /** `priceItemKey(old)`. */
  oldKey?: string | undefined;
  /** Прежняя версия найдена по названию: артикул появился, пропал или сменился. */
  byName: boolean;
  /**
   * Цена в базе, с которой сверяется скачок: по ключу, иначе прежняя версия среди
   * переименованных, иначе (позиция новая) ближайшая одноимённая вне их диапазона цен.
   */
  worstExisting?: PriceItem | undefined;
  /** Подтверждённая человеком цена для сверки (то же правило выбора). */
  worstConfirmed?: PriceItem | undefined;
  /** `worstExisting` - одноимённая позиция с другим артикулом, а не прежняя версия. */
  existingSibling?: boolean | undefined;
  /** `worstConfirmed` - одноимённая позиция с другим артикулом. */
  confirmedSibling?: boolean | undefined;
}

/** Эталон сверки по ключу или по названию и признак «одноимённая, а не прежняя версия». */
function* referenceFor(
  item: PriceItem,
  exact: PriceItem | undefined,
  matchesOf: (item: PriceItem) => PriceSteps<NameMatches>,
): PriceSteps<{ reference?: PriceItem | undefined; sibling: boolean }> {
  if (exact !== undefined) return { reference: exact, sibling: false };
  const matches = yield* matchesOf(item);
  const reference = referenceByName(item, matches);
  return { reference, sibling: reference !== undefined && matches.renamed.items.length === 0 };
}

/**
 * Сопоставить позиции нового прайса с готовыми индексами. Без `confirmedIndex` цены для
 * сверки скачка (`worstExisting`, `worstConfirmed`) не считаются: нужны только `old`/`byName`.
 */
function* pairAgainst(
  incoming: readonly PriceItem[],
  existingIndex: PriceIndex,
  confirmedIndex?: PriceIndex,
): PriceSteps<PricePair[]> {
  const skuKeys = lazySkuKeys(incoming);
  const existingMatches = nameMatcher(existingIndex, skuKeys);
  const confirmedMatches =
    confirmedIndex === undefined ? undefined : nameMatcher(confirmedIndex, skuKeys);
  const pairs: PricePair[] = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const item = incoming[index] as PriceItem;
    const key = priceItemKey(item);
    const exact = existingIndex.byKey.get(key);
    // Переименование ищется только когда точной пары нет.
    const renamed = exact !== undefined ? NO_MATCHES : yield* existingMatches(item);
    const old = exact ?? worstInGroup(item, renamed.renamed);
    const pair: PricePair = {
      item,
      key,
      old,
      // Индекс по ключу хранит позицию под её же ключом: у точной пары он совпадает с `key`.
      oldKey: exact !== undefined ? key : old === undefined ? undefined : priceItemKey(old),
      byName: exact === undefined && renamed.renamed.items.length > 0,
    };
    if (confirmedIndex !== undefined && confirmedMatches !== undefined) {
      // Одноимённые с оставшимися в прайсе артикулами - другие позиции, не прежняя версия:
      // новая позиция сверяется с ними только вне их диапазона цен (R9-A1-05).
      const existing = yield* referenceFor(item, exact, existingMatches);
      const confirmed = yield* referenceFor(
        item,
        confirmedIndex.byKey.get(key),
        confirmedMatches,
      );
      pair.worstExisting = existing.reference;
      pair.existingSibling = existing.sibling;
      pair.worstConfirmed = confirmed.reference;
      pair.confirmedSibling = confirmed.sibling;
    }
    pairs.push(pair);
    if (stepEnds(index)) yield;
  }
  return pairs;
}

/** Изменение цены позиции. */
export interface PriceChange {
  key: string;
  productName: string;
  sku?: string | undefined;
  oldPrice: number;
  newPrice: number;
  /** Признак прежней и новой цены («от», диапазон) и верхняя граница диапазона; нет - точная. */
  oldQualifier?: PriceQualifier | undefined;
  oldMax?: number | undefined;
  newQualifier?: PriceQualifier | undefined;
  newMax?: number | undefined;
  /** Валюта новой цены. */
  currency: string;
  oldCurrency: string;
  /** Изменение в процентах (+ рост, − снижение), два знака после запятой. */
  changePct: number;
  /**
   * Последняя цена, подтверждённая человеком, если она отличается от прежней: скачок может
   * считаться от неё (накопленное изменение за серию импортов без подтверждения).
   */
  confirmedPrice?: number | undefined;
  confirmedCurrency?: string | undefined;
  /** Позиция снята с прайса при массовом сокращении (newPrice = 0, подтверждает человек). */
  removed?: boolean | undefined;
  /**
   * Позиции не было в прайсе: её цена сверена с одноимённой позицией с другим артикулом
   * (`oldPrice` - цена той позиции) и вышла за диапазон одноимённых (R9-A1-05).
   */
  newItem?: boolean | undefined;
}

/** Почему позицию должен посмотреть человек. */
export const PRICE_REVIEW_REASONS = [
  'price_jump',
  'no_sku',
  'duplicate',
  'same_name_different_sku',
  'currency_changed',
  'sku_changed',
] as const;
export type PriceReviewReason = (typeof PRICE_REVIEW_REASONS)[number];

/** Позиция «на проверку». */
interface PriceReviewEntry {
  key: string;
  productName: string;
  sku?: string | undefined;
  reason: PriceReviewReason;
}

/** Разница между текущим прайсом поставщика и новым. */
export interface PriceDiff {
  /** Позиции, которых раньше не было. */
  added: PriceItem[];
  /** Позиции, пропавшие из нового прайса. */
  removed: PriceItem[];
  /** Позиции с изменившейся ценой или валютой. */
  changed: PriceChange[];
  /** Изменения сверх порога и (с пометкой `removed`) позиции, снятые при массовом сокращении. */
  jumps: PriceChange[];
  review: PriceReviewEntry[];
  /** Позиций без изменений. */
  unchanged: number;
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
function* massRemovals(
  incoming: readonly PriceItem[],
  existingByKey: ReadonlyMap<string, PriceItem>,
  confirmedByKey: ReadonlyMap<string, PriceItem>,
): PriceSteps<PriceChange[]> {
  // Текущая цена важнее подтверждённой: подтверждённая нужна только для пропавших позиций.
  // Тот же порядок и те же значения, что у `new Map([...confirmed, ...existing])`, но без двух
  // промежуточных массивов на весь прайс (R9-A1-01).
  const known = new Map(confirmedByKey);
  for (const [key, item] of existingByKey) known.set(key, item);
  if (known.size === 0) return [];
  const matched = yield* matchedKnownKeys(incoming, known);
  const removed: PriceItem[] = [];
  for (const [key, item] of known) {
    if (!matched.has(key)) removed.push(item);
  }
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
 * Ключи известного состава, которым нашлась пара в новом прайсе: те же `old`, что дал бы
 * `pairAgainst(incoming, indexPrices([...known.values()]))`, без построения пар. Позиция с
 * тем же ключом - пара сразу; индекс по названию (с тем же порядком групп) строится, только
 * если есть позиции без пары по ключу.
 */
function* matchedKnownKeys(
  incoming: readonly PriceItem[],
  known: ReadonlyMap<string, PriceItem>,
): PriceSteps<Set<string>> {
  const matched = new Set<string>();
  const skuKeys = lazySkuKeys(incoming);
  let knownMatches: ((item: PriceItem) => PriceSteps<NameMatches>) | undefined;
  for (let index = 0; index < incoming.length; index += 1) {
    if (stepEnds(index)) yield;
    const key = priceItemKey(incoming[index] as PriceItem);
    if (known.has(key)) {
      matched.add(key);
      continue;
    }
    knownMatches ??= nameMatcher(yield* indexPricesSteps([...known.values()]), skuKeys);
    const item = incoming[index] as PriceItem;
    const old = worstInGroup(item, (yield* knownMatches(item)).renamed);
    if (old !== undefined) matched.add(priceItemKey(old));
  }
  return matched;
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
  return runPriceSteps(findPriceJumpsSteps(incoming, existing, threshold, confirmed));
}

/** `findPriceJumps` по шагам (см. `PriceSteps`). */
export function* findPriceJumpsSteps(
  incoming: readonly PriceItem[],
  existing: readonly PriceItem[],
  threshold: number = DEFAULT_JUMP_THRESHOLD,
  confirmed: readonly PriceItem[] = [],
): PriceSteps<PriceChange[]> {
  const existingIndex = yield* indexPricesSteps(existing);
  const confirmedIndex = yield* indexPricesSteps(confirmed);
  const pairs = yield* pairAgainst(incoming, existingIndex, confirmedIndex);
  const jumps = yield* jumpsFromPairs(pairs, threshold);
  const removals = yield* massRemovals(incoming, existingIndex.byKey, confirmedIndex.byKey);
  return [...jumps, ...removals];
}

/** Скачки по готовым парам (без снятия позиций); общий расчёт для `findPriceJumps` и diff. */
function* jumpsFromPairs(
  pairs: readonly PricePair[],
  threshold: number,
): PriceSteps<PriceChange[]> {
  const jumps: PriceChange[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    if (stepEnds(index)) yield;
    const pair = pairs[index] as PricePair;
    const { item, worstExisting, worstConfirmed } = pair;
    const fromExisting =
      worstExisting !== undefined && exceedsThreshold(item, worstExisting, threshold);
    const fromConfirmed =
      worstConfirmed !== undefined && exceedsThreshold(item, worstConfirmed, threshold);
    const reference = fromExisting ? worstExisting : (pair.old ?? worstExisting ?? worstConfirmed);
    if ((fromExisting || fromConfirmed) && reference !== undefined) {
      // Эталон - одноимённая позиция с другим артикулом (а не прежняя версия этой позиции).
      const sibling =
        fromExisting || (pair.old === undefined && worstExisting !== undefined)
          ? pair.existingSibling === true
          : pair.old === undefined && pair.confirmedSibling === true;
      const change = toChange(item, pair.key, reference, worstConfirmed);
      jumps.push(sibling ? { ...change, newItem: true } : change);
    }
  }
  return jumps;
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
  return runPriceSteps(nextConfirmedPricesSteps(confirmed, existing, committed, approvedKeys));
}

/** `nextConfirmedPrices` по шагам (см. `PriceSteps`). */
export function* nextConfirmedPricesSteps(
  confirmed: readonly PriceItem[],
  existing: readonly PriceItem[],
  committed: readonly PriceItem[],
  approvedKeys: ReadonlySet<string>,
): PriceSteps<PriceItem[]> {
  const next = yield* latestPricesSteps(confirmed);
  for (const [key, item] of yield* latestPricesSteps(existing)) {
    if (!next.has(key)) next.set(key, item);
  }
  const base = [...next.values()];
  const baseIndex = yield* indexPricesSteps(base);
  const baseMatches = nameMatcher(baseIndex, lazySkuKeys(committed));
  // Группы, чьи устаревшие ключи уже сняты: повторное снятие всей группы на каждую позицию
  // было O(n·g) при смене формата артикулов (R9-A1-05).
  const cleared = new Set<NameMatches>();
  const emptyIndex = yield* indexPricesSteps([]);
  const pairs = yield* pairAgainst(committed, emptyIndex, baseIndex);
  for (let index = 0; index < pairs.length; index += 1) {
    if (stepEnds(index)) yield;
    const pair = pairs[index] as PricePair;
    const { key } = pair;
    // Смена артикула: подтверждённая цена жила под старым ключом, а старый артикул из прайса
    // ушёл. Переносим её под новый ключ (принятый скачок - уже новой ценой) и убираем старый,
    // иначе старая цена навсегда остаётся «подтверждённой» и даёт ложные скачки (R3-ALG-17).
    const stale = baseIndex.byKey.has(key) ? NO_MATCHES : yield* baseMatches(pair.item);
    const carried = worstInGroup(pair.item, stale.renamed);
    if (carried !== undefined) {
      if (!cleared.has(stale)) {
        for (const old of stale.renamed.items) next.delete(priceItemKey(old));
        cleared.add(stale);
      } else if (stale.namelessKey !== undefined) {
        // Снова записать после снятия могли только ключ названия (позиция без артикула):
        // ключи ушедших артикулов не совпадают ни с одним ключом нового прайса.
        next.delete(stale.namelessKey);
      }
      next.set(key, approvedKeys.has(key) ? pair.item : renamedLike(carried, pair.item));
    } else if (approvedKeys.has(key) || pair.worstConfirmed === undefined) {
      next.set(key, pair.item);
    }
  }
  // Снятие позиции, принятое человеком, закрепляет новый состав: иначе каждый следующий импорт
  // снова считал бы её потерянной. Неподтверждённые мелкие потери в составе остаются.
  const committedKeys = new Set(pairs.map((pair) => pair.key));
  for (const key of approvedKeys) {
    if (!committedKeys.has(key)) next.delete(key);
  }
  return [...next.values()];
}

function toChange(
  item: PriceItem,
  key: string,
  old: PriceItem,
  confirmed?: PriceItem,
): PriceChange {
  const differs =
    confirmed !== undefined &&
    (confirmed.price !== old.price || confirmed.currency !== old.currency);
  return {
    key,
    productName: item.productName,
    ...(item.sku === undefined ? {} : { sku: item.sku }),
    oldPrice: old.price,
    newPrice: item.price,
    ...(old.priceQualifier === undefined ? {} : { oldQualifier: old.priceQualifier }),
    ...(old.priceMax === undefined ? {} : { oldMax: old.priceMax }),
    ...(item.priceQualifier === undefined ? {} : { newQualifier: item.priceQualifier }),
    ...(item.priceMax === undefined ? {} : { newMax: item.priceMax }),
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
function* sameNameDifferentSku(items: readonly PriceItem[]): PriceSteps<Set<string>> {
  // Второй артикул, отличный от первого, и есть «больше одного»: набор артикулов на каждое
  // название (сто тысяч множеств на большом прайсе) не нужен.
  const firstSku = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    if (stepEnds(index)) yield;
    const item = items[index] as PriceItem;
    const sku = skuKeyOf(item);
    if (sku === undefined) continue;
    const name = nameKeyOf(item);
    const first = firstSku.get(name);
    if (first === undefined) firstSku.set(name, sku);
    else if (first !== sku) ambiguous.add(name);
  }
  return ambiguous;
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
  return runPriceSteps(diffPricesSteps(existing, incoming, threshold, confirmed));
}

/** `diffPrices` по шагам (см. `PriceSteps`). */
export function* diffPricesSteps(
  existing: readonly PriceItem[],
  incoming: readonly PriceItem[],
  threshold: number = DEFAULT_JUMP_THRESHOLD,
  confirmed: readonly PriceItem[] = [],
): PriceSteps<PriceDiff> {
  const existingIndex = yield* indexPricesSteps(existing);
  const confirmedIndex = yield* indexPricesSteps(confirmed);
  const previous = existingIndex.byKey;
  const added: PriceItem[] = [];
  const changed: PriceChange[] = [];
  const review: PriceReviewEntry[] = [];
  const seen = new Set<string>();
  const matched = new Set<string>();
  const ambiguousNames = yield* sameNameDifferentSku(incoming);
  let unchanged = 0;
  const pairs = yield* pairAgainst(incoming, existingIndex, confirmedIndex);
  for (let index = 0; index < pairs.length; index += 1) {
    if (stepEnds(index)) yield;
    const pair = pairs[index] as PricePair;
    const { item, old, key } = pair;
    if (seen.has(key)) review.push(reviewEntry(item, 'duplicate'));
    seen.add(key);
    if (ambiguousNames.size > 0 && ambiguousNames.has(nameKeyOf(item))) {
      review.push(reviewEntry(item, 'same_name_different_sku'));
    }
    if (old === undefined) {
      added.push(item);
      if (item.sku === undefined) review.push(reviewEntry(item, 'no_sku'));
      continue;
    }
    matched.add(pair.oldKey ?? priceItemKey(old));
    if (pair.byName) review.push(reviewEntry(item, 'sku_changed'));
    if (samePrice(old, item)) {
      unchanged += 1;
      continue;
    }
    changed.push(toChange(item, key, old, pair.worstConfirmed));
    if (item.sku === undefined) review.push(reviewEntry(item, 'no_sku'));
    if (old.currency !== item.currency) review.push(reviewEntry(item, 'currency_changed'));
  }
  // Те же пары и индексы, что и у `findPriceJumps(incoming, existing, threshold, confirmed)`.
  const jumps = [
    ...(yield* jumpsFromPairs(pairs, threshold)),
    ...(yield* massRemovals(incoming, existingIndex.byKey, confirmedIndex.byKey)),
  ];
  for (const jump of jumps) {
    review.push({
      key: jump.key,
      productName: jump.productName,
      ...(jump.sku === undefined ? {} : { sku: jump.sku }),
      reason: 'price_jump',
    });
  }
  const removed: PriceItem[] = [];
  for (const [key, item] of previous) {
    if (!matched.has(key)) removed.push(item);
  }
  return { added, removed, changed, jumps, review, unchanged };
}

/**
 * Сколько позиций нового прайса добавится или изменит цену/валюту (`added + changed` у
 * `diffPrices`) без расчёта скачков, «на проверку» и снятых: нужен только счётчик.
 */
export function countPriceUpdates(
  existing: readonly PriceItem[],
  incoming: readonly PriceItem[],
): number {
  return runPriceSteps(countPriceUpdatesSteps(existing, incoming));
}

/** `countPriceUpdates` по шагам (см. `PriceSteps`). */
export function* countPriceUpdatesSteps(
  existing: readonly PriceItem[],
  incoming: readonly PriceItem[],
): PriceSteps<number> {
  let count = 0;
  const pairs = yield* pairAgainst(incoming, yield* indexPricesSteps(existing));
  for (const { item, old } of pairs) {
    if (old === undefined || !samePrice(old, item)) {
      count += 1;
    }
  }
  return count;
}
