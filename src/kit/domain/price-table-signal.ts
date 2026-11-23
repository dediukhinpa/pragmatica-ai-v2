/**
 * Признак «таблица цен» по уже разобранному тексту файла. Чистая функция: текст приходит из
 * базы знаний (первые фрагменты файла), сам файл не читается.
 */

/** Сколько первых фрагментов файла смотрит признак. */
export const PRICE_TABLE_CHUNK_COUNT = 4;
/** Сколько первых символов текста смотрит признак. */
export const PRICE_TABLE_TEXT_LIMIT = 4000;
/** Сколько строк таблицы с ценой нужно, чтобы считать текст таблицей цен. */
export const PRICE_TABLE_MIN_ROWS = 5;

/**
 * Слова, по которым текст говорит о ценах. Граница «опт» - `(?!\p{L})`, а не `\b`: в JS `\b`
 * знает только латиницу и после кириллической буквы не срабатывает.
 */
const PRICE_TOPIC = /цен[аыуе]|стоимост|прайс|price|руб|опт(?!\p{L})|розниц|ррц|мрц/iu;
/** Ячейка таблицы с числом (цена): `| 123,45 |`, `| 1 200 руб. |`. */
const PRICE_CELL = /\|\s*\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:₽|руб\.?|р\.)?\s*\|/u;

/**
 * Текст похож на таблицу цен: в первых {@link PRICE_TABLE_TEXT_LIMIT} символах есть слово о
 * ценах и не меньше {@link PRICE_TABLE_MIN_ROWS} строк таблицы с числовой ячейкой.
 *
 * @param text Начало текста файла (фрагменты, склеенные по порядку).
 */
export function looksLikePriceTableText(text: string): boolean {
  const head = text.slice(0, PRICE_TABLE_TEXT_LIMIT);
  if (!PRICE_TOPIC.test(head)) return false;
  let rows = 0;
  for (const line of head.split('\n')) {
    if (!PRICE_CELL.test(line)) continue;
    rows += 1;
    if (rows >= PRICE_TABLE_MIN_ROWS) return true;
  }
  return false;
}

/** Слово «прайс»/«price» в имени (то же, что в `price-file-kind`). */
const PRICE_NAME_WORD = /(?<!\p{L})(?:прайс|price)/iu;

/** Слово «прайс»/«price» в имени файла (базовое имя, без каталогов), независимо от типа файла. */
export function hasPriceWordInFileName(fileName: string): boolean {
  return PRICE_NAME_WORD.test(fileName.split(/[\\/]/).pop() ?? '');
}
