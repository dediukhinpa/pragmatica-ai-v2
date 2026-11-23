/**
 * Проверка текста срока (этап 170). Срок в карточке поставщика и в ответе модели по сайту -
 * свободный текст, и туда попадают заметки про другой товар («допечатка ожидалась в конце
 * сентября 2025»). Правило общее и структурное, без слов-фильтров по названиям товаров:
 * срок - это длительность («N дней/недель/месяцев», диапазон), формулировка наличия или заказа,
 * либо будущая дата поставки. Дата в прошлом без длительности сроком не считается.
 */

/** Единицы длительности срока: приставка слова (после числа). */
const LEAD_DURATION_UNIT_PREFIXES: readonly string[] = ['час', 'дн', 'ден', 'сут', 'нед', 'мес'];
/** Число и необязательный конец диапазона: «3», «3-5», «15–17». */
const LEAD_DURATION_PATTERN = new RegExp(
  String.raw`\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?\s*` +
    String.raw`(?:(?:рабоч|календарн)\p{L}*\s+)?(\p{L}+)`,
  'giu',
);
/** Формулировки наличия и заказа: срок сказан без числа. */
const LEAD_PHRASE_PATTERN = /(?<!\p{L})(?:в\s+наличии|под\s+заказ|со\s+склада)(?!\p{L})/iu;
/** Дата с годом: «12.10.2026». */
const NUMERIC_DATE_PATTERN = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/gu;
/** Месяц словом и год: «сентября 2025», «в конце сентября 2025». */
const MONTH_YEAR_PATTERN = new RegExp(
  String.raw`(?<!\p{L})(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр` +
    String.raw`|декабр)` +
    String.raw`\p{L}*\s+(\d{4})(?!\d)`,
  'giu',
);
/** Приставка названия месяца -> номер месяца (1-12), в порядке регулярного выражения. */
const MONTH_PREFIXES: readonly string[] = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
];

function hasDuration(text: string): boolean {
  for (const match of text.matchAll(LEAD_DURATION_PATTERN)) {
    const unit = (match[1] ?? '').toLowerCase();
    if (LEAD_DURATION_UNIT_PREFIXES.some((prefix) => unit.startsWith(prefix))) return true;
  }
  return false;
}

/** Последние сутки месяца (UTC): день, до которого дата вида «месяц год» ещё не прошла. */
function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0, 23, 59, 59));
}

/** Все даты текста с годом; месяц без числа берётся по концу месяца. */
function datesIn(text: string): Date[] {
  const dates: Date[] = [];
  for (const match of text.matchAll(NUMERIC_DATE_PATTERN)) {
    const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    dates.push(new Date(Date.UTC(year, month - 1, day, 23, 59, 59)));
  }
  for (const match of text.matchAll(MONTH_YEAR_PATTERN)) {
    const word = (match[1] ?? '').toLowerCase();
    const index = MONTH_PREFIXES.findIndex((prefix) => word.startsWith(prefix));
    if (index >= 0) dates.push(endOfMonth(Number(match[2]), index + 1));
  }
  return dates.filter((date) => !Number.isNaN(date.getTime()));
}

/**
 * Похож ли текст на срок изготовления или поставки на момент `now` (часы приложения).
 * Длительность или «в наличии/под заказ» - да; иначе да только если в тексте есть дата поставки
 * не в прошлом. Дата без года проверке не поддаётся и сроком не считается.
 */
export function looksLikeLeadTime(text: string, now: Date): boolean {
  if (hasDuration(text) || LEAD_PHRASE_PATTERN.test(text)) return true;
  return datesIn(text).some((date) => date.getTime() >= now.getTime());
}

/** Срок для показа и передачи в шорт-лист: не похожий на срок текст - `undefined`. */
export function leadTimeOrUndefined(text: string | undefined, now: Date): string | undefined {
  return text !== undefined && looksLikeLeadTime(text, now) ? text : undefined;
}

/**
 * Дата прайса «не из будущего» относительно часов приложения: дата позже `now` - ошибка
 * разбора файла или имени, и «прайс от ...» по ней не показывается.
 */
export function priceDateNotInFuture(iso: string | undefined, now: Date): string | undefined {
  if (iso === undefined) return undefined;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) || time > now.getTime() ? undefined : iso;
}
