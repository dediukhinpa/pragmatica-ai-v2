import { z } from 'zod';
import {
  SUPPLIER_ENRICH_CACHE_DAYS,
  hasEnrichmentData,
  supplierEnrichmentSchema,
  type SupplierEnrichment,
} from '../../kit/domain/supplier-enrichment';
import {
  enrichmentFromRegistry,
  mergeRegistryEnrichment,
  matchRegistry,
  parseRegistryPage,
  parseSupplierNameVerdict,
  parseSupplierSiteChoice,
  registryKindOfUrl,
  supplierSiteCandidates,
  supplierSiteFromHits,
} from '../../kit/domain/supplier-registry';
import { isDomainError, registrableDomain } from '@business-ai/core';
import { extractWebPageFactsByCode, parseWebPageFacts } from '../../kit/domain/web-candidate';
import { supplierSearchName } from '../../kit/domain/price-draft-name';
import { type ShortlistEntry } from '../../kit/domain/shortlist';
import { type SupplierCard } from '../../kit/domain/supplier-card';
import type { SupplierSiteChooser } from '../../kit/ports/web-candidate-model';
import type { WebSearchHit } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import {
  externalQueryProblem,
  isWebSearchLimited,
  mapPool,
  readState,
  runAuditedWebSearch,
  runAuditedWebUrlRead,
  stableHash,
  toStoredJson,
} from '@business-ai/core';
import { EXTERNAL_SUPPLIER_PREFIX, type OrderCalcDeps } from './deps';
import { codeOf, enrichmentQuery, withTimeout } from './web-enrichment';
import { readCandidatePageTexts } from './web-page-facts';

/**
 * Обогащение карточек поставщиков базы через интернет (этап 121, тема 4). Для показанного в
 * шорт-листе поставщика базы, у которого в карточке не хватает почты, телефона, города или
 * сайта: поиск (Яндекс) по названию, затем страницы реестров юрлиц (checko, rusprofile,
 * list-org), которые разбирает КОД по разметке, затем сайт поставщика (чтение страниц и
 * извлечение фактов существующим обогащением). Найденное показывается в шорт-листе с
 * пометкой «из интернета». В карточку без подтверждения сотрудника ничего не пишется; ФИО
 * руководителя с реестра не читается вовсе, страницы реестров модели не отдаются.
 */

/** Пространство кэша: ключ - поставщик, значение - результат с отметкой времени. */
export const SUPPLIER_ENRICH_NAMESPACE = 'order-calc:supplier-enrich';
/** Сколько страниц реестров читается на одного поставщика. */
export const REGISTRY_READS_PER_SUPPLIER = 2;
/** Сколько результатов поиска просим. */
const SEARCH_HITS_LIMIT = 10;
/** Знаков названия в поисковом запросе (весь запрос ограничен проверкой запроса). */
const QUERY_NAME_MAX_CHARS = 80;
/** Сколько названий товаров из прайса поставщика видит модель. */
const PRICE_PRODUCTS_MAX = 5;
/** Знаков названия товара, заголовка и фрагмента результата в запросе к модели. */
const PRODUCT_NAME_MAX_CHARS = 80;
const HIT_TITLE_MAX_CHARS = 150;
const HIT_SNIPPET_MAX_CHARS = 200;
/** Сколько результатов поиска (после отсева) показывается модели при выборе сайта. */
const SITE_CHOICE_HITS_MAX = 15;
/** Сколько результатов поиска `site:<домен> контакты` просим. */
const CONTACTS_HITS_LIMIT = 5;
/** Слово в запросе, смещающее выдачу к реестрам юрлиц. */
const QUERY_REQUISITES_WORD = 'реквизиты';
const MS_PER_DAY = 86_400_000;

/**
 * Настройки обогащения поставщиков (`WEB_ENRICH_SUPPLIERS_ENABLED`). Пределов на сборку и на
 * сутки нет (решение владельца 28.10: при пределе 5 шестой поставщик показа оставался без
 * данных); расход ограничивают лимиты поиска и чтений за ход и суточный предел Яндекса.
 */
export interface SupplierEnrichSettings {
  /** Одновременно обогащаемых поставщиков. */
  concurrency: number;
}

const cacheSchema = z.object({
  fetchedAt: z.string().min(1),
  fingerprint: z.string().min(1),
  /** `null` - старые записи «не нашли» (теперь не пишутся; при чтении - как найденного нет). */
  result: supplierEnrichmentSchema.nullable(),
});

/** Итоговые счётчики сборки для журнала (без названий). */
interface EnrichStats {
  candidates: number;
  tried: number;
  cached: number;
  registryHit: number;
  siteHit: number;
  /** Сайт взят из обычной выдачи поиска (не с реестра и не из карточки). */
  searchSite: number;
  innMatched: number;
  /** Название карточки - не компания (категория товара): поиск не запускался. */
  notCompany: number;
  /** Модель выбрала сайт / ответила «сайта нет» / не ответила (сработало правило). */
  modelSite: number;
  modelNoSite: number;
  modelFailed: number;
  /** Поиск `site:<домен> контакты`: сколько выполнено и сколько дало телефон или почту. */
  contactsSearch: number;
  contactsFound: number;
}

/** Каких сведений не хватает в карточке. */
interface Missing {
  email: boolean;
  phone: boolean;
  city: boolean;
  site: boolean;
}

function missingOf(card: SupplierCard): Missing {
  return {
    email: !card.contacts.some((contact) => contact.email !== undefined),
    phone: !card.contacts.some((contact) => contact.phone !== undefined),
    city: card.productionCity === undefined,
    site: card.website === undefined,
  };
}

function anyMissing(missing: Missing): boolean {
  return missing.email || missing.phone || missing.city || missing.site;
}

/** Оставить в найденном только то, чего в карточке нет (имеющееся не подменяется). */
function onlyMissing(found: SupplierEnrichment, card: SupplierCard): SupplierEnrichment | null {
  const missing = missingOf(card);
  const result: SupplierEnrichment = {
    match: found.match,
    ...(missing.city && found.city !== undefined ? { city: found.city } : {}),
    ...(missing.city && found.address !== undefined && card.address === undefined
      ? { address: found.address }
      : {}),
    ...(missing.phone && found.phone !== undefined ? { phone: found.phone } : {}),
    ...(missing.email && found.email !== undefined ? { email: found.email } : {}),
    ...(missing.site && found.site !== undefined ? { site: found.site } : {}),
    ...(card.ogrn === undefined && found.ogrn !== undefined ? { ogrn: found.ogrn } : {}),
    ...(card.inn === undefined && found.inn !== undefined ? { inn: found.inn } : {}),
  };
  return hasEnrichmentData(result) ? result : null;
}

/**
 * Версия правил поиска и сопоставления. Меняется вместе с правилами: иначе «не нашли», записанное
 * по старым правилам, держалось бы весь срок кэша (2: город в названии карточки; 3: сброс
 * промахов, записанных до отказа от их кэширования; 4: слияние страниц реестров одной
 * компании и разбор фактов без сверки со страницей, 28.10; 5: служебные слова и первые
 * слова названия, сайт из выдачи, 28.10; 6: сброс сайта yandex.ru в кэше и запасные адреса
 * страницы контактов, 28.10; 7: выбор сайта и проверка названия моделью, поиск контактов
 * `site:`, этап 125; 8: контакты со страницы кодом, обычные адреса контактов вместо «о
 * компании» и текст без меню, этап 126; 9: следующий адрес контактов, если на открывшемся
 * нет телефона и почты, и страницы по выбору модели из ссылок главной, 29.10).
 */
const ENRICH_RULES_VERSION = 9;

/** Ключ кэша зависит от того, что искали: правка названия или ИНН в карточке сбрасывает кэш. */
function fingerprintOf(card: SupplierCard): string {
  return stableHash([
    ENRICH_RULES_VERSION,
    supplierSearchName(card.name),
    card.inn ?? null,
    card.productionCity ?? null,
  ]);
}

async function loadCached(
  deps: OrderCalcDeps,
  card: SupplierCard,
): Promise<{ result: SupplierEnrichment | null } | null> {
  let cached: z.infer<typeof cacheSchema> | null;
  try {
    cached = await readState(deps.state, SUPPLIER_ENRICH_NAMESPACE, card.id, cacheSchema);
  } catch {
    // Повреждённый кэш - как будто его нет: платить за поиск лучше, чем ронять сборку.
    return null;
  }
  if (cached === null || cached.fingerprint !== fingerprintOf(card)) return null;
  const age = deps.clock.now().getTime() - Date.parse(cached.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age >= SUPPLIER_ENRICH_CACHE_DAYS * MS_PER_DAY) {
    return null;
  }
  return { result: cached.result };
}

async function saveCached(
  deps: OrderCalcDeps,
  card: SupplierCard,
  result: SupplierEnrichment | null,
): Promise<void> {
  const value = {
    fetchedAt: deps.clock.now().toISOString(),
    fingerprint: fingerprintOf(card),
    result,
  };
  // `done`: запись не «живое состояние», её уберёт обычная ретенция; срок кэша проверяется
  // по `fetchedAt`.
  await deps.state.put(SUPPLIER_ENRICH_NAMESPACE, card.id, toStoredJson(value), { done: true });
}

/** Запросы по поставщику: к реестрам (с «реквизиты») и к сайту компании (без него). */
interface SupplierQueries {
  query: string;
  siteQuery: string;
  piiAllowed: boolean;
}

/** Поисковый запрос: очищенное название (+ город, + ИНН, если поиск по ИНН разрешён). */
function searchQueryOf(deps: OrderCalcDeps, card: SupplierCard): SupplierQueries | null {
  const name = supplierSearchName(card.name).slice(0, QUERY_NAME_MAX_CHARS).trim();
  if (name === '') return null;
  const piiAllowed = deps.webSearchQueryPiiAllowed === true;
  const parts = [name];
  if (card.productionCity !== undefined) parts.push(card.productionCity);
  if (piiAllowed && card.inn !== undefined) parts.push(card.inn);
  const siteQuery = [name, card.productionCity].filter((part) => part !== undefined).join(' ');
  parts.push(QUERY_REQUISITES_WORD);
  const query = parts.join(' ');
  // Без разрешения на ПДн в запросе действует полная проверка: ФИО и номера не уходят.
  if (!piiAllowed && externalQueryProblem(query) !== null) return null;
  return { query, siteQuery, piiAllowed };
}

/** Поля, при наличии которых чтение следующих страниц реестра не нужно. */
const REGISTRY_FULL_FIELDS = ['city', 'phone', 'email', 'site'] as const;

/**
 * Страницы реестра по результатам поиска: совпавшее с поставщиком или null. Читаются все
 * выбранные страницы, а не до первого совпадения: страницы одной компании сливаются (первым
 * в выдаче часто стоит rusprofile без контактов, полная страница checko - второй, 28.10).
 * Совпадение по ИНН важнее совпадения по названию.
 */
async function findInRegistries(
  deps: OrderCalcDeps,
  context: ToolContext,
  card: SupplierCard,
  urls: readonly string[],
): Promise<SupplierEnrichment | null> {
  let best: SupplierEnrichment | null = null;
  for (const url of urls.slice(0, REGISTRY_READS_PER_SUPPLIER)) {
    // Без лимита хода (решение владельца 28.10): обогащается весь показ, расход - в аудите.
    const outcome = await runAuditedWebUrlRead(deps, context, url, { charge: false });
    const html = outcome.status === 'ok' ? outcome.pages[0]?.html : undefined;
    if (html === undefined) continue;
    const data = parseRegistryPage(html);
    if (data === null) continue;
    const match = matchRegistry({ name: supplierSearchName(card.name), inn: card.inn }, data);
    if (match === null) continue;
    const page = enrichmentFromRegistry(match, data);
    if (best === null) {
      best = page;
    } else if (page.match === 'inn' && best.match !== 'inn') {
      best = mergeRegistryEnrichment(page, best) ?? page;
    } else {
      best = mergeRegistryEnrichment(best, page) ?? best;
    }
    // Всё нужное уже есть - следующая страница ничего не добавит
    const found = best;
    if (REGISTRY_FULL_FIELDS.every((field) => found[field] !== undefined)) break;
  }
  return best;
}

/** Сайт поставщика: тексты страниц -> извлечение фактов -> проверка кодом. */
export async function enrichFromSite(
  deps: OrderCalcDeps,
  context: ToolContext,
  card: Pick<SupplierCard, 'name'>,
  siteUrl: string,
): Promise<Partial<SupplierEnrichment>> {
  const enricher = deps.webEnricher;
  if (enricher === undefined) return {};
  const texts = await readCandidatePageTexts(deps, context, siteUrl);
  if (texts.length === 0) return {};
  try {
    const raw = await withTimeout(
      (signal) => enricher.extract({ name: card.name, url: siteUrl, texts }, { signal }),
      context.signal,
    );
    const facts = parseWebPageFacts(raw);
    return {
      ...(facts.city === undefined ? {} : { city: facts.city }),
      ...(facts.phone === undefined ? {} : { phone: facts.phone }),
      ...(facts.email === undefined ? {} : { email: facts.email }),
    };
  } catch (error) {
    if (context.signal?.aborted === true) throw error;
    deps.log?.('web_enrich_model_failed', { code: codeOf(error) });
    return {};
  }
}

/** Адрес сайта для чтения: http(s) и только хост; пусто, если не адрес. */
function siteUrlOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
    return url.hostname.includes('.') ? `${url.protocol}//${url.hostname}` : null;
  } catch {
    return null;
  }
}

/** Нужно ли читать сайт: реестр не закрыл город или контакты, которых нет в карточке. */
function needsSiteRead(found: SupplierEnrichment, card: SupplierCard): boolean {
  const missing = missingOf(card);
  return (
    (missing.city && found.city === undefined) ||
    (missing.phone && found.phone === undefined) ||
    (missing.email && found.email === undefined)
  );
}

/** Итог по одному поставщику. */
interface OneResult {
  found: SupplierEnrichment | null;
  registryHit: boolean;
  siteHit: boolean;
  searchSite: boolean;
  /** Название карточки - не компания: поиск не запускался, итог кэшируется. */
  notCompany: boolean;
}

/** Названия товаров из прайса поставщика (до пяти разных): по ним модель видит, чем он торгует. */
async function priceProductsOf(deps: OrderCalcDeps, card: SupplierCard): Promise<string[]> {
  try {
    const names = new Set<string>();
    for (const item of await deps.prices.listBySupplier(card.id)) {
      const name = item.productName.replace(/\s+/gu, ' ').trim().slice(0, PRODUCT_NAME_MAX_CHARS);
      if (name !== '') names.add(name);
      if (names.size >= PRICE_PRODUCTS_MAX) break;
    }
    return [...names];
  } catch {
    // Прайс - подсказка модели, не условие обогащения.
    return [];
  }
}

/** Вызов модели с общим таймаутом; сбой пишется в журнал кодом и даёт `undefined`. */
async function askChooser<T>(
  deps: OrderCalcDeps,
  context: ToolContext,
  call: (chooser: SupplierSiteChooser, signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const chooser = deps.supplierSiteChooser;
  if (chooser === undefined) return undefined;
  try {
    return await withTimeout((signal) => call(chooser, signal), context.signal);
  } catch (error) {
    if (context.signal?.aborted === true) throw error;
    // Шлюз отказал (например, ФИО в названии ИП) или таймаут: дальше работает прежнее правило.
    deps.log?.('supplier_site_model_failed', { code: codeOf(error) });
    return undefined;
  }
}

/** Итог выбора сайта из выдачи. */
interface SiteChoice {
  url: string | null;
  /** Кто решил: модель выбрала / сказала «нет» / не ответила (правило) / модели нет. */
  by: 'model' | 'model_none' | 'rule';
  /** Модель была, но не ответила (сбой или неразобранный ответ). */
  modelFailed: boolean;
}

/**
 * Сайт компании из обычной выдачи, когда его не дали ни реестр, ни карточка. Без модели:
 * сначала правило по словам названия в выдаче запроса к реестрам, затем отдельный поиск без
 * «реквизиты» (оно смещает выдачу к реестрам, и сайт компании туда часто не попадает, 28.10).
 * С моделью (этап 125): второй поиск идёт всегда, модель видит оба списка (за вычетом
 * реестров, маркетплейсов и порталов) и выбирает адрес ИЗ списка либо «нет» - правило по
 * словам не находит «Peroni Honey» по названию «мед Перони». Сбой или неразобранный ответ -
 * прежнее правило.
 */
async function siteFromSearch(
  deps: OrderCalcDeps,
  context: ToolContext,
  card: SupplierCard,
  query: SupplierQueries,
  hits: readonly WebSearchHit[],
  products: readonly string[],
): Promise<SiteChoice> {
  const name = supplierSearchName(card.name);
  const withModel = deps.supplierSiteChooser !== undefined;
  if (!withModel) {
    const first = supplierSiteFromHits(name, hits);
    if (first !== null) return { url: first, by: 'rule', modelFailed: false };
  }
  const search = await runAuditedWebSearch(deps, context, query.siteQuery, {
    limit: SEARCH_HITS_LIMIT,
    charge: false,
    ...(query.piiAllowed ? { piiAllowedInQuery: true } : {}),
  });
  const all = [...hits, ...search.hits];
  if (!withModel) {
    return { url: supplierSiteFromHits(name, search.hits), by: 'rule', modelFailed: false };
  }
  const candidates = supplierSiteCandidates(all).slice(0, SITE_CHOICE_HITS_MAX);
  if (candidates.length === 0) return { url: null, by: 'model_none', modelFailed: false };
  const urls = candidates.map((hit) => hit.url);
  const answer = await askChooser(deps, context, (chooser, signal) =>
    chooser.chooseSite(
      {
        name: card.name,
        ...(card.productionCity === undefined ? {} : { city: card.productionCity }),
        products: [...products],
        hits: candidates.map((hit) => ({
          title: hit.title.slice(0, HIT_TITLE_MAX_CHARS),
          url: hit.url,
          snippet: hit.snippet.slice(0, HIT_SNIPPET_MAX_CHARS),
        })),
      },
      { signal },
    ),
  );
  const chosen = answer === undefined ? undefined : parseSupplierSiteChoice(answer, urls);
  if (chosen === undefined) {
    return { url: supplierSiteFromHits(name, all), by: 'rule', modelFailed: true };
  }
  return { url: chosen, by: chosen === null ? 'model_none' : 'model', modelFailed: false };
}

/** Телефон и почта со страниц одного сайта из выдачи `site:<домен> контакты`. */
async function contactsFromSearch(
  deps: OrderCalcDeps,
  context: ToolContext,
  siteUrl: string,
): Promise<Partial<SupplierEnrichment>> {
  const search = enrichmentQuery(siteUrl);
  if (search === null) return {};
  try {
    const outcome = await runAuditedWebSearch(deps, context, search.query, {
      limit: CONTACTS_HITS_LIMIT,
      siteDomain: search.domain,
      charge: false,
    });
    // Только страницы этого же сайта: чужой фрагмент даст чужой телефон.
    const texts = outcome.hits
      .filter((hit) => registrableDomain(hit.url) === search.domain)
      .flatMap((hit) => [hit.title, hit.snippet]);
    if (texts.length === 0) return {};
    const facts = parseWebPageFacts(extractWebPageFactsByCode(texts));
    return {
      ...(facts.phone === undefined ? {} : { phone: facts.phone }),
      ...(facts.email === undefined ? {} : { email: facts.email }),
    };
  } catch (error) {
    if (context.signal?.aborted === true) throw error;
    deps.log?.('supplier_contacts_search_failed', { code: codeOf(error) });
    return {};
  }
}

async function enrichOne(
  deps: OrderCalcDeps,
  context: ToolContext,
  card: SupplierCard,
  query: SupplierQueries,
  stats: EnrichStats,
): Promise<OneResult> {
  // Без сайта и ИНН в карточке: сначала короткая проверка, что название - компания. «Вяленые
  // фрукты и орехи» - категория из имени файла прайса, поиск по ней приводит на мусор (28.10).
  // По ИНН реестр находит компанию независимо от названия, поэтому проверка там не нужна.
  let products: string[] = [];
  if (deps.supplierSiteChooser !== undefined && card.website === undefined) {
    products = await priceProductsOf(deps, card);
    if (card.inn === undefined) {
      const verdict = await askChooser(deps, context, (chooser, signal) =>
        chooser.checkName(
          {
            name: card.name,
            ...(card.productionCity === undefined ? {} : { city: card.productionCity }),
            products,
          },
          { signal },
        ),
      );
      if (verdict !== undefined && parseSupplierNameVerdict(verdict) === false) {
        stats.notCompany += 1;
        return {
          found: null,
          registryHit: false,
          siteHit: false,
          searchSite: false,
          notCompany: true,
        };
      }
    }
  }
  // Поиски обогащения не тратят лимит хода и сотрудника (решение владельца 28.10); остаются
  // аудит и суточный предел самого Яндекса (YANDEX_SEARCH_DAILY_MAX).
  const search = await runAuditedWebSearch(deps, context, query.query, {
    limit: SEARCH_HITS_LIMIT,
    charge: false,
    ...(query.piiAllowed ? { piiAllowedInQuery: true } : {}),
  });
  const registryUrls = search.hits
    .filter((hit) => registryKindOfUrl(hit.url) !== null)
    .map((hit) => hit.url);
  const registry = await findInRegistries(deps, context, card, registryUrls);
  let found: SupplierEnrichment | null = registry;
  // Сайт: найденный на реестре (после совпадения), указанный в карточке, иначе из выдачи.
  let siteUrl = siteUrlOf(registry?.site ?? card.website);
  let searchSite = false;
  // Не при совпадении по ИНН: такое найденное предлагается к записи в карточку, а сайт тёзки
  // туда попасть не должен. Сайт из выдачи - всегда совпадение по названию («проверьте»).
  if (siteUrl === null && registry?.match !== 'inn') {
    const choice = await siteFromSearch(deps, context, card, query, search.hits, products);
    if (choice.modelFailed) stats.modelFailed += 1;
    else if (choice.by === 'model') stats.modelSite += 1;
    else if (choice.by === 'model_none') stats.modelNoSite += 1;
    siteUrl = siteUrlOf(choice.url ?? undefined);
    if (siteUrl !== null) {
      searchSite = true;
      found = { ...(found ?? {}), match: 'name', site: siteUrl };
    }
  }
  let siteHit = false;
  if (siteUrl !== null) {
    const base: SupplierEnrichment = found ?? { match: 'site', site: siteUrl };
    if (needsSiteRead(base, card)) {
      const facts = await enrichFromSite(deps, context, card, siteUrl);
      siteHit = Object.keys(facts).length > 0;
      if (siteHit) {
        found = {
          ...base,
          ...(base.city === undefined && facts.city !== undefined ? { city: facts.city } : {}),
          ...(base.phone === undefined && facts.phone !== undefined ? { phone: facts.phone } : {}),
          ...(base.email === undefined && facts.email !== undefined ? { email: facts.email } : {}),
        };
      }
    }
    // Сайт известен, а телефона или почты (которых нет и в карточке) всё ещё нет: один поиск
    // `site:<домен> контакты`, как у веб-кандидатов; берутся фрагменты страниц этого сайта.
    const current: SupplierEnrichment = found ?? base;
    const missing = missingOf(card);
    const lackPhone = missing.phone && current.phone === undefined;
    const lackEmail = missing.email && current.email === undefined;
    if (lackPhone || lackEmail) {
      stats.contactsSearch += 1;
      const extra = await contactsFromSearch(deps, context, siteUrl);
      const phone = lackPhone ? extra.phone : undefined;
      const email = lackEmail ? extra.email : undefined;
      if (phone !== undefined || email !== undefined) {
        stats.contactsFound += 1;
        found = {
          ...current,
          ...(phone === undefined ? {} : { phone }),
          ...(email === undefined ? {} : { email }),
        };
      }
    }
  }
  return { found, registryHit: registry !== null, siteHit, searchSite, notCompany: false };
}

/**
 * Обогатить показанных поставщиков базы. Возвращает строки в прежнем порядке; сбой любого шага
 * строку не убирает. Найденное берётся из кэша на 30 дней, «не нашли» не кэшируется.
 */
export async function enrichShownSuppliers(
  deps: OrderCalcDeps,
  context: ToolContext,
  entries: readonly ShortlistEntry[],
): Promise<ShortlistEntry[]> {
  const settings = deps.supplierEnrich;
  // Без чтения страницы по адресу реестры не прочитать: обогащение выключено целиком.
  if (settings === undefined || deps.webPageReader?.readUrl === undefined) return [...entries];
  const baseIds = entries
    .filter(
      (entry) =>
        entry.sources.includes('knowledge') &&
        !entry.supplierId.startsWith(EXTERNAL_SUPPLIER_PREFIX),
    )
    .map((entry) => entry.supplierId);
  if (baseIds.length === 0) return [...entries];
  const cards = new Map<string, SupplierCard>();
  for (const card of await deps.suppliers.getCards(baseIds)) cards.set(card.id, card);

  const stats: EnrichStats = {
    candidates: 0,
    tried: 0,
    cached: 0,
    registryHit: 0,
    siteHit: 0,
    searchSite: 0,
    innMatched: 0,
    notCompany: 0,
    modelSite: 0,
    modelNoSite: 0,
    modelFailed: 0,
    contactsSearch: 0,
    contactsFound: 0,
  };
  const found = new Map<string, SupplierEnrichment>();
  const targets = baseIds
    .map((id) => cards.get(id))
    .filter((card): card is SupplierCard => card !== undefined && anyMissing(missingOf(card)));
  stats.candidates = targets.length;
  let stopped = false;

  await mapPool(targets, settings.concurrency, async (card) => {
    const cached = await loadCached(deps, card);
    if (cached !== null) {
      stats.cached += 1;
      const rest = cached.result === null ? null : onlyMissing(cached.result, card);
      if (rest !== null) found.set(card.id, rest);
      return;
    }
    if (stopped) return;
    const query = searchQueryOf(deps, card);
    if (query === null) return;
    stats.tried += 1;
    try {
      const one = await enrichOne(deps, context, card, query, stats);
      if (one.registryHit) stats.registryHit += 1;
      if (one.siteHit) stats.siteHit += 1;
      if (one.searchSite) stats.searchSite += 1;
      if (one.found?.match === 'inn') stats.innMatched += 1;
      // Кэшируются только находки. Промах не кэшируется: 28.10 отбитые лимитом чтения реестров
      // легли в кэш как «не нашли» на 30 дней, и карточки больше не искались. Цена повтора -
      // до двух поисков на поставщика за сборку.
      // Исключение - вердикт «не компания»: он не сбой, а ответ модели, повтор дал бы тот же
      // вызов на каждой сборке; null в кэше читается как «найденного нет».
      if (one.found !== null || one.notCompany) await saveCached(deps, card, one.found);
      const rest = one.found === null ? null : onlyMissing(one.found, card);
      if (rest !== null) found.set(card.id, rest);
    } catch (error) {
      if (context.signal?.aborted === true) throw error;
      // Лимит поиска и «не настроено» - дальше не ходим; результат не кэшируется.
      if (
        isWebSearchLimited(error) ||
        (isDomainError(error) && error.code === 'not_configured')
      ) {
        stopped = true;
      }
      deps.log?.('supplier_enrich_failed', { code: codeOf(error) });
    }
  });

  if (stats.tried > 0 || stats.cached > 0) {
    // Только числа: без названий поставщиков, адресов и найденных контактов.
    deps.log?.('supplier_enrich', { ...stats });
  }
  return entries.map((entry) => {
    const enrichment = found.get(entry.supplierId);
    return enrichment === undefined ? entry : { ...entry, webEnrichment: enrichment };
  });
}
