import { describe, expect, test } from 'bun:test';
import {
  AnthropicWebSearch,
  MemoryAuditRepository,
  MemoryModelGateway,
  MemoryWebSearch,
  type FetchFn,
  type ModelResponder,
} from '@business-ai/adapters';
import {
  PseudonymizingModelGateway,
  WEB_SEARCH_AUDIT_ACTION,
  createToolContext,
  searchInternet,
  type WebSearchHost,
} from '@business-ai/core';
import { searchWeb } from '../../src/agents/order-calc/search-sources';
import {
  PROJECT_EXTERNAL_TEXT_TOOL_NAMES,
} from '../../src/agents/shared/external-text-tools.owned';
import { draftDescription } from '../../src/agents/site-export/draft-description';
import { gatherItemData } from '../../src/agents/site-export/gather-item-data';
import {
  EXTERNAL_TEXT_TOOL_NAMES,
  PII_ALLOWED_EXTERNAL_TOOL_NAMES,
  WEB_SEARCH_SUMMARY_MAX_CHARS,
  assertPiiAllowedExternalQuery,
} from '@business-ai/core';
import type { ModelRequest } from '@business-ai/core';
import { DictionaryPseudonymizer, TEST_PII } from '@business-ai/testing';

const INN = '7707083893';
const SURNAME_QUERY = 'Петрова Мария ООО Ромашка';

const toolCallOf =
  (name: string, args: Record<string, string>): ModelResponder =>
  () => ({ content: '', toolCalls: [{ id: 'c', name, arguments: args }], stopReason: 'tool_use' });

const request: ModelRequest = {
  model: 'm',
  threadId: 'th',
  messages: [{ role: 'user', content: `Найди ${SURNAME_QUERY} ИНН ${INN}` }],
};

describe('перечень внешних текстовых инструментов проекта', () => {
  test('имена совпадают с name инструментов, поиск в интернете среди них', () => {
    const names = [searchInternet.name, searchWeb.name, gatherItemData.name, draftDescription.name];
    expect([...PROJECT_EXTERNAL_TEXT_TOOL_NAMES].sort()).toEqual(names.sort());
    for (const name of EXTERNAL_TEXT_TOOL_NAMES) {
      expect(PROJECT_EXTERNAL_TEXT_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe('набор PII_ALLOWED_EXTERNAL_TOOL_NAMES', () => {
  test('подмножество внешних инструментов и только searchInternet', () => {
    expect([...PII_ALLOWED_EXTERNAL_TOOL_NAMES]).toEqual([searchInternet.name]);
    for (const name of PII_ALLOWED_EXTERNAL_TOOL_NAMES) {
      expect(EXTERNAL_TEXT_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(PII_ALLOWED_EXTERNAL_TOOL_NAMES.has(searchWeb.name)).toBe(false);
  });
});

describe('шлюз псевдонимизации: восстановление в аргументах поиска', () => {
  const gatewayWith = (name: string, allowed: ReadonlySet<string>) => {
    const inner = new MemoryModelGateway(
      toolCallOf(name, { query: '[PERSON_1] ООО Ромашка [INN_1]' }),
    );
    return new PseudonymizingModelGateway(
      inner,
      new DictionaryPseudonymizer(TEST_PII),
      {},
      undefined,
      PROJECT_EXTERNAL_TEXT_TOOL_NAMES,
      allowed,
    );
  };

  test('searchInternet в режиме: токены стали реальными значениями', async () => {
    const response = await gatewayWith('searchInternet', PII_ALLOWED_EXTERNAL_TOOL_NAMES)
      .complete(request);
    expect(response.toolCalls?.[0]?.arguments).toEqual({
      query: `${SURNAME_QUERY.split(' ООО')[0]} ООО Ромашка ${INN}`,
    });
  });

  test('searchInternet без режима (поиск выключен): токены остаются', async () => {
    const response = await gatewayWith('searchInternet', new Set()).complete(request);
    expect(String(response.toolCalls?.[0]?.arguments.query)).toContain('[PERSON_1]');
  });

  test('searchWeb при включённом режиме: проверка ПДн действует, токены остаются', async () => {
    const response = await gatewayWith('searchWeb', PII_ALLOWED_EXTERNAL_TOOL_NAMES)
      .complete(request);
    expect(String(response.toolCalls?.[0]?.arguments.query)).toContain('[PERSON_1]');
  });
});

describe('searchInternet: проверка запроса', () => {
  const context = createToolContext({
    threadId: 'th',
    agentId: 'prices',
    operationId: 'op',
    initiator: { kind: 'user', userId: 'u1' },
  });
  const page = { title: 'Ромашка', url: 'https://r.example', snippet: 'ООО Ромашка' };

  test('без режима ПДн в запросе отклоняются, с режимом - доходят до поиска', async () => {
    const web = new MemoryWebSearch([page]);
    const closed: WebSearchHost = { web };
    const open: WebSearchHost = { web, webSearchQueryPiiAllowed: true };
    const query = `ИНН ${INN} Ромашка`;
    await expect(searchInternet.execute({ query }, closed, context)).rejects.toThrow('отклонён');
    const out = await searchInternet.execute({ query }, open, context);
    expect(out.results[0]?.url).toBe(page.url);
  });

  test('режим ПДн: длина и токены проверяются', () => {
    expect(() => assertPiiAllowedExternalQuery('[ORG_1] арматура')).toThrow('токен');
    // Этап 177: длина больше не отказ (сокращение — в fitPiiAllowedExternalQuery). Платформа
    // включает это выбором `skipLengthCheck`; режим предупреждений поиска делает так же.
    expect(() =>
      assertPiiAllowedExternalQuery('а'.repeat(500), { skipLengthCheck: true }),
    ).not.toThrow();
    expect(() => assertPiiAllowedExternalQuery(`ИНН ${INN}`)).not.toThrow();
  });

  test('сводка и аудит: запрос, число поисков, домены, стоимость', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 's',
              content: [{ type: 'web_search_result', url: 'https://r.example/x', title: 'Т' }],
            },
            { type: 'text', text: `Телефон 89021234567. ${'я'.repeat(3000)}` },
          ],
          usage: { server_tool_use: { web_search_requests: 3 } },
        }),
        { status: 200 },
      );
    const audit = new MemoryAuditRepository();
    const host: WebSearchHost = {
      web: new AnthropicWebSearch({
        baseUrl: 'http://g',
        apiKey: 'k',
        model: 'm',
        fetchFn,
        log: () => undefined,
      }),
      webSearchQueryPiiAllowed: true,
      webSearchAudit: audit,
    };
    const out = await searchInternet.execute({ query: `ИНН ${INN}` }, host, context);
    expect(out.summary?.length).toBeLessThanOrEqual(WEB_SEARCH_SUMMARY_MAX_CHARS);
    const [entry] = await audit.list();
    expect(entry?.action).toBe(WEB_SEARCH_AUDIT_ACTION);
    expect(entry?.details).toContain(`ИНН ${INN}`);
    expect(entry?.details).toContain('searches=3');
    expect(entry?.details).toContain('domains=r.example');
    expect(entry?.details).toContain('cost_usd=0.03');
    expect(entry?.details).not.toContain('89021234567');
  });
});

describe('аудит при сбое поиска после платных обращений', () => {
  const context = createToolContext({
    threadId: 'th',
    agentId: 'prices',
    operationId: 'op',
    initiator: { kind: 'user', userId: 'u1' },
  });

  test('отказ модели: запись с result error, числом поисков и без текстов страниц', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(
        JSON.stringify({
          stop_reason: 'refusal',
          content: [{ type: 'text', text: 'СЕКРЕТНЫЙ ТЕКСТ СТРАНИЦЫ' }],
          usage: { server_tool_use: { web_search_requests: 2 } },
        }),
        { status: 200 },
      );
    const audit = new MemoryAuditRepository();
    const host: WebSearchHost = {
      web: new AnthropicWebSearch({
        baseUrl: 'http://g',
        apiKey: 'k',
        model: 'm',
        fetchFn,
        log: () => undefined,
      }),
      webSearchQueryPiiAllowed: true,
      webSearchAudit: audit,
    };
    const error = await searchInternet
      .execute({ query: 'арматура' }, host, context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const [entry] = await audit.list();
    expect(entry?.action).toBe(WEB_SEARCH_AUDIT_ACTION);
    expect(entry?.result).toBe('error');
    expect(entry?.details).toContain('searches=2');
    expect(entry?.details).toContain('cost_usd=0.02');
    expect(entry?.details).not.toContain('СЕКРЕТНЫЙ');
  });

  test('сбой без расхода (поиск не выполнялся): аудита нет', async () => {
    const fetchFn: FetchFn = async () => new Response('{}', { status: 400 });
    const audit = new MemoryAuditRepository();
    const host: WebSearchHost = {
      web: new AnthropicWebSearch({
        baseUrl: 'http://g',
        apiKey: 'k',
        model: 'm',
        fetchFn,
        log: () => undefined,
      }),
      webSearchAudit: audit,
    };
    await searchInternet.execute({ query: 'арматура' }, host, context).catch(() => undefined);
    expect(await audit.list()).toHaveLength(0);
  });
});

describe('результат поиска для основной модели', () => {
  test('ПДн в найденном тексте маскируются, url и title сохраняются', async () => {
    const inner = new MemoryModelGateway();
    const gateway = new PseudonymizingModelGateway(inner, new DictionaryPseudonymizer(TEST_PII));
    const url = 'https://metall.example/a500';
    const result = {
      untrusted: true,
      summary: 'Контакт Иванов Иван Иванович, +7 (902) 123-45-67, ivan.petrov@example.com',
      results: [{ title: 'Арматура А500С', url, snippet: 'ИНН 7707083893' }],
    };
    await gateway.complete({
      model: 'm',
      threadId: 'th',
      messages: [
        { role: 'user', content: 'найди' },
        { role: 'tool', toolCallId: 'c', content: JSON.stringify(result) },
      ],
    });
    const wire = JSON.stringify(inner.requests);
    for (const secret of ['Иванов Иван Иванович', '123-45-67', 'ivan.petrov', '7707083893']) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain(url);
    expect(wire).toContain('Арматура А500С');
  });
});
