import { describe, expect, test } from 'bun:test';
import { PostgresPriceRepository } from '../../../src/kit/adapters/postgres/price-repository';
import { type PgClient } from '@business-ai/adapters';
import { priceRow } from '../../../src/kit/adapters/postgres/rows.owned';

const BASE_ROW = {
  supplier_id: 's1',
  product_name: 'Ручка',
  sku: null,
  price: '12',
  currency: 'RUB',
  price_date: '2026-10-01T00:00:00.000Z',
};

describe('строка price_items с тиражами', () => {
  test('price_tiers массивом, строкой и NULL', () => {
    const tiers = [
      { minQuantity: 50, price: 12 },
      { minQuantity: 100, price: 10 },
    ];
    expect(priceRow.parse({ ...BASE_ROW, price_tiers: tiers }).priceTiers).toEqual(tiers);
    expect(priceRow.parse({ ...BASE_ROW, price_tiers: JSON.stringify(tiers) }).priceTiers).toEqual(
      tiers,
    );
    expect(priceRow.parse({ ...BASE_ROW, price_tiers: null }).priceTiers).toBeUndefined();
    expect(priceRow.parse(BASE_ROW).priceTiers).toBeUndefined();
  });
});

describe('PostgresPriceRepository: тиражи', () => {
  const tiers = [
    { minQuantity: 50, price: 12 },
    { minQuantity: 100, price: 10 },
  ];

  test('запись передаёт priceTiers в пакете, только у позиций с тиражами', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client: PgClient = {
      async query(sql, params) {
        queries.push({ sql, params: params ?? [] });
        return sql.includes('RETURNING key') ? [{ key: 'k' }] : [];
      },
      transaction: async (run) => run(client),
      close: async () => undefined,
    };
    const repo = new PostgresPriceRepository(client);
    const base = { supplierId: 's1', currency: 'RUB', date: '2026-10-01T00:00:00.000Z' };
    await repo.saveImport(
      's1',
      [
        { ...base, productName: 'Ручка', price: 12, priceTiers: tiers },
        { ...base, productName: 'Папка', price: 5 },
      ],
      'key-1' as never,
    );
    const insert = queries.find((q) => q.sql.includes('INSERT INTO price_items'));
    expect(insert?.sql).toContain("e.value->'priceTiers'");
    const batch = JSON.parse(String(insert?.params[3])) as Array<Record<string, unknown>>;
    expect(batch[0]?.['priceTiers']).toEqual(tiers);
    expect('priceTiers' in (batch[1] ?? {})).toBe(false);
  });

  test('чтение возвращает тиражи у позиции и не добавляет их остальным', async () => {
    const rows = [
      { ...BASE_ROW, price_tiers: tiers },
      { ...BASE_ROW, product_name: 'Папка', price_tiers: null },
    ];
    const client: PgClient = {
      async query(sql) {
        return sql.includes('count(*)') ? [] : rows;
      },
      transaction: async (run) => run(client),
      close: async () => undefined,
    };
    const found = await new PostgresPriceRepository(client).searchProducts('ручка', 10);
    expect(found[0]?.priceTiers).toEqual(tiers);
    expect(found[1]?.priceTiers).toBeUndefined();
    const listed = await new PostgresPriceRepository(client).listBySupplier('s1');
    expect(listed[0]?.priceTiers).toEqual(tiers);
    expect(listed[1]).not.toHaveProperty('priceTiers');
  });
});
