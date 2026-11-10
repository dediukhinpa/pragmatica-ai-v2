import { describe, expect, test } from 'bun:test';
import {
  HttpTelegramChannelSource,
  TELEGRAM_SEARCH_ROUTE,
} from '../../../src/kit/adapters/http/http-telegram-channel-source';
import {
  MemoryTelegramChannelSource,
} from '../../../src/kit/adapters/memory/telegram-channel-source';
import { type FetchFn } from '@business-ai/adapters';
import { TELEGRAM_QUERY_MAX_CHARS } from '../../../src/kit/domain/telegram-source';
import { isDomainError } from '@business-ai/core';
import type { TelegramPost } from '../../../src/kit/ports/telegram-channel-source';
import {
  TELEGRAM_SEED,
  telegramChannelSourceContract,
} from '../contracts/telegram-channel-source.contract';

const BASE_URL = 'http://gateway-mtls:8080/';

/** Тело ответа сервиса чтения канала (в проводе - snake_case). */
interface WirePost {
  channel: string;
  message_id: number;
  date: string;
  text: string;
  link?: string;
}

/**
 * Фейковый сервер чтения канала: тот же поиск по словам, что у заглушки, ответ в формате
 * провода. Проверяет путь, метод и тело запроса, уважает сигнал отмены.
 */
function fakeServer(seed: readonly TelegramPost[], seen: Array<{ url: string; body: unknown }> = []) {
  const memory = new MemoryTelegramChannelSource(seed);
  const fetchFn: FetchFn = async (url, init) => {
    init.signal?.throwIfAborted();
    const body: unknown = JSON.parse(String(init.body));
    seen.push({ url, body });
    const { query, limit } = body as { query: string; limit: number };
    const posts = await memory.search(query, limit);
    const wire: WirePost[] = posts.map((post) => ({
      channel: post.channel,
      message_id: post.messageId,
      date: post.date,
      text: post.text,
      ...(post.link === undefined ? {} : { link: post.link }),
    }));
    return new Response(JSON.stringify({ posts: wire }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return fetchFn;
}

function make(fetchFn: FetchFn): HttpTelegramChannelSource {
  return new HttpTelegramChannelSource({ baseUrl: BASE_URL, fetchFn, timeoutMs: 1000 });
}

telegramChannelSourceContract('HttpTelegramChannelSource (фейковый сервер)', (seed) =>
  make(fakeServer(seed)),
);

describe('HttpTelegramChannelSource: токен службы и пределы (ревью 216, п.8, п.10)', () => {
  test('Bearer-токен службы уходит заголовком Authorization', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchFn: FetchFn = async (_url, init) => {
      headers.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ posts: [] }));
    };
    const source = new HttpTelegramChannelSource({
      baseUrl: BASE_URL,
      fetchFn,
      timeoutMs: 1000,
      token: 'service-token-for-tests',
    });
    await source.search('цемент', 3);
    expect(headers[0]?.Authorization).toBe('Bearer service-token-for-tests');
  });

  test('без токена заголовка Authorization нет (отказ даст служба: 401)', async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    const fetchFn: FetchFn = async (_url, init) => {
      headers.push(init.headers as Record<string, string> | undefined);
      return new Response(JSON.stringify({ posts: [] }));
    };
    await make(fetchFn).search('цемент', 3);
    expect(headers[0]?.Authorization).toBeUndefined();
  });

  test('401 от службы - external_failure с вниманием оператора', async () => {
    const denied: FetchFn = async () => new Response('{}', { status: 401 });
    const error = await make(denied)
      .search('цемент', 3)
      .catch((caught: unknown) => caught);
    expect(isDomainError(error) && error.code).toBe('external_failure');
  });

  test('запрос длиннее предела службы обрезается до него', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    await make(fakeServer(TELEGRAM_SEED, seen)).search('а'.repeat(500), 3);
    const body = seen[0]?.body as { query: string };
    expect(body.query).toHaveLength(TELEGRAM_QUERY_MAX_CHARS);
  });
});

describe('HttpTelegramChannelSource: запрос и ошибки', () => {
  test('POST на маршрут шлюза, тело - запрос и предел, без лишних полей', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    await make(fakeServer(TELEGRAM_SEED, seen)).search('цемент', 3);
    expect(seen).toEqual([
      { url: `http://gateway-mtls:8080${TELEGRAM_SEARCH_ROUTE}`, body: { query: 'цемент', limit: 3 } },
    ]);
  });

  test('пустой запрос сервису не отправляется', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    expect(await make(fakeServer(TELEGRAM_SEED, seen)).search('  ', 3)).toEqual([]);
    expect(seen).toEqual([]);
  });

  test('сбой сети и 5xx - external_failure, а не исключение чужого типа', async () => {
    const down: FetchFn = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    const broken: FetchFn = async () => new Response('{}', { status: 502 });
    for (const fetchFn of [down, broken]) {
      const error = await make(fetchFn)
        .search('цемент', 3)
        .catch((caught: unknown) => caught);
      expect(isDomainError(error) && error.code).toBe('external_failure');
    }
  });

  test('ответ неожиданного формата - ошибка, а не пустой успех', async () => {
    const odd: FetchFn = async () => new Response(JSON.stringify({ posts: [{ text: 1 }] }));
    await expect(make(odd).search('цемент', 3)).rejects.toBeDefined();
  });

  test('тела ответа и адрес в сообщение ошибки не попадают', async () => {
    const leaky: FetchFn = async () =>
      new Response(JSON.stringify({ detail: 'секретный текст поста' }), { status: 500 });
    const error = await make(leaky)
      .search('цемент', 3)
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain('секретный');
    expect(String((error as Error).message)).not.toContain('gateway-mtls');
  });
});
