import { describe, expect, test } from 'bun:test';
import { MemoryWebSearch } from '@business-ai/adapters';
import { runAuditedWebSearch, searchInternet } from '@business-ai/core';
import {
  EXTERNAL_QUERY_MAX_CHARS,
  externalQueryProblem,
  siteScopedQueryProblem,
} from '@business-ai/core';
import { CTX } from './support';

const REAL_DOMAINS = ['armatura.ru', 'shop.ru', '1c-bitrix.ru'];

describe('siteScopedQueryProblem: запрос site: строит код', () => {
  test('реальные домены проходят, хотя полная проверка принимает их за ссылку', () => {
    for (const domain of REAL_DOMAINS) {
      const query = `site:${domain} контакты`;
      expect(externalQueryProblem(query)).not.toBeNull();
      expect(siteScopedQueryProblem(query, domain)).toBeNull();
    }
    // Кириллический домен в punycode тоже допустим.
    const puny = 'xn--80aswg.xn--p1ai';
    expect(siteScopedQueryProblem(`site:${puny} контакты`, puny)).toBeNull();
  });

  test('домен с ИНН или телефоном отклоняется', () => {
    for (const domain of ['7707083893.ru', '8-800-555-35-35.ru', '7707083893.shop.ru']) {
      expect(siteScopedQueryProblem(`site:${domain} контакты`, domain)).not.toBeNull();
    }
  });

  test('почта, телефон, ссылка и токен в остатке запроса блокируются', () => {
    for (const tail of ['a@b.ru', '+7 999 000-11-22', 'https://x.ru', '[PERSON_1]']) {
      expect(siteScopedQueryProblem(`site:shop.ru ${tail}`, 'shop.ru')).not.toBeNull();
    }
  });

  test('длина и несовпадение домена с запросом', () => {
    const long = `site:shop.ru ${'я'.repeat(EXTERNAL_QUERY_MAX_CHARS)}`;
    expect(siteScopedQueryProblem(long, 'shop.ru')).not.toBeNull();
    expect(siteScopedQueryProblem('site:other.ru контакты', 'shop.ru')).not.toBeNull();
    expect(siteScopedQueryProblem('site:a@b.ru контакты', 'a@b.ru')).not.toBeNull();
    expect(siteScopedQueryProblem('site:shop.ru/path контакты', 'shop.ru/path')).not.toBeNull();
  });
});

describe('runAuditedWebSearch: проверка не ослаблена для остальных вызовов', () => {
  const host = (): { web: MemoryWebSearch } => ({ web: new MemoryWebSearch([]) });
  const context = CTX;

  test('без siteDomain запрос site:shop.ru по-прежнему отклоняется как ссылка', async () => {
    await expect(
      runAuditedWebSearch(host(), context, 'site:shop.ru контакты'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('с siteDomain проходит, но телефон и почта всё равно блокируются', async () => {
    const options = { siteDomain: 'shop.ru' };
    await runAuditedWebSearch(host(), context, 'site:shop.ru контакты', options);
    for (const query of ['site:shop.ru a@b.ru', 'site:shop.ru +7 999 000-11-22']) {
      await expect(runAuditedWebSearch(host(), context, query, options)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
  });

  test('свободный запрос с телефоном не проходит даже при чужом siteDomain', async () => {
    await expect(
      runAuditedWebSearch(host(), context, 'позвонить +7 999 000-11-22', { siteDomain: 'shop.ru' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('сторонний вызов searchInternet проходит полную проверку', async () => {
    const deps = host();
    await expect(
      searchInternet.execute({ query: 'site:shop.ru контакты' }, deps, CTX),
    ).rejects.toThrow('отклонён');
    await expect(
      searchInternet.execute({ query: 'звонить +7 999 000-11-22' }, deps, CTX),
    ).rejects.toThrow('отклонён');
    const out = await searchInternet.execute({ query: 'арматура 12 мм' }, deps, CTX);
    expect(out.results).toEqual([]);
  });
});
