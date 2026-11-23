import { z } from 'zod';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createToolContext } from '@business-ai/core';
import type { AnyToolDefinition } from '@business-ai/core';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { withRequestRef } from '../../src/agents/order-calc/request-title';
import { ORDER_CALC_MAIL_PROMPT, ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { buildDocumentsPrompt } from '../../src/agents/documents/prompt';
import { DomainError } from '@business-ai/core';
import { buildOrderDeps, type OrderTestDeps } from './order-support';

/** Тред связки «бот/сотрудник»: по нему код узнаёт, чьи заявки искать. */
const THREAD = 'bot/u1';
const ctx = createToolContext({ threadId: THREAD, agentId: 'test-agent', operationId: 'op-1' });

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps({ request: null });
});

const save = (title: string, name: string) =>
  saveIntakeRequest.execute(
    { source: 'text', title, items: [{ name, quantity: 1, unit: 'шт' }] },
    deps,
    ctx,
  );

const base: Omit<AnyToolDefinition, 'inputSchema'> = {
  name: 't',
  description: '',
  outputSchema: z.unknown(),
  execute: async () => null,
};
const documentTool = withRequestRef(
  { ...base, inputSchema: z.object({ requestId: z.string().optional() }) },
  { activeFallback: false },
);

describe('заявка документа ищется по названию', () => {
  test('одна заявка: частичное название без учёта регистра', async () => {
    const saved = await save('Пледы флисовые', 'Плед');
    await save('Мёд с орехами', 'Мёд');
    const out = await documentTool.resolveInput?.({ requestId: 'ПЛЕДЫ' }, deps, THREAD);
    expect(out).toEqual({ requestId: saved.requestId });
  });

  test('несколько заявок: список кандидатов без внутренних id', async () => {
    await save('пледы красные', 'Плед');
    await save('пледы синие', 'Плед синий');
    const error = await documentTool
      .resolveInput?.({ requestId: 'пледы' }, deps, THREAD)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    const message = (error as DomainError).message;
    expect(message).toContain('пледы красные');
    expect(message).toContain('пледы синие');
    expect(message).not.toContain('req-');
  });

  test('нет совпадений: понятное сообщение, а не чужая активная заявка', async () => {
    await save('пледы', 'Плед');
    const error = await documentTool
      .resolveInput?.({ requestId: 'несуществующая заявка' }, deps, THREAD)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('not_found');
    expect((error as DomainError).message).toContain('название');
  });

  test('requestId не передан: инструмент не трогаем', async () => {
    const input = { supplierId: 's1' };
    expect(await documentTool.resolveInput?.(input, deps, THREAD)).toBe(input);
  });

  test('агент документов оборачивает инструменты с requestId', () => {
    const tools = createDocumentsAgent({ model: 'm' }).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ['getSelectedQuote', 'prepareSupplierDocument']) {
      expect(byName.get(name)?.resolveInput).toBeDefined();
    }
  });
});

describe('промпты не просят номер заявки', () => {
  test('расчёт заказа и документы просят название', () => {
    const prompts = [
      ORDER_CALC_PROMPT,
      ORDER_CALC_MAIL_PROMPT,
      buildDocumentsPrompt(undefined),
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/(?:спроси|спрашивай|укажи|назови)[^.\n]*номер заявк/i);
    }
    expect(ORDER_CALC_PROMPT).toContain('название');
    expect(createOrderCalcAgent({ model: 'm' }).prompt).toContain('название заявки');
    expect(buildDocumentsPrompt(undefined)).toContain('название заявки');
  });
});
