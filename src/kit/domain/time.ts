/** Миллисекунд в часе. */
export const HOUR_MS = 3_600_000;
/** Миллисекунд в сутках. */
export const DAY_MS = 24 * HOUR_MS;
/** Ожидание ответов поставщиков перед напоминанием, часов (ТЗ: 1 день). */
export const SUPPLIER_REPLY_WAIT_HOURS = 24;

/** Часы в миллисекундах. */
export function hoursToMs(hours: number): number {
  return hours * HOUR_MS;
}
