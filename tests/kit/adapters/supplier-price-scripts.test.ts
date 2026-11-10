import { describe, expect, test } from 'bun:test';
import {
  MemorySupplierPriceScripts,
} from '../../../src/kit/adapters/memory/supplier-price-scripts';
import {
  PostgresSupplierPriceScripts,
} from '../../../src/kit/adapters/postgres/supplier-price-scripts';
import { type PgClient, type PgRow } from '@business-ai/adapters';
import {
  PRICE_SCRIPT_KEEP_VERSIONS,
  type SupplierPriceScriptRepository,
} from '../../../src/kit/ports/supplier-price-scripts';

const FORM = 'a'.repeat(64);
const OTHER_FORM = 'b'.repeat(64);
const NOW = '2026-10-27T10:00:00.000Z';

function draft(code: string, form = FORM, supplierId = 's1') {
  return { supplierId, formHash: form, code, createdBy: 'agent' as const, createdAt: NOW };
}

describe('хранилище скриптов в памяти', () => {
  test('версии растут с 1, findLatest отдаёт последнюю, формы и поставщики раздельны', async () => {
    const repo: SupplierPriceScriptRepository = new MemorySupplierPriceScripts();
    expect(await repo.findLatest('s1', FORM)).toBeNull();
    expect((await repo.save(draft('v1'))).version).toBe(1);
    expect((await repo.save({ ...draft('v2'), createdBy: 'employee_request' })).version).toBe(2);
    const latest = await repo.findLatest('s1', FORM);
    expect(latest?.code).toBe('v2');
    expect(latest?.createdBy).toBe('employee_request');
    expect(await repo.findLatest('s1', OTHER_FORM)).toBeNull();
    expect(await repo.findLatest('s2', FORM)).toBeNull();
  });

  test('хранятся только последние версии', async () => {
    const repo = new MemorySupplierPriceScripts();
    for (let i = 1; i <= PRICE_SCRIPT_KEEP_VERSIONS + 2; i += 1) await repo.save(draft(`v${i}`));
    const versions = repo.versions('s1', FORM).map((item) => item.version);
    expect(versions).toHaveLength(PRICE_SCRIPT_KEEP_VERSIONS);
    expect(versions[versions.length - 1]).toBe(PRICE_SCRIPT_KEEP_VERSIONS + 2);
  });
});

describe('хранилище скриптов в PostgreSQL (запросы)', () => {
  function fakeClient(queries: Array<{ sql: string; params: readonly unknown[] }>): PgClient {
    const row: PgRow = {
      supplier_id: 's1',
      form_hash: FORM,
      version: '3',
      code: 'def run(tables, source): return []',
      created_by: 'agent',
      created_at: NOW,
    };
    const client: PgClient = {
      async query(sql, params) {
        queries.push({ sql, params: params ?? [] });
        return sql.startsWith('SELECT pg_advisory') || sql.includes('DELETE') ? [] : [row];
      },
      transaction: async (run) => run(client),
      close: async () => undefined,
    };
    return client;
  }

  test('save: блокировка пары, версия = max + 1, вытеснение старых по порогу', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const saved = await new PostgresSupplierPriceScripts(fakeClient(queries)).save(draft('x'));
    expect(saved.version).toBe(3);
    expect(saved.createdAt).toBe(NOW);
    expect(queries[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(queries[1]?.sql).toContain('COALESCE(MAX(version), 0) + 1');
    const del = queries[2];
    expect(del?.sql).toContain('DELETE FROM supplier_price_scripts');
    expect(del?.params[2]).toBe(3 - PRICE_SCRIPT_KEEP_VERSIONS);
  });

  test('findLatest: последняя версия по убыванию и разбор строки', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const found = await new PostgresSupplierPriceScripts(fakeClient(queries)).findLatest(
      's1',
      FORM,
    );
    expect(queries[0]?.sql).toContain('ORDER BY version DESC LIMIT 1');
    expect(found).toMatchObject({ supplierId: 's1', formHash: FORM, version: 3 });
  });
});
