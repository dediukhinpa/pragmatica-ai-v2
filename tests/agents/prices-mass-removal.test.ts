import { beforeEach, describe, expect, test } from 'bun:test';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { findPriceJumps, nextConfirmedPrices } from '../../src/kit/domain/price-diff';
import { validatePriceImport } from '../../src/kit/domain/validators.owned';
import { CTX, SUPPLIER_ID } from './support';
import { buildFullPricesDeps, skuItem, stageDiskCsv, type FullPricesDeps } from './prices-support';

const TOTAL = 100;
let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  const seed = Array.from({ length: TOTAL }, (_, i) => skuItem(`Позиция ${i}`, 10, `S${i}`));
  await deps.prices.saveImport(SUPPLIER_ID, seed, 'seed', { sourceFile: 'price.csv' });
});

const rows = (count: number): Array<[string, number, string]> =>
  Array.from({ length: count }, (_, i) => [`Позиция ${i}`, 10, `S${i}`]);
const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });
const codes = async (fileHash: string) =>
  (await stagedImportValidator.validate(args(fileHash), deps, CTX)).map((i) => i.code);

describe('D-5: резкое сокращение прайса', () => {
  test('частичный файл (1 из 100) пишется как есть, снятие уходит в отчёт', async () => {
    const { fileHash } = await stageDiskCsv(deps, rows(1));
    // Решение владельца 26.10.2026: массовое снятие решения человека не требует.
    expect(await codes(fileHash)).toEqual([]);
    const preview = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    expect(preview.counts.removed).toBe(TOTAL - 1);
    await commitPriceImport.execute(args(fileHash), deps, CTX);
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(1);
  });

  test('потеря в пределах порога проходит без замечаний', async () => {
    const { fileHash } = await stageDiskCsv(deps, rows(80));
    expect(await codes(fileHash)).toEqual([]);
  });

  test('снятые позиции попадают в набор скачков для отчёта, вопроса человеку нет', async () => {
    const { fileHash } = await stageDiskCsv(deps, rows(1));
    const preview = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    expect(preview.counts.jumps).toBe(TOTAL - 1);
    expect(preview).not.toHaveProperty('approvalStatus');
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('домен: пустой прайс поставщика не даёт срабатывания', () => {
    expect(findPriceJumps([skuItem('A', 1, 'A')], [])).toEqual([]);
  });
});

describe('R2-D-5: нарезка снятия и малые прайсы', () => {
  const TEN = 10;

  test('домен: пустой файл при базе из 4 позиций - снятие всех позиций', () => {
    const existing = ['A', 'B', 'C', 'D'].map((sku) => skuItem(sku, 1, sku));
    const jumps = findPriceJumps([], existing);
    expect(jumps.filter((j) => j.removed === true)).toHaveLength(existing.length);
  });

  test('домен: частичное снятие в малой базе по-прежнему без порога', () => {
    const existing = ['A', 'B', 'C', 'D'].map((sku) => skuItem(sku, 1, sku));
    expect(findPriceJumps(existing.slice(0, 3), existing)).toEqual([]);
  });

  test('валидатор импорта: пустой файл при базе из 4 позиций даёт замечание о снятии', () => {
    const existing = ['A', 'B', 'C', 'D'].map((sku) => skuItem(sku, 1, sku));
    const issues = validatePriceImport({ sourceRowCount: 0, imported: [], existing });
    expect(issues.map((i) => i.code)).toContain('price_mass_removal');
  });

  test('нарезка 10 -> 7 -> 5 позиций: вторая порция записывается, снятие в отчёте', async () => {
    const seed = Array.from({ length: TEN }, (_, i) => skuItem(`Позиция ${i}`, 10, `S${i}`));
    await deps.prices.saveImport(SUPPLIER_ID, seed, 'ten', { sourceFile: 'price.csv' });
    const first = await stageDiskCsv(deps, rows(TEN).slice(0, 7));
    expect(await codes(first.fileHash)).toEqual([]);
    await commitPriceImport.execute(args(first.fileHash), deps, CTX);
    // 7 -> 5: от текущей базы это 28%, но от известных 10 позиций уже 50%.
    const second = await stageDiskCsv(deps, rows(TEN).slice(0, 5));
    expect(await codes(second.fileHash)).toEqual([]);
    const preview = await previewPriceChanges.execute(args(second.fileHash), deps, CTX);
    expect(preview.counts.jumps).toBeGreaterThan(0);
    await commitPriceImport.execute(args(second.fileHash), deps, CTX);
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(5);
  });

  test('записанное снятие закрепляет состав: следующий импорт не видит потерь', () => {
    const all = Array.from({ length: TEN }, (_, i) => skuItem(`П${i}`, 10, `S${i}`));
    const kept = all.slice(0, 2);
    const jumps = findPriceJumps(kept, all);
    const approved = new Set(jumps.map((j) => j.key));
    const confirmed = nextConfirmedPrices([], all, kept, approved);
    expect(confirmed).toHaveLength(kept.length);
    expect(findPriceJumps(kept, kept, undefined, confirmed)).toEqual([]);
  });
});
