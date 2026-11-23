import { describe, expect, test } from 'bun:test';
import { PostgresPriceRepository } from '../../../src/kit/adapters/postgres/price-repository';
import { type PgClient } from '@business-ai/adapters';
import { priceRow } from '../../../src/kit/adapters/postgres/rows.owned';

const TIERS = [
  { minQuantity: 62000, price: 1200 },
  { minQuantity: 102000, price: 1100 },
];
const BASE_ROW = {
  supplier_id: 's1',
  product_name: 'Одеяло',
  sku: null,
  price: '1200',
  currency: 'RUB',
  price_date: '2026-10-01T00:00:00.000Z',
  price_tiers: TIERS,
};

describe('основание тиража: чтение строк', () => {
  test('order_sum попадает в позицию, quantity и NULL - нет (хэши прежних позиций прежние)', () => {
    expect(priceRow.parse({ ...BASE_ROW, price_tier_basis: 'order_sum' }).priceTierBasis).toBe(
      'order_sum',
    );
    expect(priceRow.parse({ ...BASE_ROW, price_tier_basis: 'quantity' })).not.toHaveProperty(
      'priceTierBasis',
    );
    expect(priceRow.parse(BASE_ROW)).not.toHaveProperty('priceTierBasis');
  });

  test('репозиторий (быстрый разбор) отдаёт основание и пишет его в пакете вставки', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const rows = [{ ...BASE_ROW, price_tier_basis: 'order_sum' }];
    const client: PgClient = {
      async query(sql, params) {
        queries.push({ sql, params: params ?? [] });
        if (sql.includes('RETURNING key')) return [{ key: 'k' }];
        return sql.includes('FROM price_items') ? rows : [];
      },
      transaction: async (run) => run(client),
      close: async () => undefined,
    };
    const repo = new PostgresPriceRepository(client);
    const listed = await repo.listBySupplier('s1');
    expect(listed[0]?.priceTierBasis).toBe('order_sum');
    const item = { ...listed[0]!, supplierId: 's1' };
    await repo.saveImport('s1', [item], 'key-1' as never);
    const insert = queries.find((q) => q.sql.includes('INSERT INTO price_items'));
    expect(insert?.sql).toContain('price_tier_basis');
    const batch = JSON.parse(String(insert?.params[3])) as Array<Record<string, unknown>>;
    expect(batch[0]?.['priceTierBasis']).toBe('order_sum');
  });
});
