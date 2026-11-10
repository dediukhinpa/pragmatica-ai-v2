import { describe, expect, test } from 'bun:test';
import { MemoryPriceRelevanceChecker } from '../../src/kit/adapters/memory/price-relevance';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import type { PriceRelevanceInput } from '../../src/kit/ports/price-relevance';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Этап 121: проверка релевантности строк прайсов моделью и слова упаковки. Синтетика. */

const REQUEST: PurchaseRequest = {
  ...ORDER_REQUEST,
  items: [
    { name: 'Мёд в стеклянных банках', quantity: 30, unit: 'шт' },
    { name: 'Орехи в стеклянных банках', quantity: 30, unit: 'шт' },
  ],
};

function card(id: string, name: string): SupplierCard {
  return {
    id,
    name,
    status: 'new',
    contacts: [{ fullName: 'Иван', email: `${id}@example.test`, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  };
}

const ROWS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['honey', 'Пасека', 'Мёд цветочный 250 г в стеклянной банке', 400],
  ['nuts', 'Кедровый бор', 'Орехи кедровые очищенные', 900],
  ['tea', 'Чайный двор', 'Сокочай Имбирь, Апельсин и Мёд', 150],
  ['tea', 'Чайный двор', 'Сокочай Грецкий орех', 160],
  ['medal', 'Сувениры', 'Стеклянный медальон 90мм', 100],
  ['ball', 'Стекло', 'Стеклянный шар', 80],
];

async function seed(): Promise<OrderTestDeps> {
  const deps = await buildOrderDeps({ request: REQUEST });
  for (const [id, name] of ROWS.map(([id, name]) => [id, name] as const)) {
    await deps.suppliers.saveCard(card(id, name));
  }
  for (const [supplierId, , productName, price] of ROWS) {
    await deps.prices.saveImport(
      supplierId,
      [
        ...(await deps.prices.listBySupplier(supplierId)),
        { supplierId, productName, price, currency: 'RUB', date: '2026-01-01' },
      ],
      `seed-${supplierId}-${productName}`,
    );
  }
  return deps;
}

async function foundIds(deps: OrderTestDeps): Promise<string[]> {
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
  const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
  return (result?.candidates ?? []).map((c) => c.supplierId ?? '').sort();
}

/** Ответ-двойник: оценка по правилу от названия, ключи берутся из входа. */
function gradedBy(
  grade: (name: string) => 'exact' | 'analog' | 'wrong',
): (input: PriceRelevanceInput) => unknown {
  return (input) => ({
    results: input.items.map((item) => ({
      item: item.item,
      grades: item.names.map(({ key, name }) => ({ key, grade: grade(name), reason: 'тест' })),
    })),
  });
}

/** Модель-двойник: чай и всё с «Соко» - не тот товар, остальное - тот же. */
const teaRejecting = gradedBy((name) => (name.startsWith('Сокочай') ? 'wrong' : 'exact'));

describe('слова упаковки не становятся признаками товара', () => {
  test('позиции с тарой без модели: мёд и орехи найдены, медальон и шар - нет', async () => {
    const ids = await foundIds(await seed());
    expect(ids).toContain('honey');
    expect(ids).toContain('nuts');
    expect(ids).not.toContain('medal');
    expect(ids).not.toContain('ball');
  });
});

describe('проверка релевантности строк прайсов моделью', () => {
  test('классификатор отсеивает чай; поставщик без строк выпадает из кандидатов', async () => {
    const deps = await seed();
    deps.priceRelevance = new MemoryPriceRelevanceChecker(teaRejecting);
    const ids = await foundIds(deps);
    expect(ids).toContain('honey');
    expect(ids).toContain('nuts');
    expect(ids).not.toContain('tea');
    expect(ids).not.toContain('medal');
    expect(ids).not.toContain('ball');
  });

  test('один вызов на сборку; модели уходят только позиции и названия товаров', async () => {
    const deps = await seed();
    const checker = new MemoryPriceRelevanceChecker(teaRejecting);
    deps.priceRelevance = checker;
    await foundIds(deps);
    expect(checker.seen.length).toBe(1);
    const payload = JSON.stringify(checker.seen[0]);
    for (const secret of ['honey', 'Пасека', '400', 'tea@', 'Чайный двор', '900', 'RUB']) {
      expect(payload).not.toContain(secret);
    }
    const items = checker.seen[0]?.items ?? [];
    expect(items.map((item) => item.position)).toEqual([
      'Мёд в стеклянных банках',
      'Орехи в стеклянных банках',
    ]);
    // Тара в позиции не мешает находить; в названиях только названия строк.
    expect(items[0]?.names.map((n) => n.name)).toContain('Сокочай Имбирь, Апельсин и Мёд');
  });

  test('отсеянная строка не даёт цену в шорт-лист и среднюю', async () => {
    const deps = await seed();
    deps.priceRelevance = new MemoryPriceRelevanceChecker(teaRejecting);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(JSON.stringify(out)).not.toContain('Чайный двор');
  });

  test('сбой модели ничего не убирает', async () => {
    const deps = await seed();
    const events: string[] = [];
    deps.log = (event) => void events.push(event);
    deps.priceRelevance = new MemoryPriceRelevanceChecker(() => {
      throw new Error('модель недоступна');
    });
    const ids = await foundIds(deps);
    expect(ids).toContain('tea');
    expect(events).toContain('price_relevance_failed');
  });

  test('ответ не по схеме ничего не убирает', async () => {
    const deps = await seed();
    deps.priceRelevance = new MemoryPriceRelevanceChecker(() => ({ results: 'нет' }));
    expect(await foundIds(deps)).toContain('tea');
  });

  test('отсеяно больше 80%: решение модели принимается, отката нет (бой 29.10)', async () => {
    const deps = await seed();
    const events: string[] = [];
    deps.log = (event) => void events.push(event);
    // Набираем выборку: в «мёде» окажется не меньше пяти названий.
    const extra = ['Мёд липовый', 'Мёд гречишный', 'Мёд акациевый', 'Мёд в сотах'];
    for (const [index, productName] of extra.entries()) {
      const supplierId = `extra-${index}`;
      const date = '2026-01-01';
      await deps.prices.saveImport(
        supplierId,
        [{ supplierId, productName, price: 300, currency: 'RUB', date }],
        supplierId,
      );
    }
    deps.priceRelevance = new MemoryPriceRelevanceChecker(gradedBy(() => 'wrong'));
    const ids = await foundIds(deps);
    expect(ids).not.toContain('tea');
    expect(events).toContain('price_relevance_check');
    expect(events).not.toContain('price_relevance_implausible');
  });

  test('честный полный отказ на малой выборке принимается', async () => {
    const deps = await buildOrderDeps({
      request: { ...ORDER_REQUEST, items: [{ name: 'Мёд', quantity: 1, unit: 'шт' }] },
    });
    await deps.suppliers.saveCard(card('tea', 'Чайный двор'));
    await deps.prices.saveImport(
      'tea',
      [{ supplierId: 'tea', productName: 'Сокочай Имбирь и Мёд', price: 150, currency: 'RUB',
        date: '2026-01-01' }],
      'seed-tea',
    );
    deps.priceRelevance = new MemoryPriceRelevanceChecker(gradedBy(() => 'wrong'));
    expect(await foundIds(deps)).not.toContain('tea');
  });
});
