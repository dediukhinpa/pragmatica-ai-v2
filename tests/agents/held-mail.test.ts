import { describe, expect, test } from 'bun:test';
import { FixedClock, MemoryWorkflowStateStore } from '@business-ai/adapters';
import { HELD_MAX_REREADS, HELD_REREAD_MIN_INTERVAL_MS, holdOrSkip } from '@business-ai/core';

const NS = 'test:held';
const STEP = HELD_REREAD_MIN_INTERVAL_MS;

describe('holdOrSkip: попытки перечитывания письма без содержимого', () => {
  test('проходы с шагом интервала: hold до предела и срока, потом skip без чтения', async () => {
    const store = new MemoryWorkflowStateStore();
    const clock = new FixedClock();
    let reads = 0;
    const failing = async (): Promise<null> => {
      reads += 1;
      return null;
    };
    const kinds: string[] = [];
    for (let pass = 0; pass < HELD_MAX_REREADS + 3; pass += 1) {
      kinds.push((await holdOrSkip(store, NS, 'm1', failing, clock)).kind);
      clock.advance(STEP);
    }
    // Пять засчитанных попыток держат, на шестом проходе (интервал × предел) - пропуск.
    expect(kinds.slice(0, HELD_MAX_REREADS)).toEqual(Array(HELD_MAX_REREADS).fill('hold'));
    expect(kinds.slice(HELD_MAX_REREADS)).toEqual(['skip', 'skip', 'skip']);
    expect(reads).toBe(HELD_MAX_REREADS);
  });

  test('проходы внутри интервала не растят счётчик и не дают skip', async () => {
    const store = new MemoryWorkflowStateStore();
    const clock = new FixedClock();
    for (let pass = 0; pass < HELD_MAX_REREADS * 4; pass += 1) {
      const outcome = await holdOrSkip(store, NS, 'm1', async () => null, clock);
      expect(outcome.kind).toBe('hold');
      clock.advance(10_000);
    }
    expect(await store.get(NS, 'm1')).toMatchObject({ attempts: 1 });
  });

  test('успешное чтение внутри интервала возвращает значение', async () => {
    const store = new MemoryWorkflowStateStore();
    const clock = new FixedClock();
    await holdOrSkip(store, NS, 'm1', async () => null, clock);
    clock.advance(1_000);
    expect(await holdOrSkip(store, NS, 'm1', async () => 'ok', clock)).toEqual({
      kind: 'read',
      value: 'ok',
    });
  });

  test('запись прежнего формата (только счётчик) читается и считается давней', async () => {
    const store = new MemoryWorkflowStateStore();
    const clock = new FixedClock();
    await store.put(NS, 'old', { attempts: HELD_MAX_REREADS }, { done: true });
    expect((await holdOrSkip(store, NS, 'old', async () => null, clock)).kind).toBe('skip');
    await store.put(NS, 'old2', { attempts: 1 }, { done: true });
    expect((await holdOrSkip(store, NS, 'old2', async () => null, clock)).kind).toBe('hold');
    expect(await store.get(NS, 'old2')).toMatchObject({ attempts: 2 });
  });

  test('успешное чтение возвращает значение и счётчик не растёт', async () => {
    const store = new MemoryWorkflowStateStore();
    const result = await holdOrSkip(store, NS, 'm2', async () => 'ok', new FixedClock());
    expect(result).toEqual({ kind: 'read', value: 'ok' });
    expect(await store.get(NS, 'm2')).toBeNull();
  });

  test('ключи разных писем независимы', async () => {
    const store = new MemoryWorkflowStateStore();
    const clock = new FixedClock();
    for (let pass = 0; pass < HELD_MAX_REREADS; pass += 1) {
      await holdOrSkip(store, NS, 'a', async () => null, clock);
      clock.advance(STEP);
    }
    expect((await holdOrSkip(store, NS, 'b', async () => null, clock)).kind).toBe('hold');
  });
});
