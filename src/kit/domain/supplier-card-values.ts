import type { PackagingKind } from './supplier-card-full';

/**
 * Разбор значений карточки поставщика, которые раньше хранились текстом: упаковка, НДС, оборот,
 * размер скидки, ОКВЭД (разд. 10.3, 10.6, 10.9 ТЗ). Разбор строгий: неоднозначное или
 * неизвестное значение не угадывается, а возвращается как «не распознано» - вызывающий код
 * сообщает об ошибке строки файла или переносит исходный текст в заметку карточки.
 * Те же правила (регулярные выражения и пределы) повторены в SQL миграции 025; соответствие
 * проверяет общая таблица случаев в тестах домена и миграции.
 */

/** Режим налогообложения по НДС: плательщик (ставка в процентах) или без НДС (УСН и др.). */
export const VAT_MODES = ['with_vat', 'no_vat'] as const;
export type VatMode = (typeof VAT_MODES)[number];
export const VAT_MODE_LABELS: Readonly<Record<VatMode, string>> = {
  with_vat: 'с НДС',
  no_vat: 'без НДС',
};

/** Границы процента (ставка НДС, размер скидки) и число знаков после запятой. */
export const MIN_PERCENT = 0;
export const MAX_PERCENT = 100;
const PERCENT_DECIMALS = 2;
const MONEY_DECIMALS = 2;
/**
 * Предел оборота, руб. (10 трлн): сумма в копейках остаётся точным целым числом, столбец
 * `numeric(16,2)` вмещает её с запасом.
 */
export const MAX_TURNOVER_RUB = 10_000_000_000_000;

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;
const DECIMAL_BASE = 10;

/** Результат разбора числа: значение либо признак «не распознано». */
export type ParsedNumber = { ok: true; value: number } | { ok: false };

/** Результат разбора НДС: режим и (если назван) ставка. */
export type ParsedVat =
  | { ok: true; mode: VatMode; ratePercent?: number }
  | { ok: false };

/** Результат разбора упаковки: одно значение, неоднозначно (несколько) или не распознано. */
export type ParsedPackaging =
  | { status: 'ok'; kind: PackagingKind }
  | { status: 'ambiguous' | 'unknown' };

/** Результат разбора ОКВЭД: код в каноничном виде с точками либо «не распознано». */
export type ParsedOkved = { ok: true; code: string } | { ok: false };

const FAIL = { ok: false } as const;

/** Свёртка текста: пробелы (в том числе неразрывные) в один, регистр и «ё» не важны. */
function foldText(value: string): string {
  return value
    .replace(/[\s  ]+/g, ' ')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е');
}

function roundTo(value: number, decimals: number): number {
  const factor = DECIMAL_BASE ** decimals;
  return Math.round(value * factor) / factor;
}

/** Число из записи с точкой или запятой в качестве десятичного разделителя. */
function decimalOf(text: string): number {
  return Number(text.replace(',', '.'));
}

// ---------------------------------------------------------------------------------------------
// Упаковка (10.6)
// ---------------------------------------------------------------------------------------------

/** Признаки значений упаковки в свободном тексте (основы слов; текст уже свёрнут). */
const PACKAGING_GIFT = /подароч|gift/;
const PACKAGING_TRANSPORT = /транспорт|transport/;
const PACKAGING_NONE =
  /(?:^| )(?:нет|без|отсутствует|отсутствуют|none)(?: |$)|не предусмотрен/;

/**
 * Распознать упаковку по свободному тексту («подарочная упаковка», «без упаковки»). Ровно одно
 * значение - `ok`; два и более разных («транспортная и подарочная») - `ambiguous`; ни одного -
 * `unknown`. Точные коды и подписи перечисления разбирает вызывающий код до этого разбора.
 */
export function parsePackagingKind(text: string): ParsedPackaging {
  const folded = foldText(text);
  const found: PackagingKind[] = [];
  if (PACKAGING_GIFT.test(folded)) found.push('gift');
  if (PACKAGING_TRANSPORT.test(folded)) found.push('transport');
  if (PACKAGING_NONE.test(folded)) found.push('none');
  const [first] = found;
  if (first === undefined) return { status: 'unknown' };
  return found.length === 1 ? { status: 'ok', kind: first } : { status: 'ambiguous' };
}

// ---------------------------------------------------------------------------------------------
// Проценты: НДС и скидка (10.3)
// ---------------------------------------------------------------------------------------------

/** Без НДС: УСН, «не облагается», «нет НДС» (ставки нет). */
const VAT_NONE_PATTERN = new RegExp(
  '^(?:без ндс|(?:ндс )?не облагается(?: ндс)?|усн(?: без ндс)?|упрощенка|' +
    'упрощенная система(?: налогообложения)?|нет ндс|ндс нет|не плательщик ндс)$',
);
/** С НДС, ставка не названа. */
const VAT_ANY_PATTERN = /^(?:с ндс|ндс|включая ндс|ндс включен|в том числе ндс)$/;
/** Ставка: «20», «20%», «НДС 20%», «с НДС 22 %», «ставка 5,5». */
const VAT_RATE_PATTERN =
  /^(?:(?:(?:с |включая )?ндс:? )|ставка )?(\d+(?:[.,]\d+)?) ?%?(?: ндс)?$/;
/** Скидка: «5», «5%», «5,5 %», «скидка 10%», «10% от цены поставщика». */
const DISCOUNT_PATTERN =
  /^(?:скидка )?(\d+(?:[.,]\d+)?) ?%?(?: от цены(?: поставщика)?)?$/;

function percentIn(text: string | undefined): ParsedNumber {
  if (text === undefined) return FAIL;
  const value = decimalOf(text);
  if (!Number.isFinite(value) || value < MIN_PERCENT || value > MAX_PERCENT) return FAIL;
  return { ok: true, value: roundTo(value, PERCENT_DECIMALS) };
}

/**
 * Разобрать НДС поставщика. «20», «НДС 22%», «с НДС 20%» - плательщик со ставкой; «с НДС» -
 * плательщик без названной ставки; «без НДС», «УСН», «не облагается» - режим «без НДС» (это не
 * ставка 0%: нулевая ставка у плательщика - отдельное значение «0»). Иное - не распознано.
 */
export function parseVat(text: string): ParsedVat {
  const folded = foldText(text);
  if (VAT_NONE_PATTERN.test(folded)) return { ok: true, mode: 'no_vat' };
  if (VAT_ANY_PATTERN.test(folded)) return { ok: true, mode: 'with_vat' };
  const rate = percentIn(VAT_RATE_PATTERN.exec(folded)?.[1]);
  return rate.ok ? { ok: true, mode: 'with_vat', ratePercent: rate.value } : FAIL;
}

/** Разобрать размер скидки в процентах (0-100); «до 5%» и диапазоны не распознаются. */
export function parseDiscountPercent(text: string): ParsedNumber {
  return percentIn(DISCOUNT_PATTERN.exec(foldText(text))?.[1]);
}

// ---------------------------------------------------------------------------------------------
// Оборот (10.9)
// ---------------------------------------------------------------------------------------------

/**
 * Сумма: число с пробелами-разделителями тысяч и запятой/точкой десятичной части либо группы
 * через точку («1.000.000»), затем необязательный множитель и необязательное «руб.».
 */
const MONEY_PATTERN = new RegExp(
  '^(\\d+(?: \\d{3})*(?:[.,]\\d+)?|\\d{1,3}(?:\\.\\d{3}){2,}) ?' +
    '(тыс\\.?|тысяч|млн\\.?|миллионов|миллиона|миллион|млрд\\.?|миллиардов|миллиарда|миллиард)?' +
    ' ?(руб(?:\\.|лей|ля|ль)?|р\\.?|₽)?$',
);
/**
 * Голое число без множителя и без «руб.»/«₽» меньше этого порога - не оборот («2023» - год,
 * «120» - штуки): оно не разбирается и уходит в заметку. Тот же порог в миграции 025.
 */
const MIN_BARE_TURNOVER_RUB = 100_000;
const MULTIPLIER_THOUSAND = 'тыс';
const MULTIPLIER_BILLION = ['млрд', 'миллиард'] as const;
const DOT_GROUPS = /^\d{1,3}(?:\.\d{3}){2,}$/;

function multiplierOf(word: string | undefined): number {
  if (word === undefined) return 1;
  if (word.startsWith(MULTIPLIER_THOUSAND)) return THOUSAND;
  return MULTIPLIER_BILLION.some((prefix) => word.startsWith(prefix)) ? BILLION : MILLION;
}

/**
 * Разобрать оборот в рублях: «120 млн», «1,5 млрд», «500 000 000 руб.», «250 тыс.». Год в
 * записи («2024: 150 млн»), несколько сумм, неоднозначное «1.500» без множителя, а также
 * голое число меньше `MIN_BARE_TURNOVER_RUB` без множителя и «руб.»/«₽» («2023», «120») не
 * распознаются. Результат - от 0 до `MAX_TURNOVER_RUB`, с точностью до копейки.
 */
export function parseTurnoverRub(text: string): ParsedNumber {
  const match = MONEY_PATTERN.exec(foldText(text));
  const raw = match?.[1];
  if (raw === undefined) return FAIL;
  const multiplierWord = match?.[2];
  const grouped = DOT_GROUPS.test(raw);
  const digits = grouped ? raw.replaceAll('.', '') : raw.replaceAll(' ', '');
  const fraction = /[.,](\d+)$/.exec(digits)?.[1];
  // «1.500» без множителя - то ли полторы тысячи, то ли 1,5 руб.: не угадываем.
  if (multiplierWord === undefined && fraction !== undefined && fraction.length > MONEY_DECIMALS) {
    return FAIL;
  }
  const value = roundTo(decimalOf(digits) * multiplierOf(multiplierWord), MONEY_DECIMALS);
  const hasRubleMark = match?.[3] !== undefined;
  if (multiplierWord === undefined && !hasRubleMark && value < MIN_BARE_TURNOVER_RUB) return FAIL;
  return Number.isFinite(value) && value <= MAX_TURNOVER_RUB ? { ok: true, value } : FAIL;
}

/** Результат разбора оборота по годам: список «год - сумма» (новые годы первыми). */
export type ParsedTurnoverYears =
  | { ok: true; years: Array<{ year: number; rub: number }> }
  | { ok: false };

const YEAR_PATTERN = '((?:19|20)\\d{2})';
const YEAR_SUFFIX_PATTERN = '(?: ?(?:г\\.?|года?))?';
/** «2024: 150 млн», «2024 г. - 150 млн», «2024 = 150 млн». */
const YEAR_FIRST = new RegExp(`^${YEAR_PATTERN}${YEAR_SUFFIX_PATTERN} ?[:=\\-–—] ?(.+)$`);
/** «150 млн (2024)», «150 млн за 2024 г.». */
const YEAR_LAST = new RegExp(
  `^(.+?) ?(?:\\(${YEAR_PATTERN}${YEAR_SUFFIX_PATTERN}\\)|` +
    `за ${YEAR_PATTERN}${YEAR_SUFFIX_PATTERN})$`,
);
/** Границы между годами: точка с запятой, перевод строки, запятая перед следующим годом. */
const TURNOVER_YEAR_SPLIT = /[;\n]+|,\s*(?=(?:19|20)\d{2}\b)/;

/**
 * Разобрать оборот по годам: «2025: 150 млн; 2024: 120 млн; 2023: 100 млн» (также «150 млн
 * (2025)», «150 млн за 2025 г.»; годы через `;`, перевод строки или запятую). Каждая запись
 * обязана назвать год и сумму, которую разбирает `parseTurnoverRub`; год не повторяется. Сумма
 * без года («150 млн») здесь не распознаётся: это прежний оборот одной суммой. Результат -
 * от нового года к старому. Границы года и число лет проверяет `validateFullParts`.
 */
export function parseTurnoverByYear(text: string): ParsedTurnoverYears {
  // Делится исходный текст: свёртка пробелов превратила бы перевод строки в обычный пробел.
  const parts = text
    .split(TURNOVER_YEAR_SPLIT)
    .map((part) => foldText(part))
    .filter((part) => part !== '');
  if (parts.length === 0) return FAIL;
  const byYear = new Map<number, number>();
  for (const part of parts) {
    const first = YEAR_FIRST.exec(part);
    const last = first === null ? YEAR_LAST.exec(part) : null;
    const yearText = first?.[1] ?? last?.[2] ?? last?.[3];
    const moneyText = first?.[2] ?? last?.[1];
    if (yearText === undefined || moneyText === undefined) return FAIL;
    const money = parseTurnoverRub(moneyText);
    const year = Number(yearText);
    if (!money.ok || byYear.has(year)) return FAIL;
    byYear.set(year, money.value);
  }
  const years = [...byYear.entries()]
    .map(([year, rub]) => ({ year, rub }))
    .sort((a, b) => b.year - a.year);
  return { ok: true, years };
}

// ---------------------------------------------------------------------------------------------
// ОКВЭД 2 (ОК 029-2014)
// ---------------------------------------------------------------------------------------------

/**
 * Каноничный ОКВЭД 2: класс 01-99 и необязательные подгруппы: `NN`, `NN.N`, `NN.NN`, `NN.NN.N`,
 * `NN.NN.NN`. Тот же шаблон стоит в CHECK столбца `suppliers.okved`.
 */
export const OKVED_PATTERN = /^(?:0[1-9]|[1-9][0-9])(?:\.[0-9]|\.[0-9]{2}(?:\.[0-9]{1,2})?)?$/;
/** Начало записи: «ОКВЭД», «ОКВЭД 2», «ОКВЭД-2:», «код» (двойка не отъедает цифру кода). */
const OKVED_PREFIX = /^(?:оквэд(?: ?-? ?2(?![0-9.,]))?|код)?[ :№-]*/;
/** Код из цифр и разделителей, затем (через пробел) необязательное название вида деятельности. */
const OKVED_RUN = /^(\d[\d .,-]*)(.*)$/;
const OKVED_ENDS_WITH_SEPARATOR = /[ .,-]$/;
const OKVED_TRAILING_SEPARATORS = /[ .,-]+$/;
const OKVED_SEPARATORS = /[ .,-]+/;
const OKVED_ONLY_DIGITS = /^\d+$/;
const OKVED_CLASS_LENGTH = 2;
const OKVED_MAX_SUBGROUP_LENGTH = 2;
/** Слитная запись: число цифр -> места, после которых ставится точка. */
const OKVED_COMPACT_DOTS: Readonly<Record<number, readonly number[]>> = {
  2: [],
  3: [2],
  4: [2],
  5: [2, 4],
  6: [2, 4],
};

function compactOkved(digits: string): string | undefined {
  const dots = OKVED_COMPACT_DOTS[digits.length];
  if (dots === undefined) return undefined;
  const parts: string[] = [];
  let from = 0;
  for (const at of dots) {
    parts.push(digits.slice(from, at));
    from = at;
  }
  parts.push(digits.slice(from));
  return parts.join('.');
}

function separatedOkved(code: string): string | undefined {
  const groups = code.split(OKVED_SEPARATORS);
  const [head, ...subgroups] = groups;
  const okSubgroups =
    subgroups.length >= 1 &&
    subgroups.length <= 2 &&
    subgroups.every((part) => part.length >= 1 && part.length <= OKVED_MAX_SUBGROUP_LENGTH);
  return head?.length === OKVED_CLASS_LENGTH && okSubgroups ? groups.join('.') : undefined;
}

/**
 * Привести ОКВЭД к каноничной записи с точками: пробелы, запятая, дефис и слитная запись
 * (`4719`, `47,19`, `47.19.0`), префикс «ОКВЭД»/«ОКВЭД 2», хвост с названием
 * («47.19 Торговля розничная...»). Несколько кодов, класс вне 01-99 и неверные группы - не
 * распознано.
 */
export function normalizeOkved(text: string): ParsedOkved {
  const rest = foldText(text).replace(OKVED_PREFIX, '');
  const match = OKVED_RUN.exec(rest);
  const run = match?.[1];
  const tail = match?.[2] ?? '';
  if (run === undefined) return FAIL;
  // Название вида деятельности должно отделяться от кода пробелом или знаком.
  if (tail !== '' && !OKVED_ENDS_WITH_SEPARATOR.test(run)) return FAIL;
  const code = run.replace(OKVED_TRAILING_SEPARATORS, '');
  const canonical = OKVED_ONLY_DIGITS.test(code) ? compactOkved(code) : separatedOkved(code);
  return canonical !== undefined && OKVED_PATTERN.test(canonical)
    ? { ok: true, code: canonical }
    : FAIL;
}

/** Округление процента до сотых (как столбец `numeric(5,2)`). */
export function roundPercent(value: number): number {
  return roundTo(value, PERCENT_DECIMALS);
}

/** Округление суммы в рублях до копейки. */
export function roundRubles(value: number): number {
  return roundTo(value, MONEY_DECIMALS);
}
