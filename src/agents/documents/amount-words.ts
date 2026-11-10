/** Основание системы счисления для групп «тысяча/миллион/миллиард». */
const THOUSAND = 1000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/** Числительные до 999: единицы, десятки, сотни (в любом роде, без «ё»). */
const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  ноль: 0, один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
  семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
  тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200,
  триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800,
  девятьсот: 900,
};

/** Слова-множители по основе («тысяч» - тысяча, тысячи, тысяч). */
const MULTIPLIER_STEMS: ReadonlyArray<readonly [string, number]> = [
  ['тысяч', THOUSAND],
  ['миллион', MILLION],
  ['миллиард', BILLION],
];

/** Слова валюты: к числу не относятся и пропускаются. */
const CURRENCY_WORDS: ReadonlySet<string> = new Set(['рубль', 'рубля', 'рублей', 'руб']);

/**
 * Целое число рублей из суммы прописью («сто двадцать тысяч» → 120000). Слова валюты
 * пропускаются; незнакомое слово или пустая строка - `undefined` (сумму не удалось разобрать).
 */
export function parseAmountWords(text: string): number | undefined {
  const words = text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(/[^\p{L}]+/u)
    .filter((word) => word !== '' && !CURRENCY_WORDS.has(word));
  if (words.length === 0) return undefined;
  let total = 0;
  let group = 0;
  for (const word of words) {
    const small = Object.hasOwn(SMALL_NUMBERS, word) ? SMALL_NUMBERS[word] : undefined;
    const multiplier = MULTIPLIER_STEMS.find(([stem]) => word.startsWith(stem))?.[1];
    if (small !== undefined) {
      group += small;
    } else if (multiplier !== undefined) {
      // «тысяча» без числа перед ней - одна тысяча.
      total += (group === 0 ? 1 : group) * multiplier;
      group = 0;
    } else {
      return undefined;
    }
  }
  return total + group;
}
