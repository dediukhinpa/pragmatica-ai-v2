import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryShortlistComparer } from '../../src/kit/adapters/memory/shortlist-comparer';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { entryLines } from '../../src/agents/order-calc/shortlist-message';
import type { ShortlistCompareFacts } from '../../src/kit/domain/shortlist-compare';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const SHORT_TIMEOUT_MS = 20;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

let deps: OrderTestDeps;
let events: Array<{ event: string; fields?: Record<string, string | number | boolean> }>;

beforeEach(async () => {
  deps = await buildOrderDeps();
  events = [];
  deps.log = (event, fields) => {
    events.push({ event, ...(fields === undefined ? {} : { fields }) });
  };
});

/** Дополнительный поставщик с ценой и сроком в карточке. */
async function addSupplier(id: string, name: string, price: number, leadTime: string) {
  await deps.suppliers.saveCard({
    id,
    name,
    status: 'active',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: { leadTime },
    notes: [],
  });
  await deps.prices.saveImport(
    id,
    [{ supplierId: id, productName: 'Арматура 12 мм', price, currency: 'RUB', date: CREATED_AT }],
    `seed-${id}`,
  );
}

async function build() {
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  await buildShortlist.execute(input, deps, CTX);
  const proposal = await loadProposal(deps, REQUEST_ID);
  if (proposal === null) throw new Error('шорт-лист не сохранён');
  return proposal;
}

const ranked = () => events.find((item) => item.event === 'shortlist_ranked')?.fields;

describe('buildShortlist: сравнение кандидатов', () => {
  test('без модели правило: при равном покрытии дешевле выше, срок не главный', async () => {
    await addSupplier('s4', 'Быстрый', 90, '2 дня');
    await addSupplier('s5', 'Дешёвый', 10, '2 недели');
    const proposal = await build();
    const names = proposal.entries.map((item) => item.supplierId);
    expect(names.indexOf('s5')).toBeLessThan(names.indexOf('s4'));
    expect(proposal.orderMethod).toBe('rule');
    expect(proposal.compared).toBe(proposal.entries.length);
    expect(ranked()).toMatchObject({ method: 'rule', shown: proposal.entries.length });
  });

  test('модель вернула порядок - он применён, метод model, событие без названий', async () => {
    const byRule = (await build()).entries.map((item) => item.supplierId);
    events.length = 0;
    const comparer = new MemoryShortlistComparer((facts: ShortlistCompareFacts) => ({
      order: [...facts.candidates].reverse().map((item) => item.id),
    }));
    deps.shortlistCompare = { comparer };
    const proposal = await build();
    expect(comparer.calls).toBe(1);
    expect(proposal.orderMethod).toBe('model');
    // Модель упорядочивает только базу; интернет добирает места после неё (этап 143).
    const isBase = (id: string): boolean =>
      proposal.entries.find((item) => item.supplierId === id)?.sources.includes('knowledge') ===
      true;
    const baseIds = byRule.filter(isBase);
    const webIds = byRule.filter((id) => !isBase(id));
    expect(proposal.entries.map((item) => item.supplierId)).toEqual([
      ...[...baseIds].reverse(),
      ...webIds,
    ]);
    expect(ranked()).toEqual({
      method: 'model',
      compared: baseIds.length,
      shown: proposal.entries.length,
      webShown: proposal.entries.filter((item) => !item.sources.includes('knowledge')).length,
    });
  });

  test('picks с причинами: причина в строке, модель видела позиции с количеством', async () => {
    await addSupplier('s4', 'Быстрый', 90, '2 дня');
    const comparer = new MemoryShortlistComparer((facts: ShortlistCompareFacts) => ({
      picks: [...facts.candidates].reverse().map((c) => ({ id: c.id, reason: `причина ${c.id}` })),
    }));
    deps.shortlistCompare = { comparer };
    const proposal = await build();
    const facts = comparer.seen[0];
    expect(facts?.positions[0]).toMatchObject({ name: 'Арматура', quantity: 100, unit: 'м' });
    expect(facts?.limit).toBe(10);
    expect(facts?.candidates.every((c) => c.priceTier !== undefined)).toBe(true);
    expect(proposal.orderMethod).toBe('model');
    const base = proposal.entries.filter((item) => item.sources.includes('knowledge'));
    expect(base.length).toBeGreaterThan(0);
    expect(base.every((item) => item.rankReason?.startsWith('причина c'))).toBe(true);
  });

  test('модель не может выкинуть обязательного: пропущенные дописывает правило', async () => {
    await addSupplier('s4', 'Быстрый', 90, '2 дня');
    await addSupplier('s5', 'Дешёвый', 10, '2 недели');
    const comparer = new MemoryShortlistComparer((facts: ShortlistCompareFacts) => ({
      picks: facts.candidates.slice(0, 2).map((c) => ({ id: c.id, reason: 'выбрана' })),
    }));
    deps.shortlistCompare = { comparer };
    const proposal = await build();
    const total = comparer.seen[0]?.candidates.length ?? 0;
    expect(total).toBeGreaterThan(2);
    // Модель видела только базу; недостающие места добирает интернет, поэтому строк не меньше.
    const base = proposal.entries.filter((item) => item.sources.includes('knowledge'));
    expect(base).toHaveLength(total);
  });

  test.each([
    ['мусор', () => 'не json'],
    ['выдуманные коды', () => ({ order: ['x1', 'x2'] })],
    ['не тот тип', () => ({ order: 5 })],
  ])('%s в ответе - правило и событие без коротких кодов', async (_name, answer) => {
    deps.shortlistCompare = { comparer: new MemoryShortlistComparer(answer) };
    const proposal = await build();
    expect(proposal.orderMethod).toBe('rule');
    expect(events.some((item) => item.event === 'shortlist_compare_failed')).toBe(true);
  });

  test('ответ отклонён - в журнале подкод и числа, без текста ответа', async () => {
    deps.shortlistCompare = {
      comparer: new MemoryShortlistComparer(() => 'СЕКРЕТНОЕ пояснение без JSON'),
    };
    await build();
    const failed = events.find((item) => item.event === 'shortlist_compare_failed')?.fields;
    expect(failed).toMatchObject({ reason: 'not_json', returned: 0, known: 0 });
    expect(typeof failed?.total).toBe('number');
    expect(JSON.stringify(events)).not.toContain('СЕКРЕТНОЕ');
  });

  test('ошибка модели - подкод model_error', async () => {
    deps.shortlistCompare = {
      comparer: {
        compare: async () => {
          throw new Error('boom');
        },
      },
    };
    await build();
    expect(events.find((item) => item.event === 'shortlist_compare_failed')?.fields).toMatchObject({
      reason: 'model_error',
    });
  });

  test('частичный ответ от половины принят: метод model и событие partial', async () => {
    deps.shortlistCompare = {
      comparer: new MemoryShortlistComparer((facts: ShortlistCompareFacts) => ({
        order: facts.candidates.slice(0, Math.ceil(facts.candidates.length / 2)).map((c) => c.id),
      })),
    };
    const proposal = await build();
    expect(proposal.orderMethod).toBe('model');
    expect(events.some((item) => item.event === 'shortlist_compare_partial')).toBe(true);
    expect(events.some((item) => item.event === 'shortlist_compare_failed')).toBe(false);
  });

  test('таймаут модели - правило', async () => {
    deps.shortlistCompare = {
      comparer: {
        compare: () => new Promise(() => undefined),
      },
      timeoutMs: SHORT_TIMEOUT_MS,
    };
    const proposal = await build();
    expect(proposal.orderMethod).toBe('rule');
    expect(events.find((item) => item.event === 'shortlist_compare_failed')?.fields).toMatchObject({
      code: 'shortlist_compare_timeout',
      reason: 'timeout',
    });
  });

  test('модели уходят только факты: ни названий, ни почты', async () => {
    await addSupplier('s4', 'Секретный Поставщик', 90, '2 дня');
    const comparer = new MemoryShortlistComparer(() => null);
    deps.shortlistCompare = { comparer };
    await build();
    const sent = JSON.stringify(comparer.seen);
    // Названия позиций заявки уходят модели (нужны для покрытия и единиц), поставщиков - нет.
    for (const secret of ['Секретный', 'sales@metall.test', 'МеталлТорг']) {
      expect(sent).not.toContain(secret);
    }
  });
});

describe('причина выбора в строке шорт-листа', () => {
  const base = {
    supplierId: 's',
    name: 'Поставщик',
    sources: ['knowledge'] as ['knowledge'],
    score: 1,
    references: [],
  };

  test('есть причина от модели - поле показано; нет (правило) - поля нет', () => {
    const withReason = entryLines({ ...base, rankReason: 'точный товар, цена ниже' }, 0).join('\n');
    expect(withReason).toContain('Почему в списке: точный товар, цена ниже');
    expect(entryLines(base, 0).join('\n')).not.toContain('Почему в списке');
  });
});
