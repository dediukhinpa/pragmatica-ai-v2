import { describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  SUPPLIER_DISCOVERY_NAMESPACE,
  SUPPLIER_DISCOVERY_TTL_MS,
  discoveryQueryKey,
  loadDiscoveryState,
  newDiscoveryState,
  saveDiscoveryState,
  shownCandidateByNumber,
  type DiscoveredCandidate,
} from '../../src/supplier-discovery-state';

/** Состояние списка кандидатов для пополнения базы (этап 8z): срок жизни, ключ, номера. */

const THREAD = 'order-calc/u-state';
const NOW = new Date('2026-11-22T10:00:00.000Z');

function candidate(number: number, shown: boolean): DiscoveredCandidate {
  return {
    number,
    name: `Кандидат ${number}`,
    nameConfirmed: true,
    website: `https://candidate-${number}.test`,
    domain: `candidate-${number}.test`,
    sourceUrl: `https://candidate-${number}.test/contacts`,
    phones: [],
    emails: [],
    categories: [],
    evidence: `Источник: https://candidate-${number}.test/contacts`,
    shown,
  };
}

describe('состояние пополнения базы', () => {
  test('записанное читается обратно, запись помечена done для ретенции', async () => {
    const store = new MemoryWorkflowStateStore(() => NOW.getTime());
    const state = newDiscoveryState({ query: 'ёлочные игрушки', now: NOW });
    state.candidates.push(candidate(1, true));
    await saveDiscoveryState(store, THREAD, state);
    expect(await loadDiscoveryState(store, THREAD, NOW)).toEqual(state);
    // done: запись уходит по сроку хранения состояния (в ней контакты компаний).
    const all = await store.list(SUPPLIER_DISCOVERY_NAMESPACE, null, 10);
    const open = await store.list(SUPPLIER_DISCOVERY_NAMESPACE, null, 10, { openOnly: true });
    expect(all.map((entry) => entry.key)).toEqual([THREAD]);
    expect(open).toEqual([]);
  });

  test('после срока жизни состояние не читается: список начинается заново', async () => {
    const store = new MemoryWorkflowStateStore(() => NOW.getTime());
    await saveDiscoveryState(store, THREAD, newDiscoveryState({ query: 'ёлка', now: NOW }));
    const almost = new Date(NOW.getTime() + SUPPLIER_DISCOVERY_TTL_MS - 1);
    expect(await loadDiscoveryState(store, THREAD, almost)).not.toBeNull();
    const expired = new Date(NOW.getTime() + SUPPLIER_DISCOVERY_TTL_MS);
    expect(await loadDiscoveryState(store, THREAD, expired)).toBeNull();
  });

  test('повреждённая запись не ошибка, а отсутствие состояния', async () => {
    const store = new MemoryWorkflowStateStore(() => NOW.getTime());
    await store.put(SUPPLIER_DISCOVERY_NAMESPACE, THREAD, { queryKey: 42 });
    expect(await loadDiscoveryState(store, THREAD, NOW)).toBeNull();
    expect(await loadDiscoveryState(store, 'другой-тред', NOW)).toBeNull();
  });

  test('ключ запроса не зависит от регистра, ё и пробелов, но зависит от региона', () => {
    const base = discoveryQueryKey('Ёлочные  игрушки', undefined);
    expect(discoveryQueryKey(' елочные игрушки ', undefined)).toBe(base);
    expect(discoveryQueryKey('ёлочные игрушки', 'Казань')).not.toBe(base);
    expect(discoveryQueryKey('ёлочные шары', undefined)).not.toBe(base);
  });

  test('номером можно назвать только показанного кандидата', () => {
    const state = newDiscoveryState({ query: 'ёлка', now: NOW });
    state.candidates.push(candidate(1, true), candidate(2, false));
    expect(shownCandidateByNumber(state, 1)?.name).toBe('Кандидат 1');
    expect(shownCandidateByNumber(state, 2)).toBeUndefined();
    expect(shownCandidateByNumber(state, 3)).toBeUndefined();
  });
});
