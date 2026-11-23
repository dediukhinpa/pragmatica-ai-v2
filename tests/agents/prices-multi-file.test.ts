import { beforeEach, describe, expect, test } from 'bun:test';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { CTX, SUPPLIER_ID } from './support';
import { buildFullPricesDeps, skuItem, stageDiskCsv, type FullPricesDeps } from './prices-support';

/** Тема D: у поставщика несколько прайс-файлов (значки, медали), версии заменяют друг друга. */

const BADGES = 'Фабрика/Значки.csv';
const MEDALS = 'Фабрика/Медали.csv';
const MEDALS_OLD = 'Фабрика/Медали_05_05_2026.csv';
const MEDALS_NEW = 'Фабрика/Медали_01.10.2026.csv';

type Row = [string, number, string];
const badges: Row[] = [['Значок круглый', 50, 'B1'], ['Значок квадратный', 60, 'B2']];
const medals: Row[] = [['Медаль золото', 300, 'M1'], ['Медаль серебро', 250, 'M2']];

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });
async function load(rows: Row[], path: string): Promise<string> {
  const { fileHash } = await stageDiskCsv(deps, rows, path);
  return fileHash;
}
async function commit(rows: Row[], path: string): Promise<void> {
  await commitPriceImport.execute(args(await load(rows, path)), deps, CTX);
}
const names = async (): Promise<string[]> =>
  (await deps.prices.listBySupplier(SUPPLIER_ID)).map((item) => item.productName).sort();

describe('D: несколько прайс-файлов поставщика', () => {
  test('значки + медали - обе линии в базе, с source_file', async () => {
    await commit(badges, BADGES);
    await commit(medals, MEDALS);
    expect(await names()).toEqual([
      'Значок круглый', 'Значок квадратный', 'Медаль золото', 'Медаль серебро',
    ].sort());
    const files = new Set((await deps.prices.listBySupplier(SUPPLIER_ID)).map((i) => i.sourceFile));
    expect(files).toEqual(new Set([BADGES, MEDALS]));
  });

  test('второй файл: «снятых» нет и валидатор молчит', async () => {
    await commit(badges, BADGES);
    const hash = await load(medals, MEDALS);
    expect(await stagedImportValidator.validate(args(hash), deps, CTX)).toEqual([]);
    const preview = await previewPriceChanges.execute(args(hash), deps, CTX);
    expect(preview.counts.removed).toBe(0);
    expect(preview.counts.jumps).toBe(0);
  });

  test('повтор медалей с другой ценой: значки целы, снятое считается только по медалям', async () => {
    await commit(badges, BADGES);
    await commit(medals, MEDALS);
    const next: Row[] = [['Медаль золото', 310, 'M1']];
    const hash = await load(next, MEDALS);
    const preview = await previewPriceChanges.execute(args(hash), deps, CTX);
    expect(preview.counts.removed).toBe(1);
    await commitPriceImport.execute(args(hash), deps, CTX);
    expect(await names()).toEqual(['Значок круглый', 'Значок квадратный', 'Медаль золото'].sort());
  });

  test('новая версия по дате заменяет старую, старая дата не перетирает новую', async () => {
    await commit(badges, BADGES);
    await commit(medals, MEDALS_OLD);
    await commit([['Медаль платина', 900, 'M9']], MEDALS_NEW);
    expect(await names()).toEqual(['Значок круглый', 'Значок квадратный', 'Медаль платина'].sort());
    const hash = await load(medals, MEDALS_OLD);
    const codes = (await stagedImportValidator.validate(args(hash), deps, CTX)).map((i) => i.code);
    expect(codes).toContain('older_price_version');
    await expect(commitPriceImport.execute(args(hash), deps, CTX)).rejects.toThrow();
    expect(await names()).toContain('Медаль платина');
  });

  test('строки без файла другой линии (этап 123) не заменяются ни первым, ни следующим файлом', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Старая позиция', 5, 'O1')], 'legacy');
    await commit(badges, BADGES);
    expect(await names()).toEqual(['Значок круглый', 'Значок квадратный', 'Старая позиция'].sort());
    await commit(medals, MEDALS);
    expect(await names()).toHaveLength(5);
  });

  test('строки без файла при уже загруженном файле остаются', async () => {
    await commit(badges, BADGES);
    await deps.prices.saveImport(SUPPLIER_ID, [
      ...(await deps.prices.listBySupplier(SUPPLIER_ID)),
      skuItem('Ручная позиция', 7, 'H1'),
    ], 'manual');
    await commit(medals, MEDALS);
    expect(await names()).toContain('Ручная позиция');
    expect(await names()).toHaveLength(5);
  });

  test('этап 117: история говорит про другой файл - строки без файла остаются', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Старый значок', 5, 'O1')], 'legacy');
    // Строки без файла пришли из прайса значков (так записала история до этапа 116).
    await deps.state.put(IMPORT_META_NAMESPACE, `${SUPPLIER_ID}:old-badges`, {
      source: 'disk',
      fileName: BADGES,
      notes: [],
    });
    await commit(medals, MEDALS);
    expect(await names()).toEqual(['Медаль золото', 'Медаль серебро', 'Старый значок'].sort());
  });

  test('этап 117: история на тот же поток - строки без файла заменяются', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Старая медаль', 5, 'O1')], 'legacy');
    await deps.state.put(IMPORT_META_NAMESPACE, `${SUPPLIER_ID}:old-medals`, {
      source: 'disk',
      fileName: MEDALS_OLD,
      notes: [],
    });
    await commit(medals, MEDALS_NEW);
    expect(await names()).toEqual(['Медаль золото', 'Медаль серебро'].sort());
  });
});
