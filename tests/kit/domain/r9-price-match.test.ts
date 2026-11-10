import { describe, expect, test } from 'bun:test';
import { buildPriceMatchIndex, matchPriceItem } from '../../../src/kit/domain/price-match';
import { type PriceItem } from '../../../src/kit/domain/models';
import { rng } from '@business-ai/testing';
import * as refMatch from './support/price-match-reference';

/**
 * R9-A1-10: похожие позиции для правки сотрудника ищутся по общей строке названий и подстрокам
 * запроса, а не полным проходом прайса на каждую правку. Результат - тот же, что у эталона.
 */

const DATE = '2026-10-01T00:00:00.000Z';

function pipe(index: number): PriceItem {
  return {
    supplierId: 's',
    productName: `Труба профильная 20x20x${index} ст.3 ГОСТ 8639-82`,
    sku: `TP-${index}`,
    price: 100 + (index % 7),
    currency: 'RUB',
    date: DATE,
  };
}

describe('R9-A1-10: поиск похожих позиций', () => {
  test('200 правок без точного совпадения к прайсу 100 тыс. позиций', () => {
    const base = Array.from({ length: 100_000 }, (_, index) => pipe(index));
    const index = buildPriceMatchIndex(base);
    const UPDATES = 200;
    const started = performance.now();
    for (let update = 0; update < UPDATES; update += 1) {
      // Кириллическая «х» вместо латинской: точного совпадения нет, похожих тоже.
      matchPriceItem(base, { productName: `Труба профильная 20х20х${update}` }, index);
    }
    const elapsed = performance.now() - started;
    // Раньше около 6,7 с на этом хосте (полный проход на каждую правку); теперь ~1,4 с.
    const MAX_MS = 4_000;
    expect(elapsed).toBeLessThan(MAX_MS);
  }, 60_000);

  test('кандидаты - те же и в том же порядке, что у прямого прохода', () => {
    const random = rng(1010);
    const WORDS = ['болт', 'м8', 'гайка', 'м8х40', 'din', '933', ' ', 'ё', '-', 'x'];
    const word = (): string => WORDS[Math.floor(random() * WORDS.length)] as string;
    const text = (parts: number): string =>
      Array.from({ length: parts }, word).join(random() < 0.5 ? ' ' : '');
    for (let round = 0; round < 300; round += 1) {
      const items: PriceItem[] = Array.from({ length: 1 + Math.floor(random() * 25) }, (_, i) => ({
        supplierId: 's',
        // Пустое после нормализации название похоже на любой запрос (подстрока '' всегда есть).
        productName: random() < 0.05 ? '   ' : text(1 + Math.floor(random() * 3)),
        ...(random() < 0.5 ? { sku: `S-${i % 4}` } : {}),
        price: 10,
        currency: 'RUB',
        date: DATE,
      }));
      const index = buildPriceMatchIndex(items);
      for (let query = 0; query < 10; query += 1) {
        const long = random() < 0.1;
        const q = {
          ...(random() < 0.3 ? { sku: `S-${Math.floor(random() * 6)}` } : {}),
          // Длинный запрос уходит в прямой проход (предел перебора подстрок).
          productName: long ? text(1).repeat(3_000) : text(1 + Math.floor(random() * 4)),
        };
        expect(matchPriceItem(items, q, index)).toEqual(refMatch.matchPriceItem(items, q));
      }
    }
  }, 60_000);
});
