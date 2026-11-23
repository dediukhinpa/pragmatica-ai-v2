// Эталон: деньги до R9-A1-01 (без быстрых путей), нужен только тестам эквивалентности.

/** Знаков после запятой в копейках (рубли -> копейки). */
const MONEY_DECIMALS = 2;
/** Знаков в цене за единицу: с запасом для мелких цен (колонка цены - `numeric` без предела). */
const PRICE_DECIMALS = 6;
/** Значащих цифр, до которых срезается хвост двоичной дроби перед округлением. */
const SIGNIFICANT_DIGITS = 15;
const DECIMAL_BASE = 10;
/** Знаков доли порога скачка (0.5 -> 5000 из 10000). */
const RATIO_DECIMALS = 4;

/** Сумма в младших единицах: округление «от нуля» по десятичной записи (1.005 -> 101). */
export function toMinorUnits(amount: number, decimals: number = MONEY_DECIMALS): number {
  const scaled = Math.abs(amount) * DECIMAL_BASE ** decimals;
  const rounded = Math.round(Number(scaled.toPrecision(SIGNIFICANT_DIGITS)));
  return amount < 0 ? -rounded : rounded;
}

/** Целые младшие единицы -> число (рубли). */
export function fromMinorUnits(minor: number, decimals: number = MONEY_DECIMALS): number {
  return minor / DECIMAL_BASE ** decimals;
}

/** Отклонение цены строго больше порога (доля, 0.5 = 50%), в целых через BigInt. */
export function deviationExceeds(oldPrice: number, newPrice: number, threshold: number): boolean {
  const oldMinor = toMinorUnits(oldPrice, PRICE_DECIMALS);
  const newMinor = toMinorUnits(newPrice, PRICE_DECIMALS);
  const limit = toMinorUnits(threshold, RATIO_DECIMALS);
  // BigInt: произведение целых больше 2^53, в обычных числах потеряло бы точность.
  const diff = BigInt(Math.abs(newMinor - oldMinor)) * BigInt(DECIMAL_BASE ** RATIO_DECIMALS);
  return diff > BigInt(limit) * BigInt(oldMinor);
}
