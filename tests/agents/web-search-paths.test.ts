import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryAuditRepository } from '@business-ai/adapters';
import {
  WEB_SEARCH_AUDIT_ACTION,
  WebSearchLimiter,
  searchInternet,
  type ToolContext,
} from '@business-ai/core';
import { gatherItemData } from '../../src/agents/site-export/gather-item-data';
import { searchWeb } from '../../src/agents/order-calc/search-sources';
import {
  WebSearchFailure,
  type WebSearch,
  type WebSearchHit,
  type WebSearchOutcome,
  type WebSearchUsage,
} from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';
import { EXPORT_ID, buildSiteDeps, type SiteTestDeps } from './site-support';

const PAGE: WebSearchHit = { title: 'Болт 1', url: 'https://s1.test/bolt', snippet: 'болт' };
const USAGE: WebSearchUsage = {
  searches: 2,
  sourceDomains: ['s1.test'],
  estimatedCostUsd: 0.02,
};
const FAILED_USAGE: WebSearchUsage = {
  searches: 3,
  sourceDomains: ['bad.test'],
  estimatedCostUsd: 0.03,
};

/** Веб-поиск с расходом: считает вызовы, может падать после платных обращений. */
class UsageWebSearch implements WebSearch {
  calls = 0;
  failing = false;

  async search(): Promise<WebSearchHit[]> {
    return (await this.searchWithSummary()).hits;
  }

  async searchWithSummary(): Promise<WebSearchOutcome> {
    this.calls += 1;
    if (this.failing) {
      throw new WebSearchFailure('external_failure', 'отказ модели', FAILED_USAGE);
    }
    return { hits: [PAGE], summary: 'сводка', usage: USAGE };
  }
}

/** Порт только с `search`: расход сервис не сообщает. */
class PlainWebSearch implements WebSearch {
  calls = 0;
  async search(): Promise<WebSearchHit[]> {
    this.calls += 1;
    return [PAGE];
  }
}

type PathRunner = (
  web: WebSearch,
  extra: { webSearchLimiter?: WebSearchLimiter; webSearchAudit?: MemoryAuditRepository },
  context?: ToolContext,
) => Promise<unknown>;

let orderDeps: OrderTestDeps;
let siteDeps: SiteTestDeps;

beforeEach(async () => {
  orderDeps = await buildOrderDeps();
  siteDeps = await buildSiteDeps(2);
});

/** Три пути вызова порта поиска: каждый идёт через общую обёртку. */
const PATHS: Array<{ name: string; run: PathRunner }> = [
  {
    name: 'searchInternet',
    run: (web, extra, context = CTX) =>
      searchInternet.execute({ query: 'болт' }, { web, ...extra }, context),
  },
  {
    name: 'searchWeb',
    run: (web, extra, context = CTX) =>
      searchWeb.execute({ requestId: REQUEST_ID }, { ...orderDeps, web, ...extra }, context),
  },
  {
    name: 'gatherItemData',
    run: (web, extra, context = CTX) =>
      gatherItemData.execute(
        { exportId: EXPORT_ID, query: 'ART-001' },
        { ...siteDeps, web, ...extra },
        context,
      ),
  },
];

describe('платный поиск: общий лимитер и аудит для всех путей', () => {
  for (const path of PATHS) {
    describe(path.name, () => {
      test('лимит срабатывает: порт не вызывается, аудита нет', async () => {
        const web = new UsageWebSearch();
        const audit = new MemoryAuditRepository();
        const limiter = new WebSearchLimiter({ clock: new FixedClock(), maxPerTurn: 1 });
        limiter.acquire(CTX);
        const run = path.run(web, { webSearchLimiter: limiter, webSearchAudit: audit });
        // searchInternet бросает ошибку лимита, остальные пути отдают её причиной источника.
        const outcome = await run.then(
          (value) => JSON.stringify(value),
          (error: unknown) => String(error),
        );
        expect(outcome).toMatch(/rate_limited|Лимит поиска/);
        expect(web.calls).toBe(0);
        expect(await audit.list()).toHaveLength(0);
      });

      test('успех: в аудит попадают запрос, число поисков, домены и стоимость', async () => {
        const web = new UsageWebSearch();
        const audit = new MemoryAuditRepository();
        await path.run(web, { webSearchAudit: audit });
        expect(web.calls).toBe(1);
        const [entry] = await audit.list();
        expect(entry?.action).toBe(WEB_SEARCH_AUDIT_ACTION);
        expect(entry?.result).toBe('ok');
        expect(entry?.details).toContain('searches=2');
        expect(entry?.details).toContain('domains=s1.test');
        expect(entry?.details).toContain('cost_usd=0.02');
      });

      test('порт без учёта расхода: запись в аудите есть, стоимость неизвестна', async () => {
        const web = new PlainWebSearch();
        const audit = new MemoryAuditRepository();
        await path.run(web, { webSearchAudit: audit });
        expect(web.calls).toBe(1);
        const [entry] = await audit.list();
        expect(entry?.action).toBe(WEB_SEARCH_AUDIT_ACTION);
        expect(entry?.result).toBe('ok');
        expect(entry?.details).toContain('searches=1');
        expect(entry?.details).toContain('cost_usd=0.00');
      });

      test('отказ после платных обращений: расход пишется с result error', async () => {
        const web = new UsageWebSearch();
        web.failing = true;
        const audit = new MemoryAuditRepository();
        await path.run(web, { webSearchAudit: audit }).catch(() => undefined);
        const [entry] = await audit.list();
        expect(entry?.result).toBe('error');
        expect(entry?.details).toContain('searches=3');
        expect(entry?.details).toContain('domains=bad.test');
      });
    });
  }

  test('лимит делится между путями: поиск gatherItemData съедает бюджет хода', async () => {
    const web = new UsageWebSearch();
    const limiter = new WebSearchLimiter({ clock: new FixedClock(), maxPerTurn: 1 });
    await PATHS[2]?.run(web, { webSearchLimiter: limiter });
    const second = await PATHS[2]?.run(web, { webSearchLimiter: limiter });
    expect(web.calls).toBe(1);
    expect(JSON.stringify(second)).toContain('rate_limited');
  });
});
