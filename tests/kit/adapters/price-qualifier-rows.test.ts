import { describe, expect, test } from 'bun:test';
import { PostgresPriceRepository } from '../../../src/kit/adapters/postgres/price-repository';
import { type PgClient } from '@business-ai/adapters';
import { priceRow } from '../../../src/kit/adapters/postgres/rows.owned';

const BASE_ROW = {
  supplier_id: 's1',
  product_name: 'Ручка',
  sku: null,
  price: '500',
  currency: 'RUB',
  price_date: '2026-10-01T00:00:00.000Z',
};

describe('строка price_items с признаком цены', () => {
  test('qualifier и max читаются; NULL и отсутствие - точная цена', () => {
    const range = priceRow.parse({ ...BASE_ROW, price_qualifier: 'range', price_max: '700' });
    expect(range).toMatchObject({ priceQualifier: 'range', priceMax: 700 });
    const from = priceRow.parse({ ...BASE_ROW, price_qualifier: 'from', price_max: null });
    expect(from.priceQualifier).toBe('from');
    expect(from).not.toHaveProperty('priceMax');
    expect(priceRow.parse({ ...BASE_ROW, price_qualifier: null })).not.toHaveProperty(
      'priceQualifier',
    );
    expect(priceRow.parse(BASE_ROW)).not.toHaveProperty('priceQualifier');
  });

  test('тираж из одного элемента читается массивом', () => {
    const row = priceRow.parse({
      ...BASE_ROW,
      price_tiers: [{ minQuantity: 100, price: 45 }],
    });
    expect(row.priceTiers).toEqual([{ minQuantity: 100, price: 45 }]);
  });
});

describe('PostgresPriceRepository: признак цены', () => {
  test('запись передаёт priceQualifier/priceMax, чтение быстрым путём возвращает их', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const stored = [
      { ...BASE_ROW, price_tiers: null, price_qualifier: 'range', price_max: '700' },
      { ...BASE_ROW, product_name: 'Папка', price_tiers: null, price_qualifier: null },
    ];
    const client: PgClient = {
      async query(sql, params) {
        queries.push({ sql, params: params ?? [] });
        if (sql.includes('RETURNING key')) return [{ key: 'k' }];
        return sql.includes('FROM price_items') ? stored : [];
      },
      transaction: async (run) => run(client),
      close: async () => undefined,
    };
    const repo = new PostgresPriceRepository(client);
    const base = { supplierId: 's1', currency: 'RUB', date: '2026-10-01T00:00:00.000Z' };
    await repo.saveImport(
      's1',
      [
        { ...base, productName: 'Ручка', price: 500, priceQualifier: 'range', priceMax: 700 },
        { ...base, productName: 'Папка', price: 5 },
      ],
      'key-1' as never,
    );
    const insert = queries.find((q) => q.sql.includes('INSERT INTO price_items'));
    expect(insert?.sql).toContain("e.value->>'priceQualifier'");
    const batch = JSON.parse(String(insert?.params[3])) as Array<Record<string, unknown>>;
    expect(batch[0]).toMatchObject({ priceQualifier: 'range', priceMax: 700 });
    expect('priceQualifier' in (batch[1] ?? {})).toBe(false);
    const listed = await repo.listBySupplier('s1');
    expect(listed[0]).toMatchObject({ priceQualifier: 'range', priceMax: 700 });
    expect(listed[1]).not.toHaveProperty('priceQualifier');
  });
});
