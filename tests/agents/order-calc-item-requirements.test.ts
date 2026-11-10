import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryPriceRelevanceChecker } from '../../src/kit/adapters/memory/price-relevance';
import { MemoryShortlistComparer } from '../../src/kit/adapters/memory/shortlist-comparer';
import {
  MemoryWebCandidateEnricher,
  MemoryWebHitClassifier,
  MemoryWebQueryPlanner,
} from '../../src/kit/adapters/memory/web-candidate-model';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { PriceRelevanceInput } from '../../src/kit/ports/price-relevance';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Этап 136: требования позиции доходят до входа каждой модели. Синтетика, без реальных данных. */

const SHOPPER_NEEDS = 'ткань оксфорд, сублимационная печать с двух сторон, пришивной шеврон';
const BLOCK_NEEDS = 'А4, на КБС, 80 г, обложка 300 г с матовой ламинацией';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

const REQUEST: PurchaseRequest = {
  ...ORDER_REQUEST,
  items: [
    { name: 'Сумка-шоппер', quantity: 200, unit: 'шт', requirements: SHOPPER_NEEDS },
    { name: 'Блок для записей', quantity: 500, unit: 'шт', requirements: BLOCK_NEEDS },
  ],
};

/** Строки прайсов: [поставщик, товар, цена]. */
const ROWS: ReadonlyArray<readonly [string, string, number]> = [
  ['tapestry', 'Сумка-шоппер из гобелена "Семейка котиков"', 2252],
  ['oxford', 'Сумка-шоппер для сублимации оксфорд белый', 240],
  ['felt', 'Блок для записей из войлока', 700],
  ['kbs', 'Блок для записей А4 на КБС 80 г', 90],
];

let deps: OrderTestDeps;

async function seed(): Promise<OrderTestDeps> {
  const built = await buildOrderDeps({ request: REQUEST });
  for (const [supplierId, productName, price] of ROWS) {
    await built.suppliers.upsert({ id: supplierId, name: `Поставщик ${supplierId}` });
    await built.prices.saveImport(
      supplierId,
      [{ supplierId, productName, price, currency: 'RUB', date: CREATED_AT }],
      `seed-${supplierId}`,
    );
  }
  return built;
}

/** Одна строка прайса «Сумка-шоппер» для проверок с одной позицией. */
async function seedPlainRow(): Promise<void> {
  await deps.suppliers.upsert({ id: 'x', name: 'Х' });
  const row = {
    supplierId: 'x',
    productName: 'Сумка-шоппер',
    price: 1,
    currency: 'RUB',
    date: CREATED_AT,
  };
  await deps.prices.saveImport('x', [row], 'seed-x');
}

beforeEach(async () => {
  deps = await seed();
});

/** Двойник проверки: исполняет правило промпта по requirements входа. */
function graderByRequirements(input: PriceRelevanceInput): unknown {
  return {
    results: input.items.map((item) => ({
      item: item.item,
      grades: item.names.map(({ key, name }) => {
        const needsOxford = item.requirements?.includes('оксфорд') === true;
        const needsKbs = item.requirements?.includes('КБС') === true;
        const text = name.toLowerCase();
        const wrong =
          (needsOxford && text.includes('гобелен')) || (needsKbs && text.includes('войлок'));
        return { key, grade: wrong ? 'wrong' : 'exact' };
      }),
    })),
  };
}

describe('проверка цен', () => {
  test('требования позиции доходят до входа модели; гобелен и войлок отсеяны', async () => {
    const checker = new MemoryPriceRelevanceChecker(graderByRequirements);
    deps.priceRelevance = checker;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const sent = checker.seen.flatMap((call) => call.items);
    const shopper = sent.find((item) => item.position === 'Сумка-шоппер');
    expect(shopper?.requirements).toBe(SHOPPER_NEEDS);
    expect(sent.find((item) => item.position === 'Блок для записей')?.requirements).toBe(
      BLOCK_NEEDS,
    );
    const found = (await loadSourceResult(deps, REQUEST_ID, 'knowledge'))?.candidates ?? [];
    const ids = found.map((candidate) => candidate.supplierId ?? '').sort();
    expect(ids).toContain('oxford');
    expect(ids).toContain('kbs');
    expect(ids).not.toContain('tapestry');
    expect(ids).not.toContain('felt');
  });

  test('заявка без требований: поля во входе нет, всё работает как раньше', async () => {
    deps = await buildOrderDeps({
      request: { ...REQUEST, items: [{ name: 'Сумка-шоппер', quantity: 1, unit: 'шт' }] },
    });
    await seedPlainRow();
    const checker = new MemoryPriceRelevanceChecker(graderByRequirements);
    deps.priceRelevance = checker;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(checker.seen[0]?.items[0]).toBeDefined();
    expect('requirements' in (checker.seen[0]?.items[0] ?? {})).toBe(false);
  });

  test('требования с контактами в модель не уходят, название остаётся', async () => {
    deps = await buildOrderDeps({
      request: {
        ...REQUEST,
        items: [
          {
            name: 'Сумка-шоппер',
            quantity: 1,
            unit: 'шт',
            requirements: 'оксфорд, звонить +7 999 000-11-22',
          },
        ],
      },
    });
    await seedPlainRow();
    const checker = new MemoryPriceRelevanceChecker(graderByRequirements);
    deps.priceRelevance = checker;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const item = checker.seen[0]?.items[0];
    expect(item?.position).toBe('Сумка-шоппер');
    expect(item?.requirements).toBeUndefined();
  });
});

describe('ранжирование шорт-листа', () => {
  test('сравнитель получает требования каждой позиции', async () => {
    const comparer = new MemoryShortlistComparer((facts) => ({
      order: facts.candidates.map((candidate) => candidate.id),
    }));
    deps.shortlistCompare = { comparer };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const positions = comparer.seen[0]?.positions ?? [];
    expect(positions.find((p) => p.name === 'Сумка-шоппер')?.requirements).toBe(SHOPPER_NEEDS);
    expect(positions.find((p) => p.name === 'Блок для записей')?.requirements).toBe(BLOCK_NEEDS);
  });
});

describe('интернет', () => {
  const HIT = {
    title: 'Пошив сумок',
    url: 'https://sumki-opt.example.ru/',
    snippet: 'Шоппер оксфорд сублимация оптом',
  };

  test('планировщик запросов получает требования позиций', async () => {
    const planner = new MemoryWebQueryPlanner(() => ['шоппер оксфорд сублимация оптом']);
    deps.webQueryPlanner = planner;
    deps.web.search = async () => [{ ...HIT }];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const items = planner.seen[0]?.items ?? [];
    expect(items.find((i) => i.name === 'Сумка-шоппер')?.requirements).toBe(SHOPPER_NEEDS);
    expect(items.find((i) => i.name === 'Блок для записей')?.requirements).toBe(BLOCK_NEEDS);
  });

  test('классификатор выдачи получает требования позиций', async () => {
    const classifier = new MemoryWebHitClassifier(() => ({ results: [] }));
    deps.webClassifier = classifier;
    deps.web.search = async () => [{ ...HIT }];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const items = classifier.seen[0]?.items ?? [];
    expect(items.find((i) => i.name === 'Сумка-шоппер')?.requirements).toBe(SHOPPER_NEEDS);
  });

  test('извлечение цен со страницы получает требования позиций', async () => {
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webEnricher = enricher;
    deps.web.search = async () => [{ ...HIT }];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(enricher.seen.length).toBeGreaterThan(0);
    for (const page of enricher.seen) {
      expect(page.itemRequirements).toEqual([
        { item: 'Сумка-шоппер', requirements: SHOPPER_NEEDS },
        { item: 'Блок для записей', requirements: BLOCK_NEEDS },
      ]);
    }
  });

  test('требования с почтой во внешние модели не уходят', async () => {
    deps = await buildOrderDeps({
      request: {
        ...REQUEST,
        items: [
          {
            name: 'Сумка-шоппер',
            quantity: 1,
            unit: 'шт',
            requirements: 'оксфорд, ivan@mail.test',
          },
        ],
      },
    });
    const planner = new MemoryWebQueryPlanner(() => ['шоппер оксфорд оптом']);
    const enricher = new MemoryWebCandidateEnricher(() => ({}));
    deps.webQueryPlanner = planner;
    deps.webEnricher = enricher;
    deps.web.search = async () => [{ ...HIT }];
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(planner.seen[0]?.items[0]?.requirements).toBeUndefined();
    expect(enricher.seen.every((page) => page.itemRequirements === undefined)).toBe(true);
  });
});
