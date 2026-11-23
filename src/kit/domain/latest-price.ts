import { normalizeProductName } from './price-diff';
import { priceSourceRank } from './product-search';

/**
 * Свежая цена позиции (этап 161). Раньше из истории прайсов поставщика брался минимум по цене,
 * и старая дешёвая строка вытесняла актуальную. Теперь по каждой позиции каждого поставщика
 * берётся строка самого свежего прайса, а цена, лестница тиражей, диапазон и НДС остаются из
 * этой же строки. Здесь только чистые функции.
 */

/** Через сколько месяцев цена считается устаревшей: «прайс старше года». */
export const STALE_PRICE_MONTHS = 12;

/** Пометка устаревшей цены в строке шорт-листа. */
export const STALE_PRICE_NOTE = 'прайс старше года';

const DATE_PART_PAD = 2;

/** Минимум полей строки прайса, нужных для выбора свежей. */
export interface DatedPriceRow {
  supplierId: string;
  productName: string;
  sku?: string | undefined;
  currency: string;
  /** Дата прайса (`price_date`), ISO. */
  date: string;
  /** Момент записи строки (`created_at`), ISO; решает спор строк с одной датой прайса. */
  createdAt?: string | undefined;
  /** Файл прайса: по нему отличается диск от почты (приоритет этапа 150). */
  sourceFile?: string | undefined;
}

/** Метка времени строки; нечитаемая дата считается самой старой. */
function stamp(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Ключ позиции поставщика: одна позиция в одной валюте, с учётом артикула. */
export function priceLineKey(row: DatedPriceRow): string {
  const name = normalizeProductName(row.productName);
  return [row.supplierId, row.currency, name, (row.sku ?? '').trim().toLowerCase()].join('\u0000');
}

/**
 * Строка `candidate` строго свежее `current`: по дате прайса; при равной дате цена с диска
 * остаётся выше почтовой (этап 150), затем более поздняя запись (`created_at`).
 */
export function isFresherPrice(candidate: DatedPriceRow, current: DatedPriceRow): boolean {
  const byDate = stamp(candidate.date) - stamp(current.date);
  if (byDate !== 0 && !Number.isNaN(byDate)) return byDate > 0;
  const byOrigin = priceSourceRank(candidate.sourceFile) - priceSourceRank(current.sourceFile);
  if (byOrigin !== 0) return byOrigin < 0;
  return stamp(candidate.createdAt) > stamp(current.createdAt);
}

/**
 * Оставить по каждой позиции каждого поставщика одну строку - самую свежую. Порядок результата
 * - порядок первых вхождений позиций; при полном равенстве остаётся строка, стоящая раньше во
 * входе (выдача уже упорядочена: диск выше почты, затем цена).
 */
export function latestPerLine<T>(rows: readonly T[], rowOf: (value: T) => DatedPriceRow): T[] {
  const latest = new Map<string, T>();
  for (const value of rows) {
    const key = priceLineKey(rowOf(value));
    const current = latest.get(key);
    if (current === undefined || isFresherPrice(rowOf(value), rowOf(current))) {
      latest.set(key, value);
    }
  }
  return [...latest.values()];
}

/** Дата прайса для показа: ДД.ММ.ГГГГ (по UTC, как хранится в базе); нечитаемая - пусто. */
export function formatPriceDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(DATE_PART_PAD, '0');
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

/** Цена старше порога `STALE_PRICE_MONTHS` месяцев на момент `now`. */
export function isStalePrice(iso: string, now: Date): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const limit = new Date(now.getTime());
  limit.setUTCMonth(limit.getUTCMonth() - STALE_PRICE_MONTHS);
  return date.getTime() < limit.getTime();
}

/** Пометка для строки шорт-листа: «прайс от 31.03.2025» и, если устарела, «прайс старше года». */
export function priceDateNotes(iso: string | undefined, stale: boolean): string[] {
  const text = iso === undefined ? '' : formatPriceDate(iso);
  const notes = text === '' ? [] : [`прайс от ${text}`];
  return stale && text !== '' ? [...notes, STALE_PRICE_NOTE] : notes;
}
