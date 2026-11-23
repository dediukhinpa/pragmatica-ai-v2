import { describe, expect, test } from 'bun:test';
import {
  SOURCE_LABELS,
  SUPPLIER_SOURCES,
  mergeCandidates,
  shortlistProposalSchema,
  telegramFieldsOfCandidate,
  type SourceResult,
  type SupplierCandidate,
} from '../../../src/kit/domain/shortlist';
import {
  TELEGRAM_FIELDS,
  TELEGRAM_MAX_SHORTLIST_PLACES,
  TELEGRAM_SOURCE_MARK,
  withTelegramNote,
} from '../../../src/kit/domain/telegram-source';
import { WEB_SOURCE_MARK } from '../../../src/kit/domain/supplier-enrichment';
import { isWebOnlyEntry, shortlistTierOf } from '../../../src/kit/domain/shortlist-compare';
import { marketPriceSampleSchema } from '../../../src/kit/domain/market-price';

/**
 * Закрытый Telegram-канал как источник шорт-листа (этап 216): приоритет как у базы знаний,
 * своя пометка «из Telegram-канала», происхождение полей хранится по полю (`telegramFields`).
 */

const OPTIONS = { limit: 10, externalId: (name: string): string => `ext-${name}` };
const PRICE = { item: 'Арматура', amount: 50, currency: 'RUB' };

function source(name: SourceResult['source'], candidates: SupplierCandidate[]): SourceResult {
  return { source: name, status: 'ok', candidates };
}

const TELEGRAM_CANDIDATE: SupplierCandidate = {
  name: 'Канальный металл',
  reference: 'tg:suppliers/101',
  city: 'Пермь',
  contacts: 'тел. +70000000004',
  email: 'zakaz@kanal.test',
  leadTime: '5 дней',
  prices: [PRICE],
  score: 0.8,
};

describe('источник telegram: константы', () => {
  test('источник входит в перечень, подпись - единая константа, не «ИЗ ИНТЕРНЕТА»', () => {
    expect([...SUPPLIER_SOURCES]).toEqual(['knowledge', 'web', 'telegram']);
    expect(TELEGRAM_SOURCE_MARK).toBe('из Telegram-канала');
    expect(TELEGRAM_SOURCE_MARK).not.toBe(WEB_SOURCE_MARK);
    expect(SOURCE_LABELS.telegram).toBe(TELEGRAM_SOURCE_MARK);
    expect(withTelegramNote('Пермь')).toBe(`Пермь (${TELEGRAM_SOURCE_MARK})`);
  });

  test('перечень полей с пометкой закрыт', () => {
    expect([...TELEGRAM_FIELDS]).toEqual(['city', 'contacts', 'email', 'leadTime', 'prices']);
  });

  test('telegramFieldsOfCandidate: по одному полю на заполненное сведение', () => {
    expect(telegramFieldsOfCandidate(TELEGRAM_CANDIDATE)).toEqual([...TELEGRAM_FIELDS]);
    expect(telegramFieldsOfCandidate({})).toEqual([]);
    expect(telegramFieldsOfCandidate({ city: 'Омск' })).toEqual(['city']);
  });
});

describe('ранжирование: канал = база знаний', () => {
  const BASE: SupplierCandidate = {
    name: 'МеталлТорг',
    supplierId: 's1',
    prices: [PRICE],
    score: 0.9,
  };
  const WEB: SupplierCandidate = {
    name: 'Интернет-поставщик',
    reference: 'https://web.test',
    webPrices: [PRICE],
    score: 1,
  };

  test('Telegram-кандидат с точной ценой занимает место базы, а не добирает после неё', () => {
    const results = [
      source('knowledge', [BASE]),
      source('web', [WEB]),
      source('telegram', [TELEGRAM_CANDIDATE]),
    ];
    const names = mergeCandidates(results, { ...OPTIONS, limit: 2 }).entries.map((e) => e.name);
    expect(names).toContain('МеталлТорг');
    expect(names).toContain('Канальный металл');
    expect(names).not.toContain('Интернет-поставщик');
  });

  test('контроль: без Telegram то же место получает веб', () => {
    const results = [source('knowledge', [BASE]), source('web', [WEB])];
    const names = mergeCandidates(results, { ...OPTIONS, limit: 2 }).entries.map((e) => e.name);
    expect(names).toContain('Интернет-поставщик');
  });

  test('в пул сравнения модели Telegram-кандидат входит как база', () => {
    const merged = mergeCandidates(
      [source('telegram', [TELEGRAM_CANDIDATE]), source('web', [WEB])],
      OPTIONS,
    );
    const telegram = merged.pool?.find((entry) => entry.sources.includes('telegram'));
    expect(telegram).toBeDefined();
    expect(telegram === undefined ? true : isWebOnlyEntry(telegram)).toBe(false);
    expect(telegram === undefined ? 0 : shortlistTierOf(telegram)).toBe(4);
  });

  test('isWebOnlyEntry: только веб - да, база, канал и их сочетания - нет', () => {
    expect(isWebOnlyEntry({ sources: ['web'] })).toBe(true);
    expect(isWebOnlyEntry({ sources: ['telegram'] })).toBe(false);
    expect(isWebOnlyEntry({ sources: ['web', 'telegram'] })).toBe(false);
    expect(isWebOnlyEntry({ sources: ['knowledge'] })).toBe(false);
  });

  test('тот же поставщик в базе и в канале - одна строка с двумя источниками', () => {
    const merged = mergeCandidates(
      [
        source('knowledge', [{ name: 'МеталлТорг', supplierId: 's1', city: 'Казань', score: 1 }]),
        source('telegram', [{ ...TELEGRAM_CANDIDATE, name: 'ООО «МеталлТорг»' }]),
      ],
      OPTIONS,
    );
    expect(merged.entries).toHaveLength(1);
    const [entry] = merged.entries;
    expect(entry?.supplierId).toBe('s1');
    expect(entry?.sources).toEqual(['knowledge', 'telegram']);
    // Город базы остаётся без пометки, срок и контакты взяты из канала и помечены.
    expect(entry?.city).toBe('Казань');
    expect(entry?.telegramFields).not.toContain('city');
    expect(entry?.telegramFields).toContain('leadTime');
    expect(entry?.telegramFields).toContain('contacts');
  });

  test('цены канала помечены, пока у поставщика нет цен базы; цены базы - без пометки', () => {
    const telegramOnly = mergeCandidates([source('telegram', [TELEGRAM_CANDIDATE])], OPTIONS);
    expect(telegramOnly.entries[0]?.telegramFields).toContain('prices');
    expect(telegramOnly.entries[0]?.prices).toEqual([{ ...PRICE, fromTelegram: true }]);
    const both = mergeCandidates(
      [
        source('knowledge', [{ name: 'Канальный металл', supplierId: 's9', prices: [PRICE], score: 1 }]),
        source('telegram', [TELEGRAM_CANDIDATE]),
      ],
      OPTIONS,
    );
    expect(both.entries[0]?.telegramFields).not.toContain('prices');
  });

  test('канал и веб с одним названием: оба источника в одной строке, поля - по происхождению', () => {
    const merged = mergeCandidates(
      [
        source('web', [{ name: 'Канальный металл', reference: 'https://kanal.test', score: 1 }]),
        source('telegram', [TELEGRAM_CANDIDATE]),
      ],
      OPTIONS,
    );
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]?.sources).toEqual(['web', 'telegram']);
    expect(merged.entries[0]?.telegramFields).toContain('city');
  });

  test('недоступный канал кандидатов не даёт, остальные источники не страдают', () => {
    const merged = mergeCandidates(
      [
        source('knowledge', [{ name: 'МеталлТорг', supplierId: 's1', score: 1 }]),
        { source: 'telegram', status: 'unavailable', reason: 'external_failure', candidates: [] },
      ],
      OPTIONS,
    );
    expect(merged.entries.map((e) => e.name)).toEqual(['МеталлТорг']);
  });

  test('строка без Telegram-сведений не получает поля telegramFields (отпечаток прежний)', () => {
    const merged = mergeCandidates(
      [source('knowledge', [{ name: 'МеталлТорг', supplierId: 's1', score: 1 }])],
      OPTIONS,
    );
    expect('telegramFields' in (merged.entries[0] ?? {})).toBe(false);
  });
});

describe('сохранённый шорт-лист', () => {
  const raw = {
    requestId: 'r1',
    version: 'v1',
    createdAt: '2026-11-08T00:00:00.000Z',
    managerThreadId: 'mgr',
    truncated: 0,
    sources: [{ source: 'telegram', status: 'ok' }],
    entries: [
      {
        supplierId: 'a',
        name: 'А',
        sources: ['telegram'],
        score: 1,
        references: ['tg:suppliers/1'],
        city: 'Омск',
        telegramFields: ['city'],
      },
    ],
  };

  test('источник и telegramFields читаются и сохраняются', () => {
    const parsed = shortlistProposalSchema.parse(raw);
    expect(parsed.entries[0]?.sources).toEqual(['telegram']);
    expect(parsed.entries[0]?.telegramFields).toEqual(['city']);
    expect(parsed.sources[0]?.source).toBe('telegram');
  });

  test('неизвестное поле в telegramFields отвергается; устаревший источник по-прежнему чистится', () => {
    const bad = { ...raw, entries: [{ ...raw.entries[0], telegramFields: ['site'] }] };
    expect(shortlistProposalSchema.safeParse(bad).success).toBe(false);
    const legacy = {
      ...raw,
      sources: [{ source: 'community', status: 'ok' }],
      entries: [{ ...raw.entries[0], sources: ['community'] }],
    };
    const parsed = shortlistProposalSchema.parse(legacy);
    expect(parsed.entries).toEqual([]);
    expect(parsed.sources).toEqual([]);
  });
});


describe('происхождение у каждой цены (ревью 216, п.1)', () => {
  const BASE: SupplierCandidate = {
    name: 'МеталлТорг',
    supplierId: 's1',
    prices: [{ ...PRICE, amount: 60 }],
    score: 0.9,
  };
  const CHANNEL_SAME_FIRM: SupplierCandidate = {
    ...TELEGRAM_CANDIDATE,
    name: 'ООО «МеталлТорг»',
    prices: [{ ...PRICE, amount: 40 }],
  };

  test('схема цены принимает признак fromTelegram', () => {
    expect(marketPriceSampleSchema.parse({ ...PRICE, fromTelegram: true }).fromTelegram).toBe(true);
  });

  test('цена канала не подменяет цену базы той же позиции, даже если она ниже', () => {
    for (const order of [
      [source('knowledge', [BASE]), source('telegram', [CHANNEL_SAME_FIRM])],
      [source('telegram', [CHANNEL_SAME_FIRM]), source('knowledge', [BASE])],
    ]) {
      const [entry] = mergeCandidates(order, OPTIONS).entries;
      expect(entry?.prices).toEqual([{ ...PRICE, amount: 60 }]);
      expect(entry?.telegramFields ?? []).not.toContain('prices');
    }
  });

  test('цены разных позиций: у каждой своё происхождение', () => {
    const channel = { ...CHANNEL_SAME_FIRM, prices: [{ ...PRICE, item: 'Сетка', amount: 70 }] };
    const [entry] = mergeCandidates(
      [source('knowledge', [BASE]), source('telegram', [channel])],
      OPTIONS,
    ).entries;
    expect(entry?.prices).toEqual([
      { ...PRICE, amount: 60 },
      { ...PRICE, item: 'Сетка', amount: 70, fromTelegram: true },
    ]);
    expect(entry?.telegramFields).toContain('prices');
  });

  test('канальные цены одной позиции: остаётся самая низкая, с пометкой', () => {
    const second = { ...TELEGRAM_CANDIDATE, reference: 'tg:suppliers/102', prices: [
      { ...PRICE, amount: 45 },
    ] };
    const [entry] = mergeCandidates([source('telegram', [TELEGRAM_CANDIDATE, second])], OPTIONS)
      .entries;
    expect(entry?.prices).toEqual([{ ...PRICE, amount: 45, fromTelegram: true }]);
  });
});

describe('средние: канал отдельно от базы (ревью 216, п.2)', () => {
  const baseOf = (id: string, amount: number): SupplierCandidate => ({
    name: `База ${id}`,
    supplierId: id,
    prices: [{ ...PRICE, amount }],
    score: 0.9,
  });
  const channelOf = (name: string, amount: number): SupplierCandidate => ({
    name,
    reference: `tg:suppliers/${name}`,
    prices: [{ ...PRICE, amount }],
    score: 0.8,
  });

  test('цены канала в среднюю по базе не входят, у них своя средняя', () => {
    const merged = mergeCandidates(
      [source('knowledge', [baseOf('s1', 100)]), source('telegram', [channelOf('Канал А', 50)])],
      OPTIONS,
    );
    expect(merged.market?.status === 'ok' && merged.market.groups[0]).toMatchObject({
      n: 1,
      average: 100,
    });
    expect(merged.telegramMarket?.status === 'ok' && merged.telegramMarket.groups[0]).toMatchObject(
      { n: 1, average: 50 },
    );
  });

  test('выбросы канала отсекаются из его средней', () => {
    const merged = mergeCandidates(
      [
        source('telegram', [
          channelOf('Канал А', 50),
          channelOf('Канал Б', 55),
          channelOf('Канал В', 5000),
        ]),
      ],
      OPTIONS,
    );
    const group = merged.telegramMarket?.status === 'ok' ? merged.telegramMarket.groups[0] : null;
    expect(group).toMatchObject({ n: 2, min: 50, max: 55 });
  });

  test('без канала поля telegramMarket в итоге нет', () => {
    const merged = mergeCandidates([source('knowledge', [baseOf('s1', 100)])], OPTIONS);
    expect('telegramMarket' in merged).toBe(false);
  });

  test('сохранённый шорт-лист читает и хранит telegramMarket', () => {
    const parsed = shortlistProposalSchema.parse({
      requestId: 'r1',
      version: 'v1',
      createdAt: '2026-11-08T00:00:00.000Z',
      managerThreadId: 'mgr',
      truncated: 0,
      sources: [],
      entries: [],
      telegramMarket: {
        status: 'ok',
        found: 1,
        groups: [{ currency: 'RUB', n: 1, average: 5, min: 5, max: 5 }],
      },
    });
    expect(parsed.telegramMarket?.status).toBe('ok');
  });
});

describe('место канала в шорт-листе (ревью 216, п.2)', () => {
  const channelOf = (index: number, extra: Partial<SupplierCandidate> = {}): SupplierCandidate => ({
    name: `Канал ${index}`,
    reference: `tg:suppliers/${index}`,
    prices: [PRICE],
    score: 1 - index / 100,
    ...extra,
  });

  test('канал занимает не больше N мест; остальные уходят в truncated', () => {
    const candidates = Array.from({ length: TELEGRAM_MAX_SHORTLIST_PLACES + 3 }, (_, i) =>
      channelOf(i),
    );
    const merged = mergeCandidates([source('telegram', candidates)], OPTIONS);
    expect(merged.entries).toHaveLength(TELEGRAM_MAX_SHORTLIST_PLACES);
    expect(merged.truncated).toBe(3);
  });

  test('поставщик базы, найденный и в канале, под предел не попадает', () => {
    const base: SupplierCandidate[] = Array.from({ length: 2 }, (_, i) => ({
      name: `Канал ${i}`,
      supplierId: `s${i}`,
      score: 1,
    }));
    const candidates = Array.from({ length: TELEGRAM_MAX_SHORTLIST_PLACES + 2 }, (_, i) =>
      channelOf(i),
    );
    const merged = mergeCandidates(
      [source('knowledge', base), source('telegram', candidates)],
      OPTIONS,
    );
    expect(merged.entries).toHaveLength(TELEGRAM_MAX_SHORTLIST_PLACES + 2);
    expect(merged.entries.filter((e) => e.sources.includes('knowledge'))).toHaveLength(2);
  });

  test('при нехватке мест канал забирает не больше N мест, остальные за базой', () => {
    const limit = 5;
    const base: SupplierCandidate[] = Array.from({ length: 3 }, (_, i) => ({
      name: `База ${i}`,
      supplierId: `s${i}`,
      prices: [PRICE],
      score: 0.5,
    }));
    const candidates = Array.from({ length: 6 }, (_, i) => channelOf(i, { score: 1 }));
    const merged = mergeCandidates(
      [source('knowledge', base), source('telegram', candidates)],
      { ...OPTIONS, limit },
    );
    const sourcesOf = merged.entries.map((e) => e.sources.join('+'));
    expect(sourcesOf).toHaveLength(limit);
    expect(sourcesOf.filter((s) => s === 'telegram')).toHaveLength(TELEGRAM_MAX_SHORTLIST_PLACES);
    expect(sourcesOf.filter((s) => s === 'knowledge')).toHaveLength(
      limit - TELEGRAM_MAX_SHORTLIST_PLACES,
    );
  });

  test('цена без проверки (приблизительная) не даёт кандидату канала ярус базы', () => {
    const merged = mergeCandidates(
      [source('telegram', [channelOf(1, { prices: [{ ...PRICE, approximate: true }] })])],
      OPTIONS,
    );
    const [entry] = merged.entries;
    expect(entry === undefined ? 0 : shortlistTierOf(entry)).toBe(2);
  });
});
