import { describe, expect, test } from 'bun:test';
import {
  mergeCandidates,
  normalizeSupplierName,
  validateShortlistSelection,
  shortlistProposalSchema,
  type ShortlistProposal,
  type SourceResult,
} from '../../../src/kit/domain/shortlist';

const externalId = (normalized: string): string => `ext-${normalized}`;
const OPTIONS = { limit: 10, externalId };

const knowledge: SourceResult = {
  source: 'knowledge',
  status: 'ok',
  candidates: [
    { name: 'МеталлТорг', supplierId: 's1', email: 'a@metall.test', score: 0.5 },
    { name: 'Болтик', supplierId: 's2', score: 1 },
  ],
};
const web: SourceResult = {
  source: 'web',
  status: 'ok',
  candidates: [
    { name: 'ООО «Металлторг»', reference: 'https://metall.test', score: 0.9 },
    { name: 'Сталь-Опт', reference: 'https://stal.test', score: 0.4 },
  ],
};
// Кандидат из базы знаний без карточки поставщика: сливается с тем же названием из веба.
const knowledgeHint: SourceResult = {
  source: 'knowledge',
  status: 'ok',
  candidates: [{ name: 'Сталь Опт', reference: 'kb:1', score: 0.8 }],
};

describe('normalizeSupplierName', () => {
  test('без регистра, кавычек, ё и юридической формы', () => {
    expect(normalizeSupplierName('ООО «Металл-Торг»')).toBe('металл торг');
    expect(normalizeSupplierName('Ёлка')).toBe('елка');
  });

  test('название из одной юридической формы не пустеет', () => {
    expect(normalizeSupplierName('ООО')).toBe('ооо');
  });
});

describe('mergeCandidates', () => {
  test('дедупликация: внешний кандидат с тем же названием уходит к поставщику из базы', () => {
    const { entries } = mergeCandidates([web, knowledge], OPTIONS);
    const metall = entries.find((entry) => entry.supplierId === 's1');
    expect(metall?.sources).toEqual(['knowledge', 'web']);
    expect(metall?.score).toBe(0.9);
    expect(metall?.references).toEqual(['https://metall.test']);
    expect(entries.filter((entry) => entry.name.toLowerCase().includes('металл'))).toHaveLength(1);
  });

  test('у каждой строки перечислены все источники; внешний id детерминирован', () => {
    const { entries } = mergeCandidates([web, knowledgeHint], OPTIONS);
    const stal = entries.find((entry) => entry.supplierId === 'ext-сталь опт');
    expect(stal?.sources).toEqual(['knowledge', 'web']);
  });

  test('ранжирование: сначала база, внутри яруса - источников больше, затем оценка', () => {
    const { entries } = mergeCandidates([knowledge, web, knowledgeHint], OPTIONS);
    // «Сталь-Опт» нашёлся двумя источниками, но у него нет карточки: он ниже базы.
    expect(entries.map((entry) => entry.name)).toEqual(['МеталлТорг', 'Болтик', 'Сталь-Опт']);
  });

  test('только приблизительные цены: ярус «по карточке», вне средней по базе', () => {
    const base: SourceResult = {
      source: 'knowledge',
      status: 'ok',
      candidates: [
        {
          name: 'Грубо',
          supplierId: 'a1',
          score: 0.9,
          prices: [{ amount: 50, currency: 'RUB', approximate: true }],
        },
        {
          name: 'Точно',
          supplierId: 'a2',
          score: 0.1,
          prices: [{ amount: 70, currency: 'RUB' }],
        },
      ],
    };
    const result = mergeCandidates([base], OPTIONS);
    expect(result.entries.map((entry) => entry.name)).toEqual(['Точно', 'Грубо']);
    const market = result.market;
    expect(market?.status === 'ok' ? market.groups[0]?.average : null).toBe(70);
  });

  test('база с ценами > база по карточке > веб, даже при оценке веба 1,0', () => {
    const base: SourceResult = {
      source: 'knowledge',
      status: 'ok',
      candidates: [
        { name: 'Карточка', supplierId: 'c1', status: 'new', score: 0.25 },
        {
          name: 'Прайс',
          supplierId: 'p1',
          score: 0.5,
          prices: [{ item: 'мёд', amount: 100, currency: 'RUB' }],
        },
      ],
    };
    const site: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: [
        { name: 'Сайт А', reference: 'https://a.test', score: 1 },
        { name: 'Сайт Б', reference: 'https://b.test', score: 0.3 },
      ],
    };
    const { entries } = mergeCandidates([site, base], OPTIONS);
    expect(entries.map((entry) => entry.name)).toEqual(['Прайс', 'Карточка', 'Сайт А', 'Сайт Б']);
  });

  test('внутри веба порядок по оценке, ссылки одной компании копятся', () => {
    const site: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: [
        { name: 'Низкий', reference: 'https://low.test', score: 0.2 },
        { name: 'Высокий', reference: 'https://high.test/a', score: 0.9 },
        { name: 'Высокий', reference: 'https://high.test/b', score: 0.5 },
      ],
    };
    const { entries } = mergeCandidates([site], OPTIONS);
    expect(entries.map((entry) => entry.name)).toEqual(['Высокий', 'Низкий']);
    expect(entries[0]?.references).toEqual(['https://high.test/a', 'https://high.test/b']);
  });

  test('при равенстве побеждают контакты (e-mail), потом оценка, потом название', () => {
    const result: SourceResult = {
      source: 'knowledge',
      status: 'ok',
      candidates: [
        { name: 'Б', supplierId: 'b', score: 0.5 },
        { name: 'А', supplierId: 'a', score: 0.5 },
        { name: 'В', supplierId: 'v', score: 0.5, email: 'v@x.test' },
        { name: 'Г', supplierId: 'g', score: 0.9 },
      ],
    };
    const names = mergeCandidates([result], OPTIONS).entries.map((entry) => entry.name);
    // Контакты - критерий порядка (29.10), выше ярусной оценки поиска.
    expect(names).toEqual(['В', 'Г', 'А', 'Б']);
  });

  test('размер ограничен, число отброшенных возвращается', () => {
    const outcome = mergeCandidates([knowledge, web, knowledgeHint], { ...OPTIONS, limit: 2 });
    expect(outcome.entries).toHaveLength(2);
    expect(outcome.truncated).toBe(1);
  });

  test('недоступный источник кандидатов не даёт, остальные работают', () => {
    const down: SourceResult = {
      source: 'web',
      status: 'unavailable',
      reason: 'x',
      candidates: [],
    };
    const outcome = mergeCandidates([knowledge, down], OPTIONS);
    // У s1 есть e-mail (контакты) - при отсутствии цен он выше s2 с большей оценкой поиска.
    expect(outcome.entries.map((entry) => entry.supplierId)).toEqual(['s1', 's2']);
  });

  test('нет кандидатов — пустой шорт-лист', () => {
    expect(mergeCandidates([], OPTIONS)).toEqual({ entries: [], truncated: 0 });
  });
});

describe('mergeCandidates: статусы карточек', () => {
  const cards: SourceResult = {
    source: 'knowledge',
    status: 'ok',
    candidates: [
      { name: 'Новый', supplierId: 'n1', status: 'new', score: 0.6 },
      { name: 'Действующий', supplierId: 'a1', status: 'active', score: 0.6 },
      { name: 'Прежний', supplierId: 'x1', status: 'inactive', score: 1 },
    ],
  };

  test('«не работаем» исключается и считается; «действующий» выше «нового»', () => {
    const outcome = mergeCandidates([cards], OPTIONS);
    expect(outcome.entries.map((entry) => entry.supplierId)).toEqual(['a1', 'n1']);
    expect(outcome.excludedInactive).toBe(1);
  });

  test('внешний кандидат с названием исключённого поставщика не возвращает его', () => {
    const web: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: [{ name: 'ООО «Прежний»', reference: 'https://old.test', score: 0.9 }],
    };
    const outcome = mergeCandidates([cards, web], OPTIONS);
    expect(outcome.entries.map((entry) => entry.supplierId)).toEqual(['a1', 'n1']);
    expect(outcome.excludedInactive).toBe(1);
  });

  test('без статусов порядок и результат прежние', () => {
    const outcome = mergeCandidates([knowledge, web, knowledgeHint], OPTIONS);
    expect(outcome.excludedInactive).toBeUndefined();
  });
});

describe('normalizeSupplierName: общие примеры с индексатором', () => {
  // Те же примеры в services/indexer/tests/test_suppliers.py (PARITY_EXAMPLES).
  const examples: Array<[string, string]> = [
    ['ООО "Ромашка"', 'ромашка'],
    ['  ИП Иванов  И.И. ', 'иванов и и'],
    ['Ёлки-Палки, ЗАО', 'елки палки'],
    ['ООО', 'ооо'],
    ['ООО ОАО', 'ооо оао'],
    ['Металл-Снаб 2000', 'металл снаб 2000'],
    ['ТОО «Альфа»', 'альфа'],
    ['«»', ''],
    ['Acme Ltd.', 'acme ltd'],
  ];
  test.each(examples)('%s', (raw, expected) => {
    expect(normalizeSupplierName(raw)).toBe(expected);
  });
});

describe('validateShortlistSelection', () => {
  const proposal: ShortlistProposal = {
    requestId: 'req-1',
    version: 'v',
    createdAt: '2026-01-01T00:00:00.000Z',
    managerThreadId: 't',
    entries: [{ supplierId: 's1', name: 'А', sources: ['knowledge'], score: 1, references: [] }],
    truncated: 0,
    sources: [],
  };

  test('подмножество предложенного проходит', () => {
    expect(validateShortlistSelection(['s1'], proposal)).toEqual([]);
  });

  test('пустой выбор и посторонний поставщик — замечания', () => {
    expect(validateShortlistSelection([], proposal).map((i) => i.code)).toEqual(['no_selection']);
    expect(validateShortlistSelection(['s9'], proposal).map((i) => i.code)).toEqual([
      'not_in_proposal',
    ]);
  });
});

describe('shortlistProposalSchema: устаревшие источники', () => {
  const legacy = {
    requestId: 'r1',
    version: 'v1',
    createdAt: '2026-01-01T00:00:00Z',
    managerThreadId: 't1',
    entries: [
      {
        supplierId: 's1',
        name: 'А',
        sources: ['knowledge', 'community'],
        score: 1,
        references: [],
      },
      { supplierId: 'ext-б', name: 'Б', sources: ['community'], score: 0.5, references: [] },
    ],
    truncated: 0,
    sources: [
      { source: 'knowledge', status: 'ok' },
      { source: 'community', status: 'ok' },
      { source: 'web', status: 'not_searched' },
    ],
  };

  test('community в сохранённом шорт-листе тихо отбрасывается, чтение не падает', () => {
    const parsed = shortlistProposalSchema.parse(legacy);
    expect(parsed.sources.map((item) => item.source)).toEqual(['knowledge', 'web']);
    expect(parsed.entries.map((entry) => entry.supplierId)).toEqual(['s1']);
    expect(parsed.entries[0]?.sources).toEqual(['knowledge']);
  });

  test('чистка не отключает остальные проверки схемы', () => {
    expect(shortlistProposalSchema.safeParse({ ...legacy, truncated: -1 }).success).toBe(false);
  });
});

describe('mergeCandidates: сведения о поставщике и средняя стоимость', () => {
  const price = (amount: number, item = 'Арматура', currency = 'RUB') => ({
    item,
    amount,
    currency,
  });
  const base: SourceResult = {
    source: 'knowledge',
    status: 'ok',
    candidates: [
      {
        name: 'МеталлТорг',
        supplierId: 's1',
        score: 1,
        city: 'Казань',
        address: 'ул. Складская, 5',
        contacts: 'Петров Пётр, +79990001122, p@metall.test',
        leadTime: '3-5 дней',
        rating: 4,
        prices: [price(50), price(40)],
      },
      { name: 'Болтик', supplierId: 's2', score: 0.9, rating: null, prices: [price(60)] },
      { name: 'Сталь', supplierId: 's3', score: 0.8, prices: [price(70)] },
      { name: 'Прежний', supplierId: 'x', status: 'inactive', score: 1, prices: [price(1)] },
    ],
  };

  test('сведения из базы переходят в строку; вебу достаются они же при слиянии по названию', () => {
    const outcome = mergeCandidates([base, web], OPTIONS);
    const metall = outcome.entries.find((entry) => entry.supplierId === 's1');
    expect(metall).toMatchObject({
      city: 'Казань',
      address: 'ул. Складская, 5',
      contacts: 'Петров Пётр, +79990001122, p@metall.test',
      leadTime: '3-5 дней',
      rating: 4,
      sources: ['knowledge', 'web'],
    });
  });

  test('источник и обоснование рейтинга идут вместе с оценкой из одного кандидата', () => {
    const rated: SourceResult = {
      source: 'knowledge',
      status: 'ok',
      candidates: [
        { name: 'Сталь', supplierId: 's3', score: 1, rating: null },
        {
          name: 'Сталь',
          supplierId: 's3',
          score: 1,
          rating: 5,
          ratingSource: 'model',
          ratingRationale: 'Надёжный поставщик.',
        },
      ],
    };
    const entry = mergeCandidates([rated], OPTIONS).entries[0];
    expect(entry).toMatchObject({
      rating: 5,
      ratingSource: 'model',
      ratingRationale: 'Надёжный поставщик.',
    });
  });

  test('цена одной позиции и валюты у поставщика - самая низкая', () => {
    const outcome = mergeCandidates([base], OPTIONS);
    const metall = outcome.entries.find((entry) => entry.supplierId === 's1');
    expect(metall?.prices).toEqual([price(40)]);
  });

  test('средняя считается по всем найденным, кроме «не работаем», и не зависит от limit', () => {
    const outcome = mergeCandidates([base], { ...OPTIONS, limit: 1 });
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.market).toMatchObject({ status: 'ok', found: 3 });
    if (outcome.market?.status !== 'ok') throw new Error('ожидалось ok');
    expect(outcome.market.groups[0]).toMatchObject({ n: 3, average: 56.67, min: 40, max: 70 });
  });

  test('две цены - среднее по двум; цен нет - поля market нет', () => {
    const few: SourceResult = {
      ...base,
      candidates: base.candidates.slice(0, 2),
    };
    const market = mergeCandidates([few], OPTIONS).market;
    expect(market).toMatchObject({ status: 'ok', found: 2 });
    expect(mergeCandidates([knowledge, web], OPTIONS).market).toBeUndefined();
  });

  test('одна цена базы - тоже среднее (порога нет)', () => {
    const one: SourceResult = { ...base, candidates: base.candidates.slice(0, 1) };
    expect(mergeCandidates([one], OPTIONS).market).toMatchObject({ status: 'ok', found: 1 });
  });

  test('средняя по интернету считается по webPrice, валюты не смешиваются', () => {
    const webResult: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: [
        { name: 'Сайт А', score: 0.5, webPrice: { amount: 100, currency: 'RUB', unit: 'шт' } },
        { name: 'Сайт Б', score: 0.5, webPrice: { amount: 200, currency: 'RUB', unit: 'шт' } },
        { name: 'Сайт В', score: 0.5, webPrice: { amount: 3, currency: 'USD', unit: 'шт' } },
        { name: 'Сайт Г', score: 0.5 },
      ],
    };
    const outcome = mergeCandidates([base, webResult], OPTIONS);
    if (outcome.webMarket?.status !== 'ok') throw new Error('ожидалось ok');
    expect(outcome.webMarket.found).toBe(3);
    expect(outcome.webMarket.groups.map((g) => [g.currency, g.n, g.average])).toEqual([
      ['RUB', 2, 150],
      ['USD', 1, 3],
    ]);
    // Веб-цены в среднюю по базе не попадают.
    expect(outcome.market).toMatchObject({ status: 'ok', found: 3 });
  });

  test('несколько позиций в заявке: цены сайтов без позиции не усредняются', () => {
    const webResult: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: [
        { name: 'Сайт А', score: 0.5, webPrice: { amount: 100, currency: 'RUB', unit: 'шт' } },
        { name: 'Сайт Б', score: 0.5, webPrice: { amount: 9000, currency: 'RUB', unit: 'шт' } },
      ],
    };
    const several = mergeCandidates([base, webResult], { ...OPTIONS, positionCount: 3 });
    expect(several.webMarket).toBeUndefined();
    expect(several.webPricesUnmatched).toBe(2);
    // Цена остаётся в строке поставщика: скрыта только смешанная средняя.
    expect(several.entries.filter((entry) => entry.webPrice !== undefined)).toHaveLength(2);
    // Одна позиция (или число не передано) - средняя считается как раньше.
    for (const options of [{ ...OPTIONS, positionCount: 1 }, OPTIONS]) {
      const single = mergeCandidates([base, webResult], options);
      expect(single.webMarket).toMatchObject({ status: 'ok', found: 2 });
      expect(single.webPricesUnmatched).toBeUndefined();
    }
  });

  test('несколько позиций: цены сайтов по позициям усредняются по позициям, похожие - нет', () => {
    const price = (item: string, amount: number, approximate?: true) => ({
      item,
      amount,
      currency: 'RUB',
      unit: 'шт',
      ...(approximate === undefined ? {} : { approximate }),
    });
    const webResult: SourceResult = {
      source: 'web',
      status: 'ok',
      candidates: [
        { name: 'Сайт А', score: 0.5, webPrices: [price('мед', 100), price('орехи', 50)] },
        { name: 'Сайт Б', score: 0.5, webPrices: [price('мед', 300), price('орехи', 9, true)] },
      ],
    };
    const outcome = mergeCandidates([base, webResult], { ...OPTIONS, positionCount: 2 });
    if (outcome.webMarket?.status !== 'ok') throw new Error('ожидалось ok');
    expect(outcome.webMarket.groups.map((g) => [g.item, g.n, g.average])).toEqual([
      ['мед', 2, 200],
      ['орехи', 1, 50],
    ]);
    expect(outcome.webPricesUnmatched).toBeUndefined();
  });

  test('веб-цен нет - поля webMarket нет', () => {
    expect(mergeCandidates([base], OPTIONS).webMarket).toBeUndefined();
  });

  test('рейтинг null (нет оценки) сохраняется как null, а не 0', () => {
    const outcome = mergeCandidates([base], OPTIONS);
    const boltik = outcome.entries.find((entry) => entry.supplierId === 's2');
    expect(boltik?.rating).toBeNull();
  });

  test('строки без новых сведений не получают лишних полей', () => {
    const entry = mergeCandidates([knowledge], OPTIONS).entries[0];
    expect(entry).toBeDefined();
    for (const key of ['city', 'address', 'contacts', 'prices', 'leadTime', 'rating']) {
      expect(key in (entry ?? {})).toBe(false);
    }
  });
});

describe('shortlistProposalSchema: совместимость со старыми записями', () => {
  const OLD = {
    requestId: 'r1',
    version: 'v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    managerThreadId: 't',
    entries: [
      { supplierId: 's1', name: 'МеталлТорг', email: 'a@b.test', sources: ['knowledge'],
        score: 0.5, references: [] },
    ],
    truncated: 0,
    sources: [{ source: 'knowledge', status: 'ok' }],
  };

  test('запись без новых полей читается, market не появляется', () => {
    const parsed = shortlistProposalSchema.parse(OLD);
    expect(parsed.market).toBeUndefined();
    expect(parsed.entries[0]?.prices).toBeUndefined();
    expect(parsed.entries[0]?.rating).toBeUndefined();
  });

  test('новые поля читаются, рейтинг вне 1..5 отклоняется', () => {
    const entry = { ...OLD.entries[0], city: 'Казань', rating: 3.5 };
    const parsed = shortlistProposalSchema.parse({
      ...OLD,
      entries: [entry],
      market: { status: 'too_few', found: 2, minSamples: 3 },
      webMarket: { status: 'none' },
    });
    expect(parsed.entries[0]).toMatchObject({ city: 'Казань', rating: 3.5 });
    expect(parsed.market).toEqual({ status: 'none' });
    expect(parsed.webMarket).toEqual({ status: 'none' });
    const sourced = { ...OLD.entries[0], rating: 4, ratingSource: 'model', ratingRationale: 'ок' };
    expect(shortlistProposalSchema.parse({ ...OLD, entries: [sourced] }).entries[0]).toMatchObject({
      ratingSource: 'model',
      ratingRationale: 'ок',
    });
    for (const patch of [{ ratingSource: 'rule' }, { ratingRationale: '' }]) {
      const bad = { ...OLD, entries: [{ ...sourced, ...patch }] };
      expect(shortlistProposalSchema.safeParse(bad).success).toBe(false);
    }
    for (const rating of [0, 6]) {
      const bad = { ...OLD, entries: [{ ...OLD.entries[0], rating }] };
      expect(shortlistProposalSchema.safeParse(bad).success).toBe(false);
    }
  });
});
