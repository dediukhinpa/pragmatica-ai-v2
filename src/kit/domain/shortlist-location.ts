/**
 * Приоритет локации в шорт-листе (этап 143, решение владельца 02.11): поставщики названной
 * локации идут первой группой, внутри группы порядок прежний. Здесь только чистые функции.
 */

/** Сколько локаций учитывается в одном запросе (остальные отбрасываются). */
export const LOCATIONS_MAX = 5;
/** Предел длины строки локации от модели. */
export const LOCATION_INPUT_MAX_LENGTH = 200;

/** Всё, что код знает о месте поставщика (структурно, без зависимости от строки шорт-листа). */
export interface PlaceFacts {
  city?: string | undefined;
  address?: string | undefined;
  webEnrichment?: { city?: string | undefined } | undefined;
}

/** Разделители перечисления локаций: «Екатеринбург и Москва», «Москва, Тверь», «а / б». */
const LOCATION_SEPARATORS = /\s*(?:[,;/]|(?:^|\s)(?:и|или)(?=\s))\s*/iu;
/** Слова, не отличающие одно место от другого. */
const PLACE_STOPWORDS: ReadonlySet<string> = new Set([
  'на', 'в', 'и', 'область', 'обл', 'край', 'респ', 'республика', 'город', 'гор', 'ул',
  'улица', 'дом', 'россия', 'рф',
]);
const WORD = /[\p{L}\p{N}]+/gu;
/** Слово короче этого не сопоставляется (индексы, «г», «д»). */
const MIN_WORD_LENGTH = 3;
/** Общий префикс слов не короче этого (если слова не короче): отсекает случайные совпадения. */
const MIN_COMMON_PREFIX = 4;
/** Сколько букв слова допускается «дальше» общего префикса (падежное окончание). */
const ENDING_TAIL = 2;
/** Слова не длиннее этого сопоставляются строже: у них случайные совпадения чаще. */
const SHORT_WORD = 5;
/** Часть адреса с улицей: её название («Московская ул.», «Тверская») - не место поставщика. */
const STREET_PART =
  /(?:^|[\s.])(?:ул|улица|пр|пр-т|просп|проспект|пер|переулок|ш|шоссе|наб|набережная|б-р|бульвар|пл|площадь|тракт|проезд|тупик)(?=$|[\s.,])|(?:ая|ой|ий|ый)\s+(?:ул|улица)/iu;

/** Слова места без регистра и `ё`, без служебных слов и коротышей. */
function placeWords(text: string): string[] {
  const lowered = text.toLowerCase().replaceAll('ё', 'е');
  return (lowered.match(WORD) ?? []).filter(
    (word) => word.length >= MIN_WORD_LENGTH && !PLACE_STOPWORDS.has(word),
  );
}

function commonPrefix(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

/**
 * Одно ли слово в разных падежах/формах («москва» - «москве» - «московский»): общий префикс
 * не короче `min(4, короче-1)` и не меньше «короче минус окончание».
 */
function sameStem(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  // Короткое слово («Орёл», «Тула») не должно цепляться за длинное другое («Орехово-Зуево»).
  if (shorter <= SHORT_WORD && Math.max(a.length, b.length) > shorter + ENDING_TAIL) return false;
  const need = Math.max(Math.min(shorter - 1, MIN_COMMON_PREFIX), shorter - ENDING_TAIL);
  return commonPrefix(a, b) >= need;
}

/** Разбор строки локации от модели: список названий в порядке упоминания, без повторов. */
export function parseLocations(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(LOCATION_SEPARATORS)) {
    const name = part.trim();
    const key = placeWords(name).join(' ');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result.slice(0, LOCATIONS_MAX);
}

/** Адрес без частей с улицами: «620000, г. Екатеринбург, ул. Московская, 1» -> Екатеринбург. */
function addressWithoutStreets(address: string): string {
  return address
    .split(',')
    .filter((part) => !STREET_PART.test(part))
    .join(', ');
}

/**
 * Тексты места поставщика; пусто - данных о месте нет. Город важнее адреса: адрес берётся
 * только когда города нет, и без названий улиц (иначе «Московская ул.» делала бы
 * екатеринбургского поставщика московским).
 */
function placeTexts(entry: PlaceFacts): string[] {
  const cities = [entry.city, entry.webEnrichment?.city].filter(
    (text): text is string => text !== undefined && text.trim() !== '',
  );
  if (cities.length > 0) return cities;
  return entry.address === undefined ? [] : [addressWithoutStreets(entry.address)];
}

/** Относится ли место поставщика к локации: все слова локации находятся в его данных. */
export function matchesLocation(entry: PlaceFacts, location: string): boolean {
  const wanted = placeWords(location);
  if (wanted.length === 0) return false;
  const have = placeTexts(entry).flatMap(placeWords);
  return wanted.every((word) => have.some((candidate) => sameStem(word, candidate)));
}

/** Номер первой подходящей локации; `locations.length` - не подошла ни одна (или места нет). */
export function locationIndexOf(entry: PlaceFacts, locations: readonly string[]): number {
  const index = locations.findIndex((location) => matchesLocation(entry, location));
  return index === -1 ? locations.length : index;
}

/**
 * Разбить на группы по порядку локаций: группа 0 - первая локация, ..., последняя - остальные.
 * Порядок внутри группы сохраняется. Пустые группы остаются (индексы совпадают с локациями).
 */
export function groupByLocation<T extends PlaceFacts>(
  entries: readonly T[],
  locations: readonly string[],
): T[][] {
  const groups: T[][] = Array.from({ length: locations.length + 1 }, () => []);
  for (const entry of entries) groups[locationIndexOf(entry, locations)]?.push(entry);
  return groups;
}

/** Стабильно поставить поставщиков локаций вперёд; без локаций порядок не меняется. */
export function prioritizeByLocation<T extends PlaceFacts>(
  entries: readonly T[],
  locations: readonly string[],
): T[] {
  return locations.length === 0 ? [...entries] : groupByLocation(entries, locations).flat();
}

/** К какой из названных локаций отнесён поставщик (как назвал сотрудник); нет - `undefined`. */
export function assignedLocation(
  entry: PlaceFacts,
  locations: readonly string[],
): string | undefined {
  return locations[locationIndexOf(entry, locations)];
}
