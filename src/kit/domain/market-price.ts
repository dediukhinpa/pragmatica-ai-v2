import { z } from 'zod';
import {
  PRICE_QUALIFIERS,
  PRICE_TIER_BASES,
  PRICE_VAT_VALUES,
  priceTierSchema,
  type PriceQualifier,
  type PriceTier,
  type PriceTierBasis,
  type PriceVat,
} from './models';
import { fromMinorUnits, toMinorUnits } from './money';
import { normalizeUnit, piecesInUnit, unitSuffix } from './units';

/**
 * Средняя стоимость по рынку (ТЗ, разд. 4): считается КОДОМ из найденных цен, а не моделью.
 * Здесь только чистые функции: группировка и среднее. Порога «минимум N цен» нет: среднее
 * арифметическое считается всегда, а по скольким ценам - сказано в `n` каждой группы.
 */

/** Знаков после запятой в показанной цене. */
const PRICE_DECIMALS = 2;
/** Размер группы цифр в целой части цены. */
const THOUSANDS_GROUP = 3;
const THOUSANDS_SEPARATOR = ' ';

/** Предел длины причины оценки, знаки (с запасом над усечением в проверке цен). */
const GRADE_REASON_MAX_CHARS = 200;

/** Одна найденная цена: на какую позицию заявки, сколько, в какой валюте и за какую единицу. */
export interface MarketPriceSample {
  /** Позиция заявки, по которой найдена цена; без позиции цены считаются одной группой. */
  item?: string | undefined;
  amount: number;
  currency: string;
  /** Единица цены; в прайсах базы знаний её нет, тогда не указана. */
  unit?: string | undefined;
  /**
   * Справка: свежая неподтверждённая цена той же позиции не с диска (письмо, чат, сотрудник).
   * Только текст для показа: в среднее по рынку и расчёты не входит.
   */
  unconfirmed?: string | undefined;
  /**
   * Тиражи позиции (от двух): `amount` - цена минимального тиража, в среднее по базе идёт она.
   * Для показа «от 50 шт - X, от 100 - Y».
   */
  tiers?: PriceTier[] | undefined;
  /**
   * Основание порогов `tiers`; нет - штуки. При 'order_sum' пороги - суммы заказа в рублях, а
   * `amount` - цена со скидкой, действующей только от первой суммы: точной ценой не считается.
   */
  tierBasis?: PriceTierBasis | undefined;
  /** Как цена указана в прайсе (с НДС / без); нет - не размечено, в шорт-листе «НДС не указан». */
  vat?: PriceVat | undefined;
  /**
   * Признак цены словами («от», диапазон): `amount` - нижняя граница. Такая цена не точная и
   * в среднее по базе не входит, пока есть точные цены той же группы (см. computeMarketAverage).
   */
  qualifier?: PriceQualifier | undefined;
  /** Верхняя граница диапазона (только при `qualifier = 'range'`). */
  max?: number | undefined;
  /**
   * Цена найдена ослабленным поиском (совпали не все значимые слова позиции): возможно, другой
   * товар. Показывается с пометкой, но в среднее по базе не входит.
   */
  approximate?: true | undefined;
  /**
   * Модель проверки цен признала товар близким, но не тем же (`analog`, этап 135): всегда вместе
   * с `approximate`, чтобы не попасть в среднее; в списке подписано «похожий товар».
   */
  similar?: true | undefined;
  /** Дата прайса, из которого взята цена (ISO); в строке шорт-листа - «прайс от ДД.ММ.ГГГГ». */
  priceDate?: string | undefined;
  /** Прайс старше `STALE_PRICE_MONTHS` месяцев: в строке пометка «прайс старше года». */
  priceStale?: true | undefined;
  /** Короткая причина оценки модели - только для ранжирования, в показ менеджеру не идёт. */
  gradeReason?: string | undefined;
  /**
   * Товар, к которому относится цена, как он назван на странице сайта («Крем-мёд с черникой,
   * 500 г»): у цены с сайта позиция заявки и товар страницы могут не совпадать дословно.
   */
  offer?: string | undefined;
  /**
   * Условия цены своими словами («минимальный заказ 32 кг», «при заказе от 15 кг: 10 275 руб»):
   * показываются рядом с ценой, в единицу и ключ сравнения не входят.
   */
  note?: string | undefined;
  /**
   * Цена взята из поста закрытого Telegram-канала (этап 216). Происхождение хранится у каждой
   * цены, а не у строки целиком: у одного поставщика бывают цены базы и канала вперемешку, и
   * пометка «из Telegram-канала» ставится ровно той, что из канала. Такие цены в среднюю по
   * базе не входят (у канала своя средняя).
   */
  fromTelegram?: true | undefined;
}
export const marketPriceSampleSchema: z.ZodType<MarketPriceSample, z.ZodTypeDef, unknown> =
  z.object({
    item: z.string().min(1).optional(),
    amount: z.number().positive(),
    currency: z.string().min(1),
    unit: z.string().min(1).optional(),
    unconfirmed: z.string().min(1).optional(),
    tiers: z.array(priceTierSchema).min(1).optional(),
    tierBasis: z.enum(PRICE_TIER_BASES).optional(),
    vat: z.enum(PRICE_VAT_VALUES).optional(),
    qualifier: z.enum(PRICE_QUALIFIERS).optional(),
    max: z.number().positive().optional(),
    approximate: z.literal(true).optional(),
    similar: z.literal(true).optional(),
    priceDate: z.string().min(1).optional(),
    priceStale: z.literal(true).optional(),
    gradeReason: z.string().min(1).max(GRADE_REASON_MAX_CHARS).optional(),
    offer: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
    fromTelegram: z.literal(true).optional(),
  });

/** Среднее по одной группе цен: одна позиция, одна валюта, одна единица. */
export interface MarketAverageGroup {
  item?: string | undefined;
  currency: string;
  unit?: string | undefined;
  /** Сколько цен вошло в среднее. */
  n: number;
  average: number;
  min: number;
  max: number;
  /**
   * В группе нет точных цен, среднее посчитано по нижним границам («от», диапазон): это
   * оценка снизу, показывается с пометкой.
   */
  lowerBound?: true | undefined;
}
const marketAverageGroupSchema: z.ZodType<MarketAverageGroup, z.ZodTypeDef, unknown> = z.object({
  item: z.string().min(1).optional(),
  currency: z.string().min(1),
  unit: z.string().min(1).optional(),
  n: z.number().int().positive(),
  average: z.number(),
  min: z.number(),
  max: z.number(),
  lowerBound: z.literal(true).optional(),
});

/**
 * Итог расчёта:
 * - `none` - цен нет вовсе («нет данных»);
 * - `ok` - есть хотя бы одна группа; `found` - сколько цен вошло во все группы.
 */
export type MarketAverage =
  | { status: 'none' }
  | { status: 'ok'; found: number; groups: MarketAverageGroup[] };
const marketAverageOkSchema = z.object({
  status: z.literal('ok'),
  found: z.number().int().positive(),
  groups: z.array(marketAverageGroupSchema).min(1),
});
/**
 * Записи шорт-листа, сохранённые до отмены порога, читаются так: `ok` - как есть (лишние
 * поля отбрасываются), `too_few` («среднего нет») - как `none`, то есть «нет данных».
 */
export const marketAverageSchema: z.ZodType<MarketAverage, z.ZodTypeDef, unknown> = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'too_few'
      ? { status: 'none' }
      : value,
  z.discriminatedUnion('status', [z.object({ status: z.literal('none') }), marketAverageOkSchema]),
);

/** Ключ группы: позиция, валюта (без регистра) и единица (по словарю синонимов). */
function groupKey(sample: MarketPriceSample): string {
  const unit = sample.unit === undefined ? '' : normalizeUnit(sample.unit);
  return JSON.stringify([
    sample.item?.trim().toLowerCase() ?? '',
    sample.currency.trim().toUpperCase(),
    unit,
  ]);
}

/**
 * Во сколько раз цена может отличаться от медианы группы, прежде чем её сочтут выбросом
 * (веб: 8,63 ₽ за часы при остальных в тысячи - ошибка разбора страницы или другой товар).
 */
export const PRICE_OUTLIER_FACTOR = 5;
/** Меньше стольких цен в группе медиана ненадёжна: выбросы не отсекаются. */
export const PRICE_OUTLIER_MIN_GROUP = 3;

/**
 * Убрать из цен явные выбросы по медиане группы «позиция + валюта + единица». Нужна средней
 * по интернету: цены со страниц не проходят проверку соответствия товара, как прайсы базы.
 * Только отсечение крайностей, не оценка: группа меньше `PRICE_OUTLIER_MIN_GROUP` не меняется.
 */
export function dropPriceOutliers(prices: readonly MarketPriceSample[]): MarketPriceSample[] {
  const groups = new Map<string, number[]>();
  for (const sample of prices) {
    const key = groupKey(sample);
    groups.set(key, [...(groups.get(key) ?? []), perPiece(sample).amount]);
  }
  const medians = new Map<string, number>();
  for (const [key, amounts] of groups) {
    if (amounts.length < PRICE_OUTLIER_MIN_GROUP) continue;
    const sorted = [...amounts].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    if (median > 0) medians.set(key, median);
  }
  return prices.filter((sample) => {
    const median = medians.get(groupKey(sample));
    if (median === undefined) return true;
    const amount = perPiece(sample).amount;
    return amount >= median / PRICE_OUTLIER_FACTOR && amount <= median * PRICE_OUTLIER_FACTOR;
  });
}

/**
 * Цена упаковки из N штук («2 640 ₽ за упаковку 16 шт») для средней - цена за штуку: иначе она
 * стоит отдельной группой рядом с ценами «за шт» (бой 29.10). Показ цены не меняется.
 */
function perPiece(sample: MarketPriceSample): MarketPriceSample {
  const pieces = sample.unit === undefined ? undefined : piecesInUnit(sample.unit);
  if (pieces === undefined) return sample;
  return { ...sample, amount: sample.amount / pieces, unit: 'шт' };
}

/**
 * Средняя стоимость по найденным ценам. Цены разных позиций, валют и единиц не смешиваются:
 * для каждой комбинации считается своя группа (валюты не пересчитываются и не смешиваются).
 * Среднее арифметическое при любом числе цен, округление до копеек. Неположительные и
 * нечисловые цены игнорируются.
 */
export function computeMarketAverage(prices: readonly MarketPriceSample[]): MarketAverage {
  const buckets = new Map<string, MarketPriceSample[]>();
  for (const sample of prices.map(perPiece)) {
    if (!Number.isFinite(sample.amount) || sample.amount <= 0) continue;
    // Приблизительные цены (возможно, другой товар) среднюю по базе не искажают.
    if (sample.approximate === true) continue;
    const key = groupKey(sample);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [sample]);
    else bucket.push(sample);
  }
  // Точные цены не смешиваем с «от»/диапазоном: нижняя граница занизила бы среднее. Но если
  // в группе точных цен нет вовсе, берём нижние границы с пометкой, а не теряем рыночную
  // цену, которая раньше считалась (позиции с признаком не пропадают из расчёта).
  const used = new Map<string, { samples: MarketPriceSample[]; lowerBound: boolean }>();
  for (const [key, bucket] of buckets) {
    // Цена тиража «от суммы заказа» - скидочная, не базовая: как «от», в точное среднее не идёт.
    const exact = bucket.filter(
      (sample) => sample.qualifier === undefined && sample.tierBasis !== 'order_sum',
    );
    used.set(
      key,
      exact.length > 0
        ? { samples: exact, lowerBound: false }
        : { samples: bucket, lowerBound: true },
    );
  }
  const found = [...used.values()].reduce((total, entry) => total + entry.samples.length, 0);
  if (found === 0) return { status: 'none' };
  const groups: MarketAverageGroup[] = [];
  for (const { samples: bucket, lowerBound } of used.values()) {
    const first = bucket[0];
    if (first === undefined) continue;
    const cents = bucket.map((sample) => toMinorUnits(sample.amount));
    const sum = cents.reduce((total, value) => total + value, 0);
    groups.push({
      ...(first.item === undefined ? {} : { item: first.item }),
      currency: first.currency.trim().toUpperCase(),
      ...(first.unit === undefined ? {} : { unit: first.unit }),
      n: bucket.length,
      average: fromMinorUnits(Math.round(sum / bucket.length)),
      min: fromMinorUnits(Math.min(...cents)),
      max: fromMinorUnits(Math.max(...cents)),
      ...(lowerBound ? { lowerBound: true as const } : {}),
    });
  }
  groups.sort(
    (a, b) =>
      (a.item ?? '').localeCompare(b.item ?? '') ||
      a.currency.localeCompare(b.currency) ||
      (a.unit ?? '').localeCompare(b.unit ?? ''),
  );
  return { status: 'ok', found, groups };
}

/** Сумма для людей: пробелы между тысячами, запятая, копейки только если они есть. */
export function formatPriceAmount(amount: number): string {
  const fixed = Math.abs(amount).toFixed(PRICE_DECIMALS);
  const [whole = '0', fraction = ''] = fixed.split('.');
  const grouped = whole.replace(
    new RegExp(`\\B(?=(\\d{${THOUSANDS_GROUP}})+(?!\\d))`, 'g'),
    THOUSANDS_SEPARATOR,
  );
  const sign = amount < 0 ? '-' : '';
  return /^0+$/.test(fraction) ? `${sign}${grouped}` : `${sign}${grouped},${fraction}`;
}

/** Цена с валютой и единицей: «1 250,50 RUB/шт», «180 RUB за 100 г». */
export function formatPrice(
  sample: Pick<MarketPriceSample, 'amount' | 'currency' | 'unit'>,
): string {
  const unit = unitSuffix(sample.unit);
  return `${formatPriceAmount(sample.amount)} ${sample.currency}${unit}`;
}

/** Тире диапазона цены в показе. */
const RANGE_DASH = '\u2013';

/**
 * Цена с признаком для людей - единственный форматтер цены позиции прайса: «500 RUB» (точная),
 * «от 500 RUB» (минимальная), «500–700 RUB» (диапазон). Без признака совпадает с formatPrice.
 */
export function formatPriceWithQualifier(
  sample: Pick<MarketPriceSample, 'amount' | 'currency' | 'unit' | 'qualifier' | 'max'>,
): string {
  if (sample.qualifier === undefined) return formatPrice(sample);
  const unit = unitSuffix(sample.unit);
  const bounds = formatPriceBounds(sample.amount, sample.qualifier, sample.max);
  return `${bounds} ${sample.currency}${unit}`;
}

/** Цена для человека в отчёте: точная - как число, «от»/диапазон - «от 500», «500–700». */
export function shownPrice(
  price: number,
  qualifier: PriceQualifier | undefined,
  max: number | undefined,
): string | number {
  return qualifier === undefined ? price : formatPriceBounds(price, qualifier, max);
}

/** Сумма без валюты, с признаком: «от 500», «500–700»; без признака - просто сумма. */
export function formatPriceBounds(
  amount: number,
  qualifier: PriceQualifier | undefined,
  max?: number | undefined,
): string {
  const text = formatPriceAmount(amount);
  if (qualifier === 'from') return `от ${text}`;
  if (qualifier === 'range' && max !== undefined) {
    return `${text}${RANGE_DASH}${formatPriceAmount(max)}`;
  }
  return text;
}

/** Единица тиража в показе. */
const TIER_UNIT = 'шт';
/** Единица порога тиража по сумме заказа: пороги всегда в рублях. */
const ORDER_SUM_UNIT = '\u20BD';

/**
 * Цены по тиражам для людей: «от 50 шт — 120 RUB, от 100 — 100 RUB». Единица стоит только у
 * первого тиража, валюта - у каждой цены.
 */
export function formatPriceTiers(
  tiers: readonly PriceTier[],
  currency: string,
  basis: PriceTierBasis = 'quantity',
): string {
  if (basis === 'order_sum') {
    // Порог - сумма заказа в рублях, а не штуки: «от заказа на 62 000 ₽ — 120 RUB».
    return tiers
      .map((tier) => {
        const amount = formatPriceBounds(tier.price, tier.qualifier, tier.max);
        const threshold = `${formatPriceAmount(tier.minQuantity)} ${ORDER_SUM_UNIT}`;
        return `от заказа на ${threshold} \u2014 ${amount} ${currency}`;
      })
      .join(', ');
  }
  return tiers
    .map((tier, index) => {
      const quantity = index === 0 ? `${tier.minQuantity} ${TIER_UNIT}` : String(tier.minQuantity);
      const amount = formatPriceBounds(tier.price, tier.qualifier, tier.max);
      return `от ${quantity} \u2014 ${amount} ${currency}`;
    })
    .join(', ');
}
