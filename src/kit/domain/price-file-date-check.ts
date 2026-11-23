import { localDateKey } from '@business-ai/core';
import { DEFAULT_BUSINESS_TIMEZONE } from './monitoring';
import {
  fixTypoYear,
  monthOfWord,
  nearestPastPriceFileDate,
  validPriceFileDate,
  type PriceFileDate,
} from './price-file-date';
import { priceFileBaseName } from './price-file-kind';

/** Насколько старой может быть дата из ответа модели: глубже - не доверяем (лет назад). */
const FALLBACK_MAX_AGE_YEARS = 10;

const KEY_YEAR_WIDTH = 4;
const KEY_PART_WIDTH = 2;
/** Слитная запись (`11092025`): день, месяц и год ищутся внутри группы цифр. */
const SOLID_MIN_DIGITS = 6;
const CENTURY = 100;

/** Группы цифр подряд в названии. */
function digitGroups(name: string): string[] {
  return name.match(/\d+/gu) ?? [];
}

/** Месяцы, названные в имени словом («июнь», «окт», «Oct»). */
function monthsNamed(name: string): ReadonlySet<number> {
  const months = new Set<number>();
  for (const word of name.match(/\p{L}+/gu) ?? []) {
    const month = monthOfWord(word);
    if (month !== null) months.add(month);
  }
  return months;
}

/** Раскладки слитной записи даты: позиции дня и месяца в группе цифр заданной длины. */
const SOLID_DAY_OFFSETS: Readonly<Record<number, readonly number[]>> = {
  6: [0], // ddmmyy
  8: [0, 6], // ddmmyyyy, yyyymmdd
};
const SOLID_MONTH_OFFSETS: Readonly<Record<number, readonly number[]>> = {
  6: [2, 0], // ddmmyy, mmyyyy
  8: [2, 4], // ddmmyyyy, yyyymmdd
};

/** Что ищем в слитной записи: день или месяц. */
type DatePart = 'day' | 'month';

/**
 * Число (день или месяц) записано в имени отдельной группой цифр либо в слитной записи.
 * Слитная группа (6+ цифр) считается датой, только если её длина и позиция числа совпадают
 * с настоящей раскладкой целиком; подстрока длинной группы (ИНН, артикул, телефон) не подходит.
 */
function hasNumber(groups: readonly string[], value: number, part: DatePart): boolean {
  const padded = String(value).padStart(KEY_PART_WIDTH, '0');
  const offsets = part === 'day' ? SOLID_DAY_OFFSETS : SOLID_MONTH_OFFSETS;
  return groups.some((group) => {
    if (group === padded || group === String(value)) return true;
    if (group.length < SOLID_MIN_DIGITS) return false;
    return (offsets[group.length] ?? []).some(
      (at) => group.slice(at, at + KEY_PART_WIDTH) === padded,
    );
  });
}

/** Год записан полностью, двумя цифрами отдельной группой либо с опечаткой (`20225`). */
function hasYear(groups: readonly string[], year: number): boolean {
  const short = String(year % CENTURY).padStart(KEY_PART_WIDTH, '0');
  return groups.some(
    (group) => group.includes(String(year)) || group === short || fixTypoYear(group) === year,
  );
}

/**
 * Года в названии нет (`13.10`): он допустим, только если это год, который даёт кодовое правило
 * записи без года от опорной даты файла. Нет опорной даты - год выводить не из чего.
 */
function isYearImplied(
  date: PriceFileDate,
  yearAnchor: Date | undefined,
  timeZone: string,
): boolean {
  if (date.day === null || yearAnchor === undefined) return false;
  return nearestPastPriceFileDate(date.day, date.month, yearAnchor, timeZone)?.year === date.year;
}

/**
 * Строгая проверка даты, которую назвала модель (запасной разбор). Принимается, только если:
 * дата существует, год в окне `[сейчас - FALLBACK_MAX_AGE_YEARS; сейчас]`, дата не в будущем
 * (для «только месяц» - месяц не позже текущего), а каждая её часть - год, месяц, день -
 * действительно записана в названии (цифрами или словом месяца); год без записи допустим
 * только как год, выведенный от опорной даты файла для дня и месяца без года. Иначе модель могла
 * выдумать дату, и она отбрасывается.
 *
 * @param fileName Имя файла или путь.
 * @param candidate Дата из ответа модели.
 * @param now Текущий момент.
 * @param timeZone IANA-пояс бизнеса.
 * @param yearAnchor Опорная дата файла (`resolveYearAnchor`); не задана - год без записи в
 *   названии не принимается.
 * @returns Проверенная дата либо null.
 */
export function verifyFallbackPriceFileDate(
  fileName: string,
  candidate: PriceFileDate,
  now: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
  yearAnchor?: Date,
): PriceFileDate | null {
  const date = validPriceFileDate(candidate.year, candidate.month, candidate.day);
  if (date === null) return null;
  const today = localDateKey(now, timeZone);
  const thisYear = Number(today.slice(0, KEY_YEAR_WIDTH));
  if (date.year > thisYear || date.year < thisYear - FALLBACK_MAX_AGE_YEARS) return null;
  const mm = String(date.month).padStart(KEY_PART_WIDTH, '0');
  const dd = String(date.day ?? 1).padStart(KEY_PART_WIDTH, '0');
  if (`${date.year}-${mm}-${dd}` > today) return null;

  const name = priceFileBaseName(fileName).toLowerCase();
  const groups = digitGroups(name);
  if (!hasYear(groups, date.year) && !isYearImplied(date, yearAnchor, timeZone)) return null;
  if (!hasNumber(groups, date.month, 'month') && !monthsNamed(name).has(date.month)) return null;
  if (date.day !== null && !hasNumber(groups, date.day, 'day')) return null;
  return date;
}
