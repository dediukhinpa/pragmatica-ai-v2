import { describe, expect, test } from 'bun:test';
import { orderShortlistByRule } from '../../../src/kit/domain/shortlist-compare';
import { type ShortlistEntry } from '../../../src/kit/domain/shortlist';

/** Этап 169: интернет-кандидат встаёт в группу своей локации. Только синтетика. */

const ids = (entries: readonly ShortlistEntry[]): string[] => entries.map((e) => e.supplierId);

function entry(id: string, extra: Partial<ShortlistEntry> = {}): ShortlistEntry {
  return {
    supplierId: id,
    name: id,
    sources: ['knowledge'],
    score: 0.5,
    references: [],
    prices: [{ amount: 100, currency: 'RUB', vat: 'included' }],
    ...extra,
  };
}

const web = (id: string, city?: string): ShortlistEntry =>
  entry(id, { sources: ['web'], ...(city === undefined ? {} : { city }) });

describe('порядок по локации действует и на интернет-кандидатов', () => {
  test('Москва из интернета выше Петербурга и поставщиков без города', () => {
    const pool = [
      entry('spb', { city: 'Санкт-Петербург' }),
      entry('n1'),
      entry('m1', { city: 'Москва' }),
      entry('n2'),
      entry('m2', { city: 'Москва' }),
      web('wm', 'Москва'),
    ];
    expect(ids(orderShortlistByRule(pool, 6, ['Москва']))).toEqual([
      'm1',
      'm2',
      'wm',
      'spb',
      'n1',
      'n2',
    ]);
  });

  test('две локации: сначала Екатеринбург, затем Москва, интернет внутри своей группы', () => {
    const pool = [
      entry('m1', { city: 'Москва' }),
      web('wm', 'Москва'),
      entry('e1', { city: 'Екатеринбург' }),
      web('we', 'Екатеринбург'),
      entry('n1'),
    ];
    expect(ids(orderShortlistByRule(pool, 5, ['Екатеринбург', 'Москва']))).toEqual([
      'e1',
      'we',
      'm1',
      'wm',
      'n1',
    ]);
  });

  test('без локаций порядок прежний: база, затем интернет', () => {
    const pool = [web('wm', 'Москва'), entry('a'), entry('b', { city: 'Москва' })];
    const order = ids(orderShortlistByRule(pool, 3, []));
    expect(order.slice(0, 2).sort()).toEqual(['a', 'b']);
    expect(order[2]).toBe('wm');
  });

  test('состав не меняется: интернет добирает только недостающие места', () => {
    const pool = [
      entry('m1', { city: 'Москва' }),
      entry('n1'),
      web('wm', 'Москва'),
      web('wx'),
    ];
    const withLoc = ids(orderShortlistByRule(pool, 3, ['Москва']));
    const without = ids(orderShortlistByRule(pool, 3, []));
    expect([...withLoc].sort()).toEqual([...without].sort());
  });
});
