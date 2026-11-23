import { describe, expect, test } from 'bun:test';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createToolContext, type AnyToolDefinition } from '@business-ai/core';
import { DOCUMENT_KINDS } from '../../src/kit/domain/models';
import { USER_A, buildSupplierWorld } from './suppliers-support';

/**
 * Агент «Подготовка документов»: предложение завести карточку поставщика, которого нет в базе,
 * делается только для договора (этап 219). Данные синтетические.
 */

const NEW_NAME = 'Новый Поставщик Е';
const QUESTION = `Поставщика «${NEW_NAME}» нет в базе. Добавить в базу?`;
const THREAD = `documents/${USER_A}`;

const agent = createDocumentsAgent({ model: 'm' });

function declaredLookup(): AnyToolDefinition {
  const tool = agent.tools.find((item) => item.name === 'lookupSupplierInBase');
  if (tool === undefined) throw new Error('инструмента поиска нет в декларации');
  return tool;
}

function context() {
  return createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: 'op-lookup',
    initiator: { kind: 'user', userId: USER_A },
  });
}

describe('documents: предложение карточки только для договора', () => {
  test('договор: поставщика нет в базе - вопрос задан, предложение открыто', async () => {
    const world = buildSupplierWorld();
    const tool = declaredLookup();
    const input = tool.inputSchema.parse({ name: NEW_NAME, documentKind: 'contract' });
    const out = (await tool.execute(input, world.host, context())) as Record<string, unknown>;
    expect(out['status']).toBe('none');
    expect(out['offer']).toBe('asked');
    expect(out['question']).toBe(QUESTION);
  });

  test('любой другой вид: статус none, вопроса и предложения нет', async () => {
    for (const kind of DOCUMENT_KINDS.filter((item) => item !== 'contract')) {
      const world = buildSupplierWorld();
      const tool = declaredLookup();
      const input = tool.inputSchema.parse({ name: NEW_NAME, documentKind: kind });
      const out = (await tool.execute(input, world.host, context())) as Record<string, unknown>;
      expect(out['status']).toBe('none');
      expect(out['offer']).toBe('not_offered');
      expect(out['question']).toBeUndefined();
      expect(String(out['message'])).toContain('только для договора');
    }
  });

  test('другой вид: ответ «да» карточку не создаёт, вопроса не было', async () => {
    const world = buildSupplierWorld();
    const lookup = declaredLookup();
    const decide = agent.tools.find((item) => item.name === 'recordSupplierLookupDecision');
    if (decide === undefined) throw new Error('инструмента ответа нет');
    const found = lookup.inputSchema.parse({ name: NEW_NAME, documentKind: 'invoice' });
    await lookup.execute(found, world.host, context());
    const answer = decide.inputSchema.parse({ decision: 'create', name: NEW_NAME });
    const out = (await decide.execute(answer, world.host, context())) as Record<string, unknown>;
    expect(out['status']).toBe('not_asked');
    expect(await world.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(0);
  });

  test('договор, затем «да»: карточка заводится как раньше', async () => {
    const world = buildSupplierWorld();
    world.deps.access = {
      isAllowed: async () => true,
    } as unknown as NonNullable<typeof world.deps.access>;
    const lookup = declaredLookup();
    const decide = agent.tools.find((item) => item.name === 'recordSupplierLookupDecision');
    if (decide === undefined) throw new Error('инструмента ответа нет');
    await lookup.execute(
      lookup.inputSchema.parse({ name: NEW_NAME, documentKind: 'contract' }),
      world.host,
      context(),
    );
    const answer = decide.inputSchema.parse({ decision: 'create', name: NEW_NAME });
    const out = (await decide.execute(answer, world.host, context())) as Record<string, unknown>;
    expect(out['status']).toBe('created');
    expect(await world.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(1);
  });

  test('договор выключен флагом видов: предложения нет, «да» не создаёт (п.8)', async () => {
    const world = buildSupplierWorld();
    const host = { ...world.host, enabledKinds: ['invoice'] };
    const lookup = declaredLookup();
    const decide = agent.tools.find((item) => item.name === 'recordSupplierLookupDecision');
    if (decide === undefined) throw new Error('инструмента ответа нет');
    const found = lookup.inputSchema.parse({ name: NEW_NAME, documentKind: 'contract' });
    const out = (await lookup.execute(found, host, context())) as Record<string, unknown>;
    expect(out['offer']).toBe('not_offered');
    expect(out['question']).toBeUndefined();
    const answer = decide.inputSchema.parse({ decision: 'create', name: NEW_NAME });
    const decided = (await decide.execute(answer, host, context())) as Record<string, unknown>;
    expect(decided['status']).toBe('not_asked');
    expect(await world.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(0);
  });

  test('договор включён среди прочих видов: предложение делается', async () => {
    const world = buildSupplierWorld();
    const host = { ...world.host, enabledKinds: ['contract', 'invoice'] };
    const tool = declaredLookup();
    const input = tool.inputSchema.parse({ name: NEW_NAME, documentKind: 'contract' });
    const out = (await tool.execute(input, host, context())) as Record<string, unknown>;
    expect(out['offer']).toBe('asked');
  });

  test('поставщик найден: вид документа ничего не меняет', async () => {
    const world = buildSupplierWorld();
    await world.suppliers.upsert({ id: 's-known', name: 'Известный Поставщик' });
    const tool = declaredLookup();
    const input = tool.inputSchema.parse({ name: 'Известный Поставщик', documentKind: 'invoice' });
    const out = (await tool.execute(input, world.host, context())) as Record<string, unknown>;
    expect(out['status']).toBe('found');
  });

  test('вид документа обязателен во входе, схема плоская', () => {
    const tool = declaredLookup();
    expect(tool.inputSchema.constructor.name).toBe('ZodObject');
    expect(tool.inputSchema.safeParse({ name: NEW_NAME }).success).toBe(false);
  });

  test('в промпте: предложение только для договора, вид передаётся при поиске', () => {
    expect(agent.prompt).toContain('documentKind');
    expect(agent.prompt).toContain('только для договора');
  });
});

