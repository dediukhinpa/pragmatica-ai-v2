import { describe, expect, test } from 'bun:test';
import {
  diffPrices,
  findPriceJumps,
  nextConfirmedPrices,
  priceItemKey,
} from '../../../src/kit/domain/price-diff';
import { validatePriceImport } from '../../../src/kit/domain/validators.owned';
import { type PriceItem } from '../../../src/kit/domain/models';
import { rng } from '@business-ai/testing';
import * as refDiff from './support/price-diff-reference';

/**
 * R9-A1-05: новая позиция с тем же названием, что у позиций с оставшимися артикулами, - это
 * пополнение прайса (новый размер), а не скачок цены. Скачок - только если цена вне диапазона
 * одноимённых. При смене формата артикулов (O(n·g)) сверка группы делается один раз на группу.
 */

const OLD_DATE = '2026-10-01T00:00:00.000Z';
const NEW_DATE = '2026-10-10T00:00:00.000Z';

function bolt(sku: string, price: number, date = NEW_DATE, currency = 'RUB'): PriceItem {
  return { supplierId: 's', productName: 'Болт DIN 933', sku, price, currency, date };
}

describe('R9-A1-05: новая одноимённая позиция', () => {
  const existing = [bolt('933-M6', 10, OLD_DATE), bolt('933-M24', 300, OLD_DATE)];

  test('цена внутри диапазона одноимённых - позиция добавлена, скачка нет', () => {
    const incoming = [bolt('933-M6', 10), bolt('933-M24', 300), bolt('933-M12', 60)];
    // Раньше: скачок «933-M12 10 -> 60 (+500%)», импорт без кнопки не фиксировался.
    expect(findPriceJumps(incoming, existing, 0.5, existing)).toEqual([]);
    const diff = diffPrices(existing, incoming, 0.5, existing);
    expect(diff.added.map((item) => item.sku)).toEqual(['933-M12']);
    expect(diff.jumps).toEqual([]);
    expect(diff.review.map((entry) => entry.reason)).not.toContain('price_jump');
    expect(
      validatePriceImport({ sourceRowCount: 3, imported: incoming, existing, confirmed: existing }),
    ).toEqual([]);
  });

  test('цена вне диапазона - скачок от ближайшей границы с пометкой «новая позиция»', () => {
    const dear = [bolt('933-M6', 10), bolt('933-M24', 300), bolt('933-M30', 900)];
    const jumps = findPriceJumps(dear, existing, 0.5, existing);
    expect(jumps.map((jump) => [jump.sku, jump.oldPrice, jump.newPrice, jump.newItem])).toEqual([
      ['933-M30', 300, 900, true],
    ]);
    const issues = validatePriceImport({
      sourceRowCount: 3,
      imported: dear,
      existing,
      confirmed: existing,
      jumps,
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      'Новая позиция «Болт DIN 933» по 900 RUB вне диапазона одноимённых (ближайшая 300 RUB).',
    ]);
    const cheap = [bolt('933-M6', 10), bolt('933-M24', 300), bolt('933-M3', 2)];
    expect(findPriceJumps(cheap, existing, 0.5, existing).map((jump) => jump.oldPrice)).toEqual(
      [10],
    );
    // Рядом с границей (в пределах порога) - не скачок.
    const near = [bolt('933-M6', 10), bolt('933-M24', 300), bolt('933-M27', 420)];
    expect(findPriceJumps(near, existing, 0.5, existing)).toEqual([]);
  });

  test('смена артикула (старый ушёл) по-прежнему сверяется с прежней версией', () => {
    const renamed = [bolt('933-M6', 10), bolt('933M24', 900)];
    const jumps = findPriceJumps(renamed, existing, 0.5, existing);
    expect(jumps.map((jump) => [jump.sku, jump.oldPrice, jump.newItem])).toEqual([
      ['933M24', 300, undefined],
    ]);
  });

  test('новая позиция в диапазоне получает свою первую подтверждённую цену', () => {
    const incoming = [bolt('933-M6', 10), bolt('933-M24', 300), bolt('933-M12', 60)];
    const next = nextConfirmedPrices(existing, existing, incoming, new Set());
    const m12 = next.find((item) => priceItemKey(item) === priceItemKey(bolt('933-M12', 0)));
    expect(m12?.price).toBe(60);
  });
});

/** Прайс с группами одноимённых и артикулами нового формата («TP-1» -> «TP1»). */
function renamedLists(count: number, group: number): [PriceItem[], PriceItem[]] {
  const names = Math.max(1, Math.floor(count / group));
  const make = (index: number, sku: string, date: string): PriceItem => ({
    supplierId: 's',
    productName: `Труба профильная ${index % names}`,
    sku,
    price: 100 + (index % 7),
    currency: 'RUB',
    date,
  });
  return [
    Array.from({ length: count }, (_, index) => make(index, `TP-${index}`, OLD_DATE)),
    Array.from({ length: count }, (_, index) => make(index, `TP${index}`, NEW_DATE)),
  ];
}

describe('R9-A1-05: сложность сверки при смене формата артикулов', () => {
  test('20 тыс. позиций группами по 200: не O(n·g)', () => {
    const [existing, incoming] = renamedLists(20_000, 200);
    const started = performance.now();
    findPriceJumps(incoming, existing, 0.5, existing);
    diffPrices(existing, incoming, 0.5, existing);
    nextConfirmedPrices(existing, existing, incoming, new Set());
    const elapsed = performance.now() - started;
    // Раньше 20 с на этом хосте (9,3 + 6,4 + 4,7); теперь около 3 с даже под нагрузкой.
    const MAX_MS = 9_000;
    expect(elapsed).toBeLessThan(MAX_MS);
  }, 60_000);

  test('результат совпадает с эталоном прямого перебора', () => {
    const [existing, incoming] = renamedLists(1_200, 60);
    expect(findPriceJumps(incoming, existing, 0.5, existing)).toEqual(
      refDiff.findPriceJumps(incoming, existing, 0.5, existing),
    );
    expect(nextConfirmedPrices(existing, existing, incoming, new Set())).toEqual(
      refDiff.nextConfirmedPrices(existing, existing, incoming, new Set()),
    );
  }, 60_000);
});

describe('R9-A1-05: выбор эталона в группе = прямой перебор (равные цены, ноль, валюты)', () => {
  const NAMES = ['Болт', 'Гайка', 'Шайба'];
  const SKUS = [undefined, 'A-1', 'A1', 'B-2', 'B2', 'C-3', 'C3', 'D-4'];
  const PRICES = [0, 5, 10, 10, 15, 20, 30, 45, 60, 100, 0.3, 0.45];

  test('случайные прайсы с большими группами одноимённых', () => {
    const random = rng(505);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const list = (count: number, date: string): PriceItem[] =>
      Array.from({ length: count }, () => {
        const sku = pick(SKUS);
        return {
          supplierId: 's',
          productName: pick(NAMES),
          ...(sku === undefined ? {} : { sku }),
          price: pick(PRICES),
          currency: random() < 0.85 ? 'RUB' : 'USD',
          date,
        };
      });
    for (let round = 0; round < 400; round += 1) {
      const existing = list(1 + Math.floor(random() * 12), OLD_DATE);
      const confirmed = list(Math.floor(random() * 8), OLD_DATE);
      const incoming = list(Math.floor(random() * 12), NEW_DATE);
      const approved = new Set(incoming.filter(() => random() < 0.3).map(priceItemKey));
      expect(findPriceJumps(incoming, existing, 0.5, confirmed)).toEqual(
        refDiff.findPriceJumps(incoming, existing, 0.5, confirmed),
      );
      expect(diffPrices(existing, incoming, 0.5, confirmed)).toEqual(
        refDiff.diffPrices(existing, incoming, 0.5, confirmed),
      );
      expect(nextConfirmedPrices(confirmed, existing, incoming, approved)).toEqual(
        refDiff.nextConfirmedPrices(confirmed, existing, incoming, approved),
      );
    }
  }, 60_000);
});
