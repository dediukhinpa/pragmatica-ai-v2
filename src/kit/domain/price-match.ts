import type { PriceItem } from './models';
import { normalizeProductName, normalizeSku } from './price-diff';

/** Сколько кандидатов показываем в вопросе при неоднозначном совпадении. */
const PRICE_MATCH_MAX_CANDIDATES = 5;

/** Что известно о позиции из слов сотрудника. */
export interface PriceItemQuery {
  sku?: string | undefined;
  productName?: string | undefined;
}

/** Результат поиска позиции в прайсе поставщика. */
export type PriceMatch =
  | { kind: 'match'; item: PriceItem }
  | { kind: 'none'; candidates: PriceItem[] }
  | { kind: 'ambiguous'; candidates: PriceItem[] };

/**
 * Прайс, подготовленный к поиску: нормализованные названия и артикулы считаются один раз.
 * Строится на прайс и переиспользуется для всех правок вызова (иначе каждая правка заново
 * нормализует весь прайс).
 */
export interface PriceMatchIndex {
  items: readonly PriceItem[];
  /** Нормализованные названия, по порядку позиций. */
  names: string[];
  /** Позиции по непустому нормализованному названию (в порядке прайса). */
  byName: Map<string, PriceItem[]>;
  /** Позиции по непустому нормализованному артикулу (в порядке прайса). */
  bySku: Map<string, PriceItem[]>;
}

/** Разделитель названий в общей строке поиска: в нормализованном названии его нет. */
const NAME_SEPARATOR = '\n';
/**
 * Предел перебора подстрок запроса (длина × число разных длин названий): дальше дешевле
 * прямой проход по прайсу. Названия в правках короткие, предел не достигается.
 */
const SUBSTRING_LOOKUPS_MAX = 20_000;

/**
 * Поиск «похожих» названий без прохода по всему прайсу на каждую правку (R9-A1-10: 200 правок
 * к прайсу 100 тыс. позиций - 3,6 с синхронно). Похожее - название содержит запрос или
 * запрос содержит название. Первое ищется `indexOf` по одной строке всех названий (вхождение
 * не пересекает разделитель), второе - поиском подстрок запроса нужных длин в `byName`.
 */
interface SimilarSearch {
  /** Все нормализованные названия через `NAME_SEPARATOR`. */
  joined: string;
  /** Начало каждого названия в `joined`, по порядку позиций. */
  starts: number[];
  /** Разные длины названий по возрастанию. */
  lengths: number[];
  /** Номер позиции в прайсе (для сортировки по порядку прайса). */
  positionOf: Map<PriceItem, number>;
}

const similarSearches = new WeakMap<PriceMatchIndex, SimilarSearch>();

function similarSearchOf(index: PriceMatchIndex): SimilarSearch {
  const cached = similarSearches.get(index);
  if (cached !== undefined) return cached;
  const starts: number[] = [];
  let offset = 0;
  for (const name of index.names) {
    starts.push(offset);
    offset += name.length + NAME_SEPARATOR.length;
  }
  const search: SimilarSearch = {
    joined: index.names.join(NAME_SEPARATOR),
    starts,
    lengths: [...new Set(index.names.map((name) => name.length))].sort((a, b) => a - b),
    positionOf: new Map(index.items.map((item, position) => [item, position])),
  };
  similarSearches.set(index, search);
  return search;
}

/** Номер названия, в которое попадает смещение `offset` общей строки. */
function nameAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Позиции, чьё название содержит `name` или содержится в нём; в порядке прайса. */
function similarPositions(index: PriceMatchIndex, name: string): number[] {
  const search = similarSearchOf(index);
  const found = new Set<number>();
  // Название содержит запрос: каждое вхождение в общей строке лежит внутри одного названия.
  for (let at = search.joined.indexOf(name); at !== -1; ) {
    const position = nameAt(search.starts, at);
    found.add(position);
    const next = search.starts[position + 1];
    if (next === undefined) break;
    at = search.joined.indexOf(name, next);
  }
  // Запрос содержит название: название - подстрока запроса одной из известных длин.
  const lengths = search.lengths.filter((length) => length <= name.length);
  if (lengths.length * name.length > SUBSTRING_LOOKUPS_MAX) {
    index.names.forEach((candidate, position) => {
      if (name.includes(candidate)) found.add(position);
    });
  } else {
    for (const length of lengths) {
      for (let start = 0; start + length <= name.length; start += 1) {
        for (const item of index.byName.get(name.slice(start, start + length)) ?? []) {
          found.add(search.positionOf.get(item) as number);
        }
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

function pushTo(map: Map<string, PriceItem[]>, key: string, item: PriceItem): void {
  const group = map.get(key);
  if (group === undefined) map.set(key, [item]);
  else group.push(item);
}

export function buildPriceMatchIndex(items: readonly PriceItem[]): PriceMatchIndex {
  const names: string[] = [];
  const byName = new Map<string, PriceItem[]>();
  const bySku = new Map<string, PriceItem[]>();
  for (const item of items) {
    const name = normalizeProductName(item.productName);
    names.push(name);
    pushTo(byName, name, item);
    const sku = normalizeSku(item.sku ?? '');
    if (sku !== '') pushTo(bySku, sku, item);
  }
  return { items, names, byName, bySku };
}

/**
 * Найти позицию в текущем прайсе. Назван артикул - ищем ТОЛЬКО по нему (нормализация как у
 * ключа позиции): если такого артикула нет, правка не переносится на позицию с похожим или
 * даже точно совпавшим названием, а возвращается «не найдено» с кандидатами по названию.
 * Артикул и название указывают на разные позиции - «неоднозначно». Без артикула - точное
 * название (без регистра и лишних пробелов); похожее название не совпадение: кандидаты
 * отдаются человеку.
 *
 * `index` - готовый индекс прайса; при нескольких правках к одному прайсу его строят один раз.
 */
export function matchPriceItem(
  items: readonly PriceItem[],
  query: PriceItemQuery,
  index: PriceMatchIndex = buildPriceMatchIndex(items),
): PriceMatch {
  const sku = query.sku === undefined ? '' : normalizeSku(query.sku);
  const name = query.productName === undefined ? '' : normalizeProductName(query.productName);
  const exact: readonly PriceItem[] = name === '' ? [] : (index.byName.get(name) ?? []);
  // Похожие позиции нужны не во всех ветках: полный проход по названиям - только по запросу.
  let similarCache: PriceItem[] | undefined;
  const similarItems = (): PriceItem[] => {
    if (name === '') return [];
    similarCache ??= similarPositions(index, name).map(
      (position) => index.items[position] as PriceItem,
    );
    return similarCache;
  };
  const limit = (candidates: readonly PriceItem[]): PriceItem[] =>
    [...new Set(candidates)].slice(0, PRICE_MATCH_MAX_CANDIDATES);
  if (sku !== '') {
    const bySku = index.bySku.get(sku) ?? [];
    const [only] = bySku;
    if (bySku.length > 1) return { kind: 'ambiguous', candidates: limit(bySku) };
    if (only === undefined) {
      return { kind: 'none', candidates: limit([...exact, ...similarItems()]) };
    }
    const others = exact.filter((item) => item !== only);
    if (others.length > 0 && !exact.includes(only)) {
      return { kind: 'ambiguous', candidates: limit([only, ...others]) };
    }
    // Название не про найденную позицию, но похоже на другую: не угадываем (R3-ALG-18).
    if (name !== '' && !exact.includes(only)) {
      const similar = similarItems();
      const otherSimilar = similar.filter((item) => item !== only);
      if (!similar.includes(only) && otherSimilar.length > 0) {
        return { kind: 'ambiguous', candidates: limit([only, ...otherSimilar]) };
      }
    }
    return { kind: 'match', item: only };
  }
  if (name === '') return { kind: 'none', candidates: [] };
  if (exact.length === 1 && exact[0] !== undefined) return { kind: 'match', item: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: limit(exact) };
  return { kind: 'none', candidates: limit(similarItems()) };
}
