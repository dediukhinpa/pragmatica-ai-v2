import { describe, expect, test } from 'bun:test';
import { MemoryWebSearch } from '@business-ai/adapters';
import {
  EXTERNAL_QUERY_MAX_CHARS,
  WARNINGS_PROMPT,
  createToolContext,
  fitPiiAllowedExternalQuery,
  searchInternet,
  withFeedbackTool,
  type AgentDeclaration,
  type WebSearchHost,
} from '@business-ai/core';

describe('этап 177: общие правила', () => {
  test('длинный запрос сокращается по границе слова с предупреждением', () => {
    const query = 'арматура '.repeat(30).trim();
    const fitted = fitPiiAllowedExternalQuery(query);
    expect(fitted.query.length).toBeLessThanOrEqual(EXTERNAL_QUERY_MAX_CHARS);
    expect(fitted.query.endsWith('арматура')).toBe(true);
    expect(fitted.warning).toContain('сокращён');
  });

  test('короткий запрос не меняется', () => {
    expect(fitPiiAllowedExternalQuery('арматура')).toEqual({ query: 'арматура', warning: null });
  });

  test('общий блок промпта про один список предупреждений', () => {
    expect(WARNINGS_PROMPT).toContain('ОДНИМ коротким списком');
  });
});

describe('этап 177: searchInternet с длинным запросом', () => {
  test('поиск выполняется, предупреждение в ответе', async () => {
    const page = { title: 'Арматура', url: 'https://example.test/a', snippet: 'цена' };
    const web = new MemoryWebSearch([page]);
    const host: WebSearchHost = { web, webSearchQueryPiiAllowed: true, webSearchLimitWarnings: true };
    const context = createToolContext({
      threadId: 'th',
      agentId: 'documents',
      operationId: 'op-s177',
      initiator: { kind: 'user', userId: '42' },
    });
    const query = 'арматура '.repeat(40).trim();
    const out = await searchInternet.execute({ query }, host, context);
    expect(out.warnings?.[0]).toContain('сокращён');
  });

  test('withFeedbackTool добавляет блок предупреждений в промпт', () => {
    const declared = withFeedbackTool({ prompt: 'База', tools: [] } as unknown as AgentDeclaration, {
      limitWarnings: true,
    });
    expect(declared.prompt).toContain(WARNINGS_PROMPT);
  });
});
