import { z } from 'zod';
import { beforeEach, describe, expect, test } from 'bun:test';
import { activeRequestBlock } from '../../src/agents/order-calc/active-request';
import { createToolContext } from '@business-ai/core';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { withRequestRef } from '../../src/agents/order-calc/request-title';
import type { AnyToolDefinition } from '@business-ai/core';
import { buildOrderDeps, type OrderTestDeps } from './order-support';

/** Личный тред связки «бот/сотрудник». */
const THREAD = 'bot/u1';
const OTHER_THREAD = 'bot/u2';
const ctxOf = (threadId: string) =>
  createToolContext({ threadId, agentId: 'test-agent', operationId: `op-${threadId}` });

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps({ request: null });
});

const base: Omit<AnyToolDefinition, 'inputSchema'> = {
  name: 't',
  description: '',
  outputSchema: z.unknown(),
  execute: async () => null,
};
const requestTool = withRequestRef({
  ...base,
  inputSchema: z.object({ requestId: z.string() }),
});

describe('активная заявка треда между ходами', () => {
  test('ход 1 сохраняет заявку, ход 2 с чужим requestId получает её же', async () => {
    // Ход 1: модель принимает заявку.
    const saved = await saveIntakeRequest.execute(
      {
        source: 'text',
        title: 'чайные пары',
        items: [{ name: 'Чайная пара', quantity: 10, unit: 'шт' }],
      },
      deps,
      ctxOf(THREAD),
    );
    // Ход 2: id из истории пропал, модель передаёт название позиции, пустое или выдуманное.
    for (const wrong of ['чайная пара 10 шт', '', 'req-0000000000000000']) {
      const resolved = await requestTool.resolveInput?.({ requestId: wrong }, deps, THREAD);
      expect(resolved).toEqual({ requestId: saved.requestId });
    }
    // Верный id остаётся как есть.
    const same = await requestTool.resolveInput?.({ requestId: saved.requestId }, deps, THREAD);
    expect(same).toEqual({ requestId: saved.requestId });
  });

  test('чужой тред активной заявки не видит', async () => {
    await saveIntakeRequest.execute(
      { source: 'text', items: [{ name: 'Плед', quantity: 1, unit: 'шт' }] },
      deps,
      ctxOf(THREAD),
    );
    const input = { requestId: 'что-то неизвестное' };
    expect(await requestTool.resolveInput?.(input, deps, OTHER_THREAD)).toEqual(input);
    expect(await activeRequestBlock(deps, OTHER_THREAD)).toBeNull();
  });

  test('блок хода содержит id, этап и позиции', async () => {
    expect(await activeRequestBlock(deps, THREAD)).toBeNull();
    const saved = await saveIntakeRequest.execute(
      {
        source: 'text',
        title: 'пледы',
        items: [{ name: 'Плед флисовый', quantity: 50, unit: 'шт' }],
      },
      deps,
      ctxOf(THREAD),
    );
    const block = await activeRequestBlock(deps, THREAD);
    expect(block?.id).toBe('active_request');
    expect(block?.text).toContain(saved.requestId);
    expect(block?.text).toContain('Плед флисовый - 50 шт');
    expect(block?.text).toContain('шорт-лист ещё не собран');
  });

  test('новая заявка в треде становится активной', async () => {
    await saveIntakeRequest.execute(
      { source: 'text', items: [{ name: 'Плед', quantity: 1, unit: 'шт' }] },
      deps,
      ctxOf(THREAD),
    );
    const second = await saveIntakeRequest.execute(
      { source: 'text', items: [{ name: 'Мёд', quantity: 2, unit: 'шт' }] },
      deps,
      ctxOf(THREAD),
    );
    expect((await activeRequestBlock(deps, THREAD))?.text).toContain(second.requestId);
  });
});
