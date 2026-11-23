import { beforeEach, describe, expect, test } from 'bun:test';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

let deps: OrderTestDeps;

function card(
  id: string,
  name: string,
  patch: Partial<SupplierCard> & { email?: string } = {},
): SupplierCard {
  const { email, ...rest } = patch;
  return {
    id,
    name,
    status: 'new',
    contacts: email === undefined ? [] : [{ email, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...rest,
  };
}

beforeEach(async () => {
  deps = await buildOrderDeps();
});

interface Candidate {
  supplierId: string;
  score: number;
  status?: string;
}

async function candidates(): Promise<Candidate[]> {
  const proposal = await loadProposal(deps, REQUEST_ID);
  return (proposal?.entries ?? []).map((entry) => ({
    supplierId: entry.supplierId,
    score: entry.score,
  }));
}

describe('шорт-лист и карточки поставщиков', () => {
  test('карточка без строк прайса находится по категории и бренду', async () => {
    await deps.suppliers.saveCard(
      card('c-cat', 'Стройснаб', {
        email: 'sales@stroysnab.test',
        supplies: { categories: ['Арматура'], brands: [], regions: [] },
      }),
    );
    await deps.suppliers.saveCard(
      card('c-brand', 'Северный склад', {
        supplies: { categories: [], brands: ['Арматура Про'], regions: [] },
      }),
    );
    await deps.suppliers.saveCard(card('c-none', 'Кондитер', {}));
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.found).toBe(4); // s1, s2 по прайсу + две карточки
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const ids = (await candidates()).map((entry) => entry.supplierId);
    expect(ids).toEqual(expect.arrayContaining(['s1', 's2', 'c-cat', 'c-brand']));
    expect(ids).not.toContain('c-none');
    const proposal = await loadProposal(deps, REQUEST_ID);
    const entry = proposal?.entries.find((item) => item.supplierId === 'c-cat');
    expect(entry?.email).toBe('sales@stroysnab.test'); // из основного контакта
  });

  test('«не работаем» исключается и попадает в отчёт; «действующий» выше «нового»', async () => {
    await deps.suppliers.saveCard(
      card('c-new', 'Арматура-двор', { email: 'n@x.test' }),
    );
    await deps.suppliers.saveCard(
      card('c-act', 'Арматура-дом', { status: 'active', email: 'a@x.test' }),
    );
    await deps.suppliers.saveCard(
      card('c-off', 'Арматура-мир', { status: 'inactive', email: 'o@x.test' }),
    );
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.excludedInactive).toBe(1);
    const built = await buildShortlist.execute({ requestId: REQUEST_ID, limit: 10 }, deps, CTX);
    expect(built.excludedInactive).toBe(1);
    const ids = built.entries.map((entry) => entry.supplierId);
    expect(ids).not.toContain('c-off');
    expect(ids.indexOf('c-act')).toBeLessThan(ids.indexOf('c-new'));
  });

  test('поставщик из прайса со статусом «не работаем» тоже исключается', async () => {
    const existing = await deps.suppliers.getCard('s2');
    if (existing === null) throw new Error('нет s2');
    await deps.suppliers.saveCard({ ...existing, status: 'inactive' });
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const built = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(built.entries.map((entry) => entry.supplierId)).not.toContain('s2');
    expect(built.excludedInactive).toBe(1);
  });

  test('без карточек результат прежний: только поставщики с прайсом', async () => {
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out).toMatchObject({ found: 2 });
    expect(out.excludedInactive).toBeUndefined();
  });

  test('section и supplierId ограничивают подсказки базы знаний', async () => {
    const seen: unknown[] = [];
    const original = deps.knowledge.search.bind(deps.knowledge);
    deps.knowledge.search = async (query, limit, scope) => {
      seen.push(scope);
      return original(query, limit, scope);
    };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    await searchKnowledgeSuppliers.execute(
      { requestId: REQUEST_ID, section: 'suppliers' },
      deps,
      CTX,
    );
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID, supplierId: 's1' }, deps, CTX);
    expect(seen).toEqual([undefined, { suppliersOnly: true }, { supplierId: 's1' }]);
  });
});
