import { beforeEach, describe, expect, test } from 'bun:test';
import { computeMarketAverage, type MarketPriceSample } from '../../src/kit/domain/market-price';
import { PRICE_PROPOSAL_NAMESPACE } from '../../src/agents/prices/deps';
import {
  listProposals,
  savePriceProposal,
  unconfirmedLookup,
} from '../../src/agents/prices/price-proposals';
import { writeImport } from '../../src/agents/prices/import-checks';
import { entryLines } from '../../src/agents/order-calc/shortlist-message';
import { SUPPLIER_ID, existingPrice } from './support';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';

/** Решение владельца 26.10.2026: диск - источник правды, остальное - предложения. */
describe('диск - источник правды по ценам', () => {
  let deps: FullPricesDeps;
  beforeEach(async () => {
    deps = await buildFullPricesDeps();
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
  });

  test('импорт не с диска не трогает базу цен и создаёт предложение', async () => {
    const result = await writeImport(
      deps,
      {
        supplierId: SUPPLIER_ID,
        importId: 'imp-mail',
        sourceRowCount: 1,
        items: [existingPrice('Болт', 12)],
        source: 'mail',
        senderUnverified: true,
        sourceDate: '2026-10-24T09:00:00.000Z',
      },
      'key-mail',
    );
    expect(result).toEqual({
      status: 'proposed_not_written',
      changed: 1,
      proposed: 1,
      warnings: [],
    });
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).map((item) => item.price)).toEqual([
      10,
    ]);
    const proposals = await listProposals(deps.state, SUPPLIER_ID);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.senderVerified).toBe(false);
    const note = await unconfirmedLookup(deps.state)(existingPrice('Болт', 10));
    expect(note).toBe(
      'свежая неподтверждённая цена 12 RUB (письмо от 24.10.2026, отправитель не подтверждён, ' +
        'на диск не внесена)',
    );
  });

  test('импорт с диска пишет в базу и закрывает более старые предложения', async () => {
    await savePriceProposal(deps, {
      supplierId: SUPPLIER_ID,
      importId: 'imp-chat',
      source: 'intake',
      items: [existingPrice('Болт', 12)],
    });
    const result = await writeImport(
      deps,
      {
        supplierId: SUPPLIER_ID,
        importId: 'imp-disk',
        sourceRowCount: 1,
        items: [existingPrice('Болт', 11)],
        source: 'disk',
      },
      'key-disk',
    );
    expect(result.status).toBe('written');
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).map((item) => item.price)).toEqual([
      11,
    ]);
    expect(await deps.state.list(PRICE_PROPOSAL_NAMESPACE, null, 10)).toEqual([]);
  });

  test('шорт-лист показывает справку, а среднее по рынку её не учитывает', () => {
    const note = 'свежая неподтверждённая цена 100 RUB (письмо от 24.10.2026, на диск не внесена)';
    const prices: MarketPriceSample[] = [
      { item: 'Болт', amount: 10, currency: 'RUB', unconfirmed: note },
      { item: 'Болт', amount: 20, currency: 'RUB' },
      { item: 'Болт', amount: 30, currency: 'RUB' },
    ];
    const market = computeMarketAverage(prices);
    expect(market.status).toBe('ok');
    if (market.status === 'ok') expect(market.groups[0]?.average).toBe(20);
    const lines = entryLines(
      {
        supplierId: SUPPLIER_ID,
        name: 'МеталлТорг',
        sources: ['knowledge'],
        score: 1,
        references: [],
        prices,
      },
      0,
    );
    expect(lines.join('\n')).toContain(`Болт: 10`);
    expect(lines.join('\n')).toContain(`(${note})`);
  });
});
