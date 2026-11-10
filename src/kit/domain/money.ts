/**
 * Деньги в целых единицах младшего разряда (копейках). Двоичная дробь не хранит 0.1 и 1.005
 * точно, поэтому суммы, допуски и пороги считаются целыми, а в рубли возвращаются только на
 * границе (R3-ALG-19...22).
 */

/** Знаков после запятой в копейках (рубли -> копейки). */
const MONEY_DECIMALS = 2;
/** Знаков в цене за единицу: с запасом для мелких цен (колонка цены - `numeric` без предела). */
const PRICE_DECIMALS = 6;
/** Допуск при сравнении сумм: одна копейка. */
const MONEY_TOLERANCE_CENTS = 1;
/** Значащих цифр, до которых срезается хвост двоичной дроби перед округлением. */
const SIGNIFICANT_DIGITS = 15;
const DECIMAL_BASE = 10;
/** Знаков доли порога скачка (0.5 -> 5000 из 10000). */
const RATIO_DECIMALS = 4;
/** Масштаб доли порога: 10^RATIO_DECIMALS. */
const RATIO_SCALE = DECIMAL_BASE ** RATIO_DECIMALS;
/**
 * Целое меньше 10^15 `toPrecision(15)` записывает без потерь: округлять нечего, результат
 * медленного пути совпадает с ним самим.
 */
const EXACT_INTEGER_LIMIT = DECIMAL_BASE ** SIGNIFICANT_DIGITS;
/** Середина между соседними целыми: граница округления. */
const HALF = 0.5;
/**
 * Относительный запас до границы округления, при котором срез до 15 значащих цифр не меняет
 * результат. `toPrecision(15)` сдвигает число не больше чем на 5e-15 его величины, обратный
 * разбор - ещё на полшага double (~1.1e-16): запас 1e-13 перекрывает это с избытком.
 */
const ROUNDING_MARGIN = 1e-13;

/** Сумма в младших единицах: округление «от нуля» по десятичной записи (1.005 -> 101). */
export function toMinorUnits(amount: number, decimals: number = MONEY_DECIMALS): number {
  const scaled = Math.abs(amount) * DECIMAL_BASE ** decimals;
  // Быстрый путь (R9-A1-01): `toPrecision` - самая дорогая часть сравнения цен на большом
  // прайсе. Целое до 10^15 он не меняет; дробь, далёкую от середины между целыми, сдвигает
  // слишком мало, чтобы она перешла через середину, - округление то же.
  if (scaled < EXACT_INTEGER_LIMIT) {
    const fraction = scaled - Math.floor(scaled);
    if (fraction === 0 || Math.abs(fraction - HALF) > scaled * ROUNDING_MARGIN) {
      const fast = Math.round(scaled);
      return amount < 0 ? -fast : fast;
    }
  }
  const rounded = Math.round(Number(scaled.toPrecision(SIGNIFICANT_DIGITS)));
  return amount < 0 ? -rounded : rounded;
}

/** Целые младшие единицы -> число (рубли). */
export function fromMinorUnits(minor: number, decimals: number = MONEY_DECIMALS): number {
  return minor / DECIMAL_BASE ** decimals;
}

/** Округление суммы до копеек. */
export function roundMoney(amount: number): number {
  return fromMinorUnits(toMinorUnits(amount));
}

/** Сумма строки (количество × цена за единицу), округлённая до копеек, в копейках. */
export function lineCents(quantity: number, unitPrice: number): number {
  return toMinorUnits(quantity * unitPrice);
}

/** Сумма строк в копейках: каждая строка округляется отдельно, затем складывается. */
export function sumLineCents(
  lines: ReadonlyArray<{ quantity: number; unitPrice: number }>,
): number {
  return lines.reduce((sum, line) => sum + lineCents(line.quantity, line.unitPrice), 0);
}

/** Суммы совпадают с точностью до `MONEY_TOLERANCE_CENTS` (сравнение целых копеек). */
export function sameMoney(a: number, b: number): boolean {
  return Math.abs(toMinorUnits(a) - toMinorUnits(b)) <= MONEY_TOLERANCE_CENTS;
}

/**
 * Отклонение цены строго больше порога (доля, 0.5 = 50%). Цены и порог приводятся к целым
 * (`PRICE_DECIMALS`, `RATIO_DECIMALS`): ровно +50% (0.3 -> 0.45) не скачок из-за двоичной дроби.
 */
export function deviationExceeds(oldPrice: number, newPrice: number, threshold: number): boolean {
  const oldMinor = toMinorUnits(oldPrice, PRICE_DECIMALS);
  const newMinor = toMinorUnits(newPrice, PRICE_DECIMALS);
  const limit = toMinorUnits(threshold, RATIO_DECIMALS);
  const delta = Math.abs(newMinor - oldMinor);
  const diff = delta * RATIO_SCALE;
  const bound = limit * oldMinor;
  // Все слагаемые и произведения - целые до 2^53: в double они точны, сравнение то же, что
  // в BigInt, но без выделения памяти (R9-A1-01: BigInt на каждую позицию большого прайса).
  if (Number.isSafeInteger(delta) && Number.isSafeInteger(diff) && Number.isSafeInteger(bound)) {
    return diff > bound;
  }
  // BigInt: произведение целых больше 2^53, в обычных числах потеряло бы точность.
  return BigInt(delta) * BigInt(RATIO_SCALE) > BigInt(limit) * BigInt(oldMinor);
}
