import { z } from 'zod';
import { DomainError, isDomainError } from '@business-ai/core';
import {
  SUPPLIER_SOURCES,
  normalizeSupplierName,
  type SourceResult,
  type SupplierCandidate,
  type SupplierSource,
} from '../../kit/domain/shortlist';
import { isStalePrice, latestPerLine } from '../../kit/domain/latest-price';
import { leadTimeOrUndefined, priceDateNotInFuture } from '../../kit/domain/lead-time';
import {
  primaryContact,
  supplierFromCard,
  type SupplierCard,
} from '../../kit/domain/supplier-card';
import {
  productQueryWithoutPackaging,
  significantProductTokens,
  splitProductParts,
  wordStartMatches,
  wordStartShare,
} from '../../kit/domain/product-search';
import { type PriceItem, type PurchaseRequest } from '../../kit/domain/models';
import { type MarketPriceSample } from '../../kit/domain/market-price';
import type { KnowledgeScope } from '../../kit/ports/knowledge-search.owned';
import { defineTool } from '@business-ai/core';
import { KNOWLEDGE_REFERENCE_LIMIT, SOURCE_RESULT_LIMIT, type OrderCalcDeps } from './deps';
import {
  assertExternalQuery,
  externalQueryProblem,
  requirementsForModel,
  WEB_SEARCH_MAX_PER_TURN,
  webSearchLimitReason,
  mapPool,
  runAuditedWebSearch,
} from '@business-ai/core';
import { saveSourceResult } from './state';
import {
  findUnconfirmedPrice,
  formatUnconfirmedPrice,
  listProposals,
  type PriceProposal,
} from '../prices/price-proposals';
import { rateSupplierCards, type CardRating } from './supplier-rating';
import {
  enrichWebCandidates,
  markWebFields,
  planWebQueries,
  webProductName,
  type WebFound,
} from './web-enrichment';
import { refineWebHits } from './web-hits';
import { filterRelevantPrices, type GradedPriceRow } from './price-relevance';
import { runTelegramSource } from './telegram-source';

/** Код причины недоступности, если ошибка не доменная. */
const UNEXPECTED_REASON = 'unexpected';
/** Причина неполной выдачи: часть запросов пропущена из-за предела запросов за вызов. */
const QUERIES_CAPPED_REASON = 'queries_capped';

/** Сколько позиций заявки обходятся одновременно: пул соединений с БД всего из 4. */
const KNOWLEDGE_SEARCH_CONCURRENCY = 3;

/** Порядок идентификаторов по возрастанию (для устойчивой сортировки). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Код ошибки для лога: код доменной ошибки либо имя класса, без текста сообщения. */
function failureCode(error: unknown): string {
  if (isDomainError(error)) return error.code;
  return error instanceof Error ? error.name : UNEXPECTED_REASON;
}

/** Результат поиска по источнику: кандидаты и, если выдача неполная, код причины. */
interface PartialFind {
  candidates: SupplierCandidate[];
  reason: string;
}

/** Код причины недоступности источника: лимит веб-поиска назван своим кодом. */
function failureReason(error: unknown): string {
  // Исчерпанная квота Яндекса получает свой код: по нему ответ покажет одну понятную строку.
  const limit = webSearchLimitReason(error);
  if (limit !== undefined) return limit;
  return isDomainError(error) ? error.code : UNEXPECTED_REASON;
}

/** Что агент видит после поиска по источнику: счётчики и статус, без названий и контактов. */
interface SearchOutput {
  source: SupplierSource;
  status: 'ok' | 'unavailable';
  reason?: string | undefined;
  found: number;
  /** Сколько найденных поставщиков исключено из шорт-листа: у карточки «не работаем». */
  excludedInactive?: number | undefined;
  references: Array<{ documentId: string; snippet: string }>;
}

const searchOutputSchema = z.object({
  source: z.enum(SUPPLIER_SOURCES),
  status: z.enum(['ok', 'unavailable']),
  reason: z.string().optional(),
  found: z.number().int().nonnegative(),
  excludedInactive: z.number().int().positive().optional(),
  references: z.array(z.object({ documentId: z.string(), snippet: z.string() })),
});

interface SearchInput {
  requestId: string;
  /** Свой запрос вместо названий позиций заявки (например, после уточнения менеджера). */
  query?: string | undefined;
}
const searchInputSchema = z.object({
  requestId: z.string().min(1),
  query: z.string().min(1).optional(),
});

/** Раздел базы знаний, которым можно ограничить подсказки-документы. */
const KNOWLEDGE_SECTIONS = ['suppliers'] as const;

interface KnowledgeSearchInput extends SearchInput {
  /** `suppliers` - подсказки только из раздела поставщиков (файлы и заметки карточек). */
  section?: (typeof KNOWLEDGE_SECTIONS)[number] | undefined;
  /** Подсказки только из документов одного поставщика (включает раздел поставщиков). */
  supplierId?: string | undefined;
}
const knowledgeSearchInputSchema = searchInputSchema.extend({
  section: z.enum(KNOWLEDGE_SECTIONS).optional(),
  supplierId: z.string().min(1).optional(),
});

/** Область поиска подсказок; undefined - вся база знаний, как раньше. */
function knowledgeScopeOf(input: KnowledgeSearchInput): KnowledgeScope | undefined {
  if (input.supplierId !== undefined) return { supplierId: input.supplierId };
  return input.section === 'suppliers' ? { suppliersOnly: true } : undefined;
}

/** Вес оценки кандидата, найденного только по карточке: слабее, чем совпадение по прайсу. */
const CARD_MATCH_WEIGHT = 0.5;
/** Вес оценки поставщика, найденного только по документу-подсказке: слабее карточки. */
const DOCUMENT_MATCH_WEIGHT = 0.25;
/** Сколько документов раздела поставщиков берётся по каждому запросу в кандидаты. */
const DOCUMENT_CANDIDATES_PER_QUERY = 5;
/** Сколько поставщиков, найденных ТОЛЬКО по документам, попадает в результат (против шума). */
const DOCUMENT_ONLY_MAX = 5;
/** Сколько значимых слов одного запроса используется для поиска по карточкам. */
const CARD_TOKENS_PER_QUERY = 4;

/**
 * Слова запроса для поиска по карточкам: только значимые (без предлогов, упаковки и чисел),
 * в виде основ без «ё». Короткие товары («мёд», «чай», «сыр») не теряются, но ищутся по началу
 * слова (`wordStart`), а не подстрокой.
 */
function cardTokens(query: string): string[] {
  return significantProductTokens(query).slice(0, CARD_TOKENS_PER_QUERY);
}

/** Сколько значимых слов позиции должно найтись у карточки, если слово не одно. */
const CARD_MIN_MATCHED_TOKENS = 2;

/** От этой длины токен сравнивается с допуском на окончание («чайна» ~ «чайные»). */
const CARD_LOOSE_TOKEN_MIN = 4;
/** Слово карточки при таком допуске не длиннее токена больше чем на столько знаков. */
const CARD_LOOSE_EXTRA_CHARS = 1;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** Длина общего начала двух строк. */
function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

/**
 * Слово карточки соответствует токену запроса: по началу слова либо, для длинных токенов, с
 * допуском на окончание (основа «чайна» от «чайная» не начало слова «чайные»). Токены короче
 * четырёх знаков («мёд», «чай») идут только по строгому правилу, иначе «мед» нашёл бы «медаль».
 */
function cardTokenMatches(token: string, text: string): boolean {
  if (wordStartMatches(token, text)) return true;
  if (token.length < CARD_LOOSE_TOKEN_MIN) return false;
  const need = token.length - 1;
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(WORD_SPLIT)
    .some(
      (word) =>
        word.length <= token.length + CARD_LOOSE_EXTRA_CHARS &&
        commonPrefixLength(token, word) >= need,
    );
}

/**
 * Карточка подходит по товару, а не по одному слову признака (разбор 29.10: «Златоустовский
 * клинок» нашёлся на «ароматическая свеча» по слову «ароматический», РЧК - на «чайная пара»).
 * Подходит, если все значимые слова фразы (название позиции или короткий запрос) есть в названии
 * или категориях карточки - «категория/название целиком», либо в названии, категориях и брендах
 * совпало не меньше двух значимых слов позиции. Позиция из одного слова ищется по этому слову.
 */
function cardMatchesProduct(card: SupplierCard, phrases: readonly string[]): boolean {
  const title = [card.name, ...card.supplies.categories].join(' ');
  const whole = [title, ...card.supplies.brands].join(' ');
  return phrases.some((phrase) => {
    const tokens = significantProductTokens(phrase);
    if (tokens.length === 0) return false;
    if (tokens.every((token) => cardTokenMatches(token, title))) return true;
    const matched = tokens.filter((token) => cardTokenMatches(token, whole)).length;
    return matched >= Math.min(CARD_MIN_MATCHED_TOKENS, tokens.length);
  });
}

/**
 * Карточки, подходящие запросу: по названию (весь запрос и его слова), категории и бренду
 * (слова запроса) и по коротким запросам модели. Найденное отсеивается `cardMatchesProduct`:
 * поиск по одному слову приносит карточки, у которых это слово - лишь признак. Региона в
 * условиях `searchCards` нет, поэтому по региону поиска нет.
 */
async function findCards(
  deps: OrderCalcDeps,
  query: string,
  shortQueries: readonly string[] = [],
): Promise<Map<string, SupplierCard>> {
  const limit = SOURCE_RESULT_LIMIT;
  const calls: Array<Promise<SupplierCard[]>> = [deps.suppliers.searchCards({ query, limit })];
  for (const token of cardTokens(query)) {
    calls.push(deps.suppliers.searchCards({ category: token, wordStart: true, limit }));
    calls.push(deps.suppliers.searchCards({ brand: token, wordStart: true, limit }));
    calls.push(deps.suppliers.searchCards({ query: token, wordStart: true, limit }));
  }
  for (const short of shortQueries) {
    calls.push(deps.suppliers.searchCards({ query: short, limit }));
    calls.push(deps.suppliers.searchCards({ category: short, limit }));
  }
  const phrases = [query, ...shortQueries];
  const found = new Map<string, SupplierCard>();
  for (const card of (await Promise.all(calls)).flat()) {
    if (cardMatchesProduct(card, phrases)) found.set(card.id, card);
  }
  return found;
}

/** Самая длинная специализация поставщика, сохраняемая в кандидате (знаки). */
const SPECIALIZATION_MAX_CHARS = 300;

/** Чем занимается поставщик: категории и бренды карточки одной строкой; пусто - undefined. */
function specializationOf(card: SupplierCard): string | undefined {
  const text = [...card.supplies.categories, ...card.supplies.brands].join(', ').trim();
  return text === '' ? undefined : Array.from(text).slice(0, SPECIALIZATION_MAX_CHARS).join('');
}

/**
 * Краткая строка контактов основного контакта карточки: ФИО, телефон, email - только то, что
 * записано в карточке, без домыслов. Нет ни одного сведения - undefined.
 */
function contactsLine(card: SupplierCard): string | undefined {
  const main = primaryContact(card.contacts);
  if (main === undefined) return undefined;
  const parts = [main.fullName, main.phone, main.email].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * Кандидат из карточки: адрес основного контакта (иначе первого с адресом), статус, а также
 * сведения для строки шорт-листа: место, контакты, срок, рейтинг (оценка модели по фактам
 * карточки либо запасное правило; считается до вызова) и цены поставщика из прайса.
 */
export function candidateOfCard(
  card: SupplierCard,
  score: number,
  rating: CardRating,
  prices: readonly MarketPriceSample[] = [],
  reference: string | undefined,
  now: Date,
): SupplierCandidate {
  const email = supplierFromCard(card).email;
  const contacts = contactsLine(card);
  const specialization = specializationOf(card);
  // Срок в карточке - свободный текст: заметка про другой товар сроком не показывается.
  const leadTime = leadTimeOrUndefined(card.terms.leadTime, now);
  return {
    name: card.name,
    supplierId: card.id,
    email,
    status: card.status,
    score,
    // Документ-подсказка, по которому найден поставщик: id документа, без текста.
    ...(reference === undefined ? {} : { reference }),
    ...(card.productionCity === undefined ? {} : { city: card.productionCity }),
    ...(card.address === undefined ? {} : { address: card.address }),
    ...(contacts === undefined ? {} : { contacts }),
    ...(leadTime === undefined ? {} : { leadTime }),
    ...(card.website === undefined ? {} : { website: card.website }),
    ...(specialization === undefined ? {} : { specialization }),
    ...(prices.length === 0 ? {} : { prices: [...prices] }),
    rating: rating.value,
    // Пометка нужна только оценке модели; по правилу её нет (так считались и прежние записи).
    ...(rating.source === 'model' ? { ratingSource: rating.source } : {}),
    ...(rating.rationale === undefined ? {} : { ratingRationale: rating.rationale }),
  };
}

/** Поставщики из прайса по одному запросу: позиции и доля совпавших слов у каждого. */
interface PriceFind {
  items: PriceItem[];
  /** Доля слов запроса (0..1), совпавшая в лучшей позиции поставщика; у строгого поиска 1. */
  share: Map<string, number>;
  /** Позиции, найденные ослабленным поиском не по всем значимым словам (доля < 1). */
  approximate: ReadonlySet<PriceItem>;
  /** Позиции, которые модель признала близким, но не тем же товаром (`analog`), и причина. */
  analogs: ReadonlyMap<PriceItem, string | undefined>;
  /** Причина оценки модели по позиции (для ранжирования); у запасного поиска её нет. */
  reasons: ReadonlyMap<PriceItem, string>;
}

/** Сколько строк прайсов берётся на позицию заявки до проверки моделью. */
const PRICE_ROWS_PER_ITEM = 100;

/** Поиск по прайсам для одной позиции: строки гибридного поиска либо запасной результат. */
interface PriceSearch {
  /** Строки гибридного поиска в порядке убывания близости (ещё не проверены моделью). */
  ranked: PriceItem[];
  /** Запасной результат, когда гибридный поиск ничего не нашёл. */
  fallback: PriceFind;
}

/** Ключ строки прайса для склейки одинаковых строк из разных частей позиции. */
function priceRowKey(item: PriceItem): string {
  const parts = [item.supplierId, item.productName, item.sku ?? '', item.price, item.currency];
  return parts.join('\u0000');
}

/** Место оценки при выборе строки поставщика: точный товар раньше близкого. */
function gradeRank(grade: GradedPriceRow['grade']): number {
  return grade === 'exact' ? 0 : 1;
}

/**
 * Лучшая строка каждого поставщика в каждой валюте: по оценке (`exact` раньше `analog`), затем
 * дешевле; при равенстве - выше в выдаче. Прежнее «самая дешёвая из подходящих» ставило на
 * первое место самую непохожую строку (аккумулятор 2500 мА·ч за 229 ₽ при заявке на 10000).
 * Порядок поставщиков - по месту внутри валюты (точные раньше близких): USD и RUB по числу цены
 * не сравниваются, лимит режет поставщиков, а не строки.
 */
function bestPerSupplier(rows: readonly GradedPriceRow[], limit: number): GradedPriceRow[] {
  const best = new Map<string, GradedPriceRow>();
  // Этап 161: прежде чем выбирать лучшую позицию поставщика, по каждой позиции остаётся строка
  // самого свежего прайса. Иначе старая дешёвая строка выигрывала у актуальной цены того же
  // товара (Политехнология: 79 ₽ от 31.03.2025 вместо 81,37 ₽ от 03.10.2025). Цена, лестница
  // тиражей и диапазон берутся из одной строки, поэтому не смешиваются.
  for (const graded of latestPerLine(rows, ({ row }) => row)) {
    const key = `${graded.row.supplierId}\u0000${graded.row.currency}`;
    const current = best.get(key);
    if (
      current === undefined ||
      gradeRank(graded.grade) < gradeRank(current.grade) ||
      (graded.grade === current.grade && graded.row.price < current.row.price)
    ) {
      best.set(key, graded);
    }
  }
  const byCurrency = new Map<string, GradedPriceRow[]>();
  for (const graded of best.values()) {
    const list = byCurrency.get(graded.row.currency) ?? [];
    list.push(graded);
    byCurrency.set(graded.row.currency, list);
  }
  const placed: Array<{ place: number; graded: GradedPriceRow }> = [];
  for (const list of byCurrency.values()) {
    list.sort(
      (a, b) =>
        gradeRank(a.grade) - gradeRank(b.grade) ||
        a.row.price - b.row.price ||
        compareIds(a.row.supplierId, b.row.supplierId),
    );
    list.forEach((graded, place) => placed.push({ place, graded }));
  }
  placed.sort(
    (a, b) =>
      a.place - b.place ||
      compareIds(a.graded.row.currency, b.graded.row.currency) ||
      compareIds(a.graded.row.supplierId, b.graded.row.supplierId),
  );
  return placed.slice(0, limit).map(({ graded }) => graded);
}

/**
 * Первый шаг поиска по прайсам для позиции заявки (этап 121). Из позиции убирается уточнение о
 * таре («мёд в стеклянных банках» - товар «мёд»), несколько товаров («мёд и орехи») ищутся по
 * отдельности. Гибридный поиск (слова, начало слова, смысл) отдаёт строки; проверка моделью и
 * выбор лучшей строки поставщика - вторым шагом (`settlePrices`). Нашлось пусто - запасной
 * ослабленный поиск по значимым словам, каждому по началу слова (не подстрокой).
 */
async function searchPrices(
  deps: OrderCalcDeps,
  query: string,
  shortQueries: readonly string[] = [],
): Promise<PriceSearch> {
  const parts = splitProductParts(productQueryWithoutPackaging(query));
  const seen = new Set<string>();
  const ranked: PriceItem[] = [];
  // Короткие запросы модели - добавка к полному названию: длинное название в векторном поиске
  // даёт лишь часть поставщиков. Объединение строк по ключу; заявки без запросов идут как прежде.
  for (const part of [...parts, ...shortQueries]) {
    for (const item of await deps.prices.searchRankedProducts(part, PRICE_ROWS_PER_ITEM)) {
      const key = priceRowKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push(item);
    }
  }
  if (ranked.length > 0) return { ranked, fallback: emptyPriceFind() };
  return { ranked, fallback: await findPricesByWordStart(deps, query) };
}

function emptyPriceFind(): PriceFind {
  return {
    items: [],
    share: new Map(),
    approximate: new Set(),
    analogs: new Map(),
    reasons: new Map(),
  };
}

/** Итог поиска: оценённые строки гибридного поиска либо запасной результат. */
function settlePrices(search: PriceSearch, graded: readonly GradedPriceRow[]): PriceFind {
  if (search.ranked.length === 0) return search.fallback;
  const best = bestPerSupplier(graded, SOURCE_RESULT_LIMIT);
  const items = best.map(({ row }) => row);
  const analogs = new Map(
    best.filter(({ grade }) => grade === 'analog').map(({ row, reason }) => [row, reason]),
  );
  const reasons = new Map(
    best.flatMap(({ row, reason }) => (reason === undefined ? [] : [[row, reason] as const])),
  );
  return {
    items,
    share: new Map(items.map((item) => [item.supplierId, 1])),
    // Близкий товар помечается приблизительной ценой: в среднюю по базе он не входит.
    approximate: new Set(analogs.keys()),
    analogs,
    reasons,
  };
}

/**
 * Запасной ослабленный поиск: значимые слова-товар без предлогов и упаковки, каждое по началу
 * слова, поставщик ранжируется по доле совпавших слов. Нет ни одного значимого слова - пусто
 * (не «всё подряд»).
 */
async function findPricesByWordStart(deps: OrderCalcDeps, query: string): Promise<PriceFind> {
  const tokens = significantProductTokens(query);
  if (tokens.length === 0) return emptyPriceFind();
  // Лучшая позиция поставщика в каждой валюте: больше совпавших слов, при равенстве - дешевле.
  const best = new Map<string, { item: PriceItem; share: number }>();
  for (const token of tokens) {
    const rows = await deps.prices.searchSuppliersByProduct(token, SOURCE_RESULT_LIMIT, {
      wordStart: true,
    });
    for (const item of rows) {
      const share = wordStartShare(tokens, item.productName, item.sku);
      const key = `${item.supplierId}\u0000${item.currency}`;
      const current = best.get(key);
      if (
        current === undefined ||
        share > current.share ||
        (share === current.share && item.price < current.item.price)
      ) {
        best.set(key, { item, share });
      }
    }
  }
  const ranked = [...best.values()].sort(
    (a, b) =>
      b.share - a.share ||
      a.item.price - b.item.price ||
      compareIds(a.item.supplierId, b.item.supplierId),
  );
  const share = new Map<string, number>();
  for (const entry of ranked) {
    share.set(entry.item.supplierId, Math.max(share.get(entry.item.supplierId) ?? 0, entry.share));
  }
  // Лимит режет поставщиков, а не позиции: как у строгого поиска.
  const suppliers = new Set([...share.keys()].slice(0, SOURCE_RESULT_LIMIT));
  const kept = ranked.filter((entry) => suppliers.has(entry.item.supplierId));
  return {
    items: kept.map((entry) => entry.item),
    share: new Map([...share].filter(([id]) => suppliers.has(id))),
    // Неполное совпадение: цена возможно другого товара, в «среднюю по базе» её не берём.
    approximate: new Set(kept.filter((entry) => entry.share < 1).map((entry) => entry.item)),
    analogs: new Map(),
    reasons: new Map(),
  };
}

/**
 * Документы из выдачи подсказок, однозначно привязанные к поставщику: id документа -> id
 * поставщика. Порт без `supplierIdsOf` (старые заглушки) - пусто. Отдельного поиска нет: те же
 * результаты, что и подсказки, иначе удвоились бы вызовы эмбеддера и гибридного поиска.
 */
async function supplierIdsOfHits(
  deps: OrderCalcDeps,
  hits: ReadonlyArray<{ documentId: string }>,
): Promise<Map<string, string>> {
  if (deps.knowledge.supplierIdsOf === undefined || hits.length === 0) return new Map();
  return deps.knowledge.supplierIdsOf(hits.map((hit) => hit.documentId));
}

/** Черновик кандидата из карточки до оценки модели (см. `searchKnowledgeSuppliers`). */
interface CardDraft {
  card: SupplierCard;
  score: number;
  prices?: MarketPriceSample[] | undefined;
  reference?: string | undefined;
}

/** Ключ цены для склейки одинаковых цен дублей карточки. */
function samplePriceKey(price: MarketPriceSample): string {
  return JSON.stringify([price.item, price.offer, price.amount, price.currency, price.unit]);
}

/**
 * Склеить дубли карточек одного поставщика (More Choice ×2, Рубин ×2): одно название после
 * нормализации - один кандидат. Остаётся черновик с большим числом цен, затем с лучшей оценкой;
 * цены и документ-подсказка дополняются у второго. Статус «не работаем» у любого из дублей
 * сохраняется: исключённый поставщик не должен вернуться через дубль.
 */
function mergeDuplicateDrafts(drafts: readonly CardDraft[]): CardDraft[] {
  const result: CardDraft[] = [];
  const byName = new Map<string, number>();
  for (const draft of drafts) {
    const key = normalizeSupplierName(draft.card.name);
    const at = key === '' ? undefined : byName.get(key);
    const kept = at === undefined ? undefined : result[at];
    if (at === undefined || kept === undefined) {
      if (key !== '') byName.set(key, result.length);
      result.push({ ...draft });
      continue;
    }
    const draftWins =
      (draft.prices?.length ?? 0) > (kept.prices?.length ?? 0) ||
      ((draft.prices?.length ?? 0) === (kept.prices?.length ?? 0) && draft.score > kept.score);
    const winner = draftWins ? { ...draft } : kept;
    const other = draftWins ? kept : draft;
    const prices = new Map<string, MarketPriceSample>();
    for (const price of [...(winner.prices ?? []), ...(other.prices ?? [])]) {
      if (!prices.has(samplePriceKey(price))) prices.set(samplePriceKey(price), price);
    }
    winner.prices = prices.size === 0 ? undefined : [...prices.values()];
    winner.score = Math.max(winner.score, other.score);
    winner.reference ??= other.reference;
    if (other.card.status === 'inactive' && winner.card.status !== 'inactive') {
      winner.card = { ...winner.card, status: 'inactive' };
    }
    result[at] = winner;
  }
  return result;
}

/** Короткие запросы позиции заявки с таким названием; нет позиции или запросов - пусто. */
function shortQueriesForItem(request: PurchaseRequest, name: string): readonly string[] {
  const wanted = name.trim().toLowerCase();
  const item = request.items.find((entry) => entry.name.trim().toLowerCase() === wanted);
  return item?.searchQueries ?? [];
}

/** Требования позиции по её названию (запрос поиска совпадает с названием позиции заявки). */
function requirementsForItem(request: PurchaseRequest, name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  const item = request.items.find((entry) => entry.name.trim().toLowerCase() === wanted);
  return requirementsForModel(item?.requirements);
}

/** Запросы поиска: переданный агентом либо названия позиций заявки. */
function queriesOf(request: PurchaseRequest, input: SearchInput): string[] {
  const queries =
    input.query === undefined ? request.items.map((item) => item.name) : [input.query];
  // Пустой запрос совпал бы со всем прайсом и записал в кандидаты всех поставщиков (R4-ALG-5).
  return queries.filter((query) => query.trim() !== '');
}

/**
 * Запросы во ВНЕШНИЕ сервисы (веб): 1-3 запроса модели, прошедшие проверку кода (длина, нет
 * ПДн и токенов), а без модели - названия позиций заявки без ПДн (R3-SEC-3). Свой `query`
 * принимается, только если он совпадает с названием позиции заявки и сам чист; иначе вызов
 * отклоняется. Позиции с подозрительным названием пропускаются.
 */
async function externalQueriesOf(
  request: PurchaseRequest,
  input: SearchInput,
  deps: OrderCalcDeps,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (input.query !== undefined) {
    assertExternalQuery(input.query);
    const wanted = input.query.trim().toLowerCase();
    const known = request.items.some((item) => item.name.trim().toLowerCase() === wanted);
    if (!known) {
      throw new DomainError(
        'validation_failed',
        'Запрос во внешний поиск должен совпадать с названием позиции заявки.',
      );
    }
    return [input.query];
  }
  // Запросы строит модель по заявке и полям формы, код их проверил (ТЗ, разд. 3). Нет
  // составителя, сбой или ни один запрос не прошёл проверку - прежние названия позиций.
  const planned = await planWebQueries(deps, request, signal);
  if (planned !== null) return planned;
  const names = request.items.map((item) => item.name);
  return names.filter((name) => externalQueryProblem(name) === null);
}

/** Оценка по месту в выдаче: первый результат = 1, дальше убывает. */
function rankScore(index: number, total: number): number {
  return total <= 0 ? 0 : (total - index) / total;
}

async function loadRequest(deps: OrderCalcDeps, requestId: string): Promise<PurchaseRequest> {
  const request = await deps.requests.get(requestId);
  if (request === null) throw new DomainError('not_found', `Заявка ${requestId} не найдена.`);
  return request;
}

/**
 * Выполнить поиск по одному источнику независимо от остальных: сбой источника не бросается,
 * а записывается как «недоступен» (в шорт-лист пойдёт пометка). Результат сохраняется в
 * состоянии, чтобы кандидаты не гонялись через модель.
 */
async function searchSource(
  source: SupplierSource,
  input: SearchInput,
  deps: OrderCalcDeps,
  find: (
    queries: string[],
    request: PurchaseRequest,
  ) => Promise<SupplierCandidate[] | PartialFind>,
  references: () => SearchOutput['references'] = () => [],
  external = false,
  signal?: AbortSignal | undefined,
): Promise<SearchOutput> {
  const request = await loadRequest(deps, input.requestId);
  if (input.query !== undefined && input.query.trim() === '') {
    throw new DomainError('validation_failed', 'Поисковый запрос пуст: укажите название позиции.');
  }
  // Небезопасный запрос во внешний сервис отклоняется до любых обращений наружу.
  const queries = external
    ? await externalQueriesOf(request, input, deps, signal)
    : queriesOf(request, input);
  let result: SourceResult;
  try {
    if (external && queries.length === 0) {
      throw new DomainError('validation_failed', 'Нет безопасного запроса для внешнего поиска.');
    }
    const found = await find(queries, request);
    result = Array.isArray(found)
      ? { source, status: 'ok', candidates: found }
      : { source, status: 'ok', reason: found.reason, candidates: found.candidates };
  } catch (error) {
    const reason = failureReason(error);
    result = { source, status: 'unavailable', reason, candidates: [] };
  }
  await saveSourceResult(deps, input.requestId, result);
  const excludedInactive = result.candidates.filter((c) => c.status === 'inactive').length;
  return {
    source,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    found: result.candidates.length - excludedInactive,
    ...(excludedInactive === 0 ? {} : { excludedInactive }),
    references: references(),
  };
}

/**
 * Поиск в базе знаний: поставщики, у которых в прайсах есть позиции заявки (оценка — доля
 * покрытых позиций), поставщики с карточкой по названию, категории и бренду (оценка вдвое
 * слабее) и документы базы знаний как подсказки. Поставщик со статусом «не работаем»
 * сохраняется в результате с этим статусом (шорт-лист его исключит), в ответе - счётчик.
 */
export const searchKnowledgeSuppliers = defineTool<
  KnowledgeSearchInput,
  SearchOutput,
  OrderCalcDeps
>({
  name: 'searchKnowledgeSuppliers',
  description:
    'Найти поставщиков в базе знаний по позициям заявки requestId (или по своему query): по ' +
    'прайсам и по карточкам (название, категории, бренды). Результат сохраняется; ' +
    'возвращаются статус, число найденных (поставщики «не работаем» не считаются, их число ' +
    'в excludedInactive) и документы-подсказки. section=suppliers или supplierId ограничивают ' +
    'подсказки разделом поставщиков / одним поставщиком.',
  inputSchema: knowledgeSearchInputSchema,
  outputSchema: searchOutputSchema,
  async execute(input, deps, context) {
    const hints = new Map<string, string>();
    // Закрытый Telegram-канал опрашивается параллельно с базой (этап 216) и пишет свою запись
    // источника; сбой канала не бросается и поиск по базе не затрагивает. Источник выключен -
    // runTelegramSource ничего не делает, и поведение поиска прежнее.
    const telegram = runTelegramSource(deps, input, context);
    const knowledge = searchSource(
      'knowledge',
      input,
      deps,
      async (queries, request) => {
        if (queries.length === 0) {
          throw new DomainError('validation_failed', 'Нет непустого запроса для поиска.');
        }
        const shortQueriesOf = (query: string): readonly string[] =>
          shortQueriesForItem(request, query);
        // Поставщик -> позиция заявки -> доля совпавших слов (1 у строгого совпадения).
        const covered = new Map<string, Map<string, number>>();
        // Цены прайса по поставщикам и позициям заявки (для строки шорт-листа и среднего).
        const pricesOf = new Map<string, MarketPriceSample[]>();
        const cardsMatched = new Map<string, { card: SupplierCard; queries: Set<string> }>();
        const scope = knowledgeScopeOf(input);
        // Подсказок в выдаче максимум KNOWLEDGE_REFERENCE_LIMIT, поэтому гибридный поиск по
        // следующим позициям после них впустую. Пропуск разрешён, только когда все ПРЕДЫДУЩИЕ
        // позиции уже отработали и дали достаточно подсказок: так выбор подсказок не зависит
        // от того, какая из параллельных задач закончилась раньше.
        const hintsOf: Array<Array<{ documentId: string; snippet: string }> | undefined> = [];
        const enoughHintsBefore = (index: number): boolean => {
          const ids = new Set<string>();
          for (let i = 0; i < index; i += 1) {
            const earlier = hintsOf[i];
            if (earlier === undefined) return false;
            for (const hit of earlier) ids.add(hit.documentId);
          }
          return ids.size >= KNOWLEDGE_REFERENCE_LIMIT;
        };
        // Пул БД мал (4 соединения), поэтому позиции обходятся небольшим пулом, не разом.
        const perQuery = await mapPool(
          queries,
          KNOWLEDGE_SEARCH_CONCURRENCY,
          async (query, index) => {
            let hits: Array<{ documentId: string; snippet: string }> = [];
            if (!enoughHintsBefore(index)) {
              // Берём с запасом: подсказок моделям по-прежнему не больше KNOWLEDGE_REFERENCE_LIMIT,
              // а из остальных документов раздела поставщиков получаются кандидаты.
              hits =
                scope === undefined
                  ? await deps.knowledge.search(query, DOCUMENT_CANDIDATES_PER_QUERY)
                  : await deps.knowledge.search(query, DOCUMENT_CANDIDATES_PER_QUERY, scope);
            }
            hintsOf[index] = hits.slice(0, KNOWLEDGE_REFERENCE_LIMIT);
            const priceSearch = await searchPrices(deps, query, shortQueriesOf(query));
            // Карточки - дополнительный источник: сбой не должен убрать результаты по прайсам.
            const shorts = shortQueriesOf(query);
            const cards = await findCards(deps, query, shorts).catch((error: unknown) => {
              deps.log?.('order_calc_card_search_failed', {
                code: failureCode(error),
              });
              return new Map<string, SupplierCard>();
            });
            const documents = await supplierIdsOfHits(deps, hits).catch(
              (error: unknown) => {
                // Документы - дополнительный источник: сбой не убирает остальные результаты.
                deps.log?.('order_calc_document_search_failed', { code: failureCode(error) });
                return new Map<string, string>();
              },
            );
            return { query, priceSearch, cards, documents };
          },
        );
        // Одна проверка моделью на всю сборку: какие найденные строки - тот же товар.
        const relevant = await filterRelevantPrices(
          deps,
          context,
          perQuery.map((found) => {
            const requirements = requirementsForItem(request, found.query);
            return {
              position: found.query,
              ...(requirements === undefined ? {} : { requirements }),
              rows: found.priceSearch.ranked,
            };
          }),
        );
        const settled = perQuery.map((found, index) => ({
          ...found,
          ...settlePrices(found.priceSearch, relevant[index] ?? []),
        }));
        // Неподтверждённые предложения цен (не с диска) по поставщику: только справка.
        const proposalsOf = new Map<string, PriceProposal[]>();
        for (const { items: prices } of settled) {
          for (const price of prices) {
            if (proposalsOf.has(price.supplierId)) continue;
            proposalsOf.set(price.supplierId, await listProposals(deps.state, price.supplierId));
          }
        }
        // Слияние строго в порядке позиций заявки: результат не зависит от гонки задач.
        // Поставщик -> позиции заявки и документ-подсказка (первый по порядку позиций).
        const documentsOf = new Map<string, { queries: Set<string>; documentId: string }>();
        for (const [index, found] of settled.entries()) {
          const {
            query,
            items: prices,
            share,
            approximate,
            analogs,
            reasons,
            cards,
            documents,
          } = found;
          for (const [documentId, supplierId] of documents) {
            const entry = documentsOf.get(supplierId) ?? { queries: new Set(), documentId };
            entry.queries.add(query);
            documentsOf.set(supplierId, entry);
          }
          for (const price of prices) {
            const set = covered.get(price.supplierId) ?? new Map<string, number>();
            set.set(query, share.get(price.supplierId) ?? 1);
            covered.set(price.supplierId, set);
            const own = pricesOf.get(price.supplierId) ?? [];
            const ref = findUnconfirmedPrice(proposalsOf.get(price.supplierId) ?? [], price);
            own.push({
              item: query,
              // Товар, как он назван в прайсе: показывается вместо позиции заявки
              offer: price.productName,
              amount: price.price,
              currency: price.currency,
              ...(price.priceTiers === undefined ? {} : { tiers: price.priceTiers }),
              ...(price.priceTierBasis === undefined ? {} : { tierBasis: price.priceTierBasis }),
              ...(price.priceVat === undefined ? {} : { vat: price.priceVat }),
              ...(price.priceQualifier === undefined ? {} : { qualifier: price.priceQualifier }),
              ...(price.priceMax === undefined ? {} : { max: price.priceMax }),
              // Дата прайса из будущего (ошибка разбора) не показывается как «прайс от ...».
              ...(priceDateNotInFuture(price.date, deps.clock.now()) === undefined
                ? {}
                : { priceDate: price.date }),
              ...(isStalePrice(price.date, deps.clock.now()) ? { priceStale: true as const } : {}),
              ...(approximate.has(price) ? { approximate: true as const } : {}),
              // Пометка «похожий товар» - только у оценки модели `analog`, не у запасного поиска.
              ...(analogs.has(price) ? { similar: true as const } : {}),
              ...(reasons.has(price) ? { gradeReason: reasons.get(price) } : {}),
              ...(ref === null ? {} : { unconfirmed: formatUnconfirmedPrice(ref) }),
            });
            pricesOf.set(price.supplierId, own);
          }
          for (const hit of hintsOf[index] ?? []) {
            if (!hints.has(hit.documentId)) hints.set(hit.documentId, hit.snippet);
          }
          for (const [cardId, card] of cards) {
            const entry = cardsMatched.get(cardId) ?? {
              card,
              queries: new Set<string>(),
            };
            entry.queries.add(query);
            cardsMatched.set(cardId, entry);
          }
        }
        const documentSuppliers = [...documentsOf.keys()].filter(
          (id) => !covered.has(id) && !cardsMatched.has(id),
        );
        const priceCards = new Map(
          (await deps.suppliers.getCards([...covered.keys(), ...documentSuppliers])).map((card) => [
            card.id,
            card,
          ]),
        );
        // Кандидаты из карточек без оценки: сначала поставщики с ценами прайса, затем
        // поставщики только с карточкой (слабее, чем покрытие позиций прайсом).
        const rawDrafts: CardDraft[] = [];
        const added = new Set<string>();
        for (const [supplierId, matched] of covered) {
          const card = priceCards.get(supplierId);
          if (card === undefined) continue;
          const cardScore = (cardsMatched.get(supplierId)?.queries.size ?? 0) / queries.length;
          const priceScore = [...matched.values()].reduce((sum, v) => sum + v, 0) / queries.length;
          rawDrafts.push({
            card,
            score: Math.max(priceScore, cardScore * CARD_MATCH_WEIGHT),
            prices: pricesOf.get(supplierId),
            reference: documentsOf.get(supplierId)?.documentId,
          });
          added.add(supplierId);
        }
        for (const [supplierId, { card, queries: matched }] of cardsMatched) {
          if (added.has(supplierId)) continue;
          rawDrafts.push({
            card,
            score: (matched.size / queries.length) * CARD_MATCH_WEIGHT,
            reference: documentsOf.get(supplierId)?.documentId,
          });
          added.add(supplierId);
        }
        // Поставщики, найденные только по документу (прайс, презентация из его папки): слабее
        // карточки, с id документа в ссылке; их число ограничено, чтобы не шуметь.
        let documentOnly = 0;
        for (const [supplierId, { queries: matched, documentId }] of documentsOf) {
          if (added.has(supplierId) || documentOnly >= DOCUMENT_ONLY_MAX) continue;
          const card = priceCards.get(supplierId);
          if (card === undefined) continue;
          documentOnly += 1;
          rawDrafts.push({
            card,
            score: (matched.size / queries.length) * DOCUMENT_MATCH_WEIGHT,
            reference: documentId,
          });
          added.add(supplierId);
        }
        const drafts = mergeDuplicateDrafts(rawDrafts);
        // Вызовы модели идут сначала самым релевантным (при равенстве - по id): так выбор
        // не зависит от порядка обхода и лимит достаётся тем, кто чаще попадёт в шорт-лист.
        const byPriority = [...drafts].sort(
          (a, b) => b.score - a.score || compareIds(a.card.id, b.card.id),
        );
        const ratings = await rateSupplierCards(
          deps,
          byPriority.map((draft) => draft.card),
        );
        const candidates: SupplierCandidate[] = drafts.map((draft) =>
          candidateOfCard(
            draft.card,
            draft.score,
            ratings.get(draft.card.id) ?? { value: null },
            draft.prices,
            draft.reference,
            deps.clock.now(),
          ),
        );
        return candidates;
      },
      () => [...hints].slice(0, KNOWLEDGE_REFERENCE_LIMIT).map(([documentId, snippet]) => ({
        documentId,
        snippet,
      })),
    );
    try {
      return await knowledge;
    } finally {
      await telegram;
    }
  },
});

/** Веб-поиск: один сайт = один кандидат (название компании), адреса страниц — ссылки. */
export const searchWeb = defineTool<SearchInput, SearchOutput, OrderCalcDeps>({
  name: 'searchWeb',
  description:
    'Найти поставщиков на сайтах по заявке requestId. Запросы строит модель по позициям и ' +
    'полям формы, код их проверяет (без модели - названия позиций); кандидаты обогащаются ' +
    'городом, контактами, ценой и сроком со страницы. query допустим только как точное ' +
    'название позиции заявки. ' +
    'Если источник недоступен, статус unavailable; остальные источники это не затрагивает.',
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  async execute(input, deps, context) {
    return searchSource(
      'web',
      input,
      deps,
      async (queries, request) => {
        const found: WebFound[] = [];
        // Каждый запрос списывается отдельно: число обращений наружу равно числу списаний,
        // и заявка из 40 позиций не обходит лимит одним вызовом. Запросов за вызов не больше
        // WEB_SEARCH_MAX_PER_TURN (бюджет хода); лишние пропускаются, первые остаются.
        // Исчерпанный лимит посреди вызова не отбрасывает уже найденное: источник остаётся
        // `ok` с кодом причины `rate_limited`/`queries_capped` (без ПДн), а если не прошёл
        // даже первый запрос - обычный `unavailable: rate_limited` из catch выше.
        const planned = queries.slice(0, WEB_SEARCH_MAX_PER_TURN);
        let partialReason: string | undefined =
          planned.length < queries.length ? QUERIES_CAPPED_REASON : undefined;
        for (const query of planned) {
          let hits: Awaited<ReturnType<typeof runAuditedWebSearch>>['hits'];
          try {
            // Лимитер и аудит платного поиска - общие с searchInternet.
            ({ hits } = await runAuditedWebSearch(deps, context, query, {
              limit: SOURCE_RESULT_LIMIT,
            }));
          } catch (error) {
            const limitReason = webSearchLimitReason(error);
            if (limitReason === undefined || found.length === 0) throw error;
            partialReason = limitReason;
            break;
          }
          hits.forEach((hit, index) => {
            if (hit.title.trim() === '') return;
            found.push({
              candidate: {
                name: hit.title,
                reference: hit.url,
                score: rankScore(index, hits.length),
              },
              hit,
            });
          });
        }
        // Хиты -> компании: отсев площадок и тары, склейка по сайту, название компании.
        const refined = await refineWebHits(deps, context, request, found);
        // Город, контакты, цена и срок со страницы лучших кандидатов (ТЗ, разд. 4); прочие
        // ссылки сайтов добавляются после, чтобы не занимать места обогащения.
        const candidates = [
          ...(await enrichWebCandidates(
            deps,
            context,
            refined.primary,
            request.items.map((item) => item.name),
            request.items.flatMap((item) => {
              const requirements = requirementsForModel(item.requirements);
              return requirements === undefined ? [] : [{ name: item.name, requirements }];
            }),
          )),
          ...refined.extras,
        ].map(markWebFields);
        if (partialReason !== undefined) return { candidates, reason: partialReason };
        return candidates;
      },
      undefined,
      true,
      context.signal,
    );
  },
});
