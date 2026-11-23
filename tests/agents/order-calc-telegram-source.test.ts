import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryPriceRelevanceChecker } from '../../src/kit/adapters/memory/price-relevance';
import {
  MemoryTelegramChannelSource,
  MemoryTelegramPostExtractor,
} from '../../src/kit/adapters/memory/telegram-channel-source';
import { ModelTelegramPostExtractor } from '../../src/kit/adapters/litellm/telegram-post-extractor';
import {
  TELEGRAM_SEARCH_PARTIAL_REASON,
  TELEGRAM_SOURCE_BUDGET_REASON,
  TelegramPostCache,
} from '../../src/agents/order-calc/telegram-source';
import { buildChoiceMessage } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal, loadSourceResult } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { DomainError } from '@business-ai/core';
import {
  TELEGRAM_QUERY_MAX_CHARS,
  TELEGRAM_SOURCE_MARK,
} from '../../src/kit/domain/telegram-source';
import { type PurchaseRequest } from '../../src/kit/domain/models';
import type { ModelGateway, ModelRequest } from '@business-ai/core';
import type { PriceRelevanceInput } from '../../src/kit/ports/price-relevance';
import type { TelegramPost } from '../../src/kit/ports/telegram-channel-source';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Этап 216: закрытый Telegram-канал - отдельный источник шорт-листа (флаг выключен по умолчанию). */

const POST_TEXT =
  'Канальный металл, Пермь. Арматура 12 мм - 55 руб/м, срок 3 дня. ' +
  'Заказы: +7 912 345-67-89, zakaz@kanal.test';
const POSTS: TelegramPost[] = [
  { channel: 'suppliers', messageId: 101, date: '2026-11-01T10:00:00.000Z', text: POST_TEXT },
  {
    channel: 'suppliers',
    messageId: 102,
    date: '2026-11-02T10:00:00.000Z',
    text: 'Арматура и сетка оптом, цену уточняйте',
  },
];

/** Ответ модели по посту: название, город, цена; контакты модель не возвращает. */
function answer(post: { text: string }): unknown {
  if (post.text.startsWith('Канальный')) {
    return {
      name: 'Канальный металл',
      city: 'Пермь',
      leadTime: '3 дня',
      prices: [{ item: 'Арматура', amount: 55, currency: 'RUB', unit: 'м' }],
    };
  }
  return { name: '' };
}

interface Setup {
  deps: OrderTestDeps;
  source: MemoryTelegramChannelSource;
  extractor: MemoryTelegramPostExtractor;
  logs: Array<[string, Record<string, unknown> | undefined]>;
}

let setup: Setup;

async function enable(posts: TelegramPost[] = POSTS, maxPosts = 5): Promise<Setup> {
  const deps = await buildOrderDeps();
  const logs: Setup['logs'] = [];
  deps.log = (event, fields) => logs.push([event, fields]);
  const source = new MemoryTelegramChannelSource(posts);
  const extractor = new MemoryTelegramPostExtractor(answer);
  deps.telegramChannel = { source, extractor, maxPosts };
  return { deps, source, extractor, logs };
}

beforeEach(async () => {
  setup = await enable();
});

/** Проверка цен в памяти: оценка каждого названия задаётся функцией. */
function checker(
  gradeOf: (name: string) => 'exact' | 'analog' | 'wrong',
): MemoryPriceRelevanceChecker {
  return new MemoryPriceRelevanceChecker((input: PriceRelevanceInput) => ({
    results: input.items.map((item) => ({
      item: item.item,
      grades: item.names.map((name) => ({ key: name.key, grade: gradeOf(name.name) })),
    })),
  }));
}

/** Три поста трёх поставщиков с ценой на «Арматуру»; цена и товар задаются по номеру поста. */
function pricedPosts(amounts: readonly number[]): TelegramPost[] {
  return amounts.map((_, index) => ({
    channel: 'suppliers',
    messageId: 200 + index,
    date: '2026-11-03T10:00:00.000Z',
    text: `Поставщик ${index + 1}. Арматура, цена в посте`,
  }));
}

function priceAnswer(amounts: readonly number[], extra: Record<string, unknown> = {}) {
  return (post: { text: string }): unknown => {
    const index = Number(/Поставщик (\d)/u.exec(post.text)?.[1] ?? '1') - 1;
    return {
      name: `Поставщик ${index + 1}`,
      prices: [
        {
          item: 'Арматура',
          amount: amounts[index] ?? 1,
          currency: 'RUB',
          unit: 'м',
          offer: 'Арматура А500 12 мм',
          ...extra,
        },
      ],
    };
  };
}

describe('флаг выключен: поведение прежнее', () => {
  test('без telegramChannel запись источника не создаётся, статусов telegram нет', async () => {
    const deps = await buildOrderDeps();
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toBeNull();
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    expect(proposal?.sources.map((item) => item.source)).toEqual(['knowledge', 'web']);
    expect(out.unavailableSources.map((item) => item.source)).not.toContain('telegram');
    expect(proposal?.entries.some((entry) => entry.sources.includes('telegram'))).toBe(false);
  });
});

describe('флаг выключили после поиска (ревью 216, п.11)', () => {
  test('старая запись telegram в новую сборку не берётся; включили снова - читается', async () => {
    const { deps } = setup;
    const channel = deps.telegramChannel;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).not.toBeNull();
    deps.telegramChannel = undefined;
    const off = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const offProposal = await loadProposal(deps, REQUEST_ID);
    expect(off.entries.some((entry) => entry.sources.includes('telegram'))).toBe(false);
    expect(offProposal?.sources.map((item) => item.source)).not.toContain('telegram');
    deps.telegramChannel = channel;
    const on = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(on.entries.some((entry) => entry.sources.includes('telegram'))).toBe(true);
  });
});

describe('searchKnowledgeSuppliers: источник telegram', () => {
  test('кандидат из поста: название и сведения от модели, контакты берёт код', async () => {
    const { deps, source } = setup;
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    // Ответ агенту и источник «база знаний» от канала не зависят.
    expect(out.source).toBe('knowledge');
    expect(source.queries).toEqual(['Арматура']);
    const stored = await loadSourceResult(deps, REQUEST_ID, 'telegram');
    expect(stored?.status).toBe('ok');
    expect(stored?.candidates).toHaveLength(1);
    const [candidate] = stored?.candidates ?? [];
    expect(candidate).toMatchObject({
      name: 'Канальный металл',
      city: 'Пермь',
      leadTime: '3 дня',
      reference: 'tg:suppliers/101',
      email: 'zakaz@kanal.test',
    });
    expect(candidate?.contacts).toContain('+7 912 345-67-89');
    expect(candidate?.contacts).toContain('zakaz@kanal.test');
    expect(candidate?.prices?.[0]).toMatchObject({ item: 'Арматура', amount: 55, currency: 'RUB' });
    expect(candidate?.telegramFields).toEqual(['city', 'contacts', 'email', 'leadTime', 'prices']);
  });

  test('контакты из ответа модели не принимаются: телефон и почту берёт код из поста', async () => {
    const { deps, extractor } = setup;
    extractor.replace(() => ({
      name: 'Канальный металл',
      phone: '+7 000 000-00-00',
      email: 'fake@model.test',
    }));
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const stored = await loadSourceResult(deps, REQUEST_ID, 'telegram');
    const candidate = stored?.candidates.find((item) => item.reference === 'tg:suppliers/101');
    expect(candidate?.contacts).toContain('+7 912 345-67-89');
    expect(candidate?.contacts).not.toContain('000');
    expect(candidate?.email).toBe('zakaz@kanal.test');
  });

  test('пост без названия отбрасывается, в журнале только числа', async () => {
    const { deps, logs } = setup;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const event = logs.find(([name]) => name === 'telegram_source');
    expect(event?.[1]).toMatchObject({ posts: 2, candidates: 1, dropped: 1, failed: 0 });
    expect(JSON.stringify(logs)).not.toContain('Канальный');
    expect(JSON.stringify(logs)).not.toContain('zakaz');
  });

  test('предел постов: источнику передаётся maxPosts, лишнее не читается', async () => {
    const { deps, source, extractor } = await enable(POSTS, 1);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(source.limits).toEqual([1]);
    expect(extractor.seen).toHaveLength(1);
  });

  test('сузили поиск разделом или поставщиком: канал не опрашивается', async () => {
    const { deps, source } = setup;
    await searchKnowledgeSuppliers.execute(
      { requestId: REQUEST_ID, section: 'suppliers' },
      deps,
      CTX,
    );
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID, supplierId: 's1' }, deps, CTX);
    expect(source.queries).toEqual([]);
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toBeNull();
  });

  test('запрос с ПДн во внешний канал не уходит: источник недоступен, остальные целы', async () => {
    const request: PurchaseRequest = {
      id: 'req-pii',
      dealRef: 'D-2',
      items: [{ name: 'Арматура +7 912 345-67-89', quantity: 1, unit: 'м' }],
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    await setup.deps.requests.save(request);
    const out = await searchKnowledgeSuppliers.execute({ requestId: 'req-pii' }, setup.deps, CTX);
    expect(out.status).toBe('ok');
    expect(setup.source.queries).toEqual([]);
    const stored = await loadSourceResult(setup.deps, 'req-pii', 'telegram');
    expect(stored).toMatchObject({ status: 'unavailable', reason: 'validation_failed' });
  });
});

describe('сбой источника не ломает остальные', () => {
  test('канал недоступен: knowledge ok, telegram unavailable, шорт-лист собирается', async () => {
    const { deps, source } = setup;
    source.failWith(new DomainError('external_failure', 'канал недоступен'));
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    expect(out.found).toBeGreaterThan(0);
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toMatchObject({
      status: 'unavailable',
      reason: 'external_failure',
      candidates: [],
    });
    const built = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(built.empty).toBe(false);
    expect(built.unavailableSources).toContainEqual({
      source: 'telegram',
      status: 'unavailable',
      reason: 'external_failure',
    });
    const proposal = await loadProposal(deps, REQUEST_ID);
    if (proposal === null) throw new Error('нет шорт-листа');
    expect(buildChoiceMessage(proposal).text).toContain(
      `Источник «${TELEGRAM_SOURCE_MARK}» недоступен.`,
    );
  });

  test('модель не разобрала ни один пост: источник ok с кодом причины, база цела', async () => {
    const { deps, extractor } = setup;
    extractor.replace(() => {
      throw new Error('модель недоступна');
    });
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toMatchObject({
      status: 'ok',
      reason: TELEGRAM_SEARCH_PARTIAL_REASON,
      candidates: [],
    });
  });

  test('сбой сохранения записи канала не мешает ответу по базе', async () => {
    const { deps } = setup;
    const original = deps.state.put.bind(deps.state);
    deps.state.put = async (namespace, key, value, ...rest) => {
      if (key.endsWith(':telegram')) throw new Error('state down');
      return original(namespace, key, value, ...rest);
    };
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
  });
});

describe('шорт-лист с каналом', () => {
  test('кандидат канала в списке, с подписью источника и пометкой полей', async () => {
    const { deps } = setup;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const built = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const entry = built.entries.find((item) => item.sources.includes('telegram'));
    expect(entry?.sources).toEqual(['telegram']);
    expect(entry?.hasPrice).toBe(true);
    const proposal = await loadProposal(deps, REQUEST_ID);
    if (proposal === null) throw new Error('нет шорт-листа');
    expect(proposal.sources.map((item) => item.source)).toEqual(['knowledge', 'web', 'telegram']);
    const lines = buildChoiceMessage(proposal).text.split('\n');
    const at = lines.findIndex((line) => line.includes('Поставщик: Канальный металл'));
    expect(lines[at]).toContain(`(${TELEGRAM_SOURCE_MARK})`);
    expect(lines.slice(at, at + 7).join('\n')).toContain(
      `Город: Пермь (${TELEGRAM_SOURCE_MARK})`,
    );
    expect(lines.slice(at, at + 7).join('\n')).not.toContain('ИЗ ИНТЕРНЕТА');
  });

  test('цена канала ранжируется как цена базы: кандидат канала выше веб-кандидатов', async () => {
    const { deps } = setup;
    // Цена канала идёт наравне с базой только после проверки соответствия товара (ревью 216).
    deps.priceRelevance = checker(() => 'exact');
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const built = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const order = built.entries.map((item) => item.sources.join('+'));
    const telegramAt = order.indexOf('telegram');
    const firstWeb = order.findIndex((sources) => sources === 'web');
    expect(telegramAt).toBeGreaterThanOrEqual(0);
    if (firstWeb >= 0) expect(telegramAt).toBeLessThan(firstWeb);
  });
});

describe('ПДн: текст поста перед моделью', () => {
  test('настоящий экстрактор: модели уходит очищенный текст, контакты в кандидате - от кода', async () => {
    const { deps } = setup;
    const seen: ModelRequest[] = [];
    const gateway: ModelGateway = {
      async complete(request) {
        seen.push(request);
        return {
          model: request.model,
          content: '{"name":"Канальный металл","city":"Пермь"}',
          stopReason: 'end_turn',
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('не используется');
      },
    };
    deps.telegramChannel = {
      source: new MemoryTelegramChannelSource([POSTS[0]!]),
      extractor: new ModelTelegramPostExtractor(gateway, 'm'),
      maxPosts: 5,
    };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const body = seen
      .map((request) => request.messages.map((message) => message.content).join('\n'))
      .join('\n');
    expect(body).not.toContain('912 345-67-89');
    expect(body).not.toContain('zakaz@kanal.test');
    expect(body).toContain('Арматура 12 мм - 55 руб/м');
    const [candidate] = (await loadSourceResult(deps, REQUEST_ID, 'telegram'))?.candidates ?? [];
    expect(candidate?.contacts).toContain('+7 912 345-67-89');
  });
});


describe('проверка цен канала (ревью 216, п.1-2)', () => {
  async function run(
    amounts: readonly number[],
    options: { check?: MemoryPriceRelevanceChecker; extra?: Record<string, unknown> } = {},
  ) {
    const ready = await enable(pricedPosts(amounts), 10);
    ready.extractor.replace(priceAnswer(amounts, options.extra));
    if (options.check !== undefined) ready.deps.priceRelevance = options.check;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, ready.deps, CTX);
    const stored = await loadSourceResult(ready.deps, REQUEST_ID, 'telegram');
    return { ready, candidates: stored?.candidates ?? [] };
  }

  test('цена проверена как «тот же товар»: без «приблизительной», с признаком канала', async () => {
    const { candidates, ready } = await run([50], { check: checker(() => 'exact') });
    const price = candidates[0]?.prices?.[0];
    expect(price).toMatchObject({ item: 'Арматура', amount: 50, fromTelegram: true });
    expect(price?.approximate).toBeUndefined();
    // Модель проверки видит позицию и название товара из поста, без поставщика и цены.
    const sent = JSON.stringify(
      (ready.deps.priceRelevance as MemoryPriceRelevanceChecker).seen,
    );
    expect(sent).toContain('Арматура А500 12 мм');
    expect(sent).not.toContain('Поставщик 1');
  });

  test('нет проверяющего: цена не проверена - приблизительная, в ярус базы не идёт', async () => {
    const { candidates } = await run([50]);
    expect(candidates[0]?.prices?.[0]).toMatchObject({ approximate: true, fromTelegram: true });
  });

  test('сбой проверки: цена остаётся, но как непроверенная (приблизительная)', async () => {
    const failing = new MemoryPriceRelevanceChecker(() => {
      throw new Error('модель недоступна');
    });
    const { candidates } = await run([50], { check: failing });
    expect(candidates[0]?.prices?.[0]).toMatchObject({ approximate: true });
  });

  test('«не тот товар» - цена убрана, кандидат остаётся без цены', async () => {
    const { candidates } = await run([50], { check: checker(() => 'wrong') });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.prices).toBeUndefined();
    expect(candidates[0]?.telegramFields ?? []).not.toContain('prices');
  });

  test('«похожий товар» - приблизительная с пометкой similar', async () => {
    const { candidates } = await run([50], { check: checker(() => 'analog') });
    expect(candidates[0]?.prices?.[0]).toMatchObject({ approximate: true, similar: true });
  });

  test('exact=false из разбора поста остаётся приблизительной при ответе exact', async () => {
    const { candidates } = await run([50], {
      check: checker(() => 'exact'),
      extra: { exact: false },
    });
    expect(candidates[0]?.prices?.[0]).toMatchObject({ approximate: true });
  });

  test('выбросы по медиане отсекаются: цена 5000 при 50 и 55 не проходит', async () => {
    const { candidates } = await run([50, 55, 5000], { check: checker(() => 'exact') });
    const amounts = candidates.flatMap((candidate) => candidate.prices ?? []).map((p) => p.amount);
    expect(amounts.sort((a, b) => a - b)).toEqual([50, 55]);
    const third = candidates.find((candidate) => candidate.name === 'Поставщик 3');
    expect(third?.prices).toBeUndefined();
  });
});

describe('бюджет времени и кэш разбора постов (ревью 216, п.6)', () => {
  const NEVER = new Promise<never>(() => {});

  test('источник не отвечает дольше бюджета: telegram недоступен, база отвечает', async () => {
    const { deps, source } = await enable();
    source.search = async () => NEVER;
    deps.telegramChannel = { ...deps.telegramChannel!, source, budgetMs: 30 };
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toMatchObject({
      status: 'unavailable',
      reason: TELEGRAM_SOURCE_BUDGET_REASON,
    });
  });

  test('зависший разбор поста тоже упирается в общий бюджет', async () => {
    const { deps, extractor } = await enable();
    extractor.replace(() => NEVER);
    deps.telegramChannel = { ...deps.telegramChannel!, budgetMs: 30 };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toMatchObject({
      status: 'unavailable',
      reason: TELEGRAM_SOURCE_BUDGET_REASON,
    });
  });

  test('отмена хода - не «бюджет»: запись канала не пишется', async () => {
    const { deps, source } = await enable();
    const controller = new AbortController();
    source.search = async () => {
      controller.abort(new Error('отмена'));
      return NEVER;
    };
    deps.telegramChannel = { ...deps.telegramChannel!, source, budgetMs: 5_000 };
    await searchKnowledgeSuppliers
      .execute({ requestId: REQUEST_ID }, deps, { ...CTX, signal: controller.signal })
      .catch(() => undefined);
    expect(await loadSourceResult(deps, REQUEST_ID, 'telegram')).toBeNull();
  });

  test('пост, уже разобранный в этом процессе, второй раз модели не отдаётся', async () => {
    const { deps, extractor } = await enable();
    let now = 1_000;
    deps.telegramChannel = {
      ...deps.telegramChannel!,
      cache: new TelegramPostCache({ ttlMs: 60_000, now: () => now }),
    };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const first = extractor.seen.length;
    expect(first).toBe(2);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(extractor.seen.length).toBe(first);
    // Результат тот же, что при разборе моделью.
    const stored = await loadSourceResult(deps, REQUEST_ID, 'telegram');
    expect(stored?.candidates.map((candidate) => candidate.name)).toEqual(['Канальный металл']);
    // По истечении срока пост разбирается заново.
    now += 60_001;
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(extractor.seen.length).toBe(first * 2);
  });

  test('другие позиции заявки - другой разбор: ключ кэша включает позиции', async () => {
    const { deps, extractor } = await enable();
    deps.telegramChannel = { ...deps.telegramChannel!, cache: new TelegramPostCache() };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const before = extractor.seen.length;
    await deps.requests.save({
      id: 'req-2',
      dealRef: 'D-2',
      items: [{ name: 'Арматура и сетка', quantity: 1, unit: 'м' }],
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    await searchKnowledgeSuppliers.execute({ requestId: 'req-2' }, deps, CTX);
    expect(extractor.seen.length).toBeGreaterThan(before);
  });

  test('сбой разбора в кэш не кладётся', async () => {
    const { deps, extractor } = await enable();
    deps.telegramChannel = { ...deps.telegramChannel!, cache: new TelegramPostCache() };
    extractor.replace(() => {
      throw new Error('сбой');
    });
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const failed = extractor.seen.length;
    extractor.replace(answer);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(extractor.seen.length).toBeGreaterThan(failed);
  });
});

describe('запрос к каналу и название-ИП (ревью 216, п.9-10)', () => {
  test('запрос длиннее предела сервиса чтения в канал не уходит', async () => {
    const { deps, source } = await enable();
    const long = `Арматура ${'а'.repeat(250)}`;
    await deps.requests.save({
      id: 'req-long',
      dealRef: 'D-3',
      items: [
        { name: long, quantity: 1, unit: 'м' },
        { name: 'Сетка', quantity: 1, unit: 'м' },
      ],
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    await searchKnowledgeSuppliers.execute({ requestId: 'req-long' }, deps, CTX);
    for (const query of source.queries) {
      expect(query.length).toBeLessThanOrEqual(TELEGRAM_QUERY_MAX_CHARS);
    }
    expect(source.queries).toContain('Сетка');
  });

  test('«ИП Фамилия И.О.» - валидное название, ФИО модель не видела', async () => {
    const text = 'ИП Иванов И.О., Пермь. Арматура 12 мм - 55 руб/м';
    const ready = await enable([
      { channel: 'suppliers', messageId: 301, date: '2026-11-03T10:00:00.000Z', text },
    ]);
    const seen: ModelRequest[] = [];
    const gateway: ModelGateway = {
      async complete(request) {
        seen.push(request);
        return {
          model: request.model,
          content: '{"name":"ИП [ФИО]","city":"Пермь"}',
          stopReason: 'end_turn',
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('не используется');
      },
    };
    ready.deps.telegramChannel = {
      ...ready.deps.telegramChannel!,
      extractor: new ModelTelegramPostExtractor(gateway, 'm'),
    };
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, ready.deps, CTX);
    const body = seen.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n');
    expect(body).not.toContain('Иванов');
    expect(body).toContain('ИП [ФИО]');
    const stored = await loadSourceResult(ready.deps, REQUEST_ID, 'telegram');
    const [candidate] = stored?.candidates ?? [];
    expect(candidate?.name).toBe('ИП Иванов И.О.');
  });
});
