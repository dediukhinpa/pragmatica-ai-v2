import { pluralRu, type PluralForms } from '@business-ai/core';
import {
  formatPriceAmount,
  marketGroupOf,
  type MarketAverage,
  type MarketPriceSample,
} from './market-price';
import { SHORTLIST_CODE_REASON_MAX_CHARS, type ShortlistEntry } from './shortlist';
import { withWebNote } from './supplier-enrichment';
import { withTelegramNote } from './telegram-source';
import { unitSuffix } from './units';

/**
 * «Почему в списке» - строка, которую собирает КОД по данным строки шорт-листа после поиска и
 * обогащения из интернета (замечания заказчика 26.11.2026). Модель ранжирования задаёт только
 * порядок; её фраза в показ больше не идёт: оценки без чисел («цена умеренная») клиенту
 * непонятны, а писалась она до обогащения и противоречила найденному («нет контактов» рядом с
 * контактами из интернета). Про контакты строка не пишет: пометки «нет контактов» в шорт-листе
 * нет по решению владельца 28.10, контакты видны в своём поле.
 *
 * Критерий - те же признаки, по которым ранжируется список, в том же порядке:
 * 1. соответствие заявке: по скольким позициям у поставщика тот же товар (точная цена), по
 *    скольким - только похожий (аналог или цена по части слов позиции);
 * 2. цена относительно средней по той же позиции, валюте и единице: цена прайса базы - со
 *    средней по базе, цена с сайта - со средней по интернету, цена из канала - со средней по
 *    каналу. «в 13,7 раза дешевле средней по базе (9 710 ₽)» от двукратной разницы, «на 15%
 *    дешевле/дороже» до неё, «на уровне средней» в пределах ±10%; самая низкая цена группы
 *    отмечается; единственная цена позиции - «других цен по позиции нет». Не больше двух
 *    позиций, остальные - числом;
 * Цен нет совсем - где найден: в базе, поиском в интернете или в канале по товару заявки.
 * Части из интернета и из канала помечены каждая отдельно, а не вся строка.
 */

/** Цена в пределах этой доли от средней - «на уровне средней». */
export const REASON_LEVEL_BAND = 0.1;
/** С этого отношения к средней разница пишется разами («в 2,5 раза»), а не процентами. */
export const REASON_TIMES_FROM = 2;
/** Сколько позиций сравнивается со средней в одной строке; остальные - числом. */
export const REASON_POSITIONS_SHOWN = 2;
const PERCENT = 100;
/** Копеек в рубле: суммы средней округлены до копеек. */
const CENTS = 100;
/** Знаков после запятой в «в N раза». */
const TIMES_DECIMALS = 1;

/** После «по»: «по 1 позиции», «по 2 позициям», «по 5 позициям». */
const BY_POSITION_FORMS: PluralForms = ['позиции', 'позициям', 'позициям'];
/** «из 10 цен». */
const OF_PRICES_FORMS: PluralForms = ['цены', 'цен', 'цен'];
const CURRENCY_SIGNS: Readonly<Record<string, string>> = { RUB: '₽' };
const PART_SEPARATOR = '; ';
const DASH = ' — ';

/** Откуда цена: прайс базы, страница сайта, Telegram-канал. */
type PriceOrigin = 'base' | 'web' | 'telegram';

/** Средние, с которыми сравниваются цены строки (из записи шорт-листа). */
export interface ReasonMarkets {
  market?: MarketAverage | undefined;
  webMarket?: MarketAverage | undefined;
  telegramMarket?: MarketAverage | undefined;
}

interface PricedSample {
  sample: MarketPriceSample;
  origin: PriceOrigin;
}

/** Часть строки причины и её источник (для пометки). */
interface ReasonPart {
  text: string;
  origin: PriceOrigin;
}

const SCOPE_TEXT: Readonly<Record<PriceOrigin, string>> = {
  base: 'по базе',
  web: 'по интернету',
  telegram: 'по Telegram-каналу',
};

function currencySign(currency: string): string {
  return CURRENCY_SIGNS[currency.trim().toUpperCase()] ?? currency;
}

function money(amount: number, currency: string, unit: string | undefined): string {
  return `${formatPriceAmount(amount)} ${currencySign(currency)}${unitSuffix(unit)}`;
}

/** «13,7», «2»: один знак после запятой, без «,0». */
function timesText(value: number): string {
  const fixed = value.toFixed(TIMES_DECIMALS).replace('.', ',');
  return fixed.endsWith(',0') ? fixed.slice(0, -2) : fixed;
}

/** Ключ позиции заявки у цены; без позиции все цены - одна позиция. */
function positionKey(sample: MarketPriceSample): string {
  return sample.item?.trim().toLowerCase() ?? '';
}

/** Тот же товар: не аналог и не найдено по части слов. */
function isExact(sample: MarketPriceSample): boolean {
  return sample.similar !== true && sample.approximate !== true;
}

/** Все цены строки с источником: прайс базы (канал - по пометке цены) и страница сайта. */
function pricedSamples(entry: ShortlistEntry): PricedSample[] {
  const base = (entry.prices ?? []).map(
    (sample): PricedSample => ({
      sample,
      origin: sample.fromTelegram === true ? 'telegram' : 'base',
    }),
  );
  const pages = entry.webPrices ?? (entry.webPrice === undefined ? [] : [entry.webPrice]);
  const web = pages.map((sample): PricedSample => ({ sample, origin: 'web' }));
  return [...base, ...web];
}

/** Соответствие заявке: тот же товар и похожий - по числу позиций. */
function coverageText(samples: readonly PricedSample[], singlePosition: boolean): string {
  const exact = new Set(
    samples.filter((item) => isExact(item.sample)).map((item) => positionKey(item.sample)),
  );
  const similar = new Set(
    samples.map((item) => positionKey(item.sample)).filter((key) => !exact.has(key)),
  );
  const by = (count: number): string => `по ${count} ${pluralRu(count, BY_POSITION_FORMS)}`;
  if (exact.size === 0) {
    return singlePosition ? 'только похожий товар' : `только похожий товар ${by(similar.size)}`;
  }
  const head = singlePosition ? 'тот же товар, что в заявке' : `тот же товар ${by(exact.size)}`;
  return similar.size === 0 ? head : `${head}, похожий${DASH}${by(similar.size)}`;
}

function marketOf(markets: ReasonMarkets, origin: PriceOrigin): MarketAverage | undefined {
  if (origin === 'web') return markets.webMarket;
  return origin === 'telegram' ? markets.telegramMarket : markets.market;
}

/** Отношение цены к средней словами: разы от двукратной разницы, иначе проценты. */
function verdictText(ratio: number, scope: string): string {
  if (Math.abs(ratio - 1) <= REASON_LEVEL_BAND) return `на уровне ${scope}`;
  if (ratio <= 1 / REASON_TIMES_FROM) return `в ${timesText(1 / ratio)} раза дешевле ${scope}`;
  if (ratio < 1) return `на ${Math.round((1 - ratio) * PERCENT)}% дешевле ${scope}`;
  if (ratio < REASON_TIMES_FROM) return `на ${Math.round((ratio - 1) * PERCENT)}% дороже ${scope}`;
  return `в ${timesText(ratio)} раза дороже ${scope}`;
}

/**
 * Цена вошла бы в свою группу средней: не приблизительная (другой товар не сравниваем), а
 * «от»/диапазон и скидка тиража - только с группой из нижних границ (иначе «дешевле средней»
 * было бы сравнением нижней границы с точными ценами).
 */
function comparable(sample: MarketPriceSample, lowerBound: boolean): boolean {
  if (sample.approximate === true) return false;
  const bound = sample.qualifier !== undefined || sample.tierBasis === 'order_sum';
  return !bound || lowerBound;
}

/** Совпадает до копейки (суммы средней округлены до копеек). */
function sameCents(a: number, b: number): boolean {
  return Math.round(a * CENTS) === Math.round(b * CENTS);
}

/** Сравнение одной цены со средней её группы. */
function comparisonText(priced: PricedSample, markets: ReasonMarkets): string | undefined {
  const { sample, origin } = priced;
  const match = marketGroupOf(marketOf(markets, origin), sample);
  if (match === undefined || !comparable(sample, match.group.lowerBound === true)) {
    return undefined;
  }
  const { group, amount } = match;
  const price = money(amount, group.currency, group.unit);
  const label = sample.item ?? sample.offer;
  const head = label === undefined ? price : `${label}: ${price}`;
  if (group.n < 2) return `${head}${DASH}других цен по позиции нет`;
  const average = money(group.average, group.currency, group.unit);
  const lower = group.lowerBound === true ? ', оценка снизу' : '';
  const scope = `средней ${SCOPE_TEXT[origin]} (${average}${lower})`;
  // Ниже минимума группы - цена отсечена как выброс и в среднюю не вошла: «самой низкой из N»
  // её не называем.
  const lowest = sameCents(amount, group.min)
    ? `, самая низкая из ${group.n} ${pluralRu(group.n, OF_PRICES_FORMS)}`
    : '';
  return `${head}${DASH}${verdictText(amount / group.average, scope)}${lowest}`;
}

/** По каждой позиции - самая низкая точная цена строки (иначе самая низкая любая). */
function bestPerPosition(samples: readonly PricedSample[]): PricedSample[] {
  const best = new Map<string, PricedSample>();
  for (const item of samples) {
    const key = positionKey(item.sample);
    const current = best.get(key);
    const better =
      current === undefined ||
      (isExact(item.sample) && !isExact(current.sample)) ||
      (isExact(item.sample) === isExact(current.sample) &&
        item.sample.amount < current.sample.amount);
    if (better) best.set(key, item);
  }
  return [...best.values()];
}

/**
 * Строка без цен: где поставщик найден. Совпадение по товару заявки без цены - карточка или
 * прайс базы по названию позиции, страница из поиска в интернете, пост в канале.
 */
function foundWithoutPrices(entry: ShortlistEntry): ReasonPart {
  if (entry.sources.includes('knowledge')) {
    return { text: 'найден в базе по товару заявки, цен в прайсах нет', origin: 'base' };
  }
  if (entry.sources.includes('telegram')) {
    return { text: 'найден в канале по товару заявки, цен нет', origin: 'telegram' };
  }
  return { text: 'найден поиском по товару заявки, цен на странице нет', origin: 'web' };
}

function noted(part: ReasonPart): string {
  if (part.origin === 'web') return withWebNote(part.text);
  return part.origin === 'telegram' ? withTelegramNote(part.text) : part.text;
}

/**
 * Строка «Почему в списке» для одной строки шорт-листа. `singlePosition` - в заявке одна
 * позиция (тогда без «по N позициям»). Пустая строка - сказать нечего (поля в показе нет).
 */
export function shortlistReasonText(
  entry: ShortlistEntry,
  markets: ReasonMarkets,
  singlePosition: boolean,
): string {
  const samples = pricedSamples(entry);
  const parts: ReasonPart[] = [];
  if (samples.length > 0) {
    parts.push({ text: coverageText(samples, singlePosition), origin: 'base' });
    const compared = bestPerPosition(samples)
      .map((priced) => ({ priced, text: comparisonText(priced, markets) }))
      .filter((item): item is { priced: PricedSample; text: string } => item.text !== undefined);
    for (const item of compared.slice(0, REASON_POSITIONS_SHOWN)) {
      parts.push({ text: item.text, origin: item.priced.origin });
    }
    const rest = compared.length - REASON_POSITIONS_SHOWN;
    if (rest > 0) {
      parts.push({ text: `и ещё по ${rest} ${pluralRu(rest, BY_POSITION_FORMS)}`, origin: 'base' });
    }
  } else {
    parts.push(foundWithoutPrices(entry));
  }
  return parts.map(noted).join(PART_SEPARATOR).slice(0, SHORTLIST_CODE_REASON_MAX_CHARS);
}

/** Позиций заявки, по которым у строк есть цены (для «тот же товар, что в заявке»). */
function positionsOf(entries: readonly ShortlistEntry[]): number {
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const priced of pricedSamples(entry)) keys.add(positionKey(priced.sample));
  }
  return keys.size;
}

/**
 * Строки шорт-листа с причиной «Почему в списке» (`reason`), посчитанной кодом по итоговым
 * данным: вызывается после обогащения из интернета, на каждой выдаче и странице «ещё».
 * `positionCount` - позиций в заявке; не известно - по ценам всех строк.
 */
export function withShortlistReasons(
  entries: readonly ShortlistEntry[],
  markets: ReasonMarkets,
  positionCount?: number | undefined,
): ShortlistEntry[] {
  const single = (positionCount ?? positionsOf(entries)) <= 1;
  return entries.map((entry) => {
    const reason = shortlistReasonText(entry, markets, single);
    return reason === '' ? entry : { ...entry, reason };
  });
}
