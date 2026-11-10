import { describe, expect, test } from 'bun:test';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { lookupSupplierInBase } from '../../src/agents/suppliers/supplier-lookup';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import { buildSupplierWorld, turnContext } from './suppliers-support';
import { buildTemplateWorld } from './site-template-support';

/** Агент «Актуализация сайта»: поиск поставщика по базе (этап 182). Данные синтетические. */

const NEW_NAME = 'Новый Поставщик Б';
const SUPPLIER_COLUMN = 'название поставщика. Техническое поле';

describe('site-export: поставщик из базы', () => {
  test('декларация содержит оба инструмента, схемы плоские', () => {
    const agent = createSiteExportAgent({ model: 'test-model' });
    const names = agent.tools.map((tool) => tool.name);
    expect(names).toContain('lookupSupplierInBase');
    expect(names).toContain('recordSupplierLookupDecision');
    expect(new Set(names).size).toBe(names.length);
    expect(agent.prompt).toContain('lookupSupplierInBase');
  });

  test('поставщика нет в базе: файл заполнен, предложение добавить есть', async () => {
    const world = await buildTemplateWorld();
    const suppliers = buildSupplierWorld();
    const book = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const filled = await fillTemplateRows.execute(
      {
        workbookId: book.workbookId ?? '',
        items: [{ cells: [
          { column: 'Название', value: 'Тестовая кружка' },
          { column: SUPPLIER_COLUMN, value: NEW_NAME },
        ] }],
        requestedByEmployee: false,
        confirmedByEmployee: false,
        overwrite: false,
        stampManager: true,
      },
      world.deps,
      world.ctx,
    );
    expect(filled.skipped).toHaveLength(0);
    expect(filled.written).toBeGreaterThan(0);

    const ctx = turnContext('u-100', 'site-export/u-100', 'site-export');
    const out = await lookupSupplierInBase.execute({ name: NEW_NAME }, suppliers.host, ctx);
    expect(out.status).toBe('none');
    expect(out.question).toBe(`Поставщика «${NEW_NAME}» нет в базе. Добавить в базу?`);
    expect(await suppliers.suppliers.searchCards({ query: NEW_NAME, limit: 5 })).toHaveLength(0);
  });
});
