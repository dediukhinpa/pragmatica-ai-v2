import { describe, expect, test } from 'bun:test';

import { webPricesFields } from '../../../src/agents/order-calc/web-enrichment';

type Facts = Parameters<typeof webPricesFields>[0];

const facts = (prices: Array<Record<string, unknown>>): Facts => ({ prices }) as unknown as Facts;

describe('webPricesFields', () => {
  test('сорт вместо позиции сводится к позиции по слову', () => {
    const out = webPricesFields(
      facts([{ item: 'Донниковый мёд Светлый', offer: 'Крем-мёд 300гр', amount: 121.5 }]),
      ['Мёд', 'Орехи'],
    );
    expect(out.webPrices?.map((p) => p.item)).toEqual(['Мёд']);
  });

  test('медведь не считается мёдом', () => {
    const out = webPricesFields(facts([{ item: 'Медведь плюшевый', amount: 10 }]), [
      'Мёд',
      'Орехи',
    ]);
    expect(out.webPrices).toBeUndefined();
  });

  test('единственная позиция заявки принимает цену любого названия', () => {
    const out = webPricesFields(facts([{ item: 'Липовый', amount: 5 }]), ['Мёд']);
    expect(out.webPrices?.[0]?.item).toBe('Мёд');
  });

  test('точное совпадение и одна цена на позицию', () => {
    const out = webPricesFields(
      facts([
        { item: 'орехи', amount: 1 },
        { item: 'Грецкий орех', amount: 2 },
      ]),
      ['Мёд', 'Орехи'],
    );
    expect(out.webPrices).toHaveLength(1);
    expect(out.webPrices?.[0]?.amount).toBe(1);
  });
});
