import { z } from 'zod';
import { findPriceJumpsSteps, priceItemKey, type PriceChange } from '../../kit/domain/price-diff';
import { priceItemSchema, type PriceItem } from '../../kit/domain/models';
import { stateEntries } from '@business-ai/core';
import { stableHash, toStoredJson } from '@business-ai/core';
import { CONFIRMED_PRICE_NAMESPACE, type PricesDeps } from './deps';
import { runPriceStepsYielding } from './price-steps';

/** Знаков отпечатка ключа позиции в имени корзины: до 256 записей на поставщика. */
const BUCKET_CHARS = 2;
/** Сколько корзин читаем за запрос и предел запросов (все корзины одного поставщика). */
const BUCKET_PAGE = 100;
const BUCKET_MAX_PAGES = 4;

const bucketSchema = z.object({ items: z.array(priceItemSchema) });

/** Префикс ключей поставщика; id кодируется, чтобы разделитель не встретился внутри него. */
function supplierPrefix(supplierId: string): string {
  return `${encodeURIComponent(supplierId)}:`;
}

function bucketOf(item: PriceItem): string {
  return stableHash(priceItemKey(item)).slice(0, BUCKET_CHARS);
}

/**
 * Последние цены поставщика, подтверждённые человеком. Хранятся в состоянии сценариев (в базе
 * цен истории нет), корзинами по отпечатку ключа позиции: большой прайс не превращается в одну
 * огромную запись. Пишет их только код после фиксации; у модели нет инструмента для записи.
 * Без хранилища состояния список пуст: сверка идёт только с текущей базой.
 */
export async function loadConfirmedPrices(
  deps: PricesDeps,
  supplierId: string,
): Promise<PriceItem[]> {
  if (deps.state === undefined) return [];
  const prefix = supplierPrefix(supplierId);
  const items: PriceItem[] = [];
  // Список упорядочен по ключу: читаем только диапазон поставщика, за его концом - стоп.
  const entries = stateEntries(deps.state, CONFIRMED_PRICE_NAMESPACE, {
    pageSize: BUCKET_PAGE,
    maxPages: BUCKET_MAX_PAGES,
    after: prefix,
    prefix,
  });
  for await (const entry of entries) {
    const parsed = bucketSchema.safeParse(entry.value);
    if (parsed.success) items.push(...parsed.data.items);
  }
  return items;
}

/** Записать подтверждённые цены поставщика: переписываются только изменившиеся корзины. */
export async function saveConfirmedPrices(
  deps: PricesDeps,
  supplierId: string,
  previous: readonly PriceItem[],
  next: readonly PriceItem[],
): Promise<void> {
  if (deps.state === undefined) return;
  // Корзина зависит только от ключа позиции: хэш считается один раз на ключ, а не дважды на
  // позицию (предыдущий и новый набор почти целиком состоят из одних и тех же позиций).
  const bucketByKey = new Map<string, string>();
  const group = (items: readonly PriceItem[]): Map<string, PriceItem[]> => {
    const buckets = new Map<string, PriceItem[]>();
    for (const item of items) {
      const key = priceItemKey(item);
      let bucket = bucketByKey.get(key);
      if (bucket === undefined) {
        bucket = bucketOf(item);
        bucketByKey.set(key, bucket);
      }
      const group = buckets.get(bucket);
      if (group === undefined) buckets.set(bucket, [item]);
      else group.push(item);
    }
    return buckets;
  };
  // Корзины из тех же объектов в том же порядке дают тот же отпечаток: хэш не нужен.
  const sameItems = (a: readonly PriceItem[], b: readonly PriceItem[]): boolean =>
    a.length === b.length && a.every((item, index) => item === b[index]);
  const before = group(previous);
  const after = group(next);
  // Корзины, из которых убрали все позиции, переписываются пустыми: иначе снятые позиции
  // всплывают при следующей загрузке (R3-ALG-5).
  const buckets = new Set([...before.keys(), ...after.keys()]);
  for (const bucket of buckets) {
    const items = after.get(bucket) ?? [];
    const was = before.get(bucket) ?? [];
    if (sameItems(was, items) || stableHash(was) === stableHash(items)) continue;
    await deps.state.put(
      CONFIRMED_PRICE_NAMESPACE,
      `${supplierPrefix(supplierId)}${bucket}`,
      toStoredJson({ items }),
    );
  }
}

/** Скачки набора и прайс базы, от которого они посчитаны. */
export interface ImportJumps {
  jumps: PriceChange[];
  existing: PriceItem[];
}

/**
 * Скачки набора: от текущей базы и от последних подтверждённых человеком цен. Прайс базы
 * возвращается вместе со скачками, чтобы вызывающий не читал и не хэшировал его повторно.
 */
export async function importJumps(
  deps: PricesDeps,
  supplierId: string,
  items: readonly PriceItem[],
): Promise<ImportJumps> {
  const existing = await deps.prices.listBySupplier(supplierId);
  const confirmed = await loadConfirmedPrices(deps, supplierId);
  const jumps = await runPriceStepsYielding(
    findPriceJumpsSteps(items, existing, undefined, confirmed),
  );
  return { jumps, existing };
}
