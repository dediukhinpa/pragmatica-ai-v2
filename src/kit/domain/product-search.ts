import { normalizeProductName } from './price-diff';
import { DomainError } from '@business-ai/core';

/**
 * Слово названия короче этого не считается началом слова запроса: «м8» или «din» не должны
 * совпадать с любым токеном, который с них начинается.
 */
export const MIN_STEM_WORD_LENGTH = 4;
/** Разделители слов в названии позиции (пробелы, точки, скобки, кавычки, косая черта). */
const PRODUCT_WORD_SEPARATORS = '[\\s.,;:()/"«»]+';
const WORD_SPLIT = new RegExp(PRODUCT_WORD_SEPARATORS);

/**
 * Токены поискового запроса по правилу сравнения названий (NFKC, «ё», тире, регистр).
 * Пустой или пробельный запрос - ошибка: он совпал бы со всем прайсом (R4-ALG-5).
 */
export function productSearchTokens(query: string): string[] {
  const tokens = normalizeProductName(query)
    .split(WORD_SPLIT)
    .filter((token) => token !== '');
  if (tokens.length === 0) {
    throw new DomainError(
      'validation_failed',
      'Поисковый запрос пуст: укажите название или артикул.',
    );
  }
  return [...new Set(tokens)];
}

/**
 * Позиция подходит под запрос, если каждый токен запроса есть в названии или артикуле как
 * подстрока либо является продолжением целого слова названия («оцинкованный» - «оцинк.»).
 */
export function productMatchesTokens(
  tokens: readonly string[],
  productName: string,
  sku?: string,
): boolean {
  const hay = normalizeProductName(`${productName} ${sku ?? ''}`);
  const words = hay.split(WORD_SPLIT).filter((word) => word.length >= MIN_STEM_WORD_LENGTH);
  return tokens.every(
    (token) => hay.includes(token) || words.some((word) => token.startsWith(word)),
  );
}

/**
 * Разделители слов для поиска «по началу слова»: те же, что в названии позиции, плюс дефис
 * («мёд-липовый»). SQL-адаптеры подставляют это же выражение в regexp_replace.
 */
export const WORD_START_SEPARATORS = '[\\s.,;:()/"«»-]+';
const WORD_START_SPLIT = new RegExp(WORD_START_SEPARATORS);

/** Короче этого слова-основы не бывает: «чай», «сыр», «мёд» (после «ё»->«е» - «мед») значимы. */
const MIN_SIGNIFICANT_LENGTH = 3;
/** С такой длины у слова отбрасывается последняя буква (окончание): «орехи» -> «орех». */
const STEM_TRIM_FROM_LENGTH = 5;
const ONLY_DIGITS = /^\d+$/;

/**
 * Служебные слова и единицы: предлоги, союзы, меры. Не товар, искать по ним нельзя (без «ё»:
 * токены уже нормализованы).
 */
export const SERVICE_WORDS: ReadonlySet<string> = new Set([
  'для', 'без', 'под', 'над', 'при', 'про', 'из', 'на', 'по', 'от', 'до', 'за', 'или', 'как',
  'шт', 'штук', 'штуки', 'кг', 'гр', 'мл', 'литр', 'литра', 'литров', 'тара', 'тары', 'таре',
]);
/**
 * Основы слов упаковки и формы поставки («в банках», «упаковка», «набор»): это не товар, а
 * тара, по ним в прайсе и карточках находится что угодно («банки для мёда», «Драже в банках»).
 * Слово считается упаковкой, если начинается с одной из основ.
 */
export const PACKAGING_STEMS: readonly string[] = [
  'банк', 'баноч', 'упак', 'набор', 'комплект', 'короб', 'пакет', 'бутыл', 'ведр', 'канистр',
  'фасов', 'мешк', 'мешок', 'контейнер', 'коробк', 'пласт', 'стекл',
];

/** Слово - не товар: служебное, упаковка или число. */
function isNoiseToken(token: string): boolean {
  return (
    SERVICE_WORDS.has(token) ||
    ONLY_DIGITS.test(token) ||
    PACKAGING_STEMS.some((stem) => token.startsWith(stem))
  );
}

/** Основа слова для сравнения по началу слова: без последней буквы у длинных слов. */
function wordStem(token: string): string {
  const chars = Array.from(token);
  return chars.length >= STEM_TRIM_FROM_LENGTH ? chars.slice(0, -1).join('') : token;
}

/**
 * Значимые слова-товар запроса: без служебных, упаковки и чисел, с основами вместо слов
 * (ослабленный поиск, когда строгий по всем словам ничего не дал). Нет значимых слов -
 * пустой массив: искать «всё подряд» нельзя.
 */
export function significantProductTokens(query: string): string[] {
  const tokens = normalizeProductName(query)
    .split(WORD_START_SPLIT)
    .filter((token) => Array.from(token).length >= MIN_SIGNIFICANT_LENGTH && !isNoiseToken(token));
  return [...new Set(tokens.map(wordStem))];
}

/** До этой длины токен короткий: «мед», «чай», «сыр», «орех» - после него нужна форма слова. */
const SHORT_TOKEN_MAX_LENGTH = 4;
/**
 * Что может стоять после короткого токена в том же слове: падежное окончание или «-ов-» +
 * окончание прилагательного («мёд» - «мёда», «медовый»), но не «-аль»/«-ный»: «мед» не должен
 * находить «медаль» и «медный».
 */
const SHORT_TOKEN_ENDINGS =
  '(?:|а|у|е|ы|и|ом|ем|ов|ей|ам|ах|ами|' +
  'ов(?:ый|ая|ое|ые|ой|ых|ого|ому|ую|ым|ом|о|а|ы))';
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Регулярное выражение «слово названия начинается с токена» для текста, где слова склеены
 * одиночными пробелами и обрамлены пробелами (` слово слово `). Длинный токен - любое начало
 * слова; короткий - только он сам с окончанием (см. `SHORT_TOKEN_ENDINGS`). Один и тот же
 * шаблон используют код и SQL-адаптеры (оператор `~`), чтобы память и Postgres не расходились.
 */
export function wordStartPattern(token: string): string {
  const escaped = token.replace(REGEX_SPECIALS, '\\$&');
  const tail = Array.from(token).length <= SHORT_TOKEN_MAX_LENGTH ? `${SHORT_TOKEN_ENDINGS} ` : '';
  return ` ${escaped}${tail}`;
}

/** Слова названия и артикула, склеенные одиночными пробелами и обрамлённые ими. */
function spacedWords(productName: string, sku: string | undefined): string[] {
  return normalizeProductName(`${productName} ${sku ?? ''}`)
    .split(WORD_START_SPLIT)
    .filter((word) => word !== '');
}

/**
 * Токен совпал с началом слова названия или артикула, а не любой подстрокой (см.
 * `wordStartPattern`), либо целое слово названия длиной от `MIN_STEM_WORD_LENGTH` - начало
 * токена («орехи» - «орех»).
 */
export function wordStartMatches(token: string, productName: string, sku?: string): boolean {
  const words = spacedWords(productName, sku);
  if (new RegExp(wordStartPattern(token)).test(` ${words.join(' ')} `)) return true;
  return words.some((word) => word.length >= MIN_STEM_WORD_LENGTH && token.startsWith(word));
}

/** Доля токенов запроса (0..1), совпавших по началу слова с названием или артикулом. */
export function wordStartShare(
  tokens: readonly string[],
  productName: string,
  sku?: string,
): number {
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => wordStartMatches(token, productName, sku)).length;
  return matched / tokens.length;
}

/**
 * Основы существительных тары и формы поставки («в банке», «в пакете», «тубус»). Это уточнение
 * к товару, а не сам товар: при поиске по прайсам оно отделяется от названия. Уже, чем
 * `PACKAGING_STEMS`: «набор», «комплект» и «пласт» здесь нет - это бывает самим товаром
 * («набор ручек», «пластиковая ручка»).
 */
export const PACKAGING_NOUN_STEMS: readonly string[] = [
  'банк', 'баноч', 'упак', 'короб', 'пакет', 'бутыл', 'ведр', 'канистр', 'фасов', 'мешк',
  'мешок', 'контейнер', 'тубус', 'пачк', 'кульк', 'жестянк', 'флакон',
];
/** Слова тары, которые нельзя задать основой («тара» - основа «тар» поймала бы «тарелку»). */
const PACKAGING_NOUN_WORDS: ReadonlySet<string> = new Set([
  'тара', 'тары', 'таре', 'тару', 'тарой',
]);
/**
 * Основы материалов тары: «стеклянных банках», «в подарочной упаковке». Отделяются, только если
 * стоят рядом со словом тары: «кружка стеклянная» - товар из стекла, а не тара.
 */
export const PACKAGING_MATERIAL_STEMS: readonly string[] = [
  'стекл', 'пласт', 'картон', 'бумаж', 'жестян', 'металл', 'полиэтилен', 'подароч', 'вакуум',
];
/** Предлоги, связывающие товар с тарой: «мёд В банке», «орехи ИЗ упаковки». */
const PACKAGING_LINK_WORDS: ReadonlySet<string> = new Set([
  'в', 'во', 'из', 'с', 'со', 'для', 'на', 'по',
]);
/** Единицы объёма и массы после слова тары («в банке 0,5 л»): входят в уточнение. */
const QUANTITY_UNIT_WORDS: ReadonlySet<string> = new Set([
  'г', 'гр', 'кг', 'л', 'мл', 'литр', 'литра', 'литров', 'шт', 'штук', 'см', 'мм',
]);
/** Запятая или точка с запятой между словами (не в «0,5») отделяет следующий товар: как «и». */
const PRODUCT_LIST_SEPARATOR = /(?<=\D)\s*[,;]\s*/g;
const PRODUCT_CONJUNCTION = 'и';

function isPackagingNoun(word: string): boolean {
  return PACKAGING_NOUN_WORDS.has(word) || PACKAGING_NOUN_STEMS.some((s) => word.startsWith(s));
}

function isPackagingMaterial(word: string): boolean {
  return PACKAGING_MATERIAL_STEMS.some((stem) => word.startsWith(stem));
}

/** Слова нормализованного названия; запятая между товарами превращается в союз «и». */
function productWords(query: string): string[] {
  return normalizeProductName(query)
    .replace(PRODUCT_LIST_SEPARATOR, ` ${PRODUCT_CONJUNCTION} `)
    .split(WORD_START_SPLIT)
    .filter((word) => word !== '');
}

/** В слове есть смысл товара: не служебное, не упаковка, не число, не короче трёх букв. */
function isProductWord(word: string): boolean {
  return Array.from(word).length >= MIN_SIGNIFICANT_LENGTH && !isNoiseToken(word);
}

/**
 * Название позиции без уточнения о таре: «мёд в стеклянных банках» -> «мед», «орехи в пакете
 * 1 кг» -> «орехи». Убираются слова тары, материал рядом с ними, связующий предлог и мера
 * после тары. Если кроме тары в позиции нет слов товара («банка стеклянная 0,5 л», «коробка
 * для кружек» целиком - сама тара), позиция возвращается как есть: тара ищется как товар.
 */
export function productQueryWithoutPackaging(query: string): string {
  const words = productWords(query);
  const dropped = new Array<boolean>(words.length).fill(false);
  for (const [index, word] of words.entries()) {
    if (!isPackagingNoun(word)) continue;
    dropped[index] = true;
    let before = index - 1;
    while (before >= 0 && isPackagingMaterial(words[before] ?? '')) dropped[before--] = true;
    if (before >= 0 && PACKAGING_LINK_WORDS.has(words[before] ?? '')) dropped[before] = true;
    let after = index + 1;
    while (after < words.length) {
      const next = words[after] ?? '';
      if (!isPackagingMaterial(next) && !ONLY_DIGITS.test(next) && !QUANTITY_UNIT_WORDS.has(next)) {
        break;
      }
      dropped[after++] = true;
    }
  }
  const kept = words.filter((_, index) => !dropped[index]);
  // Тара в начале («коробка для кружек») - сама позиция, а не уточнение к другому товару.
  const firstPackaging = words.findIndex(isPackagingNoun);
  if (firstPackaging < 0) return query.trim();
  const hasProductBefore = words.slice(0, firstPackaging).some(isProductWord);
  return hasProductBefore && kept.some(isProductWord) ? kept.join(' ') : query.trim();
}

/**
 * Несколько товаров в одной позиции («мёд и орехи»): каждый ищется отдельно. Делится по союзу
 * «и» и запятой, только если в каждой части есть слово товара; иначе позиция одна. Лишняя
 * часть безвредна: строки прайса всё равно проверяются на соответствие всей позиции.
 */
export function splitProductParts(query: string): string[] {
  const parts: string[][] = [[]];
  for (const word of productWords(query)) {
    if (word === PRODUCT_CONJUNCTION) parts.push([]);
    else parts[parts.length - 1]?.push(word);
  }
  const phrases = parts.filter((part) => part.length > 0);
  if (phrases.length < 2 || !phrases.every((part) => part.some(isProductWord))) {
    return [query.trim()];
  }
  return phrases.map((part) => part.join(' '));
}

/**
 * Токены поиска строк прайса по началу слова: без служебных слов и одиночных букв, у длинных
 * слов без окончания («орехи» -> «орех»). Короткие («мед», «м8») остаются целыми и ищутся с
 * допустимыми окончаниями (`wordStartPattern`). Все токены служебные - берутся как есть.
 */
export function rankedSearchTokens(query: string): string[] {
  const all = productSearchTokens(query);
  const meaningful = all.filter(
    (token) =>
      !SERVICE_WORDS.has(token) && !(Array.from(token).length === 1 && /\p{L}/u.test(token)),
  );
  return [...new Set((meaningful.length === 0 ? all : meaningful).map(wordStem))];
}

/** Префикс `source_file` строк, взятых с диска (прайсы в папке производителей). */
export const DISK_PRICE_SOURCE_PREFIX = 'produkciya/';
/** Место строки в тай-брейке по источнику: диск выше, всё остальное (почта и прочее) ниже. */
export const DISK_SOURCE_RANK = 0;
export const OTHER_SOURCE_RANK = 1;

/**
 * Ранг источника строки прайса для тай-брейка выдачи. Зачем: диск - проверенный прайс, а
 * почтовая строка (`mail:...`) - случайное вложение; при равной релевантности диск идёт выше.
 * Используется только как порядок среди равных, составом выдачи и порогами не управляет.
 */
export function priceSourceRank(sourceFile: string | undefined | null): number {
  return sourceFile?.startsWith(DISK_PRICE_SOURCE_PREFIX) === true
    ? DISK_SOURCE_RANK
    : OTHER_SOURCE_RANK;
}
