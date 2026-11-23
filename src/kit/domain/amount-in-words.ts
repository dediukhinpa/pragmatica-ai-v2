/**
 * Сумма прописью по-русски: целые рубли словами (мужской род, «рубль»), копейки цифрами.
 * Единственный источник прописи для договоров: сотрудник и модель её не вводят.
 */

/** Основание групп разрядов и предел, до которого пропись поддерживается (до триллиона). */
const GROUP_BASE = 1000;
const MAX_WORDS_AMOUNT = 999_999_999_999;
/** Границы «teens»: 11-14 склоняются как «рублей», а не по последней цифре. */
const TEENS_FROM = 11;
const TEENS_TO = 14;
/** Остатки от деления на 10 для форм «рубль» (1) и «рубля» (2-4). */
const ONE = 1;
const FEW_FROM = 2;
const FEW_TO = 4;
const TEN = 10;
const HUNDRED = 100;
const TWENTY = 20;
/** Копеек в рубле и ширина поля копеек («05»). */
const KOPECKS_PER_RUBLE = 100;
const KOPECKS_WIDTH = 2;

/** Род числительного: мужской («один рубль») и женский («одна тысяча»). */
export type Gender = 'm' | 'f';

const UNITS_M: readonly string[] = [
  '', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
];
const UNITS_F: readonly string[] = [
  '', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
];
const TEENS: readonly string[] = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS: readonly string[] = [
  '', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят',
  'восемьдесят', 'девяносто',
];
const HUNDREDS: readonly string[] = [
  '', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот',
  'девятьсот',
];

/** Группа разрядов: слово для (один, несколько 2-4, много) и род числа внутри группы. */
interface Scale {
  forms: readonly [string, string, string];
  gender: Gender;
}
/** Группы от младшей: единицы, тысячи, миллионы, миллиарды. */
const SCALES: readonly Scale[] = [
  { forms: ['', '', ''], gender: 'm' },
  { forms: ['тысяча', 'тысячи', 'тысяч'], gender: 'f' },
  { forms: ['миллион', 'миллиона', 'миллионов'], gender: 'm' },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], gender: 'm' },
];

/** Форма существительного по числу: 1 рубль, 2 рубля, 5 рублей, 11 рублей, 21 рубль. */
function pluralForm(count: number, forms: readonly [string, string, string]): string {
  const lastTwo = count % HUNDRED;
  if (lastTwo >= TEENS_FROM && lastTwo <= TEENS_TO) return forms[2];
  const last = count % TEN;
  if (last === ONE) return forms[0];
  if (last >= FEW_FROM && last <= FEW_TO) return forms[1];
  return forms[2];
}

/** Слова для числа 1..999 в заданном роде. */
function groupWords(value: number, gender: Gender): string[] {
  const words: string[] = [];
  const hundreds = HUNDREDS[Math.trunc(value / HUNDRED)];
  if (hundreds !== undefined && hundreds !== '') words.push(hundreds);
  const rest = value % HUNDRED;
  if (rest >= TEN && rest < TWENTY) {
    words.push(TEENS[rest - TEN] ?? '');
  } else {
    const tens = TENS[Math.trunc(rest / TEN)];
    if (tens !== undefined && tens !== '') words.push(tens);
    const units = (gender === 'f' ? UNITS_F : UNITS_M)[rest % TEN];
    if (units !== undefined && units !== '') words.push(units);
  }
  return words;
}

/**
 * Целое число прописью («сто двадцать одна тысяча пятьсот» для 121 500). Род младшей группы
 * задаёт `gender`: мужской для рублей, женский для «тысяч» в шаблоне. Ноль - «ноль». Не целое,
 * отрицательное или больше предела - `undefined`.
 */
export function integerInWords(value: number, gender: Gender = 'm'): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > MAX_WORDS_AMOUNT) return undefined;
  if (value === 0) return 'ноль';
  const words: string[] = [];
  let rest = value;
  const parts: string[][] = [];
  for (const scale of SCALES) {
    const group = rest % GROUP_BASE;
    rest = Math.trunc(rest / GROUP_BASE);
    if (group === 0) continue;
    const part = groupWords(group, scale.forms[0] === '' ? gender : scale.gender);
    const name = pluralForm(group, scale.forms);
    if (name !== '') part.push(name);
    parts.unshift(part);
  }
  for (const part of parts) words.push(...part);
  return words.join(' ');
}

/** Рубли прописью с валютой: «двадцать один рубль», «две тысячи рублей». */
export function rublesInWords(rubles: number): string | undefined {
  const words = integerInWords(rubles);
  if (words === undefined) return undefined;
  return `${words} ${pluralForm(rubles, ['рубль', 'рубля', 'рублей'])}`;
}

/** Копейки двумя цифрами: 5 → «05». */
export function kopecksDigits(kopecks: number): string {
  return String(kopecks).padStart(KOPECKS_WIDTH, '0');
}

/**
 * Сумма целиком: рубли прописью, копейки цифрами («сто двадцать тысяч рублей 05 копеек»).
 * Принимает сумму в копейках (целое неотрицательное), иначе `undefined`.
 */
export function amountInWords(totalKopecks: number): string | undefined {
  if (!Number.isInteger(totalKopecks) || totalKopecks < 0) return undefined;
  const rubles = rublesInWords(Math.trunc(totalKopecks / KOPECKS_PER_RUBLE));
  if (rubles === undefined) return undefined;
  return `${rubles} ${kopecksDigits(totalKopecks % KOPECKS_PER_RUBLE)} копеек`;
}
