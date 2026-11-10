import { describe, expect, test } from 'bun:test';
import {
  SHORTLIST_MAX_SIZE,
  mergeCandidates,
  type ShortlistEntry,
  type SourceResult,
} from '../../../src/kit/domain/shortlist';
import {
  assignedLocation,
  matchesLocation,
  parseLocations,
  prioritizeByLocation,
} from '../../../src/kit/domain/shortlist-location';
import { orderShortlistByRule } from '../../../src/kit/domain/shortlist-compare';

function entry(id: string, extra: Partial<ShortlistEntry> = {}): ShortlistEntry {
  return { supplierId: id, name: id, sources: ['knowledge'], score: 0.5, references: [], ...extra };
}
const web = (id: string, extra: Partial<ShortlistEntry> = {}): ShortlistEntry =>
  entry(id, { sources: ['web'], ...extra });
const ids = (entries: readonly ShortlistEntry[]): string[] => entries.map((e) => e.supplierId);
const price = (amount: number) => [{ amount, currency: 'RUB' }];

describe('parseLocations / matchesLocation', () => {
  test('несколько локаций разбираются по порядку упоминания', () => {
    expect(parseLocations('Екатеринбург и Москва')).toEqual(['Екатеринбург', 'Москва']);
    expect(parseLocations('Москва, Тверь; москва')).toEqual(['Москва', 'Тверь']);
    expect(parseLocations(undefined)).toEqual([]);
  });

  test('падежи, регистр и ё/е', () => {
    expect(matchesLocation({ city: 'Москве' }, 'Москва')).toBe(true);
    expect(matchesLocation({ city: 'МОСКВА' }, 'москве')).toBe(true);
    expect(matchesLocation({ address: 'Московская область, Химки' }, 'Москва')).toBe(true);
    expect(matchesLocation({ city: 'Орёл' }, 'орел')).toBe(true);
    expect(matchesLocation({ address: '620000, г. Екатеринбург, ул. Ленина' }, 'Екатеринбурге'))
      .toBe(true);
    expect(matchesLocation({ city: 'Нижний Новгород' }, 'Новгород')).toBe(true);
  });

  test('другие города не совпадают', () => {
    expect(matchesLocation({ city: 'Новосибирск' }, 'Новоуральск')).toBe(false);
    expect(matchesLocation({ city: 'Тверь' }, 'Москва')).toBe(false);
  });

  test('улица в адресе не делает поставщика жителем города', () => {
    expect(matchesLocation({ address: '620000, Екатеринбург, ул. Московская, 10' }, 'Москва'))
      .toBe(false);
    expect(matchesLocation({ address: 'Москва, Тверская ул., 1' }, 'Тверь')).toBe(false);
    expect(matchesLocation({ address: 'Москва, Тверская ул., 1' }, 'Москва')).toBe(true);
    expect(matchesLocation({ city: 'Екатеринбург', address: 'Москва, 1' }, 'Москва')).toBe(false);
    expect(matchesLocation({ city: 'Орехово-Зуево' }, 'Орёл')).toBe(false);
  });

  test('нет данных о месте - не из локации', () => {
    expect(matchesLocation({}, 'Москва')).toBe(false);
    expect(assignedLocation({}, ['Москва'])).toBeUndefined();
  });
});

describe('приоритет локации в порядке', () => {
  test('одна локация: её поставщики первыми, внутри группы прежний порядок', () => {
    const pool = [
      entry('a', { city: 'Тверь', prices: price(10) }),
      entry('b', { city: 'Москва', prices: price(30) }),
      entry('c', { city: 'Москва', prices: price(20) }),
    ];
    expect(ids(orderShortlistByRule(pool, 10, ['Москва']))).toEqual(['c', 'b', 'a']);
    expect(ids(orderShortlistByRule(pool, 10, []))).toEqual(['a', 'c', 'b']);
  });

  test('две локации: сначала первая, потом вторая, потом остальные', () => {
    const pool = [
      entry('t', { city: 'Тверь', prices: price(1) }),
      entry('m', { city: 'Москва', prices: price(2) }),
      entry('e', { city: 'Екатеринбург', prices: price(3) }),
    ];
    const locations = ['Екатеринбург', 'Москва'];
    expect(ids(orderShortlistByRule(pool, 10, locations))).toEqual(['e', 'm', 't']);
    expect(ids(prioritizeByLocation(pool, locations))).toEqual(['e', 'm', 't']);
  });

  test('нет совпадений - порядок прежний, без отказа', () => {
    const pool = [
      entry('a', { city: 'Тверь', prices: price(10) }),
      entry('b', { city: 'Омск', prices: price(20) }),
    ];
    expect(ids(orderShortlistByRule(pool, 10, ['Москва']))).toEqual(['a', 'b']);
  });

  test('поставщик без места уходит в конец, но не отбрасывается', () => {
    const pool = [
      entry('x', { prices: price(1) }),
      entry('m', { city: 'Москва', prices: price(5) }),
    ];
    expect(ids(orderShortlistByRule(pool, 10, ['Москва']))).toEqual(['m', 'x']);
  });

  test('локация не вытесняется более выгодным из другого города при нехватке мест', () => {
    const pool = [
      ...Array.from({ length: 3 }, (_, i) => entry(`o${i}`, { city: 'Тверь', prices: price(1) })),
      entry('m', { city: 'Москва' }),
    ];
    expect(ids(orderShortlistByRule(pool, 2, ['Москва']))[0]).toBe('m');
  });
});

describe('топ-10 из базы, интернет только добирает', () => {
  const baseCandidates = (count: number): SourceResult => ({
    source: 'knowledge',
    status: 'ok',
    candidates: Array.from({ length: count }, (_, i) => ({
      name: `База ${i}`,
      supplierId: `b${i}`,
      score: 0.5,
      prices: price(100 + i),
    })),
  });
  const webCandidates = (count: number): SourceResult => ({
    source: 'web',
    status: 'ok',
    candidates: Array.from({ length: count }, (_, i) => ({
      name: `Сайт ${i}`,
      reference: `https://site${i}.test`,
      score: 0.9,
      webPrices: price(10 + i),
    })),
  });
  const options = { limit: SHORTLIST_MAX_SIZE, externalId: (n: string) => `ext-${n}` };

  test('ровно 10 из базы: интернет в топ не попал, средняя по интернету считается', () => {
    const outcome = mergeCandidates([baseCandidates(10), webCandidates(5)], options);
    expect(outcome.entries).toHaveLength(SHORTLIST_MAX_SIZE);
    expect(outcome.entries.every((e) => e.sources.includes('knowledge'))).toBe(true);
    expect(outcome.webMarket?.status).toBe('ok');
    expect(outcome.market?.status).toBe('ok');
  });

  test('7 из базы и 5 из интернета: 7 + 3', () => {
    const outcome = mergeCandidates([baseCandidates(7), webCandidates(5)], options);
    expect(outcome.entries).toHaveLength(SHORTLIST_MAX_SIZE);
    expect(outcome.entries.filter((e) => e.sources.includes('knowledge'))).toHaveLength(7);
    expect(outcome.entries.slice(0, 7).every((e) => e.sources.includes('knowledge'))).toBe(true);
  });

  test('0 из базы: список из интернета, не больше 10', () => {
    const outcome = mergeCandidates([baseCandidates(0), webCandidates(12)], options);
    expect(outcome.entries).toHaveLength(SHORTLIST_MAX_SIZE);
  });

  test('база без цен всё равно впереди интернета с ценами', () => {
    const noPrice: SourceResult = {
      source: 'knowledge',
      status: 'ok',
      candidates: [{ name: 'Без цены', supplierId: 'np', score: 0.5 }],
    };
    const outcome = mergeCandidates([noPrice, webCandidates(3)], options);
    expect(outcome.entries[0]?.supplierId).toBe('np');
  });

  test('слияние и orderShortlistByRule дают один порядок', () => {
    const outcome = mergeCandidates(
      [baseCandidates(7), webCandidates(5)],
      { ...options, locations: ['Москва'] },
    );
    const again = orderShortlistByRule(outcome.pool ?? [], SHORTLIST_MAX_SIZE, ['Москва']);
    expect(ids(again)).toEqual(ids(outcome.entries));
  });

  test('локация в слиянии: база локации не отсекается пулом', () => {
    const many: SourceResult = {
      source: 'knowledge',
      status: 'ok',
      candidates: Array.from({ length: 25 }, (_, i) => ({
        name: `База ${i}`,
        supplierId: `b${i}`,
        score: 0.5,
        prices: price(100 + i),
        ...(i === 24 ? { city: 'Москва' } : {}),
      })),
    };
    const outcome = mergeCandidates([many], { ...options, locations: ['Москва'] });
    expect(outcome.entries[0]?.supplierId).toBe('b24');
  });

  test('web-кандидат в хвосте не влияет на локации: web без места - после базы', () => {
    const outcome = mergeCandidates([baseCandidates(2), webCandidates(2)], options);
    expect(ids(outcome.entries).slice(0, 2)).toEqual(['b0', 'b1']);
  });
});
