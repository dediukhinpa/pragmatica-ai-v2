import { describe, expect, test } from 'bun:test';
import {
  computeMarketAverage,
  marketGroupOf,
  type MarketPriceSample,
} from '../../../src/kit/domain/market-price';
import type { ShortlistEntry } from '../../../src/kit/domain/shortlist';
import {
  shortlistReasonText,
  withShortlistReasons,
} from '../../../src/kit/domain/shortlist-reason';

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
  contacts: 'Иванов, +7 900 000-00-00',
  ...extra,
});

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

describe('«Почему в списке»: критерий считает код', () => {
  const market = computeMarketAverage([
    rub(700, { item: 'Часы настенные' }),
    rub(9_710, { item: 'Часы настенные' }),
    rub(18_720, { item: 'Часы настенные' }),
  ]);

  test('в разы дешевле средней по базе: число средней и «самая низкая из N»', () => {
    const text = shortlistReasonText(
      entry({ prices: [rub(700, { item: 'Часы настенные' })] }),
      { market },
      true,
    );
    expect(text).toBe(
      'тот же товар, что в заявке; Часы настенные: 700 ₽ — в 13,9 раза дешевле средней по базе' +
        ' (9 710 ₽), самая низкая из 3 цен',
    );
  });

  test('проценты до двукратной разницы, «на уровне» в пределах 10%', () => {
    const near = computeMarketAverage([rub(100, { item: 'A' }), rub(120, { item: 'A' })]);
    const reasonOf = (amount: number, average: typeof near): string => {
      const prices = [rub(amount, { item: 'A' })];
      return shortlistReasonText(entry({ prices }), { market: average }, true);
    };
    const level = reasonOf(105, near);
    expect(level).toContain('на уровне средней по базе (110 ₽)');
    const wide = computeMarketAverage([rub(100, { item: 'A' }), rub(150, { item: 'A' })]);
    const above = reasonOf(150, wide);
    expect(above).toContain('на 20% дороже средней по базе (125 ₽)');
    expect(above).not.toContain('самая низкая');
    const below = reasonOf(100, wide);
    expect(below).toContain('на 20% дешевле средней по базе (125 ₽), самая низкая из 2 цен');
    const times = shortlistReasonText(
      entry({ prices: [rub(18_720, { item: 'Часы настенные' })] }),
      { market },
      true,
    );
    expect(times).toContain('на 93% дороже средней по базе (9 710 ₽)');
  });

  test('единственная цена позиции: «других цен по позиции нет», без выдуманной средней', () => {
    const one = computeMarketAverage([rub(500, { item: 'Кружка' })]);
    const prices = [rub(500, { item: 'Кружка' })];
    const text = shortlistReasonText(entry({ prices }), { market: one }, true);
    expect(text).toBe('тот же товар, что в заявке; Кружка: 500 ₽ — других цен по позиции нет');
  });

  test('несколько позиций: тот же и похожий по числу позиций, не больше двух сравнений', () => {
    const prices = [
      rub(10, { item: 'A' }),
      rub(20, { item: 'B' }),
      rub(30, { item: 'C' }),
      rub(40, { item: 'D', similar: true }),
    ];
    const doubled = prices.map((price) => ({ ...price, amount: price.amount * 2 }));
    const all = computeMarketAverage([...prices, ...doubled]);
    const text = shortlistReasonText(entry({ prices }), { market: all }, false);
    expect(text.startsWith('тот же товар по 3 позициям, похожий — по 1 позиции; ')).toBe(true);
    expect(text).toContain('A: 10 ₽');
    expect(text).toContain('B: 20 ₽');
    expect(text).not.toContain('C: 30 ₽');
    expect(text.endsWith('и ещё по 2 позициям')).toBe(true);
  });

  test('только приблизительные цены: «только похожий товар», со средней не сравниваются', () => {
    const text = shortlistReasonText(
      entry({ prices: [rub(10, { item: 'A', approximate: true })] }),
      { market: computeMarketAverage([rub(100, { item: 'A' }), rub(200, { item: 'A' })]) },
      true,
    );
    expect(text).toBe('только похожий товар');
  });

  test('цена «от» с точной средней не сравнивается', () => {
    const exact = computeMarketAverage([rub(100, { item: 'A' }), rub(200, { item: 'A' })]);
    const text = shortlistReasonText(
      entry({ prices: [rub(50, { item: 'A', qualifier: 'from' })] }),
      { market: exact },
      true,
    );
    expect(text).toBe('тот же товар, что в заявке');
  });

  test('цена сайта - со средней по интернету и с пометкой только у этой части', () => {
    const webMarket = computeMarketAverage([rub(100, { item: 'A' }), rub(300, { item: 'A' })]);
    const text = shortlistReasonText(
      entry({ sources: ['web'], webPrices: [rub(100, { item: 'A' })] }),
      { webMarket },
      true,
    );
    expect(text).toBe(
      'тот же товар, что в заявке; A: 100 ₽ — в 2 раза дешевле средней по интернету (200 ₽),' +
        ' самая низкая из 2 цен (ИЗ ИНТЕРНЕТА)',
    );
  });

  test('цена из канала - со средней по каналу', () => {
    const telegramMarket = computeMarketAverage([
      rub(100, { item: 'A', fromTelegram: true }),
      rub(100, { item: 'A', fromTelegram: true }),
    ]);
    const text = shortlistReasonText(
      entry({ prices: [rub(100, { item: 'A', fromTelegram: true })] }),
      { market: { status: 'none' }, telegramMarket },
      true,
    );
    expect(text).toContain('на уровне средней по Telegram-каналу (100 ₽)');
  });

  test('цен нет: где найден; про контакты не пишет (решение владельца 28.10)', () => {
    const base = shortlistReasonText(entry({ contacts: undefined }), {}, true);
    expect(base).toBe('найден в базе по товару заявки, цен в прайсах нет');
    const web = shortlistReasonText(entry({ sources: ['web'], contacts: undefined }), {}, true);
    expect(web).toBe('найден поиском по товару заявки, цен на странице нет (ИЗ ИНТЕРНЕТА)');
    const channel = shortlistReasonText(entry({ sources: ['telegram'] }), {}, true);
    expect(channel).toBe('найден в канале по товару заявки, цен нет (из Telegram-канала)');
  });

  test('withShortlistReasons: причина у каждой строки, число позиций - из заявки', () => {
    const rows = withShortlistReasons(
      [entry({ prices: [rub(10, { item: 'A' })] }), entry({ supplierId: 's2' })],
      { market: computeMarketAverage([rub(10, { item: 'A' })]) },
      2,
    );
    expect(rows[0]?.reason?.startsWith('тот же товар по 1 позиции')).toBe(true);
    expect(rows[1]?.reason).toBe('найден в базе по товару заявки, цен в прайсах нет');
  });
});
