import { beforeEach, describe, expect, test } from 'bun:test';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { assertDeclarationValid, type ToolContext } from '@business-ai/core';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { lookupSupplierInBase } from '../../src/agents/suppliers/supplier-lookup';
import { recordEmployeePriceUpdates } from '../../src/agents/prices/employee-updates';
import { recordSupplierLookupDecision } from '../../src/agents/suppliers/supplier-lookup-offer';
import { SUPPLIER_ID } from './support';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  skuItem,
  type FullPricesDeps,
} from './prices-support';
import { buildSupplierWorld, turnContext, type SupplierWorld } from './suppliers-support';

/** Агент прайсов: поиск поставщика по базе не блокирует основную работу (этап 182). */

const NEW_NAME = 'Новый Поставщик Прайсов';
const EMPLOYEE_CTX: ToolContext = turnContext('employee-1', EMPLOYEE_THREAD);

let deps: FullPricesDeps;
let world: SupplierWorld;

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  world = buildSupplierWorld();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт М8', 10, 'B8')], 'seed');
});

describe('prices: поставщика нет в базе', () => {
  test('основная задача выполнена, вопрос о добавлении приходит в итог, карточки нет', async () => {
    const host = { ...deps, supplierCards: world.deps };
    const found = await lookupSupplierInBase.execute({ name: NEW_NAME }, host, EMPLOYEE_CTX);
    expect(found.status).toBe('none');
    expect(found.offer).toBe('asked');
    expect(found.question).toContain(NEW_NAME);
    // Основная работа идёт независимо от результата поиска.
    const out = await recordEmployeePriceUpdates.execute(
      { supplierId: SUPPLIER_ID, updates: [{ sku: 'B8', price: 11 }] },
      deps,
      EMPLOYEE_CTX,
    );
    expect(out.applied).toHaveLength(1);
    expect(await world.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(0);
    // Отказ сотрудника карточку не создаёт.
    const declined = await recordSupplierLookupDecision.execute(
      { decision: 'decline' },
      host,
      EMPLOYEE_CTX,
    );
    expect(declined.status).toBe('declined');
    expect(await world.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(0);
  });

  test('без supplierCards в deps инструмент даёт unavailable, работа идёт', async () => {
    const out = await lookupSupplierInBase.execute({ name: NEW_NAME }, deps, EMPLOYEE_CTX);
    expect(out.status).toBe('unavailable');
  });
});

describe('prices: декларация', () => {
  test('оба инструмента есть всегда, схемы плоские, правило в промпте', () => {
    for (const options of [{}, { supplierCards: {} }]) {
      const declaration = createPricesAgent({ model: 'm', ...options });
      expect(() => assertDeclarationValid(declaration)).not.toThrow();
      for (const name of ['lookupSupplierInBase', 'recordSupplierLookupDecision']) {
        const tool = declaration.tools.find((candidate) => candidate.name === name);
        expect(tool).toBeDefined();
        const shape = (tool?.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
        expect(shape).toBeDefined();
        expect(JSON.stringify(Object.keys(shape))).not.toContain('{');
      }
      expect(declaration.prompt).toContain('lookupSupplierInBase');
    }
    expect(PRICES_PROMPT).toContain('recordSupplierLookupDecision');
  });
});
