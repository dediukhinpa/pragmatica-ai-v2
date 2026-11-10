import type { PriceItem } from './models';

/**
 * Выбор цены для сверки среди одноимённых позиций прайса за O(log g) на позицию вместо полного
 * перебора группы (R9-A1-05): при смене формата артикулов у поставщика каждая позиция шла
 * через перебор своей группы, и прайс 40 тыс. позиций с группами по 200 сверялся 17 с.
 *
 * Результат тот же, что у прямого перебора (эталон - tests/domain/support/price-diff-reference):
 * та же позиция, включая выбор первой по порядку группы при равных отклонениях. Отклонение
 * |новая − старая| / старая монотонно по старой цене по обе стороны от новой, поэтому
 * наибольшее и наименьшее отклонение - на краях отсортированных цен; равные отклонения у
 * разных цен (совпадение после округления double) проверяются проходом от края.
 */

/** Положительные цены одной валюты группы по возрастанию и первая позиция с каждой ценой. */
interface CurrencyPrices {
  /** Номер первой (по порядку группы) позиции в этой валюте, с любой ценой. */
  first: number;
  prices: number[];
  /** `firstAt[i]` - номер первой позиции группы с ценой `prices[i]`. */
  firstAt: number[];
}

/** Группа позиций для сверки цены; сводка по валютам строится при первом обращении. */
export interface PriceGroup {
  readonly items: readonly PriceItem[];
  byCurrency?: ReadonlyMap<string, CurrencyPrices> | undefined;
}

/** Пустая группа: пары нет. */
export const EMPTY_PRICE_GROUP: PriceGroup = { items: [] };

/** Группа из позиций в порядке, в котором их перебирал бы прямой проход. */
export function priceGroup(items: readonly PriceItem[]): PriceGroup {
  return items.length === 0 ? EMPTY_PRICE_GROUP : { items };
}

/** Отклонение цены `price` от прежней положительной цены той же валюты. */
function priceDeviation(item: PriceItem, price: number): number {
  return Math.abs(item.price - price) / price;
}

function summaryOf(group: PriceGroup): ReadonlyMap<string, CurrencyPrices> {
  if (group.byCurrency !== undefined) return group.byCurrency;
  const firstByPrice = new Map<string, { first: number; byPrice: Map<number, number> }>();
  group.items.forEach((item, index) => {
    let entry = firstByPrice.get(item.currency);
    if (entry === undefined) {
      entry = { first: index, byPrice: new Map() };
      firstByPrice.set(item.currency, entry);
    }
    // Нулевая и отрицательная цена дают отклонение 0: в сводку цен не входят.
    if (item.price > 0 && !entry.byPrice.has(item.price)) entry.byPrice.set(item.price, index);
  });
  const byCurrency = new Map<string, CurrencyPrices>();
  for (const [currency, { first, byPrice }] of firstByPrice) {
    const prices = [...byPrice.keys()].sort((a, b) => a - b);
    byCurrency.set(currency, {
      first,
      prices,
      firstAt: prices.map((price) => byPrice.get(price) as number),
    });
  }
  group.byCurrency = byCurrency;
  return byCurrency;
}

/**
 * Первая по порядку группы позиция с отклонением `target`, если искать от края `prices`
 * (`step` = 1 - от меньшей цены, -1 - от большей), пока отклонение равно `target`.
 */
function firstWithDeviation(
  item: PriceItem,
  span: CurrencyPrices,
  target: number,
  step: 1 | -1,
): number {
  let best = Number.POSITIVE_INFINITY;
  const last = span.prices.length - 1;
  for (let at = step === 1 ? 0 : last; at >= 0 && at <= last; at += step) {
    if (priceDeviation(item, span.prices[at] as number) !== target) break;
    best = Math.min(best, span.firstAt[at] as number);
  }
  return best;
}

/** Номер первой позиции группы в валюте, отличной от валюты позиции; бесконечность - нет такой. */
function firstOtherCurrency(item: PriceItem, summary: ReadonlyMap<string, CurrencyPrices>): number {
  let first = Number.POSITIVE_INFINITY;
  for (const [currency, span] of summary) {
    if (currency !== item.currency && span.first < first) first = span.first;
  }
  return first;
}

/**
 * Позиция группы с наибольшим отклонением от новой цены (первая по порядку при равенстве):
 * прежняя версия позиции при смене артикула, «худшая» из кандидатов.
 */
export function worstInGroup(item: PriceItem, group: PriceGroup): PriceItem | undefined {
  const { items } = group;
  if (items.length <= 1) return items[0];
  const summary = summaryOf(group);
  const other = firstOtherCurrency(item, summary);
  if (other !== Number.POSITIVE_INFINITY) return items[other];
  // Здесь вся группа в валюте позиции: сводка ровно одна.
  const span = summary.get(item.currency) as CurrencyPrices;
  const { prices } = span;
  if (prices.length === 0) return items[0];
  const low = priceDeviation(item, prices[0] as number);
  const high = priceDeviation(item, prices[prices.length - 1] as number);
  const worst = Math.max(low, high);
  // Все отклонения нулевые: прямой перебор оставляет первую позицию группы.
  if (!(worst > 0)) return items[0];
  const index = Math.min(
    low === worst ? firstWithDeviation(item, span, worst, 1) : Number.POSITIVE_INFINITY,
    high === worst ? firstWithDeviation(item, span, worst, -1) : Number.POSITIVE_INFINITY,
  );
  return items[index];
}

/**
 * С чем сверять цену НОВОЙ позиции, у которой есть одноимённые с другими (оставшимися в прайсе)
 * артикулами (R9-A1-05). Цена внутри диапазона одноимённых той же валюты - не скачок: новый
 * размер «Болт DIN 933 M12» между M6 и M24 - обычное пополнение прайса. Цена вне диапазона
 * сверяется с ближайшей границей (наименьшее отклонение): дорогой дубль известной позиции
 * по-прежнему требует подтверждения, иначе её цену можно поднять в два шага (добавить дубль,
 * затем снять старую). Одноимённые только в другой валюте - смена валюты, как раньше.
 */
export function nearestSiblingOutsideRange(
  item: PriceItem,
  group: PriceGroup,
): PriceItem | undefined {
  const { items } = group;
  if (items.length === 0) return undefined;
  const summary = summaryOf(group);
  const span = summary.get(item.currency);
  if (span === undefined) return items[0];
  const { prices } = span;
  const lowest = prices[0];
  const highest = prices[prices.length - 1];
  if (lowest === undefined || highest === undefined) return undefined;
  if (item.price >= lowest && item.price <= highest) return undefined;
  const below = item.price < lowest;
  const nearest = priceDeviation(item, below ? lowest : highest);
  return items[firstWithDeviation(item, span, nearest, below ? 1 : -1)];
}
