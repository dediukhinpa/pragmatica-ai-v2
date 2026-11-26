import { beforeEach, describe, expect, test } from 'bun:test';
import { DomainError, createToolContext } from '@business-ai/core';
import type { ToolContext, WebSearch, WebSearchHit } from '@business-ai/core';
import {
  MemoryPriceRepository,
  MemoryPurchaseRequestRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import {
  MemoryWebCandidateEnricher,
  MemoryWebQueryPlanner,
} from '../../src/kit/adapters/memory/web-candidate-model';
import {
  askManagerToChoose,
  recordManagerChoice,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadChoiceAsk } from '../../src/agents/order-calc/choice-confirmation';
import { recordSelection } from '../../src/agents/order-calc/record-selection';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { loadProposal } from '../../src/agents/order-calc/state';
import { isWebOnlyEntry } from '../../src/kit/domain/shortlist-compare';
import {
  normalizeSupplierName,
  type ShortlistEntry,
} from '../../src/kit/domain/shortlist';
import {
  SHORTLIST_PAGING_PROMPT,
  showMoreSuppliers,
} from '../../src/shortlist-paging';
import {
  SHORTLIST_PAGES_MAX,
  SHORTLIST_PAGE_SIZE,
  SHORTLIST_PAGE_TTL_MS,
  SHORTLIST_WEB_QUERIES_PER_STEP,
  SHORTLIST_WEB_QUERY_SUFFIXES,
  SHORTLIST_WEB_SEARCHES_MAX,
  SHORTLIST_WEB_STEPS_PER_CALL,
  loadPageState,
} from '../../src/shortlist-paging-state';
import {
  MAIL_OWNER,
  ORDER_REQUEST,
  REQUEST_ID,
  buildOrderDeps,
  type OrderTestDeps,
} from '../agents/order-support';
import { MANAGER_THREAD } from '../agents/support';

/** Дата прайса в синтетических данных. */
const PRICE_DATE = '2026-01-01T00:00:00.000Z';
/** Цена первого базового поставщика; каждый следующий дороже на единицу. */
const BASE_PRICE_START = 100;
/** Ширина номера в названиях синтетических поставщиков. */
const NUMBER_WIDTH = 2;
/** Хитов в одной выдаче заглушки поиска (предел платформы на один поиск). */
const HITS_PER_SEARCH = 10;
/** Номера карточек базы, которые не вошли в первую выдачу из четырнадцати. */
const BASE_LEFTOVER = 4;
const BASE_LARGE = 14;
/** Доля страницы, которую добирает интернет, когда из базы пришло четыре. */
const WEB_AFTER_BASE_LEFTOVER = SHORTLIST_PAGE_SIZE - BASE_LEFTOVER;

/** Заглушка веб-поиска: ответ по тексту запроса, все обращения запоминаются. */
class ScriptedWebSearch implements WebSearch {
  readonly calls: string[] = [];
  failure: Error | null = null;

  constructor(private readonly answer: (query: string) => WebSearchHit[]) {}

  async search(query: string, limit: number): Promise<WebSearchHit[]> {
    this.calls.push(query);
    if (this.failure !== null) throw this.failure;
    return this.answer(query).slice(0, limit);
  }

  /** Обращения платного поиска без уточняющих `site:` (их делает обогащение показанных). */
  get searches(): string[] {
    return this.calls.filter((query) => !query.startsWith('site:'));
  }
}

const pad = (n: number): string => String(n).padStart(NUMBER_WIDTH, '0');

/** Хиты выдачи: `count` разных сайтов с названиями «Веб Поставщик <метка>-NN». */
function hitsOf(tag: string, count: number, from = 1): WebSearchHit[] {
  return Array.from({ length: count }, (_, index) => {
    const nn = pad(from + index);
    return {
      title: `Веб Поставщик ${tag}-${nn}`,
      url: `https://web-${tag}-${nn}.test`,
      snippet: 'Арматура оптом',
    };
  });
}

/**
 * Выдача по умолчанию: «Арматура» - первая выдача (метка i), с суффиксом запроса - свежий
 * поиск (метки o, p, s); обращения `site:` ничего не дают.
 */
function defaultAnswer(initialHits: number): (query: string) => WebSearchHit[] {
  return (query) => {
    if (query.startsWith('site:')) return [];
    if (query.endsWith('оптом')) return hitsOf('o', HITS_PER_SEARCH);
    if (query.endsWith('производитель')) return hitsOf('p', HITS_PER_SEARCH);
    if (query.endsWith('поставщик')) return hitsOf('s', HITS_PER_SEARCH);
    return hitsOf('i', initialHits);
  };
}

interface PagingDeps extends Omit<OrderTestDeps, 'web'> {
  web: ScriptedWebSearch;
}

/** Контекст хода сотрудника: у каждой реплики свой номер (лимиты веб-поиска - на ход). */
function turn(number: number): ToolContext {
  return createToolContext({
    threadId: MANAGER_THREAD,
    agentId: 'order-calc',
    operationId: `op-turn-${number}`,
    initiator: { kind: 'user', userId: MAIL_OWNER },
    turnNumber: number,
  });
}

/** Карточка базы с прайсом на «Арматуру»; `website` - сайт карточки. */
async function addBase(
  deps: PagingDeps,
  index: number,
  options: { website?: string; name?: string } = {},
): Promise<void> {
  const id = `base-${pad(index)}`;
  await deps.suppliers.saveCard({
    id,
    name: options.name ?? `Базовый поставщик ${pad(index)}`,
    status: 'active',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...(options.website === undefined ? {} : { website: options.website }),
  });
  await deps.prices.saveImport(
    id,
    [
      {
        supplierId: id,
        productName: 'Арматура 12 мм',
        price: BASE_PRICE_START + index,
        currency: 'RUB',
        date: PRICE_DATE,
      },
    ],
    `seed-${id}`,
  );
}

interface Setup {
  /** Сколько карточек базы с прайсом на позицию заявки. */
  base: number;
  /** Сколько хитов в первой выдаче интернета. */
  web: number;
  answer?: ((query: string) => WebSearchHit[]) | undefined;
}

/** Окружение без лишних поставщиков: только заданные карточки и заглушка поиска. */
async function setup(options: Setup): Promise<PagingDeps> {
  const base = await buildOrderDeps();
  const web = new ScriptedWebSearch(options.answer ?? defaultAnswer(options.web));
  const paging: PagingDeps = {
    ...base,
    suppliers: new MemorySupplierRepository(),
    prices: new MemoryPriceRepository(),
    web,
  };
  for (let index = 1; index <= options.base; index += 1) await addBase(paging, index);
  return paging;
}

/** Первая выдача: поиски, шорт-лист и вопрос менеджеру. */
async function firstPage(deps: PagingDeps): Promise<{ version: string }> {
  const context = turn(1);
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, context);
  await searchWeb.execute({ requestId: REQUEST_ID }, deps, context);
  const built = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, context);
  const ask = { requestId: REQUEST_ID, version: built.version };
  await askManagerToChoose.execute(ask, deps, context);
  return { version: built.version };
}

async function more(deps: PagingDeps, number: number, count?: number) {
  return showMoreSuppliers.execute(
    { requestId: REQUEST_ID, ...(count === undefined ? {} : { count }) },
    deps,
    turn(number),
  );
}

async function entriesOf(deps: PagingDeps): Promise<ShortlistEntry[]> {
  const proposal = await loadProposal(deps, REQUEST_ID);
  if (proposal === null) throw new Error('шорт-лист не сохранён');
  return proposal.entries;
}

const idsOf = (entries: readonly ShortlistEntry[]): string[] =>
  entries.map((entry) => entry.supplierId);
const baseOf = (entries: readonly ShortlistEntry[]): ShortlistEntry[] =>
  entries.filter((entry) => !isWebOnlyEntry(entry));
const webOf = (entries: readonly ShortlistEntry[]): ShortlistEntry[] =>
  entries.filter((entry) => isWebOnlyEntry(entry));

/** Нет ни повторов идентификатора, ни повторов нормализованного названия. */
function expectNoRepeats(entries: readonly ShortlistEntry[]): void {
  expect(new Set(idsOf(entries)).size).toBe(entries.length);
  const names = entries.map((entry) => normalizeSupplierName(entry.name));
  expect(new Set(names).size).toBe(entries.length);
}

/** Новая страница: строки шорт-листа после уже показанных. */
async function newPage(deps: PagingDeps, before: number): Promise<ShortlistEntry[]> {
  return (await entriesOf(deps)).slice(before);
}

/** Текст сообщений, отправленных менеджеру после `skip` исходящих. */
function sentText(deps: PagingDeps, skip: number): string {
  return deps.chat.outbox
    .slice(skip)
    .map((record) => ('message' in record ? record.message.text : ''))
    .join('\n');
}

let deps: PagingDeps;

describe('showMoreSuppliers: соотношение базы и интернета', () => {
  const ratios: Array<{ base: number; first: [number, number]; second: [number, number] }> = [
    { base: 0, first: [0, 10], second: [0, 10] },
    { base: 1, first: [1, 9], second: [0, 10] },
    { base: 7, first: [7, 3], second: [0, 10] },
    { base: 10, first: [10, 0], second: [0, 10] },
    { base: BASE_LARGE, first: [10, 0], second: [BASE_LEFTOVER, WEB_AFTER_BASE_LEFTOVER] },
  ];

  for (const { base, first, second } of ratios) {
    test(`база ${base}: первая выдача ${first.join('+')}, вторая ${second.join('+')}`, async () => {
      deps = await setup({ base, web: HITS_PER_SEARCH });
      await firstPage(deps);
      const page1 = await entriesOf(deps);
      expect([baseOf(page1).length, webOf(page1).length]).toEqual(first);

      const out = await more(deps, 2);
      expect(out.status).toBe('shown');
      expect([out.fromBase, out.fromWeb]).toEqual(second);
      expect(out.page).toBe(2);
      expect(out.shown).toBe(SHORTLIST_PAGE_SIZE);
      const page2 = await newPage(deps, page1.length);
      expect([baseOf(page2).length, webOf(page2).length]).toEqual(second);
      expectNoRepeats(await entriesOf(deps));
      // Страница не пересекается с первой выдачей.
      expect(idsOf(page2).filter((id) => idsOf(page1).includes(id))).toEqual([]);
      // «Почему в списке» и на странице «ещё» собирает код, у каждой строки (замечания 26.11).
      expect(page2.every((entry) => entry.reason !== undefined)).toBe(true);
    });
  }

  test('база кончается посреди выдачи: стр.2 = 4+6, стр.3 - интернет', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
    let rankedCalls = 0;
    const rankedSearch = deps.prices.searchRankedProducts.bind(deps.prices);
    deps.prices.searchRankedProducts = async (query, limit) => {
      rankedCalls += 1;
      return rankedSearch(query, limit);
    };

    const second = await more(deps, 2);
    expect([second.fromBase, second.fromWeb]).toEqual([BASE_LEFTOVER, WEB_AFTER_BASE_LEFTOVER]);
    // Повторный поиск по базе выполнен ровно один раз (по позиции заявки).
    expect(rankedCalls).toBe(1);
    expect((await loadPageState(deps.state, REQUEST_ID))?.baseExhausted).toBe(true);

    const rankedAfterSecond = rankedCalls;
    const third = await more(deps, 3);
    expect([third.fromBase, third.fromWeb]).toEqual([0, SHORTLIST_PAGE_SIZE]);
    // После страницы 2 поиск по базе не повторяется (карточки читаются лишь для дедупликации).
    expect(rankedCalls).toBe(rankedAfterSecond);
    const fourth = await more(deps, 4);
    expect(fourth.fromBase).toBe(0);
    expect(rankedCalls).toBe(rankedAfterSecond);
    expectNoRepeats(await entriesOf(deps));
  });

  test('«7+3»: вторая сразу из интернета, база не ищется', async () => {
    deps = await setup({ base: 7, web: HITS_PER_SEARCH });
    await firstPage(deps);
    let rankedCalls = 0;
    const rankedSearch = deps.prices.searchRankedProducts.bind(deps.prices);
    deps.prices.searchRankedProducts = async (query, limit) => {
      rankedCalls += 1;
      return rankedSearch(query, limit);
    };
    const out = await more(deps, 2);
    expect(rankedCalls).toBe(0);
    expect(out.fromBase).toBe(0);
    expect(out.fromWeb).toBe(SHORTLIST_PAGE_SIZE);
    const state = await loadPageState(deps.state, REQUEST_ID);
    expect(state?.baseExhausted).toBe(true);
    expect(state?.baseExtra).toBeUndefined();
  });

  test('count меньше десяти: показывается столько, сколько просили', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
    const out = await more(deps, 2, 3);
    expect(out.shown).toBe(3);
    // Три из четырёх оставшихся базы: база страницу заполнила, исчерпанной не считается.
    expect(out.fromBase).toBe(3);
    expect((await loadPageState(deps.state, REQUEST_ID))?.baseExhausted).toBe(false);
    const next = await more(deps, 3, 3);
    // Осталась одна из базы, две добирает интернет, и база исчерпана.
    expect([next.fromBase, next.fromWeb]).toEqual([1, 2]);
    expect((await loadPageState(deps.state, REQUEST_ID))?.baseExhausted).toBe(true);
  });
});

describe('showMoreSuppliers: повторы, кэш и пределы', () => {
  test('пять страниц подряд без повторов; шестая - предел страниц', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
    const statuses: string[] = [];
    for (let number = 2; number <= SHORTLIST_PAGES_MAX; number += 1) {
      const out = await more(deps, number);
      statuses.push(out.status);
      expect(out.page).toBe(number);
      expect(out.exhausted).toBe(number === SHORTLIST_PAGES_MAX);
    }
    expect(statuses).toEqual(['shown', 'shown', 'shown', 'shown']);
    const all = await entriesOf(deps);
    expect(all).toHaveLength(SHORTLIST_PAGES_MAX * SHORTLIST_PAGE_SIZE);
    expectNoRepeats(all);
    const searchesBefore = deps.web.searches.length;
    const stop = await more(deps, SHORTLIST_PAGES_MAX + 1);
    expect(stop.status).toBe('pages_limit');
    expect(stop.exhausted).toBe(true);
    expect(stop.shown).toBe(0);
    // На пределе страниц новых обращений наружу нет.
    expect(deps.web.searches).toHaveLength(searchesBefore);
    expect(await entriesOf(deps)).toHaveLength(all.length);
  });

  test('второе «ещё» берёт найденное из кэша без нового поиска', async () => {
    const planned = ['Арматура', 'Арматура сетка'];
    const answer = (query: string): WebSearchHit[] => {
      if (query.startsWith('site:')) return [];
      if (query === 'Арматура') return hitsOf('i', HITS_PER_SEARCH);
      if (query === 'Арматура оптом') return hitsOf('a', HITS_PER_SEARCH);
      if (query === 'Арматура сетка оптом') return hitsOf('b', HITS_PER_SEARCH);
      return [];
    };
    deps = await setup({ base: 0, web: 0, answer });
    deps.webQueryPlanner = new MemoryWebQueryPlanner(() => planned);
    await firstPage(deps);

    const second = await more(deps, 2);
    expect(second.fromWeb).toBe(SHORTLIST_PAGE_SIZE);
    const state2 = await loadPageState(deps.state, REQUEST_ID);
    // Один шаг дал два запроса и двадцать кандидатов: десять показаны, десять в кэше.
    expect(deps.web.searches.filter((query) => query.endsWith('оптом'))).toHaveLength(2);
    expect(state2?.webCache.candidates.length).toBeGreaterThan(0);

    const searchesBefore = deps.web.searches.length;
    const third = await more(deps, 3);
    expect(third.fromWeb).toBe(SHORTLIST_PAGE_SIZE);
    expect(deps.web.searches).toHaveLength(searchesBefore);
    expectNoRepeats(await entriesOf(deps));
  });

  test('поисков на состояние не больше предела, за вызов - не больше шагов', async () => {
    const planned = ['Арматура', 'Арматура сетка', 'Арматура балка'];
    const answer = (): WebSearchHit[] => [];
    deps = await setup({ base: 0, web: 0, answer });
    deps.webQueryPlanner = new MemoryWebQueryPlanner(() => planned);
    await firstPage(deps);
    const initial = deps.web.searches.length;
    const perStep = SHORTLIST_WEB_QUERIES_PER_STEP;

    const first = await more(deps, 2);
    expect(first.status).toBe('no_new');
    // За один вызов - не больше шагов, поиск ещё не исчерпан.
    expect(deps.web.searches.length - initial).toBe(SHORTLIST_WEB_STEPS_PER_CALL * perStep);
    expect(first.exhausted).toBe(false);

    const second = await more(deps, 3);
    expect(deps.web.searches.length - initial).toBe(SHORTLIST_WEB_SEARCHES_MAX);
    expect(second.exhausted).toBe(true);
    expect(second.message).toContain('Новых подходящих поставщиков нет');

    const total = deps.web.searches.length;
    const third = await more(deps, 4);
    expect(third.exhausted).toBe(true);
    expect(deps.web.searches).toHaveLength(total);
    // Шагов суффиксов столько, сколько формулировок: дальше свежий поиск не идёт.
    expect(SHORTLIST_WEB_QUERY_SUFFIXES.length * perStep).toBe(SHORTLIST_WEB_SEARCHES_MAX);
  });

  test('«новых нет»: честный ответ без показа и без повторов', async () => {
    deps = await setup({ base: 3, web: 0, answer: () => [] });
    await firstPage(deps);
    const before = await entriesOf(deps);
    const outbox = deps.chat.outbox.length;
    // Формулировок поиска больше, чем шагов за один вызов: полная проверка - за два «ещё».
    const partial = await more(deps, 2);
    expect(partial.exhausted).toBe(false);
    const out = await more(deps, 3);
    expect(out.status).toBe('no_new');
    expect(out.exhausted).toBe(true);
    expect(out.shown).toBe(0);
    expect(out.message).toContain('Новых подходящих поставщиков нет');
    // Страница не отправлялась, шорт-лист не менялся.
    expect(deps.chat.outbox).toHaveLength(outbox);
    expect(await entriesOf(deps)).toEqual(before);
  });

  test('ограничение поиска не считается исчерпанием и не теряет найденное', async () => {
    deps = await setup({ base: 0, web: 0 });
    await firstPage(deps);
    deps.web.failure = new DomainError('external_failure', 'лимит');
    const limited = await more(deps, 2);
    expect(limited.status).toBe('no_new');
    expect(limited.exhausted).toBe(false);
    expect(limited.webLimited).toBe(true);
    deps.web.failure = null;
    const next = await more(deps, 3);
    expect(next.status).toBe('shown');
    expect(next.fromWeb).toBe(SHORTLIST_PAGE_SIZE);
  });
});

describe('showMoreSuppliers: сброс состояния', () => {
  beforeEach(async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
  });

  test('смена критериев заявки: выдача устарела, состояние забыто', async () => {
    await more(deps, 2);
    // Заглушка хранилища не перезаписывает заявку: подменяем хранилище целиком.
    const changed = new MemoryPurchaseRequestRepository();
    await changed.save({ ...ORDER_REQUEST, items: [{ name: 'Швеллер', quantity: 10, unit: 'м' }] });
    deps.requests = changed;
    const out = await more(deps, 3);
    expect(out.status).toBe('criteria_changed');
    expect(out.shown).toBe(0);
    expect(await loadPageState(deps.state, REQUEST_ID)).toBeNull();
  });

  test('шорт-лист пересобран: состояние начинается заново от текущего списка', async () => {
    await more(deps, 2);
    const stale = await loadPageState(deps.state, REQUEST_ID);
    const context = turn(10);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, context);
    const rebuilt = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, context);
    expect(rebuilt.version).not.toBe(stale?.proposalVersion);
    const out = await more(deps, 11);
    expect(out.status).toBe('shown');
    // Страница 2 нового шорт-листа: прежние страницы не помнятся, номер - 2.
    expect(out.page).toBe(2);
    const state = await loadPageState(deps.state, REQUEST_ID);
    expect(state?.proposalVersion).toBe(out.version);
    expectNoRepeats(await entriesOf(deps));
  });

  test('срок вышел: «ещё» продолжается от расширенного списка', async () => {
    await more(deps, 2);
    deps.clock.advance(SHORTLIST_PAGE_TTL_MS + 1);
    const out = await more(deps, 3);
    expect(out.status).toBe('shown');
    expect(out.totalShown).toBe(SHORTLIST_PAGE_SIZE * 3);
    expectNoRepeats(await entriesOf(deps));
  });

  test('шорт-листа нет: подсказка собрать его', async () => {
    const empty = await setup({ base: 1, web: 0 });
    const out = await more(empty, 2);
    expect(out.status).toBe('no_shortlist');
    expect(out.message).toContain('buildShortlist');
  });
});

describe('showMoreSuppliers: дедупликация веб-кандидатов с базой', () => {
  test('совпавшие с карточкой базы не выдаются как интернет', async () => {
    const answer = (query: string): WebSearchHit[] => {
      if (query.startsWith('site:')) return [];
      if (query.endsWith('оптом')) {
        return [
          // Тот же сайт, что у карточки из пула базы.
          { title: 'Веб Поставщик o-01', url: 'https://base-site-01.test', snippet: 'х' },
          // Название совпало с карточкой вне пула (нет прайса на позицию).
          { title: 'Веб Поставщик o-02', url: 'https://web-o-02.test', snippet: 'х' },
          // Сайт совпал с карточкой вне пула, название другое.
          { title: 'Веб Поставщик o-03', url: 'https://web-o-03.test', snippet: 'х' },
          ...hitsOf('o', 7, 4),
        ];
      }
      if (query.endsWith('производитель')) return hitsOf('p', HITS_PER_SEARCH);
      return [];
    };
    deps = await setup({ base: 0, web: 0, answer });
    for (let index = 1; index <= SHORTLIST_PAGE_SIZE + 1; index += 1) {
      await addBase(deps, index, { website: `https://base-site-${pad(index)}.test` });
    }
    await deps.suppliers.saveCard({
      id: 'card-name',
      name: 'ООО «Веб Поставщик o-02»',
      status: 'active',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    await deps.suppliers.saveCard({
      id: 'card-site',
      name: 'Веб Поставщик o-03 Групп',
      status: 'active',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
      website: 'https://web-o-03.test',
    });
    await firstPage(deps);
    const before = (await entriesOf(deps)).length;
    const out = await more(deps, 2);
    expect(out.status).toBe('shown');
    const page = await newPage(deps, before);
    const names = page.map((entry) => entry.name);
    expect(names).not.toContain('Веб Поставщик o-01');
    expect(names).not.toContain('Веб Поставщик o-02');
    expect(names).not.toContain('Веб Поставщик o-03');
    // Остальные из той же выдачи доступны как «из интернета».
    expect(names).toContain('Веб Поставщик o-04');
    expectNoRepeats(await entriesOf(deps));
  });

  test('показанная карточка базы запоминается ключами сайта и ИНН', async () => {
    deps = await setup({ base: 0, web: 0 });
    // Синтетический ИНН юрлица с верной контрольной суммой.
    const inn = '7707083893';
    await addBase(deps, 1, { website: 'https://www.base-site-01.test/about' });
    const card = await deps.suppliers.getCard('base-01');
    if (card === null) throw new Error('нет карточки');
    await deps.suppliers.saveCard({ ...card, inn });
    await firstPage(deps);
    await more(deps, 2);
    const state = await loadPageState(deps.state, REQUEST_ID);
    expect(state?.shownKeys).toContain(`inn:${inn}`);
    expect(state?.shownKeys).toContain('dom:base-site-01.test');
  });
});

describe('showMoreSuppliers: показ, выбор и обогащение', () => {
  test('менеджеру уходит только новая страница, нумерация продолжается', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
    const sent = deps.chat.outbox.length;
    const before = await entriesOf(deps);
    await more(deps, 2);
    const text = sentText(deps, sent);
    expect(text).toMatch(/^11\. Поставщик:/m);
    expect(text).toMatch(/^20\. Поставщик:/m);
    expect(text).not.toMatch(/^10\. Поставщик:/m);
    for (const entry of before) expect(text).not.toContain(entry.name);
    expect(text).toContain('Из базы знаний: 4, из интернета: 6.');
  });

  test('выбор по сквозному номеру со второй страницы записывается и фиксируется', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
    const out = await more(deps, 2);
    const all = await entriesOf(deps);
    expect(all).toHaveLength(SHORTLIST_PAGE_SIZE * 2);
    const ask = await loadChoiceAsk(deps.state, MANAGER_THREAD);
    expect(ask?.version).toBe(out.version);
    expect(ask?.entries).toHaveLength(all.length);

    const context = turn(3);
    const picked = await recordManagerChoice.execute(
      { requestId: REQUEST_ID, decision: 'picked', picks: ['12'] },
      deps,
      context,
    );
    expect(picked.status).toBe('recorded');
    expect(picked.chosen).toEqual([all[11]?.name ?? '']);
    const selected = await recordSelection.execute({ requestId: REQUEST_ID }, deps, context);
    expect(selected.selected).toBe(1);
  });

  test('прежний выбор менеджера не переносится: просьба спросить заново', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    await firstPage(deps);
    const choice = await recordManagerChoice.execute(
      { requestId: REQUEST_ID, decision: 'picked', picks: ['1'] },
      deps,
      turn(2),
    );
    expect(choice.status).toBe('recorded');
    const out = await more(deps, 3);
    expect(out.choiceNeedsRepeat).toBe(true);
  });

  test('обогащаются только показанные веб-кандидаты, не весь кэш', async () => {
    const planned = ['Арматура', 'Арматура сетка'];
    const answer = (query: string): WebSearchHit[] => {
      if (query.startsWith('site:')) return [];
      if (query === 'Арматура') return hitsOf('i', HITS_PER_SEARCH);
      if (query === 'Арматура оптом') return hitsOf('a', HITS_PER_SEARCH);
      if (query === 'Арматура сетка оптом') return hitsOf('b', HITS_PER_SEARCH);
      return [];
    };
    deps = await setup({ base: 0, web: 0, answer });
    deps.webQueryPlanner = new MemoryWebQueryPlanner(() => planned);
    await firstPage(deps);
    const enricher = new MemoryWebCandidateEnricher(() => ({ city: 'Тестоград' }));
    deps.webEnricher = enricher;
    await more(deps, 2);
    // Найдено двадцать, показано десять: страницы читаются и разбираются только у десяти.
    expect(enricher.seen.length).toBeGreaterThan(0);
    expect(enricher.seen.length).toBeLessThanOrEqual(SHORTLIST_PAGE_SIZE);
    const page = await newPage(deps, SHORTLIST_PAGE_SIZE);
    expect(page.every((entry) => entry.city === 'Тестоград')).toBe(true);
  });

  test('названные сотрудником поставщики не засчитываются как места базы', async () => {
    deps = await setup({ base: 9, web: HITS_PER_SEARCH });
    await deps.suppliers.saveCard({
      id: 'named-1',
      name: 'Названный Поставщик',
      status: 'active',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    const context = turn(1);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, context);
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, context);
    await buildShortlist.execute(
      { requestId: REQUEST_ID, namedSuppliers: ['Названный Поставщик'] },
      deps,
      context,
    );
    const first = await entriesOf(deps);
    expect(first[0]?.namedByManager).toBe(true);
    // Девять из базы вне названного - страница не заполнена, база исчерпана.
    const out = await more(deps, 2);
    expect(out.fromBase).toBe(0);
    expect((await loadPageState(deps.state, REQUEST_ID))?.baseExhausted).toBe(true);
  });

  test('сбой отправки страницы возвращает состояние: повтор показывает её целиком', async () => {
    deps = await setup({ base: BASE_LARGE, web: HITS_PER_SEARCH });
    const { version } = await firstPage(deps);
    const reply = deps.chat.reply.bind(deps.chat);
    deps.chat.reply = async (threadId, message, key) => {
      if (key.startsWith('order-more:')) throw new Error('канал недоступен');
      return reply(threadId, message, key);
    };
    await expect(more(deps, 2)).rejects.toThrow('канал недоступен');
    expect((await loadProposal(deps, REQUEST_ID))?.version).toBe(version);
    deps.chat.reply = reply;
    const out = await more(deps, 3);
    expect(out.status).toBe('shown');
    expect(out.page).toBe(2);
    expect(out.totalShown).toBe(SHORTLIST_PAGE_SIZE * 2);
    expectNoRepeats(await entriesOf(deps));
  });
});

describe('showMoreSuppliers: описание инструмента и промпт', () => {
  test('ключ идемпотентности «на ход»: другая реплика - другая операция', async () => {
    deps = await setup({ base: 1, web: 0 });
    const input = { requestId: REQUEST_ID, count: SHORTLIST_PAGE_SIZE };
    const predecessor = showMoreSuppliers.idempotencyPredecessor;
    if (predecessor === undefined) throw new Error('нет предшественника');
    const first = await predecessor(input, deps, MANAGER_THREAD, 1);
    const same = await predecessor(input, deps, MANAGER_THREAD, 1);
    const next = await predecessor(input, deps, MANAGER_THREAD, 2);
    expect(same).toBe(first);
    expect(next).not.toBe(first);
    expect(showMoreSuppliers.sideEffect).toBe(true);
  });

  test('промпт называет инструмент, статусы и честный ответ без выдумок', () => {
    expect(SHORTLIST_PAGING_PROMPT).toContain('showMoreSuppliers');
    expect(SHORTLIST_PAGING_PROMPT).toContain('«ещё 10»');
    expect(SHORTLIST_PAGING_PROMPT).toContain('новых подходящих поставщиков нет');
    expect(SHORTLIST_PAGING_PROMPT).toContain('не придумывай');
  });
});
