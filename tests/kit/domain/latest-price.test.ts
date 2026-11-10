import { describe, expect, test } from 'bun:test';
import {
  STALE_PRICE_NOTE,
  formatPriceDate,
  isStalePrice,
  latestPerLine,
  priceDateNotes,
  type DatedPriceRow,
} from '../../../src/kit/domain/latest-price';

/** Свежая цена позиции вместо исторического минимума (этап 161). Данные синтетические. */

interface Row extends DatedPriceRow {
  price: number;
  tiers?: number[];
}

function row(patch: Partial<Row> & Pick<Row, 'date' | 'price'>): Row {
  return { supplierId: 's1', productName: 'ТЕСТ Календарь 2026', currency: 'RUB', ...patch };
}

const pick = (rows: Row[]): Row[] => latestPerLine(rows, (r) => r);

describe('latestPerLine', () => {
  test('берётся свежая строка, даже если она дороже', () => {
    const old = row({ date: '2025-03-31T00:00:00.000Z', price: 79 });
    const fresh = row({ date: '2025-10-03T00:00:00.000Z', price: 81.37 });
    expect(pick([old, fresh])).toEqual([fresh]);
    expect(pick([fresh, old])).toEqual([fresh]);
  });

  test('одинаковые даты: позже записанная строка', () => {
    const first = row({ date: '2025-10-03T00:00:00.000Z', price: 70, createdAt: '2025-10-04' });
    const second = row({ date: '2025-10-03T00:00:00.000Z', price: 90, createdAt: '2025-10-05' });
    expect(pick([first, second])).toEqual([second]);
  });

  test('одинаковые даты и записи: остаётся первая во входе', () => {
    const first = row({ date: '2025-10-03T00:00:00.000Z', price: 90 });
    const second = row({ date: '2025-10-03T00:00:00.000Z', price: 70 });
    expect(pick([first, second])).toEqual([first]);
  });

  test('одинаковые даты: диск выше почты, даже если почта записана позже', () => {
    const disk = row({
      date: '2025-10-03T00:00:00.000Z',
      price: 90,
      sourceFile: 'produkciya/test/price.xlsx',
      createdAt: '2025-10-04',
    });
    const mail = row({
      date: '2025-10-03T00:00:00.000Z',
      price: 70,
      sourceFile: 'mail:abc',
      createdAt: '2025-10-09',
    });
    expect(pick([mail, disk])).toEqual([disk]);
  });

  test('лестница тиражей остаётся от той же строки, что и цена', () => {
    const old = row({ date: '2025-03-31T00:00:00.000Z', price: 79, tiers: [100, 300] });
    const fresh = row({ date: '2025-10-03T00:00:00.000Z', price: 81.37, tiers: [500] });
    const [chosen] = pick([old, fresh]);
    expect(chosen?.price).toBe(81.37);
    expect(chosen?.tiers).toEqual([500]);
  });

  test('разные позиции, поставщики и валюты не склеиваются', () => {
    const rows = [
      row({ date: '2025-03-31T00:00:00.000Z', price: 1 }),
      row({ date: '2025-10-03T00:00:00.000Z', price: 2, productName: 'ТЕСТ Другой' }),
      row({ date: '2025-10-03T00:00:00.000Z', price: 3, supplierId: 's2' }),
      row({ date: '2025-10-03T00:00:00.000Z', price: 4, currency: 'USD' }),
      row({ date: '2025-10-03T00:00:00.000Z', price: 5, sku: 'A-1' }),
    ];
    expect(pick(rows)).toHaveLength(5);
  });

  test('название сравнивается без учёта регистра и «ё»', () => {
    const old = row({ date: '2025-03-31T00:00:00.000Z', price: 1, productName: 'Ёлка тест' });
    const fresh = row({ date: '2025-10-03T00:00:00.000Z', price: 2, productName: 'елка ТЕСТ' });
    expect(pick([old, fresh])).toEqual([fresh]);
  });
});

describe('дата прайса и пометка устаревшего', () => {
  test('формат ДД.ММ.ГГГГ', () => {
    expect(formatPriceDate('2025-03-31T00:00:00.000Z')).toBe('31.03.2025');
    expect(formatPriceDate('2025-10-03T12:00:00.000Z')).toBe('03.10.2025');
    expect(formatPriceDate('не дата')).toBe('');
  });

  test('старше 12 месяцев - устарела, ровно год - ещё нет', () => {
    const now = new Date('2026-11-03T00:00:00.000Z');
    expect(isStalePrice('2025-10-03T00:00:00.000Z', now)).toBe(true);
    expect(isStalePrice('2025-11-03T00:00:00.000Z', now)).toBe(false);
    expect(isStalePrice('2026-06-01T00:00:00.000Z', now)).toBe(false);
  });

  test('пометки: дата и, для устаревшей, «прайс старше года»', () => {
    expect(priceDateNotes('2025-03-31T00:00:00.000Z', false)).toEqual(['прайс от 31.03.2025']);
    expect(priceDateNotes('2025-03-31T00:00:00.000Z', true)).toEqual([
      'прайс от 31.03.2025',
      STALE_PRICE_NOTE,
    ]);
    expect(priceDateNotes(undefined, true)).toEqual([]);
  });
});
