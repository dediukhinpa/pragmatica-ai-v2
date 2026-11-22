import { describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  SHORTLIST_PAGE_NAMESPACE,
  SHORTLIST_PAGE_TTL_MS,
  criteriaKeyOf,
  deletePageState,
  isPageStateAlive,
  loadPageState,
  pageStateExpiry,
  savePageState,
  type ShortlistPageState,
} from '../../src/shortlist-paging-state';

const REQUEST = {
  id: 'req-1',
  items: [{ name: 'Арматура', quantity: 100, unit: 'м', requirements: 'А500С' }],
};
const START = new Date('2026-01-01T00:00:00.000Z');
/** Миллисекунд сверх срока, чтобы выйти за него. */
const OVER_TTL_MS = 1;
/** Сколько записей читает проверка просмотра пространства. */
const LIST_LIMIT = 10;

function stateAt(now: Date): ShortlistPageState {
  return {
    requestId: REQUEST.id,
    proposalVersion: 'v1',
    criteriaKey: criteriaKeyOf(REQUEST),
    shownKeys: ['dom:example.test'],
    shownIds: ['base-01'],
    page: 1,
    baseExhausted: false,
    webExhausted: false,
    webSearchesDone: 0,
    webStep: 0,
    webCache: { source: 'web', status: 'ok', candidates: [] },
    createdAt: now.toISOString(),
    expiresAt: pageStateExpiry(now),
  };
}

describe('criteriaKeyOf', () => {
  test('регистр и пробелы не меняют отпечаток, количество не входит', () => {
    const same = {
      id: 'req-1',
      items: [{ name: ' арматура ', quantity: 5, unit: 'т', requirements: 'а500с' }],
    };
    expect(criteriaKeyOf(same)).toBe(criteriaKeyOf(REQUEST));
  });

  test('другая позиция, требование или поле формы - другой отпечаток', () => {
    const base = criteriaKeyOf(REQUEST);
    const other = { ...REQUEST, items: [{ name: 'Швеллер', quantity: 1, unit: 'м' }] };
    const noReq = { ...REQUEST, items: [{ name: 'Арматура', quantity: 100, unit: 'м' }] };
    expect(criteriaKeyOf(other)).not.toBe(base);
    expect(criteriaKeyOf(noReq)).not.toBe(base);
    expect(criteriaKeyOf(REQUEST, { срок: '5 дней' })).not.toBe(base);
  });

  test('порядок полей формы не важен', () => {
    const a = criteriaKeyOf(REQUEST, { срок: '5', тираж: '10' });
    const b = criteriaKeyOf(REQUEST, { тираж: '10', срок: '5' });
    expect(a).toBe(b);
  });
});

describe('состояние выдачи', () => {
  test('срок отсчитывается от записи; после срока состояние не живо', () => {
    const value = stateAt(START);
    expect(isPageStateAlive(value, START)).toBe(true);
    const edge = new Date(START.getTime() + SHORTLIST_PAGE_TTL_MS);
    expect(isPageStateAlive(value, edge)).toBe(false);
    expect(isPageStateAlive(value, new Date(edge.getTime() + OVER_TTL_MS))).toBe(false);
  });

  test('битая дата срока - состояние не используется', () => {
    expect(isPageStateAlive({ ...stateAt(START), expiresAt: 'не дата' }, START)).toBe(false);
  });

  test('запись, чтение и удаление; запись закрыта (done) для ретенции', async () => {
    const store = new MemoryWorkflowStateStore();
    expect(await loadPageState(store, REQUEST.id)).toBeNull();
    await savePageState(store, stateAt(START));
    expect(await loadPageState(store, REQUEST.id)).toEqual(stateAt(START));
    // Закрытая запись не видна в «живом» просмотре, то есть её уберёт ретенция состояния.
    const live = await store.list(SHORTLIST_PAGE_NAMESPACE, null, LIST_LIMIT, { openOnly: true });
    expect(live).toEqual([]);
    const all = await store.list(SHORTLIST_PAGE_NAMESPACE, null, LIST_LIMIT);
    expect(all.map((entry) => entry.key)).toEqual([REQUEST.id]);
    await deletePageState(store, REQUEST.id);
    expect(await loadPageState(store, REQUEST.id)).toBeNull();
  });
});
