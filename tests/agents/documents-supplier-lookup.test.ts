import { describe, expect, test } from 'bun:test';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { getSupplierRequisites } from '../../src/agents/documents/get-supplier-requisites';
import { lookupSupplierInBase } from '../../src/agents/suppliers/supplier-lookup';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { recordSupplierLookupDecision } from '../../src/agents/suppliers/supplier-lookup-offer';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { THREAD_A, USER_A, buildSupplierWorld, turnContext } from './suppliers-support';

/** Агент «Документы» и поиск поставщика по базе (этап 182). Данные синтетические. */

const NEW_NAME = 'Новый Поставщик Д';
const QUESTION = `Поставщика «${NEW_NAME}» нет в базе. Добавить в базу?`;

const agent = createDocumentsAgent({ model: 'm' });
const names = agent.tools.map((tool) => tool.name);

describe('documents: декларация и промпт', () => {
  test('оба инструмента поиска на месте, прежние не потеряны', () => {
    expect(names).toContain('lookupSupplierInBase');
    expect(names).toContain('recordSupplierLookupDecision');
    expect(names).toContain('getSupplierRequisites');
    expect(names).toContain('prepareSupplierDocument');
    expect(new Set(names).size).toBe(names.length);
  });

  test('схемы входа плоские: type=object без объединений', () => {
    for (const tool of [lookupSupplierInBase, recordSupplierLookupDecision]) {
      expect(tool.inputSchema.constructor.name).toBe('ZodObject');
    }
  });

  test('в промпте есть короткое правило про поставщика и маркеры', () => {
    expect(agent.prompt).toContain('lookupSupplierInBase');
    expect(agent.prompt).toContain('recordSupplierLookupDecision');
  });
});

describe('documents: поставщика нет в базе', () => {
  test('поиск даёт none и вопрос, документ собирается дальше, без блокировки', async () => {
    const world = buildSupplierWorld();
    const ctx = turnContext(USER_A, THREAD_A, 'documents');
    const out = await lookupSupplierInBase.execute({ name: NEW_NAME }, world.host, ctx);
    expect(out.status).toBe('none');
    expect(out.offer).toBe('asked');
    expect(out.question).toBe(QUESTION);
    // Карточка без явного «да» не создана.
    expect(await world.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(0);

    // Сборка по карточке невозможна, но это не отказ: подсказка собрать с маркерами (этап 176).
    const deps = { suppliers: new MemorySupplierRepository() } as unknown as DocumentsDeps;
    const prepared = await prepareSupplierDocument.execute(
      { kind: 'contract', supplierId: 'нет' },
      deps,
      ctx,
    );
    expect(prepared.ready).toBe(false);
    expect(prepared.questions.join(' ')).toContain('маркеры');
    const requisites = await getSupplierRequisites.execute({ supplierId: 'нет' }, deps, ctx);
    expect(requisites.found).toBe(false);
  });

  test('без зависимостей карточек поиск unavailable, работа продолжается', async () => {
    const ctx = turnContext(USER_A, THREAD_A, 'documents');
    const out = await lookupSupplierInBase.execute({ name: NEW_NAME }, {}, ctx);
    expect(out.status).toBe('unavailable');
  });
});
