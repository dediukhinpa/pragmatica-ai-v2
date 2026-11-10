/**
 * Чистые функции для текстовых ячеек шаблона сайта (этап 225): нормализация пробелов и
 * инварианты текста (величины «число + единица», артикулы, токены маски), которые не должна
 * менять правка модели. Никаких обращений к модели и вводу-выводу.
 */

/** Символы нулевой ширины и BOM: невидимы, в ячейке не нужны. */
const INVISIBLE = /[​-‍⁠﻿]/g;
/** Неразрывные, узкие, тонкие и прочие пробелы Юникода, табуляция и разрывы страницы. */
const EXOTIC_SPACES = /[   -   　\t\v\f]/g;
/** Знаки, перед которыми пробела быть не должно. Процент не входит: «15 %» - число и единица. */
const SPACE_BEFORE_PUNCTUATION = / +([,.;:!?)»])/g;
/** Открывающие скобка и кавычка: пробела после них быть не должно. */
const SPACE_AFTER_OPENING = /([(«]) +/g;

/** Ссылка или адрес: пробелы внутри не правятся ни в каком режиме. */
const LINK_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/**
 * Режим пробелов. `prose` - текст для людей (название, описание): повторы схлопываются,
 * пробел перед знаком убирается. `strict` - артикулы, ссылки, формулы и прочие значения, где
 * внутренний пробел или знак - часть данных: правятся только края, невидимые и неразрывные.
 */
export type SpaceMode = 'prose' | 'strict';

/** Значение, которое нельзя править как текст: формула (`=...`) и ссылка. */
function isOpaqueValue(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('=') || LINK_LIKE.test(trimmed);
}

/**
 * Привести пробелы к обычному виду. Всегда: невидимые символы убираются, неразрывные и узкие
 * пробелы становятся обычными, края строк обрезаются. Режим `prose` (по умолчанию) дополнительно
 * схлопывает повторы, убирает пробел перед `,.;:!?)»` и после `(«`. Формулы и ссылки правятся
 * как `strict` в любом режиме. Переводы строк сохраняются (описание бывает многострочным).
 * Пробел между числом и единицей («300 мл», «15 %») остаётся ОДНИМ обычным: слитное «300мл» и
 * неразрывный пробел сайту не нужны.
 */
export function normalizeSpaces(text: string, mode: SpaceMode = 'prose'): string {
  const prose = mode === 'prose' && !isOpaqueValue(text);
  const lines = text
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(EXOTIC_SPACES, ' ')
    .split('\n')
    .map((line) => {
      if (!prose) return line.trim();
      return line
        .replace(/ {2,}/g, ' ')
        .trim()
        .replace(SPACE_BEFORE_PUNCTUATION, '$1')
        .replace(SPACE_AFTER_OPENING, '$1');
    });
  return lines.join('\n').trim();
}

/** Токен псевдонимизации: `[PERSON_1]`, `[ORG_12]`. */
const MASK_TOKEN = /\[[A-Z][A-Z_]*_\d+\]/gi;
/** Разряды через пробел (и неразрывный): «1 000» -> «1000», перед группой из трёх цифр. */
const THOUSANDS = /(\d)[ \u00a0\u202f](?=\d{3}(?!\d))/g;
/** Буква: за единицей буквы быть не должно («5 мес», «3 грамма» - не единицы). */
const LETTER = 'A-Za-zА-Яа-яЁё';
/**
 * Единицы: площадь и объём (`м²`, `м2`), электрические и частотные, объём данных, дюймы,
 * градусы, длина, масса, объём, штуки, деньги, проценты. Длинные написания раньше коротких.
 */
const UNIT_SOURCE =
  '(?:мм|см|дм|м)[²³23]|мАч|кВт|МГц|кГц|ГГц|Гц|Вт|Ач|[ГМТ][бБ]|дюйм(?:ов|а)?|мм|см|дм|мг|кг|' +
  'мл|шт|руб|mAh|mm|cm|dm|kg|ml|°\\s?[CСF]|м|г|л|g|l|m|W|%|₽';
/** Величина: число и необязательная единица сразу за ним. */
const QUANTITY = new RegExp(
  `(\\d+(?:[.,]\\d+)?)(?:\\s*(${UNIT_SOURCE})(?![\\d${LETTER}]))?`,
  'gi',
);
/** Слово-кандидат в артикулы: буквы, цифры и внутренние `-`, `/`, `.`, `_`. */
const WORD = /[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\-/._]*/g;
/** Слово, целиком состоящее из величин («300мл», «10x20x30мм», «5000мАч»): не артикул. */
const PURE_QUANTITY = new RegExp(
  `^\\d+(?:[.,]\\d+)?(?:${UNIT_SOURCE})?(?:[xх×*\\-/]\\d+(?:[.,]\\d+)?(?:${UNIT_SOURCE})?)*$`,
  'i',
);
/** Единица площади или объёма, записанная цифрой: «м2», «см3» (число стоит перед ней отдельно). */
const SQUARE_UNIT_WORD = /^(?:мм|см|дм|м)[23]$/i;
/**
 * Единицы, где регистр меняет смысл (мАч/МАч, Вт/вт, МГц/мГц): сравниваются как написаны. Прочие
 * приводятся к нижнему регистру.
 */
const CASE_SENSITIVE_UNITS: ReadonlySet<string> = new Set([
  'мач', 'квт', 'мгц', 'кгц', 'ггц', 'гц', 'вт', 'ач', 'гб', 'мб', 'тб', 'mah', 'w',
]);
const SUPERSCRIPTS: Readonly<Record<string, string>> = { '2': '²', '3': '³', '²': '²', '³': '³' };
/** Дробная часть из трёх цифр («1,500»): тысячи или полторы - неизвестно, число не трогаем. */
const AMBIGUOUS_FRACTION_DIGITS = 3;

/** Что не должна менять правка текста. Артикулы сравниваются с учётом регистра. */
export interface TextInvariants {
  /**
   * Величины в порядке следования: «число единица» («300 мл») либо просто число. Сравниваются
   * как мультимножество ПАР, а не отдельно числа и единицы: «300 мл, 500 г» и «300 г, 500 мл»
   * различаются.
   */
  quantities: string[];
  /** Слова, где вместе буквы и цифры (`AB-123/5`). */
  articles: Set<string>;
  masks: Set<string>;
}

function normalizeNumber(raw: string): string {
  const parts = /^(\d+)[.,](\d+)$/.exec(raw);
  if (parts === null) return raw;
  const whole = parts[1] ?? '';
  const fraction = parts[2] ?? '';
  // «1,500» не превращаем ни в 1,5, ни в 1500: нули остаются, запятая и точка равны.
  if (fraction.length === AMBIGUOUS_FRACTION_DIGITS) return `${whole}.${fraction}`;
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole : `${whole}.${trimmed}`;
}

function canonicalUnit(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  const lower = compact.toLowerCase();
  if (lower.startsWith('дюйм')) return 'дюйм';
  if (lower.startsWith('°')) return `°${compact.slice(1).toUpperCase()}`;
  const powered = /^(мм|см|дм|м)([²³23])$/.exec(lower);
  if (powered !== null) return `${powered[1] ?? ''}${SUPERSCRIPTS[powered[2] ?? ''] ?? ''}`;
  return CASE_SENSITIVE_UNITS.has(lower) ? compact : lower;
}

function isArticle(word: string): boolean {
  const trimmed = word.replace(/[-/._]+$/, '');
  if (!/\d/.test(trimmed) || !/[A-Za-zА-Яа-яЁё]/.test(trimmed)) return false;
  // Размер и количество с единицей («10x20x30», «300мл», «5000мАч») и «м2» - не артикул.
  return !PURE_QUANTITY.test(trimmed) && !SQUARE_UNIT_WORD.test(trimmed);
}

/** Выделить инварианты текста. */
export function extractInvariants(text: string): TextInvariants {
  const masks = new Set((text.match(MASK_TOKEN) ?? []).map((token) => token.toLowerCase()));
  const articles = new Set<string>();
  const body = text
    .replace(MASK_TOKEN, ' ')
    .replace(THOUSANDS, '$1')
    .replace(WORD, (word) => {
      if (!isArticle(word)) return word;
      articles.add(word.replace(/[-/._]+$/, ''));
      // Цифры артикула отдельными числами не считаются.
      return ' ';
    });
  const quantities: string[] = [];
  for (const match of body.matchAll(QUANTITY)) {
    const number = normalizeNumber(match[1] ?? '');
    quantities.push(match[2] === undefined ? number : `${number} ${canonicalUnit(match[2])}`);
  }
  return { quantities, articles, masks };
}

/** Различия инвариантов до и после правки, в виде подписей для сообщений. */
export interface InvariantDiff {
  /** Есть после, но не было до: изменено или выдумано. Всегда нарушение. */
  added: string[];
  /** Было до, нет после: потеряно. Нарушение, если сжатие не разрешено. */
  dropped: string[];
  /** Величины те же, но идут в другом порядке: нарушение без сжатия. */
  reordered: boolean;
}

function counts(items: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) result.set(item, (result.get(item) ?? 0) + 1);
  return result;
}

/** Элементы `from`, которых больше, чем в `other` (с учётом повторов), в порядке `from`. */
function surplus(from: readonly string[], other: readonly string[]): string[] {
  const have = counts(other);
  const result: string[] = [];
  for (const item of from) {
    const left = have.get(item) ?? 0;
    if (left > 0) have.set(item, left - 1);
    else result.push(item);
  }
  return result;
}

function quantityLabel(item: string): string {
  return item.includes(' ') ? `величина ${item}` : `число ${item}`;
}

/** Сравнить инварианты до и после: величины - мультимножества пар, остальное - множества. */
export function compareInvariants(before: string, after: string): InvariantDiff {
  const was = extractInvariants(before);
  const now = extractInvariants(after);
  const added = surplus(now.quantities, was.quantities).map(quantityLabel);
  const dropped = surplus(was.quantities, now.quantities).map(quantityLabel);
  for (const [key, label] of [
    ['articles', 'артикул'],
    ['masks', 'токен'],
  ] as const) {
    for (const item of now[key]) if (!was[key].has(item)) added.push(`${label} ${item}`);
    for (const item of was[key]) if (!now[key].has(item)) dropped.push(`${label} ${item}`);
  }
  const reordered =
    added.length === 0 &&
    dropped.length === 0 &&
    was.quantities.join('|') !== now.quantities.join('|');
  return { added, dropped, reordered };
}

/**
 * Различия нарушают правило: добавлено новое (изменено или выдумано) либо потеряно или
 * переставлено, когда нельзя. `allowDrop` - сжатие может опустить второстепенное и перестроить
 * фразы, но не добавить и не изменить; без сжатия величины обязаны совпасть и по составу, и по
 * порядку.
 */
export function violatesInvariants(diff: InvariantDiff, allowDrop: boolean): boolean {
  return diff.added.length > 0 || (!allowDrop && (diff.dropped.length > 0 || diff.reordered));
}
