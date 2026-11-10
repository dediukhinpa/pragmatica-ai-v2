import { z } from 'zod';
import { TELEGRAM_QUERY_MAX_CHARS } from '../../domain/telegram-source';
import type { Telemetry } from '@business-ai/core';
import type {
  TelegramChannelSource,
  TelegramPost,
  TelegramSearchOptions,
} from '../../ports/telegram-channel-source';
import { httpTrace, type HttpTrace } from '@business-ai/adapters';
import { parseResponse, requestJson, trimBaseUrl, type FetchFn } from '@business-ai/adapters';

const SERVICE = 'чтения Telegram-канала';
/** Маршрут сервиса чтения канала на зарубежном шлюзе (тот же mTLS-прокси, что у моделей). */
export const TELEGRAM_SEARCH_ROUTE = '/telegram/v1/search';
/** Таймаут запроса по умолчанию, мс: поиск по каналу идёт через MTProto, он небыстрый. */
export const DEFAULT_TELEGRAM_SEARCH_TIMEOUT_MS = 30_000;

/** Пост в проводе: snake_case, как у Python-сервиса. */
const wirePostSchema = z.object({
  channel: z.string().min(1),
  message_id: z.number().int(),
  date: z.string().min(1),
  text: z.string(),
  link: z.string().min(1).nullish(),
});
const responseSchema = z.object({ posts: z.array(wirePostSchema) });

/** Параметры HTTP-адаптера сервиса чтения канала. */
export interface HttpTelegramChannelSourceOptions {
  /** Адрес mTLS-прокси к шлюзу (`TELEGRAM_READER_BASE_URL`, по умолчанию адрес моделей). */
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  /** Каналы, которыми ограничен поиск; пусто - всеми каналами сервиса. */
  channels?: readonly string[];
  /**
   * Bearer-токен службы чтения (`TELEGRAM_READER_TOKEN`): служба без него отвечает 401. Токен
   * уходит только заголовком Authorization, в сообщения ошибок и журнал не попадает.
   */
  token?: string | undefined;
  telemetry?: Telemetry | undefined;
}

/**
 * Адаптер порта TelegramChannelSource к сервису чтения канала на шлюзе
 * (`POST /telegram/v1/search`). Один запрос без повторов: недоступный источник шорт-листа
 * изолирован (запись «недоступен»), а повтор удлинил бы ход. Сбои - DomainError
 * 'external_failure' (общий разбор `requestJson`); тела ответов, адрес и тексты постов в
 * сообщения ошибок не попадают.
 */
export class HttpTelegramChannelSource implements TelegramChannelSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly channels: readonly string[];
  private readonly token: string | undefined;
  private readonly trace: HttpTrace | undefined;

  constructor(options: HttpTelegramChannelSourceOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_SEARCH_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.channels = options.channels ?? [];
    this.token = options.token;
    this.trace = httpTrace(options.telemetry, 'telegram-reader', true);
  }

  async search(
    query: string,
    limit: number,
    options: TelegramSearchOptions = {},
  ): Promise<TelegramPost[]> {
    if (query.trim() === '') return [];
    // Служба отклоняет строку длиннее своего предела: обрезаем до него (запросы ядра короче).
    const text = Array.from(query).slice(0, TELEGRAM_QUERY_MAX_CHARS).join('');
    const data = await requestJson({
      fetchFn: this.fetchFn,
      trace: this.trace,
      service: SERVICE,
      url: `${this.baseUrl}${TELEGRAM_SEARCH_ROUTE}`,
      method: 'POST',
      ...(this.token === undefined ? {} : { headers: { Authorization: `Bearer ${this.token}` } }),
      body: {
        query: text,
        limit,
        ...(this.channels.length === 0 ? {} : { channels: this.channels }),
      },
      timeoutMs: this.timeoutMs,
      signal: options.signal,
    });
    const { posts } = parseResponse(SERVICE, responseSchema, data);
    return posts.map((post) => ({
      channel: post.channel,
      messageId: post.message_id,
      date: post.date,
      text: post.text,
      ...(post.link == null ? {} : { link: post.link }),
    }));
  }
}
