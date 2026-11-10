import { describe, expect, test } from 'bun:test';
import { loadSourceResult } from '../../src/agents/order-calc/state';
import { normalizeIntakeItems } from '../../src/agents/order-calc/intake';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import {
  REQUEST_ITEM_REQUIREMENTS_MAX_CHARS,
  purchaseRequestSchema,
  type PurchaseRequest,
} from '../../src/kit/domain/models';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Этап 135: короткие поисковые запросы позиции заявки расширяют поиск по базе цен. */

const LONG_NAME = 'Мёд липовый башкирский в стеклянной банке с логотипом на крышке';

function requestOf(searchQueries?: string[]): PurchaseRequest {
  const item = { name: LONG_NAME, quantity: 30, unit: 'шт' };
  return {
    ...ORDER_REQUEST,
    items: [searchQueries === undefined ? item : { ...item, searchQueries }],
  };
}

async function seed(request: PurchaseRequest): Promise<OrderTestDeps> {
  const deps = await buildOrderDeps({ request });
  await deps.suppliers.saveCard({
    id: 'honey',
    name: 'Пасека Липовая',
    status: 'new',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  });
  await deps.prices.saveImport(
    'honey',
    [
      {
        supplierId: 'honey',
        productName: 'Мёд липовый 0,5 кг',
        price: 400,
        currency: 'RUB',
        date: '2026-01-01',
      },
    ],
    'seed-honey',
  );
  return deps;
}

async function honeyScore(deps: OrderTestDeps): Promise<number | undefined> {
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
  const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
  return result?.candidates.find((candidate) => candidate.supplierId === 'honey')?.score;
}

describe('короткие запросы позиции', () => {
  test('с коротким запросом строка найдена основным поиском (оценка 1)', async () => {
    expect(await honeyScore(await seed(requestOf(['мёд липовый'])))).toBe(1);
  });

  test('старая заявка без запросов работает как раньше (запасной поиск)', async () => {
    const score = await honeyScore(await seed(requestOf()));
    expect(score).toBeDefined();
    expect(score).toBeLessThan(1);
  });
});

describe('приём коротких запросов', () => {
  const base = { name: 'Чайная пара', unit: 'шт', quantity: 10 };

  test('лишнее обрезается: пробелы, пустые, повторы и сверх трёх', () => {
    const [item] = normalizeIntakeItems(
      [
        {
          ...base,
          searchQueries: ['  чайная   пара ', '', 'Чайная пара', 'чашка', 'блюдце', 'сервиз'],
        },
      ],
      'reject',
    );
    expect(item?.searchQueries).toEqual(['чайная пара', 'чашка', 'блюдце']);
  });

  test('без запросов поле не появляется (старый вид позиции)', () => {
    expect(normalizeIntakeItems([base], 'reject')).toEqual([base]);
    expect(
      normalizeIntakeItems([{ ...base, searchQueries: ['  '] }], 'reject')[0],
    ).not.toHaveProperty('searchQueries');
  });
});

describe('требования к позиции (этап 136)', () => {
  const base = { name: 'Шоперы', unit: 'шт', quantity: 200 };

  test('требования сохраняются, пробелы схлопываются', () => {
    const [item] = normalizeIntakeItems(
      [{ ...base, requirements: '  оксфорд,  сублимация\nс двух сторон ' }],
      'reject',
    );
    expect(item?.requirements).toBe('оксфорд, сублимация с двух сторон');
  });

  test('длинные требования обрезаются до предела', () => {
    const [item] = normalizeIntakeItems(
      [{ ...base, requirements: 'я'.repeat(REQUEST_ITEM_REQUIREMENTS_MAX_CHARS + 300) }],
      'reject',
    );
    expect(item?.requirements).toHaveLength(REQUEST_ITEM_REQUIREMENTS_MAX_CHARS);
  });

  test('без требований поле не появляется (старый вид позиции)', () => {
    expect(normalizeIntakeItems([base], 'reject')).toEqual([base]);
    expect(
      normalizeIntakeItems([{ ...base, requirements: '   ' }], 'reject')[0],
    ).not.toHaveProperty('requirements');
  });

  test('старая заявка без поля проходит схему, с полем - хранится', () => {
    const legacy = purchaseRequestSchema.parse({ ...ORDER_REQUEST, items: [base] });
    expect(legacy.items[0]).not.toHaveProperty('requirements');
    const withReq = purchaseRequestSchema.parse({
      ...ORDER_REQUEST,
      items: [{ ...base, requirements: 'оксфорд' }],
    });
    expect(withReq.items[0]?.requirements).toBe('оксфорд');
  });

  test('saveIntakeRequest: поле хранится, повтор с иной формулировкой - дубликат', async () => {
    const deps = await buildOrderDeps({ request: ORDER_REQUEST });
    const call = (requirements: string) =>
      saveIntakeRequest.execute(
        { source: 'text', items: [{ ...base, requirements }] },
        deps,
        CTX,
      );
    const first = await call('оксфорд, сублимация');
    expect(first.duplicate).toBe(false);
    const stored = await deps.requests.get(first.requestId);
    expect(stored?.items[0]?.requirements).toBe('оксфорд, сублимация');
    const second = await call('ткань оксфорд, сублимационная печать');
    expect(second.duplicate).toBe(true);
    expect(second.requestId).toBe(first.requestId);
    const again = await deps.requests.get(first.requestId);
    expect(again?.items[0]?.requirements).toBe('оксфорд, сублимация');
  });
});
