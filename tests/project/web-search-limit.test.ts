import { afterAll, describe, expect, test } from 'bun:test';
import { isWebSearchRateLimited, type WebSearchLimiter } from '@business-ai/core';
import { removeTempDirs } from '@business-ai/testing';
import { pragmatikaRuntime } from '../../src/runtime';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

/** Прежнее значение по умолчанию: поисков за ход при включённом обогащении (SRC). */
const DEFAULT_PER_TURN = 20;
/** Малый предел для проверки: наглядно меньше умолчания. */
const SMALL_PER_TURN = 3;

type Scope = Parameters<WebSearchLimiter['acquire']>[0];

/** Часть контекста хода, по которой лимитер считает поиски. */
function scope(turnNumber: number): Scope {
  return { threadId: 'thread-1', turnNumber, initiator: { kind: 'user', userId: 'u-1' } };
}

/** Сколько поисков удалось занять в ходе, пока лимитер не отказал. */
function acquiredInTurn(env: Record<string, string>, turnNumber: number): number {
  buildPragmatika(env);
  const limiter = pragmatikaRuntime()?.orderCalc.webSearchLimiter;
  if (limiter === undefined) throw new Error('лимитер веб-поиска не собран');
  let acquired = 0;
  for (;;) {
    try {
      limiter.acquire(scope(turnNumber));
      acquired += 1;
    } catch (error) {
      expect(isWebSearchRateLimited(error)).toBe(true);
      return acquired;
    }
  }
}

describe('предел веб-поиска за ход (WEB_SEARCH_MAX_PER_TURN)', () => {
  test('умолчание как в прежнем ядре: 20 поисков за ход', () => {
    expect(acquiredInTurn({}, 1)).toBe(DEFAULT_PER_TURN);
  });

  test('значение из окружения доходит до лимитера агентов', () => {
    expect(acquiredInTurn({ WEB_SEARCH_MAX_PER_TURN: String(SMALL_PER_TURN) }, 1)).toBe(
      SMALL_PER_TURN,
    );
  });

  test('лимитер общий у агентов, ходы считаются раздельно', () => {
    buildPragmatika({ WEB_SEARCH_MAX_PER_TURN: String(SMALL_PER_TURN) });
    const runtime = pragmatikaRuntime();
    const limiter = runtime?.orderCalc.webSearchLimiter;
    if (limiter === undefined) throw new Error('лимитер веб-поиска не собран');
    limiter.acquire(scope(1), SMALL_PER_TURN);
    expect(() => limiter.acquire(scope(1))).toThrow();
    // Следующий ход начинается с нуля.
    expect(() => limiter.acquire(scope(2))).not.toThrow();
  });
});
