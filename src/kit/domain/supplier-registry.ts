import { z } from 'zod';
import { normalizeSupplierName } from './shortlist';
import { hostOfUrl, isForeignHost, isMarketplaceHost, registrableDomain } from '@business-ai/core';
import { isValidInn } from './requisites';
import type { EnrichMatch, SupplierEnrichment } from './supplier-enrichment';
import { MAX_CITY_LENGTH, MAX_PHONE_LENGTH, MAX_WEBSITE_LENGTH } from './supplier-card';

/**
 * Страницы реестров юрлиц (checko.ru, rusprofile.ru, list-org.com): разбор разметки КОДОМ,
 * без модели. Из страницы берутся юрлицо, ИНН, ОГРН, город, адрес, телефон, почта и сайт.
 * ФИО руководителя не читается вовсе: в модель и в шорт-лист оно не нужно. Текст страницы
 * недоверенный: из него берутся только значения по шаблонам, указания не исполняются.
 */

/** Реестры, страницы которых читаются. */
export const REGISTRY_KINDS = ['checko', 'rusprofile', 'listorg'] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** Регистрируемые домены реестров. */
const REGISTRY_DOMAINS: Readonly<Record<string, RegistryKind>> = {
  'checko.ru': 'checko',
  'rusprofile.ru': 'rusprofile',
  'list-org.com': 'listorg',
};

/** Пути страниц компании (а не списков, поиска и разделов) по реестрам. */
const REGISTRY_COMPANY_PATH: Readonly<Record<RegistryKind, RegExp>> = {
  checko: /^\/(?:company|entrepreneur)\/[^/]+\/?$/u,
  rusprofile: /^\/(?:id|ip)\/\d+\/?$/u,
  listorg: /^\/company\/\d+\/?$/u,
};

/** Какому реестру принадлежит адрес страницы компании; null - не страница компании реестра. */
export function registryKindOfUrl(url: string): RegistryKind | null {
  const host = hostOfUrl(url);
  if (host === '') return null;
  const kind = REGISTRY_DOMAINS[registrableDomain(host)];
  if (kind === undefined) return null;
  try {
    const path = new URL(url).pathname;
    return REGISTRY_COMPANY_PATH[kind].test(path) ? kind : null;
  } catch {
    return null;
  }
}

/** Разобранная страница реестра. */
export interface RegistryData {
  inn?: string | undefined;
  ogrn?: string | undefined;
  /** Названия юрлица со страницы (краткое и полное) - для сопоставления по названию. */
  names: string[];
  city?: string | undefined;
  address?: string | undefined;
  phones: string[];
  emails: string[];
  site?: string | undefined;
}

/** Сколько телефонов и адресов почты берётся со страницы. */
const CONTACTS_MAX = 2;
/** Длины ИНН и ОГРН. */
const INN_LEGAL = 10;
const INN_PERSON = 12;
const OGRN_LEGAL = 13;
const OGRN_PERSON = 15;
/** Пределы значений со страницы. */
const VALUE_MAX_CHARS = 200;
const SITE_MAX_CHARS = 120;
/** Сколько знаков после метки сайта просматривается в поиске ссылки. */
const SITE_LOOKAHEAD = 700;
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 11;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  apos: "'",
};

/** Подставить HTML-сущности (именованные и числовые). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Текст без тегов, сущности подставлены, пробелы схлопнуты. */
function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Страница без скриптов, стилей и комментариев (кроме JSON-LD, он берётся отдельно). */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<script\b(?![^>]*ld\+json)[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ');
}

/** Объекты JSON-LD страницы (массив, `@graph` и одиночные объекты разворачиваются в список). */
function jsonLdObjects(html: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      result.push(record);
      visit(record['@graph']);
    }
  };
  for (const match of html.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      visit(JSON.parse(match[1] ?? ''));
    } catch {
      // Битый блок разметки пропускается: остальные источники страницы остаются.
    }
  }
  return result;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Только цифры значения. */
function digitsOf(text: string): string {
  return text.replace(/\D/gu, '');
}

/** ИНН из текста: 10 или 12 цифр подряд. */
function validInnShape(value: string | undefined): string | undefined {
  const digits = value === undefined ? '' : digitsOf(value);
  return digits.length === INN_LEGAL || digits.length === INN_PERSON ? digits : undefined;
}

function validOgrnShape(value: string | undefined): string | undefined {
  const digits = value === undefined ? '' : digitsOf(value);
  return digits.length === OGRN_LEGAL || digits.length === OGRN_PERSON ? digits : undefined;
}

/** Значение внутри элемента с данным id или itemprop (первый такой элемент). */
function elementText(html: string, attribute: string): string | undefined {
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${attribute}[^>]*>([\\s\\S]*?)</\\1>`, 'iu');
  const text = plainText(pattern.exec(html)?.[2] ?? '');
  return text === '' ? undefined : text.slice(0, VALUE_MAX_CHARS);
}

/** Привести город к названию: «г. Москва», «город Тюмень» -> «Москва». */
function cleanCity(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const city = raw
    .replace(/^(?:г\.?|город|гор\.)\s+/iu, '')
    .replace(/[,;].*$/u, '')
    .trim();
  return city === '' ? undefined : city.slice(0, VALUE_MAX_CHARS);
}

/** Домены самих реестров и соцсетей: их ссылки и почта не принадлежат поставщику. */
const FOREIGN_SITE_DOMAINS: ReadonlySet<string> = new Set([
  'checko.ru',
  'rusprofile.ru',
  'list-org.com',
  'vk.com',
  'ok.ru',
  't.me',
  'wa.me',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'yandex.ru',
  'google.com',
]);

function isForeignDomain(hostOrUrl: string): boolean {
  return FOREIGN_SITE_DOMAINS.has(registrableDomain(hostOrUrl));
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/iu;

function pushEmail(list: string[], raw: string | undefined): void {
  const email = decodeEntities(raw ?? '')
    .trim()
    .toLowerCase();
  const domain = email.split('@')[1] ?? '';
  if (!EMAIL.test(email) || isForeignDomain(domain) || list.includes(email)) return;
  list.push(email);
}

/** Телефон для показа: как на странице, если в нём 10-11 цифр. */
function pushPhone(list: string[], raw: string | undefined): void {
  const text = plainText(raw ?? '');
  const digits = digitsOf(text);
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return;
  const known = new Set(list.map(digitsOf));
  if (!known.has(digits)) list.push(text.slice(0, VALUE_MAX_CHARS));
}

/** Сайт со ссылки: только http(s), без логина, не реестр и не соцсеть. */
function siteFromHref(raw: string): string | undefined {
  const href = decodeEntities(raw).trim();
  try {
    const url = new URL(href);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '') {
      return undefined;
    }
    if (isForeignDomain(url.hostname)) return undefined;
    const site = `${url.protocol}//${url.hostname}`;
    return site.length <= SITE_MAX_CHARS ? site : undefined;
  } catch {
    return undefined;
  }
}

/** Сайт: первая внешняя ссылка после метки «Веб-сайт» / «Сайт» (в ограниченном окне). */
function siteAfterLabel(html: string): string | undefined {
  for (const label of html.matchAll(/(?:Веб-сайт|Электронная почта и сайт|Сайт)/gu)) {
    const window = html.slice(
      (label.index ?? 0) + label[0].length,
      (label.index ?? 0) + label[0].length + SITE_LOOKAHEAD,
    );
    for (const link of window.matchAll(/href="([^"]+)"/giu)) {
      const site = siteFromHref(link[1] ?? '');
      if (site !== undefined) return site;
    }
  }
  return undefined;
}

/** Значение после подписи в тексте страницы: «ИНН: 123», «Телефон 8 (495)…». */
function textAfter(text: string, label: RegExp): string | undefined {
  return label.exec(text)?.[1]?.trim();
}

/**
 * Разобрать страницу реестра (один разбор на все три реестра). Источники по убыванию
 * надёжности: JSON-LD (checko), разметка
 * с itemprop и id полей (rusprofile), подписи в тексте (запасной путь, в том числе list-org).
 * ИНН не найден - страница считается непригодной (`null`): сопоставить её не с чем.
 */
export function parseRegistryPage(html: string): RegistryData | null {
  const clean = stripNoise(html);
  const org = jsonLdObjects(html).find(
    (item) => str(item['taxID']) !== undefined || item['@type'] === 'Organization',
  );
  const text = plainText(clean);

  let inn = validInnShape(str(org?.['taxID']));
  let ogrn: string | undefined;
  const identifiers = org?.['identifier'];
  if (Array.isArray(identifiers)) {
    for (const entry of identifiers) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = str(record['propertyID']);
      if (id === 'ОГРН' || id === 'ОГРНИП') ogrn ??= validOgrnShape(str(record['value']));
      if (id === 'ИНН') inn ??= validInnShape(str(record['value']));
    }
  }
  inn ??= validInnShape(elementText(clean, 'id="(?:clip_inn|copy-inn)"'));
  ogrn ??= validOgrnShape(elementText(clean, 'id="(?:clip_ogrn|copy-ogrn)"'));
  // Запасной путь по подписям: цифры принимаются только с верной контрольной суммой ИНН.
  const innByText = validInnShape(textAfter(text, /ИНН(?:\s*\/\s*КПП)?\s*:?\s*(\d{10,12})(?!\d)/u));
  if (inn === undefined && innByText !== undefined && isValidInn(innByText)) inn = innByText;
  ogrn ??= validOgrnShape(textAfter(text, /ОГРН(?:ИП)?\s*:?\s*(\d{13,15})(?!\d)/u));
  if (inn === undefined) return null;

  const names: string[] = [];
  for (const candidate of [
    str(org?.['name']),
    str(org?.['legalName']),
    elementText(clean, 'itemprop="name"'),
    elementText(clean, 'itemprop="legalName"'),
  ]) {
    if (candidate !== undefined && !names.includes(candidate))
      names.push(candidate.slice(0, VALUE_MAX_CHARS));
  }
  if (names.length === 0) {
    const title = textAfter(
      plainText(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? ''),
      /^(.+?)(?:\s+[-–—]\s+|$)/u,
    );
    if (title !== undefined) names.push(title.slice(0, VALUE_MAX_CHARS));
  }

  const address = org?.['address'];
  const addressRecord =
    typeof address === 'object' && address !== null ? (address as Record<string, unknown>) : {};
  const city = cleanCity(
    str(addressRecord['addressLocality']) ??
      elementText(clean, 'itemprop="addressLocality"') ??
      str(addressRecord['addressRegion']),
  );
  const street = str(addressRecord['streetAddress']);
  const addressText =
    street ??
    elementText(clean, 'id="(?:clip_address|copy-x-address)"') ??
    textAfter(text, /Юридический адрес\s*:?\s*(.{10,160}?)(?:\s{2,}|$)/u);

  const phones: string[] = [];
  for (const link of clean.matchAll(/<a\b[^>]*href="tel:[^"]*"[^>]*>([\s\S]*?)<\/a>/giu)) {
    pushPhone(phones, link[1]);
  }
  pushPhone(phones, str(org?.['telephone']));
  const emails: string[] = [];
  for (const link of clean.matchAll(/href="mailto:([^"?]+)/giu)) pushEmail(emails, link[1]);
  pushEmail(emails, str(org?.['email']));
  if (emails.length === 0) {
    for (const found of text.matchAll(/[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}/giu)) {
      pushEmail(emails, found[0]);
    }
  }
  if (phones.length === 0) {
    pushPhone(phones, textAfter(text, /Телефон(?:ы)?\s*:?\s*((?:\+7|8)[\d\s()+-]{9,20})/u));
  }

  const site =
    siteAfterLabel(clean) ??
    siteFromHref(textAfter(text, /Сайт\s*:?\s*((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,})/iu) ?? '');

  return {
    inn,
    ...(ogrn === undefined ? {} : { ogrn }),
    names,
    ...(city === undefined ? {} : { city }),
    ...(addressText === undefined ? {} : { address: addressText.slice(0, VALUE_MAX_CHARS) }),
    phones: phones.slice(0, CONTACTS_MAX),
    emails: emails.slice(0, CONTACTS_MAX),
    ...(site === undefined ? {} : { site }),
  };
}

/** Значимые слова названия: без юридических форм, кавычек и регистра. */
function nameTokens(name: string): string[] {
  const normalized = normalizeSupplierName(name);
  return normalized === '' ? [] : normalized.split(' ');
}

/**
 * Сопоставить страницу реестра с поставщиком. С ИНН в карточке принимается ТОЛЬКО страница с
 * тем же ИНН (`inn`); иначе значимые слова названия поставщика (все или первые, см.
 * `nameWordsPresent`), кроме города или адреса со страницы, должны быть в названии юрлица
 * (`name` - с пометкой «проверьте»: у тёзок разные города). Нет совпадения - `null`.
 */
export function matchRegistry(
  supplier: { name: string; inn?: string | undefined },
  data: RegistryData,
): EnrichMatch | null {
  const cardInn = supplier.inn === undefined ? '' : digitsOf(supplier.inn);
  if (cardInn !== '') return data.inn === cardInn ? 'inn' : null;
  // Названия карточек в базе часто «бренд + город» («Мир Меда Оренбург»): город в названии
  // юрлица не пишется, поэтому слово, совпавшее с городом или адресом реестра, не требуется
  // в названии. Остальные слова (в том числе из имени файла прайса) по-прежнему обязательны.
  const place = new Set([data.city, data.address].flatMap((value) => nameTokens(value ?? '')));
  const wanted = nameTokens(supplier.name).filter((token) => !place.has(token));
  return nameWordsPresent(wanted, new Set(data.names.flatMap(nameTokens))) ? 'name' : null;
}

/** Сколько первых слов названия достаточно, если всё название целиком не совпало. */
export const LEAD_NAME_WORDS = 2;

/**
 * Слова названия есть среди `present`: все целиком либо, если слов больше `LEAD_NAME_WORDS`,
 * хотя бы первые из них. В хвосте названия карточки бывает товар из имени файла («Медовый
 * дом Мед»): юрлицо зовётся «Медовый дом», и без запасного правила оно не совпадало (28.10).
 */
export function nameWordsPresent(
  wanted: readonly string[],
  present: ReadonlySet<string>,
): boolean {
  if (wanted.length === 0) return false;
  if (wanted.every((token) => present.has(token))) return true;
  const lead = wanted.slice(0, LEAD_NAME_WORDS);
  return wanted.length > LEAD_NAME_WORDS && lead.every((token) => present.has(token));
}

/**
 * Поисковики и порталы: их страницы (Карты, Услуги, поиск по картинкам) несут название
 * компании в заголовке, но сайтом компании не являются. 28.10 сайтом «мед Перони» был
 * взят yandex.ru.
 */
const PORTAL_DOMAINS: ReadonlySet<string> = new Set([
  'yandex.ru', 'yandex.com', 'ya.ru', 'google.com', 'google.ru', 'mail.ru', 'rambler.ru',
  'bing.com', 'yahoo.com', 'dzen.ru', 'vk.com', 'ok.ru', 't.me', 'telegram.me',
]);

function isPortalHost(host: string): boolean {
  return PORTAL_DOMAINS.has(registrableDomain(host));
}

function isHttpUrl(url: string): boolean {
  try {
    return /^https?:$/u.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Сайт компании из обычной выдачи поиска: первый результат, заголовок которого совпал с
 * названием поставщика (правило `nameWordsPresent`), кроме реестров, маркетплейсов,
 * справочников, поисковиков и порталов, зарубежных зон. Товар и город на сайте не сверяются
 * (решение владельца, 28.10), поэтому найденное так помечается «совпадение по названию,
 * проверьте».
 */
export function supplierSiteFromHits(
  name: string,
  hits: readonly { title: string; url: string }[],
): string | null {
  const wanted = nameTokens(name);
  for (const hit of supplierSiteCandidates(hits)) {
    if (nameWordsPresent(wanted, new Set(nameTokens(hit.title)))) return hit.url;
  }
  return null;
}

/**
 * Результаты поиска, которые вообще могут быть сайтом компании: http(s), не реестры, не
 * маркетплейсы и справочники, не поисковики и порталы, не зарубежные зоны, без повторов
 * адреса. Один отсев и для правила по словам названия, и для выбора сайта моделью: модели
 * показываются только эти результаты, а ответ принимается только из них.
 */
export function supplierSiteCandidates<T extends { title: string; url: string }>(
  hits: readonly T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const hit of hits) {
    const host = hostOfUrl(hit.url);
    if (host === '' || !isHttpUrl(hit.url) || registryKindOfUrl(hit.url) !== null) continue;
    if (isMarketplaceHost(host) || isForeignHost(host) || isPortalHost(host)) continue;
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    result.push(hit);
  }
  return result;
}

/** Ответ модели про название карточки; поля необязательны - нет поля, нет вывода. */
const nameVerdictSchema = z.object({ isCompany: z.boolean().optional() });
const siteChoiceSchema = z.object({ site: z.string().nullable().optional() });

/**
 * Похоже ли название карточки на название компании по ответу модели: `false` - категория
 * товара («Вяленые фрукты и орехи»), поиск компании по ней бесполезен; `undefined` - ответ не
 * разобран или вывода нет (поиск идёт как раньше).
 */
export function parseSupplierNameVerdict(raw: unknown): boolean | undefined {
  const parsed = nameVerdictSchema.safeParse(raw);
  return parsed.success ? parsed.data.isCompany : undefined;
}

/** Адрес для сравнения: без схемы, `www.`, query, якоря и хвостового `/`, в нижнем регистре. */
function comparableUrl(url: string): string {
  try {
    const text = url.trim();
    const parsed = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
    const path = parsed.pathname.replace(/\/+$/u, '');
    return `${parsed.hostname.toLowerCase().replace(/^www\./u, '')}${path.toLowerCase()}`;
  } catch {
    return '';
  }
}

/**
 * Сайт, выбранный моделью: возвращается ТОЛЬКО адрес из присланного ей списка (выдуманный
 * моделью адрес отбрасывается). Допускается ответ голым доменом или без query - он сверяется
 * со списком, а возвращается адрес из списка. `null` - модель ответила «сайта нет» либо адрес
 * не из списка (оба - «сайт не выбран»); `undefined` - ответ не разобран (запасное правило).
 */
export function parseSupplierSiteChoice(
  raw: unknown,
  allowedUrls: readonly string[],
): string | null | undefined {
  const parsed = siteChoiceSchema.safeParse(raw);
  const answer = parsed.success ? parsed.data.site : undefined;
  // Не разобрано (нет поля `site`) - undefined: вызывающий код идёт запасным правилом.
  if (answer === undefined) return undefined;
  if (answer === null || answer.trim() === '') return null;
  const wanted = comparableUrl(answer);
  if (wanted === '') return null;
  const exact = allowedUrls.find((url) => comparableUrl(url) === wanted);
  if (exact !== undefined) return exact;
  // Голый домен («peronihoney.ru»): берём адрес из списка с тем же хостом.
  return allowedUrls.find((url) => comparableUrl(hostOfUrl(url)) === wanted) ?? null;
}

/** Найденное на странице реестра в виде сведений о поставщике. */
export function enrichmentFromRegistry(match: EnrichMatch, data: RegistryData): SupplierEnrichment {
  return {
    match,
    ...(data.city === undefined ? {} : { city: data.city }),
    ...(data.address === undefined ? {} : { address: data.address }),
    ...(data.phones[0] === undefined ? {} : { phone: data.phones[0] }),
    ...(data.emails[0] === undefined ? {} : { email: data.emails[0] }),
    ...(data.site === undefined ? {} : { site: data.site }),
    ...(data.inn === undefined ? {} : { inn: data.inn }),
    ...(data.ogrn === undefined ? {} : { ogrn: data.ogrn }),
  };
}

/** Поля сведений, которые дополняются со следующей страницы реестра той же компании. */
const MERGED_FIELDS = ['city', 'address', 'phone', 'email', 'site', 'inn', 'ogrn'] as const;

/**
 * Дополнить найденное по названию сведениями со второй страницы реестра той же компании:
 * пустые поля берутся из `extra`, заполненные не меняются. Разные ИНН - разные юрлица (тёзки):
 * `null`, страница не принимается. Нужно потому, что первым в выдаче часто стоит rusprofile,
 * который без входа не показывает контакты, а полная страница checko идёт второй (28.10).
 */
export function mergeRegistryEnrichment(
  base: SupplierEnrichment,
  extra: SupplierEnrichment,
): SupplierEnrichment | null {
  if (base.inn !== undefined && extra.inn !== undefined && base.inn !== extra.inn) return null;
  const merged: SupplierEnrichment = { ...base };
  for (const field of MERGED_FIELDS) {
    if (merged[field] === undefined && extra[field] !== undefined) merged[field] = extra[field];
  }
  return merged;
}

/** Поля правки карточки по найденному (подмножество входа `prepareSupplierCardEdit`). */
export interface CardEditChanges {
  website?: string | undefined;
  productionCity?: string | undefined;
  ogrn?: string | undefined;
  contacts?: Array<{ email?: string | undefined; phone?: string | undefined }> | undefined;
}

/**
 * Правка карточки по найденному, готовая к передаче в `prepareSupplierCardEdit`; пусто, если
 * сохранять нечего. Только совпавшее по ИНН или с сайта карточки: найденное по названию
 * не предлагается к записи (возможен тёзка). Реквизиты и контакты добавляются, чужое не
 * затирается: инструмент правки сам дополняет карточку и показывает итог на подтверждение.
 */
export function cardChangesFromEnrichment(value: SupplierEnrichment): CardEditChanges {
  if (value.match === 'name') return {};
  const phone = value.phone !== undefined && value.phone.length <= MAX_PHONE_LENGTH;
  const contact = {
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(phone && value.phone !== undefined ? { phone: value.phone } : {}),
  };
  return {
    ...(value.site !== undefined && value.site.length <= MAX_WEBSITE_LENGTH
      ? { website: value.site }
      : {}),
    ...(value.city !== undefined && value.city.length <= MAX_CITY_LENGTH
      ? { productionCity: value.city }
      : {}),
    ...(value.ogrn === undefined ? {} : { ogrn: value.ogrn }),
    ...(Object.keys(contact).length === 0 ? {} : { contacts: [contact] }),
  };
}
