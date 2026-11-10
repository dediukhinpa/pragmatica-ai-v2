import { describe, expect, test } from 'bun:test';
import { DomainError } from '@business-ai/core';
import { HttpSignatoryInflector } from '../../src/adapters/http-signatory-inflector';

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Подмена fetch: запоминает запрос и отвечает заданным ответом. */
function stubFetch(respond: () => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return respond();
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const TIMEOUT_MS = 1000;

describe('HttpSignatoryInflector', () => {
  test('шлёт должность и ФИО в тело, возвращает текст в родительном падеже', async () => {
    const { seen, fetchFn } = stubFetch(() => Response.json({ text: 'директора Петрова П. П.' }));
    const inflector = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test/',
      timeoutMs: TIMEOUT_MS,
      apiToken: 'token-1',
      fetchFn,
    });
    const text = await inflector.signatoryGenitive('директор', 'Петров Пётр Петрович');
    expect(text).toBe('директора Петрова П. П.');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://pseudonymizer.test/inflect_signatory');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers['authorization']).toBe('Bearer token-1');
    expect(seen[0]?.body).toEqual({ position: 'директор', full_name: 'Петров Пётр Петрович' });
  });

  test('словарь не уверен: null, а не выдуманный текст', async () => {
    const { fetchFn } = stubFetch(() => Response.json({ text: null }));
    const inflector = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test',
      timeoutMs: TIMEOUT_MS,
      fetchFn,
    });
    expect(await inflector.signatoryGenitive('директор', 'Иванов')).toBeNull();
  });

  test('без токена заголовок авторизации не шлётся', async () => {
    const { seen, fetchFn } = stubFetch(() => Response.json({ text: null }));
    const inflector = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test',
      timeoutMs: TIMEOUT_MS,
      fetchFn,
    });
    await inflector.signatoryGenitive('директор', 'Иванов');
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });

  test('отказ сервера 5xx - повторяемая внешняя ошибка, ФИО в тексте ошибки нет', async () => {
    const { fetchFn } = stubFetch(() => new Response('x', { status: 503 }));
    const inflector = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test',
      timeoutMs: TIMEOUT_MS,
      fetchFn,
    });
    const error = await inflector.signatoryGenitive('директор', 'Секретов Иван').catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('external_failure');
    expect((error as DomainError).retryable).toBe(true);
    expect(String((error as Error).message)).not.toContain('Секретов');
  });

  test('отказ 4xx не повторяется, неверный ответ - внешняя ошибка', async () => {
    const refused = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test',
      timeoutMs: TIMEOUT_MS,
      fetchFn: stubFetch(() => new Response('x', { status: 400 })).fetchFn,
    });
    const error = await refused.signatoryGenitive('директор', 'Иванов').catch((e) => e);
    expect((error as DomainError).retryable).toBeFalsy();
    const broken = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test',
      timeoutMs: TIMEOUT_MS,
      fetchFn: stubFetch(() => Response.json({ other: 1 })).fetchFn,
    });
    await expect(broken.signatoryGenitive('директор', 'Иванов')).rejects.toMatchObject({
      code: 'external_failure',
    });
  });

  test('сеть недоступна - повторяемая внешняя ошибка', async () => {
    const inflector = new HttpSignatoryInflector({
      baseUrl: 'http://pseudonymizer.test',
      timeoutMs: TIMEOUT_MS,
      fetchFn: (async () => {
        throw new Error('connect refused');
      }) as unknown as typeof fetch,
    });
    const error = await inflector.signatoryGenitive('директор', 'Иванов').catch((e) => e);
    expect((error as DomainError).code).toBe('external_failure');
    expect((error as DomainError).retryable).toBe(true);
  });
});
