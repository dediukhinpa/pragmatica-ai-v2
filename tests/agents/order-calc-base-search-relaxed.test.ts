import { describe, expect, test } from 'bun:test';
import {
  MemoryKnowledgeSearch,
  type MemoryKnowledgeDocument,
} from '../../src/kit/adapters/memory/knowledge-search.owned';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal, loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Поиск по базе в ослабленном режиме: «мёд в банках» находит то, что в базе есть (этап 108). */

function requestOf(name: string): PurchaseRequest {
  return { ...ORDER_REQUEST, items: [{ name, quantity: 30, unit: 'шт' }] };
}

function card(id: string, name: string, patch: Partial<SupplierCard> = {}): SupplierCard {
  return {
    id,
    name,
    status: 'new',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...patch,
  };
}

async function seed(item: string): Promise<OrderTestDeps> {
  const deps = await buildOrderDeps({ request: requestOf(item) });
  const price = (supplierId: string, productName: string, amount: number): Promise<void> =>
    deps.prices.saveImport(
      supplierId,
      [{ supplierId, productName, price: amount, currency: 'RUB', date: '2026-01-01' }],
      `seed-${supplierId}`,
    );
  for (const [id, name] of [
    ['honey', 'Пасека Липовая'],
    ['nuts', 'Кедровый Бор'],
    ['medal', 'Стеклодув'],
    ['peroni', 'Peroni'],
  ] as const) {
    await deps.suppliers.saveCard(card(id, name));
  }
  await price('honey', 'Мёд липовый 0,5 кг', 400);
  await price('nuts', 'Лесной орех очищенный', 900);
  await price('medal', 'Медаль из стекла', 100);
  await deps.suppliers.saveCard(card('house', 'Медовый дом Деликатесы'));
  await deps.suppliers.saveCard(card('candy', 'Драже и жев резинка в жестяных банках'));
  return deps;
}

/** Кандидаты источника knowledge: id поставщика -> оценка и ссылка. */
async function found(deps: OrderTestDeps): Promise<Map<string, { score: number; ref?: string }>> {
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
  const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
  const map = new Map<string, { score: number; ref?: string }>();
  for (const c of result?.candidates ?? []) {
    map.set(c.supplierId ?? '', {
      score: c.score,
      ...(c.reference === undefined ? {} : { ref: c.reference }),
    });
  }
  return map;
}

describe('поиск по базе: ослабленный', () => {
  test('«мёд в банках» находит прайс «Мёд липовый» и карточку «Медовый дом»', async () => {
    const hits = await found(await seed('мёд в банках'));
    expect(hits.has('honey')).toBe(true);
    expect(hits.get('honey')?.score).toBe(1);
    expect(hits.has('house')).toBe(true);
    // Слово упаковки не тащит карточку про «жестяные банки»; «мед» не ловит «Медаль».
    expect(hits.has('candy')).toBe(false);
    expect(hits.has('medal')).toBe(false);
    expect(hits.has('nuts')).toBe(false);
  });

  test('«орехи в банках» находит «Лесной орех»', async () => {
    const hits = await found(await seed('орехи в банках'));
    expect(hits.has('nuts')).toBe(true);
    expect(hits.has('honey')).toBe(false);
    expect(hits.has('candy')).toBe(false);
  });

  test('только слова упаковки - ничего (не «всё подряд»)', async () => {
    const hits = await found(await seed('в банках'));
    expect(hits.size).toBe(0);
  });

  test('ранжирование по доле совпавших слов', async () => {
    // Слова «башкирский» нет ни в одной строке: поиск по всем словам пуст, работает запасной.
    const deps = await seed('мёд липовый башкирский в банках');
    await deps.prices.saveImport(
      'peroni',
      [
        {
          supplierId: 'peroni',
          productName: 'Мёд цветочный',
          price: 300,
          currency: 'RUB',
          date: '2026-01-01',
        },
      ],
      'seed-peroni',
    );
    const hits = await found(deps);
    expect(hits.get('honey')?.score).toBeCloseTo(2 / 3);
    expect(hits.get('peroni')?.score).toBeCloseTo(1 / 3);
  });

  test('все слова есть в строке: другой вариант товара неполным не добавляется', async () => {
    const deps = await seed('мёд липовый в банках');
    await deps.prices.saveImport(
      'peroni',
      [
        {
          supplierId: 'peroni',
          productName: 'Мёд цветочный',
          price: 300,
          currency: 'RUB',
          date: '2026-01-01',
        },
      ],
      'seed-peroni',
    );
    const hits = await found(deps);
    expect(hits.get('honey')?.score).toBe(1);
    expect(hits.has('peroni')).toBe(false);
  });

  test('документ поставщика даёт кандидата слабее карточки, со ссылкой на документ', async () => {
    const deps = await seed('мёд в банках');
    deps.knowledge = new MemoryKnowledgeSearch(
      new Map<string, string | MemoryKnowledgeDocument>([
        ['doc-peroni', { text: 'Презентация: мёд и орехи, ассортимент', supplierId: 'peroni' }],
        ['doc-free', 'Общий документ про мёд'],
      ]),
    );
    const hits = await found(deps);
    expect(hits.get('peroni')).toEqual({ score: 0.25, ref: 'doc-peroni' });
    expect(hits.has('doc-free')).toBe(false);
    expect(hits.get('house')?.score).toBe(0.5);
  });
  test('неполное совпадение: цена приблизительная, вне средней и яруса «с ценами»', async () => {
    const deps = await seed('мёд липовый башкирский в банках');
    await deps.prices.saveImport(
      'peroni',
      [
        {
          supplierId: 'peroni',
          productName: 'Мёд цветочный',
          price: 300,
          currency: 'RUB',
          date: '2026-01-01',
        },
      ],
      'seed-peroni',
    );
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
    const priceOf = (id: string) =>
      result?.candidates.find((c) => c.supplierId === id)?.prices?.[0];
    // Ни одна строка не совпала по всем словам: обе цены приблизительные.
    expect(priceOf('honey')?.approximate).toBe(true);
    expect(priceOf('peroni')?.approximate).toBe(true);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    // Приблизительные цены не входят в среднюю и не считаются ценой поставщика базы.
    const proposal = await loadProposal(deps, REQUEST_ID);
    const group = proposal?.market?.status === 'ok' ? proposal.market.groups[0] : undefined;
    expect(group).toBeUndefined();
    expect(JSON.stringify(out)).toContain('"baseSuppliersWithPrice":0');
    const names = proposal?.entries.map((entry) => entry.supplierId) ?? [];
    expect(names.indexOf('honey')).toBeLessThan(names.indexOf('peroni'));
  });
});
