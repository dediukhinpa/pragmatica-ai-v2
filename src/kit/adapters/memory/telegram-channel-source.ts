import type {
  TelegramChannelSource,
  TelegramPost,
  TelegramPostExtractor,
  TelegramPostInput,
  TelegramSearchOptions,
} from '../../ports/telegram-channel-source';
import type { WebModelOptions } from '../../ports/web-candidate-model';
import type { DomainError } from '@business-ai/core';

/**
 * Канал в памяти: доля слов запроса, найденных в тексте поста; при равенстве свежие раньше.
 * Запросы и пределы запоминаются для проверок в тестах.
 */
export class MemoryTelegramChannelSource implements TelegramChannelSource {
  /** Запросы, с которыми вызывался поиск (для проверок). */
  readonly queries: string[] = [];
  /** Пределы, с которыми вызывался поиск (для проверок). */
  readonly limits: number[] = [];
  private failure: DomainError | null = null;

  constructor(private readonly posts: readonly TelegramPost[]) {}

  async search(
    query: string,
    limit: number,
    options: TelegramSearchOptions = {},
  ): Promise<TelegramPost[]> {
    options.signal?.throwIfAborted();
    this.queries.push(query);
    this.limits.push(limit);
    if (this.failure !== null) throw this.failure;
    const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) return [];
    return this.posts
      .map((post) => {
        const text = post.text.toLowerCase();
        return { post, matched: words.filter((word) => text.includes(word)).length };
      })
      .filter((item) => item.matched > 0)
      .sort((a, b) => b.matched - a.matched || (a.post.date < b.post.date ? 1 : -1))
      .slice(0, limit)
      .map((item) => ({ ...item.post }));
  }

  /** Имитировать недоступность сервиса (служебный метод заглушки). */
  failWith(error: DomainError | null): void {
    this.failure = error;
  }
}

/** Разбор поста в памяти (тестовый двойник): ответ по посту, входы запоминаются. */
export class MemoryTelegramPostExtractor implements TelegramPostExtractor {
  readonly seen: TelegramPostInput[] = [];

  constructor(private answer: (post: TelegramPostInput) => unknown) {}

  async extract(post: TelegramPostInput, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.seen.push(post);
    return this.answer(post);
  }

  /** Подменить ответ (служебный метод заглушки). */
  replace(answer: (post: TelegramPostInput) => unknown): void {
    this.answer = answer;
  }
}
