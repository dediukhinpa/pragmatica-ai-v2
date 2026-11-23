import { describe, expect, test } from 'bun:test';
import {
  countPriceUpdates,
  diffPrices,
  findPriceJumps,
  latestPrices,
  nextConfirmedPrices,
  priceItemKey,
} from '../../../src/kit/domain/price-diff';
import { deviationExceeds, toMinorUnits } from '../../../src/kit/domain/money';
import { type PriceItem } from '../../../src/kit/domain/models';
import { rng } from '@business-ai/testing';
import * as refMoney from './support/money-reference';
import * as refDiff from './support/price-diff-reference';

/**
 * R9-A1-01: быстрые пути денег и сверки прайса дают ПОБАЙТНО тот же результат, что эталоны без
 * оптимизаций: те же скачки, снятия, подтверждённые цены. Отдельно - граница порога (ровно на
 * пороге - не скачок), свежие копии тех же позиций (кэш ключей по тексту) и прайс длиннее шага
 * пошагового расчёта.
 */

type Random = () => number;
const pick = <T>(random: Random, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)] as T;
const int = (random: Random, max: number): number => Math.floor(random() * max);
/** Эталоны без оптимизаций медленные, а хост тестов бывает загружен. */
const TEST_TIMEOUT_MS = 60_000;

describe('деньги: быстрые пути = эталон', () => {
  test('toMinorUnits на случайных и пограничных значениях', () => {
    const random = rng(91);
    const values: number[] = [
      0, -0, 1.005, -1.005, 0.285, 2.675, 1.255, 0.5, 1.5, 2.5, -2.5, 0.125, 10.1, 0.335,
      1e15, 1e15 - 1, 999_999_999.995, 123_456.785, Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY, Number.MIN_VALUE, 1e-7, 5e-7, 4.9999999e-7,
    ];
    for (let round = 0; round < 5_000; round += 1) {
      const decimals = int(random, 7);
      const cents = int(random, 10 ** 9);
      // Середина между младшими единицами и соседние с ней double: граница округления.
      const half = (cents + 0.5) / 10 ** decimals;
      values.push(half, half * (1 + Number.EPSILON), half * (1 - Number.EPSILON));
      values.push(cents / 10 ** decimals, random() * 10 ** int(random, 12), -random() * 1000);
      values.push(Number((random() * 1000).toFixed(int(random, 8))));
    }
    for (const value of values) {
      for (const decimals of [0, 2, 4, 6]) {
        // `toBe` сравнивает как Object.is: -0 и 0 различаются, NaN равен NaN.
        expect(toMinorUnits(value, decimals)).toBe(refMoney.toMinorUnits(value, decimals));
      }
    }
  }, TEST_TIMEOUT_MS);

  test('deviationExceeds: ровно на пороге, рядом с ним и на огромных ценах', () => {
    const random = rng(92);
    let atThreshold = 0;
    let exceeded = 0;
    for (let round = 0; round < 5_000; round += 1) {
      const threshold = pick(random, [0.5, 0.2, 1, 0.3333, 0.05, 0]);
      const oldCents = 1 + int(random, 10 ** pick(random, [3, 6, 9, 12]));
      const oldPrice = oldCents / 100;
      // Новая цена ровно на пороге (в десятичной записи), на шаг выше и ниже, и случайная.
      const exact = Number(((oldCents * (1 + threshold)) / 100).toFixed(6));
      const candidates = [
        exact,
        exact + 0.000001,
        exact - 0.000001,
        Number(((oldCents * (1 - threshold)) / 100).toFixed(6)),
        oldPrice * (random() * 3),
        oldPrice * 1e6,
      ];
      for (const newPrice of candidates) {
        const expected = refMoney.deviationExceeds(oldPrice, newPrice, threshold);
        expect(deviationExceeds(oldPrice, newPrice, threshold)).toBe(expected);
        if (newPrice === exact && !expected) atThreshold += 1;
        if (expected) exceeded += 1;
      }
    }
    // Ровно +50% (0.3 -> 0.45) - не скачок; случаи на пороге действительно проверены.
    expect(deviationExceeds(0.3, 0.45, 0.5)).toBe(false);
    expect(atThreshold).toBeGreaterThan(250);
    expect(exceeded).toBeGreaterThan(250);
  }, TEST_TIMEOUT_MS);
});

const NAMES = [
  'Болт М8',
  'болт  м8',
  'Болт М8 оцинк',
  'Ёмкость 10л',
  'Емкость 10л',
  'Винт – 5',
  'винт - 5',
  'ＡＢＣ',
  'Гайка',
  'Труба 20-3',
];
const SKUS = [undefined, 'AB-1', 'ab-1', 'AB–1', 'АВ-1', ' ', 'X1', 'x 1', 'Y-7', 'TP-1'];
const DATES = ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', 'bad'];
/** Цены, у которых отклонения попадают ровно на пороги 0.5, 0.2 и 1. */
const PRICES = [0, 0.3, 0.45, 0.15, 0.6, 10, 12, 15, 20, 5, 8, 100, 150, 50, 1.005, 2.675];

/** Доля позиций с уникальными артикулом и названием в малых прайсах. */
const UNIQUE_SHARE = 0.7;
/** В большом прайсе одноимённых мало: эталон сверяет одноимённые попарно (квадратично). */
const LARGE_UNIQUE_SHARE = 0.995;

/** Позиция; `index` даёт уникальные артикулы и названия, чтобы большие прайсы не схлопнулись. */
function priceItem(random: Random, index: number, dated: boolean, share: number): PriceItem {
  const unique = random() < share;
  const sku = unique ? `TP-${index}` : pick(random, SKUS);
  return {
    supplierId: 's1',
    productName: random() < share ? `Труба ${index} ГОСТ` : pick(random, NAMES),
    ...(sku === undefined ? {} : { sku }),
    price: pick(random, PRICES),
    currency: random() < 0.95 ? 'RUB' : 'USD',
    date: dated ? pick(random, DATES) : '2026-01-01T00:00:00Z',
  };
}

/** Прайс: часть позиций - из `from` с другой ценой (пары по ключу и названию). */
function priceList(
  random: Random,
  size: number,
  from: readonly PriceItem[] = [],
  share: number = UNIQUE_SHARE,
): PriceItem[] {
  const dated = random() < 0.5;
  return Array.from({ length: size }, (_, index) => {
    const source = from.length > 0 && random() < 0.7 ? pick(random, from) : undefined;
    const item = priceItem(random, index, dated, share);
    return source === undefined ? item : { ...source, price: item.price };
  });
}

/** Свежие копии тех же позиций, как из базы: новые объекты и новые строки. */
const fresh = (items: readonly PriceItem[]): PriceItem[] =>
  JSON.parse(JSON.stringify(items)) as PriceItem[];

function expectSameAsReference(
  existing: PriceItem[],
  incoming: PriceItem[],
  confirmed: PriceItem[],
  threshold: number,
  random: Random,
): void {
  const expected = refDiff.diffPrices(existing, incoming, threshold, confirmed);
  expect(diffPrices(fresh(existing), fresh(incoming), threshold, fresh(confirmed))).toEqual(
    expected,
  );
  expect(diffPrices(existing, incoming, threshold, confirmed)).toEqual(expected);
  expect(findPriceJumps(incoming, existing, threshold, confirmed)).toEqual(
    refDiff.findPriceJumps(incoming, existing, threshold, confirmed),
  );
  const plain = refDiff.diffPrices(existing, incoming);
  expect(countPriceUpdates(existing, incoming)).toBe(plain.added.length + plain.changed.length);
  const approved = new Set(expected.jumps.filter(() => random() < 0.5).map((jump) => jump.key));
  expect(nextConfirmedPrices(confirmed, existing, incoming, approved)).toEqual(
    refDiff.nextConfirmedPrices(confirmed, existing, incoming, approved),
  );
  expect([...latestPrices(fresh(existing))]).toEqual([...refDiff.latestPrices(existing)]);
}

describe('сверка прайса: оптимизированная = эталон (R9-A1-01)', () => {
  test('случайные прайсы с повторами, переименованиями, снятиями и порогами', () => {
    const random = rng(93);
    let jumps = 0;
    let removals = 0;
    for (let round = 0; round < 200; round += 1) {
      const existing = priceList(random, int(random, 120));
      const incoming = random() < 0.1 ? [] : priceList(random, int(random, 120), existing);
      const confirmed = priceList(random, int(random, 80), [...existing, ...incoming]);
      const threshold = pick(random, [0.5, 0.2, 1]);
      expectSameAsReference(existing, incoming, confirmed, threshold, random);
      const expected = refDiff.findPriceJumps(incoming, existing, threshold, confirmed);
      jumps += expected.filter((jump) => jump.removed !== true).length;
      removals += expected.filter((jump) => jump.removed === true).length;
    }
    // Генератор действительно задевает и скачки, и массовое снятие.
    expect(jumps).toBeGreaterThan(500);
    expect(removals).toBeGreaterThan(100);
  }, TEST_TIMEOUT_MS);

  test('прайс длиннее шага пошагового расчёта', () => {
    const random = rng(94);
    const existing = priceList(random, 7_000, [], LARGE_UNIQUE_SHARE);
    const incoming = priceList(random, 6_500, existing, LARGE_UNIQUE_SHARE);
    const confirmed = priceList(random, 3_000, existing, LARGE_UNIQUE_SHARE);
    expectSameAsReference(existing, incoming, confirmed, 0.5, random);
  }, TEST_TIMEOUT_MS);

  test('ключ по тексту: правка поля на месте и совпадение с эталоном', () => {
    const random = rng(95);
    for (const item of priceList(random, 300)) {
      expect(priceItemKey(item)).toBe(refDiff.priceItemKey(item));
      expect(priceItemKey(fresh([item])[0] as PriceItem)).toBe(refDiff.priceItemKey(item));
    }
    const item: PriceItem = { ...priceItem(random, 0, false, 1), productName: 'Болт', sku: ' ' };
    expect(priceItemKey(item)).toBe('name:болт');
    item.sku = 'AB – 1';
    expect(priceItemKey(item)).toBe('sku:ab-1');
  });
});
