import { addDays } from '@business-ai/core';
import { isCalendarWorkingDay } from '@business-ai/core';

/** Предел счёта: срок дальше двух лет - явно не срок поставки, а ошибка в дате. */
const MAX_TERM_CALENDAR_DAYS = 730;
/**
 * Рабочих дней от `fromKey` (не включая, это день заключения договора) до `toKey`
 * (включительно): «до 05.11.2026» от 28.10.2026 = 5. undefined - дата не позже начала,
 * слишком далеко или часть дней вне календаря.
 */
export function workingDaysUntil(fromKey: string, toKey: string): number | undefined {
  let count = 0;
  let day = fromKey;
  for (let step = 0; step < MAX_TERM_CALENDAR_DAYS; step += 1) {
    day = addDays(day, 1);
    if (day > toKey) return count > 0 ? count : undefined;
    const working = isCalendarWorkingDay(day);
    if (working === undefined) return undefined;
    if (working) count += 1;
  }
  return undefined;
}
