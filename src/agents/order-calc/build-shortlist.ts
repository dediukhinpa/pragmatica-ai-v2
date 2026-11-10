import { z } from 'zod';
import {
  SHORTLIST_MAX_SIZE,
  SUPPLIER_SOURCES,
  hasExactPrice,
  mergeCandidates,
  type ShortlistProposal,
  type SourceResult,
  type SourceStatus,
  type SupplierSource,
  webPricesOf,
} from '../../kit/domain/shortlist';
import {
  LOCATION_INPUT_MAX_LENGTH,
  assignedLocation,
  parseLocations,
} from '../../kit/domain/shortlist-location';
import {
  cardChangesFromEnrichment,
  type CardEditChanges,
} from '../../kit/domain/supplier-registry';
import { regroupByLocation } from '../../kit/domain/shortlist-compare';
import { defineTool } from '@business-ai/core';
import { recordWorkOwner, resolveRecipientThread, stableHash } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { EXTERNAL_SUPPLIER_PREFIX, type OrderCalcDeps } from './deps';
import {
  NAMED_SUPPLIERS_MAX,
  NAMED_SUPPLIER_MAX_LENGTH,
  namedSupplierEntries,
  type NamedSupplierOutcome,
} from './named-suppliers';
import { assertOrderOwner } from './order-access';
import { orderShortlistPool, webShownCount } from './shortlist-compare';
import { loadCompleteness, loadSourceResult, saveProposal } from './state';
import { enrichShownSuppliers } from './supplier-enrich';

interface BuildShortlistInput {
  requestId: string;
  limit: number;
  /** Названия или id поставщиков, которых сотрудник явно назвал в заявке или сообщении. */
  namedSuppliers?: string[] | undefined;
  /** Город или регион, названный сотрудником (как он его написал); нет - без приоритета. */
  location?: string | undefined;
}
interface BuildShortlistOutput {
  requestId: string;
  version: string;
  empty: boolean;
  entries: Array<{
    supplierId: string;
    sources: SupplierSource[];
    score: number;
    hasEmail: boolean;
    /** Есть ли цена и рейтинг; сами значения и контакты модели не отдаются. */
    hasPrice: boolean;
    hasRating: boolean;
  }>;
  /**
   * Средняя стоимость посчитана кодом и показана менеджеру в сообщении; модели - только
   * статус и число найденных цен.
   */
  marketStatus: 'ok' | 'none';
  pricesFound: number;
  /** То же для средней по интернету (цены веб-кандидатов). */
  webMarketStatus: 'ok' | 'none';
  webPricesFound: number;
  truncated: number;
  /**
   * Сколько поставщиков нашей базы в показанном шорт-листе, у скольких из них есть цена и
   * сколько документов-подсказок привязано к ним. Только числа: итоговое сообщение не должно
   * утверждать про базу больше этого.
   */
  baseSuppliersShown: number;
  baseSuppliersWithPrice: number;
  documentHints: number;
  /** Сколько поставщиков исключено из шорт-листа: у карточки статус «не работаем». */
  excludedInactive?: number | undefined;
  /**
   * Найденное в интернете для поставщиков базы, которое можно предложить сохранить в карточку
   * (совпало по ИНН или с сайта карточки). `changes` передаётся в `prepareSupplierCardEdit`
   * только после согласия сотрудника; сам код карточку не меняет.
   */
  cardSaveSuggestions?: Array<{ supplierId: string; changes: CardSaveChanges }> | undefined;
  /** Пометки об источниках, которые не дали результата: недоступны или не запрашивались. */
  unavailableSources: Array<{
    source: SupplierSource;
    status: string;
    reason?: string | undefined;
  }>;
  /** Итог по каждому названию из `namedSuppliers`; нет поля - названий не передавали. */
  namedSuppliers?: NamedSupplierOutcome[] | undefined;
}

/** Правка карточки по найденному в интернете (форма входа `prepareSupplierCardEdit`). */
type CardSaveChanges = CardEditChanges;

/** Предложения сохранить найденное: только то, что совпало надёжно и есть что записать. */
function saveSuggestions(
  entries: ShortlistProposal['entries'],
): Array<{ supplierId: string; changes: CardSaveChanges }> {
  const result: Array<{ supplierId: string; changes: CardSaveChanges }> = [];
  for (const entry of entries) {
    if (entry.webEnrichment === undefined) continue;
    const changes = cardChangesFromEnrichment(entry.webEnrichment);
    if (Object.keys(changes).length > 0) result.push({ supplierId: entry.supplierId, changes });
  }
  return result;
}

/** Статусы источников: нет записи о поиске = «не запрашивался». */
async function sourceStatuses(
  deps: OrderCalcDeps,
  requestId: string,
): Promise<{ statuses: SourceStatus[]; results: SourceResult[] }> {
  const statuses: SourceStatus[] = [];
  const results: SourceResult[] = [];
  for (const source of SUPPLIER_SOURCES) {
    // Флаг канала выключили после поиска: запись `telegram` остаётся в хранилище, но в новую
    // сборку не берётся (иначе «выключено» не вернуло бы прежний шорт-лист по заявкам, где
    // канал уже опрашивался). Включили снова - запись читается как была.
    if (source === 'telegram' && deps.telegramChannel === undefined) continue;
    const result = await loadSourceResult(deps, requestId, source);
    if (result === null) {
      // Канал опрашивается только при включённом флаге (этап 216): нет записи - источника в
      // этой сборке не было, и «не проверялся» про него не пишем (иначе выключенный флаг
      // менял бы статусы источников и отпечаток шорт-листа).
      if (source !== 'telegram') statuses.push({ source, status: 'not_searched' });
      continue;
    }
    results.push(result);
    statuses.push({
      source,
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
  }
  return { statuses, results };
}

/** Знаков после запятой у оценки в ответе модели. */
const SCORE_DECIMALS = 2;

/**
 * Оценка для модели: дробь без округления (`0.3333333333333333`) - это серия цифр, которую
 * проверки ПДн принимают за номер. В сохранённом шорт-листе оценка остаётся точной.
 */
function roundScore(score: number): number {
  return Number(score.toFixed(SCORE_DECIMALS));
}

/** Почта в строке контактов кандидата из интернета («тел. ..., zakaz@пример.рф, https://...»). */
const EMAIL_IN_CONTACTS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}\p{N}-]{2,}/u;

/**
 * Есть ли у записи почта: в карточке, в обогащении или в строке контактов с сайта. Раньше
 * считалась только почта карточки, и агент писал «у кандидатов из интернета почты нет», хотя
 * в шорт-листе она показана (29.10).
 */
function entryHasEmail(entry: ShortlistProposal['entries'][number]): boolean {
  if (entry.email !== undefined || entry.webEnrichment?.email !== undefined) return true;
  return entry.contacts !== undefined && EMAIL_IN_CONTACTS.test(entry.contacts);
}

/** Ссылка на страницу сайта, а не на документ из базы. */
const WEB_REFERENCE = /^https?:\/\//i;

/**
 * Числа по базе для модели. Считаются по показанным строкам, а не по всем найденным: модель
 * не должна рассказывать про поставщиков, которых менеджер в списке не видит.
 */
function baseCounts(
  entries: ShortlistProposal['entries'],
): Pick<BuildShortlistOutput, 'baseSuppliersShown' | 'baseSuppliersWithPrice' | 'documentHints'> {
  const base = entries.filter((entry) => entry.sources.includes('knowledge'));
  return {
    baseSuppliersShown: base.length,
    baseSuppliersWithPrice: base.filter((entry) => hasExactPrice(entry.prices)).length,
    documentHints: base.reduce(
      (sum, entry) => sum + entry.references.filter((ref) => !WEB_REFERENCE.test(ref)).length,
      0,
    ),
  };
}

/**
 * Шорт-лист без LLM: объединение результатов источников, дедупликация по поставщику,
 * источники у каждой строки, ранжирование простым правилом, ограничение размера.
 * Предложение сохраняется в состоянии: менеджер выбирает именно из него.
 */
export const buildShortlist = defineTool<
  BuildShortlistInput,
  BuildShortlistOutput,
  OrderCalcDeps
>({
  name: 'buildShortlist',
  description:
    'Собрать шорт-лист по заявке из результатов searchKnowledgeSuppliers и searchWeb ' +
    '(запусти их перед этим). Возвращает supplierId, источники и оценку; среднюю стоимость, ' +
    'город, контакты, срок и рейтинг считает и показывает менеджеру код, не пересказывай их; ' +
    'baseSuppliersShown/baseSuppliersWithPrice/documentHints - числа по нашей базе в показе ' +
    '(документы-подсказки - не найденные цены); про базу не утверждай больше этого. ' +
    `недоступные источники помечены. limit не больше ${SHORTLIST_MAX_SIZE}. ` +
    'namedSuppliers - названия (или supplierId) поставщиков, которых сотрудник сам назвал в ' +
    'заявке или сообщении: они идут в шорт-лист первыми вне limit с пометкой «вы указали». ' +
    'Итог по каждому - в ответе namedSuppliers: ambiguous - подходят несколько карточек ' +
    '(candidates), не угадывай, уточни у сотрудника и пересобери с supplierId; not_found - ' +
    'карточки нет; added с inactive=true - у карточки статус «не работаем», но поставщик ' +
    'добавлен по указанию сотрудника (в списке пометка), письма ему готовятся как всем. ' +
    'location - город или регион, если сотрудник его назвал (как написал, несколько через «и» ' +
    'или запятую, в порядке упоминания): поставщики этой локации идут в шорт-листе первыми; ' +
    'передавай, но не уточняй локацию у сотрудника.',
  inputSchema: z.object({
    requestId: z.string().min(1),
    limit: z.number().int().positive().max(SHORTLIST_MAX_SIZE).default(SHORTLIST_MAX_SIZE),
    namedSuppliers: z
      // Длину названия не проверяем схемой (этап 177): код обрезает с предупреждением.
      .array(z.string().trim().min(1))
      .max(NAMED_SUPPLIERS_MAX)
      .optional(),
    location: z.string().trim().min(1).max(LOCATION_INPUT_MAX_LENGTH).optional(),
  }),
  outputSchema: z.object({
    requestId: z.string(),
    version: z.string(),
    empty: z.boolean(),
    entries: z.array(
      z.object({
        supplierId: z.string(),
        sources: z.array(z.enum(SUPPLIER_SOURCES)),
        score: z.number(),
        hasEmail: z.boolean(),
        hasPrice: z.boolean(),
        hasRating: z.boolean(),
      }),
    ),
    marketStatus: z.enum(['ok', 'none']),
    webMarketStatus: z.enum(['ok', 'none']),
    webPricesFound: z.number().int().nonnegative(),
    pricesFound: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
    baseSuppliersShown: z.number().int().nonnegative(),
    baseSuppliersWithPrice: z.number().int().nonnegative(),
    documentHints: z.number().int().nonnegative(),
    excludedInactive: z.number().int().positive().optional(),
    cardSaveSuggestions: z
      .array(
        z.object({
          supplierId: z.string(),
          changes: z.object({
            website: z.string().optional(),
            productionCity: z.string().optional(),
            ogrn: z.string().optional(),
            contacts: z
              .array(z.object({ email: z.string().optional(), phone: z.string().optional() }))
              .optional(),
          }),
        }),
      )
      .optional(),
    unavailableSources: z.array(
      z.object({
        source: z.enum(SUPPLIER_SOURCES),
        status: z.string(),
        reason: z.string().optional(),
      }),
    ),
    warnings: z.array(z.string()).optional(),
    namedSuppliers: z
      .array(
        z.object({
          name: z.string(),
          status: z.enum(['added', 'not_found', 'ambiguous']),
          inactive: z.literal(true).optional(),
          supplierId: z.string().optional(),
          candidates: z
            .array(z.object({ supplierId: z.string(), name: z.string() }))
            .optional(),
        }),
      )
      .optional(),
  }),
  async execute(input, deps, context) {
    await assertOrderOwner(deps, input.requestId, context);
    const { statuses, results } = await sourceStatuses(deps, input.requestId);
    const request = await deps.requests.get(input.requestId);
    const locations = parseLocations(input.location);
    const merged = mergeCandidates(results, {
      limit: input.limit,
      locations,
      ...(request === null ? {} : { positionCount: request.items.length }),
      externalId: (normalized) => `${EXTERNAL_SUPPLIER_PREFIX}${stableHash(normalized)}`,
    });
    // Модель (с проверкой кодом) или правило упорядочивает пул: покрытие позиций ценами,
    // стоимость, контакты, город и срок, рейтинг; без пула (кандидатов нет) сравнивать нечего.
    const ordered =
      merged.pool === undefined
        ? undefined
        : await orderShortlistPool(
            deps,
            merged.pool,
            input.limit,
            context.signal,
            {
              positions: request?.items.map((item) => ({
                name: item.name,
                quantity: item.quantity,
                unit: item.unit,
                requirements: item.requirements,
              })),
              requirements: (await loadCompleteness(deps, input.requestId))?.values,
              locations,
            },
          );
    // Названные сотрудником поставщики - первыми и вне лимита: выбрать можно только из
    // шорт-листа, а ранжирование оставляло дешёвых и вытесняло названного (бой 29.10).
    // Порядок и состав остальных не меняются, только убирается повтор названного.
    const namedNames = (input.namedSuppliers ?? []).map((name) =>
      name.slice(0, NAMED_SUPPLIER_MAX_LENGTH).trim(),
    );
    const warnings =
      namedNames.some((name, index) => name !== input.namedSuppliers?.[index])
        ? [`название поставщика длиннее ${NAMED_SUPPLIER_MAX_LENGTH} знаков обрезано: проверьте`]
        : [];
    const named =
      namedNames.length === 0
        ? undefined
        : await namedSupplierEntries(
            deps,
            namedNames,
            results,
            request?.items.map((item) => item.name) ?? [],
          );
    const namedIds = new Set((named?.entries ?? []).map((entry) => entry.supplierId));
    const ranked = (ordered?.entries ?? merged.entries).filter(
      (entry) => !namedIds.has(entry.supplierId),
    );
    // Обогащение карточек базы через интернет: после отбора, только показанным (платный поиск).
    const forShow = [...(named?.entries ?? []), ...ranked];
    // Город, найденный в интернете, появляется только здесь (поиск платный и идёт по показанным),
    // поэтому группировка по локации повторяется после обогащения, а метка ставится по тем же
    // данным: иначе «Москва (из интернета)» стояла бы ниже поставщика другого города и без метки.
    // Названные сотрудником остаются первыми вне групп.
    const enriched = await enrichShownSuppliers(deps, context, forShow);
    const namedCount = named?.entries.length ?? 0;
    const arranged = [
      ...enriched.slice(0, namedCount),
      ...regroupByLocation(enriched.slice(namedCount), locations),
    ];
    const shown = arranged.map((entry) => {
      const group = locations.length === 0 ? undefined : assignedLocation(entry, locations);
      return group === undefined ? entry : { ...entry, locationGroup: group };
    });
    // Не показано: всё активное за вычетом показанных (пул сравнения - только его часть).
    // Названные не из результатов поиска в найденные не входили - их не вычитаем.
    const truncated = Math.max(
      0,
      merged.truncated + merged.entries.length - (shown.length - (named?.outsideResults ?? 0)),
    );
    if (named !== undefined) {
      const count = (status: NamedSupplierOutcome['status']): number =>
        named.outcomes.filter((outcome) => outcome.status === status).length;
      deps.log?.('shortlist_named_suppliers', {
        requested: named.outcomes.length,
        added: named.entries.length,
        outsideResults: named.outsideResults,
        notFound: count('not_found'),
        ambiguous: count('ambiguous'),
        inactive: named.outcomes.filter((outcome) => outcome.inactive === true).length,
      });
    }
    if (ordered !== undefined) {
      deps.log?.('shortlist_ranked', {
        method: ordered.method,
        compared: ordered.compared,
        shown: shown.length,
        webShown: webShownCount(shown),
      });
    }
    // Только автоматически исключённые: названные сотрудником «не работаем» теперь в списке.
    const excludedInactive = Math.max(
      0,
      (merged.excludedInactive ?? 0) - (named?.inactiveInResults ?? 0),
    );
    const createdAt = deps.clock.now().toISOString();
    // Заявку ведёт сотрудник, собравший шорт-лист в чате (первый владелец сохраняется при
    // пересборке другим сотрудником). Из планового или дочернего хода владельца нет: тогда
    // тред менеджера по умолчанию, а не служебный тред запуска.
    const subject = workSubject.order(input.requestId);
    await recordWorkOwner(deps.state, subject, context);
    const managerThreadId = await resolveRecipientThread(deps.state, subject, deps.managerThreadId);
    const proposal: ShortlistProposal = {
      requestId: input.requestId,
      // Время в отпечатке: каждая пересборка — новый раунд вопроса менеджеру.
      version: stableHash({ entries: shown, statuses, createdAt }),
      createdAt,
      managerThreadId,
      entries: shown,
      truncated,
      sources: statuses,
      market: merged.market ?? { status: 'none' },
      webMarket: merged.webMarket ?? { status: 'none' },
      // Средняя по каналу пишется, только когда у канала есть цены: при выключенном источнике
      // запись и отпечаток шорт-листа прежние.
      ...(merged.telegramMarket === undefined ? {} : { telegramMarket: merged.telegramMarket }),
      ...(merged.webPricesUnmatched === undefined
        ? {}
        : { webPricesUnmatched: merged.webPricesUnmatched }),
      ...(ordered === undefined
        ? {}
        : { compared: ordered.compared, orderMethod: ordered.method }),
    };
    await saveProposal(deps, proposal);
    return {
      requestId: proposal.requestId,
      version: proposal.version,
      empty: proposal.entries.length === 0,
      entries: proposal.entries.map((entry) => ({
        supplierId: entry.supplierId,
        sources: entry.sources,
        score: roundScore(entry.score),
        hasEmail: entryHasEmail(entry),
        hasPrice: (entry.prices ?? []).length > 0 || webPricesOf(entry).length > 0,
        hasRating: typeof entry.rating === 'number',
      })),
      marketStatus: (proposal.market ?? { status: 'none' }).status,
      pricesFound: proposal.market?.status === 'ok' ? proposal.market.found : 0,
      webMarketStatus: (proposal.webMarket ?? { status: 'none' }).status,
      webPricesFound: proposal.webMarket?.status === 'ok' ? proposal.webMarket.found : 0,
      truncated: proposal.truncated,
      ...baseCounts(proposal.entries),
      ...(deps.supplierCards === undefined || saveSuggestions(proposal.entries).length === 0
        ? {}
        : { cardSaveSuggestions: saveSuggestions(proposal.entries) }),
      ...(excludedInactive === 0 ? {} : { excludedInactive }),
      unavailableSources: statuses
        .filter((item) => item.status !== 'ok')
        .map((item) => ({
          source: item.source,
          status: item.status,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        })),
      ...(named === undefined ? {} : { namedSuppliers: named.outcomes }),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  },
});
