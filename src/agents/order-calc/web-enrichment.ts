import {
  SHORTLIST_MAX_SIZE,
  webFieldsOfCandidate,
  type SupplierCandidate,
} from '../../kit/domain/shortlist';
import { leadTimeOrUndefined } from '../../kit/domain/lead-time';
import {
  parseWebPageFacts,
  webContactsLine,
  type WebPageFacts,
} from '../../kit/domain/web-candidate';
import { registrableDomain } from '@business-ai/core';
import { type PurchaseRequest } from '../../kit/domain/models';
import type { WebSearchHit } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import {
  externalQueryProblem,
  requirementsForModel,
  siteScopedQueryProblem,
  isWebSearchLimited,
  mapPool,
  runAuditedWebSearch,
} from '@business-ai/core';
import { loadCompleteness } from './state';
import type { OrderCalcDeps, WebEnrichBudget } from './deps';
import { pageFactsCoverKeyFields, readCandidatePageTexts } from './web-page-facts';

/**
 * Веб-поиск поставщиков с участием модели (ТЗ, разд. 3-4).
 *
 * Почему отдельный вызов модели через `ModelGateway`, а не запросы самого агента: (1) ход
 * агента уже строит ответ сотруднику, лишние рассуждения о поиске раздувают контекст;
 * (2) вход и выход узкие и проверяемые: на входе позиции и поля формы, на выходе список
 * строк, который код фильтрует так же строго, как прежние запросы (длина, ПДн, токены);
 * (3) бюджет и таймаут задаёт код, при сбое модели есть запасной путь - названия позиций;
 * (4) тот же приём уже работает для рейтинга поставщиков. Шлюз - обёртка псевдонимизации:
 * ПДн заявки и контакты со страниц уходят модели токенами, ответ приходит восстановленным.
 */

/** Сколько запросов остаётся от плана модели. */
export const WEB_PLAN_MAX_QUERIES = 3;
/**
 * Предел ожидания ответа модели (план или извлечение), мс. Равен таймауту одного запроса к
 * модели (120 с, решение владельца 09.11): при 20 с отменялись ~2% вызовов, часть из них
 * успела бы ответить; по истечении запрос отменяется, берётся запасной путь.
 */
const WEB_MODEL_TIMEOUT_MS = 120_000;
/**
 * Для скольких лучших кандидатов выполняется обогащение по умолчанию: для всех, кто может
 * попасть в показ (кандидат вне показа обогащать незачем). Каждое обогащение - платный поиск.
 */
export const WEB_ENRICH_MAX_CANDIDATES = SHORTLIST_MAX_SIZE;
/** Платных поисков `site:` на заявку по умолчанию: по одному на показанного кандидата. */
export const WEB_ENRICH_MAX_QUERIES = SHORTLIST_MAX_SIZE;
/** Сколько кандидатов обогащается одновременно по умолчанию (бережём лимитер и шлюз). */
export const WEB_ENRICH_CONCURRENCY = 3;
/**
 * Поисков за ход агента в боевой сборке: до 3 запросов плана + до `WEB_ENRICH_MAX_QUERIES`
 * `site:`-запросов + запас на ручной поиск. Обогащение карточек базы этот лимит не тратит
 * (без лимитов за ход с 28.10, решение владельца). Прежние 8 не хватали на весь показ.
 */
export const WEB_SEARCH_PER_TURN_WITH_ENRICH = 20;
/** Бюджет по умолчанию, когда боевая сборка его не задала. */
const DEFAULT_ENRICH_BUDGET: WebEnrichBudget = {
  maxCandidates: WEB_ENRICH_MAX_CANDIDATES,
  maxQueries: WEB_ENRICH_MAX_QUERIES,
  concurrency: WEB_ENRICH_CONCURRENCY,
};
/** Запрос обогащения: страница контактов именно этого сайта. */
const ENRICH_QUERY_TEMPLATE = (domain: string): string => `site:${domain} контакты`;
/** Сколько результатов поиска просим при обогащении. */
const ENRICH_HITS_LIMIT = 5;
/** Сколько названий позиций заявки уходит в запрос извлечения как «искомый товар». */
const PRODUCT_NAMES_MAX = 3;
/** Сколько позиций заявки уходит модели для поиска цен (больше - пустая трата токенов). */
const WEB_ITEMS_MAX = 10;
/** Знаков одного названия товара в запросе извлечения. */
const PRODUCT_NAME_MAX_CHARS = 100;
/** Знаков значения поля формы, отдаваемых планировщику. */
const FIELD_VALUE_MAX_CHARS = 300;
const WHITESPACE_RUN = /\s+/g;

type Log = OrderCalcDeps['log'];

/**
 * Название искомого товара для запроса извлечения: только названия позиций (без количеств,
 * полей формы и данных заказчика), коротко. Пустая заявка - `undefined`.
 */
export function webProductName(itemNames: readonly string[]): string | undefined {
  const names = itemNames
    .map((name) => name.replace(WHITESPACE_RUN, ' ').trim().slice(0, PRODUCT_NAME_MAX_CHARS))
    .filter((name) => name !== '')
    .slice(0, PRODUCT_NAMES_MAX);
  return names.length === 0 ? undefined : names.join('; ');
}

/** Названия позиций заявки для модели: без лишних пробелов, не длиннее предела, не больше N. */
export function webItemNames(itemNames: readonly string[]): string[] {
  return itemNames
    .map((name) => name.replace(WHITESPACE_RUN, ' ').trim().slice(0, PRODUCT_NAME_MAX_CHARS))
    .filter((name) => name !== '')
    .slice(0, WEB_ITEMS_MAX);
}

/** Требования одной позиции для извлечения цен со страницы. */
export interface WebItemRequirements {
  name: string;
  requirements: string;
}

/** Ключ сравнения позиции: без регистра, «ё» как «е». */
function itemKey(name: string): string {
  return name.trim().toLowerCase().replaceAll('ё', 'е');
}

/** Слово названия короче этого не считается названием товара. */
const POSITION_WORD_MIN_CHARS = 3;
/** Длина основы слова позиции: «орехи» и «грецкий орех» сходятся по «орех». */
const POSITION_STEM_CHARS = 4;
/** Сколько букв допускается после основы («мёд» - «медовый», но не «медведь»). */
const POSITION_ENDING_MAX_CHARS = 3;
/** Слова позиции, которые не называют товар. */
const POSITION_STOP_WORDS: ReadonlySet<string> = new Set([
  'банка', 'банки', 'банках', 'упаковка', 'набор', 'штука',
]);

/** Основы слов позиции (по ним цена с названием сорта сводится к позиции заявки). */
function positionStems(name: string): string[] {
  const words = itemKey(name).match(/[а-яa-z]+/gu) ?? [];
  return words
    .filter((word) => word.length >= POSITION_WORD_MIN_CHARS && !POSITION_STOP_WORDS.has(word))
    .map((word) => word.slice(0, POSITION_STEM_CHARS));
}

/** Слово текста подходит основе: начинается с неё, хвост короткий или «ов…» (медовый). */
function wordMatchesStem(word: string, stem: string): boolean {
  if (!word.startsWith(stem)) return false;
  const rest = word.length - stem.length;
  return rest <= POSITION_ENDING_MAX_CHARS || word.startsWith(`${stem}ов`);
}

/**
 * Позиция заявки для цены, у которой модель написала не название позиции, а сорт товара
 * («Донниковый мёд Светлый» при позиции «Мёд»): по словам названия и предложения. Одна позиция
 * в заявке - она и есть; иначе совпадение по основе слова, неоднозначное - не берём.
 */
function positionOfPrice(
  price: { item?: string | undefined; offer?: string | undefined },
  positions: readonly string[],
): string | undefined {
  if (positions.length === 1) return positions[0];
  const words = itemKey(`${price.item ?? ''} ${price.offer ?? ''}`).match(/[а-яa-z]+/gu) ?? [];
  const matched = positions.filter((name) =>
    positionStems(name).some((stem) => words.some((word) => wordMatchesStem(word, stem))),
  );
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * Цены страницы для кандидата: по позициям заявки (позиция ответа сводится к названию из
 * заявки: точно либо по словам названия и предложения; чужие позиции отбрасываются), иначе
 * прежняя одна цена без позиции. По одной цене на позицию - первая в ответе страницы.
 */
export function webPricesFields(
  facts: WebPageFacts,
  positions: readonly string[],
): Pick<SupplierCandidate, 'webPrice' | 'webPrices'> {
  const byKey = new Map(positions.map((name) => [itemKey(name), name]));
  const taken = new Set<string>();
  const prices = (facts.prices ?? []).flatMap((price) => {
    const item =
      (price.item === undefined ? undefined : byKey.get(itemKey(price.item))) ??
      positionOfPrice(price, positions);
    if (item === undefined || taken.has(item)) return [];
    taken.add(item);
    return [{ ...price, item }];
  });
  if (prices.length > 0) return { webPrices: prices };
  return facts.price === undefined ? {} : { webPrice: facts.price };
}

/** Выполнить вызов модели с пределом ожидания; по таймауту запрос отменяется. */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal | undefined,
  /** Предел ожидания; проверка цен большой пачкой передаёт свой, остальные - общий. */
  timeoutMs: number = WEB_MODEL_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('web_model_timeout')),
    timeoutMs,
  );
  const onOuter = (): void => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuter, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}

/** Код ошибки для журнала (без текста: в нём могли быть данные заявки). */
export function codeOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unexpected';
}

/**
 * Проверка запросов модели кодом: строки, без пробельных повторов, не длиннее предела,
 * без ПДн и токенов (`externalQueryProblem`), без повторов; остаётся не больше трёх.
 */
export function validateWebQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const query = item.replace(WHITESPACE_RUN, ' ').trim();
    const key = query.toLowerCase();
    if (query === '' || seen.has(key) || externalQueryProblem(query) !== null) continue;
    seen.add(key);
    result.push(query);
    if (result.length >= WEB_PLAN_MAX_QUERIES) break;
  }
  return result;
}

/**
 * Веб-запросы по заявке и полям формы. Нет составителя, сбой модели или все запросы не
 * прошли проверку - `null`: вызывающий код берёт прежние запросы по названиям позиций.
 */
export async function planWebQueries(
  deps: OrderCalcDeps,
  request: PurchaseRequest,
  signal: AbortSignal | undefined,
): Promise<string[] | null> {
  const planner = deps.webQueryPlanner;
  if (planner === undefined) return null;
  try {
    const completeness = await loadCompleteness(deps, request.id);
    const fields = Object.fromEntries(
      Object.entries(completeness?.values ?? {}).map(([key, value]) => [
        key,
        value.slice(0, FIELD_VALUE_MAX_CHARS),
      ]),
    );
    const raw = await withTimeout(
      (inner) =>
        planner.plan(
          {
            items: request.items.map((item) => {
              // Требования идут тем же путём, что и название: проверка на ПДн, затем шлюз.
              const requirements = requirementsForModel(item.requirements);
              return {
                name: item.name,
                ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
                unit: item.unit,
                ...(requirements === undefined ? {} : { requirements }),
              };
            }),
            ...(completeness === null ? {} : { kind: completeness.kind }),
            fields,
          },
          { signal: inner },
        ),
      signal,
    );
    const queries = validateWebQueries(raw);
    deps.log?.('web_query_plan', {
      proposed: Array.isArray(raw) ? raw.length : 0,
      kept: queries.length,
    });
    return queries.length === 0 ? null : queries;
  } catch (error) {
    deps.log?.('web_query_plan_failed', { code: codeOf(error) });
    return null;
  }
}

/**
 * Запрос обогащения `site:<регистрируемый домен> контакты`. Не по заголовку: заголовок
 * приводит на чужие сайты и маркетплейсы, а `site:` держит поиск на самом поставщике.
 * Проверка - `siteScopedQueryProblem`, а не `externalQueryProblem`: последняя принимает
 * любой реальный домен за ссылку. Небезопасный запрос (домен с ИНН/телефоном, длина) или
 * нет домена - null, поиск без обогащения.
 */
export function enrichmentQuery(url: string): { query: string; domain: string } | null {
  const domain = registrableDomain(url);
  if (domain === '') return null;
  const query = ENRICH_QUERY_TEMPLATE(domain);
  return siteScopedQueryProblem(query, domain) === null ? { query, domain } : null;
}

/**
 * Веб-кандидат с отметкой, какие его поля взяты из интернета. Всё, что есть у кандидата
 * `searchWeb`, найдено в сети (заголовок выдачи, страница, поиск по сайту), поэтому отметка
 * ставится здесь, один раз, а показ шорт-листа её только читает (п.6 доработок 08.11).
 */
export function markWebFields(candidate: SupplierCandidate): SupplierCandidate {
  const webFields = webFieldsOfCandidate(candidate);
  return webFields.length === 0 ? candidate : { ...candidate, webFields };
}

/** Кандидат и страница, по которой он найден. */
export interface WebFound {
  candidate: SupplierCandidate;
  hit: WebSearchHit;
}

/**
 * Обогащение веб-кандидатов, попавших в показ: дополнительный поиск `site:<домен> контакты`
 * (общий лимитер и аудит; только если чтение страницы не дало город и контакты),
 * тексты страницы (фрагмент, сводка, фрагменты того же сайта) - модели,
 * ответ проверяет код (`parseWebPageFacts`). Нет сведения - поле не заполняется («не
 * указано» в шорт-листе). Сбой любого шага (лимит, модель) кандидата не убирает и другим
 * не мешает. Бюджет заявки - `deps.webEnrichBudget`: кандидатов не больше `maxCandidates`,
 * поисков не больше `maxQueries`; кому поиска не досталось, тому остаются фрагмент и заголовок.
 * Стоимость: до `maxQueries` поисков на заявку (10 USD за 1000 -> до 0,1 USD при 10).
 * Возвращает кандидатов в прежнем порядке.
 */
export async function enrichWebCandidates(
  deps: OrderCalcDeps,
  context: ToolContext,
  found: readonly WebFound[],
  items: readonly string[] = [],
  itemRequirements: readonly WebItemRequirements[] = [],
): Promise<SupplierCandidate[]> {
  const positions = webItemNames(items);
  // Требования только тех позиций, что остались после усечения списка названий.
  const needs = itemRequirements.flatMap(({ name, requirements }) => {
    const [item] = webItemNames([name]);
    return item !== undefined && positions.includes(item) ? [{ item, requirements }] : [];
  });
  const productField = {
    ...(positions.length === 0 ? {} : { items: positions }),
    ...(needs.length === 0 ? {} : { itemRequirements: needs }),
  };
  const enricher = deps.webEnricher;
  if (enricher === undefined) return found.map((item) => item.candidate);
  const log: Log = deps.log;
  const budget = deps.webEnrichBudget ?? DEFAULT_ENRICH_BUDGET;
  // Лучшие кандидаты по релевантности, без повторов по адресу страницы.
  const targets: WebFound[] = [];
  const seenUrls = new Set<string>();
  for (const item of [...found].sort((a, b) => b.candidate.score - a.candidate.score)) {
    if (targets.length >= budget.maxCandidates) break;
    if (seenUrls.has(item.hit.url)) continue;
    seenUrls.add(item.hit.url);
    targets.push(item);
  }
  const enriched = new Map<string, Partial<SupplierCandidate>>();
  let limited = false;
  let queriesLeft = budget.maxQueries;
  await mapPool(targets, budget.concurrency, async ({ candidate, hit }) => {
    const texts = [hit.title, hit.snippet];
    // Страница сайта читается ПЕРВОЙ: она дешевле и точнее второго поиска; поиск (дорогой)
    // нужен, только если по странице не заполнены город и контакты. Сбой чтения даёт [] -
    // прежнее поведение. Тексты страницы идут лишь в extract, не в модель агента.
    const pageTexts = await readCandidatePageTexts(
      deps,
      context,
      hit.url,
      positions.length === 0 ? undefined : { words: positions, hintUrl: hit.url },
    );
    let pageRaw: unknown;
    let pageCovers = false;
    if (pageTexts.length > 0) {
      texts.push(...pageTexts);
      try {
        const early = texts.filter((text) => text.trim() !== '');
        pageRaw = await withTimeout(
          (signal) =>
            enricher.extract(
              { name: candidate.name, url: hit.url, texts: early, ...productField },
              { signal },
            ),
          context.signal,
        );
        const pageFacts = parseWebPageFacts(pageRaw);
        pageCovers = pageFactsCoverKeyFields(pageFacts);
      } catch (error) {
        log?.('web_enrich_model_failed', { code: codeOf(error) });
      }
    }
    const search = enrichmentQuery(hit.url);
    if (search !== null && !limited && !pageCovers && queriesLeft > 0) {
      // Счётчик списывается до await: параллельные кандидаты не превысят бюджет заявки.
      queriesLeft -= 1;
      try {
        const outcome = await runAuditedWebSearch(deps, context, search.query, {
          limit: ENRICH_HITS_LIMIT,
          siteDomain: search.domain,
        });
        texts.push(outcome.summary);
        const domain = registrableDomain(hit.url);
        for (const other of outcome.hits) {
          if (domain !== '' && registrableDomain(other.url) === domain) texts.push(other.snippet);
        }
      } catch (error) {
        // Лимит поиска исчерпан: дальше не ходим, но уже найденное обогащаем по фрагментам.
        if (isWebSearchLimited(error)) limited = true;
        log?.('web_enrich_search_failed', { code: codeOf(error) });
      }
    }
    const allTexts = texts.filter((text) => text.trim() !== '');
    try {
      // Страница уже закрыла ключевые поля - повторный вызов модели не нужен.
      const raw = pageCovers
        ? pageRaw
        : await withTimeout(
            (signal) =>
              enricher.extract(
                { name: candidate.name, url: hit.url, texts: allTexts, ...productField },
                { signal },
              ),
            context.signal,
          );
      const facts = parseWebPageFacts(raw);
      const contacts = webContactsLine(facts);
      const priceFields = webPricesFields(facts, positions);
      // Модель могла вернуть заметку не о сроке («ожидалась в сентябре 2025») - не показываем.
      const leadTime = leadTimeOrUndefined(facts.leadTime, deps.clock.now());
      // Только счётчики, без текстов: видно, вернула ли модель цены и сколько отбросил код
      // при сведении к позициям заявки (орехи-оптом.рф, 29.10 - цены «пропали» без следа).
      log?.('web_enrich_prices', {
        returned: facts.prices?.length ?? 0,
        kept: priceFields.webPrices?.length ?? 0,
        single: facts.price !== undefined,
        pages: pageTexts.length,
      });
      enriched.set(hit.url, {
        ...(facts.city === undefined ? {} : { city: facts.city }),
        ...(contacts === undefined ? {} : { contacts }),
        ...(leadTime === undefined ? {} : { leadTime }),
        ...priceFields,
      });
    } catch (error) {
      log?.('web_enrich_model_failed', { code: codeOf(error) });
    }
  });
  return found.map(({ candidate, hit }) => ({ ...candidate, ...enriched.get(hit.url) }));
}
