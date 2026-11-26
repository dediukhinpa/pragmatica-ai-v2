import { describe, expect, test } from 'bun:test';
import {
  computeMarketAverage,
  marketGroupOf,
  type MarketAverage,
  type MarketPriceSample,
} from '../../../src/kit/domain/market-price';
import type { ShortlistEntry } from '../../../src/kit/domain/shortlist';
import { shortlistPriceNote, withPriceNotes } from '../../../src/kit/domain/shortlist-price-note';

const rub = (amount: number, extra: Partial<MarketPriceSample> = {}): MarketPriceSample => ({
  amount,
  currency: 'RUB',
  ...extra,
});

const entry = (extra: Partial<ShortlistEntry> = {}): ShortlistEntry => ({
  supplierId: 's1',
  name: 'Поставщик',
  sources: ['knowledge'],
  score: 1,
  references: [],
  ...extra,
});

/** Подробность о цене для одной цены позиции «A» против заданной средней по базе. */
function noteOf(amount: number, market: MarketAverage): string {
  return shortlistPriceNote(entry({ prices: [rub(amount, { item: 'A' })] }), { market });
}

describe('marketGroupOf', () => {
  test('находит группу той же позиции, валюты и единицы; упаковка - за штуку', () => {
    const market = computeMarketAverage([
      rub(100, { item: 'Часы', unit: 'шт' }),
      rub(300, { item: 'Часы', unit: 'шт' }),
      rub(50, { item: 'Ручка', unit: 'шт' }),
    ]);
    const match = marketGroupOf(market, rub(1000, { item: 'часы', unit: '10 шт' }));
    expect(match?.amount).toBe(100);
    expect(match?.group).toMatchObject({ item: 'Часы', n: 2, average: 200 });
  });

  test('нет средней или другая валюта - группы нет', () => {
    expect(marketGroupOf(undefined, rub(1))).toBeUndefined();
    expect(marketGroupOf({ status: 'none' }, rub(1))).toBeUndefined();
    const market = computeMarketAverage([rub(100, { item: 'Часы' })]);
    expect(marketGroupOf(market, { amount: 1, currency: 'USD', item: 'Часы' })).toBeUndefined();
  });
});

describe('цена против средней к «Почему в списке»: числа считает код', () => {
  test('в разы дешевле средней по базе: число средней и «самая низкая из N»', () => {
    const market = computeMarketAverage([
      rub(700, { item: 'Часы настенные' }),
      rub(9_710, { item: 'Часы настенные' }),
      rub(18_720, { item: 'Часы настенные' }),
    ]);
    const prices = [rub(700, { item: 'Часы настенные' })];
    expect(shortlistPriceNote(entry({ prices }), { market })).toBe(
      'Часы настенные: 700 ₽ — в 13,9 раза дешевле средней по базе (9 710 ₽),' +
        ' самая низкая из 3 цен',
    );
    const dear = [rub(18_720, { item: 'Часы настенные' })];
    expect(shortlistPriceNote(entry({ prices: dear }), { market })).toContain(
      'на 93% дороже средней по базе (9 710 ₽)',
    );
  });

  test('проценты до двукратной разницы, «на уровне» в пределах 10%', () => {
    const near = computeMarketAverage([rub(100, { item: 'A' }), rub(120, { item: 'A' })]);
    expect(noteOf(105, near)).toContain('на уровне средней по базе (110 ₽)');
    const wide = computeMarketAverage([rub(100, { item: 'A' }), rub(150, { item: 'A' })]);
    expect(noteOf(150, wide)).toBe('A: 150 ₽ — на 20% дороже средней по базе (125 ₽)');
    expect(noteOf(100, wide)).toBe(
      'A: 100 ₽ — на 20% дешевле средней по базе (125 ₽), самая низкая из 2 цен',
    );
  });

  test('единственная цена позиции: «других цен по позиции нет», без выдуманной средней', () => {
    const one = computeMarketAverage([rub(500, { item: 'A' })]);
    expect(noteOf(500, one)).toBe('A: 500 ₽ — других цен по позиции нет');
  });

  test('несколько позиций: не больше двух сравнений, остальные - числом', () => {
    const prices = ['A', 'B', 'C', 'D'].map((item, index) => rub(10 * (index + 1), { item }));
    const doubled = prices.map((price) => ({ ...price, amount: price.amount * 2 }));
    const market = computeMarketAverage([...prices, ...doubled]);
    const text = shortlistPriceNote(entry({ prices }), { market });
    expect(text).toContain('A: 10 ₽');
    expect(text).toContain('B: 20 ₽');
    expect(text).not.toContain('C: 30 ₽');
    expect(text.endsWith('; и ещё по 2 позициям')).toBe(true);
  });

  test('по позиции берётся цена того же товара, а не более дешёвого аналога', () => {
    const market = computeMarketAverage([rub(100, { item: 'A' }), rub(200, { item: 'A' })]);
    const prices = [rub(50, { item: 'A', similar: true }), rub(100, { item: 'A' })];
    expect(shortlistPriceNote(entry({ prices }), { market })).toContain('A: 100 ₽');
  });

  test('приблизительная цена и «от» против точной средней не сравниваются', () => {
    const exact = computeMarketAverage([rub(100, { item: 'A' }), rub(200, { item: 'A' })]);
    const approximate = [rub(10, { item: 'A', approximate: true })];
    expect(shortlistPriceNote(entry({ prices: approximate }), { market: exact })).toBe('');
    const from = [rub(50, { item: 'A', qualifier: 'from' })];
    expect(shortlistPriceNote(entry({ prices: from }), { market: exact })).toBe('');
  });

  test('цена сайта - со средней по интернету и с пометкой у своей части', () => {
    const webMarket = computeMarketAverage([rub(100, { item: 'A' }), rub(300, { item: 'A' })]);
    const webPrices = [rub(100, { item: 'A' })];
    const text = shortlistPriceNote(entry({ sources: ['web'], webPrices }), { webMarket });
    expect(text).toBe(
      'A: 100 ₽ — в 2 раза дешевле средней по интернету (200 ₽), самая низкая из 2 цен' +
        ' (ИЗ ИНТЕРНЕТА)',
    );
  });

  test('цена из канала - со средней по каналу, с пометкой канала', () => {
    const telegramMarket = computeMarketAverage([
      rub(100, { item: 'A', fromTelegram: true }),
      rub(100, { item: 'A', fromTelegram: true }),
    ]);
    const prices = [rub(100, { item: 'A', fromTelegram: true })];
    expect(
      shortlistPriceNote(entry({ prices }), { market: { status: 'none' }, telegramMarket }),
    ).toBe(
      'A: 100 ₽ — на уровне средней по Telegram-каналу (100 ₽), самая низкая из 2 цен' +
        ' (из Telegram-канала)',
    );
  });

  test('цен нет - подробности нет, поле у строки не ставится', () => {
    const rows = withPriceNotes([entry({ prices: [rub(10, { item: 'A' })] }), entry()], {
      market: computeMarketAverage([rub(10, { item: 'A' })]),
    });
    expect(rows[0]?.priceNote).toBe('A: 10 ₽ — других цен по позиции нет');
    expect(rows[1]).not.toHaveProperty('priceNote');
  });
});
