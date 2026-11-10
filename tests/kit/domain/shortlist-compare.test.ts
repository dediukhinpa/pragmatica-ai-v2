import { describe, expect, test } from 'bun:test';
import {
  applyModelOrder,
  parseModelOrder,
  buildCompareFacts,
  compareByCriteria,
  parseLeadTimeDays,
  applyTierSelection,
  arrangeShortlist,
  planShortlist,
  suspiciousFromPriceIds,
  selectByTiers,
  shortlistTierOf,
} from '../../../src/kit/domain/shortlist-compare';
import {
  mergeCandidates,
  shortlistProposalSchema,
  type ShortlistEntry,
  type SourceResult,
} from '../../../src/kit/domain/shortlist';
import { dropPriceOutliers } from '../../../src/kit/domain/market-price';

const externalId = (normalized: string): string => `ext-${normalized}`;
const OPTIONS = { limit: 10, externalId };

function entry(id: string, extra: Partial<ShortlistEntry> = {}): ShortlistEntry {
  return {
    supplierId: id,
    name: id,
    sources: ['knowledge'],
    score: 0.5,
    references: [],
    ...extra,
  };
}
const webEntry = (id: string, extra: Partial<ShortlistEntry> = {}): ShortlistEntry =>
  entry(id, { sources: ['web'], ...extra });
const ids = (entries: readonly ShortlistEntry[]): string[] =>
  entries.map((item) => item.supplierId);

describe('parseLeadTimeDays', () => {
  test.each([
    ['5 дней', 5],
    ['3-5 дней', 5],
    ['3–5 рабочих дней', 5],
    ['2 недели', 14],
    ['под заказ 2 недели', 14],
    ['1-2 недели', 14],
    ['1 месяц', 30],
    ['от 100 шт, срок 5 дн.', 5],
  ])('%s -> %d', (text, days) => {
    expect(parseLeadTimeDays(text)).toBe(days);
  });

  test('не разобрано или пусто - undefined', () => {
    expect(parseLeadTimeDays('по договорённости')).toBeUndefined();
    expect(parseLeadTimeDays(undefined)).toBeUndefined();
    expect(parseLeadTimeDays('100 шт')).toBeUndefined();
  });
});

const rub = (amount: number, item?: string, extra: Record<string, unknown> = {}) => ({
  ...(item === undefined ? {} : { item }),
  amount,
  currency: 'RUB',
  ...extra,
});

describe('compareByCriteria', () => {
  test('бой 29.10: без цен - в конце, две позиции выше одной, одна выше нуля', () => {
    const nobody = entry('nobody', { leadTime: '3 дня', email: 'a@b.test' });
    const one = entry('one', { prices: [rub(10, 'мёд')], leadTime: '1 день' });
    const both = entry('both', { prices: [rub(500, 'мёд'), rub(900, 'орехи')] });
    expect(ids(compareByCriteria([nobody, one, both]))).toEqual(['both', 'one', 'nobody']);
  });

  test('покрытие считается одинаково для базы и веба: цены страницы по двум позициям', () => {
    const web = webEntry('web', { webPrices: [rub(100, 'мёд'), rub(200, 'орехи')] });
    const base = entry('base', { prices: [rub(1, 'мёд')] });
    expect(ids(compareByCriteria([base, web]))).toEqual(['web', 'base']);
  });

  test('«похожий товар» ниже точной цены при равном покрытии', () => {
    const rough = entry('rough', { prices: [rub(1, 'мёд', { approximate: true })] });
    const exact = entry('exact', { prices: [rub(500, 'мёд')] });
    expect(ids(compareByCriteria([rough, exact]))).toEqual(['exact', 'rough']);
  });

  test('срок больше не главный: быстрый без цены ниже медленного с ценой', () => {
    const slowCheap = entry('slow', { leadTime: '2 недели', prices: [rub(10)] });
    const fastNone = entry('fast', { leadTime: '3 дня' });
    expect(ids(compareByCriteria([fastNone, slowCheap]))).toEqual(['slow', 'fast']);
  });

  test('контакты важнее города и срока при равных ценах', () => {
    const prices = [rub(100, 'мёд')];
    const dated = entry('dated', { prices, city: 'Уфа', leadTime: '3 дня' });
    const contact = entry('contact', { prices, email: 'x@y.test' });
    expect(ids(compareByCriteria([dated, contact]))).toEqual(['contact', 'dated']);
  });

  test('контакты, найденные в интернете, считаются контактами', () => {
    const prices = [rub(100, 'мёд')];
    const found = entry('found', {
      prices,
      webEnrichment: { match: 'site', phone: '+7 347 275-27-10' },
    });
    expect(ids(compareByCriteria([entry('bare', { prices }), found]))).toEqual(['found', 'bare']);
  });

  test('при равном сроке выигрывает меньшая точная цена; приблизительная не считается', () => {
    const rub = (amount: number) => [{ amount, currency: 'RUB' }];
    const dear = entry('dear', { leadTime: '5 дней', prices: rub(200) });
    const cheap = entry('cheap', { leadTime: '5 дней', prices: rub(100) });
    const rough = entry('rough', {
      leadTime: '5 дней',
      prices: [{ amount: 1, currency: 'RUB', approximate: true }],
    });
    expect(ids(compareByCriteria([rough, dear, cheap]))).toEqual(['cheap', 'dear', 'rough']);
  });

  test('цена считается по позициям: нормированный ранг в группе одной позиции и единицы', () => {
    const prices = (a: number, b: number) => [rub(a, 'мёд'), rub(b, 'орехи')];
    // Мёд: 100 < 150; орехи: 1000 < 3000 -> у «two» ранги 1 и 0 (среднее 0,5), у «one» 0 и 1.
    // Ничья по рангу решается порядком входа; третий делает мёд дороже для «two».
    const one = entry('one', { prices: prices(100, 3000) });
    const two = entry('two', { prices: prices(150, 1000) });
    const cheapest = entry('cheapest', { prices: prices(100, 1000) });
    expect(ids(compareByCriteria([one, two, cheapest]))).toEqual(['cheapest', 'one', 'two']);
  });

  test('цены в разных единицах не сравниваются между собой', () => {
    const kg = entry('kg', { prices: [rub(255, 'мёд', { unit: 'кг' })] });
    const jar = entry('jar', { prices: [rub(83, 'мёд', { unit: 'за банку 70 г' })] });
    const kg2 = entry('kg2', { prices: [rub(300, 'мёд', { unit: 'килограмм' })] });
    // «килограмм» и «кг» - одна группа: 255 лучше 300; «банка» одна в группе - нейтрально.
    expect(ids(compareByCriteria([kg2, jar, kg]))).toEqual(['kg', 'jar', 'kg2']);
  });

  test('рейтинг последним: решает только при равных прочих критериях', () => {
    const low = entry('low', { rating: 2 });
    const high = entry('high', { rating: 5 });
    const none = entry('none', { rating: null });
    const fastLow = entry('fast', { rating: 1, leadTime: '1 день' });
    // Срок известен (меньше критичных данных не хватает) - выше рейтинга.
    expect(ids(compareByCriteria([none, low, high, fastLow]))).toEqual([
      'fast',
      'high',
      'low',
      'none',
    ]);
  });

  test('база с ценой выше веба без данных', () => {
    const base = entry('base', { leadTime: '4 дня', prices: [{ amount: 50, currency: 'RUB' }] });
    expect(ids(compareByCriteria([webEntry('w'), base]))).toEqual(['base', 'w']);
  });
});

const priced = (amount: number, extra: Record<string, unknown> = {}) => [
  { amount, currency: 'RUB', ...extra },
];
const baseExact = (id: string) => entry(id, { prices: priced(100) });
const baseAnalog = (id: string) =>
  entry(id, { prices: priced(100, { approximate: true, similar: true }) });
const webExact = (id: string) => webEntry(id, { webPrices: priced(90) });
const webNoPrice = (id: string) => webEntry(id);

describe('ярусы набора шорт-листа (этап 135)', () => {
  test('ярус: база с точной ценой > веб с ценой > только похожие > без цены', () => {
    expect(shortlistTierOf(baseExact('a'))).toBe(4);
    expect(shortlistTierOf(webExact('w'))).toBe(3);
    expect(shortlistTierOf(baseAnalog('b'))).toBe(2);
    expect(shortlistTierOf(webEntry('x', { webPrices: priced(5, { approximate: true }) }))).toBe(2);
    expect(shortlistTierOf(entry('c'))).toBe(1);
  });

  test('базы с ценой хватает на всё: веб без фиксированных мест не входит', () => {
    const base = Array.from({ length: 12 }, (_, i) => baseExact(`b${i}`));
    const web = Array.from({ length: 6 }, (_, i) => webExact(`w${i}`));
    const selection = selectByTiers([...web, ...base], 10);
    expect(selection.required).toHaveLength(0);
    expect(selection.slots).toBe(10);
    const picked = applyTierSelection(selection, [...web, ...base]);
    expect(ids(picked).every((id) => id.startsWith('b'))).toBe(true);
    expect(picked).toHaveLength(10);
  });

  test('базы меньше десяти: веб с ценой добирает остаток, цена без цены - после', () => {
    const base = Array.from({ length: 6 }, (_, i) => baseExact(`b${i}`));
    const web = Array.from({ length: 6 }, (_, i) => webExact(`w${i}`));
    const bare = [entry('card1'), webNoPrice('w-bare')];
    const ranked = [...bare, ...web, ...base];
    const picked = applyTierSelection(selectByTiers(ranked, 10), ranked);
    expect(picked).toHaveLength(10);
    expect(ids(picked).filter((id) => id.startsWith('b'))).toHaveLength(6);
    expect(ids(picked).filter((id) => id.startsWith('w') && id !== 'w-bare')).toHaveLength(4);
    expect(ids(picked)).not.toContain('card1');
    expect(ids(picked)).not.toContain('w-bare');
  });

  test('без цены - только в остаток, когда цен мало', () => {
    const ranked = [entry('card1'), webNoPrice('w-bare'), baseExact('b0'), baseAnalog('a0')];
    const picked = applyTierSelection(selectByTiers(ranked, 10), ranked);
    expect(ids(picked).sort()).toEqual(['a0', 'b0', 'card1', 'w-bare']);
  });

  test('пограничный ярус выбирает порядок ranked, обязательные остаются', () => {
    const base = Array.from({ length: 3 }, (_, i) => baseExact(`b${i}`));
    const web = Array.from({ length: 5 }, (_, i) => webExact(`w${i}`));
    const selection = selectByTiers([...base, ...web], 5);
    expect(ids(selection.required)).toEqual(['b0', 'b1', 'b2']);
    expect(selection.slots).toBe(2);
    const modelOrder = [web[4], base[0], web[2], base[1], base[2], web[0], web[1], web[3]].filter(
      (item): item is ShortlistEntry => item !== undefined,
    );
    expect(ids(applyTierSelection(selection, modelOrder))).toEqual(['w4', 'b0', 'w2', 'b1', 'b2']);
  });

  test('сверх limit ничего нет', () => {
    expect(applyTierSelection(selectByTiers([entry('a')], 0), [entry('a')])).toEqual([]);
  });
});

describe('dropPriceOutliers: выбросы веб-цен', () => {
  const watch = (amount: number) => ({ item: 'часы', amount, currency: 'RUB', unit: 'шт' });

  test('8,63 ₽ при остальных в тысячи отсекается, нормальные остаются', () => {
    const kept = dropPriceOutliers([watch(8.63), watch(1200), watch(1500), watch(1800)]);
    expect(kept.map((p) => p.amount)).toEqual([1200, 1500, 1800]);
  });

  test('меньше трёх цен в группе - не трогаем', () => {
    expect(dropPriceOutliers([watch(8.63), watch(1200)])).toHaveLength(2);
  });

  test('разные позиции и валюты считаются по отдельности', () => {
    const other = { item: 'ручка', amount: 5, currency: 'RUB', unit: 'шт' };
    const kept = dropPriceOutliers([watch(1200), watch(1300), watch(1400), other]);
    expect(kept).toHaveLength(4);
  });
});

describe('applyModelOrder', () => {
  const pool = [entry('a'), entry('b'), entry('c')];
  const { supplierIdByCode } = buildCompareFacts(pool);

  test('порядок модели применяется', () => {
    const result = applyModelOrder({ order: ['c3', 'c1', 'c2'] }, supplierIdByCode, pool);
    expect(ids(result ?? [])).toEqual(['c', 'a', 'b']);
  });

  test('выдуманные и повторные коды отброшены, пропущенные дописаны по порядку кода', () => {
    const result = applyModelOrder({ order: ['zzz', 'c3', 'c3', 'c1'] }, supplierIdByCode, pool);
    expect(ids(result ?? [])).toEqual(['c', 'a', 'b']);
  });

  test('мусор - null (порядок строит правило)', () => {
    for (const raw of [null, 'text', {}, { order: 'c1' }, { order: [] }, { order: ['x'] }]) {
      expect(applyModelOrder(raw, supplierIdByCode, pool)).toBeNull();
    }
  });
});

describe('parseModelOrder: терпимый разбор и причины отказа', () => {
  const pool = ['a', 'b', 'c', 'd'].map((id) => entry(id));
  const { supplierIdByCode } = buildCompareFacts(pool);
  const parse = (raw: unknown) => parseModelOrder(raw, supplierIdByCode, pool);
  const okIds = (raw: unknown): string[] => {
    const outcome = parse(raw);
    if (!outcome.ok) throw new Error(`отказ: ${outcome.reason}`);
    return ids(outcome.entries);
  };
  const reasonOf = (raw: unknown) => {
    const outcome = parse(raw);
    return outcome.ok ? 'ok' : outcome.reason;
  };

  test('JSON в ограде и с текстом вокруг', () => {
    const json = '{"order":["c4","c3","c2","c1"]}';
    expect(okIds('```json\n' + json + '\n```')).toEqual(['d', 'c', 'b', 'a']);
    expect(okIds('Вот порядок:\n' + json + '\nГотово.')).toEqual(['d', 'c', 'b', 'a']);
    expect(okIds({ text: json, truncated: false })).toEqual(['d', 'c', 'b', 'a']);
  });

  test('регистр и пробелы в кодах', () => {
    expect(okIds({ order: [' C4 ', 'c 3', '"c2"', 'c1'] })).toEqual(['d', 'c', 'b', 'a']);
  });

  test('номера вместо кодов', () => {
    expect(okIds({ order: [4, '3', '#2', 1] })).toEqual(['d', 'c', 'b', 'a']);
    expect(reasonOf({ order: [9, 10, 11] })).toBe('unknown_codes');
  });

  test('голый массив принимается', () => {
    expect(okIds('["c2","c1","c3","c4"]')).toEqual(['b', 'a', 'c', 'd']);
  });

  test('частичный ответ от половины дописывается по правилу', () => {
    const outcome = parse({ order: ['c3', 'c2'] });
    expect(outcome).toMatchObject({ ok: true, known: 2, total: 4 });
    expect(okIds({ order: ['c3', 'c2'] })).toEqual(['c', 'b', 'a', 'd']);
  });

  test('меньше половины - missing_codes с числами', () => {
    expect(parse({ order: ['c3'] })).toEqual({
      ok: false,
      reason: 'missing_codes',
      returned: 1,
      known: 1,
      total: 4,
    });
  });

  test('причины отказа', () => {
    expect(reasonOf('не json')).toBe('not_json');
    expect(reasonOf({ order: 'c1' })).toBe('wrong_shape');
    expect(reasonOf({ items: [] })).toBe('wrong_shape');
    expect(reasonOf({ order: ['x1', 'x2'] })).toBe('unknown_codes');
    expect(reasonOf({ order: ['c1', 'c1', 'c1'] })).toBe('duplicate_codes');
    expect(reasonOf({ order: [] })).toBe('missing_codes');
  });

  test('обрыв по лимиту токенов: truncated, а прочитанное от половины принимается', () => {
    expect(reasonOf({ text: '{"order":["c1"', truncated: true })).toBe('truncated');
    expect(reasonOf({ text: 'Сначала рассуждения без списка', truncated: true })).toBe('truncated');
    expect(okIds({ text: '{"order":["c2","c4","c1","c', truncated: true })).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
});

describe('parseModelOrder: выбор с причинами и число мест', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry(id));
  const { supplierIdByCode } = buildCompareFacts(pool);

  test('picks с {id, reason}: причины сохраняются, повторы и чужие коды отбрасываются', () => {
    const outcome = parseModelOrder(
      {
        picks: [
          { id: 'c3', reason: 'точный товар' },
          { id: 'c9', reason: 'выдумка' },
          { id: 'c3', reason: 'повтор' },
          { id: 'c1', reason: '  два\nслова ' },
        ],
      },
      supplierIdByCode,
      pool,
      { need: 2 },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(ids(outcome.entries).slice(0, 2)).toEqual(['c', 'a']);
    expect(outcome.reasons.get('c')).toBe('точный товар');
    expect(outcome.reasons.get('a')).toBe('два слова');
  });

  test('need: ответ из двух кодов принят при 10 местах только от половины', () => {
    const raw = { picks: [{ id: 'c1' }, { id: 'c2' }] };
    expect(parseModelOrder(raw, supplierIdByCode, pool, { need: 4 }).ok).toBe(true);
    expect(parseModelOrder(raw, supplierIdByCode, pool, { need: 6 }).ok).toBe(false);
  });
});

describe('buildCompareFacts: что уходит модели', () => {
  test('только факты сравнения; названий, почты и контактов нет', () => {
    const facts = buildCompareFacts([
      entry('s1', {
        name: 'Секретное ООО',
        email: 'boss@secret.test',
        contacts: 'Иванов, +79990001122',
        leadTime: 'срок 5 дней, звоните +7 999 000-11-22 или boss@secret.test',
        prices: [{ item: 'Мёд липовый', amount: 100, currency: 'RUB', unit: 'кг' }],
        rating: 4,
      }),
    ]).facts;
    const text = JSON.stringify(facts);
    for (const secret of ['Секретное', 'boss@', '79990001122', 'Иванов', '999 000']) {
      expect(text).not.toContain(secret);
    }
    expect(facts.candidates[0]).toMatchObject({
      id: 'c1',
      source: 'база',
      rating: 4,
      hasContacts: true,
      prices: [{ position: 'p1', amount: 100, currency: 'RUB', unit: 'кг', exact: true }],
      pricedPositions: 1,
      exactPositions: 1,
      hasCity: false,
      hasLeadTime: true,
    });
  });

  test('позиции заявки с кодами, цены веба по позициям с товаром страницы, признаки', () => {
    const { facts } = buildCompareFacts(
      [
        webEntry('w', {
          city: 'Уфа',
          webPrices: [
            rub(180, 'Орехи', { unit: 'за 100 г', offer: 'Грецкий орех, 100 г, +7 999 000-11-22' }),
            rub(255, 'мёд', { unit: 'кг' }),
          ],
        }),
        entry('b', { prices: [rub(90, 'мёд'), rub(80, 'мёд', { approximate: true })] }),
      ],
      { positions: ['Мёд', 'Орехи', 'Чай'] },
    );
    expect(facts.positions).toEqual([
      { id: 'p1', name: 'Мёд' },
      { id: 'p2', name: 'Орехи' },
      { id: 'p3', name: 'Чай' },
    ]);
    expect(facts.positionsTotal).toBe(3);
    const [web, base] = facts.candidates;
    expect(web).toMatchObject({ source: 'веб', pricedPositions: 2, hasCity: true });
    expect(web?.prices).toEqual([
      expect.objectContaining({ position: 'p2', unit: 'за 100 г', offer: 'Грецкий орех, 100 г' }),
      expect.objectContaining({ position: 'p1', amount: 255, unit: 'кг' }),
    ]);
    // По позиции одна лучшая цена: точная раньше приблизительной, хоть и дороже.
    expect(base?.prices).toEqual([expect.objectContaining({ amount: 90, exact: true })]);
    expect(JSON.stringify(facts)).not.toContain('999');
  });

  test('этап 135: оценки товаров, ярус, сайт и специализация, требования заявки', () => {
    const { facts } = buildCompareFacts(
      [
        entry('s1', {
          website: 'https://www.tea-shop.test/catalog?x=1',
          specialization: 'чай, чайные пары, +7 999 000-11-22',
          city: 'Казань',
          prices: [
            rub(300, 'Чайная пара', { offer: 'Чайная пара фарфор', gradeReason: 'тот же товар' }),
          ],
        }),
        entry('s2', {
          prices: [
            rub(90, 'Чайная пара', {
              offer: 'Кружка',
              approximate: true,
              similar: true,
              gradeReason: 'кружка вместо пары',
            }),
          ],
        }),
      ],
      {
        positions: [{ name: 'Чайная пара', quantity: 50, unit: 'шт' }],
        requirements: { deadline: 'до 15 ноября', contact: 'звонить +7 999 000-11-22' },
        limit: 10,
        requiredSupplierIds: new Set(['s1']),
      },
    );
    const [first, second] = facts.candidates;
    expect(facts.positions).toEqual([{ id: 'p1', name: 'Чайная пара', quantity: 50, unit: 'шт' }]);
    expect(facts.limit).toBe(10);
    expect(facts.requirements?.deadline).toBe('до 15 ноября');
    expect(first).toMatchObject({
      priceTier: 'base_exact',
      required: true,
      site: 'tea-shop.test',
      city: 'Казань',
      specialization: 'чай, чайные пары',
    });
    expect(first?.prices[0]).toMatchObject({ grade: 'exact', gradeReason: 'тот же товар' });
    expect(second).toMatchObject({ priceTier: 'analog_only' });
    expect(second?.required).toBeUndefined();
    expect(second?.prices[0]).toMatchObject({ grade: 'analog', exact: false });
    expect(JSON.stringify(facts)).not.toContain('999');
  });

  test('цен на кандидата не меньше числа позиций заявки', () => {
    const names = Array.from({ length: 9 }, (_, i) => `позиция ${i}`);
    const { facts } = buildCompareFacts(
      [entry('s', { prices: names.map((name) => rub(10, name)) })],
      { positions: names },
    );
    expect(facts.candidates[0]?.prices).toHaveLength(9);
  });
});

describe('mergeCandidates: пул и добор веба по ярусам', () => {
  const base: SourceResult = {
    source: 'knowledge',
    status: 'ok',
    candidates: Array.from({ length: 14 }, (_, i) => ({
      name: `База ${i}`,
      supplierId: `b${i}`,
      score: 0.5,
      prices: [{ amount: 100 + i, currency: 'RUB' }],
    })),
  };
  const webResult: SourceResult = {
    source: 'web',
    status: 'ok',
    candidates: Array.from({ length: 23 }, (_, i) => ({
      name: `Сайт ${i}`,
      reference: `https://site${i}.test`,
      score: 0.9,
    })),
  };

  test('заявка 28.10: 14 из базы с ценой и 23 из веба без цены - показана одна база', () => {
    const outcome = mergeCandidates([base, webResult], OPTIONS);
    expect(outcome.pool).toHaveLength(20);
    expect(outcome.entries).toHaveLength(10);
    const webShown = outcome.entries.filter((item) => !item.sources.includes('knowledge'));
    expect(webShown).toHaveLength(0);
    expect(outcome.truncated).toBe(27);
  });

  test('базы с ценой пять, веб с ценой и без: веб с ценой добирает, без цены - в хвосте', () => {
    const fewBase: SourceResult = { ...base, candidates: base.candidates.slice(0, 5) };
    const priced: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: Array.from({ length: 8 }, (_, i) => ({
        name: `Сайт ${i}`,
        reference: `https://site${i}.test`,
        score: i < 3 ? 0.9 : 0.1,
        ...(i < 3 ? {} : { webPrices: [{ amount: 50 + i, currency: 'RUB' }] }),
      })),
    };
    const outcome = mergeCandidates([fewBase, priced], OPTIONS);
    const shown = outcome.entries.map((item) => item.name);
    expect(outcome.entries).toHaveLength(10);
    // Пять баз, затем пять веб-кандидатов с ценой; трое без цены не вошли.
    expect(shown.filter((name) => name.startsWith('База'))).toHaveLength(5);
    expect(shown).not.toContain('Сайт 0');
    expect(shown).toContain('Сайт 7');
  });

  test('веба нет - пул целиком из базы', () => {
    const outcome = mergeCandidates([base], OPTIONS);
    expect(outcome.pool).toHaveLength(14);
    expect(outcome.entries).toHaveLength(10);
  });
});

describe('shortlistProposalSchema: поля сравнения', () => {
  const stored = {
    requestId: 'r1',
    version: 'v',
    createdAt: '2026-10-28T00:00:00Z',
    managerThreadId: 't',
    entries: [],
    truncated: 0,
    sources: [],
  };

  test('старая запись без compared/orderMethod читается', () => {
    expect(shortlistProposalSchema.safeParse(stored).success).toBe(true);
  });

  test('новые поля сохраняются', () => {
    const parsed = shortlistProposalSchema.parse({
      ...stored,
      compared: 20,
      orderMethod: 'model',
    });
    expect(parsed).toMatchObject({ compared: 20, orderMethod: 'model' });
    expect(shortlistProposalSchema.safeParse({ ...stored, orderMethod: 'x' }).success).toBe(false);
  });
});

describe('подозрительная «цена от» за услугу (этап 170)', () => {
  const fromPrice = (amount: number) => priced(amount, { qualifier: 'from' });
  const service = () => entry('service', { prices: fromPrice(30000) });
  const exactOnes = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      entry(`e${i}`, { prices: priced(400 + i * 50), email: `e${i}@example.test` }),
    );
  const shown = (pool: ShortlistEntry[], limit: number): string[] => {
    const ranked = compareByCriteria(pool);
    const plan = planShortlist(ranked, limit);
    return ids(arrangeShortlist(plan, ranked, limit));
  };

  test('«от 30 000» без контактов и города при дешёвых точных - подозрительна', () => {
    const pool = [service(), ...exactOnes(5)];
    expect([...suspiciousFromPriceIds(pool)]).toEqual(['service']);
  });

  test('при достаточном числе кандидатов уступает место точным', () => {
    const pool = [service(), ...exactOnes(10)];
    const picked = shown(pool, 10);
    expect(picked).toHaveLength(10);
    expect(picked).not.toContain('service');
  });

  test('при малом числе кандидатов остаётся в списке, но последней', () => {
    const picked = shown([service(), ...exactOnes(4)], 10);
    expect(picked).toHaveLength(5);
    expect(picked).toContain('service');
  });

  test('с контактами или без точных цен для сравнения - не подозрительна', () => {
    const withMail = entry('svc', { prices: fromPrice(30000), email: 'svc@example.test' });
    expect(suspiciousFromPriceIds([withMail, ...exactOnes(5)]).size).toBe(0);
    expect(suspiciousFromPriceIds([service(), ...exactOnes(2)]).size).toBe(0);
  });

  test('«от» того же порядка, что точные цены, не понижается', () => {
    const close = entry('close', { prices: fromPrice(600) });
    expect(suspiciousFromPriceIds([close, ...exactOnes(5)]).size).toBe(0);
  });
});
