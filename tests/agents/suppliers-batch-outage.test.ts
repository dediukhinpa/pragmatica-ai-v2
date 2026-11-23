import { beforeEach, describe, expect, test } from 'bun:test';
import { applySupplierBatch, type BatchRetryRows } from '../../src/agents/suppliers/batch-apply';
import { type SupplierBatchRow } from '../../src/agents/suppliers/card-request';
import { DomainError } from '@business-ai/core';
import { USER_A, buildSupplierWorld, type SupplierWorld } from './suppliers-support';

const NOW = '2026-01-01T00:00:00.000Z';
const CONTEXT = { userId: USER_A, nowIso: NOW, source: 'file' } as const;
const ROW_COUNT = 6;

let world: SupplierWorld;

beforeEach(() => {
  world = buildSupplierWorld();
});

function rowsOf(count: number): SupplierBatchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    row: index + 2,
    fields: { name: `Поставщик ${index + 1}` },
  }));
}

function newRetry(): BatchRetryRows {
  return { rows: new Set(), duplicates: new Set() };
}

/** Хранилище «зависло»: поиск дублей падает повторяемой ошибкой, считаем обращения. */
function breakStorage(failAfter: number): { calls: () => number } {
  let calls = 0;
  const original = world.suppliers.findDuplicates.bind(world.suppliers);
  world.suppliers.findDuplicates = async (candidate) => {
    calls += 1;
    if (calls > failAfter) {
      throw new DomainError('external_failure', 'Таймаут запроса', { retryable: true });
    }
    return original(candidate);
  };
  return { calls: () => calls };
}

describe('applySupplierBatch: недоступное хранилище', () => {
  test('после первой повторяемой ошибки остаток в retry без обращений к БД и один лог', async () => {
    const storage = breakStorage(2);
    const events: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
    world.deps.log = (event, fields) => events.push({ event, fields });
    const retry = newRetry();
    const result = await applySupplierBatch(
      world.deps,
      { rows: rowsOf(ROW_COUNT), duplicates: [] },
      'save',
      CONTEXT,
      retry,
    );
    expect(result.created).toBe(2);
    expect(storage.calls()).toBe(3); // две записи и одна упавшая попытка, остальное - без БД
    expect(result.failed.map((item) => item.row)).toEqual([4, 5, 6, 7]);
    expect(result.failed.every((item) => item.code === 'external_failure')).toBe(true);
    expect([...retry.rows]).toEqual([4, 5, 6, 7]);
    expect(events).toEqual([
      {
        event: 'supplier_batch_storage_unavailable',
        fields: { code: 'external_failure', notTried: 3 },
      },
    ]);
  });

  test('неповторяемая ошибка строки не прерывает обход', async () => {
    const original = world.suppliers.findDuplicates.bind(world.suppliers);
    let calls = 0;
    world.suppliers.findDuplicates = async (candidate) => {
      calls += 1;
      if (calls === 1) throw new DomainError('invalid_input', 'Плохая строка');
      return original(candidate);
    };
    const events: string[] = [];
    world.deps.log = (event) => events.push(event);
    const retry = newRetry();
    const result = await applySupplierBatch(
      world.deps,
      { rows: rowsOf(3), duplicates: [] },
      'save',
      CONTEXT,
      retry,
    );
    expect(result.created).toBe(2);
    expect(result.failed).toEqual([{ row: 2, code: 'invalid_input' }]);
    expect(retry.rows.size).toBe(0);
    expect(events).toEqual([]);
  });

  test('обновление дублей: после сбоя оставшиеся дубли тоже уходят в retry', async () => {
    let reads = 0;
    world.suppliers.getCard = async () => {
      reads += 1;
      throw new DomainError('external_failure', 'Таймаут запроса', { retryable: true });
    };
    const retry = newRetry();
    const duplicates = rowsOf(3).map((row) => ({ ...row, targetId: `t-${row.row}` }));
    const result = await applySupplierBatch(
      world.deps,
      { rows: [], duplicates },
      'update',
      CONTEXT,
      retry,
    );
    expect(result.updated).toBe(0);
    expect(result.failed).toHaveLength(3);
    expect([...retry.duplicates]).toEqual([2, 3, 4]);
    expect(reads).toBe(1);
  });
});
