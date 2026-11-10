import { describe, expect, test } from 'bun:test';
import { entryLines } from '../../src/agents/order-calc/shortlist-message';
import { assignedLocation } from '../../src/kit/domain/shortlist-location';
import { orderShortlistByRule, regroupByLocation } from '../../src/kit/domain/shortlist-compare';
import { type ShortlistEntry } from '../../src/kit/domain/shortlist';

/** Порядок по локации после обогащения города из интернета (этап 161). Только синтетика. */

const LOCATIONS = ['Москва'];
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

/** Пул из 10: m1-m3 город в базе, w1-w3 только из интернета, spb другой город, n1-n3 пусто. */
function pool(): ShortlistEntry[] {
  return [
    entry('n1'),
    entry('spb', { city: 'Санкт-Петербург' }),
    entry('w1'),
    entry('m1', { city: 'Москва' }),
    entry('n2'),
    entry('w2'),
    entry('m2', { city: 'Москва' }),
    entry('w3'),
    entry('n3'),
    entry('m3', { city: 'Москва' }),
  ];
}

/** Имитация поиска в интернете: показанным w1-w3 находится Москва. */
function enrich(entries: readonly ShortlistEntry[]): ShortlistEntry[] {
  return entries.map((e) =>
    e.supplierId.startsWith('w') ? { ...e, webEnrichment: { match: 'inn', city: 'Москва' } } : e,
  );
}

describe('локация и город из интернета', () => {
  test('воспроизведение: порядок до обогащения ставит СПб выше Москвы из интернета', () => {
    const before = orderShortlistByRule(pool(), 10, LOCATIONS);
    // Причина: на момент группировки у w1-w3 города нет, они в той же группе, что и spb.
    expect(ids(before).slice(0, 3).sort()).toEqual(['m1', 'm2', 'm3']);
    const order = ids(before);
    // СПб (город в базе) выше хотя бы одного из «московских из интернета».
    expect(['w1', 'w2', 'w3'].some((id) => order.indexOf('spb') < order.indexOf(id))).toBe(true);
  });

  test('после повторной группировки Москва из интернета идёт с московскими, СПб не выше', () => {
    const before = orderShortlistByRule(pool(), 10, LOCATIONS);
    const after = regroupByLocation(enrich(before), LOCATIONS);
    expect(ids(after).slice(0, 6).sort()).toEqual(['m1', 'm2', 'm3', 'w1', 'w2', 'w3']);
    const spbAt = ids(after).indexOf('spb');
    for (const id of ['w1', 'w2', 'w3']) expect(ids(after).indexOf(id)).toBeLessThan(spbAt);
  });

  test('«без данных» и «другой город» остаются одной группой в прежнем порядке', () => {
    const before = orderShortlistByRule(pool(), 10, LOCATIONS);
    const after = regroupByLocation(enrich(before), LOCATIONS);
    const rest = new Set(['n1', 'n2', 'n3', 'spb']);
    // Порядок остатка тот же, что был до обогащения (решение «без данных» / «другой город»
    // не принято: одна группа «прочие»).
    expect(ids(after).slice(6)).toEqual(ids(before).filter((id) => rest.has(id)));
  });

  test('метка локации у всех совпавших, включая найденных через интернет', () => {
    const after = regroupByLocation(enrich(pool()), LOCATIONS);
    const labelled = after.filter((e) => assignedLocation(e, LOCATIONS) !== undefined);
    expect(ids(labelled).sort()).toEqual(['m1', 'm2', 'm3', 'w1', 'w2', 'w3']);
    const sample = labelled[3];
    if (sample === undefined) throw new Error('нет совпавших');
    const text = entryLines({ ...sample, locationGroup: 'Москва' }, 3).join('\n');
    expect(text).toContain('локация: Москва');
    // Цена в строке по-прежнему подписана НДС (этап 150).
    expect(text).toContain('(с НДС)');
  });

  test('интернет-кандидат своей локации встаёт в её группу (этап 169), без локаций порядок прежний',
    () => {
      const web = entry('ext', { sources: ['web'], city: 'Москва' });
      const mixed = [entry('a'), entry('b', { city: 'Москва' }), web];
      expect(ids(regroupByLocation(mixed, LOCATIONS))).toEqual(['b', 'ext', 'a']);
      expect(ids(regroupByLocation(mixed, []))).toEqual(['a', 'b', 'ext']);
    });
});
