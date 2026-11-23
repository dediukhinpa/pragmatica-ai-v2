import { describe, expect, test } from 'bun:test';
import {
  MemoryPriceRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import {
  applySourceFileBackfill,
  planSourceFileBackfill,
  type BackfillDeps,
} from '../../src/agents/prices/source-file-backfill';
import { diskSyncThreadId } from '../../src/agents/prices/price-disk-sync';
import { DISK_SYNC_OUTCOME_NAMESPACE } from '../../src/agents/prices/disk-sync-outcome';
import { loadSupplierDiskFiles } from '../../src/agents/prices/supplier-file-history';
import type { PriceItem } from '../../src/kit/domain/models';
import { mergePriceLists } from '../../src/agents/suppliers/draft-merge';

const PRICE_DATE = '2026-10-01T00:00:00.000Z';
const MEDALS = 'Фабрика/Медали.xlsx';
const BADGES = 'Фабрика/Значки.xlsx';

function item(supplierId: string, name: string, sourceFile?: string): PriceItem {
  return {
    supplierId,
    productName: name,
    price: 10,
    currency: 'RUB',
    date: PRICE_DATE,
    ...(sourceFile === undefined ? {} : { sourceFile }),
  };
}

async function setup(): Promise<BackfillDeps & { state: MemoryWorkflowStateStore }> {
  const state = new MemoryWorkflowStateStore();
  const suppliers = new MemorySupplierRepository();
  const prices = new MemoryPriceRepository();
  for (const id of ['one', 'many', 'none', 'clean']) await suppliers.upsert({ id, name: id });
  return { state, suppliers, prices };
}

async function history(
  state: MemoryWorkflowStateStore,
  supplierId: string,
  hash: string,
  fileName: string,
  source: 'disk' | 'chat' = 'disk',
): Promise<void> {
  await state.put(IMPORT_META_NAMESPACE, `${supplierId}:${hash}`, {
    source,
    fileName,
    notes: [],
  });
}

describe('заполнение source_file задним числом (этап 117)', () => {
  test('один файл в истории - проставляется; несколько и ни одного - не трогаются', async () => {
    const deps = await setup();
    await deps.prices.saveImport('one', [item('one', 'A'), item('one', 'B')], 'k1');
    await deps.prices.saveImport('many', [item('many', 'A')], 'k2');
    await deps.prices.saveImport('none', [item('none', 'A')], 'k3');
    await deps.prices.saveImport('clean', [item('clean', 'A', MEDALS)], 'k4');
    await history(deps.state, 'one', 'h1', MEDALS);
    await history(deps.state, 'one', 'h1b', MEDALS);
    await history(deps.state, 'many', 'h2', MEDALS);
    await history(deps.state, 'many', 'h3', BADGES);
    await history(deps.state, 'none', 'h4', 'Чат', 'chat');

    const plan = await planSourceFileBackfill(deps, []);
    const byId = new Map(plan.entries.map((entry) => [entry.supplierId, entry]));
    expect(plan.entries.map((entry) => entry.supplierId).sort()).toEqual(['many', 'none', 'one']);
    expect(byId.get('one')).toMatchObject({ file: MEDALS, nullRows: 2 });
    expect(byId.get('many')).toMatchObject({ skip: 'several_files', historyFiles: 2 });
    expect(byId.get('none')).toMatchObject({ skip: 'no_history' });

    // План ничего не пишет.
    expect((await deps.prices.listBySupplier('one')).every((i) => i.sourceFile === undefined)).toBe(true);

    const result = await applySourceFileBackfill(deps, plan);
    expect(result).toEqual({ updated: 1, rows: 2, changed: 0 });
    expect((await deps.prices.listBySupplier('one')).map((i) => i.sourceFile)).toEqual([MEDALS, MEDALS]);
    expect((await deps.prices.listBySupplier('many'))[0]?.sourceFile).toBeUndefined();
    expect((await deps.prices.listBySupplier('none'))[0]?.sourceFile).toBeUndefined();
    expect((await deps.prices.listBySupplier('clean'))[0]?.sourceFile).toBe(MEDALS);
  });

  test('идемпотентность: повтор плана и записи ничего не меняет', async () => {
    const deps = await setup();
    await deps.prices.saveImport('one', [item('one', 'A')], 'k1');
    await history(deps.state, 'one', 'h1', MEDALS);
    await applySourceFileBackfill(deps, await planSourceFileBackfill(deps, []));
    const again = await planSourceFileBackfill(deps, []);
    expect(again.entries.filter((entry) => entry.supplierId === 'one')).toEqual([]);
    expect(await applySourceFileBackfill(deps, again)).toEqual({ updated: 0, rows: 0, changed: 0 });
    // Устаревший план после записи тоже безопасен.
    const stale = await planSourceFileBackfill(
      { ...deps, prices: new MemoryPriceRepository() },
      [],
    );
    expect(stale.entries).toEqual([]);
  });

  test('есть строки с файлом - строки без файла не получают файл', async () => {
    const deps = await setup();
    await deps.prices.saveImport('one', [item('one', 'A'), item('one', 'B', BADGES)], 'k1');
    await history(deps.state, 'one', 'h1', MEDALS);
    const plan = await planSourceFileBackfill(deps, []);
    expect(plan.entries).toMatchObject([{ supplierId: 'one', skip: 'has_file_rows' }]);
    expect(await applySourceFileBackfill(deps, plan)).toEqual({ updated: 0, rows: 0, changed: 0 });
  });

  test('файл, по которому итог не written, из истории исключается; черновик берётся из итогов', async () => {
    const deps = await setup();
    await deps.prices.saveImport('one', [item('one', 'A')], 'k1');
    await deps.prices.saveImport('many', [item('many', 'A')], 'k2');
    await history(deps.state, 'one', 'h1', MEDALS);
    await history(deps.state, 'one', 'h2', BADGES);
    const outcome = (status: string, draft?: string): Record<string, unknown> => ({
      run: 'r1',
      file: 'x.xlsx',
      status,
      at: PRICE_DATE,
      ...(draft === undefined ? {} : { draft: { supplierId: draft, name: 'Ч' } }),
    });
    await deps.state.put(DISK_SYNC_OUTCOME_NAMESPACE, diskSyncThreadId(BADGES), outcome('skipped') as never);
    await deps.state.put(DISK_SYNC_OUTCOME_NAMESPACE, diskSyncThreadId(MEDALS), outcome('written') as never);
    await deps.state.put(
      DISK_SYNC_OUTCOME_NAMESPACE,
      diskSyncThreadId('Фабрика/Другое.xlsx'),
      outcome('written', 'many') as never,
    );
    const plan = await planSourceFileBackfill(deps, [BADGES, MEDALS, 'Фабрика/Другое.xlsx']);
    const byId = new Map(plan.entries.map((entry) => [entry.supplierId, entry]));
    expect(byId.get('one')?.file).toBe(MEDALS);
    expect(byId.get('many')?.file).toBe('Фабрика/Другое.xlsx');
  });

  test('история поставщика читается по префиксу ключа без чужих id', async () => {
    const state = new MemoryWorkflowStateStore();
    await history(state, 'sup', 'a', MEDALS);
    await history(state, 'sup:x', 'b', BADGES);
    await history(state, 'sup2', 'c', BADGES);
    expect(await loadSupplierDiskFiles(state, 'sup')).toEqual([MEDALS]);
  });
});

describe('слияние карточек: прайс-линии разных файлов', () => {
  test('две карточки с разными source_file - после слияния обе линии', () => {
    const merged = mergePriceLists(
      'real',
      [item('real', 'Значок', BADGES), item('real', 'Только значки', BADGES)],
      [item('draft', 'Значок', MEDALS), item('draft', 'Только медали', MEDALS)],
    );
    expect(merged.map((row) => [row.productName, row.sourceFile])).toEqual([
      ['Значок', BADGES],
      ['Только значки', BADGES],
      ['Значок', MEDALS],
      ['Только медали', MEDALS],
    ]);
    expect(merged.every((row) => row.supplierId === 'real')).toBe(true);
  });

  test('тот же файл или строка без файла - по-прежнему одна позиция', () => {
    const merged = mergePriceLists(
      'real',
      [item('real', 'Значок', BADGES)],
      [item('draft', 'Значок', BADGES), item('draft', 'значок')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceFile).toBe(BADGES);
  });
});
