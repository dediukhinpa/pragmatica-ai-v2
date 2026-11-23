import { localDateKey } from '@business-ai/core';
import { DEFAULT_BUSINESS_TIMEZONE } from './monitoring';

/**
 * Дата из названия файла прайса. `day === null` - в названии указан только месяц
 * (точность «месяц»).
 */
export interface PriceFileDate {
  year: number;
  month: number;
  day: number | null;
}

/** Срок актуальности прайса по ТЗ: больше этого числа календарных месяцев - устарел. */
export const PRICE_FILE_STALE_MONTHS = 3;

/** Допустимое окно годов в названии файла. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;
/** Век для двухзначного года: 26 -> 2026. */
const TWO_DIGIT_YEAR_BASE = 2000;
const MONTHS_IN_YEAR = 12;
const MAX_DAY_IN_MONTH = 31;
/** Длина слитной записи даты: ддммгггг или ггггммдд. */
const SOLID_DATE_LENGTH = 8;
const SOLID_DAY_OFFSET = 6;
const SOLID_MONTH_OFFSET = 4;
const SOLID_DAY_MONTH_WIDTH = 2;
const KEY_PART_WIDTH = 2;
const KEY_YEAR_WIDTH = 4;
/** Знак-заглушка вместо уже разобранной даты: не цифра, не буква, не разделитель. */
const MASK_CHAR = '#';
/** Високосный год для проверки существования дня и месяца без года (29 февраля есть). */
const LEAP_YEAR = 2024;
/** Сколько прошлых лет перебирается для даты без года (29 февраля бывает раз в 4 года). */
const YEARLESS_LOOKBACK_YEARS = 4;
/** Опечатка года: лишняя цифра (`20225`) - пять цифр подряд, начинающиеся с `20`. */
const TYPO_YEAR_LENGTH = 5;
/** Верхняя граница месяца в двухзначной записи «мм-гг»; больше - это год, а не месяц. */
const TWO_DIGIT_YEAR_MIN = 20;

/** Разделители частей даты в числовой записи. */
const SEP = '[._\\-/]';
/** Месяц не должен примыкать к предыдущей цифре или к предыдущему разделителю с цифрой. */
const NO_DIGIT_BEFORE = '(?<!\\d)(?<!\\d[._\\-/])';

/** Непосредственно перед числовой датой не должна стоять `v`/`V`: это версия (`v2.10.2026`). */
const NO_VERSION_BEFORE = '(?<![vV])';

/** Названия месяцев (русские и английские): полные и сокращённые формы, по номеру месяца. */
const MONTH_WORDS: readonly string[] = [
  'янв(?:ар(?:ь|я))?|jan(?:uary)?',
  'фев(?:рал(?:ь|я))?|feb(?:ruary)?',
  'мар(?:та|т)?|mar(?:ch)?',
  'апр(?:ел(?:ь|я))?|apr(?:il)?',
  'ма(?:й|я)|may',
  'июн(?:ь|я)?|june?',
  'июл(?:ь|я)?|july?',
  'авг(?:уста|уст)?|aug(?:ust)?',
  'сен(?:т(?:ябр(?:ь|я))?)?|sep(?:t(?:ember)?)?',
  'окт(?:ябр(?:ь|я))?|oct(?:ober)?',
  'ноя(?:бр(?:ь|я))?|nov(?:ember)?',
  'дек(?:абр(?:ь|я))?|dec(?:ember)?',
];
const MONTH_ANY = MONTH_WORDS.map((word) => `(?:${word})`).join('|');
const MONTH_MATCHERS: readonly RegExp[] = MONTH_WORDS.map(
  (word) => new RegExp(`^(?:${word})$`, 'u'),
);
/** Слово месяца с границами по буквам. */
const MONTH_TOKEN = `(?<!\\p{L})(${MONTH_ANY})(?!\\p{L})\\.?`;

type Builder = (m: RegExpMatchArray) => PriceFileDate | null;

interface DatePattern {
  regex: RegExp;
  build: Builder;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function makeDate(year: number, month: number, day: number | null): PriceFileDate | null {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > MONTHS_IN_YEAR) return null;
  if (day !== null && (day < 1 || day > Math.min(MAX_DAY_IN_MONTH, daysInMonth(year, month)))) {
    return null;
  }
  return { year, month, day };
}

/** Проверенная дата: год в окне 2000-2099, месяц и день существуют; иначе null. */
export function validPriceFileDate(
  year: number,
  month: number,
  day: number | null,
): PriceFileDate | null {
  return makeDate(year, month, day);
}

function monthFromWord(word: string): number | null {
  const index = MONTH_MATCHERS.findIndex((matcher) => matcher.test(word));
  return index === -1 ? null : index + 1;
}

function num(value: string | undefined): number {
  return Number(value ?? Number.NaN);
}

/**
 * Исправление опечатки года с лишней цифрой: пять цифр `20abc`, где две соседние цифры
 * одинаковы (`20225`), - одна из них лишняя (-> `2025`). Нет повтора - год не угадывается
 * (NaN), чтобы случайное число даты не дало.
 */
export function fixTypoYear(digits: string): number {
  if (digits.length !== TYPO_YEAR_LENGTH) return Number.NaN;
  for (let at = 1; at < digits.length; at += 1) {
    if (digits[at] === digits[at - 1]) return num(digits.slice(0, at) + digits.slice(at + 1));
  }
  return Number.NaN;
}

/** Номер месяца по слову (русское или английское название, в том числе сокращённое). */
export function monthOfWord(word: string): number | null {
  return monthFromWord(word.toLowerCase());
}

/** Слитная запись из 8 цифр: гггг-мм-дд (год 20xx) либо дд-мм-гггг. */
const buildSolid: Builder = (m) => {
  const digits = m[1] ?? '';
  const asIso = makeDate(
    num(digits.slice(0, KEY_YEAR_WIDTH)),
    num(digits.slice(SOLID_MONTH_OFFSET, SOLID_DAY_OFFSET)),
    num(digits.slice(SOLID_DAY_OFFSET)),
  );
  if (asIso !== null) return asIso;
  return makeDate(
    num(digits.slice(SOLID_MONTH_OFFSET)),
    num(digits.slice(SOLID_DAY_MONTH_WIDTH, SOLID_MONTH_OFFSET)),
    num(digits.slice(0, SOLID_DAY_MONTH_WIDTH)),
  );
};

/**
 * Шаблоны в порядке приоритета: найденная дата маскируется, чтобы её часть (например,
 * «10.2026» внутри «15.10.2026») не прочиталась второй раз как «только месяц».
 */
const PATTERNS: readonly DatePattern[] = [
  {
    regex: new RegExp(`(?<!\\d)(\\d{${SOLID_DATE_LENGTH}})(?!\\d)`, 'gu'),
    build: buildSolid,
  },
  {
    regex: new RegExp(`(?<!\\d)(20\\d{2})(${SEP})(\\d{1,2})\\2(\\d{1,2})(?!\\d)`, 'gu'),
    build: (m) => makeDate(num(m[1]), num(m[3]), num(m[4])),
  },
  {
    regex: new RegExp(
      `${NO_VERSION_BEFORE}(?<!\\d)(\\d{1,2})(${SEP})(\\d{1,2})\\2(20\\d{2})(?!\\d)`,
      'gu',
    ),
    build: (m) => makeDate(num(m[4]), num(m[3]), num(m[1])),
  },
  {
    // Опечатка года: лишняя цифра («06.08.20225» -> 2025), только дд.мм.ггггг.
    regex: new RegExp(
      `${NO_VERSION_BEFORE}(?<!\\d)(\\d{1,2})(${SEP})(\\d{1,2})\\2(20\\d{3})(?!\\d)`,
      'gu',
    ),
    build: (m) => makeDate(fixTypoYear(m[4] ?? ''), num(m[3]), num(m[1])),
  },
  {
    // Двухзначный год: только дд.мм.гг с нулями, иначе версии вида «1.2.10» дают дату.
    regex: new RegExp(`(?<![\\dv])(\\d{2})(${SEP})(\\d{2})\\2(\\d{2})(?!\\d)`, 'gu'),
    build: (m) => makeDate(TWO_DIGIT_YEAR_BASE + num(m[4]), num(m[3]), num(m[1])),
  },
  {
    regex: new RegExp(
      `(?<!\\d)(\\d{1,2})[\\s._\\-]*${MONTH_TOKEN}[\\s._,\\-]*(20\\d{2})(?!\\d)`,
      'giu',
    ),
    build: (m) => makeDate(num(m[3]), monthFromWord(m[2] ?? '') ?? 0, num(m[1])),
  },
  {
    regex: new RegExp(`${MONTH_TOKEN}[\\s._,\\-]*(20\\d{2})(?!\\d)`, 'giu'),
    build: (m) => makeDate(num(m[2]), monthFromWord(m[1] ?? '') ?? 0, null),
  },
  {
    // Год перед словом месяца: «2026 июнь».
    regex: new RegExp(`(?<!\\d)(20\\d{2})[\\s._,\\-]*${MONTH_TOKEN}`, 'giu'),
    build: (m) => makeDate(num(m[1]), monthFromWord(m[2] ?? '') ?? 0, null),
  },
  {
    regex: new RegExp(`${NO_DIGIT_BEFORE}(20\\d{2})(${SEP})(\\d{1,2})(?!\\d)`, 'gu'),
    build: (m) => makeDate(num(m[1]), num(m[3]), null),
  },
  {
    regex: new RegExp(
      `${NO_VERSION_BEFORE}${NO_DIGIT_BEFORE}(\\d{1,2})(${SEP})(20\\d{2})(?!\\d)`,
      'gu',
    ),
    build: (m) => makeDate(num(m[3]), num(m[1]), null),
  },
];

/**
 * Срок действия, а не дата выпуска: «актуально до 30.07.26», «действителен по 01.10.2026».
 * Такая дата в расчёт не идёт (выпуск прайса она не определяет) - файл попадёт в «без даты»
 * и будет проверен вручную.
 */
const VALIDITY_DEADLINE = new RegExp(
  '(?<!\\p{L})(?:актуал\\p{L}*|действ\\p{L}*|годен|valid)[\\s:_-]*(?:до|по|until|till)\\s*' +
    // Сначала запись со словом месяца: иначе числовая ветка съест только день.
    `(?:\\d{1,2}[\\s._-]*${MONTH_TOKEN}[\\s._,-]*(?:20\\d{2})?|\\d{1,2}(?:[._\\-/]\\d{1,2}){0,2})`,
  'giu',
);

/**
 * Запись без года: две пары цифр через разделитель (`28.10`, `01_07`, `01-25`). Только с
 * нулями и без соседних цифр или разделителей с цифрой (иначе версии `1.2.10`, `v2.10`,
 * размеры и числа `(9)` давали бы дату).
 */
const YEARLESS = new RegExp(
  `(?<![\\dvV])(?<!\\d${SEP})(\\d{2})(${SEP})(\\d{2})(?!\\d)(?!${SEP}\\d)`,
  'gu',
);

/** Базовое имя без каталогов и расширения (расширение - с буквой, до 5 символов). */
function baseName(fileName: string): string {
  const segments = fileName.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,5}$/iu, '').toLowerCase();
}

/** Последний день: для «только месяц» - последний день месяца (консервативно). */
function effectiveDay(date: PriceFileDate): number {
  return date.day ?? daysInMonth(date.year, date.month);
}

function dateKey(year: number, month: number, day: number): string {
  const mm = String(month).padStart(KEY_PART_WIDTH, '0');
  const dd = String(day).padStart(KEY_PART_WIDTH, '0');
  return `${String(year).padStart(KEY_YEAR_WIDTH, '0')}-${mm}-${dd}`;
}

function sortKey(date: PriceFileDate): string {
  return dateKey(date.year, date.month, effectiveDay(date));
}

/**
 * Полные даты названия: самая поздняя из найденных и текст, где найденное замаскировано
 * (остаток для записей без года).
 */
function scanFullDates(fileName: string): {
  text: string;
  best: PriceFileDate | null;
} {
  let text = baseName(fileName).replace(VALIDITY_DEADLINE, (found) =>
    MASK_CHAR.repeat(found.length),
  );
  let best: PriceFileDate | null = null;
  for (const { regex, build } of PATTERNS) {
    let masked = '';
    let cursor = 0;
    for (const match of text.matchAll(regex)) {
      const found = build(match);
      if (found === null) continue;
      const start = match.index ?? 0;
      masked += text.slice(cursor, start) + MASK_CHAR.repeat(match[0].length);
      cursor = start + match[0].length;
      if (best === null || sortKey(found) > sortKey(best)) best = found;
    }
    text = masked + text.slice(cursor);
  }
  return { text, best };
}

/**
 * Имя файла без расширения, где полные даты заменены знаком-заглушкой, и самая поздняя дата.
 * Нужно «потоку прайса» (`price-file-stream`): версии одного прайса отличаются только датой.
 */
export function maskFullPriceFileDates(fileName: string): {
  text: string;
  date: PriceFileDate | null;
} {
  const { text, best } = scanFullDates(fileName);
  return { text: text.replaceAll(MASK_CHAR, ' '), date: best };
}

/**
 * Разбор даты из названия файла прайса (актуальность считается по названию, не по mtime).
 *
 * Учитывается только базовое имя: последний сегмент пути без расширения. Понимает записи
 * `01.10.2026`, `1-10-2026`, `2026_10_01`, `20261001`, `прайс_01102026`, `01.10.26`,
 * `октябрь 2026`, `окт.2026`, `10.2026`, `2026-10`, `от 1 октября 2026 г.`, `Oct 2026`.
 * Двухзначный год 26 -> 2026 (окно 2000-2099). Несуществующие даты и годы вне окна
 * отбрасываются, поэтому артикулы, версии и телефоны даты не дают.
 *
 * Числовая дата (`дд.мм.гггг`, `мм.гггг`), перед которой сразу стоит `v`/`V`, считается
 * версией и даты не даёт (`price_v2.10.2026`).
 *
 * Если дат несколько (период, «с ... по ...»), возвращается самая поздняя. Известное
 * ограничение: победа самой поздней даты означает, что лишняя дата «из будущего» в названии
 * (опечатка, номер, артикул) скрывает устаревание прайса. Без текущего момента такую дату
 * отличить нельзя, поэтому функция её не отбрасывает. Для записи без
 * дня (`day: null`) при сравнении берётся последний день месяца: прайс не считается
 * устаревшим раньше времени.
 *
 * Дополнительные форматы: опечатка года с лишней цифрой (`06.08.20225` -> 2025), год перед
 * словом месяца (`2026 июнь`), суффикс `г.`/`г..` после года. Срок действия («актуально до
 * 30.07.26») датой выпуска не считается.
 *
 * Записи без года, когда полной даты нет:
 * - `28.10`, `01_07` - ближайшая дата `дд.мм`, не позже ОПОРНОЙ даты файла `yearAnchor`
 *   (день опорного момента берётся в поясе `timeZone`; дата того же года, которая позже
 *   опорной, - предыдущего года). Опорную дату выбирает вызывающий код по признакам самого
 *   файла (год в пути, дата сохранения в свойствах документа, время изменения файла - см.
 *   `resolveYearAnchor`), а не по сегодняшнему дню: `Прайс 31.12.xlsx`, сохранённый 10.01.2024,
 *   читается как 31.12.2023. Без `yearAnchor` такие записи даты не дают (файл идёт в «без
 *   даты»);
 * - `01-25` - месяц (год в записи есть); берётся, если он не в будущем относительно `now`.
 *   Без `now` такие записи даты не дают.
 *
 * @param fileName Имя файла или путь.
 * @param now Текущий момент: граница «не в будущем» для записи `мм-гг`.
 * @param timeZone IANA-пояс бизнеса.
 * @param yearAnchor Опорная дата файла для записи `дд.мм` без года; не задана - не разбирается.
 * @returns Дата с точностью либо null, если дату определить нельзя.
 */
export function parsePriceFileDate(
  fileName: string,
  now?: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
  yearAnchor?: Date,
): PriceFileDate | null {
  const { text, best } = scanFullDates(fileName);
  if (best !== null) return best;
  return parseYearless(
    text,
    now === undefined ? null : localDateKey(now, timeZone),
    yearAnchor === undefined ? null : localDateKey(yearAnchor, timeZone),
  );
}

/**
 * Дата без года - запасной разбор, когда полной даты в названии нет. `дд.мм` -> ближайшая дата,
 * не позже опорной (`anchorKey`; нет опорной даты - запись не разбирается). `мм-гг` (второе
 * число не месяц) -> месяц того года, если он не в будущем (`todayKey`; нет - не разбирается).
 * Из нескольких находок - самая поздняя.
 */
function parseYearless(
  text: string,
  todayKey: string | null,
  anchorKey: string | null,
): PriceFileDate | null {
  let best: PriceFileDate | null = null;
  for (const match of text.matchAll(YEARLESS)) {
    const first = num(match[1]);
    const second = num(match[3]);
    const found =
      (anchorKey === null ? null : nearestPastDate(first, second, anchorKey)) ??
      (todayKey === null ? null : monthOfShortYear(first, second, todayKey));
    if (found !== null && (best === null || sortKey(found) > sortKey(best))) best = found;
  }
  return best;
}

/**
 * В названии нет полной даты, но есть запись `дд.мм` без года (`28.10`, `31_12`): для неё нужна
 * опорная дата файла (`resolveYearAnchor`). Запись `мм-гг` (`01-25`) сюда не относится - год
 * в ней записан.
 */
export function hasYearlessDayMonth(fileName: string): boolean {
  const { text, best } = scanFullDates(fileName);
  if (best !== null) return false;
  for (const match of text.matchAll(YEARLESS)) {
    if (makeDate(LEAP_YEAR, num(match[3]), num(match[1])) !== null) return true;
  }
  return false;
}

/** День и месяц без года -> ближайшая дата, не позже опорной (`anchorKey`, `гггг-мм-дд`). */
function nearestPastDate(day: number, month: number, anchorKey: string): PriceFileDate | null {
  const anchorYear = num(anchorKey.slice(0, KEY_YEAR_WIDTH));
  for (let back = 0; back <= YEARLESS_LOOKBACK_YEARS; back += 1) {
    const candidate = makeDate(anchorYear - back, month, day);
    if (candidate !== null && sortKey(candidate) <= anchorKey) return candidate;
  }
  return null;
}

/**
 * Ближайшая дата для дня и месяца без года (правило записи `28.10`): в году опорной даты, а
 * если она позже опорной, то в предыдущем. Нет такой даты за {@link YEARLESS_LOOKBACK_YEARS}
 * лет - null.
 *
 * @param day День.
 * @param month Месяц.
 * @param anchor Опорный момент файла (не текущий день, см. `resolveYearAnchor`).
 * @param timeZone IANA-пояс бизнеса.
 */
export function nearestPastPriceFileDate(
  day: number,
  month: number,
  anchor: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): PriceFileDate | null {
  return nearestPastDate(day, month, localDateKey(anchor, timeZone));
}

/** `мм-гг` (год 20-й и позже, месяц не в будущем) -> только месяц. */
function monthOfShortYear(
  month: number,
  shortYear: number,
  todayKey: string,
): PriceFileDate | null {
  if (shortYear < TWO_DIGIT_YEAR_MIN) return null;
  const candidate = makeDate(TWO_DIGIT_YEAR_BASE + shortYear, month, null);
  if (candidate === null || candidate.year > num(todayKey.slice(0, KEY_YEAR_WIDTH))) return null;
  const firstDay = dateKey(candidate.year, candidate.month, 1);
  return firstDay <= todayKey ? candidate : null;
}

/** Сдвиг даты на месяцы вперёд; день усекается до длины месяца (31 мая + 3 = 31 авг.). */
function addMonthsClamped(year: number, month: number, day: number, months: number): string {
  const total = year * MONTHS_IN_YEAR + (month - 1) + months;
  const targetYear = Math.floor(total / MONTHS_IN_YEAR);
  const targetMonth = (total % MONTHS_IN_YEAR) + 1;
  return dateKey(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/**
 * Прайс устарел, если с его даты прошло больше {@link PRICE_FILE_STALE_MONTHS} календарных
 * месяцев: дата + 3 месяца < сегодня (локальная дата в поясе бизнеса). Ровно 3 месяца - ещё
 * не устарел; дата в будущем - не устарел. Для даты без дня берётся последний день месяца.
 * Конец месяца усекается: 30 ноября + 3 месяца = 28 (29) февраля.
 *
 * @param date Дата из названия файла.
 * @param now Текущий момент.
 * @param timeZone IANA-пояс бизнеса.
 */
export function isPriceDateStale(
  date: PriceFileDate,
  now: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): boolean {
  const deadline = addMonthsClamped(
    date.year,
    date.month,
    effectiveDay(date),
    PRICE_FILE_STALE_MONTHS,
  );
  return localDateKey(now, timeZone) > deadline;
}

/**
 * Прайс в базе устарел по той же календарной шкале, что и файл на диске: дата прайса
 * (момент ISO, локальная дата в поясе бизнеса) + {@link PRICE_FILE_STALE_MONTHS} месяцев <
 * сегодня. Единый источник порога для файлов и базы. Момент, который не разбирается, считается
 * устаревшим.
 *
 * @param timestamp Момент последней загрузки прайса в базу (ISO).
 * @param now Текущий момент.
 * @param timeZone IANA-пояс бизнеса.
 */
export function isPriceTimestampStale(
  timestamp: string,
  now: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): boolean {
  const moment = new Date(timestamp);
  if (Number.isNaN(moment.getTime())) return true;
  const key = localDateKey(moment, timeZone);
  const [year, month, day] = key.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return true;
  return isPriceDateStale({ year, month, day }, now, timeZone);
}
