import { describe, expect, test } from 'bun:test';
import { MemoryPriceRelevanceChecker } from '../../src/kit/adapters/memory/price-relevance';
import {
  PRICE_RELEVANCE_MAX_CALLS,
  PRICE_RELEVANCE_MAX_NAMES,
  PRICE_RELEVANCE_TIMEOUT_MS,
} from '../../src/agents/order-calc/price-relevance';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal, loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import { withTimeout } from '../../src/agents/order-calc/web-enrichment';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import type { PriceRelevanceInput } from '../../src/kit/ports/price-relevance';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Этап 135, тема 2: оценки exact | analog | wrong по случаям разбора 29.10. Синтетика. */

type Row = readonly [supplierId: string, productName: string, price: number];

function card(id: string): SupplierCard {
  return {
    id,
    name: `Поставщик ${id}`,
    status: 'new',
    contacts: [{ fullName: 'Иван', email: `${id}@example.test`, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  };
}

async function seed(
  name: string,
  searchQueries: string[],
  rows: readonly Row[],
): Promise<OrderTestDeps> {
  const request: PurchaseRequest = {
    ...ORDER_REQUEST,
    items: [{ name, quantity: 10, unit: 'шт', searchQueries }],
  };
  const deps = await buildOrderDeps({ request });
  const bySupplier = new Map<string, Row[]>();
  for (const row of rows) bySupplier.set(row[0], [...(bySupplier.get(row[0]) ?? []), row]);
  for (const [supplierId, own] of bySupplier) {
    await deps.suppliers.saveCard(card(supplierId));
    await deps.prices.saveImport(
      supplierId,
      own.map(([, productName, price]) => ({
        supplierId,
        productName,
        price,
        currency: 'RUB',
        date: '2026-01-01',
      })),
      `seed-${supplierId}`,
    );
  }
  return deps;
}

/** Оценка по правилу от названия; модель отвечает по ключам из входа. */
function checkerBy(grade: (name: string) => 'exact' | 'analog' | 'wrong' | undefined) {
  return new MemoryPriceRelevanceChecker((input: PriceRelevanceInput) => ({
    results: input.items.map((item) => ({
      item: item.item,
      grades: item.names.flatMap(({ key, name }) => {
        const verdict = grade(name);
        return verdict === undefined ? [] : [{ key, grade: verdict, reason: 'тест' }];
      }),
    })),
  }));
}

async function candidatesOf(deps: OrderTestDeps) {
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
  const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
  return result?.candidates ?? [];
}

const DIARY_ROWS: readonly Row[] = [
  ['a', 'Ежедневник датированный 2027 А5', 520],
  ['b', 'Ежедневник недатированный А5', 74.8],
  ['c', 'Ежедневник недатированный А5 серый', 90],
  ['c', 'Ежедневник датированный 2027 А5 серый', 610],
  ['d', 'Ежедневник датированный 2026 А5', 300],
];

const diaryGrade = (name: string): 'exact' | 'analog' | 'wrong' => {
  if (name.includes('2027')) return 'exact';
  if (name.includes('недатированный')) return 'analog';
  return 'wrong';
};

describe('ежедневник: датированный 2027 против недатированного', () => {
  test('лучшая строка поставщика - по оценке, а не по цене: 610 вместо 90', async () => {
    const deps = await seed('Ежедневник датированный 2027', ['ежедневник'], DIARY_ROWS);
    deps.priceRelevance = checkerBy(diaryGrade);
    const candidates = await candidatesOf(deps);
    const c = candidates.find((x) => x.supplierId === 'c');
    expect(c?.prices?.map((p) => p.amount)).toEqual([610]);
    expect(c?.prices?.[0]?.approximate).toBeUndefined();
  });

  test('недатированный - analog с пометкой, 2026 - wrong и поставщик выпадает', async () => {
    const deps = await seed('Ежедневник датированный 2027', ['ежедневник'], DIARY_ROWS);
    deps.priceRelevance = checkerBy(diaryGrade);
    const candidates = await candidatesOf(deps);
    const b = candidates.find((x) => x.supplierId === 'b');
    expect(b?.prices?.[0]).toMatchObject({ amount: 74.8, approximate: true, similar: true });
    expect(candidates.some((x) => x.supplierId === 'd')).toBe(false);
  });

  test('в среднюю по базе идут только exact', async () => {
    const deps = await seed('Ежедневник датированный 2027', ['ежедневник'], DIARY_ROWS);
    deps.priceRelevance = checkerBy(diaryGrade);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const market = (await loadProposal(deps, REQUEST_ID))?.market;
    expect(market?.status).toBe('ok');
    if (market?.status !== 'ok') return;
    expect(market.found).toBe(2);
    expect(market.groups[0]?.min).toBe(520);
    expect(market.groups[0]?.max).toBe(610);
  });
});

describe('аккумулятор: 10000 мА·ч против 2500', () => {
  const rows: readonly Row[] = [
    ['p', 'Аккумулятор внешний 2500 мА·ч', 229],
    ['p', 'Аккумулятор внешний 10000 мА·ч', 900],
    ['q', 'Аккумулятор внешний 2500 мА·ч синий', 250],
    ['r', 'Аккумулятор внешний 20000 мА·ч', 1500],
  ];
  const grade = (name: string): 'exact' | 'wrong' => (name.includes('10000') ? 'exact' : 'wrong');

  test('промах по ёмкости - wrong: берётся 900, а не 229, чужой выпадает', async () => {
    const deps = await seed('Внешний аккумулятор 10000 мА·ч', ['аккумулятор внешний'], rows);
    deps.priceRelevance = checkerBy(grade);
    const candidates = await candidatesOf(deps);
    expect(candidates.map((c) => c.supplierId)).toEqual(['p']);
    expect(candidates[0]?.prices?.map((p) => p.amount)).toEqual([900]);
  });
});

describe('пряники: колбаса не проходит, свои не отбрасываются', () => {
  const rows: readonly Row[] = [
    ['k', 'Колбаса ИЗЮБРЬ', 400],
    ['k', 'Георгиевская лента', 20],
    ['l', 'Имбирные пряники Leupoldt', 350],
    ['l', 'Колбаса сырокопчёная', 500],
  ];

  test('ответ по ключам, а не по счёту: Leupoldt exact, колбаса wrong', async () => {
    const deps = await seed('Имбирные пряники', ['имбирный пряник', 'пряники', 'колбаса'], rows);
    const checker = checkerBy((name) => (name.includes('пряники') ? 'exact' : 'wrong'));
    deps.priceRelevance = checker;
    const candidates = await candidatesOf(deps);
    expect(candidates.map((c) => c.supplierId)).toEqual(['l']);
    expect(candidates[0]?.prices?.[0]?.offer).toBe('Имбирные пряники Leupoldt');
    const keys = checker.seen[0]?.items[0]?.names.map((n) => n.key);
    expect(keys?.[0]).toBe('p1');
  });

  test('неизвестные ключи отбрасываются, пропущенный ключ - не проверен (analog)', async () => {
    const deps = await seed('Имбирные пряники', ['пряники', 'колбаса'], rows);
    deps.priceRelevance = new MemoryPriceRelevanceChecker((input: PriceRelevanceInput) => ({
      results: input.items.map((item) => ({
        item: item.item,
        grades: [
          { key: 'p99', grade: 'exact' },
          ...item.names
            .filter(({ name }) => name.includes('Leupoldt'))
            .map(({ key }) => ({ key, grade: 'EXACT ', reason: 'тот же' })),
        ],
      })),
    }));
    const candidates = await candidatesOf(deps);
    const l = candidates.find((c) => c.supplierId === 'l');
    expect(l?.prices?.[0]?.approximate).toBeUndefined();
    const k = candidates.find((c) => c.supplierId === 'k');
    // Модель ключ пропустила: цена не пропала молча и не попала в «подходящие».
    expect(k?.prices?.[0]).toMatchObject({ approximate: true, similar: true });
  });
});

describe('охват проверки: все поставщики, не более трёх названий от каждого', () => {
  const rows: Row[] = [];
  for (let s = 1; s <= 8; s += 1) {
    for (let n = 1; n <= 6; n += 1) rows.push([`sup${s}`, `Кружка модель ${s}-${n}`, 100 + n]);
  }

  test('каждому поставщику - до трёх названий; по размеру выдачи несколько вызовов', async () => {
    const deps = await seed('Кружка', ['кружка'], rows);
    deps.priceRelevanceMaxNames = 10;
    const checker = checkerBy(() => 'exact');
    deps.priceRelevance = checker;
    const candidates = await candidatesOf(deps);
    expect(candidates.length).toBe(8);
    const names = checker.seen.flatMap((call) => call.items.flatMap((i) => i.names));
    expect(names.length).toBe(24);
    expect(checker.seen.length).toBe(3);
    for (const call of checker.seen) {
      expect(call.items.reduce((sum, i) => sum + i.names.length, 0)).toBeLessThanOrEqual(10);
    }
  });

  test('сбой одного вызова из нескольких: повтор, затем его строки не проходят', async () => {
    const deps = await seed('Кружка', ['кружка'], rows);
    deps.priceRelevanceMaxNames = 10;
    const broken = new Map<string, number>();
    const checker = new MemoryPriceRelevanceChecker((input: PriceRelevanceInput) => {
      // Вызов с первым поставщиком всегда сбивается, остальные отвергают всё.
      if (input.items.some((i) => i.names.some((n) => n.name.includes('модель 1-')))) {
        const key = JSON.stringify(input.items);
        broken.set(key, (broken.get(key) ?? 0) + 1);
        return { broken: true };
      }
      return checkerBy(() => 'wrong').check(input, { signal: new AbortController().signal });
    });
    deps.priceRelevance = checker;
    const candidates = await candidatesOf(deps);
    expect(candidates).toEqual([]);
    // Каждый сбившийся вызов повторён ровно один раз.
    expect(broken.size).toBeGreaterThan(0);
    for (const count of broken.values()) expect(count).toBe(2);
  });
});

describe('этап 136, тема 3: большие пачки проверки цен', () => {
  test('по умолчанию в вызов уходит до 150 названий, вызовов не больше восьми', () => {
    expect(PRICE_RELEVANCE_MAX_NAMES).toBe(150);
    expect(PRICE_RELEVANCE_MAX_CALLS).toBe(8);
  });

  test('сто названий (выдача поиска) уходят одним вызовом, а не тремя по 40', async () => {
    const rows: Row[] = [];
    for (let s = 1; s <= 34; s += 1) {
      for (let n = 1; n <= 3; n += 1) rows.push([`sup${s}`, `Кружка модель ${s}-${n}`, 100 + n]);
    }
    const deps = await seed('Кружка', ['кружка'], rows);
    const checker = checkerBy(() => 'exact');
    deps.priceRelevance = checker;
    await candidatesOf(deps);
    expect(checker.seen.length).toBe(1);
    expect(checker.seen[0]?.items[0]?.names.length).toBe(100);
  });

  test('wrong без reason принимается: строка отбрасывается, остальные идут', async () => {
    const deps = await seed('Кружка', ['кружка'], [
      ['a', 'Кружка керамическая', 100],
      ['b', 'Ложка', 50],
    ]);
    deps.priceRelevance = new MemoryPriceRelevanceChecker((input: PriceRelevanceInput) => ({
      results: input.items.map((item) => ({
        item: item.item,
        grades: item.names.map(({ key, name }) =>
          name.startsWith('Ложка')
            ? { key, grade: 'wrong' }
            : { key, grade: 'exact', reason: 'тот же товар' },
        ),
      })),
    }));
    const candidates = await candidatesOf(deps);
    expect(candidates.map((c) => c.supplierId)).toEqual(['a']);
  });

  test('таймаут проверки цен отдельный и не меньше общего 120 с', async () => {
    expect(PRICE_RELEVANCE_TIMEOUT_MS).toBe(120_000);
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (ms !== undefined) delays.push(ms);
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout;
    try {
      const deps = await seed('Кружка', ['кружка'], [['a', 'Кружка керамическая', 100]]);
      deps.priceRelevance = checkerBy(() => 'exact');
      await candidatesOf(deps);
      await withTimeout(async () => 1, undefined);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(delays).toContain(PRICE_RELEVANCE_TIMEOUT_MS);
    expect(delays).toContain(120_000);
    expect(PRICE_RELEVANCE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
