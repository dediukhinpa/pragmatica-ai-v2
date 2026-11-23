import type { PriceItem } from './models';
import { DAY_MS } from './time';
import { DEFAULT_BUSINESS_TIMEZONE } from './monitoring';
import { isPriceTimestampStale } from './price-file-date';

/** Валюты, которые принимаем в обновлениях от сотрудников (допущение). */
export const KNOWN_PRICE_CURRENCIES: readonly string[] = ['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'BYN'];

/** Дата последнего обновления прайса (самая поздняя дата позиций); null, если цен нет. */
export function lastPriceUpdate(items: readonly PriceItem[]): string | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const item of items) latest = Math.max(latest, Date.parse(item.date));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

/**
 * Свежесть прайса: дата последней загрузки файла, если она известна, иначе самая поздняя
 * дата позиций. Правка позиции словами сотрудника дату загрузки не двигает.
 */
export function priceFreshness(
  lastUpload: string | null,
  items: readonly PriceItem[],
): string | null {
  if (lastUpload !== null && Number.isFinite(Date.parse(lastUpload))) return lastUpload;
  return lastPriceUpdate(items);
}

/** Сколько полных дней прошло с `since` (ISO) до `now`. */
export function daysSince(since: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(since)) / DAY_MS);
}

/**
 * Прайс не обновлялся дольше срока (или цен нет совсем). Срок - тот же, что у файлов на диске:
 * больше `PRICE_FILE_STALE_MONTHS` календарных месяцев от даты (см. `isPriceTimestampStale`).
 */
export function isPriceStale(
  lastUpdate: string | null,
  now: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): boolean {
  return lastUpdate === null || isPriceTimestampStale(lastUpdate, now, timeZone);
}
