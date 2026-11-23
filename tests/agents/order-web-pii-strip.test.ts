import { beforeEach, describe, expect, test } from 'bun:test';
import { ModelWebCandidateEnricher } from '../../src/kit/adapters/litellm/web-candidate-model';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal } from '../../src/agents/order-calc/state';
import { searchWeb } from '../../src/agents/order-calc/search-sources';
import type { ModelGateway, ModelRequest } from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Фрагмент выдачи с ПДн директора; телефоны записаны с разделителями. */
const PAGE_TEXT =
  'Арматура-Центр, г. Казань, ул. Тестовая, д. 5. Директор Руководов Иван Петрович, ' +
  'тел. +7 843 555-01-02, sales@armatura.test. Арматура 12 мм от 1 250,50 руб за м.';
const LONG_DIGITS = /\d{10,}/;

let deps: OrderTestDeps;
const seen: ModelRequest[] = [];

/** Модель отвечает только городом: телефон и почту должен добавить код. */
const gateway: ModelGateway = {
  async complete(request) {
    seen.push(request);
    return { model: request.model, content: '{"city":"Казань"}', stopReason: 'end_turn' };
  },
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('не используется');
  },
};

beforeEach(async () => {
  seen.length = 0;
  deps = await buildOrderDeps();
  deps.web.search = async () => [
    { title: 'Арматура-Центр', url: 'https://armatura.test', snippet: PAGE_TEXT },
  ];
});

describe('searchWeb: очистка страницы (WEB_PAGE_PII_STRIP=enforce)', () => {
  test('модель не видит ПДн, а контакты в шорт-листе берутся кодом из исходного текста', async () => {
    deps.webEnricher = new ModelWebCandidateEnricher(gateway, 'm', { mode: 'enforce' });
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(seen.length).toBeGreaterThan(0);
    const body = seen.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n');
    expect(body).not.toContain('Руководов');
    expect(body).not.toContain('sales@armatura.test');
    expect(body).not.toContain('Тестовая');
    expect(LONG_DIGITS.test(body)).toBe(false);
    expect(body).toContain('1 250,50 руб');

    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    const entry = proposal?.entries.find((item) => item.name === 'Арматура-Центр');
    expect(entry?.city).toBe('Казань');
    expect(entry?.contacts).toContain('sales@armatura.test');
    expect(entry?.contacts).toContain('843');
    expect(out.entries.find((item) => item.supplierId === entry?.supplierId)?.hasEmail).toBe(true);
    // Фамилия директора не попадает в выдачу
    expect(JSON.stringify(proposal)).not.toContain('Руководов');
  });

  test('сбой очистки: модель не вызывается, контакты всё равно берутся кодом', async () => {
    deps.webEnricher = new ModelWebCandidateEnricher(gateway, 'm', {
      mode: 'enforce',
      sanitize: () => {
        throw new Error('сбой очистки');
      },
    });
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    expect(seen).toHaveLength(0);
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    const entry = proposal?.entries.find((item) => item.name === 'Арматура-Центр');
    expect(entry?.contacts).toContain('sales@armatura.test');
  });
});
