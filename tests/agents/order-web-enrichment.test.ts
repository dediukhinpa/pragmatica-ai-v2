import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryWebPageReader } from '@business-ai/adapters';
import {
  MemoryWebCandidateEnricher,
  MemoryWebQueryPlanner,
} from '../../src/kit/adapters/memory/web-candidate-model';
import {
  WEB_ENRICH_MAX_CANDIDATES,
  WEB_SEARCH_PER_TURN_WITH_ENRICH,
  validateWebQueries,
} from '../../src/agents/order-calc/web-enrichment';
import { WebSearchLimiter } from '@business-ai/core';
import { buildChoiceMessage } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal, saveCompleteness } from '../../src/agents/order-calc/state';
import { searchWeb } from '../../src/agents/order-calc/search-sources';
import { DomainError } from '@business-ai/core';
import { SHORTLIST_MAX_SIZE } from '../../src/kit/domain/shortlist';
import { parseWebPageFacts } from '../../src/kit/domain/web-candidate';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Текст страницы, из которого модель «достаёт» сведения (в тестах - заданный ответ). */
const PAGE_TEXT =
  'Арматура-Центр, Казань. Тел. +7 843 555-01-02, sales@armatura.test, https://armatura.test. ' +
  'Арматура 12 мм от 1 250,50 руб за м. Срок 3-5 дней.';

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps();
});

describe('валидация запросов модели', () => {
  test('оставляет чистые, режет ПДн, токены, длинные и повторы, не больше трёх', () => {
    const raw = [
      'купить арматуру 12 мм оптом',
      'КУПИТЬ арматуру 12 мм оптом',
      'позвонить +7 999 000-11-22',
      'написать ivan@mail.test',
      'арматура [PERSON_1]',
      'x'.repeat(200),
      42,
      'арматура А500С цена',
      'сетка кладочная',
      'ещё один запрос',
    ];
    expect(validateWebQueries(raw)).toEqual([
      'купить арматуру 12 мм оптом',
      'арматура А500С цена',
      'сетка кладочная',
    ]);
    expect(validateWebQueries('не массив')).toEqual([]);
  });
});

describe('searchWeb: запросы модели', () => {
  test('планировщик получает позиции и поля формы, запросы идут в поиск', async () => {
    await saveCompleteness(deps, {
      requestId: REQUEST_ID,
      kind: 'other',
      values: { material: 'сталь А500С' },
      declined: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const planner = new MemoryWebQueryPlanner(() => ['арматура сталь А500С', 'арматура Центр']);
    deps.webQueryPlanner = planner;
    const searched: string[] = [];
    const original = deps.web.search.bind(deps.web);
    deps.web.search = async (query, limit, options) => {
      searched.push(query);
      return original(query, limit, options);
    };
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    expect(planner.seen[0]?.fields).toEqual({ material: 'сталь А500С' });
    expect(planner.seen[0]?.items[0]?.name).toBe('Арматура');
    expect(searched).toEqual(['арматура сталь А500С', 'арматура Центр']);
  });

  test('все запросы модели небезопасны - запасной путь: названия позиций', async () => {
    deps.webQueryPlanner = new MemoryWebQueryPlanner(() => ['звони +7 999 000-11-22']);
    const searched: string[] = [];
    const original = deps.web.search.bind(deps.web);
    deps.web.search = async (query, limit, options) => {
      searched.push(query);
      return original(query, limit, options);
    };
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(searched).toEqual(['Арматура']);
  });

  test('сбой модели не ломает поиск', async () => {
    deps.webQueryPlanner = new MemoryWebQueryPlanner(() => {
      throw new Error('boom');
    });
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out).toMatchObject({ status: 'ok' });
    expect(out.found).toBeGreaterThan(0);
  });
});

describe('searchWeb: обогащение кандидатов', () => {
  test('сведения со страницы попадают в шорт-лист; цена структурно в webPrice', async () => {
    deps.webEnricher = new MemoryWebCandidateEnricher((page) =>
      page.name === 'Арматура-Центр'
        ? {
            city: 'Казань',
            phone: '+7 843 555-01-02',
            email: 'sales@armatura.test',
            site: 'https://armatura.test',
            price: { amount: 1250.5, currency: 'руб', unit: 'м' },
            leadTime: '3-5 дней',
          }
        : {},
    );
    deps.web.search = async () => [
      { title: 'Арматура-Центр', url: 'https://armatura.test', snippet: PAGE_TEXT },
      { title: 'Пустой Поставщик', url: 'https://empty.test', snippet: 'Арматура' },
    ];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    const entry = proposal?.entries.find((item) => item.name === 'Арматура-Центр');
    // Почта с сайта видна модели флагом: иначе агент пишет «почты нет» (29.10)
    const flags = out.entries.find((item) => item.supplierId === entry?.supplierId);
    expect(flags?.hasEmail).toBe(true);
    const bare = proposal?.entries.find((item) => item.name === 'Пустой Поставщик');
    expect(out.entries.find((item) => item.supplierId === bare?.supplierId)?.hasEmail).toBe(false);
    expect(entry).toMatchObject({
      city: 'Казань',
      contacts: 'тел. +7 843 555-01-02, sales@armatura.test, https://armatura.test',
      leadTime: '3-5 дней',
      webPrice: { amount: 1250.5, currency: 'RUB', unit: 'м' },
    });
    expect(entry?.prices).toBeUndefined();
    // Происхождение по полю сохраняется при поиске: всё, что есть у веб-кандидата, из сети.
    expect(entry?.webFields).toEqual(['city', 'contacts', 'leadTime', 'site']);
    expect(bare?.webFields).toEqual(['site']);
    if (proposal === null) throw new Error('нет шорт-листа');
    const lines = buildChoiceMessage(proposal).text.split('\n');
    const at = lines.findIndex((line) => line.includes('Поставщик: Арматура-Центр'));
    expect(lines[at + 1]).toContain('1 250,50 ₽/м (НДС не указан) (ИЗ ИНТЕРНЕТА)');
    expect(lines[at + 2]).toContain('Срок: 3-5 дней (ИЗ ИНТЕРНЕТА)');
    expect(lines[at + 3]).toContain('Рейтинг: нет данных');
    expect(lines[at + 4]).toContain('Город: Казань (ИЗ ИНТЕРНЕТА)');
    expect(lines[at + 5]).toContain('+7 843 555-01-02');
    expect(lines[at + 5]).toContain('(ИЗ ИНТЕРНЕТА)');
    const empty = lines.findIndex((line) => line.includes('Поставщик: Пустой Поставщик'));
    // Кандидат без сведений: пять строк «нет данных» и ссылка.
    expect(lines.slice(empty + 1, empty + 6).every((line) => line.endsWith('нет данных'))).toBe(
      true,
    );
    expect(lines[empty + 6]).toContain('Сайт: https://empty.test (ИЗ ИНТЕРНЕТА)');
    expect(lines[at + 6]).toContain('Сайт: https://armatura.test (ИЗ ИНТЕРНЕТА)');
  });

  /** Выдача из N разных сайтов; запросы `site:` записываются, на них те же сайты отвечают. */
  function stubSites(count: number): string[] {
    const searched: string[] = [];
    deps.web.search = async (query) => {
      searched.push(query);
      return Array.from({ length: count }, (_, index) => ({
        title: `Поставщик ${index}`,
        url: `https://s${index}.test/catalog`,
        snippet: 'арматура',
      }));
    };
    return searched;
  }

  test('в извлечение уходят только названия позиций заявки, а не её поля и заказчик', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webEnricher = enricher;
    deps.web.search = async () => [
      { title: 'Арматура-Центр', url: 'https://armatura.test', snippet: PAGE_TEXT },
    ];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(enricher.seen.length).toBeGreaterThan(0);
    for (const page of enricher.seen) {
      expect(Object.keys(page).sort()).toEqual(['items', 'name', 'texts', 'url']);
      expect(page.items?.every((item) => typeof item === 'string')).toBe(true);
    }
  });

  test('цены страницы по позициям: привязка к позициям заявки, похожий товар помечен', async () => {
    const names = (await deps.requests.get(REQUEST_ID))?.items.map((item) => item.name) ?? [];
    const [first = 'позиция'] = names;
    const enricher = new MemoryWebCandidateEnricher(() => ({
      prices: [
        {
          item: first.toUpperCase(),
          amount: 1305,
          currency: 'RUB',
          unit: '9шт',
          offer: 'Крем',
          exact: false,
        },
        { item: 'чужая позиция', amount: 10, currency: 'RUB' },
      ],
    }));
    deps.webEnricher = enricher;
    deps.web.search = async () => [
      { title: 'Арматура-Центр', url: 'https://armatura.test', snippet: PAGE_TEXT },
    ];
    const events: Array<{ event: string; fields: unknown }> = [];
    deps.log = (event, fields) => void events.push({ event, fields });
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    // Счётчики цен: модель вернула две, к позициям заявки свелась одна (без текстов)
    expect(events.filter((e) => e.event === 'web_enrich_prices').map((e) => e.fields)).toEqual([
      { returned: 2, kept: 1, single: false, pages: 0 },
    ]);
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    const web = proposal?.entries.find((entry) => entry.webPrices !== undefined);
    expect(web?.webPrices).toEqual([
      {
        item: first,
        amount: 1305,
        currency: 'RUB',
        unit: '9 шт',
        offer: 'Крем',
        approximate: true,
      },
    ]);
  });

  test('НДС цены со страницы доходит до шорт-листа, иначе «НДС не указан»', async () => {
    const names = (await deps.requests.get(REQUEST_ID))?.items.map((item) => item.name) ?? [];
    const [first = 'позиция'] = names;
    deps.webEnricher = new MemoryWebCandidateEnricher((page) =>
      page.name === 'Арматура-Центр'
        ? { prices: [{ item: first, amount: 100, currency: 'RUB', vat: 'excluded' }] }
        : { prices: [{ item: first, amount: 200, currency: 'RUB' }] },
    );
    deps.web.search = async () => [
      { title: 'Арматура-Центр', url: 'https://armatura.test', snippet: PAGE_TEXT },
      { title: 'Молчун', url: 'https://molchun.test', snippet: 'Арматура' },
    ];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    if (proposal === null) throw new Error('нет шорт-листа');
    const lines = buildChoiceMessage(proposal).text.split('\n');
    const priceOf = (name: string): string => {
      const at = lines.findIndex((line) => line.includes(`Поставщик: ${name}`));
      return lines[at + 1] ?? '';
    };
    expect(priceOf('Арматура-Центр')).toContain('(без НДС) (ИЗ ИНТЕРНЕТА)');
    expect(priceOf('Молчун')).toContain('(НДС не указан) (ИЗ ИНТЕРНЕТА)');
  });

  test('сбой модели кандидата не убирает', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => {
      throw new Error('boom');
    });
    deps.webEnricher = enricher;
    stubSites(WEB_ENRICH_MAX_CANDIDATES);
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(WEB_ENRICH_MAX_CANDIDATES);
    expect(enricher.seen).toHaveLength(WEB_ENRICH_MAX_CANDIDATES);
  });

  test('обогащаются все показанные (десять), а не три; запрос site:<домен> контакты', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webEnricher = enricher;
    // Лимитер боевой сборки: прежних 8 поисков за ход на весь показ не хватало.
    deps.webSearchLimiter = new WebSearchLimiter({
      clock: new FixedClock(),
      maxPerTurn: WEB_SEARCH_PER_TURN_WITH_ENRICH,
      userMaxPerWindow: 100,
    });
    const searched = stubSites(SHORTLIST_MAX_SIZE);
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(enricher.seen).toHaveLength(SHORTLIST_MAX_SIZE);
    const siteQueries = searched.filter((query) => query.startsWith('site:'));
    expect(siteQueries.sort()).toEqual(
      Array.from({ length: SHORTLIST_MAX_SIZE }, (_, i) => `site:s${i}.test контакты`).sort(),
    );
    // Запрос не по заголовку: названия поставщиков в поиск обогащения не уходят.
    expect(searched.some((query) => query.includes('Поставщик'))).toBe(false);
  });

  test('реальные домены обогащаются; домен с ИНН пропускается без поиска', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webEnricher = enricher;
    const domains = ['armatura.ru', 'shop.ru', '1c-bitrix.ru', '7707083893.ru'];
    const searched: string[] = [];
    deps.web.search = async (query) => {
      searched.push(query);
      return domains.map((domain, index) => ({
        title: `Поставщик ${index}`,
        url: `https://www.${domain}/catalog`,
        snippet: 'арматура',
      }));
    };
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(searched.filter((query) => query.startsWith('site:')).sort()).toEqual([
      'site:1c-bitrix.ru контакты',
      'site:armatura.ru контакты',
      'site:shop.ru контакты',
    ]);
    expect(enricher.seen).toHaveLength(domains.length);
  });

  test('бюджет заявки: кандидатов не больше maxCandidates, поисков не больше maxQueries', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webEnricher = enricher;
    deps.webEnrichBudget = { maxCandidates: 6, maxQueries: 4, concurrency: 2 };
    const searched = stubSites(SHORTLIST_MAX_SIZE);
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(enricher.seen).toHaveLength(6);
    expect(searched.filter((query) => query.startsWith('site:'))).toHaveLength(4);
  });

  test('частичный сбой: упавший поиск или модель одного кандидата не роняет остальных', async () => {
    const enricher = new MemoryWebCandidateEnricher((page) => {
      if (page.name === 'Поставщик 2') throw new Error('boom');
      return { city: 'Казань' };
    });
    deps.webEnricher = enricher;
    deps.web.search = async (query) => {
      if (query === 'site:s1.test контакты') throw new Error('сеть');
      if (query.startsWith('site:')) return [];
      return Array.from({ length: 4 }, (_, index) => ({
        title: `Поставщик ${index}`,
        url: `https://s${index}.test`,
        snippet: 'арматура',
      }));
    };
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(4);
    expect(enricher.seen).toHaveLength(4);
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    const cities = Object.fromEntries(
      (proposal?.entries ?? []).map((entry) => [entry.name, entry.city]),
    );
    // Сбой поиска у s1 модель не остановил; сбой модели у s2 оставил кандидата без города.
    expect(cities).toMatchObject({
      'Поставщик 0': 'Казань',
      'Поставщик 1': 'Казань',
      'Поставщик 3': 'Казань',
    });
    expect(cities['Поставщик 2']).toBeUndefined();
    expect(proposal?.entries.map((entry) => entry.name)).toContain('Поставщик 2');
  });
});

describe('parseWebPageFacts: только форма значений (решение владельца 28.10)', () => {
  test('контакты берутся как ответила модель: почта на .рф, несколько номеров', () => {
    const facts = parseWebPageFacts({
      city: 'Казань',
      phone: '8(800) 555 68 09, +7 (916) 209-56-86',
      email: 'Zakaz@Пчелково.рф',
      site: 'https://xn--b1afpdqbb8d.xn--p1ai/',
      price: { amount: 999, currency: 'RUB' },
    });
    expect(facts).toEqual({
      city: 'Казань',
      phone: '8(800) 555 68 09, +7 (916) 209-56-86',
      email: 'zakaz@пчелково.рф',
      site: 'https://xn--b1afpdqbb8d.xn--p1ai/',
      price: { amount: 999, currency: 'RUB' },
    });
  });

  test('остаётся проверка формы и безопасности ссылки', () => {
    const facts = parseWebPageFacts({
      phone: 'звоните',
      email: 'не указан',
      site: 'javascript:alert(1)',
      leadTime: 'пишите на a@b.test',
    });
    expect(facts).toEqual({});
    expect(parseWebPageFacts({ site: 'https://user:pass@x.ru/' }).site).toBeUndefined();
  });

  test('цена: неизвестная валюта и нулевая сумма отбрасываются', () => {
    const unknown = parseWebPageFacts({ price: { amount: 1250.5, currency: 'XYZ' } });
    expect(unknown.price).toBeUndefined();
    expect(parseWebPageFacts({ price: { amount: 0, currency: 'RUB' } }).price).toBeUndefined();
    expect(parseWebPageFacts('мусор')).toEqual({});
  });
});

describe('searchWeb: чтение страницы сайта при обогащении', () => {
  const FULL = {
    city: 'Казань',
    phone: '+7 843 555-01-02',
    email: 'sales@armatura.test',
    leadTime: '3-5 дней',
  };
  const SITE_TEXT = 'Контакты: Казань, +7 843 555-01-02, sales@armatura.test. Срок 3-5 дней.';
  const reader = (): MemoryWebPageReader =>
    new MemoryWebPageReader({
      'armatura.test': [{ url: 'https://armatura.test/contacts', text: SITE_TEXT }],
    });
  const hits = [{ title: 'Арматура-Центр', url: 'https://armatura.test', snippet: 'Арматура' }];

  function countSearches(): { count: () => number } {
    let calls = 0;
    const original = deps.web.search.bind(deps.web);
    deps.web.search = async (query, limit, options) => {
      calls += 1;
      return original(query, limit, options);
    };
    return { count: () => calls };
  }

  async function shortlistEntry() {
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    return proposal?.entries.find((item) => item.name === 'Арматура-Центр');
  }

  test('страница закрыла город и контакты - платный поиск не вызывается', async () => {
    const enricher = new MemoryWebCandidateEnricher((page) =>
      page.texts.some((text) => text.includes(SITE_TEXT)) ? FULL : {},
    );
    deps.webEnricher = enricher;
    deps.webPageReader = reader();
    deps.web.search = async () => hits;
    const searches = countSearches();
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    // Один поиск плана заявки, уточняющего по названию кандидата нет.
    expect(searches.count()).toBe(1);
    expect(enricher.seen).toHaveLength(1);
    expect(await shortlistEntry()).toMatchObject({ city: 'Казань', leadTime: '3-5 дней' });
  });

  test('на странице пусто - поиск идёт следом, тексты обоих источников в extract', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webEnricher = enricher;
    deps.webPageReader = reader();
    deps.web.search = async () => hits;
    const searches = countSearches();
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(searches.count()).toBe(2);
    expect(enricher.seen).toHaveLength(2);
    expect(enricher.seen[1]?.texts.some((text) => text.includes(SITE_TEXT))).toBe(true);
  });

  test('сбой чтения: кандидат остаётся, поведение прежнее', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({ city: 'Казань' }));
    deps.webEnricher = enricher;
    deps.webPageReader = new MemoryWebPageReader({});
    deps.web.search = async () => hits;
    const searches = countSearches();
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(1);
    expect(searches.count()).toBe(2);
    expect(enricher.seen).toHaveLength(1);
    expect(await shortlistEntry()).toMatchObject({ city: 'Казань' });
  });

  test('сбой транспорта читателя не роняет обогащение', async () => {
    const failing = reader();
    failing.failWith(new DomainError('external_failure', 'gateway down'));
    deps.webEnricher = new MemoryWebCandidateEnricher(() => ({ city: 'Казань' }));
    deps.webPageReader = failing;
    deps.web.search = async () => hits;
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(1);
    expect(await shortlistEntry()).toMatchObject({ city: 'Казань' });
  });

  test('читателя нет - поведение не меняется', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => FULL);
    deps.webEnricher = enricher;
    deps.web.search = async () => hits;
    const searches = countSearches();
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(searches.count()).toBe(2);
    expect(enricher.seen).toHaveLength(1);
    expect(enricher.seen[0]?.texts.some((text) => text.includes('Страница сайта'))).toBe(false);
  });

  test('тексты страницы не попадают в вывод инструмента для модели', async () => {
    deps.webEnricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webPageReader = reader();
    deps.web.search = async () => hits;
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(JSON.stringify(out)).not.toContain('sales@armatura.test');
    expect(JSON.stringify(out)).not.toContain(SITE_TEXT);
  });

  test('лимитер чтений: сверх лимита хода страница не читается, кандидат обогащается', async () => {
    const pages = new MemoryWebPageReader({
      's0.test': [{ url: 'https://s0.test/', text: SITE_TEXT }],
      's1.test': [{ url: 'https://s1.test/', text: SITE_TEXT }],
      's2.test': [{ url: 'https://s2.test/', text: SITE_TEXT }],
    });
    deps.webPageReader = pages;
    deps.webFetchLimiter = new WebSearchLimiter({ clock: new FixedClock(), maxPerTurn: 1 });
    deps.webEnricher = new MemoryWebCandidateEnricher(() => ({ city: 'Казань' }));
    deps.web.search = async () =>
      Array.from({ length: 3 }, (_, index) => ({
        title: `Поставщик ${index}`,
        url: `https://s${index}.test`,
        snippet: 'арматура',
      }));
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(3);
    expect(pages.calls).toHaveLength(1);
  });
});
