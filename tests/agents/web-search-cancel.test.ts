import { describe, expect, test } from 'bun:test';
import { MemoryAuditRepository } from '@business-ai/adapters';
import { createToolContext, runAuditedWebSearch, type WebSearchHost } from '@business-ai/core';
import { DomainError } from '@business-ai/core';
import type {
  AuditEntry,
  AuditRepository,
  WebSearch,
  WebSearchHit,
  WebSearchOptions,
  WebSearchOutcome,
} from '@business-ai/core';

const QUERY = 'арматура А500';
const PAGE: WebSearchHit = { title: 'Арматура', url: 'https://metall.example/a', snippet: '' };

/** Веб-поиск, запоминающий условия вызова. */
class OptionsSpy implements WebSearch {
  seen: WebSearchOptions | undefined;
  async search(): Promise<WebSearchHit[]> {
    return [PAGE];
  }
  async searchWithSummary(
    _query: string,
    _limit: number,
    options?: WebSearchOptions,
  ): Promise<WebSearchOutcome> {
    this.seen = options;
    return {
      hits: [PAGE],
      summary: '',
      usage: { searches: 1, sourceDomains: [], estimatedCostUsd: 0.01 },
    };
  }
}

/** Аудит, который не может записать. */
class BrokenAudit extends MemoryAuditRepository implements AuditRepository {
  override async append(_entry: AuditEntry): Promise<void> {
    throw new DomainError('external_failure', 'база недоступна');
  }
}

describe('веб-поиск: сигнал хода и сбой аудита', () => {
  test('сигнал хода доходит до порта поиска', async () => {
    const web = new OptionsSpy();
    const controller = new AbortController();
    const context = createToolContext({
      threadId: 't1',
      agentId: 'a1',
      operationId: 'op-1',
      signal: controller.signal,
    });
    await runAuditedWebSearch({ web } satisfies WebSearchHost, context, QUERY);
    expect(web.seen?.signal).toBe(controller.signal);
  });

  test('без сигнала хода в условиях поиска нет ключа signal', async () => {
    const web = new OptionsSpy();
    const context = createToolContext({ threadId: 't1', agentId: 'a1', operationId: 'op-1' });
    await runAuditedWebSearch({ web }, context, QUERY);
    expect(web.seen !== undefined && 'signal' in web.seen).toBe(false);
  });

  test('сбой записи аудита не роняет поиск, но пишет код в журнал', async () => {
    const events: Array<{ event: string; fields?: Record<string, string | number | boolean> }> =
      [];
    const host: WebSearchHost = {
      web: new OptionsSpy(),
      webSearchAudit: new BrokenAudit(),
      webSearchLog: (event, fields) => {
        events.push({ event, ...(fields === undefined ? {} : { fields }) });
      },
    };
    const context = createToolContext({ threadId: 't1', agentId: 'a1', operationId: 'op-1' });
    const { hits } = await runAuditedWebSearch(host, context, QUERY);
    expect(hits).toHaveLength(1);
    expect(events).toEqual([
      { event: 'web_search_audit_failed', fields: { code: 'external_failure' } },
    ]);
  });
});
