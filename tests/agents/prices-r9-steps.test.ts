import { describe, expect, test } from 'bun:test';
import { priceListHash } from '../../src/agents/prices/employee-updates';
import { runPriceStepsYielding } from '../../src/agents/prices/price-steps';
import { stableHash } from '@business-ai/core';
import {
  countPriceUpdatesSteps,
  diffPrices,
  diffPricesSteps,
  findPriceJumpsSteps,
  nextConfirmedPricesSteps,
  priceItemKey,
} from '../../src/kit/domain/price-diff';
import { type PriceItem } from '../../src/kit/domain/models';
import * as refDiff from '../kit/domain/support/price-diff-reference';

/**
 * R9-A1-01: сверка большого прайса идёт по шагам с уступками циклу событий, а результат и
 * отпечатки (diffHash, отпечаток базы) - те же, что у синхронного расчёта и эталона.
 */

/** Больше шага пошагового расчёта, чтобы уступки действительно случались. */
const SIZE = 9_000;
const DATE = '2026-01-01T00:00:00Z';
const LATER = '2026-02-01T00:00:00Z';
/** Эталон без оптимизаций медленный, а хост тестов бывает загружен. */
const TEST_TIMEOUT_MS = 60_000;

function priceList(base: number, date: string, shift: number): PriceItem[] {
  return Array.from({ length: SIZE }, (_, index) => ({
    supplierId: 's1',
    productName: `Труба профильная ${index}`,
    // Часть позиций без артикула, часть - с артикулом, который в новом прайсе сменится.
    ...(index % 50 === 0 ? {} : { sku: `TP-${index % 97 === 0 ? index + shift : index}` }),
    price: base + (index % 7) + (index % 13 === 0 ? base : 0),
    currency: 'RUB',
    date,
  }));
}

/** Отпечаток базы по эталону: те же строки, что строит `priceListHash`. */
function referenceListHash(items: readonly PriceItem[]): string {
  const rows = [...refDiff.latestPrices(items).values()]
    .map((item): [string, number, string] => [
      refDiff.priceItemKey(item),
      item.price,
      item.currency,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return stableHash(rows);
}

describe('пошаговая сверка прайса (R9-A1-01)', () => {
  test('уступает циклу событий и даёт тот же результат и те же отпечатки', async () => {
    const existing = priceList(100, DATE, 0);
    const confirmed = priceList(100, DATE, 0).slice(0, SIZE / 2);
    const incoming = priceList(101, LATER, 1);
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const diff = await runPriceStepsYielding(diffPricesSteps(existing, incoming, 0.5, confirmed));
    running = false;
    // Пока шла сверка, другие задачи цикла событий выполнялись.
    expect(ticks).toBeGreaterThan(2);

    const expected = refDiff.diffPrices(existing, incoming, 0.5, confirmed);
    expect(diff).toEqual(expected);
    expect(diff).toEqual(diffPrices(existing, incoming, 0.5, confirmed));
    expect(stableHash(diff)).toBe(stableHash(expected));
    expect(diff.jumps.length).toBeGreaterThan(0);
    expect(diff.review.some((entry) => entry.reason === 'sku_changed')).toBe(true);

    expect(
      await runPriceStepsYielding(findPriceJumpsSteps(incoming, existing, undefined, confirmed)),
    ).toEqual(refDiff.findPriceJumps(incoming, existing, undefined, confirmed));
    const approved = new Set(expected.jumps.map((jump) => jump.key));
    expect(
      await runPriceStepsYielding(
        nextConfirmedPricesSteps(confirmed, existing, incoming, approved),
      ),
    ).toEqual(refDiff.nextConfirmedPrices(confirmed, existing, incoming, approved));
    expect(await runPriceStepsYielding(countPriceUpdatesSteps(existing, incoming))).toBe(
      expected.added.length + expected.changed.length,
    );
    expect(priceListHash(existing)).toBe(referenceListHash(existing));
    expect(priceListHash(incoming)).toBe(referenceListHash(incoming));
    for (const item of incoming.slice(0, 200)) {
      expect(priceItemKey(item)).toBe(refDiff.priceItemKey(item));
    }
  }, TEST_TIMEOUT_MS);
});
