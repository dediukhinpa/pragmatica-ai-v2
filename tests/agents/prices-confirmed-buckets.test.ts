import { describe, expect, test } from 'bun:test';
import { loadConfirmedPrices, saveConfirmedPrices } from '../../src/agents/prices/confirmed-prices';
import { SUPPLIER_ID } from './support';
import { buildFullPricesDeps, skuItem } from './prices-support';

describe('R3-ALG-5: опустевшие корзины подтверждённых цен', () => {
  test('все позиции сняты: корзины очищены, старые цены не всплывают', async () => {
    const deps = await buildFullPricesDeps();
    const first = [skuItem('Болт', 100, 'B1'), skuItem('Гайка', 5, 'G1')];
    await saveConfirmedPrices(deps, SUPPLIER_ID, [], first);
    expect(await loadConfirmedPrices(deps, SUPPLIER_ID)).toHaveLength(2);
    await saveConfirmedPrices(deps, SUPPLIER_ID, first, []);
    expect(await loadConfirmedPrices(deps, SUPPLIER_ID)).toEqual([]);
  });

  test('часть позиций снята: остаются только оставшиеся (много корзин)', async () => {
    const deps = await buildFullPricesDeps();
    const many = Array.from({ length: 40 }, (_, i) => skuItem(`Т${i}`, 10 + i, `S${i}`));
    await saveConfirmedPrices(deps, SUPPLIER_ID, [], many);
    const kept = many.slice(0, 1);
    await saveConfirmedPrices(deps, SUPPLIER_ID, many, kept);
    const loaded = await loadConfirmedPrices(deps, SUPPLIER_ID);
    expect(loaded.map((i) => i.sku)).toEqual(['S0']);
  });
});
