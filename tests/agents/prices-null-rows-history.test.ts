import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource, MemoryScheduler } from '@business-ai/adapters';
import { MemoryPriceRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { diskSyncThreadId, runPriceDiskSync } from '../../src/agents/prices/price-disk-sync';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { savePriceImport } from '../../src/agents/prices/save-price-import';
import { DISK_SYNC_OUTCOME_NAMESPACE } from '../../src/agents/prices/disk-sync-outcome';
import { loadSupplierDiskFiles } from '../../src/agents/prices/supplier-file-history';
import type { PriceItem } from '../../src/kit/domain/models';
import type { IdGenerator } from '@business-ai/core';
import { buildFullPricesDeps, encode, type FullPricesDeps } from './prices-support';

/**
 * Этап 123: импорт файла не стирает строки поставщика без `source_file` из другого файла
 * (сценарий Mida Vaneri: «сумки» без файла, импорт «мешков»). Всё на синтетике.
 */

let counter = 0;
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(counter += 1)}` };
const MTIME = 1_000;
const COLUMNS = { name: 0, price: 1 };
const SUPPLIER = 'sup-mida';
const BAGS = 'Mida/сумки.csv';
const SACKS = 'Mida/мешки.csv';

const diskCtx = (path: string): ToolContext =>
  createToolContext({
    threadId: diskSyncThreadId(path),
    agentId: PRICES_AGENT_ID,
    operationId: `op-${path}`,
  });

let deps: FullPricesDeps;
let scheduler: MemoryScheduler;

const put = (path: string, text: string): void =>
  (deps.files as MemoryFileSource).put(path, encode(text), MTIME);
const legacy = (name: string): PriceItem => ({
  supplierId: SUPPLIER,
  productName: name,
  price: 10,
  currency: 'RUB',
  date: '2026-10-01T00:00:00.000Z',
});
const names = async (): Promise<string[]> =>
  (await deps.prices.listBySupplier(SUPPLIER)).map((i) => i.productName).sort();

/** Импорт файла как делает агент: тред с итогом в очереди, разбор, запись. */
async function importFile(path: string): Promise<void> {
  const ctx = diskCtx(path);
  const table = await normalizePriceTable.execute(
    { path, supplierId: SUPPLIER, columns: COLUMNS },
    deps,
    ctx,
  );
  await savePriceImport.execute(
    { path, supplierId: SUPPLIER, fileHash: table.fileHash, columns: COLUMNS },
    deps,
    ctx,
  );
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  scheduler = new MemoryScheduler(ids);
  await deps.suppliers.upsert({ id: SUPPLIER, name: 'Mida Vaneri' });
});

describe('строки без файла и импорт другого файла (этап 123)', () => {
  test('сценарий Mida: «сумки» без файла, истории нет, импорт «мешков» - сумки целы', async () => {
    await deps.prices.saveImport(SUPPLIER, [legacy('Сумка 1'), legacy('Сумка 2')], 'legacy');
    put(SACKS, 'Наименование,Цена\nМешок 1,5\nМешок 2,6');
    await runPriceDiskSync(deps, scheduler, { initialImport: true });
    await importFile(SACKS);
    expect(await names()).toEqual(['Мешок 1', 'Мешок 2', 'Сумка 1', 'Сумка 2']);
  });

  test('строки без файла - прежняя версия того же прайса (пары по названию) - обновляются', async () => {
    await deps.prices.saveImport(SUPPLIER, [legacy('Мешок 1'), legacy('Мешок 2')], 'legacy');
    put(SACKS, 'Наименование,Цена\nМешок 1,7\nМешок 2,8\nМешок 3,9');
    await runPriceDiskSync(deps, scheduler, { initialImport: true });
    await importFile(SACKS);
    expect(await names()).toEqual(['Мешок 1', 'Мешок 2', 'Мешок 3']);
  });

  test('запись в существующую карточку: в итоге supplierId и путь, история видит файл', async () => {
    put(SACKS, 'Наименование,Цена\nМешок 1,5');
    await runPriceDiskSync(deps, scheduler, { initialImport: true });
    await importFile(SACKS);
    const entries = await deps.state.list(DISK_SYNC_OUTCOME_NAMESPACE, null, 10);
    const outcome = entries.map((e) => e.value as Record<string, unknown>);
    expect(outcome.some((o) => o['supplierId'] === SUPPLIER && o['path'] === SACKS)).toBe(true);
    expect(await loadSupplierDiskFiles(deps.state, SUPPLIER)).toContain(SACKS);
  });

  test('история через import-meta: на пути малого прайса запись с fileName есть', async () => {
    put(BAGS, 'Наименование,Цена\nСумка 1,5');
    await runPriceDiskSync(deps, scheduler, { initialImport: true });
    await importFile(BAGS);
    // Следующий импорт другого потока видит BAGS и не заменяет строки без файла.
    expect(await loadSupplierDiskFiles(deps.state, SUPPLIER)).toEqual([BAGS]);
  });
});

describe('память: построчная замена NULL-строк', () => {
  test('пары обновлены и получили файл, новые добавлены, несовпавшие целы', async () => {
    const repo = new MemoryPriceRepository();
    await repo.saveImport(SUPPLIER, [legacy('Мешок 1'), legacy('Мешок 2'), legacy('Сумка 1')], 'l');
    await repo.saveImport(SUPPLIER, [{ ...legacy('мешок 1'), price: 99 }, legacy('Мешок 3')], 'n', {
      sourceFile: SACKS,
    });
    const rows = await repo.listBySupplier(SUPPLIER);
    expect(rows.map((i) => [i.productName, i.price, i.sourceFile])).toEqual([
      ['Мешок 2', 10, undefined],
      ['Сумка 1', 10, undefined],
      ['мешок 1', 99, SACKS],
      ['Мешок 3', 10, SACKS],
    ]);
  });
});

describe('память: sha256 файла в ключе импорта (этап 123)', () => {
  test('тот же файл - NULL-строки заменяются, другой - остаются', async () => {
    const repo = new MemoryPriceRepository();
    const hash = 'd'.repeat(64);
    await repo.saveImport(SUPPLIER, [legacy('Старый')], `price-import:${SUPPLIER}:${hash}:base:q`);
    expect(await repo.hasNullRowsFromFile(SUPPLIER, hash)).toBe(true);
    await repo.saveImport(SUPPLIER, [legacy('Иной')], 'k1', { sourceFile: SACKS, fileHash: 'e'.repeat(64) });
    expect((await repo.listBySupplier(SUPPLIER)).map((i) => i.productName).sort()).toEqual(['Иной', 'Старый']);
    const fresh = new MemoryPriceRepository();
    await fresh.saveImport(SUPPLIER, [legacy('Старый')], `price-import:${SUPPLIER}:${hash}:base:q`);
    await fresh.saveImport(SUPPLIER, [legacy('Новый')], 'k2', { sourceFile: SACKS, fileHash: hash });
    expect((await fresh.listBySupplier(SUPPLIER)).map((i) => i.productName)).toEqual(['Новый']);
  });
});
