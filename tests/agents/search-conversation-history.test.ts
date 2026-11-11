import { describe, expect, test } from 'bun:test';
import { MemoryConversationHistorySearch, MemoryThreadStore } from '@business-ai/adapters';
import { severityOf } from '@business-ai/adapters';
import {
  HISTORY_SEARCH_DONE_EVENT,
  HISTORY_SEARCH_FAILED_EVENT,
  SEARCH_CONVERSATION_HISTORY_TOOL,
  createToolContext,
  searchConversationHistory,
  type ConversationHistoryHost,
} from '@business-ai/core';
import { HISTORY_SEARCH_PROMPT } from '../../src/agents/shared/legacy-prompts.owned';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { DAY_MS } from '../../src/kit/domain/time';
import type { ConversationHistorySearch, ThreadMessage } from '@business-ai/core';

const THREAD = 'bot-1/user-1';
const OTHER_THREAD = 'bot-1/user-2';
const DEAL = '4711';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const SMALL_CHAR_LIMIT = 120;
const LONG_TEXT_LENGTH = 500;

/** Подвижные часы: ими пользуются и хранилище (моменты реплик), и инструмент (период). */
class Clock {
  constructor(public ms: number) {}
  now = (): Date => new Date(this.ms);
}

function ctxOf(threadId: string): ReturnType<typeof createToolContext> {
  return createToolContext({ threadId, agentId: 'documents', operationId: 'op-1' });
}

async function saveMessages(
  store: MemoryThreadStore,
  threadId: string,
  messages: ThreadMessage[],
): Promise<void> {
  await store.save({
    state: { threadId, agentId: 'documents', status: 'completed', messages },
    spec: { id: 'documents', prompt: 'p', model: 'm', tools: [] },
  });
}

/** Реплика в ответе инструмента. */
interface OutMessage {
  role: string;
  at: string;
  text: string;
}

/** Фрагмент в ответе инструмента. */
interface OutFragment {
  message: OutMessage;
  before: OutMessage[];
  after: OutMessage[];
}

/** Ответ инструмента. */
interface Out {
  found: number;
  truncated: boolean;
  fragments: OutFragment[];
}

interface Setup {
  clock: Clock;
  store: MemoryThreadStore;
  deps: ConversationHistoryHost;
  events: Array<{ event: string; fields: Record<string, string | number | boolean> }>;
}

function setup(limits?: { maxResults: number; maxChars: number }): Setup {
  const clock = new Clock(T0);
  const store = new MemoryThreadStore(() => clock.ms);
  const events: Setup['events'] = [];
  const deps: ConversationHistoryHost = {
    conversationHistory: new MemoryConversationHistorySearch(store),
    clock,
    historySearchLog: (event, fields) => events.push({ event, fields: fields ?? {} }),
    ...(limits === undefined ? {} : { historySearchLimits: limits }),
  };
  return { clock, store, deps, events };
}

describe('searchConversationHistory: вход', () => {
  const parse = (input: unknown): boolean =>
    searchConversationHistory.inputSchema.safeParse(input).success;

  test('пустой запрос, лишний период и неверный limit отклоняются', () => {
    expect(parse({ query: '   ' })).toBe(false);
    expect(parse({ query: 'сделка', sinceDaysAgo: 1, untilDaysAgo: 5 })).toBe(false);
    expect(parse({ query: 'сделка', limit: 0 })).toBe(false);
    expect(parse({ query: 'сделка', sinceDaysAgo: -1 })).toBe(false);
    expect(parse({ query: 'сделка', sinceDaysAgo: 1.5 })).toBe(false);
  });

  test('запрос без периода и запрос с периодом допустимы', () => {
    expect(parse({ query: 'сделка' })).toBe(true);
    expect(parse({ query: 'сделка', sinceDaysAgo: 5, untilDaysAgo: 1, limit: 3 })).toBe(true);
  });

  test('тред в схеме входа не задаётся моделью', () => {
    const parsed = searchConversationHistory.inputSchema.safeParse({
      query: 'сделка',
      threadId: OTHER_THREAD,
    });
    expect(parsed.success && 'threadId' in (parsed.data as object)).toBe(false);
  });
});

describe('searchConversationHistory: выполнение', () => {
  test('находит реплику с соседними, датой и ролью', async () => {
    const { store, deps } = setup();
    await saveMessages(store, THREAD, [
      { role: 'user', text: 'Привет' },
      { role: 'user', text: `Сделка ${DEAL} на арматуру` },
      { role: 'agent', text: 'Принял, готовлю КП' },
    ]);
    const out = await searchConversationHistory.execute({ query: DEAL }, deps, ctxOf(THREAD));
    const result = out as Out;
    expect(result.found).toBe(1);
    const [fragment] = result.fragments;
    expect(fragment?.message.text).toContain(DEAL);
    expect(fragment?.message.role).toBe('user');
    expect(fragment?.message.at).toBe(new Date(T0).toISOString());
    expect(fragment?.before).toHaveLength(1);
    expect(fragment?.after).toHaveLength(1);
  });

  test('скоуп по треду из контекста: чужой тред и threadId во вводе не помогают', async () => {
    const { store, deps } = setup();
    await saveMessages(store, OTHER_THREAD, [{ role: 'user', text: `Сделка ${DEAL}` }]);
    await saveMessages(store, THREAD, [{ role: 'user', text: 'Другое дело' }]);
    const out = await searchConversationHistory.execute(
      { query: DEAL, threadId: OTHER_THREAD },
      deps,
      ctxOf(THREAD),
    );
    expect((out as { found: number }).found).toBe(0);
    // Тот же запрос из контекста чужой связки находит.
    const own = await searchConversationHistory.execute(
      { query: DEAL },
      deps,
      ctxOf(OTHER_THREAD),
    );
    expect((own as { found: number }).found).toBe(1);
  });

  test('пустой результат: found 0, фрагментов нет', async () => {
    const { store, deps } = setup();
    await saveMessages(store, THREAD, [{ role: 'user', text: 'Привет' }]);
    const out = await searchConversationHistory.execute(
      { query: 'несуществующее' },
      deps,
      ctxOf(THREAD),
    );
    expect(out).toMatchObject({ found: 0, fragments: [], truncated: false });
  });

  test('период в сутках назад: давняя реплика не попадает в недавний период', async () => {
    const { clock, store, deps } = setup();
    await saveMessages(store, THREAD, [{ role: 'user', text: `Сделка ${DEAL} старая` }]);
    clock.ms = T0 + 3 * DAY_MS;
    await saveMessages(store, THREAD, [
      { role: 'user', text: `Сделка ${DEAL} старая` },
      { role: 'user', text: `Сделка ${DEAL} свежая` },
    ]);
    const recent = await searchConversationHistory.execute(
      { query: DEAL, sinceDaysAgo: 1 },
      deps,
      ctxOf(THREAD),
    );
    const texts = (recent as { fragments: Array<{ message: { text: string } }> }).fragments.map(
      (f) => f.message.text,
    );
    expect(texts).toEqual([`Сделка ${DEAL} свежая`]);
    const old = await searchConversationHistory.execute(
      { query: DEAL, sinceDaysAgo: 10, untilDaysAgo: 2 },
      deps,
      ctxOf(THREAD),
    );
    expect((old as { found: number }).found).toBe(1);
  });

  test('предел символов: тексты обрезаются, truncated = true', async () => {
    const { store, deps } = setup({ maxResults: 5, maxChars: SMALL_CHAR_LIMIT });
    const long = `${DEAL} ${'ы'.repeat(LONG_TEXT_LENGTH)}`;
    await saveMessages(store, THREAD, [
      { role: 'user', text: long },
      { role: 'agent', text: long },
      { role: 'user', text: `${DEAL} ещё` },
    ]);
    const out = (await searchConversationHistory.execute(
      { query: DEAL },
      deps,
      ctxOf(THREAD),
    )) as Out;
    const total = out.fragments.reduce(
      (sum, f) =>
        sum +
        f.message.text.length +
        f.before.reduce((s, m) => s + m.text.length, 0) +
        f.after.reduce((s, m) => s + m.text.length, 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(SMALL_CHAR_LIMIT);
    expect(out.truncated).toBe(true);
  });

  test('предел числа фрагментов', async () => {
    const { store, deps } = setup({ maxResults: 2, maxChars: 10_000 });
    const messages: ThreadMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: 'user' as const,
      text: `Сделка ${DEAL} номер ${i}`,
    }));
    await saveMessages(store, THREAD, messages);
    const out = (await searchConversationHistory.execute(
      { query: DEAL, limit: 20 },
      deps,
      ctxOf(THREAD),
    )) as { fragments: unknown[] };
    expect(out.fragments).toHaveLength(2);
  });

  test('без подключённого поиска: not_configured', async () => {
    await expect(
      searchConversationHistory.execute({ query: DEAL }, {}, ctxOf(THREAD)),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('searchConversationHistory: журнал', () => {
  const SECRET_QUERY = 'секретныйзапрос9981';
  const SECRET_TEXT = 'Иванов Иван паспорт 4500 123456';

  test('в событии только счётчики: ни запроса, ни текста реплик', async () => {
    const { store, deps, events } = setup();
    await saveMessages(store, THREAD, [{ role: 'user', text: `${SECRET_QUERY} ${SECRET_TEXT}` }]);
    await searchConversationHistory.execute({ query: SECRET_QUERY }, deps, ctxOf(THREAD));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe(HISTORY_SEARCH_DONE_EVENT);
    expect(events[0]?.fields).toMatchObject({ found: 1, returned: 1 });
    expect(typeof events[0]?.fields['duration_ms']).toBe('number');
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(SECRET_QUERY);
    expect(dump).not.toContain('Иванов');
    expect(dump).not.toContain('4500');
  });

  test('сбой поиска: событие с кодом, без текста запроса', async () => {
    const failing: ConversationHistorySearch = {
      search: () => Promise.reject(new Error(`упало на ${SECRET_QUERY}`)),
    };
    const events: Setup['events'] = [];
    const deps: ConversationHistoryHost = {
      conversationHistory: failing,
      historySearchLog: (event, fields) => events.push({ event, fields: fields ?? {} }),
    };
    await expect(
      searchConversationHistory.execute({ query: SECRET_QUERY }, deps, ctxOf(THREAD)),
    ).rejects.toThrow();
    expect(events[0]?.event).toBe(HISTORY_SEARCH_FAILED_EVENT);
    expect(JSON.stringify(events)).not.toContain(SECRET_QUERY);
  });

  test('классы событий есть в таблице серьёзности', () => {
    expect(severityOf(HISTORY_SEARCH_DONE_EVENT)).toBe('info');
    expect(severityOf(HISTORY_SEARCH_FAILED_EVENT)).toBe('warning');
  });
});

describe('searchConversationHistory: подключение к агентам', () => {
  const agents = [
    createPricesAgent({ model: 'm' }),
    createDocumentsAgent({ model: 'm' }),
    createOrderCalcAgent({ model: 'm' }),
    createSiteExportAgent({ model: 'm' }),
  ];

  test('инструмент и подсказка в промпте есть у всех четырёх агентов', () => {
    for (const agent of agents) {
      expect(agent.tools.map((t) => t.name)).toContain(SEARCH_CONVERSATION_HISTORY_TOOL);
      expect(agent.prompt).toContain(HISTORY_SEARCH_PROMPT);
    }
    expect(HISTORY_SEARCH_PROMPT).toContain('источник важнее истории');
  });
});
