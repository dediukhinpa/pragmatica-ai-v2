import { beforeEach, describe, expect, test } from 'bun:test';
import { listStalePriceSuppliers } from '../../src/agents/prices/stale-price-suppliers';
import { CTX, SUPPLIER_ID, existingPrice } from './support';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';

const DAY_MS = 86_400_000;
/** Заведомо старше трёх календарных месяцев (максимум 3 месяца = 92 дня). */
const STALE_DAYS_AGO = 100;
/** Заведомо свежее порога. */
const FRESH_DAYS_AGO = 10;
let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

/** Прайс поставщика, обновлённый `daysAgo` дней назад (относительно часов теста). */
async function seedPrice(supplierId: string, daysAgo: number): Promise<void> {
  const date = new Date(deps.clock.now().getTime() - daysAgo * DAY_MS).toISOString();
  const item = { ...existingPrice('Болт', 10), supplierId, date };
  await deps.prices.saveImport(supplierId, [item], 'k');
}

describe('listStalePriceSuppliers', () => {
  test('прайс старше трёх календарных месяцев: попадает в список', async () => {
    await deps.suppliers.upsert({ id: 's2', name: 'СвежийПрайс', email: 'f@example.test' });
    await deps.suppliers.upsert({ id: 's3', name: 'БезПрайса' });
    await seedPrice(SUPPLIER_ID, STALE_DAYS_AGO);
    await seedPrice('s2', FRESH_DAYS_AGO);
    const out = await listStalePriceSuppliers.execute({}, deps, CTX);
    expect(out.suppliers.map((s) => s.supplierId)).toEqual([SUPPLIER_ID]);
    expect(out.suppliers[0]).toMatchObject({ daysSinceUpdate: STALE_DAYS_AGO, hasEmail: true });
  });
});
