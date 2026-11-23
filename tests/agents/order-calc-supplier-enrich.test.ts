import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryWebPageReader, MemoryWebSearch } from '@business-ai/adapters';
import {
  MemoryWebCandidateEnricher,
  MemorySupplierSiteChooser,
} from '../../src/kit/adapters/memory/web-candidate-model';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { createToolContext, WebSearchLimiter, type ToolContext } from '@business-ai/core';
import { loadProposal, saveSelection } from '../../src/agents/order-calc/state';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import { SUPPLIER_ENRICH_NAMESPACE } from '../../src/agents/order-calc/supplier-enrich';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { entryLines } from '../../src/agents/order-calc/shortlist-message';
import type { WebSearchHit } from '@business-ai/core';
import { DomainError } from '@business-ai/core';
import {
  parseSupplierNameVerdict,
  parseSupplierSiteChoice,
} from '../../src/kit/domain/supplier-registry';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

// Только синтетика: вымышленные компании, ИНН с верной контрольной суммой.
const INN = '1234567894';
const OTHER_INN = '9876543210';
const REGISTRY_URL = 'https://checko.ru/company/luna-pak-1027700000001';
const OTHER_REGISTRY_URL = 'https://www.rusprofile.ru/id/1000001';
const SITE = 'https://luna-pack.example';
const DIRECTOR = 'Руководов Иван Петрович';

/** Страница реестра в духе checko (JSON-LD); `inn` и сайт подставляются. */
function registryHtml(inn: string, site = SITE): string {
  return `<html><head><title>ООО "ЛУНА-ПАК" - Казань - ИНН ${inn}</title>
<script type="application/ld+json">{"@type":"Organization","name":"ООО \\"ЛУНА-ПАК\\"",
"taxID":"${inn}","telephone":"+78435550101","email":"sales@luna-pack.example",
"address":{"streetAddress":"ул. Тестовая, д. 1","addressLocality":"г. Казань"}}</script></head>
<body><strong>Веб-сайт</strong> <a href="${site}/">сайт</a>
<div>Руководитель: <a href="/person/1">${DIRECTOR}</a></div></body></html>`;
}

const HITS: WebSearchHit[] = [
  { title: 'Луна-Пак реквизиты', url: REGISTRY_URL, snippet: 'ООО Луна-Пак Казань' },
  { title: 'Луна-Пак профиль', url: OTHER_REGISTRY_URL, snippet: 'ООО Луна-Пак профиль' },
];

interface Harness {
  deps: OrderTestDeps;
  reader: MemoryWebPageReader;
  logged: Array<{ event: string; fields: Record<string, string | number | boolean> }>;
  searches: number;
}

async function harness(
  options: {
    card?: { inn?: string; name?: string; contacts?: boolean; city?: string; website?: string };
    registry?: Record<string, string>;
    pages?: Record<string, Array<{ url: string; text: string }>>;
    enricher?: MemoryWebCandidateEnricher;
    chooser?: MemorySupplierSiteChooser;
    hits?: WebSearchHit[];
  } = {},
): Promise<Harness> {
  const deps = await buildOrderDeps({
    request: { ...ORDER_REQUEST, items: [{ name: 'Мёд липовый', quantity: 30, unit: 'шт' }] },
  });
  const card = options.card ?? { inn: INN };
  await deps.suppliers.saveCard({
    id: 'luna',
    name: card.name ?? 'ООО Луна-Пак',
    status: 'new',
    ...(card.inn === undefined ? {} : { inn: card.inn }),
    ...(card.city === undefined ? {} : { productionCity: card.city }),
    ...(card.website === undefined ? {} : { website: card.website }),
    contacts: card.contacts === true ? [{ email: 'old@luna.example', isPrimary: true }] : [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  });
  await deps.prices.saveImport(
    'luna',
    [
      {
        supplierId: 'luna',
        productName: 'Мёд липовый',
        price: 400,
        currency: 'RUB',
        date: '2026-01-01',
      },
    ],
    'seed-luna',
  );
  const registry = options.registry ?? { [REGISTRY_URL]: registryHtml(INN) };
  const reader = new MemoryWebPageReader(
    options.pages ?? {},
    Object.fromEntries(
      Object.entries(registry).map(([url, html]) => [url, { url, text: 'страница', html }]),
    ),
  );
  const web = new MemoryWebSearch(options.hits ?? HITS);
  const harnessDeps: OrderTestDeps = Object.assign(deps, {
    web,
    webPageReader: reader,
    supplierEnrich: { concurrency: 1 },
    ...(options.enricher === undefined ? {} : { webEnricher: options.enricher }),
    ...(options.chooser === undefined ? {} : { supplierSiteChooser: options.chooser }),
  });
  const logged: Harness['logged'] = [];
  harnessDeps.log = (event, fields) => logged.push({ event, fields: fields ?? {} });
  const result: Harness = { deps: harnessDeps, reader, logged, searches: 0 };
  const original = web.search.bind(web);
  web.search = async (...args) => {
    result.searches += 1;
    return original(...args);
  };
  return result;
}

async function build(
  h: Harness,
  context: ToolContext = CTX,
): ReturnType<typeof buildShortlist.execute> {
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, h.deps, context);
  return buildShortlist.execute({ requestId: REQUEST_ID, limit: 10 }, h.deps, context);
}

async function entryOf(h: Harness) {
  const proposal = await loadProposal(h.deps, REQUEST_ID);
  return proposal?.entries.find((entry) => entry.supplierId === 'luna');
}

describe('обогащение карточек базы: правила совпадения', () => {
  test('ИНН карточки совпал со страницей реестра: город, контакты, сайт; без ФИО', async () => {
    const h = await harness();
    await build(h);
    const entry = await entryOf(h);
    expect(entry?.webEnrichment).toMatchObject({
      match: 'inn',
      city: 'Казань',
      phone: '+78435550101',
      email: 'sales@luna-pack.example',
      site: SITE,
    });
    expect(JSON.stringify(entry)).not.toContain('Руководов');
    expect(h.reader.urlCalls).toEqual([REGISTRY_URL]);
  });

  test('первая страница без контактов (rusprofile), вторая полная: сливаются', async () => {
    const bare = `<html><head><script type="application/ld+json">{"@type":"Organization",
"name":"ООО \\"ЛУНА-ПАК\\"","taxID":"${INN}","address":{"addressLocality":"г. Казань"}}</script>
</head><body></body></html>`;
    const h = await harness({
      card: { name: 'Луна-Пак Казань' },
      registry: { [REGISTRY_URL]: bare, [OTHER_REGISTRY_URL]: registryHtml(INN) },
    });
    await build(h);
    expect((await entryOf(h))?.webEnrichment).toMatchObject({
      match: 'name',
      city: 'Казань',
      phone: '+78435550101',
      email: 'sales@luna-pack.example',
      site: SITE,
    });
    expect(h.reader.urlCalls).toEqual([REGISTRY_URL, OTHER_REGISTRY_URL]);
  });

  test('вторая страница - другое юрлицо (другой ИНН): не сливается', async () => {
    const bare = `<html><head><script type="application/ld+json">{"@type":"Organization",
"name":"ООО \\"ЛУНА-ПАК\\"","taxID":"${INN}","address":{"addressLocality":"г. Казань"}}</script>
</head><body></body></html>`;
    const h = await harness({
      card: { name: 'Луна-Пак Казань' },
      registry: { [REGISTRY_URL]: bare, [OTHER_REGISTRY_URL]: registryHtml(OTHER_INN) },
    });
    await build(h);
    const enrichment = (await entryOf(h))?.webEnrichment;
    expect(enrichment?.city).toBe('Казань');
    expect(enrichment?.phone).toBeUndefined();
  });

  test('ИНН карточки не совпал: страница отклонена, обогащения нет', async () => {
    const h = await harness({ registry: { [REGISTRY_URL]: registryHtml(OTHER_INN) } });
    await build(h);
    expect((await entryOf(h))?.webEnrichment).toBeUndefined();
  });

  test('без ИНН: совпадение по названию с пометкой «проверьте», к записи не предлагается', async () => {
    const h = await harness({ card: {} });
    const out = await build(h);
    const entry = await entryOf(h);
    expect(entry?.webEnrichment?.match).toBe('name');
    const text = entry === undefined ? '' : entryLines(entry, 0).join('\n');
    expect(text).toContain('Казань (ИЗ ИНТЕРНЕТА)');
    expect(text).toContain('+78435550101, sales@luna-pack.example (ИЗ ИНТЕРНЕТА)');
    expect(text).toContain('совпадение по названию, проверьте');
    expect(out.cardSaveSuggestions).toBeUndefined();
  });

  test('без ИНН и другое название на странице: не принимается', async () => {
    const h = await harness({ card: { name: 'Совсем Другая Фирма' } });
    await build(h);
    expect((await entryOf(h))?.webEnrichment).toBeUndefined();
  });

  test('есть данные в карточке - они не подменяются найденным', async () => {
    const h = await harness({ card: { inn: INN, city: 'Тверь', contacts: true } });
    await build(h);
    const found = (await entryOf(h))?.webEnrichment;
    expect(found?.city).toBeUndefined();
    expect(found?.email).toBeUndefined();
    expect(found?.phone).toBe('+78435550101');
  });

  test('карточка полная: поиск не запускается', async () => {
    const h = await harness({
      card: { inn: INN, city: 'Тверь', contacts: true, website: 'https://x.example' },
    });
    // Телефона нет в карточке, остальное есть: поиск всё равно нужен только для телефона.
    await build(h);
    expect(h.searches).toBe(1);
    const full = await harness({ card: { inn: INN } });
    await full.deps.suppliers.saveCard({
      id: 'luna',
      name: 'ООО Луна-Пак',
      status: 'new',
      inn: INN,
      productionCity: 'Тверь',
      website: 'https://x.example',
      contacts: [{ email: 'a@x.example', phone: '+79990000000', isPrimary: true }],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    await build(full);
    expect(full.searches).toBe(0);
  });
});

describe('обогащение карточек базы: подтверждение, кэш, бюджет, журнал', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  test('предложение сохранить - только при инструменте карточек и совпадении по ИНН', async () => {
    const without = await build(h);
    expect(without.cardSaveSuggestions).toBeUndefined();
    const withCards = await harness();
    withCards.deps.supplierCards = {} as never;
    const out = await build(withCards);
    expect(out.cardSaveSuggestions).toEqual([
      {
        supplierId: 'luna',
        changes: {
          website: SITE,
          productionCity: 'Казань',
          contacts: [{ email: 'sales@luna-pack.example', phone: '+78435550101' }],
        },
      },
    ]);
    // В карточку код сам не пишет.
    const card = await withCards.deps.suppliers.getCard('luna');
    expect(card?.productionCity).toBeUndefined();
    expect(card?.contacts).toEqual([]);
  });

  test('кэш на 30 дней: повторная сборка не ищет и не читает; через 31 день - заново', async () => {
    await build(h);
    expect(h.searches).toBe(1);
    await build(h);
    expect(h.searches).toBe(1);
    expect(h.reader.urlCalls).toHaveLength(1);
    expect((await entryOf(h))?.webEnrichment?.match).toBe('inn');
    // Через 31 день кэш устарел: поиск повторяется.
    h.deps.clock.advance(31 * 24 * 3_600_000);
    await build(h);
    expect(h.searches).toBe(2);
    const stored = await h.deps.state.get(SUPPLIER_ENRICH_NAMESPACE, 'luna');
    expect(stored).not.toBeNull();
  });

  test('«не нашли» не кэшируется: следующая сборка ищет заново и находит', async () => {
    const empty = await harness({ registry: {} });
    await build(empty);
    await build(empty);
    // На сборку два поиска: к реестрам и, раз сайта нет, к сайту компании
    expect(empty.searches).toBe(4);
    expect(await empty.deps.state.get(SUPPLIER_ENRICH_NAMESPACE, 'luna')).toBeNull();
  });

  test('лимиты хода исчерпаны (поиск и чтения): обогащение всё равно идёт', async () => {
    const h = await harness();
    // Лимиты хода уже заняты (как поисками и сайтами веб-кандидатов того же хода)
    const { threadId, turnNumber, initiator } = CTX;
    const busy = (): WebSearchLimiter => {
      const limiter = new WebSearchLimiter({ clock: new FixedClock(), maxPerTurn: 1 });
      limiter.acquire({ threadId, turnNumber, initiator });
      return limiter;
    };
    h.deps.webUrlReadLimiter = busy();
    h.deps.webSearchLimiter = busy();
    await build(h);
    expect(h.searches).toBe(1);
    expect(h.reader.urlCalls).toEqual([REGISTRY_URL]);
    expect((await entryOf(h))?.webEnrichment?.match).toBe('inn');
  });

  test('пределов на сборку нет: обогащаются все показанные поставщики', async () => {
    const h = await harness();
    await build(h);
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).not.toHaveProperty(
      'skippedBudget',
    );
  });

  test('журнал supplier_enrich: числа без названий и контактов', async () => {
    await build(h);
    const event = h.logged.find((item) => item.event === 'supplier_enrich');
    expect(event?.fields).toMatchObject({
      candidates: 1,
      tried: 1,
      registryHit: 1,
      siteHit: 0,
      innMatched: 1,
    });
    const text = JSON.stringify(event);
    for (const secret of ['Луна', 'luna', 'Казань', '8435550101', INN]) {
      expect(text).not.toContain(secret);
    }
  });

  test('сбой поиска: поставщик остаётся, ничего не кэшируется', async () => {
    const failing = await harness();
    failing.deps.web.failWith(new DomainError('external_failure', 'x'));
    const out = await build(failing);
    expect(out.entries.map((entry) => entry.supplierId)).toContain('luna');
    expect(await failing.deps.state.get(SUPPLIER_ENRICH_NAMESPACE, 'luna')).toBeNull();
    expect(failing.logged.some((item) => item.event === 'supplier_enrich_failed')).toBe(true);
  });

  test('без readUrl у читателя обогащение выключено', async () => {
    const plain = await harness();
    plain.deps.webPageReader = { readSite: plain.reader.readSite.bind(plain.reader) };
    await build(plain);
    expect(plain.searches).toBe(0);
  });
});

describe('обогащение карточек базы: сайт поставщика', () => {
  test('сайт с реестра читается обогащением; модели уходят только тексты сайта', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({
      city: 'Казань',
      phone: '+7 843 555-77-88',
    }));
    const registry = registryHtml(INN).replace('"telephone":"+78435550101",', '');
    const h = await harness({
      registry: { [REGISTRY_URL]: registry.replace('"email":"sales@luna-pack.example",', '') },
      pages: {
        'luna-pack.example': [{ url: `${SITE}/`, text: 'Главная. Казань, тел. +7 843 555-77-88' }],
      },
      enricher,
    });
    await build(h);
    const found = (await entryOf(h))?.webEnrichment;
    expect(found?.phone).toBe('+7 843 555-77-88');
    expect(found?.city).toBe('Казань');
    expect(enricher.seen).toHaveLength(1);
    const sent = JSON.stringify(enricher.seen);
    expect(sent).toContain('Главная');
    expect(sent).not.toContain('Руководов');
    expect(sent).not.toContain('checko');
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
      siteHit: 1,
    });
  });
});

describe('обогащение карточек базы: сайт из выдачи поиска', () => {
  const siteHit: WebSearchHit = {
    title: 'Луна-Пак — упаковка для мёда',
    url: `${SITE}/?ysclid=1`,
    snippet: 'Луна-Пак упаковка',
  };

  test('реестр не совпал: сайт из выдачи читается, совпадение по названию', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({ phone: '+7 843 555-77-88' }));
    const h = await harness({
      // Хвост имени файла «новинки» и товар «Коробки» не мешают найти компанию
      card: { name: 'Луна-Пак Коробки новинки' },
      registry: {},
      hits: [...HITS, siteHit],
      pages: { 'luna-pack.example': [{ url: `${SITE}/`, text: 'Главная. тел. +7 843 555-77-88' }] },
      enricher,
    });
    await build(h);
    expect((await entryOf(h))?.webEnrichment).toMatchObject({
      match: 'name',
      site: SITE,
      phone: '+7 843 555-77-88',
    });
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
      searchSite: 1,
    });
  });

  test('совпадение по ИНН: сайт из выдачи не берётся', async () => {
    const h = await harness({
      registry: { [REGISTRY_URL]: registryHtml(INN).replace(/<a href="[^"]+\/">сайт<\/a>/u, '') },
      hits: [...HITS, siteHit],
    });
    await build(h);
    const found = (await entryOf(h))?.webEnrichment;
    expect(found?.match).toBe('inn');
    expect(found?.site).toBeUndefined();
    expect(h.searches).toBe(1);
  });
});

describe('текст запроса поставщику: почта из интернета', () => {
  test('вместо «адрес не найден» - найденная почта с пометкой', async () => {
    const h = await harness();
    const context = createToolContext({
      threadId: 'order-calc/u1',
      agentId: 'order-calc',
      operationId: 'op-text',
      initiator: { kind: 'user', userId: 'u1' },
    });
    await build(h, context);
    await saveSelection(h.deps, {
      requestId: REQUEST_ID,
      supplierIds: ['luna'],
      createdAt: h.deps.clock.now().toISOString(),
    });
    h.deps.mailboxes.connect('u1', 'owner@company.test');
    await prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, h.deps, context);
    const texts = h.deps.chat.outbox.map((record) => record.message?.text ?? '');
    const block = texts.find((text) => text.includes('Поставщик:')) ?? '';
    expect(block).toContain('Кому: sales@luna-pack.example (из интернета, проверьте)');
    expect(block).not.toContain('адрес не найден');
    expect(texts.join('\n')).toContain('Адрес почты найден в интернете');
  });
});

describe('обогащение карточек базы: сайт выбирает модель (этап 125)', () => {
  const PERONI = 'https://peronihoney.ru';
  const peroniHits: WebSearchHit[] = [
    { title: 'Мед Перони реквизиты', url: REGISTRY_URL, snippet: 'Мед Перони, ИП' },
    { title: 'Peroni Honey - натуральный мёд', url: `${PERONI}/`, snippet: 'Мед Перони с пасеки' },
    { title: 'Мед Перони на Ozon', url: 'https://www.ozon.ru/product/1', snippet: 'Мед Перони' },
  ];
  const peroniCard = { card: { name: 'мед Перони' }, registry: {}, hits: peroniHits };

  test('латинский сайт: модель выбирает peronihoney.ru, правило его не находит', async () => {
    const noModel = await harness(peroniCard);
    await build(noModel);
    expect((await entryOf(noModel))?.webEnrichment?.site).toBeUndefined();

    const chooser = new MemorySupplierSiteChooser({ chooseSite: () => ({ site: `${PERONI}/` }) });
    const h = await harness({ ...peroniCard, chooser });
    await build(h);
    expect((await entryOf(h))?.webEnrichment).toMatchObject({ match: 'name', site: PERONI });
    const sent = chooser.siteInputs[0];
    expect(sent?.name).toBe('мед Перони');
    expect(sent?.products).toEqual(['Мёд липовый']);
    // Реестры и маркетплейсы модели не показываются, остальное - с заголовком и фрагментом
    expect(sent?.hits.map((hit) => hit.url)).toEqual([`${PERONI}/`]);
    expect(sent?.hits[0]?.title).toContain('Peroni Honey');
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
      modelSite: 1,
      searchSite: 1,
    });
  });

  test('модель выдумала адрес не из списка: отклонён', async () => {
    const chooser = new MemorySupplierSiteChooser({
      chooseSite: () => ({ site: 'https://peroni-honey-invented.ru/' }),
    });
    const h = await harness({ ...peroniCard, chooser });
    await build(h);
    expect((await entryOf(h))?.webEnrichment?.site).toBeUndefined();
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
      modelNoSite: 1,
      modelFailed: 0,
    });
  });

  test('модель недоступна или ответ не разобран: прежнее правило по словам', async () => {
    const hits = [
      { title: 'Луна-Пак — упаковка для мёда', url: `${SITE}/`, snippet: 'Луна-Пак упаковка' },
    ];
    for (const chooseSite of [
      (): unknown => {
        throw new Error('gateway refused');
      },
      (): unknown => ({ unexpected: 1 }),
    ]) {
      const chooser = new MemorySupplierSiteChooser({ chooseSite });
      const h = await harness({
        card: { name: 'Луна-Пак Коробки новинки' },
        registry: {},
        hits,
        chooser,
      });
      await build(h);
      expect((await entryOf(h))?.webEnrichment).toMatchObject({ match: 'name', site: SITE });
      expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
        modelFailed: 1,
      });
    }
  });

  test('название - категория товара: поиск не запускается, вердикт кэшируется', async () => {
    const chooser = new MemorySupplierSiteChooser({ checkName: () => ({ isCompany: false }) });
    const h = await harness({ card: { name: 'Вяленые фрукты и орехи' }, chooser });
    await build(h);
    expect(h.searches).toBe(0);
    expect((await entryOf(h))?.webEnrichment).toBeUndefined();
    expect(chooser.nameInputs).toHaveLength(1);
    expect(chooser.siteInputs).toHaveLength(0);
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
      notCompany: 1,
    });
    await build(h);
    expect(chooser.nameInputs).toHaveLength(1);
    expect(h.searches).toBe(0);
  });

  test('карточка с ИНН: название не проверяется, реестр находит компанию', async () => {
    const chooser = new MemorySupplierSiteChooser({ checkName: () => ({ isCompany: false }) });
    const h = await harness({ card: { inn: INN, name: 'Луна-Пак наборы' }, chooser });
    await build(h);
    expect(chooser.nameInputs).toHaveLength(0);
    expect((await entryOf(h))?.webEnrichment?.match).toBe('inn');
  });

  test('сайт прочитан, контактов нет: один поиск site:<домен> контакты', async () => {
    const chooser = new MemorySupplierSiteChooser({ chooseSite: () => ({ site: `${PERONI}/` }) });
    const h = await harness({
      ...peroniCard,
      hits: [
        ...peroniHits,
        {
          title: 'Контакты - Peroni Honey',
          url: `${PERONI}/contacts`,
          snippet: 'Контакты. Тел. +7 843 555-01-02, info@peronihoney.ru',
        },
        {
          title: 'Контакты чужого сайта',
          url: 'https://other.example/contacts',
          snippet: 'Контакты. Тел. +7 999 111-22-33',
        },
      ],
      chooser,
    });
    await build(h);
    const found = (await entryOf(h))?.webEnrichment;
    expect(found).toMatchObject({ site: PERONI, phone: '+7 843 555-01-02' });
    expect(found?.email).toBe('info@peronihoney.ru');
    expect(h.logged.find((item) => item.event === 'supplier_enrich')?.fields).toMatchObject({
      contactsSearch: 1,
      contactsFound: 1,
    });
  });
});

describe('выбор сайта моделью: разбор ответа кодом', () => {
  const urls = ['https://peronihoney.ru/', 'https://other.example/shop?x=1'];
  test('адрес из списка, голый домен и чужой адрес', () => {
    expect(parseSupplierSiteChoice({ site: 'https://peronihoney.ru' }, urls)).toBe(urls[0]);
    expect(parseSupplierSiteChoice({ site: 'www.other.example/shop' }, urls)).toBe(urls[1]);
    expect(parseSupplierSiteChoice({ site: 'other.example' }, urls)).toBe(urls[1]);
    expect(parseSupplierSiteChoice({ site: 'https://invented.ru' }, urls)).toBeNull();
    expect(parseSupplierSiteChoice({ site: null }, urls)).toBeNull();
    expect(parseSupplierSiteChoice('не JSON', urls)).toBeUndefined();
    expect(parseSupplierNameVerdict({ isCompany: false })).toBe(false);
    expect(parseSupplierNameVerdict({})).toBeUndefined();
  });
});
