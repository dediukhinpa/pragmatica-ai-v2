import { describe, expect, test } from 'bun:test';
import { loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import { entryLines } from '../../src/agents/order-calc/shortlist-message';
import type { MarketPriceSample } from '../../src/kit/domain/market-price';
import type { ShortlistEntry } from '../../src/kit/domain/shortlist';
import { CTX } from './support';
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Свежая цена вместо исторического минимума в шорт-листе (этап 161). Данные синтетические. */

const PRODUCT = 'Календарь квартальный';

async function addPrice(
  deps: OrderTestDeps,
  key: string,
  patch: { price: number; date: string; sourceFile?: string; tiers?: Array<[number, number]> },
): Promise<void> {
  await deps.prices.saveImport(
    's1',
    [
      {
        supplierId: 's1',
        productName: PRODUCT,
        price: patch.price,
        currency: 'RUB',
        date: patch.date,
        ...(patch.sourceFile === undefined ? {} : { sourceFile: patch.sourceFile }),
        ...(patch.tiers === undefined
          ? {}
          : { priceTiers: patch.tiers.map(([minQuantity, price]) => ({ minQuantity, price })) }),
      },
    ],
    key,
  );
}

async function pricesOfS1(deps: OrderTestDeps): Promise<MarketPriceSample[]> {
  await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
  const result = await loadSourceResult(deps, REQUEST_ID, 'knowledge');
  const candidate = result?.candidates.find((c) => c.supplierId === 's1');
  return candidate?.prices ?? [];
}

/** Заявка на календарь: посевные строки арматуры в сравнении не участвуют. */
/** Сдвиг часов от 01.01.2026 за дату самого свежего прайса теста (~ноябрь 2026). */
const CLOCK_SHIFT_MS = 300 * 24 * 60 * 60 * 1000;

async function freshDeps(): Promise<OrderTestDeps> {
  const items = [{ name: PRODUCT, quantity: 500, unit: 'шт' }];
  const deps = await buildOrderDeps({ request: { ...ORDER_REQUEST, items } });
  // Даты прайсов в тестах до октября 2026: часы позже них, иначе дата считалась бы будущей.
  deps.clock.advance(CLOCK_SHIFT_MS);
  return deps;
}

describe('шорт-лист берёт свежую цену позиции', () => {
  test('новая цена выше старой: выбрана новая, дата прайса в образце', async () => {
    const deps = await freshDeps();
    await addPrice(deps, 'old', { price: 10, date: '2024-03-31T00:00:00.000Z', sourceFile: 'a' });
    await addPrice(deps, 'new', { price: 99, date: '2026-10-03T00:00:00.000Z', sourceFile: 'b' });
    const prices = await pricesOfS1(deps);
    expect(prices).toHaveLength(1);
    expect(prices[0]?.amount).toBe(99);
    expect(prices[0]?.priceDate).toBe('2026-10-03T00:00:00.000Z');
    expect(prices[0]?.priceStale).toBeUndefined();
  });

  test('лестница тиражей берётся из той же строки, что и цена', async () => {
    const deps = await freshDeps();
    await addPrice(deps, 'old', {
      price: 10,
      date: '2024-03-31T00:00:00.000Z',
      sourceFile: 'a',
      tiers: [
        [100, 10],
        [500, 9],
      ],
    });
    await addPrice(deps, 'new', {
      price: 99,
      date: '2026-10-03T00:00:00.000Z',
      sourceFile: 'b',
      tiers: [
        [200, 99],
        [800, 95],
      ],
    });
    const [price] = await pricesOfS1(deps);
    expect(price?.amount).toBe(99);
    expect(price?.tiers).toEqual([
      { minQuantity: 200, price: 99 },
      { minQuantity: 800, price: 95 },
    ]);
  });

  test('старый прайс получает пометку «прайс старше года»', async () => {
    const deps = await freshDeps();
    await addPrice(deps, 'old', { price: 79, date: '2024-03-31T00:00:00.000Z', sourceFile: 'a' });
    const [price] = await pricesOfS1(deps);
    expect(price?.priceStale).toBe(true);
    const entry: ShortlistEntry = {
      supplierId: 's1',
      name: 'ТЕСТ Поставщик',
      sources: ['knowledge'],
      score: 1,
      references: [],
      prices: price === undefined ? [] : [price],
    };
    const text = entryLines(entry, 0).join('\n');
    expect(text).toContain('79 ₽ (прайс от 31.03.2024) (прайс старше года)');
  });

  test('свежая цена без пометки устаревшего', () => {
    const entry: ShortlistEntry = {
      supplierId: 's1',
      name: 'ТЕСТ Поставщик',
      sources: ['knowledge'],
      score: 1,
      references: [],
      prices: [
        { amount: 81.37, currency: 'RUB', priceDate: '2026-10-03T00:00:00.000Z', vat: 'included' },
      ],
    };
    const text = entryLines(entry, 0).join('\n');
    expect(text).toContain('81,37 ₽ (прайс от 03.10.2026) (с НДС)');
    expect(text).not.toContain('старше года');
  });

  test('цена с диска не уступает почтовой при равной дате (этап 150)', async () => {
    const deps = await freshDeps();
    const date = '2026-10-03T00:00:00.000Z';
    await addPrice(deps, 'mail', { price: 40, date, sourceFile: 'mail:test-1' });
    await addPrice(deps, 'disk', { price: 60, date, sourceFile: 'produkciya/test/price.xlsx' });
    const [price] = await pricesOfS1(deps);
    expect(price?.amount).toBe(60);
  });
});
