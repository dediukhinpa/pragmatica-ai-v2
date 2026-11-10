import type { MarketPriceSample } from './market-price';
import type { PriceVat } from './models';
import { splitUnitText } from './units';
import { hasPersonName } from '@business-ai/core';

/**
 * Сведения о веб-кандидате, вытащенные моделью со страницы (ТЗ, разд. 3-4). Модель отвечает
 * сырым JSON, а здесь код проверяет форму каждого поля (без сверки с текстом страницы,
 * решение владельца 28.10). Неверное поле молча отбрасывается и в шорт-листе показывается как
 * «нет данных».
 */

/** Цена веб-кандидата структурно: число, валюта и единица (для «средней по интернету»). */
export interface WebPrice {
  amount: number;
  /** Код валюты из `WEB_PRICE_CURRENCIES`. */
  currency: string;
  /** Единица цены в краткой форме (шт, м2...); не указана - цена за штуку не утверждается. */
  unit?: string | undefined;
  /** Условия цены («минимальный заказ 32 кг»): показываются рядом, в единицу не входят. */
  note?: string | undefined;
  /** НДС, если страница назвала его явно; нет - в шорт-листе «НДС не указан». */
  vat?: PriceVat | undefined;
}

/** Проверенные сведения со страницы кандидата; любое поле может отсутствовать. */
export interface WebPageFacts {
  city?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  site?: string | undefined;
  /** Прежний ответ модели: одна цена без позиции (записи и ответы до 28.10). */
  price?: WebPrice | undefined;
  /** Цены по позициям заявки: позиция, сумма, валюта, единица, товар страницы. */
  prices?: MarketPriceSample[] | undefined;
  leadTime?: string | undefined;
}

/** Валюты, цены в которых принимаются; остальные записи отбрасываются. */
export const WEB_PRICE_CURRENCIES: readonly string[] = ['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'BYN'];
/** Написания валют на страницах -> код. */
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  '₽': 'RUB',
  р: 'RUB',
  руб: 'RUB',
  рубль: 'RUB',
  рублей: 'RUB',
  rub: 'RUB',
  '$': 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
};

/** Пределы длины полей (знаки). */
export const WEB_CITY_MAX_CHARS = 60;
export const WEB_LEAD_TIME_MAX_CHARS = 80;
export const WEB_SITE_MAX_CHARS = 200;
const WEB_EMAIL_MAX_CHARS = 100;
/** Телефон: строка с несколькими номерами длиннее одного адреса почты. */
const WEB_PHONE_MAX_CHARS = 200;
/** Телефон: не меньше цифр, чем в одном номере (российский номер с кодом страны или без). */
const PHONE_DIGITS_MIN = 10;

const CITY_PATTERN = /^[\p{L}][\p{L}\s.\-]*$/u;
const EMAIL_PATTERN = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}\p{N}-]{2,}$/u;
const NON_DIGIT = /\D/g;
const WHITESPACE = /[\s ]+/g;
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** Строка из сырого значения: без управляющих символов, пробелы схлопнуты; не строка - null. */
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_CHARS, ' ').replace(WHITESPACE, ' ').trim();
  return text === '' || text.length > max ? null : text;
}

/**
 * Свободный текст из ответа модели (пометка, название товара, срок). Если в нём ФИО человека -
 * поле отбрасывается: ФИО руководителей и сотрудников в факты и выдачу не попадают (этап 188),
 * даже если модель вопреки инструкции их вернула.
 */
function cleanFreeText(value: unknown, max: number): string | null {
  const text = cleanString(value, max);
  return text === null || hasPersonName(text) ? null : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Код валюты из записи страницы; незнакомая валюта - null. */
export function normalizeWebCurrency(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/\./g, '');
  const code = CURRENCY_ALIASES[key] ?? key.toUpperCase();
  return WEB_PRICE_CURRENCIES.includes(code) ? code : null;
}

function parseCity(value: unknown): string | undefined {
  const text = cleanString(value, WEB_CITY_MAX_CHARS);
  return text !== null && CITY_PATTERN.test(text) ? text : undefined;
}

/*
 * Сверка значений с текстом страницы снята (решение владельца 28.10): правила сверки раз за
 * разом отбрасывали настоящие контакты (почта на домене .рф, несколько номеров в одном поле,
 * регистр). Остались только форма значения и безопасность ссылки; значения из интернета в
 * шорт-листе помечены источником, сотрудник проверяет их сам.
 */

/** Телефон: строка, в которой есть хотя бы 10 цифр (несколько номеров через запятую - можно). */
function parsePhone(value: unknown): string | undefined {
  const text = cleanString(value, WEB_PHONE_MAX_CHARS);
  if (text === null) return undefined;
  return text.replace(NON_DIGIT, '').length >= PHONE_DIGITS_MIN ? text : undefined;
}

/** Почта: строка вида «имя@домен», домен может быть кириллическим (zakaz@пример.рф). */
function parseEmail(value: unknown): string | undefined {
  const text = cleanString(value, WEB_EMAIL_MAX_CHARS)?.toLowerCase();
  return text !== undefined && EMAIL_PATTERN.test(text) ? text : undefined;
}

/** Сайт: только http/https и без учётных данных в адресе (ссылка кликабельна в шорт-листе). */
function parseSite(value: unknown): string | undefined {
  const text = cleanString(value, WEB_SITE_MAX_CHARS);
  if (text === null) return undefined;
  try {
    const url = new URL(text);
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) return undefined;
    return url.username === '' && url.password === '' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * НДС, который страница назвала явно. «unknown» от модели - это «не сказано», поле тогда не
 * заполняется: в шорт-листе «НДС не указан» ставит показ, а не догадка.
 */
const PAGE_VAT_VALUES: readonly PriceVat[] = ['included', 'excluded', 'none'];

function parsePageVat(value: unknown): PriceVat | undefined {
  return PAGE_VAT_VALUES.find((item) => item === value);
}

/** Цена: положительное число и известная валюта. */
function parsePrice(value: unknown): WebPrice | undefined {
  if (!isRecord(value)) return undefined;
  const amount = value.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
  const rawCurrency = cleanString(value.currency, WEB_CITY_MAX_CHARS);
  const currency = rawCurrency === null ? null : normalizeWebCurrency(rawCurrency);
  if (currency === null) return undefined;
  // Единица остаётся читаемой («100 г», «банка 70 г»), условия уходят в пометку: ключ для
  // сравнения и группировки строится из неё отдельно (normalizeUnit), а показ - человеку.
  const rawUnit = cleanString(value.unit, WEB_UNIT_RAW_MAX_CHARS);
  const split = rawUnit === null ? {} : splitUnitText(rawUnit);
  const modelNote = cleanFreeText(value.note, WEB_NOTE_MAX_CHARS);
  const note = [split.note, modelNote].find((text) => text !== undefined && text !== null);
  const vat = parsePageVat(value.vat);
  return {
    amount,
    currency,
    ...(vat === undefined ? {} : { vat }),
    ...(split.unit === undefined ? {} : { unit: split.unit }),
    ...(note === undefined || note === null ? {} : { note: note.slice(0, WEB_NOTE_MAX_CHARS) }),
  };
}

/** Сколько цен по позициям берётся из одного ответа (с запасом на позиции заявки). */
export const WEB_ITEM_PRICES_MAX = 20;
/** Предел длины названия позиции и товара со страницы (знаки). */
const WEB_OFFER_MAX_CHARS = 150;
/** Предел сырой единицы от модели (с условиями) и пометки к цене (знаки). */
const WEB_UNIT_RAW_MAX_CHARS = 120;
const WEB_NOTE_MAX_CHARS = 120;

/**
 * Цены по позициям: `[{item, amount, currency, unit?, offer?, exact?}]`. `exact: false` - товар
 * страницы лишь похож на позицию: цена показывается с пометкой и в среднюю не идёт.
 */
function parseItemPrices(value: unknown): MarketPriceSample[] {
  if (!Array.isArray(value)) return [];
  const out: MarketPriceSample[] = [];
  for (const raw of value.slice(0, WEB_ITEM_PRICES_MAX)) {
    if (!isRecord(raw)) continue;
    const item = cleanString(raw.item, WEB_OFFER_MAX_CHARS);
    const price = parsePrice(raw);
    if (item === null || price === undefined) continue;
    const offer = cleanFreeText(raw.offer, WEB_OFFER_MAX_CHARS);
    out.push({
      item,
      ...price,
      ...(offer === null ? {} : { offer }),
      ...(raw.exact === false ? { approximate: true as const } : {}),
    });
  }
  return out;
}

/** Срок: короткая фраза без адресов и почты (цифры и слова про дни/недели допускаются). */
function parseLeadTime(value: unknown): string | undefined {
  const text = cleanFreeText(value, WEB_LEAD_TIME_MAX_CHARS);
  if (text === null || text.includes('@') || /https?:|www\./i.test(text)) return undefined;
  return text;
}

/**
 * Разобрать сырой ответ модели о странице: форма значений, без сверки с текстом страницы.
 * Не бросает исключений: плохой ответ даёт `{}`.
 */
export function parseWebPageFacts(raw: unknown): WebPageFacts {
  if (!isRecord(raw)) return {};
  const city = parseCity(raw.city);
  const phone = parsePhone(raw.phone);
  const email = parseEmail(raw.email);
  const site = parseSite(raw.site);
  const price = parsePrice(raw.price);
  const prices = parseItemPrices(raw.prices);
  const leadTime = parseLeadTime(raw.leadTime);
  return {
    ...(city === undefined ? {} : { city }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    ...(site === undefined ? {} : { site }),
    ...(price === undefined ? {} : { price }),
    ...(prices.length === 0 ? {} : { prices }),
    ...(leadTime === undefined ? {} : { leadTime }),
  };
}

const EMAIL_IN_TEXT = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}\p{N}-]{2,}/gu;
const PHONE_IN_TEXT = /(?:\+7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/g;
/**
 * Город из адреса: «г. Уфа», «г.Санкт-Петербург», «город Казань». Второе слово через пробел
 * берём только для известных первых слов («Нижний Новгород»): иначе в название попадает
 * следующая за городом подпись («г. Москва Тел»).
 */
const CITY_TWO_WORDS = '(?:Нижний|Великий|Набережные|Старый|Новый|Ростов|Йошкар)\\s+[А-ЯЁ][а-яё]+';
const CITY_ONE_WORD = '[А-ЯЁ][а-яё]+(?:-(?:на-)?[А-ЯЁ][а-яё]+)*';
const CITY_IN_TEXT = new RegExp(
  `(?:^|[\\s,;(])(?:г\\.|город)\\s*(${CITY_TWO_WORDS}|${CITY_ONE_WORD})`,
  'gu',
);
/** Город после слова «Адрес» без «г.»: «Адрес магазина Москва, м.ВДНХ» (opt.med-konfitur.ru). */
const CITY_AFTER_ADDRESS = new RegExp(
  `Адрес[^.,:]{0,30}?:?\\s+(?:\\d{6},?\\s*)?(${CITY_ONE_WORD}),`,
  'u',
);
const NOT_A_CITY: ReadonlySet<string> = new Set(['Россия', 'Российская']);
/** Городов в тексте больше этого - список дилеров или филиалов, а не адрес компании. */
const CITIES_IN_ADDRESS_MAX = 2;

/** Город компании из адресов в тексте: самый частый; много разных городов - не угадываем. */
function pickCity(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(CITY_IN_TEXT)) {
    const city = match[1];
    if (city !== undefined) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  if (counts.size === 0) {
    const byAddress = CITY_AFTER_ADDRESS.exec(text)?.[1];
    return byAddress === undefined || NOT_A_CITY.has(byAddress) ? undefined : byAddress;
  }
  if (counts.size > CITIES_IN_ADDRESS_MAX) return undefined;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Первая почта; при известном сайте предпочтение почте на его домене (не чужой баннер). */
function pickEmail(text: string, siteUrl: string | undefined): string | undefined {
  const all = text.match(EMAIL_IN_TEXT) ?? [];
  const host = hostOfUrl(siteUrl);
  const own =
    host === undefined ? undefined : all.find((mail) => mail.toLowerCase().endsWith(`@${host}`));
  return own ?? all[0];
}

function hostOfUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return undefined;
  }
}

/**
 * Запасной разбор страницы кодом, без модели: почта, российский телефон и город из адреса.
 * Нужен и при отказе шлюза, и чтобы не терять то, что модель пропустила (мобильный номер и
 * почта на mail.ru на сайте компании - контакты компании, 29.10). Результат проходит ту же
 * проверку формы `parseWebPageFacts`; цену и срок код не угадывает.
 */
export function extractWebPageFactsByCode(
  texts: readonly string[],
  siteUrl?: string,
): Record<string, string> {
  const joined = texts.join('\n');
  const email = pickEmail(joined, siteUrl);
  const phone = joined.match(PHONE_IN_TEXT)?.[0];
  const city = pickCity(joined);
  return {
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(city === undefined ? {} : { city }),
  };
}

/**
 * Есть ли в тексте телефон или почта (разбор кодом): по нему читатель решает, нашлась ли
 * страница контактов или нужно пробовать следующий адрес.
 */
export function textHasContacts(text: string): boolean {
  const facts = extractWebPageFactsByCode([text]);
  return facts.phone !== undefined || facts.email !== undefined;
}

const PRICE_IN_TEXT = /(\d[\d\s]*(?:[.,]\d+)?)\s*(?:₽|руб|р\.)/giu;

/** Есть ли в тексте цена больше нуля («0,00 ₽» пустой корзины ценой не считается). */
export function textHasPrice(text: string): boolean {
  for (const match of text.matchAll(PRICE_IN_TEXT)) {
    const value = Number.parseFloat((match[1] ?? '').replace(/\s/gu, '').replace(',', '.'));
    if (Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

/**
 * Город модели «с довеском»: код нашёл тот же город отдельным словом внутри ответа модели
 * («Робинзон Уфа» - название ТЦ из выдачи и город, dikiimed.ru, 29.10). Это не расхождение, а
 * лишние слова: берётся город кода. Другой город у модели - остаётся её ответ (решение 29.10).
 */
function cityWithExtraWords(model: string, code: string): boolean {
  const words = model.toLowerCase().replaceAll('ё', 'е').split(/[\s,.()«»"-]+/u);
  const target = code.toLowerCase().replaceAll('ё', 'е');
  return words.length > 1 && words.includes(target) && model.trim() !== code;
}

/**
 * Дополнить ответ модели тем, что нашёл код: пустые city/phone/email берутся из разбора
 * текстов. Ответ модели не перетирается; исключение - город модели с лишними словами вокруг
 * города кода. Не объект (модель не ответила) - как есть.
 */
export function mergeCodeContacts(
  raw: unknown,
  texts: readonly string[],
  siteUrl?: string,
): unknown {
  if (!isRecord(raw)) return raw;
  const byCode = extractWebPageFactsByCode(texts, siteUrl);
  const merged: Record<string, unknown> = { ...raw };
  for (const field of ['city', 'phone', 'email'] as const) {
    const have = parseWebPageFacts({ [field]: raw[field] })[field];
    const code = byCode[field];
    if (have === undefined && code !== undefined) merged[field] = code;
  }
  const modelCity = parseWebPageFacts({ city: raw.city }).city;
  if (modelCity !== undefined && byCode.city !== undefined) {
    if (cityWithExtraWords(modelCity, byCode.city)) merged.city = byCode.city;
  }
  return merged;
}

/** Сколько телефонов со страницы показывается в шорт-листе: остальные - на сайте. */
export const WEB_PHONES_SHOWN = 2;

/**
 * Телефоны для показа: не больше `WEB_PHONES_SHOWN`, «7 (918) …» без плюса - с плюсом. Сайт
 * пчелково.рф отдал пять номеров одной строкой (бой 29.10).
 */
function phonesForShow(phone: string): string {
  return phone
    .split(/[,;]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(0, WEB_PHONES_SHOWN)
    .map((part) => (/^7[\s(]/u.test(part) ? `+${part}` : part))
    .join(', ');
}

/** Строка контактов юрлица для шорт-листа: телефон, email, сайт; нет ничего - undefined. */
export function webContactsLine(facts: WebPageFacts): string | undefined {
  const parts = [
    facts.phone === undefined ? undefined : `тел. ${phonesForShow(facts.phone)}`,
    facts.email,
    facts.site,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(', ');
}
