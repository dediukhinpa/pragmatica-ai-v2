import { describe, expect, test } from 'bun:test';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { isDomainError } from '@business-ai/core';
import { CTX, SUPPLIER_ID, putFile } from './support';
import { COLUMNS, buildFullPricesDeps, skuCsv, skuItem } from './prices-support';

/** Окружение: база из 10 позиций, файл с 9 из них, парсер сообщает truncated=true. */
async function truncatedSetup() {
  const deps = await buildFullPricesDeps();
  const seed = Array.from({ length: 10 }, (_, i) => skuItem(`Позиция ${i}`, 10 + i, `S${i}`));
  await deps.prices.saveImport(SUPPLIER_ID, seed, 'seed');
  const rows = seed
    .slice(0, 9)
    .map((s): [string, number, string] => [s.productName, s.price, s.sku ?? '']);
  putFile(deps, 'price.csv', skuCsv(rows));
  const inner = deps.parser;
  const parser = {
    parse: async (...args: Parameters<typeof inner.parse>) => ({
      ...(await inner.parse(...args)),
      truncated: true,
    }),
  };
  return { deps: { ...deps, parser }, seed };
}

describe('R4-AGT-2: truncated парсера', () => {
  test('ветка staging: file_truncated в проверке и фиксация блокируется', async () => {
    const { deps, seed } = await truncatedSetup();
    const staged = await stagePriceRows.execute(
      { path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      CTX,
    );
    expect(staged.truncated).toBe(true);
    const input = { supplierId: SUPPLIER_ID, fileHash: staged.fileHash };
    const issues = await stagedImportValidator.validate(input, deps, CTX);
    expect(issues.map((i) => i.code)).toContain('file_truncated');
    const err = await commitPriceImport.execute(input, deps, CTX).catch((e: unknown) => e);
    expect(isDomainError(err) && err.code).toBe('validation_failed');
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).length).toBe(seed.length);
    const preview = await previewPriceChanges.execute(input, deps, CTX);
    expect(preview.truncated).toBe(true);
  });

  test('ветка staging: признак сохраняется, даже если усечён только один из кусков', async () => {
    const { deps } = await truncatedSetup();
    const first = await stagePriceRows.execute(
      { path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true, toRow: 3 },
      deps,
      CTX,
    );
    const staged = await deps.staging.load(`${SUPPLIER_ID}:${first.fileHash}`);
    expect(staged?.truncated).toBe(true);
  });

  test('ветка save: file_truncated в проверке и запись блокируется', async () => {
    const { deps, seed } = await truncatedSetup();
    const norm = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse({
        path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS,
      }),
      deps,
      CTX,
    );
    const input = savePriceImport.inputSchema.parse({
      path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, fileHash: norm.fileHash,
    });
    const issues = await priceImportValidator.validate(input, deps, CTX);
    expect(issues.map((i) => i.code)).toContain('file_truncated');
    const err = await savePriceImport.execute(input, deps, CTX).catch((e: unknown) => e);
    expect(isDomainError(err) && err.code).toBe('validation_failed');
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).length).toBe(seed.length);
  });

  test('без усечения проверка file_truncated не срабатывает', async () => {
    const deps = await buildFullPricesDeps();
    putFile(deps, 'price.csv', skuCsv([['Болт', 10, 'B1']]));
    const staged = await stagePriceRows.execute(
      { path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      CTX,
    );
    expect(staged.truncated).toBe(false);
    const issues = await stagedImportValidator.validate(
      { supplierId: SUPPLIER_ID, fileHash: staged.fileHash },
      deps,
      CTX,
    );
    expect(issues.map((i) => i.code)).not.toContain('file_truncated');
  });
});
