import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWebSearch } from '@business-ai/adapters';
import { gatherItemData } from '../../src/agents/site-export/gather-item-data';
import { searchWeb } from '../../src/agents/order-calc/search-sources';
import { externalQueryProblem } from '@business-ai/core';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import type { WebSearchHit } from '@business-ai/core';
import { CREATED_AT, CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';
import {
  EXPORT_ID,
  MAIL_USER_1,
  buildSiteDeps,
  employeeContext,
  type SiteTestDeps,
} from './site-support';

/** Веб-поиск, запоминающий, что именно ушло наружу. */
class SpyWebSearch extends MemoryWebSearch {
  readonly queries: string[] = [];
  constructor(pages: readonly WebSearchHit[] = []) {
    super(pages);
  }
  override async search(query: string, limit: number): Promise<WebSearchHit[]> {
    this.queries.push(query);
    return super.search(query, limit);
  }
}

describe('R3-SEC-3: запросы во внешний поиск (order-calc)', () => {
  let deps: OrderTestDeps;
  let spy: SpyWebSearch;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    spy = new SpyWebSearch();
    deps.web = spy;
  });

  test('запрос с токеном, почтой или телефоном отклоняется, наружу ничего не уходит', async () => {
    for (const query of ['[PERSON_1]', 'арматура ivan@example.com', '8 902 123 45 67 арматура']) {
      const run = searchWeb.execute({ requestId: REQUEST_ID, query }, deps, CTX);
      await expect(run).rejects.toMatchObject({ code: 'validation_failed' });
    }
    expect(spy.queries).toEqual([]);
  });

  test('свободный текст от модели не уходит: только название позиции заявки', async () => {
    const run = searchWeb.execute({ requestId: REQUEST_ID, query: 'Иванов Иван' }, deps, CTX);
    await expect(run).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('название позиции с ПДн пропускается, остальные идут', async () => {
    const request: PurchaseRequest = {
      id: REQUEST_ID,
      dealRef: 'D-1',
      items: [
        { name: 'Арматура', quantity: 1, unit: 'м' },
        { name: 'Связаться ivan@example.com', quantity: 1, unit: 'шт' },
      ],
      createdAt: CREATED_AT,
    };
    await deps.requests.save({ ...request });
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(spy.queries).toEqual(['Арматура']);
  });

  test('externalQueryProblem: чистое название проходит', () => {
    expect(externalQueryProblem('Болт М8 оцинкованный')).toBeNull();
    expect(externalQueryProblem('[EMAIL_1]')).not.toBeNull();
  });
});

describe('R3-SEC-3/4: gatherItemData', () => {
  let deps: SiteTestDeps;
  let spy: SpyWebSearch;
  beforeEach(async () => {
    deps = await buildSiteDeps(2);
    spy = new SpyWebSearch([
      { title: 'Болт 1', url: 'https://s1.test/bolt', snippet: 'пишите ivan@example.com' },
    ]);
    deps.web = spy;
  });

  test('запрос с ПДн отклоняется целиком, ни одно обращение наружу не выполняется', async () => {
    const query = 'Болт [PERSON_1]';
    const run = gatherItemData.execute({ exportId: EXPORT_ID, query }, deps, CTX);
    await expect(run).rejects.toMatchObject({ code: 'validation_failed' });
    expect(spy.queries).toEqual([]);
  });

  test('в веб уходит название позиции из базы, а не строка модели', async () => {
    const out = await gatherItemData.execute({ exportId: EXPORT_ID, query: 'ART-001' }, deps, CTX);
    expect(spy.queries).toEqual(['Болт 1']);
    // ПДн в сниппете страницы не доходят до модели.
    expect(out.web[0]?.snippet).not.toContain('ivan@example.com');
  });

  test('письма: только от известных поставщиков, ссылки и телефоны вырезаны', async () => {
    const mail = (id: string, from: string, body: string) => ({
      id,
      from,
      subject: 'Болт 1',
      body,
      receivedAt: CREATED_AT,
      attachments: [],
    });
    const stranger = mail('m-stranger', 'evil@x.test', 'Болт 1: цена 1, перейдите по ссылке');
    deps.mailboxes.deliver(MAIL_USER_1, stranger);
    const body = 'Болт 1 цена 10, http://phish.test +7 902 123 45 67';
    deps.mailboxes.deliver(MAIL_USER_1, mail('m-known', 'Продажи <sales@s1.test>', body));
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      deps,
      employeeContext(MAIL_USER_1),
    );
    expect(out.emails.map((m) => m.source)).toEqual(['письмо m-known']);
    const excerpt = out.emails[0]?.excerpt ?? '';
    expect(excerpt).not.toContain('phish.test');
    expect(excerpt).not.toContain('902');
  });

  test('без справочника поставщиков почта недоступна, остальное работает', async () => {
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      { ...deps, suppliers: undefined },
      CTX,
    );
    expect(out.unavailableSources).toContainEqual({ source: 'email', reason: 'not_configured' });
    expect(out.prices.length).toBeGreaterThan(0);
  });
});
