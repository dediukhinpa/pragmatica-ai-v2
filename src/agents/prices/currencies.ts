/**
 * Общий список валют прайса: символы, коды и написания. Источник - shared/currencies.json,
 * константы генерирует scripts/sync-shared.sh (`--check` падает при расхождении).
 */
import { PRICE_CURRENCIES } from './currencies.generated';

const CODE_PATTERN = /^[A-Z]{3}$/;

/** Метка (символ, слово или код в нижнем регистре) -> код валюты. */
const CODE_BY_MARK: ReadonlyMap<string, string> = new Map(
  PRICE_CURRENCIES.flatMap((entry) => [
    [entry.code.toLowerCase(), entry.code] as const,
    ...entry.symbols.map((mark) => [mark.toLowerCase(), entry.code] as const),
    ...entry.aliases.map((mark) => [mark.toLowerCase(), entry.code] as const),
  ]),
);

/** Код валюты по метке («₽», «руб.», «usd», «EUR»); null, если метка не из списка. */
export function currencyOfMark(mark: string): string | null {
  const text = mark.trim().toLowerCase();
  const known = CODE_BY_MARK.get(text);
  if (known !== undefined) return known;
  const upper = text.toUpperCase();
  return CODE_PATTERN.test(upper) ? upper : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Метки по убыванию длины: «руб.» раньше «руб», «рублей» раньше «р». */
const MARKS_LONGEST_FIRST: readonly string[] = [...CODE_BY_MARK.keys()].sort(
  (a, b) => b.length - a.length,
);
const MARKS_ALTERNATION = MARKS_LONGEST_FIRST.map(escapeRegExp).join('|');
const SYMBOLS_ALTERNATION = PRICE_CURRENCIES.flatMap((entry) => entry.symbols)
  .map(escapeRegExp)
  .join('|');

/**
 * Валюта в конце ячейки цены: «100 руб.», «1200¥», «5 usd». Перед разбором `parsePriceCell`
 * схлопывает ряды пробелов в один, поэтому `\s?` достаточно: вложенный `.*?\s*` на длинном
 * ряде пробелов был квадратичным (R8-D2-01).
 *
 * Метка не должна продолжать слово («абвруб»): условие «перед меткой не буква» записано не
 * просмотром назад `(?<![\p{L}])`, а самой группой числа - пустой или кончается не буквой.
 * Набор принятых ячеек тот же, но JSC исполнял просмотр назад на каждой позиции в 10-20 раз
 * медленнее: «1 234,50» - 15 мкс против 1 мкс, а это две проверки на строку прайса (R9-A1-03).
 */
export const PRICE_WITH_SUFFIX = new RegExp(
  `^(|.*?[^\\p{L}])\\s?(${MARKS_ALTERNATION})$`,
  'iu',
);
/** Предел длины ячейки цены после схлопывания пробелов: длиннее - это не цена. */
export const PRICE_CELL_MAX_CHARS = 128;
/** Ряд из двух и более пробельных знаков (включая NBSP) - заменяется одним пробелом. */
const WHITESPACE_RUN = /\s{2,}/gu;
/** Привести ячейку цены к виду для регулярок: схлопнуть ряды пробелов, обрезать края. */
export function normalizePriceCell(raw: string): string {
  return raw.replace(WHITESPACE_RUN, ' ').trim();
}
/** Символ или трёхбуквенный код в начале ячейки: «$100», «USD 5». */
const CODES_ALTERNATION = MARKS_LONGEST_FIRST.filter((mark) => /^[a-z]{3}$/.test(mark))
  .map(escapeRegExp)
  .join('|');
export const PRICE_WITH_PREFIX = new RegExp(
  `^(${SYMBOLS_ALTERNATION}|(?:${CODES_ALTERNATION})(?=\\s|\\d))\\s*(.*)$`,
  'iu',
);

/** Граница слова для меток-слов: не буква и не цифра (и не точка перед «р.»). */
const WORD_BEFORE = '(?<![\\p{L}\\p{N}.])';
const WORD_AFTER = '(?![\\p{L}\\p{N}])';
const HEADER_WORD_MARKS = new RegExp(
  `${WORD_BEFORE}(${MARKS_ALTERNATION})${WORD_AFTER}`,
  'giu',
);
const HEADER_SYMBOLS = new RegExp(`(${SYMBOLS_ALTERNATION})`, 'gu');

/**
 * Валюты, названные в заголовке столбца («Цена, USD», «Цена (¥)», «руб.»). Слова
 * ищутся только отдельным токеном: «за кор.», «Европа» валюты не дают.
 */
export function currenciesInHeader(header: string): string[] {
  const found = new Set<string>();
  for (const match of header.matchAll(HEADER_SYMBOLS)) {
    const code = currencyOfMark(match[1] ?? '');
    if (code !== null) found.add(code);
  }
  for (const match of header.matchAll(HEADER_WORD_MARKS)) {
    const code = CODE_BY_MARK.get((match[1] ?? '').toLowerCase());
    if (code !== undefined) found.add(code);
  }
  return [...found];
}
