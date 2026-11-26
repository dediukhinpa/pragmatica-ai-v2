import { z } from 'zod';
import {
  DomainError,
  WEB_SEARCH_MAX_RESULTS,
  defineTool,
  externalQueryProblem,
  mapPool,
  requirementsForModel,
  runAuditedWebSearch,
  stableHash,
  turnPredecessor,
  webSearchLimitReason,
} from '@business-ai/core';
import type { ToolContext, WebSearchHit } from '@business-ai/core';
import { EXTERNAL_SUPPLIER_PREFIX, type OrderCalcDeps } from './agents/order-calc/deps';
import { enrichShownSuppliers } from './agents/order-calc/supplier-enrich';
import { checkShownSites } from './agents/order-calc/site-check';
import { withPriceNotes } from './kit/domain/shortlist-price-note';
import { knowledgeSearch } from './agents/order-calc/search-sources';
import { loadChoiceConfirmation, saveChoiceAsk } from './agents/order-calc/choice-confirmation';
import { findCard } from './agents/order-calc/named-suppliers';
import { assertOrderOwner } from './agents/order-calc/order-access';
import { requestLabel } from './agents/order-calc/request-title';
import { orderShortlistPool } from './agents/order-calc/shortlist-compare';
import {
  entryCardBlocks,
  entryLines,
  shortlistTitleLines,
} from './agents/order-calc/shortlist-message';
import {
  loadCompleteness,
  loadProposal,
  loadSourceResult,
  saveProposal,
} from './agents/order-calc/state';
import { refineWebHits } from './agents/order-calc/web-hits';
import {
  enrichWebCandidates,
  markWebFields,
  planWebQueries,
  type WebFound,
} from './agents/order-calc/web-enrichment';
import { isWebOnlyEntry, regroupByLocation } from './kit/domain/shortlist-compare';
import {
  LOCATION_INPUT_MAX_LENGTH,
  assignedLocation,
  parseLocations,
} from './kit/domain/shortlist-location';
import {
  SHORTLIST_MAX_SIZE,
  mergeCandidates,
  normalizeSupplierName,
  webPricesOf,
  type MergeOutcome,
  type ShortlistEntry,
  type ShortlistProposal,
  type SourceResult,
  type SupplierCandidate,
  type SupplierSource,
} from './kit/domain/shortlist';
import type { PurchaseRequest } from './kit/domain/models';
import type { SupplierCard } from './kit/domain/supplier-card';
import type { ChatBlock, ChatMessage } from '@business-ai/core';
import {
  SHORTLIST_BASE_RESEARCH_LIMIT,
  SHORTLIST_CACHE_MAX,
  SHORTLIST_PAGES_MAX,
  SHORTLIST_PAGE_SIZE,
  SHORTLIST_WEB_QUERIES_PER_STEP,
  SHORTLIST_WEB_QUERY_SUFFIXES,
  SHORTLIST_WEB_SEARCHES_MAX,
  SHORTLIST_WEB_STEPS_PER_CALL,
  criteriaKeyOf,
  deletePageState,
  isPageStateAlive,
  loadPageState,
  pageStateExpiry,
  savePageState,
  type ShortlistPageState,
} from './shortlist-paging-state';
import { SupplierIdentitySet, type SupplierIdentityInput } from './supplier-identity';

/**
 * «Ещё 10» (этап 8z): следующая страница шорт-листа без повторов.
 *
 * Правило каждой страницы: невыданные подходящие поставщики из базы в порядке ранжирования
 * (то же ранжирование, что у первой выдачи: `mergeCandidates` + `orderShortlistPool`), остаток
 * до `count` добирает интернет. Как только в какой-то выдаче база не заполнила `count` мест,
 * `baseExhausted` становится истиной навсегда для этого состояния: база больше не
 * запрашивается, страницы идут из интернета. Заполнила все места - следующая страница снова
 * начинается с остатка базы.
 *
 * Первая выдача считается по сохранённому шорт-листу: «база» - строки с источником `knowledge`
 * (и `telegram`: канал ранжируется на уровне базы, `isWebOnlyEntry`). Поставщики, названные
 * сотрудником (`namedByManager`), идут вне лимита ранжирования и места базы не занимают: их
 * учёт сломал бы правило («10 из базы» превратилось бы в «9 из базы + 1 названный»).
 *
 * Откуда берутся кандидаты страницы: (1) сохранённые результаты источников заявки
 * (`order-calc:source`): в первой выдаче показана лишь часть найденного; (2) повторный поиск по
 * базе с большим пределом БЕЗ записи в `order-calc:source` (первая выдача не затирается),
 * один раз на состояние, результат кэшируется; (3) свежий поиск в интернете другой
 * формулировкой (платформа отдаёт не больше десяти хитов на поиск), домены показанных и
 * карточек базы отсеиваются ДО классификации и чтения страниц; найденное, но не показанное,
 * кэшируется. Страницы сайтов читает обогащение только у тех, кто вошёл в показ.
 *
 * Выбор менеджера: после страницы N+1 `order-calc:proposal` содержит ВСЕ показанные строки
 * (страницы 1..N+1, новая версия), вопрос выбора (`saveChoiceAsk`) переоткрыт на новой версии,
 * поэтому `recordManagerChoice` принимает номера сквозной нумерации, а `recordSelection` и
 * `validateShortlistSelection` видят всех. Менеджеру показывается ТОЛЬКО новая страница, номера
 * продолжаются (11-20). Файл Excel не отправляется: он строится при `askManagerToChoose` и
 * покажет все строки, если вопрос задать заново. Прежнее подтверждение выбора относится к
 * прежней версии и не действует: `choiceNeedsRepeat` просит спросить выбор заново.
 */

/** Сколько кандидатов базы проверяется за одно сопоставление веб-кандидата с карточками. */
const CARD_LOOKUP_CONCURRENCY = 3;
/** Ссылка на страницу сайта (а не идентификатор документа из базы знаний). */
const HTTP_URL = /^https?:\/\//i;

/** Тексты сообщений: код показывает их сотруднику, модель пересказывает коротко. */
const NO_SHORTLIST_MESSAGE =
  'Шорт-лист по заявке ещё не собран: сначала searchKnowledgeSuppliers, searchWeb и ' +
  'buildShortlist, затем askManagerToChoose.';
const CRITERIA_CHANGED_MESSAGE =
  'Критерии заявки изменились после последней выдачи: прежний шорт-лист устарел. Соберите ' +
  'его заново (searchKnowledgeSuppliers, searchWeb, buildShortlist), затем askManagerToChoose.';
const NO_NEW_MESSAGE =
  'Новых подходящих поставщиков нет: все найденные уже показаны. Можно уточнить запрос ' +
  '(другие названия, артикулы, город) и собрать шорт-лист заново.';
const NOT_FOUND_YET_MESSAGE =
  'Новых поставщиков пока не нашлось, но поиск ещё не исчерпан: можно повторить «ещё».';
const WEB_LIMITED_MESSAGE =
  'Поиск в интернете сейчас ограничен (лимит запросов), поэтому найдено меньше. Повторите ' +
  'позже.';
const PAGES_LIMIT_MESSAGE =
  `Достигнут предел выдачи (страниц: ${SHORTLIST_PAGES_MAX}). Чтобы увидеть других ` +
  'поставщиков, уточните запрос и соберите шорт-лист заново.';
const SHOWN_MESSAGE = 'Новая страница показана менеджеру кодом; не пересказывай её.';
/** Строки закрывающего сообщения под страницей. */
const NOTE_EXHAUSTED = 'Это все подходящие поставщики: новых больше нет.';
const NOTE_PARTIAL = 'Нашлось меньше, чем просили: можно написать «ещё», поиск продолжится.';
const NOTE_PAGES_LIMIT = 'Достигнут предел выдачи: чтобы увидеть других, уточните запрос.';
const NOTE_MORE = 'Чтобы увидеть ещё вариантов, напишите «ещё».';
const PAGE_CHOICE_PROMPT =
  '[B]Кому готовить запросы?[/B] Можно выбрать из любого показанного списка по номеру ' +
  'или названию, например: «берём 3 и 12».';
const CARDS_SEPARATOR = '──── карточки поставщиков ────';

/** Промпт агента: когда вызывать `showMoreSuppliers` (подключает исполнитель под флагом). */
export const SHORTLIST_PAGING_PROMPT =
  '\n\n## Следующие поставщики («ещё»)\n' +
  '- Если после шорт-листа сотрудник просит «ещё», «ещё 10», «покажи следующих», «есть ещё ' +
  'варианты?», вызови showMoreSuppliers (requestId - заявка, по которой показан шорт-лист; ' +
  'count - сколько показать, по умолчанию 10; location - только если сотрудник называл ' +
  'город). Не собирай шорт-лист заново и не вызывай buildShortlist ради этого.\n' +
  '- Порядок выбирает код: сначала невыданные подходящие поставщики из базы, остаток ' +
  'добирает интернет; показанные раньше не повторяются, номера продолжаются (11, 12...). ' +
  'Любое соотношение базы и интернета нормально, не объясняй его и не обещай больше, чем ' +
  'нашёл код.\n' +
  '- status=shown: страницу и вопрос «кому готовить запросы» уже отправил код, ход закончен: ' +
  'ничего не пересказывай и не добавляй. Выбор из любой страницы записывай ' +
  'recordManagerChoice по сквозному номеру или названию.\n' +
  '- status=no_new (exhausted=true): честно скажи «новых подходящих поставщиков нет» и ' +
  'предложи уточнить запрос; не придумывай поставщиков и не показывай прежних как новых. ' +
  'При exhausted=false скажи, что поиск не исчерпан, и предложи написать «ещё» ещё раз.\n' +
  '- status=pages_limit: скажи, что предел выдачи достигнут, и предложи уточнить запрос.\n' +
  '- status=no_shortlist или criteria_changed: сначала searchKnowledgeSuppliers, searchWeb, ' +
  'buildShortlist, askManagerToChoose, потом снова showMoreSuppliers по просьбе.\n' +
  '- choiceNeedsRepeat=true: сотрудник выбирал поставщиков до «ещё»; прежний выбор не ' +
  'действует, после списка попроси назвать выбор заново из всех показанных.\n';

/** Статусы ответа инструмента. */
const PAGING_STATUSES = [
  'shown',
  'no_new',
  'pages_limit',
  'no_shortlist',
  'criteria_changed',
] as const;
type PagingStatus = (typeof PAGING_STATUSES)[number];

interface ShowMoreInput {
  requestId: string;
  /** Сколько поставщиков показать; не больше размера первой выдачи. */
  count: number;
  /** Город или регион, как в `buildShortlist` (повторно называть не нужно: помнится). */
  location?: string | undefined;
}

/** Ответ модели: числа и статус, без контактов и цен. */
interface ShowMoreOutput {
  status: PagingStatus;
  requestId: string;
  /** Номер показанной страницы (первая выдача - 1); без показа - последняя показанная. */
  page: number;
  /** Сколько новых поставщиков показано на этой странице. */
  shown: number;
  fromBase: number;
  fromWeb: number;
  /** Всего показано менеджеру по заявке (все страницы). */
  totalShown: number;
  /** Подходящих больше нет (или достигнут предел страниц). */
  exhausted: boolean;
  /** Новая версия шорт-листа (все показанные строки); нет - страница не показывалась. */
  version?: string | undefined;
  /** Прежний выбор менеджера не действует: после новой страницы спросить заново. */
  choiceNeedsRepeat?: boolean | undefined;
  /** Поиск в интернете ограничен лимитом: найдено меньше возможного. */
  webLimited?: boolean | undefined;
  message: string;
}

const showMoreInputSchema = z.object({
  requestId: z.string().min(1),
  count: z.number().int().positive().max(SHORTLIST_PAGE_SIZE).default(SHORTLIST_PAGE_SIZE),
  location: z.string().trim().min(1).max(LOCATION_INPUT_MAX_LENGTH).optional(),
});
const showMoreOutputSchema = z.object({
  status: z.enum(PAGING_STATUSES),
  requestId: z.string(),
  page: z.number().int().nonnegative(),
  shown: z.number().int().nonnegative(),
  fromBase: z.number().int().nonnegative(),
  fromWeb: z.number().int().nonnegative(),
  totalShown: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  version: z.string().optional(),
  choiceNeedsRepeat: z.boolean().optional(),
  webLimited: z.boolean().optional(),
  message: z.string(),
});

/** Рабочий контекст одного вызова «ещё». */
interface Work {
  deps: OrderCalcDeps;
  context: ToolContext;
  request: PurchaseRequest;
  /** Изменяемая копия состояния: записывается в конце вызова. */
  state: ShortlistPageState;
  count: number;
  locations: string[];
  /** Поля формы заявки: модель сравнения видит, что нужно заказчику. */
  fields: Record<string, string>;
  /** Сохранённые результаты источников первой выдачи. */
  stored: SourceResult[];
  shown: SupplierIdentitySet;
  shownIds: Set<string>;
}

/** Идентичность кандидата поиска: название, сайт карточки и страницы-ссылки. */
function candidateIdentity(candidate: SupplierCandidate): SupplierIdentityInput {
  const reference = candidate.reference;
  return {
    name: candidate.name,
    url: candidate.website,
    extraUrls: reference !== undefined && HTTP_URL.test(reference) ? [reference] : [],
  };
}

/** Идентичность строки шорт-листа. */
function entryIdentity(entry: ShortlistEntry): SupplierIdentityInput {
  return {
    name: entry.name,
    url: entry.website,
    extraUrls: entry.references.filter((reference) => HTTP_URL.test(reference)),
  };
}

/** Идентичность карточки базы: название, сайт и ИНН (с проверкой контрольной суммы). */
function cardIdentity(card: SupplierCard): SupplierIdentityInput {
  return { name: card.name, url: card.website, inn: card.inn };
}

/** Запомнить показанные строки: их ключи и ключи их карточек базы (сайт, ИНН). */
async function rememberShown(
  deps: OrderCalcDeps,
  shown: SupplierIdentitySet,
  shownIds: Set<string>,
  entries: readonly ShortlistEntry[],
): Promise<void> {
  for (const entry of entries) {
    shownIds.add(entry.supplierId);
    shown.add(entryIdentity(entry));
  }
  const baseIds = entries
    .map((entry) => entry.supplierId)
    .filter((id) => !id.startsWith(EXTERNAL_SUPPLIER_PREFIX));
  if (baseIds.length === 0) return;
  for (const card of await deps.suppliers.getCards(baseIds)) shown.add(cardIdentity(card));
}

/** Шорт-лист построен лимитом меньше размера страницы: по числу строк исчерпание не видно. */
function builtWithSmallerLimit(proposal: ShortlistProposal, ranked: number): boolean {
  return ranked < SHORTLIST_MAX_SIZE && proposal.truncated > 0;
}

/** Сколько строк занимает база (источник `knowledge` или канал, не «только веб»). */
function baseCountOf(entries: readonly ShortlistEntry[]): number {
  return entries.filter((entry) => !isWebOnlyEntry(entry)).length;
}

/**
 * Состояние по сохранённому шорт-листу (первая выдача = страница 1). База считается
 * исчерпанной, если не заполнила страницу; названные сотрудником строки в расчёт не входят.
 */
async function initialState(
  deps: OrderCalcDeps,
  proposal: ShortlistProposal,
  criteriaKey: string,
  location: string | undefined,
): Promise<ShortlistPageState> {
  const shown = new SupplierIdentitySet();
  const shownIds = new Set<string>();
  await rememberShown(deps, shown, shownIds, proposal.entries);
  const ranked = proposal.entries.filter((entry) => entry.namedByManager !== true);
  const now = deps.clock.now();
  return {
    requestId: proposal.requestId,
    proposalVersion: proposal.version,
    criteriaKey,
    shownKeys: shown.toKeys(),
    shownIds: [...shownIds],
    page: 1,
    baseExhausted:
      baseCountOf(ranked) < SHORTLIST_MAX_SIZE && !builtWithSmallerLimit(proposal, ranked.length),
    webExhausted: false,
    webSearchesDone: 0,
    webStep: 0,
    ...(location === undefined ? {} : { location }),
    webCache: { source: 'web', status: 'ok', candidates: [] },
    createdAt: now.toISOString(),
    expiresAt: pageStateExpiry(now),
  };
}

/** Сохранённые результаты источников заявки (канал Telegram - только при включённом флаге). */
async function loadStoredResults(deps: OrderCalcDeps, requestId: string): Promise<SourceResult[]> {
  const sources: SupplierSource[] = ['knowledge', 'web'];
  if (deps.telegramChannel !== undefined) sources.push('telegram');
  const results: SourceResult[] = [];
  for (const source of sources) {
    const result = await loadSourceResult(deps, requestId, source);
    if (result !== null) results.push(result);
  }
  return results;
}

/** Кандидат уже показан: по идентификатору строки либо по ключу идентичности. */
function isShown(work: Work, candidate: SupplierCandidate): boolean {
  if (candidate.supplierId !== undefined && work.shownIds.has(candidate.supplierId)) return true;
  return work.shown.has(candidateIdentity(candidate));
}

/** Все результаты пула без показанных: сохранённые, повторный поиск базы, кэш интернета. */
function poolResults(work: Work): SourceResult[] {
  const all = [...work.stored];
  if (work.state.baseExtra !== undefined) all.push(work.state.baseExtra);
  if (work.state.webCache.candidates.length > 0) all.push(work.state.webCache);
  return all.map((result) => ({
    ...result,
    candidates: result.candidates.filter((candidate) => !isShown(work, candidate)),
  }));
}

/** Слияние пула тем же правилом, что у первой выдачи (база первой, интернет добирает). */
function mergePool(work: Work, results: readonly SourceResult[]): MergeOutcome {
  return mergeCandidates(results, {
    limit: work.count,
    locations: work.locations,
    positionCount: work.request.items.length,
    externalId: (normalized) => `${EXTERNAL_SUPPLIER_PREFIX}${stableHash(normalized)}`,
  });
}

/**
 * Повторный поиск по базе с большим пределом (один раз на состояние). Результат в состояние
 * заявки не пишется, канал Telegram не опрашивается. `false` - база недоступна (не кэшируем:
 * вывод «база исчерпана» по сбою был бы ложным).
 */
async function researchBase(work: Work): Promise<boolean> {
  const box: { result?: SourceResult } = {};
  await knowledgeSearch.run({ requestId: work.request.id }, work.deps, work.context, {
    resultLimit: SHORTLIST_BASE_RESEARCH_LIMIT,
    capture: (result) => {
      box.result = result;
    },
  });
  const result = box.result;
  if (result === undefined || result.status !== 'ok') {
    work.deps.log?.('shortlist_paging_base_unavailable', { found: 0 });
    return false;
  }
  const best = [...result.candidates].sort((a, b) => b.score - a.score);
  work.state.baseExtra = { ...result, candidates: best.slice(0, SHORTLIST_CACHE_MAX) };
  work.deps.log?.('shortlist_paging_base_research', { found: result.candidates.length });
  return true;
}

/** Базовые веб-запросы по заявке: план модели с проверкой кода, иначе названия позиций. */
async function planBaseQueries(work: Work): Promise<string[]> {
  const planned = await planWebQueries(work.deps, work.request, work.context.signal);
  if (planned !== null) return planned;
  return work.request.items
    .map((item) => item.name)
    .filter((name) => externalQueryProblem(name) === null);
}

/** Оценка по месту в выдаче: первый результат = 1, дальше убывает (как у `searchWeb`). */
function rankScore(index: number, total: number): number {
  return total <= 0 ? 0 : (total - index) / total;
}

/** Все известные идентичности: показанные, найденные в базе и всё, что уже есть в пуле. */
function knownIdentities(work: Work): SupplierIdentitySet {
  const known = SupplierIdentitySet.fromKeys(work.shown.toKeys());
  const results = [...work.stored];
  if (work.state.baseExtra !== undefined) results.push(work.state.baseExtra);
  results.push(work.state.webCache);
  for (const result of results) {
    for (const candidate of result.candidates) known.add(candidateIdentity(candidate));
  }
  return known;
}

/** Веб-кандидат совпал с карточкой базы по названию, сайту или ИНН (сбой поиска - не совпал). */
async function matchesBaseCard(work: Work, candidate: SupplierCandidate): Promise<boolean> {
  try {
    const match = await findCard(work.deps, candidate.name);
    const cards =
      match.kind === 'card' ? [match.card] : match.kind === 'ambiguous' ? match.cards : [];
    if (cards.length === 0) return false;
    const base = new SupplierIdentitySet();
    for (const card of cards) base.add(cardIdentity(card));
    return base.has(candidateIdentity(candidate));
  } catch (error) {
    work.deps.log?.('shortlist_paging_card_lookup_failed', {
      code: error instanceof Error ? error.name : 'unexpected',
    });
    return false;
  }
}

/**
 * Новые веб-кандидаты: без показанных, уже имеющихся в пуле и совпавших с карточкой базы
 * (такой поставщик не выдаётся «из интернета»). Сопоставление с базой - один поиск на название.
 */
async function newWebCandidates(
  work: Work,
  candidates: readonly SupplierCandidate[],
): Promise<SupplierCandidate[]> {
  const known = knownIdentities(work);
  const fresh = candidates.filter((candidate) => !known.has(candidateIdentity(candidate)));
  const names = [...new Set(fresh.map((candidate) => normalizeSupplierName(candidate.name)))];
  const representative = names.flatMap((name) => {
    const first = fresh.find((candidate) => normalizeSupplierName(candidate.name) === name);
    return first === undefined ? [] : [first];
  });
  const inBase = new Set<string>();
  await mapPool(representative, CARD_LOOKUP_CONCURRENCY, async (candidate) => {
    if (await matchesBaseCard(work, candidate)) inBase.add(normalizeSupplierName(candidate.name));
  });
  return fresh.filter((candidate) => !inBase.has(normalizeSupplierName(candidate.name)));
}

/** Можно ли ещё искать в интернете: формулировки и бюджет поисков не вышли. */
function canSearchWeb(state: ShortlistPageState): boolean {
  return (
    !state.webExhausted &&
    state.webStep < SHORTLIST_WEB_QUERY_SUFFIXES.length &&
    state.webSearchesDone < SHORTLIST_WEB_SEARCHES_MAX
  );
}

/** Итог шага свежего поиска. */
interface WebStepOutcome {
  /** Код причины, если поиск ограничен лимитом (повторять в этом вызове бессмысленно). */
  limited?: string | undefined;
}

/**
 * Один шаг свежего поиска: до `SHORTLIST_WEB_QUERIES_PER_STEP` запросов с очередным
 * суффиксом. Каждый запрос идёт через `runAuditedWebSearch` (лимитер хода и сотрудника,
 * аудит, ограничитель частоты адаптера). Домены показанных и уже известных отсеиваются ДО
 * классификации и платного чтения страниц; найденное попадает в кэш состояния.
 */
async function freshWebStep(work: Work): Promise<WebStepOutcome> {
  const { deps, context, state } = work;
  state.webQueries ??= await planBaseQueries(work);
  const suffix = SHORTLIST_WEB_QUERY_SUFFIXES[state.webStep];
  if (suffix === undefined || state.webQueries.length === 0) {
    state.webExhausted = true;
    return {};
  }
  state.webStep += 1;
  const queries = state.webQueries
    .slice(0, SHORTLIST_WEB_QUERIES_PER_STEP)
    .map((query) => `${query} ${suffix}`)
    .filter((query) => externalQueryProblem(query) === null)
    .slice(0, Math.max(0, SHORTLIST_WEB_SEARCHES_MAX - state.webSearchesDone));
  const known = knownIdentities(work);
  const found: WebFound[] = [];
  let limited: string | undefined;
  for (const query of queries) {
    // Списываем до обращения: сбой платного поиска тоже расходует бюджет состояния.
    state.webSearchesDone += 1;
    let hits: WebSearchHit[];
    try {
      ({ hits } = await runAuditedWebSearch(deps, context, query, {
        limit: WEB_SEARCH_MAX_RESULTS,
      }));
    } catch (error) {
      limited = webSearchLimitReason(error) ?? 'unavailable';
      deps.log?.('shortlist_paging_web_failed', {
        code: error instanceof Error ? error.name : 'unexpected',
      });
      break;
    }
    hits.forEach((hit, index) => {
      if (hit.title.trim() === '' || known.has({ url: hit.url })) return;
      found.push({
        candidate: { name: hit.title, reference: hit.url, score: rankScore(index, hits.length) },
        hit,
      });
    });
  }
  if (found.length > 0) {
    const refined = await refineWebHits(deps, context, work.request, found);
    const candidates = [...refined.primary.map((item) => item.candidate), ...refined.extras];
    const added = await newWebCandidates(work, candidates);
    const cache = state.webCache.candidates;
    for (const candidate of added.map(markWebFields)) {
      const duplicate = cache.some(
        (item) => item.name === candidate.name && item.reference === candidate.reference,
      );
      if (!duplicate && cache.length < SHORTLIST_CACHE_MAX) cache.push(candidate);
    }
  }
  deps.log?.('shortlist_paging_web_step', {
    step: state.webStep,
    queries: queries.length,
    hits: found.length,
    cached: state.webCache.candidates.length,
  });
  return { limited };
}

/** Уже есть сведения со страницы (город, контакты, срок, цена): повторно не обогащать. */
function isWebEnriched(entry: ShortlistEntry): boolean {
  const fields = entry.webFields ?? [];
  const facts = fields.some((field) => field !== 'site');
  return facts || webPricesOf(entry).length > 0;
}

/** Первая ссылка на страницу сайта у строки. */
function siteOfEntry(entry: ShortlistEntry): string | undefined {
  return entry.references.find((reference) => HTTP_URL.test(reference));
}

/**
 * Обогащение показанных веб-кандидатов (город, контакты, цена, срок со страницы сайта): только
 * тем, кто вошёл в страницу, - чтение страниц и модель платные. Строка пересобирается тем же
 * слиянием, что у первой выдачи; порядок, причина выбора и группа локации сохраняются.
 */
async function enrichWebEntries(
  work: Work,
  entries: readonly ShortlistEntry[],
): Promise<ShortlistEntry[]> {
  const targets = entries.filter(
    (entry) => isWebOnlyEntry(entry) && !isWebEnriched(entry) && siteOfEntry(entry) !== undefined,
  );
  if (targets.length === 0 || work.deps.webEnricher === undefined) return [...entries];
  const found: WebFound[] = targets.flatMap((entry) => {
    const url = siteOfEntry(entry);
    if (url === undefined) return [];
    const candidate: SupplierCandidate = { name: entry.name, reference: url, score: entry.score };
    return [{ candidate, hit: { title: entry.name, url, snippet: '' } }];
  });
  const items = work.request.items;
  const enriched = await enrichWebCandidates(
    work.deps,
    work.context,
    found,
    items.map((item) => item.name),
    items.flatMap((item) => {
      const requirements = requirementsForModel(item.requirements);
      return requirements === undefined ? [] : [{ name: item.name, requirements }];
    }),
  );
  const rebuilt = new Map<string, ShortlistEntry>();
  targets.forEach((entry, index) => {
    const main = enriched[index];
    if (main === undefined) return;
    const others = entry.references
      .filter((reference) => reference !== main.reference)
      .map((reference): SupplierCandidate => ({ name: entry.name, reference, score: entry.score }));
    const merged = mergeCandidates(
      [{ source: 'web', status: 'ok', candidates: [markWebFields(main), ...others] }],
      {
        limit: 1,
        positionCount: items.length,
        externalId: (normalized) => `${EXTERNAL_SUPPLIER_PREFIX}${stableHash(normalized)}`,
      },
    );
    const [entryRebuilt] = merged.entries;
    if (entryRebuilt === undefined) return;
    rebuilt.set(entry.supplierId, {
      ...entryRebuilt,
      supplierId: entry.supplierId,
      ...(entry.rankReason === undefined ? {} : { rankReason: entry.rankReason }),
    });
  });
  return entries.map((entry) => rebuilt.get(entry.supplierId) ?? entry);
}

/** Итог построения страницы. */
interface PageBuild {
  /** Строки страницы в порядке показа. */
  page: ShortlistEntry[];
  /** Сколько подходящих осталось в пуле после страницы. */
  remaining: number;
  /** Поиск в интернете ограничен лимитом. */
  webLimited: boolean;
}

/**
 * Построить страницу: слияние пула, при нехватке базы - повторный поиск по ней (один раз),
 * при нехватке всего - до `SHORTLIST_WEB_STEPS_PER_CALL` шагов свежего поиска; затем то же
 * упорядочение, что у первой выдачи, обогащение показанных и группировка по локации.
 */
async function buildPage(work: Work): Promise<PageBuild> {
  const { state, count } = work;
  let merged = mergePool(work, poolResults(work));
  let baseUnavailable = false;
  const baseShort = baseCountOf(merged.entries) < count;
  if (!state.baseExhausted && state.baseExtra === undefined && baseShort) {
    baseUnavailable = !(await researchBase(work));
    merged = mergePool(work, poolResults(work));
  }
  let steps = 0;
  let limited: string | undefined;
  while (
    merged.entries.length < count &&
    canSearchWeb(state) &&
    steps < SHORTLIST_WEB_STEPS_PER_CALL &&
    limited === undefined
  ) {
    steps += 1;
    limited = (await freshWebStep(work)).limited;
    merged = mergePool(work, poolResults(work));
  }
  if (merged.entries.length < count && limited === undefined && !canSearchWeb(state)) {
    state.webExhausted = true;
  }
  const request = work.request;
  const ordered =
    merged.pool === undefined
      ? []
      : (
          await orderShortlistPool(work.deps, merged.pool, count, work.context.signal, {
            positions: request.items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unit: item.unit,
              requirements: item.requirements,
            })),
            requirements: work.fields,
            locations: work.locations,
          })
        ).entries;
  // База не заполнила страницу - она исчерпана навсегда (сбой базы вывода не даёт).
  if (!state.baseExhausted && !baseUnavailable && baseCountOf(ordered) < count) {
    state.baseExhausted = true;
  }
  const withWeb = await enrichWebEntries(work, ordered);
  const enriched = await checkShownSites(
    work.deps,
    work.context,
    await enrichShownSuppliers(work.deps, work.context, withWeb),
  );
  const arranged = regroupByLocation(enriched, work.locations).map((entry) => {
    const group = work.locations.length === 0 ? undefined : assignedLocation(entry, work.locations);
    return group === undefined ? entry : { ...entry, locationGroup: group };
  });
  return { page: arranged, remaining: merged.truncated, webLimited: limited !== undefined };
}

/** Новая версия шорт-листа: все показанные строки (страницы 1..N+1). */
function extendedProposal(
  proposal: ShortlistProposal,
  page: readonly ShortlistEntry[],
  remaining: number,
  createdAt: string,
): ShortlistProposal {
  const entries = [...proposal.entries, ...page];
  return {
    requestId: proposal.requestId,
    version: stableHash({ entries, statuses: proposal.sources, createdAt }),
    createdAt,
    managerThreadId: proposal.managerThreadId,
    entries,
    truncated: remaining,
    sources: proposal.sources,
    market: proposal.market,
    webMarket: proposal.webMarket,
    telegramMarket: proposal.telegramMarket,
    webPricesUnmatched: proposal.webPricesUnmatched,
    // `compared` и `orderMethod` описывают только первую выдачу: на расширенном списке строка
    // «сравнено N из M» вводила бы в заблуждение, поэтому поля не переносятся.
  };
}

/** Что сообщение говорит о результате страницы. */
interface PageNotes {
  exhausted: boolean;
  partial: boolean;
  pagesLimit: boolean;
  webLimited: boolean;
}

/** Сообщение менеджеру: только новая страница с продолжением номеров и закрывающий абзац. */
async function pageMessage(
  deps: OrderCalcDeps,
  proposal: ShortlistProposal,
  page: readonly ShortlistEntry[],
  offset: number,
  pageNumber: number,
  notes: PageNotes,
): Promise<{ cards: ChatMessage; closing: string }> {
  const label = await requestLabel(deps, proposal.requestId);
  const fromBase = baseCountOf(page);
  const header = [
    ...shortlistTitleLines(label),
    `Следующие поставщики: №${offset + 1}–${offset + page.length} (страница ${pageNumber}).`,
    `Из базы знаний: ${fromBase}, из интернета: ${page.length - fromBase}.`,
  ];
  const lines = page.flatMap((entry, index) => entryLines(entry, offset + index));
  const text = [...header, CARDS_SEPARATOR, ...lines].join('\n');
  const closingLines = [
    ...(notes.webLimited ? [WEB_LIMITED_MESSAGE] : []),
    ...(notes.pagesLimit ? [NOTE_PAGES_LIMIT] : []),
    ...(notes.exhausted && !notes.pagesLimit ? [NOTE_EXHAUSTED] : []),
    ...(notes.partial ? [NOTE_PARTIAL] : []),
    PAGE_CHOICE_PROMPT,
    ...(notes.exhausted || notes.pagesLimit ? [] : [NOTE_MORE]),
  ];
  const closing = closingLines.join('\n\n');
  if (deps.shortlistAttachEnabled === false) return { cards: { text }, closing };
  const blocks: ChatBlock[] = page.flatMap((entry, index): ChatBlock[] => [
    ...entryCardBlocks(entry, offset + index),
    { kind: 'delimiter' },
  ]);
  return { cards: { text, blocks, blocksLead: header.join('\n') }, closing };
}

/** Ключи повторной отправки сообщений страницы: одна страница - одна пара сообщений. */
const cardsKey = (proposal: ShortlistProposal): string =>
  `order-more:${proposal.requestId}:${proposal.version}`;
const closingKey = (proposal: ShortlistProposal): string =>
  `order-more-closing:${proposal.requestId}:${proposal.version}`;

/** Ответ без показа страницы. */
function refusal(
  status: Exclude<PagingStatus, 'shown'>,
  requestId: string,
  message: string,
  extra: Partial<ShowMoreOutput> = {},
): ShowMoreOutput {
  return {
    status,
    requestId,
    page: 0,
    shown: 0,
    fromBase: 0,
    fromWeb: 0,
    totalShown: 0,
    exhausted: false,
    message,
    ...extra,
  };
}

/**
 * «Ещё 10»: следующая страница шорт-листа по заявке без повторов (описание правил - в шапке
 * модуля). Модели отдаются числа и статус; список и вопрос выбора показывает код.
 */
export const showMoreSuppliers = defineTool<ShowMoreInput, ShowMoreOutput, OrderCalcDeps>({
  name: 'showMoreSuppliers',
  description:
    'Показать следующих поставщиков по заявке requestId, когда сотрудник просит «ещё», ' +
    '«ещё 10», «покажи следующих» после шорт-листа. Код сам берёт сначала невыданных ' +
    'подходящих из нашей базы, остаток добирает из интернета, показанных раньше не повторяет ' +
    'и продолжает нумерацию; страницу и вопрос «кому готовить запросы» отправляет менеджеру ' +
    'сам (status=shown - ход закончен). count не больше ' +
    `${SHORTLIST_PAGE_SIZE}; location - город, если сотрудник его называл. no_new: новых ` +
    'подходящих нет (скажи честно, ничего не выдумывай); pages_limit: предел выдачи; ' +
    'no_shortlist или criteria_changed: шорт-лист нужно собрать заново. Ответ - числа и ' +
    'статус: страницу не пересказывай.',
  sideEffect: true,
  // Страницу и вопрос выбора отправляет код: шаг модели с итогом после показа не нужен.
  endsTurn: true,
  endsTurnWhen: (output) => output.status === 'shown',
  inputSchema: showMoreInputSchema,
  outputSchema: showMoreOutputSchema,
  idempotencyKey: (input) => `order-more:${input.requestId}:${input.count}`,
  // Ключ «на ход»: повтор того же хода не задваивает страницу, а следующая просьба «ещё» в
  // другой реплике сотрудника - новая операция.
  idempotencyPredecessor: async (_input, _deps, threadId, turnNumber) =>
    turnPredecessor(threadId, turnNumber),
  async execute(input, deps, context): Promise<ShowMoreOutput> {
    await assertOrderOwner(deps, input.requestId, context);
    const proposal = await loadProposal(deps, input.requestId);
    if (proposal === null) return refusal('no_shortlist', input.requestId, NO_SHORTLIST_MESSAGE);
    const request = await deps.requests.get(input.requestId);
    if (request === null) {
      throw new DomainError('not_found', `Заявка ${input.requestId} не найдена.`);
    }
    const now = deps.clock.now();
    const fields = (await loadCompleteness(deps, input.requestId))?.values ?? {};
    const criteriaKey = criteriaKeyOf(request, fields);
    const loaded = await loadPageState(deps.state, input.requestId);
    const resumed =
      loaded !== null &&
      isPageStateAlive(loaded, now) &&
      loaded.proposalVersion === proposal.version;
    if (resumed && loaded.criteriaKey !== criteriaKey) {
      // Выдача построена по другим критериям: продолжать её нельзя, состояние забывается.
      await deletePageState(deps.state, input.requestId);
      return refusal('criteria_changed', input.requestId, CRITERIA_CHANGED_MESSAGE);
    }
    const location = input.location ?? (resumed ? loaded.location : undefined);
    const state: ShortlistPageState = resumed
      ? structuredClone(loaded)
      : await initialState(deps, proposal, criteriaKey, location);
    if (location !== undefined) state.location = location;
    const totalShown = proposal.entries.length;
    if (state.page >= SHORTLIST_PAGES_MAX) {
      return refusal('pages_limit', input.requestId, PAGES_LIMIT_MESSAGE, {
        page: state.page,
        totalShown,
        exhausted: true,
      });
    }
    const shown = SupplierIdentitySet.fromKeys(state.shownKeys);
    const work: Work = {
      deps,
      context,
      request,
      state,
      count: input.count,
      locations: parseLocations(state.location),
      fields,
      stored: await loadStoredResults(deps, input.requestId),
      shown,
      shownIds: new Set(state.shownIds),
    };
    const built = await buildPage(work);
    // Цена против средней к «Почему в списке» - по средним первой выдачи (как у неё).
    const page = withPriceNotes(built.page, proposal);
    const bothExhausted = state.baseExhausted && state.webExhausted && !built.webLimited;
    const exhausted = page.length < input.count && bothExhausted;
    state.expiresAt = pageStateExpiry(now);
    const fromBase = baseCountOf(page);
    const counts = { page: state.page, totalShown, fromBase, fromWeb: page.length - fromBase };
    deps.log?.('shortlist_paging', {
      page: state.page + (page.length > 0 ? 1 : 0),
      shown: page.length,
      fromBase,
      fromWeb: counts.fromWeb,
      searches: state.webSearchesDone,
      baseExhausted: state.baseExhausted,
      webExhausted: state.webExhausted,
    });
    if (page.length === 0) {
      await savePageState(deps.state, state);
      return refusal(
        'no_new',
        input.requestId,
        exhausted ? NO_NEW_MESSAGE : built.webLimited ? WEB_LIMITED_MESSAGE : NOT_FOUND_YET_MESSAGE,
        { ...counts, exhausted, webLimited: built.webLimited || undefined },
      );
    }
    // Показанное запоминается ДО сохранения: даже при сбое отправки повтор не вернёт эти строки.
    await rememberShown(deps, shown, work.shownIds, page);
    const next = extendedProposal(proposal, page, built.remaining, now.toISOString());
    const nextState: ShortlistPageState = {
      ...state,
      proposalVersion: next.version,
      shownKeys: shown.toKeys(),
      shownIds: [...work.shownIds],
      page: state.page + 1,
    };
    const pagesLimit = nextState.page >= SHORTLIST_PAGES_MAX;
    const notes: PageNotes = {
      exhausted: exhausted || pagesLimit,
      partial: page.length < input.count && !exhausted && !built.webLimited,
      pagesLimit,
      webLimited: built.webLimited,
    };
    const previousChoice = await loadChoiceConfirmation(deps.state, input.requestId);
    // Нумерация сквозная: новая страница продолжает прежний список, и выбор принимается по любой.
    await saveProposal(deps, next);
    await saveChoiceAsk(deps.state, deps.clock, context.threadId, next);
    await savePageState(deps.state, nextState);
    try {
      const message = await pageMessage(
        deps,
        next,
        page,
        proposal.entries.length,
        nextState.page,
        notes,
      );
      await deps.chat.reply(context.threadId, message.cards, cardsKey(next));
      context.noteShown?.(message.cards.text);
      await deps.chat.reply(context.threadId, { text: message.closing }, closingKey(next));
      context.noteShown?.(message.closing);
    } catch (error) {
      // Страница не дошла до менеджера: возвращаем прежнее состояние, чтобы повтор показал её.
      await saveProposal(deps, proposal);
      await saveChoiceAsk(deps.state, deps.clock, context.threadId, proposal);
      if (loaded !== null && resumed) await savePageState(deps.state, loaded);
      else await deletePageState(deps.state, input.requestId);
      throw error;
    }
    return {
      status: 'shown',
      requestId: input.requestId,
      page: nextState.page,
      shown: page.length,
      fromBase: counts.fromBase,
      fromWeb: counts.fromWeb,
      totalShown: next.entries.length,
      exhausted: notes.exhausted,
      version: next.version,
      ...(previousChoice === null ? {} : { choiceNeedsRepeat: true }),
      ...(built.webLimited ? { webLimited: true } : {}),
      message: SHOWN_MESSAGE,
    };
  },
});
