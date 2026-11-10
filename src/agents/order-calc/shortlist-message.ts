import {
  SOURCE_LABELS,
  webPricesOf,
  type ShortlistProposal,
  type SupplierSource,
  type WebField,
  webFieldsOfEntry,
} from '../../kit/domain/shortlist';
import {
  ENRICH_NAME_MATCH_NOTE,
  WEB_SOURCE_MARK,
  enrichmentContactsLine,
  withWebNote,
} from '../../kit/domain/supplier-enrichment';
import {
  TELEGRAM_SOURCE_MARK,
  withTelegramNote,
  type TelegramField,
} from '../../kit/domain/telegram-source';
import {
  formatPrice,
  formatPriceAmount,
  formatPriceTiers,
  formatPriceWithQualifier,
  type MarketAverage,
  type MarketAverageGroup,
  type MarketPriceSample,
} from '../../kit/domain/market-price';
import { formatSupplierRating } from '../../kit/domain/supplier-rating';
import { pluralRu, type PluralForms } from '@business-ai/core';
import { priceDateNotes } from '../../kit/domain/latest-price';
import { type PriceVat } from '../../kit/domain/models';
import { unitSuffix } from '../../kit/domain/units';
import { matchesLocation } from '../../kit/domain/shortlist-location';
import type { ChatBlock, ChatBlockRow } from '@business-ai/core';

/**
 * Тексты шорт-листа для менеджера (ТЗ, разд. 4). Строит код, не модель: контакты поставщиков
 * (ФИО, телефон, email) попадают только в чат менеджеру и в модель не уходят.
 */

/** Сколько цен одного поставщика показывается в строке; остальные - счётчиком. */
const PRICES_SHOWN_PER_SUPPLIER = 3;

const BASE_LABEL = 'Средняя цена по нашей базе';
const WEB_LABEL = 'Средняя цена по интернету';
const TELEGRAM_LABEL = 'Средняя цена по Telegram-каналу';
/** Пометка среднего, когда у части позиций есть тиражи. */
const TIERS_NOTE = 'Для позиций с тиражами взята цена минимального тиража.';
/**
 * Скидка от суммы заказа в расчёте заказа НЕ применяется (итог зависит от самой скидки и от
 * состава заказа): цена только показывается и в среднее не входит.
 */
const ORDER_SUM_NOTE = 'Скидки от суммы заказа в среднюю не входят.';
/** Пометка среднего, посчитанного только по нижним границам («от», диапазон). */
const LOWER_BOUND_NOTE = 'Оценка снизу: учтены только цены «от» и диапазоны.';
/** Пометка цены, найденной по части слов позиции: возможно, другой товар. */
const APPROXIMATE_NOTE = '(приблизительно, по части слов позиции)';
/** Нет ни одной цены (и любого другого сведения) - так и пишется, без «средней». */
const NO_DATA = 'нет данных';
/** Знаки валют в сообщении о шорт-листе; прочие валюты - кодом. */
const CURRENCY_SIGNS: Readonly<Record<string, string>> = { RUB: '₽' };
const SUPPLIER_FORMS: PluralForms = ['поставщик', 'поставщика', 'поставщиков'];
// После «из»: «из 21 кандидата», «из 22 кандидатов».
const CANDIDATE_OF_FORMS: PluralForms = ['кандидата', 'кандидатов', 'кандидатов'];
const COMPARED_OF_FORMS: PluralForms = [
  'сравнённого кандидата',
  'сравнённых кандидатов',
  'сравнённых кандидатов',
];
const BULLET = '• ';
const DASH = ' — ';

/** Жирный BB-код портала (в таблице Excel жирного нет). */
type Bold = (text: string) => string;
const bbBold: Bold = (text) => `[B]${text}[/B]`;
const plainBold: Bold = (text) => text;

/**
 * Подпись заявки, когда названия нет под рукой (старые вызовы и тесты): внутренний
 * идентификатор сотруднику не показывается никогда.
 */
export const DEFAULT_REQUEST_LABEL = 'заявка';

/** Сумма с валютой и единицей для сообщения о шорт-листе: «1 431,90 ₽/кг». Только здесь. */
function moneyText(amount: number, currency: string, unit?: string | undefined): string {
  return `${formatPriceAmount(amount)} ${currencySign(currency)}${unitSuffix(unit)}`;
}

/** Знак валюты для показа менеджеру: «₽» вместо RUB, остальные валюты - кодом. */
function currencySign(currency: string): string {
  return CURRENCY_SIGNS[currency.trim().toUpperCase()] ?? currency;
}

/**
 * Подпись цены: товар поставщика, как он назван в прайсе или на сайте, иначе позиция заявки.
 * Раньше у каждой цены стояла позиция заявки («ТЕСТ Мёд липовый 250 г: 54,40 ₽»), и не было
 * видно, что за ней ложечка для мёда (бой 29.10).
 */
export function priceLabel(price: Pick<MarketPriceSample, 'item' | 'offer'>): string | undefined {
  return price.offer ?? price.item;
}

/** Подпись НДС, когда признак неизвестен: не угадываем, а так и пишем. */
export const VAT_UNKNOWN_NOTE = 'НДС не указан';
const VAT_NOTES: Readonly<Record<PriceVat, string>> = {
  included: 'с НДС',
  excluded: 'без НДС',
  // Поставщик без НДС (УСН): для менеджера это тоже цена без НДС.
  none: 'без НДС',
  unknown: VAT_UNKNOWN_NOTE,
};

/**
 * Пометка НДС у цены из базы: менеджер должен видеть, сопоставимы ли цены поставщиков. Нет
 * признака (строка до разметки) - «НДС не указан», а не догадка.
 */
export function vatNote(vat: PriceVat | undefined): string {
  return vat === undefined ? VAT_UNKNOWN_NOTE : VAT_NOTES[vat];
}

/**
 * Дата прайса и пометка устаревшего: « (прайс от 31.03.2025)», при давности больше года ещё
 * « (прайс старше года)». Менеджер видит, на какой прайс опирается цена (этап 161).
 */
export function dateNotes(price: MarketPriceSample): string {
  return priceDateNotes(price.priceDate, price.priceStale === true)
    .map((note) => ` (${note})`)
    .join('');
}

/** Цена с подписью товара (или позиции заявки), если она известна. */
function priceText(price: MarketPriceSample): string {
  // Тиражи: основная цена - минимального тиража, рядом все пороги.
  // Один тираж (из ячейки «от 100 шт 45 руб») показывается вместо цены: «от 100 шт — 45 ₽».
  const sign = currencySign(price.currency);
  const [onlyTier, ...moreTiers] = price.tiers ?? [];
  const tierText =
    price.tiers === undefined ? '' : formatPriceTiers(price.tiers, sign, price.tierBasis);
  const tiers = tierText === '' ? '' : ` (${tierText})`;
  const value =
    onlyTier !== undefined && moreTiers.length === 0
      ? tierText
      : `${formatPriceWithQualifier({ ...price, currency: sign })}${tiers}`;
  // Неподтверждённая цена не с диска - только справка рядом с ценой диска.
  const note = price.unconfirmed === undefined ? '' : ` (${price.unconfirmed})`;
  // Близкий товар по оценке модели подписан так же, как у веба; прочее приблизительное - по словам.
  const rough =
    price.similar === true
      ? ` (${SIMILAR_NOTE})`
      : price.approximate === true
        ? ` ${APPROXIMATE_NOTE}`
        : '';
  const terms = price.note === undefined ? '' : ` (${price.note})`;
  const text = `${value}${dateNotes(price)} (${vatNote(price.vat)})${terms}${note}${rough}`;
  const label = priceLabel(price);
  return label === undefined ? text : `${label}: ${text}`;
}

/** Пометка цены, когда товар лишь похож на позицию заявки (сайт или оценка `analog`). */
export const SIMILAR_NOTE = 'похожий товар';

/**
 * Цена со страницы сайта: «Крем-мёд с черникой, 500 г: 1 305 ₽/уп (НДС не указан) (ИЗ
 * ИНТЕРНЕТА)»; без названия товара - позиция заявки. НДС - по данным страницы, а если страница
 * его не назвала - «НДС не указан» (п.2 доработок 08.11). `currency` - как показывать валюту
 * (знак или код в xlsx). Цена на странице по определению из интернета: пометка всегда.
 */
export function webPriceText(price: MarketPriceSample, currency: string): string {
  const value = formatPrice({ ...price, currency });
  const notes = [
    vatNote(price.vat),
    price.note,
    price.approximate === true ? SIMILAR_NOTE : undefined,
  ].filter((note): note is string => note !== undefined);
  const text = withWebNote(`${value} (${notes.join('; ')})`);
  const label = priceLabel(price);
  return label === undefined ? text : `${label}: ${text}`;
}

/** Группа средней: «396,66 ₽ (10 поставщиков, от 122,40 до 905 ₽)»; с позицией - «мёд — …». */
function groupText(group: MarketAverageGroup): string {
  const value = moneyText(group.average, group.currency, group.unit);
  const range =
    group.n > 1 && group.min !== group.max
      ? `, от ${formatPriceAmount(group.min)} до ` +
        moneyText(group.max, group.currency, group.unit)
      : '';
  const count = `${group.n} ${pluralRu(group.n, SUPPLIER_FORMS)}`;
  const head = group.item === undefined ? '' : `${group.item}${DASH}`;
  return `${head}${value} (${count}${range})`;
}

/** Блок одной средней: заголовок и значения (одна группа - одной строкой, иначе списком). */
function averageBlock(
  label: string,
  average: MarketAverage | undefined,
  bold: Bold,
  missing: string,
  origin: 'web' | 'telegram' | undefined = undefined,
): string[] {
  if (average === undefined || average.status === 'none') {
    return [`${bold(`${label}:`)} ${average === undefined ? missing : NO_DATA}`];
  }
  // Средняя по интернету посчитана по ценам со страниц, по каналу - по ценам постов: каждое
  // значение с пометкой своего источника.
  const text = (group: MarketAverageGroup): string => {
    if (origin === 'web') return withWebNote(groupText(group));
    return origin === 'telegram' ? withTelegramNote(groupText(group)) : groupText(group);
  };
  const [only, ...more] = average.groups;
  if (only !== undefined && more.length === 0) return [`${bold(`${label}:`)} ${text(only)}`];
  return [bold(label), ...average.groups.map((group) => `${BULLET}${text(group)}`)];
}

/** Что показать про средние: блоки по базе и интернету и короткая пометка под ними. */
export interface MarketView {
  base: string[];
  web: string[];
  /** Средняя по Telegram-каналу; пусто, пока у канала цен нет (источник выключен). */
  telegram: string[];
  /** Пометки (тиражи, скидки от суммы, оценка снизу) одной строкой; пусто - не применимо. */
  note: string;
}

/**
 * Две средние перед списком поставщиков: «по нашей базе» (последняя цена каждого поставщика
 * из прайсов базы) и «по интернету» (цены со страниц веб-кандидатов). Считает код; порога
 * числа цен нет, в каждой группе подписано, по скольким поставщикам она посчитана. Запись без
 * поля `market` (сохранена до его появления) для базы - «не рассчитывалась». `plain` - без
 * BB-кодов (таблица Excel).
 */
export function marketView(
  market: MarketAverage | undefined,
  webMarket: MarketAverage | undefined,
  webPricesUnmatched = 0,
  hasTiers = false,
  hasOrderSumTiers = false,
  plain = false,
  telegramMarket: MarketAverage | undefined = undefined,
): MarketView {
  const bold = plain ? plainBold : bbBold;
  const base = averageBlock(BASE_LABEL, market, bold, 'не рассчитывалась');
  // Несколько позиций в заявке: цены сайтов не привязаны к позициям и не усредняются.
  const web =
    webPricesUnmatched > 0
      ? [`${bold(`${WEB_LABEL}:`)} ${NO_DATA} (несколько позиций, цены сайтов — в карточках)`]
      : averageBlock(WEB_LABEL, webMarket, bold, NO_DATA, 'web');
  // Блок канала есть, только когда у канала нашлись цены: без источника шапка прежняя.
  const telegram =
    telegramMarket === undefined || telegramMarket.status === 'none'
      ? []
      : averageBlock(TELEGRAM_LABEL, telegramMarket, bold, NO_DATA, 'telegram');
  const lowerBound = [market, webMarket, telegramMarket].some(
    (average) => average?.status === 'ok' && average.groups.some((group) => group.lowerBound),
  );
  const note = [
    hasTiers ? TIERS_NOTE : '',
    hasOrderSumTiers ? ORDER_SUM_NOTE : '',
    lowerBound ? LOWER_BOUND_NOTE : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return { base, web, telegram, note };
}

/**
 * Строка о числе сравнённых кандидатов; нет данных или счёт совпал - пусто.
 * Сравниваются только кандидаты базы (`shortlist-compare.ts`), а в шорт-лист после сравнения
 * добавляются интернет-кандидаты и названные сотрудником поставщики, поэтому сравнённых бывает
 * меньше показанных. Фраза считает ровно показанное и не говорит «отобрано» там, где число
 * меньше: иначе читатель видит противоречие «отобрано 9, в шорт-листе - 10».
 */
export function comparedLine(compared: number | undefined, shown: number): string | undefined {
  if (compared === undefined || compared === shown) return undefined;
  if (compared < shown) {
    return (
      `Сравнено ${compared} из ${shown} ${pluralRu(shown, CANDIDATE_OF_FORMS)}, ` +
      'остальные добавлены без сравнения (из интернета или по названию).'
    );
  }
  return (
    `Из ${compared} ${pluralRu(compared, COMPARED_OF_FORMS)} в шорт-листе — ${shown}.`
  );
}

/**
 * Заголовок сообщения: название шорт-листа и заявки (одинаков для списка, пустой выдачи и
 * откатов). Заявка названа по продукции, а не по `req-…`: id сотрудник не читает и не копирует.
 */
export function shortlistTitleLines(label: string = DEFAULT_REQUEST_LABEL): string[] {
  return [bbBold('Шорт-лист поставщиков'), `Заявка: ${bbBold(label)}`];
}

/**
 * Шапка сообщения о шорт-листе: заголовок, номер заявки, две средние с пометками и строка о
 * числе сравнённых кандидатов. Блоки разделены пустой строкой.
 */
export function shortlistHeaderLines(
  proposal: ShortlistProposal,
  label: string = DEFAULT_REQUEST_LABEL,
): string[] {
  const view = marketView(
    proposal.market,
    proposal.webMarket,
    proposal.webPricesUnmatched,
    proposal.entries.some((entry) => entry.prices?.some((price) => price.tiers !== undefined)),
    proposal.entries.some((entry) =>
      entry.prices?.some((price) => price.tierBasis === 'order_sum'),
    ),
    false,
    proposal.telegramMarket,
  );
  const compared = comparedLine(proposal.compared, proposal.entries.length);
  return [
    ...shortlistTitleLines(label),
    ...view.base,
    '',
    ...view.web,
    ...(view.telegram.length === 0 ? [] : ['', ...view.telegram]),
    ...(view.note === '' ? [] : [view.note]),
    ...(compared === undefined ? [] : ['', compared]),
  ];
}

type Entry = ShortlistProposal['entries'][number];

/**
 * Взято ли поле строки из интернета: по сохранённому происхождению; у прежней записи без
 * `webFields` оно выводится только для строки, найденной лишь вебом (`webFieldsOfEntry`).
 */
function isWebField(entry: Entry, field: WebField): boolean {
  return webFieldsOfEntry(entry).includes(field);
}

/** Откуда сведение строки: из интернета, из Telegram-канала или своё (карточка базы). */
type Origin = 'web' | 'telegram' | undefined;

/** Взято ли поле строки из Telegram-канала (запись без `telegramFields` - ничего не из канала). */
function isTelegramField(entry: Entry, field: TelegramField): boolean {
  return entry.telegramFields?.includes(field) === true;
}

/** Происхождение поля строки; веб-поле важнее (поле берёт один источник, совпасть не могут). */
function originOf(entry: Entry, field: WebField): Origin {
  if (isWebField(entry, field)) return 'web';
  const telegram = (['city', 'contacts', 'email', 'leadTime'] as const).find((f) => f === field);
  return telegram !== undefined && isTelegramField(entry, telegram) ? 'telegram' : undefined;
}

/** Значение с пометкой его источника; своё (из базы) - без пометки. */
function noted(origin: Origin, text: string): string {
  if (origin === 'web') return withWebNote(text);
  return origin === 'telegram' ? withTelegramNote(text) : text;
}

/** Цена с пометкой «из Telegram-канала», если она из канала (происхождение у каждой цены). */
export function telegramPriceNoted(price: MarketPriceSample, text: string): string {
  return price.fromTelegram === true ? withTelegramNote(text) : text;
}

/** Есть ли в строке хоть что-то из интернета: поля, цены страниц, обогащение карточки. */
function hasWebData(entry: Entry): boolean {
  return (
    webFieldsOfEntry(entry).length > 0 ||
    webPricesOf(entry).length > 0 ||
    entry.webEnrichment !== undefined
  );
}

/**
 * Причина выбора от модели ранжирования: она писалась по фактам обоих источников, поэтому
 * при любых данных из интернета в строке помечается целиком.
 */
function rankReasonText(entry: Entry, reason: string): string {
  if (hasWebData(entry)) return withWebNote(reason);
  // Сведения из канала модель тоже видела: причина помечается целиком, как у интернета.
  return (entry.telegramFields ?? []).length > 0 ? withTelegramNote(reason) : reason;
}

/** Значение с пометкой источника поля: «ИЗ ИНТЕРНЕТА», «из Telegram-канала» либо без пометки. */
function marked(entry: Entry, field: WebField, text: string): string {
  return noted(originOf(entry, field), text);
}

/**
 * Город производства; при наличии адреса склада и производства - вместе с ним. Пометка
 * источника («ИЗ ИНТЕРНЕТА», «из Telegram-канала») - у того, что найдено вовне: одного
 * происхождения - одна на всё, разного - у каждой части отдельно.
 */
export function placeText(entry: Entry): string {
  const { city, address } = entry;
  if (city !== undefined && address !== undefined) {
    const cityOrigin = originOf(entry, 'city');
    if (cityOrigin === originOf(entry, 'address')) return noted(cityOrigin, `${city} (${address})`);
    return `${marked(entry, 'city', city)}; адрес: ${marked(entry, 'address', address)}`;
  }
  if (city !== undefined) return marked(entry, 'city', city);
  return address === undefined ? '' : marked(entry, 'address', address);
}

/** Контакты из карточки; у прежних записей шорт-листа - только сохранённый email. */
export function contactsText(entry: Entry): string {
  if (entry.contacts !== undefined) return marked(entry, 'contacts', entry.contacts);
  return entry.email === undefined ? '' : marked(entry, 'email', entry.email);
}

/** Срок поставки; со страницы сайта - с пометкой «ИЗ ИНТЕРНЕТА», из канала - «из Telegram-канала». */
export function leadTimeText(entry: Entry): string {
  return entry.leadTime === undefined ? '' : marked(entry, 'leadTime', entry.leadTime);
}

/**
 * Подпись источника поставщика: интернет и канал - единой пометкой, база - своим названием.
 * Канал подписан одинаково в тексте и в карточке: «база» для него была бы неверной.
 */
export function sourceLabel(source: SupplierSource, card = false): string {
  if (source === 'web') return WEB_SOURCE_MARK;
  if (source === 'telegram') return TELEGRAM_SOURCE_MARK;
  return card ? CARD_BASE_LABEL : SOURCE_LABELS[source];
}

/**
 * Найденное в интернете вместо недостающего в карточке: город, контакты, сайт - всегда с
 * пометкой «из интернета». Есть данные карточки - пусто (карточка важнее найденного).
 */
export function webPlaceText(entry: Entry): string {
  const city = entry.webEnrichment?.city;
  return placeText(entry) !== '' || city === undefined ? '' : withWebNote(city);
}
export function webContactsText(entry: Entry): string {
  const line = entry.webEnrichment === undefined ? '' : enrichmentContactsLine(entry.webEnrichment);
  return contactsText(entry) !== '' || line === '' ? '' : withWebNote(line);
}
/**
 * Сайт поставщика: ссылка и текст для показа. Ссылка из `references` (кандидат из интернета)
 * помечена по `webFields`; сайт обогащения карточки базы - всегда из интернета. Ссылка из
 * `references` важнее найденной обогащением.
 */
export function siteOf(entry: Entry): { url: string; text: string } | undefined {
  const reference = entry.references.find((item) => ABSOLUTE_URL.test(item));
  if (reference !== undefined) {
    return { url: reference, text: marked(entry, 'site', reference) };
  }
  const found = entry.webEnrichment?.site;
  return found === undefined ? undefined : { url: found, text: withWebNote(found) };
}
/** Предупреждение, если найденное сопоставлено только по названию. */
export function webMatchWarning(entry: Entry): string | undefined {
  return entry.webEnrichment?.match === 'name'
    ? `Данные из интернета: ${ENRICH_NAME_MATCH_NOTE}`
    : undefined;
}

function costText(entry: Entry): string {
  const prices = entry.prices ?? [];
  // Веб-кандидат: цены со страницы поставщика (в «среднюю по базе» они не входят).
  const web = webPricesOf(entry);
  if (prices.length === 0 && web.length > 0) {
    const shown = web
      .slice(0, PRICES_SHOWN_PER_SUPPLIER)
      .map((price) => webPriceText(price, currencySign(price.currency)));
    const rest = web.length - PRICES_SHOWN_PER_SUPPLIER;
    return rest > 0 ? `${shown.join('; ')}; и ещё ${rest}` : shown.join('; ');
  }
  if (prices.length === 0) return '';
  // Цены из канала: пометка у каждой такой цены (у поставщика бывают цены базы и канала).
  const shown = prices
    .slice(0, PRICES_SHOWN_PER_SUPPLIER)
    .map((price) => telegramPriceNoted(price, priceText(price)))
    .join('; ');
  const rest = prices.length - PRICES_SHOWN_PER_SUPPLIER;
  return rest > 0 ? `${shown}; и ещё ${rest}` : shown;
}

/** Пометка источника рейтинга: скромно, в скобках. Нет пометки модели - считало правило. */
const RATING_MODEL_LABEL = 'оценка модели';
const RATING_RULE_LABEL = 'по правилу';

/** Рейтинг: «4 из 5 (оценка модели): обоснование», «3,5 из 5 (по правилу)», «нет оценки». */
function ratingText(entry: Entry): string {
  const base = formatSupplierRating(entry.rating);
  if (entry.rating === null || entry.rating === undefined) return base;
  const mark = ` (${entry.ratingSource === 'model' ? RATING_MODEL_LABEL : RATING_RULE_LABEL})`;
  const why = entry.ratingRationale === undefined ? '' : `: ${entry.ratingRationale}`;
  return `${base}${mark}${why}`;
}

/** Подпись строки-предупреждения в карточке. */
const ALERT_LABEL = 'Внимание';
/** Подпись ссылки на сайт. */
const SITE_LABEL = 'Сайт';
/** Подписи источников в карточке. */
const CARD_BASE_LABEL = 'из базы';
/**
 * Пометка строки поставщика, которого назвал сотрудник: он добавлен вне ранжирования, и
 * менеджер должен видеть, почему он в списке (возможно, не самый дешёвый).
 */
export const NAMED_BY_MANAGER_NOTE = 'вы указали';
/** Пометка названного поставщика, у которого в карточке статус «не работаем». */
export const NAMED_INACTIVE_NOTE = 'карточка: не работаем, добавлен по вашему указанию';

/** Хвост заголовка строки с пометкой названного поставщика; у остальных пусто. */
function namedNote(entry: Entry): string {
  if (entry.namedInactive === true) return ` · ${NAMED_INACTIVE_NOTE}`;
  return entry.namedByManager === true ? ` · ${NAMED_BY_MANAGER_NOTE}` : '';
}
/**
 * Чьё место держит отнесение к локации: по данным базы (город или адрес без пометки) локация
 * не находится, а по полному месту - находится, тогда это место из интернета либо из канала
 * (`undefined` - отнесение по своим данным). Правила выбора города или адреса те же, что в
 * `matchesLocation`.
 */
function locationOrigin(entry: Entry, location: string): Origin {
  const { city, address } = entry;
  const cityOwn = city !== undefined && originOf(entry, 'city') === undefined;
  // Адрес считается, только когда города нет вовсе (ни своего, ни найденного обогащением).
  const addressOwn =
    city === undefined &&
    entry.webEnrichment?.city === undefined &&
    address !== undefined &&
    originOf(entry, 'address') === undefined;
  const own = cityOwn ? { city } : addressOwn ? { address } : {};
  if (!matchesLocation(entry, location) || matchesLocation(own, location)) return undefined;
  if (city !== undefined) return originOf(entry, 'city');
  if (entry.webEnrichment?.city === undefined && address !== undefined) {
    return originOf(entry, 'address');
  }
  // Место нашло обогащение карточки базы: оно всегда из интернета.
  return 'web';
}

/** Хвост заголовка с локацией, к которой отнесён поставщик (если приоритет локации применялся). */
function locationNote(entry: Entry): string {
  const { locationGroup } = entry;
  if (locationGroup === undefined) return '';
  const shown = noted(locationOrigin(entry, locationGroup), locationGroup);
  return ` · локация: ${shown}`;
}
/** Абсолютная ссылка: только такая годится как «Сайт» (в `references` бывают и id документов). */
const ABSOLUTE_URL = /^https?:\/\/\S+$/u;

/** Строка карточки поставщика. */
interface EntryField {
  /** Подпись в тексте и в карточке (`Стоимость`); у предупреждения в тексте пустая. */
  label: string;
  cardLabel: string;
  value: string;
  tone?: 'primary' | 'alert' | 'secondary' | undefined;
  /** Абсолютная ссылка для кликабельного значения. */
  link?: string | undefined;
}

/**
 * Поля одного поставщика в порядке показа: Стоимость, Срок, Рейтинг, Город, Контакты - все
 * пять всегда, пустое - «нет данных» (решение владельца 28.10: ТЗ, разд. 4, требует шесть
 * колонок вместе с названием поставщика; прежнее решение скрывать пустые отменено), затем
 * Сайт (если есть) и предупреждение о совпадении. Единый источник для текстового отката
 * и карточек: они не расходятся.
 */
function entryFields(entry: Entry): EntryField[] {
  const fields: EntryField[] = [];
  const add = (label: string, value: string, extra: Partial<EntryField> = {}): void => {
    const empty = value.trim() === '';
    // Пустое значение всегда приглушено, даже у «главной» стоимости.
    fields.push({
      label,
      cardLabel: label,
      ...extra,
      value: empty ? NO_DATA : value,
      ...(empty ? { tone: 'secondary' as const } : {}),
    });
  };
  add('Стоимость', costText(entry), { tone: 'primary' });
  add('Срок', leadTimeText(entry));
  add('Рейтинг', entry.rating === null || entry.rating === undefined ? '' : ratingText(entry));
  add('Город', placeText(entry) || webPlaceText(entry));
  add('Контакты', contactsText(entry) || webContactsText(entry));
  // Причину выбора пишет модель ранжирования; без неё (правило кода) поля нет, а не «нет данных».
  if (entry.rankReason !== undefined) {
    add('Почему в списке', rankReasonText(entry, entry.rankReason));
  }
  const site = siteOf(entry);
  if (site !== undefined) add(SITE_LABEL, site.text, { link: site.url });
  const matchWarning = webMatchWarning(entry);
  if (matchWarning !== undefined) add('', matchWarning, { tone: 'alert', cardLabel: ALERT_LABEL });
  // Пометок «не проверено» и «нет контактов» в шорт-листе нет (решение владельца
  // 28.10): письмо по шаблону составляется и без контакта, контакты часто находит обогащение.
  return fields;
}

/** Строки одного поставщика (текстовый откат): заголовок и заполненные поля. */
export function entryLines(entry: Entry, index: number): string[] {
  const sources = entry.sources.map((source) => sourceLabel(source)).join(', ');
  const notes = `${namedNote(entry)}${locationNote(entry)}`;
  const header = `${index + 1}. Поставщик: ${entry.name} (${sources})${notes}`;
  const body = entryFields(entry).map((field) =>
    field.label === '' ? `   ${field.value}` : `   ${field.label}: ${field.value}`,
  );
  return [header, ...body];
}

/** Квадратные скобки в тексте поставщика (из интернета) не должны стать BB-кодами портала. */
function bbSafe(text: string): string {
  return text.replaceAll('[', '(').replaceAll(']', ')').replaceAll('**', '');
}

/**
 * Карточка поставщика для чата: строка `[B]N. Имя[/B] · источник`, таблица-ROW из заполненных
 * полей (цена - акцентом, предупреждения - красным, сайт - ссылкой). Строит код: контакты в
 * модель не уходят.
 */
export function entryCardBlocks(entry: Entry, index: number): ChatBlock[] {
  const sources = entry.sources.map((source) => sourceLabel(source, true)).join(', ');
  const rows: ChatBlockRow[] = entryFields(entry).map((field) => ({
    name: field.cardLabel,
    value: bbSafe(field.value),
    ...(field.tone === undefined ? {} : { tone: field.tone }),
    ...(field.link === undefined ? {} : { link: field.link }),
  }));
  return [
    {
      kind: 'message',
      text:
        `[B]${index + 1}. ${bbSafe(entry.name)}[/B] · ${sources}${namedNote(entry)}` +
        bbSafe(locationNote(entry)),
    },
    { kind: 'grid', rows },
  ];
}

/** Сколько недостающих сведений заявки называется в строке под шорт-листом (не больше). */
const MAX_REMINDER_ITEMS = 3;
/** Начало и конец строки напоминания: текст фиксирован, меняется только перечень. */
const REMINDER_LEAD = 'Для точного письма поставщику можно добавить:';
const REMINDER_TAIL =
  'Можно не добавлять: письмо будет по имеющимся данным; отправляете его вы.';

/** Короткая подпись поля без пояснений после двоеточия или тире («Образец: да/нет»). */
function reminderItem(label: string): string {
  const short = (label.split(':')[0] ?? label).split(' — ')[0]?.trim() ?? label;
  // Нижний регистр в середине фразы, кроме аббревиатур («НДС»).
  const second = short.charAt(1);
  const abbreviation =
    second !== '' && second === second.toUpperCase() && second !== second.toLowerCase();
  return abbreviation ? short : short.charAt(0).toLowerCase() + short.slice(1);
}

/**
 * Строка о недостающем в заявке под шорт-листом. Собирается кодом из подписей полей формы, а не
 * моделью: модель дописывала выдуманные нормы по материалам и обещала, что «запросы пойдут сами»
 * (запросы поставщикам не отправляются, письмо отправляет сотрудник). Только то, чего не хватает
 * в заявке, максимум три пункта; нечего добавлять - строки нет.
 */
export function missingReminderLine(missing: readonly { label: string }[]): string | undefined {
  const items = [...new Set(missing.map((item) => reminderItem(item.label)))].slice(
    0,
    MAX_REMINDER_ITEMS,
  );
  if (items.length === 0) return undefined;
  return `${REMINDER_LEAD} ${items.join(', ')}. ${REMINDER_TAIL}`;
}
