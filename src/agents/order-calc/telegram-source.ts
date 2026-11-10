import { DomainError, isDomainError } from '@business-ai/core';
import {
  TELEGRAM_QUERY_MAX_CHARS,
  parseTelegramPostFacts,
  telegramReference,
} from '../../kit/domain/telegram-source';
import { dropPriceOutliers, type MarketPriceSample } from '../../kit/domain/market-price';
import {
  telegramFieldsOfCandidate,
  type SourceResult,
  type SupplierCandidate,
} from '../../kit/domain/shortlist';
import { webContactsLine } from '../../kit/domain/web-candidate';
import { type PriceItem, type PurchaseRequest } from '../../kit/domain/models';
import type {
  TelegramChannelSource,
  TelegramPost,
  TelegramPostExtractor,
} from '../../kit/ports/telegram-channel-source';
import { BoundedCache, compositeKey, sha256HexSync } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import { externalQueryProblem, mapPool, requirementsForModel } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { filterRelevantPrices, type PriceRowsOfItem } from './price-relevance';
import { saveSourceResult } from './state';
import { codeOf, webPricesFields, withTimeout } from './web-enrichment';

/**
 * Закрытый Telegram-канал как источник поиска поставщиков (этап 216, п.3 доработок 08.11).
 *
 * Почему поиск стоит внутри `searchKnowledgeSuppliers`, а не отдельным инструментом: (1) промпт,
 * декларация агента и записи eval при выключенном флаге не меняются; (2) канал по приоритету -
 * база знаний, его место рядом с ней; (3) вызов делает код, поэтому модель не может направить
 * его на произвольный запрос или текст. Сбой канала записывается как «недоступен» и остальные
 * источники не затрагивает.
 */

/** Зависимости источника; нет поля в `OrderCalcDeps` - источник выключен. */
export interface TelegramChannelDeps {
  source: TelegramChannelSource;
  extractor: TelegramPostExtractor;
  /** Сколько постов брать в разбор за сборку (`TELEGRAM_SEARCH_MAX_POSTS`). */
  maxPosts: number;
  /**
   * Общий бюджет времени источника за сборку, мс (по умолчанию `TELEGRAM_SOURCE_BUDGET_MS`):
   * поиск, разбор постов и проверка цен вместе. Нет поля - константа.
   */
  budgetMs?: number | undefined;
  /** Кэш разбора постов в пределах процесса; нет - каждый пост разбирается заново. */
  cache?: TelegramPostCache | undefined;
}

/** Ключ источника отдаёт сам вызов; значение - сырой ответ модели по посту. */
interface CachedPost {
  storedAt: number;
  raw: unknown;
}

/** Параметры кэша разбора постов. */
export interface TelegramPostCacheOptions {
  /** Срок жизни записи, мс. */
  ttlMs?: number;
  /** Сколько постов держать в памяти. */
  maxEntries?: number;
  /** Часы (в тестах подменяются). */
  now?: () => number;
}

/** Срок жизни разбора поста в кэше, мс: пост канала не меняется, шорт-листы пересобирают часто. */
const TELEGRAM_POST_CACHE_TTL_MS = 600_000;
/** Сколько разобранных постов держим в памяти процесса. */
const TELEGRAM_POST_CACHE_ENTRIES = 200;

/**
 * Кэш разбора постов канала по каналу, номеру сообщения и позициям заявки (цены в разборе
 * зависят от позиций, поэтому они в ключе; текст поста - в отпечатке, правка поста сбрасывает
 * запись). Живёт в памяти процесса и ограничен по числу записей и сроку. Кладётся только
 * успешный сырой ответ модели; сбой и пустой ответ не кэшируются. Повторная сборка шорт-листа
 * по той же заявке иначе заново отправляла бы каждый пост модели.
 */
export class TelegramPostCache {
  private readonly entries: BoundedCache<CachedPost>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TelegramPostCacheOptions = {}) {
    this.entries = new BoundedCache(options.maxEntries ?? TELEGRAM_POST_CACHE_ENTRIES);
    this.ttlMs = options.ttlMs ?? TELEGRAM_POST_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private keyOf(post: TelegramPost, positions: readonly string[]): string {
    const digest = sha256HexSync(JSON.stringify([post.text, positions]));
    return compositeKey(`${post.channel}/${post.messageId}`, digest);
  }

  /** Сырой ответ модели по посту; нет записи или срок вышел - `undefined`. */
  get(post: TelegramPost, positions: readonly string[]): unknown {
    const found = this.entries.get(this.keyOf(post, positions));
    if (found === undefined || this.now() - found.storedAt > this.ttlMs) return undefined;
    return found.raw;
  }

  /** Запомнить ответ модели по посту (пустой ответ не запоминается). */
  set(post: TelegramPost, positions: readonly string[], raw: unknown): void {
    if (raw === null || raw === undefined) return;
    this.entries.set(this.keyOf(post, positions), { storedAt: this.now(), raw });
  }
}

/** Постов в разбор за сборку по умолчанию и наибольшее допустимое значение настройки. */
export const TELEGRAM_SEARCH_MAX_POSTS_DEFAULT = 20;
export const TELEGRAM_SEARCH_MAX_POSTS_LIMIT = 50;

/** Код причины: часть постов (или все) не разобрана; источник при этом `ok`. */
export const TELEGRAM_SEARCH_PARTIAL_REASON = 'extract_failed';
/** Общий бюджет времени источника за сборку, мс: дольше канал не ждём (база отвечает сама). */
const TELEGRAM_SOURCE_BUDGET_MS = 90_000;
/** Код причины недоступности, когда источник не уложился в бюджет времени. */
export const TELEGRAM_SOURCE_BUDGET_REASON = 'timeout';
/** Код причины: часть запросов к каналу не выполнена, посты по остальным найдены. */
const QUERIES_PARTIAL_REASON = 'queries_failed';
/** Код ошибки, если исключение не доменное. */
const UNEXPECTED_REASON = 'unexpected';
/** Запросов к каналу за сборку: по названиям позиций заявки, дальше первые. */
const TELEGRAM_QUERIES_MAX = 5;
/** Постов разбирается моделью одновременно (бережём шлюз и лимит запросов). */
const EXTRACT_CONCURRENCY = 3;
/** Предел ожидания разбора одного поста, мс. */
const EXTRACT_TIMEOUT_MS = 30_000;
/** Предел длины текста поста, который идёт на разбор (знаки): дальше обычно подписи. */
const POST_TEXT_MAX_CHARS = 4_000;

/** Что нужно от запроса сотрудника: заявка и необязательный свой запрос. */
export interface TelegramSearchInput {
  requestId: string;
  query?: string | undefined;
}

/** Оценка по месту в выдаче: первый пост = 1, дальше убывает. */
function rankScore(index: number, total: number): number {
  return total <= 0 ? 0 : (total - index) / total;
}

/**
 * Запросы к каналу: названия позиций заявки (или свой запрос сотрудника), только безопасные
 * для внешнего сервиса: с ПДн и токенами замены запрос в канал не уходит.
 */
function telegramQueries(request: PurchaseRequest, input: TelegramSearchInput): string[] {
  const wanted = input.query === undefined ? request.items.map((item) => item.name) : [input.query];
  const seen = new Set<string>();
  const safe: string[] = [];
  for (const raw of wanted) {
    // Предел сервиса чтения (200 знаков): запрос ядра заведомо короче (проверка ниже строже),
    // но обрезка не даёт сервису отклонить его ответом 422 при любом изменении предела.
    const query = Array.from(raw.replace(/\s+/gu, ' ').trim())
      .slice(0, TELEGRAM_QUERY_MAX_CHARS)
      .join('');
    const key = query.toLowerCase();
    if (query === '' || seen.has(key) || externalQueryProblem(query) !== null) continue;
    seen.add(key);
    safe.push(query);
  }
  return safe.slice(0, TELEGRAM_QUERIES_MAX);
}

/** Посты по запросам без повторов, не больше `maxPosts`; сбой части запросов - в `partial`. */
async function collectPosts(
  channel: TelegramChannelDeps,
  queries: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ posts: TelegramPost[]; partial: boolean }> {
  const posts: TelegramPost[] = [];
  const seen = new Set<string>();
  let firstError: unknown;
  let failedQueries = 0;
  for (const query of queries) {
    if (posts.length >= channel.maxPosts) break;
    try {
      const found = await channel.source.search(query, channel.maxPosts, { signal });
      for (const post of found) {
        const key = `${post.channel}/${post.messageId}`;
        if (seen.has(key) || posts.length >= channel.maxPosts) continue;
        seen.add(key);
        posts.push(post);
      }
    } catch (error) {
      // Отмена хода - не сбой источника: дальше идти незачем.
      if (signal?.aborted === true) throw error;
      failedQueries += 1;
      firstError ??= error;
    }
  }
  // Ни один запрос не выполнен - источник недоступен; иначе работаем с тем, что найдено.
  if (failedQueries === queries.length && firstError !== undefined) throw firstError;
  return { posts, partial: failedQueries > 0 };
}

/** Цены поста по позициям заявки; прежняя одна цена без позиции - только для одной позиции. */
function pricesOf(
  facts: Parameters<typeof webPricesFields>[0],
  positions: readonly string[],
): MarketPriceSample[] {
  const fields = webPricesFields(facts, positions);
  const found =
    fields.webPrices ??
    (fields.webPrice === undefined || positions.length > 1 ? [] : [{ ...fields.webPrice }]);
  // Происхождение хранится у каждой цены (ревью 216): дальше цена несёт признак канала сама.
  return found.map((price) => ({ ...price, fromTelegram: true as const }));
}

/** Итог разбора одного поста: кандидат, пост без названия или сбой. */
type PostOutcome =
  | { kind: 'candidate'; candidate: SupplierCandidate; postDate: string }
  | { kind: 'dropped' }
  | { kind: 'failed' };

/**
 * Разобрать пост: модель отдаёт название, город, цены и срок по очищенному тексту, а телефон и
 * почту код достаёт из ИСХОДНОГО текста (`parseTelegramPostFacts`). Нет названия - пост
 * отбрасывается: поставщика без названия в шорт-листе быть не может.
 */
async function candidateOfPost(
  deps: OrderCalcDeps,
  channel: TelegramChannelDeps,
  post: TelegramPost,
  positions: readonly string[],
  rank: { index: number; total: number },
  signal: AbortSignal | undefined,
): Promise<PostOutcome> {
  const text = post.text.slice(0, POST_TEXT_MAX_CHARS);
  try {
    // Разобранный в этом процессе пост второй раз модели не отдаётся (ревью 216, п.6).
    const cached = channel.cache?.get(post, positions);
    const raw =
      cached ??
      (await withTimeout(
        (inner) => channel.extractor.extract({ text, items: [...positions] }, { signal: inner }),
        signal,
        EXTRACT_TIMEOUT_MS,
      ));
    if (cached === undefined) channel.cache?.set(post, positions, raw);
    // Ответа нет (пост не ушёл модели или не JSON) - не сбой, но и кандидата нет.
    const parsed = parseTelegramPostFacts(raw, text);
    if (parsed === null) return { kind: 'dropped' };
    const { name, facts } = parsed;
    const contacts = webContactsLine(facts);
    const prices = pricesOf(facts, positions);
    const details = {
      ...(facts.city === undefined ? {} : { city: facts.city }),
      ...(contacts === undefined ? {} : { contacts }),
      ...(facts.email === undefined ? {} : { email: facts.email }),
      ...(facts.leadTime === undefined ? {} : { leadTime: facts.leadTime }),
      ...(prices.length === 0 ? {} : { prices }),
    };
    const telegramFields = telegramFieldsOfCandidate(details);
    return {
      kind: 'candidate',
      postDate: post.date,
      candidate: {
        name,
        reference: telegramReference(post.channel, post.messageId),
        score: rankScore(rank.index, rank.total),
        ...details,
        ...(telegramFields.length === 0 ? {} : { telegramFields }),
      },
    };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    deps.log?.('telegram_post_failed', { code: codeOf(error) });
    return { kind: 'failed' };
  }
}

/** Код причины недоступности источника: код доменной ошибки либо «непредвиденно». */
function failureReason(error: unknown): string {
  return isDomainError(error) ? error.code : UNEXPECTED_REASON;
}

/** Решение по цене канала после проверки соответствия товара. */
interface PriceDecision {
  grade: 'exact' | 'analog';
  /** Модель проверки действительно оценила название (а не «проверять нечем»). */
  checked: boolean;
  reason: string | undefined;
}

/**
 * Проверить цены кандидатов канала: соответствие товара позиции заявки (модель проверки цен, та
 * же, что у прайсов базы) и выбросы по медиане. Цена «не тот товар» убирается; «похожий» и
 * непроверенная цена (проверяющего нет, сбой, модель пропустила название) остаются как
 * приблизительные: в среднюю и в ярус «база с подходящей ценой» они не входят. Кандидат без
 * цен остаётся (название, город, контакты).
 */
async function verifyChannelPrices(
  deps: OrderCalcDeps,
  context: ToolContext,
  request: PurchaseRequest,
  found: ReadonlyArray<{ candidate: SupplierCandidate; postDate: string }>,
): Promise<SupplierCandidate[]> {
  const positions = request.items.map((item) => item.name);
  const rowsOf = positions.map((): PriceItem[] => []);
  const refOf = new Map<PriceItem, string>();
  const keyOf = (index: number, priceIndex: number): string => `${index}:${priceIndex}`;
  for (const [index, { candidate, postDate }] of found.entries()) {
    for (const [priceIndex, price] of (candidate.prices ?? []).entries()) {
      // Цена без позиции (прежняя одна цена) относится к единственной позиции заявки.
      const group = Math.max(0, positions.indexOf(price.item ?? ''));
      const row: PriceItem = {
        supplierId: candidate.reference ?? String(index),
        productName: price.offer ?? price.item ?? positions[group] ?? '',
        price: price.amount,
        currency: price.currency,
        date: postDate,
      };
      if (row.productName === '') continue;
      rowsOf[group]?.push(row);
      refOf.set(row, keyOf(index, priceIndex));
    }
  }
  const groups: PriceRowsOfItem[] = positions.map((position, index) => {
    const requirements = requirementsForModel(
      request.items.find((item) => item.name === position)?.requirements,
    );
    return {
      position,
      ...(requirements === undefined ? {} : { requirements }),
      rows: rowsOf[index] ?? [],
    };
  });
  const decisions = new Map<string, PriceDecision>();
  const graded = await filterRelevantPrices(deps, context, groups).catch(() => null);
  for (const row of (graded ?? []).flat()) {
    const key = refOf.get(row.row);
    if (key !== undefined) {
      decisions.set(key, {
        grade: row.grade,
        checked: row.checked === true,
        reason: row.reason,
      });
    }
  }
  // Сбой самой проверки: цены остаются, но непроверенными.
  if (graded === null) {
    for (const key of refOf.values()) {
      decisions.set(key, { grade: 'exact', checked: false, reason: undefined });
    }
  }
  const settled = found.map(({ candidate }, index) =>
    (candidate.prices ?? []).flatMap((price, priceIndex): MarketPriceSample[] => {
      const decision = decisions.get(keyOf(index, priceIndex));
      if (decision === undefined) return [];
      const verified = decision.checked && decision.grade === 'exact';
      return [
        {
          ...price,
          ...(verified ? {} : { approximate: true as const }),
          ...(decision.grade === 'analog' ? { similar: true as const } : {}),
          ...(decision.reason === undefined || price.gradeReason !== undefined
            ? {}
            : { gradeReason: decision.reason }),
        },
      ];
    }),
  );
  const kept = new Set(dropPriceOutliers(settled.flat()));
  return found.map(({ candidate }, index) => {
    const { prices: _prices, telegramFields: _fields, ...rest } = candidate;
    const prices = (settled[index] ?? []).filter((price) => kept.has(price));
    const details = { ...rest, ...(prices.length === 0 ? {} : { prices }) };
    const telegramFields = telegramFieldsOfCandidate(details);
    return { ...details, ...(telegramFields.length === 0 ? {} : { telegramFields }) };
  });
}

/** Поиск по каналу: результат источника (кандидаты и, если выдача неполная, причина). */
async function findInChannel(
  deps: OrderCalcDeps,
  channel: TelegramChannelDeps,
  request: PurchaseRequest,
  input: TelegramSearchInput,
  context: ToolContext,
): Promise<SourceResult> {
  const signal = context.signal;
  const queries = telegramQueries(request, input);
  if (queries.length === 0) {
    throw new DomainError('validation_failed', 'Нет безопасного запроса для поиска по каналу.');
  }
  const { posts, partial: queriesPartial } = await collectPosts(channel, queries, signal);
  const positions = request.items.map((item) => item.name);
  const outcomes = await mapPool(posts, EXTRACT_CONCURRENCY, (post, index) =>
    candidateOfPost(deps, channel, post, positions, { index, total: posts.length }, signal),
  );
  const found = outcomes.flatMap((outcome) =>
    outcome.kind === 'candidate'
      ? [{ candidate: outcome.candidate, postDate: outcome.postDate }]
      : [],
  );
  // Цены канала проходят ту же проверку соответствия товара и отсев выбросов, что и прайсы
  // базы, прежде чем попасть в шорт-лист (ревью 216, п.2): «exact» ставит не разбор поста.
  const candidates = await verifyChannelPrices(deps, context, request, found);
  const failed = outcomes.filter((outcome) => outcome.kind === 'failed').length;
  const dropped = outcomes.filter((outcome) => outcome.kind === 'dropped').length;
  // Только счётчики: тексты постов, названия и контакты в журнал не попадают.
  deps.log?.('telegram_source', {
    queries: queries.length,
    posts: posts.length,
    candidates: candidates.length,
    dropped,
    failed,
  });
  const reason =
    failed > 0 ? TELEGRAM_SEARCH_PARTIAL_REASON : queriesPartial ? QUERIES_PARTIAL_REASON : undefined;
  return {
    source: 'telegram',
    status: 'ok',
    ...(reason === undefined ? {} : { reason }),
    candidates,
  };
}

/**
 * Опросить канал и сохранить результат источника `telegram` для сборки шорт-листа. Ничего не
 * бросает: любой сбой (канал, модель, состояние) остаётся записью «недоступен» либо журналом, а
 * поиск по базе знаний идёт как обычно. Не опрашивается при выключенном источнике (нет
 * `deps.telegramChannel`) и при узком поиске по разделу или одному поставщику: это не поиск
 * поставщиков по заявке, и перезаписывать результат канала нельзя.
 */
export async function runTelegramSource(
  deps: OrderCalcDeps,
  input: TelegramSearchInput & { section?: unknown; supplierId?: unknown },
  context: ToolContext,
): Promise<void> {
  const channel = deps.telegramChannel;
  if (channel === undefined) return;
  if (input.section !== undefined || input.supplierId !== undefined) return;
  const signal = context.signal;
  try {
    const request = await deps.requests.get(input.requestId);
    // Нет заявки - ошибку выдаст основной поиск; результат канала не пишем.
    if (request === null) return;
    let result: SourceResult;
    let budget: AbortSignal | undefined;
    try {
      // Общий бюджет времени (ревью 216, п.6): запросы к каналу, разбор постов и проверка цен
      // вместе. Не уложились - источник «недоступен» с причиной timeout, база не ждёт дольше.
      result = await withTimeout(
        (inner) => {
          budget = inner;
          return rejectOnAbort(
            findInChannel(deps, channel, request, input, { ...context, signal: inner }),
            inner,
          );
        },
        signal,
        channel.budgetMs ?? TELEGRAM_SOURCE_BUDGET_MS,
      );
    } catch (error) {
      if (signal?.aborted === true) return;
      result = {
        source: 'telegram',
        status: 'unavailable',
        reason: budget?.aborted === true ? TELEGRAM_SOURCE_BUDGET_REASON : failureReason(error),
        candidates: [],
      };
      deps.log?.('telegram_source_unavailable', { reason: result.reason ?? UNEXPECTED_REASON });
    }
    await saveSourceResult(deps, input.requestId, result);
  } catch (error) {
    deps.log?.('telegram_source_failed', { code: codeOf(error) });
  }
}

/**
 * Отказ, когда сигнал сработал, даже если сама работа его не слушает (заглушка источника или
 * модели, которая не отвечает): иначе зависший вызов держал бы ход после бюджета.
 */
function rejectOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
