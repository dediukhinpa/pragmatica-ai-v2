/** Результат разбора числа из текста: значение, неоднозначность или не число. */
export type NumberTextResult =
  | { kind: 'ok'; value: number }
  | { kind: 'ambiguous' }
  | { kind: 'invalid' };

/** Размер группы разрядов («1 234», «1.234.567»). */
const GROUP_SIZE = 3;
/**
 * Разделитель групп: пробел, неразрывный (U+00A0), цифровой (U+2007, его ставят форматы чисел
 * с выравниванием разрядов, R9-A1-09), тонкий (U+2009) и узкий (U+202F). Тот же набор, что
 * `SPACE_CHARS` в Python (`currency.py`).
 */
const GROUP_SPACE_CLASS = '[ \\u00a0\\u2007\\u2009\\u202f]';
const SINGLE_SPACE = /\s/;
const WHITESPACE = /\s/g;
/**
 * Число с пробелами: 1-3 цифры, затем группы ровно по 3 цифры через один пробел, затем
 * необязательная дробная часть. То же правило, что в Python (`currency.py`, `_clean_number`).
 * «100 120» по этому правилу - число 100120 (неоднозначно: может быть и «опт розница»;
 * решение владельца - принять, как Python).
 */
const SPACE_GROUPED = new RegExp(
  `^-?[1-9]\\d{0,2}(?:${GROUP_SPACE_CLASS}\\d{3})+(?:[.,]\\d+)?$`,
);
const SEPARATORS = /[.,]/g;

/** Все части (после разделителей) кроме первой имеют ровно GROUP_SIZE цифр. */
function isGrouped(parts: readonly string[]): boolean {
  const [head, ...rest] = parts;
  if (head === undefined || !/^-?\d{1,3}$/.test(head) || /^-?0/.test(head)) return false;
  return rest.every((part) => /^\d+$/.test(part) && part.length === GROUP_SIZE);
}

/**
 * Единый разбор числа из текста (прайс, карточка сайта). Принимает «15,5», «15.5»,
 * «1 234,50», «1.234,50», «1,234.50», «1.234.567». Пробел допустим только между группами по
 * три цифры («12 500»); «10 20», «1 23», «12 3456» - не число. Когда одна точка/запятая и после неё
 * ровно три цифры при 1-3 цифрах до неё («1,234»), это может быть и тысячи, и дробь - результат
 * `ambiguous`, угадывать нельзя. Экспонента, буквы и прочее - `invalid`.
 */
export function parseNumberText(raw: string): NumberTextResult {
  const invalid: NumberTextResult = { kind: 'invalid' };
  const trimmed = raw.trim();
  // Пробел внутри - только разделитель групп («1 234 567,89»); «10 20» - два числа.
  if (SINGLE_SPACE.test(trimmed) && !SPACE_GROUPED.test(trimmed)) return invalid;
  const text = trimmed.replace(WHITESPACE, '');
  if (!/^-?\d[\d.,]*\d$|^-?\d$/.test(text)) return invalid;
  const separators: string[] = text.match(SEPARATORS) ?? [];
  if (separators.length === 0) return { kind: 'ok', value: Number(text) };
  const hasDot = separators.includes('.');
  const hasComma = separators.includes(',');
  if (hasDot && hasComma) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const [integer = '', fraction = '', ...extra] = text.split(decimal);
    if (extra.length > 0 || !/^\d+$/.test(fraction)) return invalid;
    const parts = integer.split(group);
    if (integer.includes(decimal) || !isGrouped(parts)) return invalid;
    return { kind: 'ok', value: Number(`${parts.join('')}.${fraction}`) };
  }
  const separator = hasDot ? '.' : ',';
  const parts = text.split(separator);
  if (parts.length > 2) {
    return isGrouped(parts) ? { kind: 'ok', value: Number(parts.join('')) } : invalid;
  }
  const [integer = '', fraction = ''] = parts;
  if (fraction.length === GROUP_SIZE && isGrouped(parts)) return { kind: 'ambiguous' };
  return { kind: 'ok', value: Number(`${integer}.${fraction}`) };
}

