import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryModelGateway, MemoryPseudonymizer } from '@business-ai/adapters';
import { MemorySupplierRater } from '../../src/kit/adapters/memory/supplier-rater';
import { MemorySupplierRatingCache } from '../../src/kit/adapters/memory/supplier-rating-cache';
import { ModelSupplierRater } from '../../src/kit/adapters/litellm/supplier-model-rater';
import { PseudonymizingModelGateway } from '@business-ai/core';
import {
  SUPPLIER_RATING_MAX_MODEL_CALLS,
  hashSupplierRatingFacts,
  rateSupplierCards,
  type SupplierRatingHost,
} from '../../src/agents/order-calc/supplier-rating';
import { buildChoiceMessage } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers } from '../../src/agents/order-calc/search-sources';
import {
  buildSupplierRatingFacts,
  type SupplierRatingFacts,
} from '../../src/kit/domain/supplier-rating-facts';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import type { SupplierRater } from '../../src/kit/ports/supplier-rater';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const SHORT_TIMEOUT_MS = 20;
const GOOD_VERDICT = { score: 5, rationale: 'Надёжный действующий поставщик.' };

function card(id: string, patch: Partial<SupplierCard> = {}): SupplierCard {
  return {
    id,
    name: `Поставщик ${id}`,
    status: 'active',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...patch,
  };
}

interface Harness {
  host: SupplierRatingHost;
  cache: MemorySupplierRatingCache;
  logs: string[];
}

function harness(rater: SupplierRater | undefined, timeoutMs?: number): Harness {
  const cache = new MemorySupplierRatingCache();
  const logs: string[] = [];
  const host: SupplierRatingHost = {
    clock: new FixedClock(),
    log: (event) => {
      logs.push(event);
    },
    ...(rater === undefined ? {} : { supplierRating: { rater, cache, timeoutMs } }),
  };
  return { host, cache, logs };
}

describe('хэш фактов', () => {
  const facts = buildSupplierRatingFacts(card('s1', { strengths: 'Быстро' }));

  test('стабилен: тот же набор - тот же sha-256, не зависит от порядка ключей', () => {
    const hash = hashSupplierRatingFacts(facts);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSupplierRatingFacts({ ...facts })).toBe(hash);
    const reversed = Object.fromEntries(Object.entries(facts).reverse()) as SupplierRatingFacts;
    expect(hashSupplierRatingFacts(reversed)).toBe(hash);
  });

  test('пробелы в тексте карточки хэш не меняют, смысловая правка - меняет', () => {
    const spaced = buildSupplierRatingFacts(card('s1', { strengths: '  Быстро \n' }));
    expect(hashSupplierRatingFacts(spaced)).toBe(hashSupplierRatingFacts(facts));
    const changed = [
      card('s1', { strengths: 'Медленно' }),
      card('s1', { strengths: 'Быстро', defectRatePercent: 0 }),
      card('s1', { strengths: 'Быстро', status: 'inactive' }),
      card('s1', { strengths: 'Быстро', hasQualityControl: true }),
      card('s1', { strengths: 'Быстро', terms: { leadTime: '3 дня' } }),
    ];
    for (const next of changed) {
      expect(hashSupplierRatingFacts(buildSupplierRatingFacts(next))).not.toBe(
        hashSupplierRatingFacts(facts),
      );
    }
  });

  test('имя, контакты и заметки на хэш не влияют: оценке они не нужны', () => {
    const other = card('s1', {
      name: 'Другое имя',
      strengths: 'Быстро',
      notes: [{ text: 'заметка', authorId: 'u', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(hashSupplierRatingFacts(buildSupplierRatingFacts(other))).toBe(
      hashSupplierRatingFacts(facts),
    );
  });
});

describe('rateSupplierCards', () => {
  test('нет сигналов - оценка пустая без вызова модели и без обращения к кэшу', async () => {
    const rater = new MemorySupplierRater();
    const { host, cache } = harness(rater);
    const out = await rateSupplierCards(host, [card('s1', { status: 'new' })]);
    expect(out.get('s1')).toEqual({ value: null });
    expect(rater.calls).toBe(0);
    expect(cache.puts).toBe(0);
  });

  test('без оценщика - правило, источник «rule»', async () => {
    const { host } = harness(undefined);
    const out = await rateSupplierCards(host, [card('s1')]);
    expect(out.get('s1')).toEqual({ value: 4, source: 'rule' });
  });

  test('успех модели: оценка и обоснование, запись в кэше', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host, cache } = harness(rater);
    const subject = card('s1');
    const out = await rateSupplierCards(host, [subject]);
    expect(out.get('s1')).toEqual({ value: 5, source: 'model', rationale: GOOD_VERDICT.rationale });
    const hash = hashSupplierRatingFacts(buildSupplierRatingFacts(subject));
    expect(await cache.get('s1', hash)).toMatchObject({ score: 5, source: 'model' });
  });

  test('попадание в кэш - без вызова модели', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host } = harness(rater);
    await rateSupplierCards(host, [card('s1')]);
    const again = await rateSupplierCards(host, [card('s1')]);
    expect(rater.calls).toBe(1);
    expect(again.get('s1')).toMatchObject({ value: 5, source: 'model' });
  });

  test('смена фактов - новый вызов и новая запись', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host } = harness(rater);
    await rateSupplierCards(host, [card('s1')]);
    await rateSupplierCards(host, [card('s1', { weaknesses: 'срывает сроки' })]);
    expect(rater.calls).toBe(2);
  });

  test('сбой модели - правило, в кэш не пишется, повтор зовёт модель снова', async () => {
    let fail = true;
    const rater = new MemorySupplierRater(() => {
      if (fail) throw new Error('gateway down');
      return GOOD_VERDICT;
    });
    const { host, cache, logs } = harness(rater);
    const first = await rateSupplierCards(host, [card('s1')]);
    expect(first.get('s1')).toEqual({ value: 4, source: 'rule' });
    expect(cache.puts).toBe(0);
    expect(logs).toContain('supplier_rating_model_failed');
    fail = false;
    const second = await rateSupplierCards(host, [card('s1')]);
    expect(rater.calls).toBe(2);
    expect(second.get('s1')).toMatchObject({ value: 5, source: 'model' });
  });

  test('ответ вне схемы от нестрогого оценщика не принимается: правило', async () => {
    for (const verdict of [
      { score: 6, rationale: 'ок' },
      { score: 3.5, rationale: 'ок' },
      { score: 4, rationale: 'звоните +7 999 000-11-22' },
      { score: 4, rationale: '' },
    ]) {
      const { host, cache } = harness(new MemorySupplierRater(() => verdict));
      const out = await rateSupplierCards(host, [card('s1')]);
      expect(out.get('s1')).toEqual({ value: 4, source: 'rule' });
      expect(cache.puts).toBe(0);
    }
  });

  test('таймаут: запрос отменяется сигналом, берётся правило', async () => {
    let aborted = false;
    const hanging: SupplierRater = {
      rate: (_facts, options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const { host, cache, logs } = harness(hanging, SHORT_TIMEOUT_MS);
    const out = await rateSupplierCards(host, [card('s1')]);
    expect(out.get('s1')).toEqual({ value: 4, source: 'rule' });
    expect(aborted).toBe(true);
    expect(cache.puts).toBe(0);
    expect(logs).toContain('supplier_rating_model_failed');
  });

  test('оценщик, не реагирующий на сигнал, всё равно не подвешивает сборку', async () => {
    const stuck: SupplierRater = { rate: () => new Promise(() => undefined) };
    const { host } = harness(stuck, SHORT_TIMEOUT_MS);
    const out = await rateSupplierCards(host, [card('s1')]);
    expect(out.get('s1')).toEqual({ value: 4, source: 'rule' });
  });

  test('сбой чтения и записи кэша модель не ломает', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host, logs } = harness(rater);
    const broken = {
      get: async () => {
        throw new Error('db down');
      },
      put: async () => {
        throw new Error('db down');
      },
    };
    host.supplierRating = { rater, cache: broken };
    const out = await rateSupplierCards(host, [card('s1')]);
    expect(out.get('s1')).toMatchObject({ value: 5, source: 'model' });
    expect(logs).toContain('supplier_rating_cache_read_failed');
    expect(logs).toContain('supplier_rating_cache_write_failed');
  });

  test('лимит вызовов за сборку: первые по приоритету - модель, остальные - правило', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host, logs } = harness(rater);
    const total = SUPPLIER_RATING_MAX_MODEL_CALLS + 3;
    const cards = Array.from({ length: total }, (_, i) => card(`s${String(i).padStart(2, '0')}`));
    const out = await rateSupplierCards(host, cards);
    expect(rater.calls).toBe(SUPPLIER_RATING_MAX_MODEL_CALLS);
    const sources = cards.map((item) => out.get(item.id)?.source);
    const head = sources.slice(0, SUPPLIER_RATING_MAX_MODEL_CALLS);
    expect(head.every((source) => source === 'model')).toBe(true);
    expect(sources.slice(SUPPLIER_RATING_MAX_MODEL_CALLS)).toEqual(['rule', 'rule', 'rule']);
    expect(logs).toContain('supplier_rating_model_limit');
    // Следующая сборка добирает оставшиеся: первые десять берутся из кэша.
    await rateSupplierCards(host, cards);
    expect(rater.calls).toBe(total);
  });

  test('попадания кэша лимит не расходуют', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host } = harness(rater);
    const cached = Array.from({ length: SUPPLIER_RATING_MAX_MODEL_CALLS }, (_, i) =>
      card(`c${i}`),
    );
    await rateSupplierCards(host, cached);
    const fresh = card('zz');
    await rateSupplierCards(host, [...cached, fresh]);
    expect(rater.calls).toBe(SUPPLIER_RATING_MAX_MODEL_CALLS + 1);
  });

  test('повтор одной карточки в списке - один вызов', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host } = harness(rater);
    await rateSupplierCards(host, [card('s1'), card('s1')]);
    expect(rater.calls).toBe(1);
  });

  test('испорченная запись кэша (вне правил) не принимается', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host, cache } = harness(rater);
    const subject = card('s1');
    await cache.put({
      supplierId: 's1',
      factsHash: hashSupplierRatingFacts(buildSupplierRatingFacts(subject)),
      score: 5,
      rationale: 'звоните +7 999 000-11-22',
      source: 'model',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await rateSupplierCards(host, [subject]);
    expect(rater.calls).toBe(1);
  });

  test('запись источника «rule» в кэше не используется как оценка модели', async () => {
    const rater = new MemorySupplierRater(() => GOOD_VERDICT);
    const { host, cache } = harness(rater);
    const subject = card('s1');
    await cache.put({
      supplierId: 's1',
      factsHash: hashSupplierRatingFacts(buildSupplierRatingFacts(subject)),
      score: 4,
      rationale: 'По правилу.',
      source: 'rule',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await rateSupplierCards(host, [subject]);
    expect(rater.calls).toBe(1);
  });
});

describe('шлюз псевдонимизации', () => {
  test('ФИО и контакты карточки в запрос не попадают, email из текста маскируется', async () => {
    const inner = new MemoryModelGateway(() => JSON.stringify(GOOD_VERDICT));
    const gateway = new PseudonymizingModelGateway(inner, new MemoryPseudonymizer());
    const rater = new ModelSupplierRater(gateway, 'order-calc-alias');
    const { host } = harness(rater);
    const subject = card('s1', {
      inn: '7707083893',
      contacts: [
        {
          fullName: 'Петров Пётр Петрович',
          email: 'sales@metall.test',
          phone: '+79990001122',
          isPrimary: true,
        },
      ],
      strengths: 'Пишите менеджеру ivan.petrov@example.com или 8 (495) 123-45-67',
    });
    const out = await rateSupplierCards(host, [subject]);
    expect(out.get('s1')).toMatchObject({ value: 5, source: 'model' });
    const sent = JSON.stringify(inner.requests);
    for (const secret of [
      'Петров',
      'sales@metall',
      '79990001122',
      '7707083893',
      'ivan.petrov@example.com',
      '495',
    ]) {
      expect(sent).not.toContain(secret);
    }
    expect(sent).toContain('[EMAIL_1]');
  });
});

describe('рейтинг в шорт-листе', () => {
  let deps: OrderTestDeps;
  let rater: MemorySupplierRater;

  beforeEach(async () => {
    deps = await buildOrderDeps();
    rater = new MemorySupplierRater(() => GOOD_VERDICT);
    deps.supplierRating = { rater, cache: new MemorySupplierRatingCache() };
    await deps.suppliers.saveCard(
      card('s1', { name: 'МеталлТорг', defectRatePercent: 2, strengths: 'Быстро' }),
    );
  });

  async function build(): Promise<string> {
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await buildShortlist.execute(input, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    if (proposal === null) throw new Error('шорт-лист не сохранён');
    return buildChoiceMessage(proposal).text;
  }

  test('оценка модели с обоснованием и пометкой; без сигналов рейтинг - «нет данных»', async () => {
    const text = await build();
    expect(text).toContain(`Рейтинг: 5 из 5 (оценка модели): ${GOOD_VERDICT.rationale}`);
    // Этап 118: строка рейтинга есть у всех, без оценки - «нет данных».
    expect(text).not.toContain('нет оценки');
    expect(text).toContain('Рейтинг: нет данных');
    // Поставщик без карточки/сигналов модели не стоил ни одного вызова.
    expect(rater.calls).toBe(1);
  });

  test('вторая сборка берёт оценку из кэша: модель не зовётся', async () => {
    await build();
    const text = await build();
    expect(rater.calls).toBe(1);
    expect(text).toContain('(оценка модели)');
  });

  test('сбой модели: шорт-лист собран, рейтинг по правилу с пометкой', async () => {
    deps.supplierRating = {
      rater: new MemorySupplierRater(() => {
        throw new Error('gateway down');
      }),
      cache: new MemorySupplierRatingCache(),
    };
    const text = await build();
    expect(text).toContain('Рейтинг: 4,5 из 5 (по правилу)');
    expect(text).not.toContain('оценка модели');
  });

  test('без оценщика в зависимостях - только правило', async () => {
    deps.supplierRating = undefined;
    const text = await build();
    expect(text).toContain('Рейтинг: 4,5 из 5 (по правилу)');
  });

  test('результат инструмента для модели обоснование не содержит', async () => {
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(JSON.stringify(out)).not.toContain(GOOD_VERDICT.rationale);
  });
});
