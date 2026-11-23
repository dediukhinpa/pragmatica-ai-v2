import { beforeEach, describe, expect, test } from 'bun:test';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { listStalePriceSuppliers } from '../../src/agents/prices/stale-price-suppliers';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { parsePriceCell, parseTableRows } from '../../src/agents/prices/table-rows';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { recordEmployeePriceUpdates } from '../../src/agents/prices/employee-updates';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { isDomainError } from '@business-ai/core';
import { CTX, SUPPLIER_ID, existingPrice, putFile } from './support';
import { COLUMNS, buildFullPricesDeps, skuItem, type FullPricesDeps } from './prices-support';

/** Правки со слов сотрудника записывает только ход сотрудника (R7-07). */
const EMPLOYEE_CTX = { ...CTX, initiator: { kind: 'user', userId: 'employee-1' } } as const;

const DAY_MS = 86_400_000;
/** Дней без обновления: заведомо больше трёх календарных месяцев. */
const STALE_DAYS_AGO = 100;
let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

const PARAMS = {
  supplierId: 's1',
  headerRows: 1,
  columns: { name: 0, price: 1 },
  defaultCurrency: 'RUB',
  date: '2026-10-01',
};

describe('R4-ALG-1: строки «не позиция»', () => {
  test('заголовок группы и «Итого» не позиции и не строки исходника', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Цена'],
        ['Крепёж', ''],
        ['Болт М8', '10,50'],
        ['Гайка М8', '5'],
        ['Итого', '15,5'],
      ],
      PARAMS,
    );
    expect(out.items.map((i) => [i.productName, i.price])).toEqual([
      ['Болт М8', 10.5],
      ['Гайка М8', 5],
    ]);
    expect(out.skipped.map((s) => s.row)).toEqual([1, 4]);
    expect(out.rejected).toEqual([]);
    expect(out.sourceRowCount).toBe(2);
  });

  test('«по запросу», вторая шапка, нулевая цена, ноль без названия', () => {
    const out = parseTableRows(
      [
        ['Наименование', 'Цена'],
        ['Болт', '10'],
        ['Анкер', 'по запросу'],
        ['Наименование', 'Цена'],
        ['Шайба', '0'],
        ['', '0'],
        ['Примечание: цены с НДС', ''],
        ['Всего по группе', '100'],
      ],
      PARAMS,
    );
    expect(out.items.map((i) => i.productName)).toEqual(['Болт']);
    expect(out.skipped).toHaveLength(6);
    expect(out.rejected).toEqual([]);
    expect(out.sourceRowCount).toBe(1);
  });

  test('реально битая строка (название и нечисловая цена) остаётся в rejected', () => {
    const out = parseTableRows(
      [['Наименование', 'Цена'], ['Болт', 'abc'], ['Гайка', '5']],
      PARAMS,
    );
    expect(out.rejected).toEqual([{ row: 1, reason: 'цена не распознана' }]);
    expect(out.skipped).toEqual([]);
    expect(out.sourceRowCount).toBe(2);
  });

  test('normalizePriceTable и savePriceImport: прайс с группами записывается', async () => {
    putFile(deps, 'p.csv', 'Наименование,Цена\nКрепёж,\nБолт М8,10\nГайка М8,5\nИтого,15');
    const input = { path: 'p.csv', supplierId: SUPPLIER_ID, columns: { name: 0, price: 1 } };
    const out = await normalizePriceTable.execute(input, deps, CTX);
    expect(out.items).toHaveLength(2);
    expect(out.skippedCount).toBe(2);
    expect(out.skippedRows).toHaveLength(2);
    expect(out.sourceRowCount).toBe(2);
    const saveInput = { ...input, tableIndex: 0, headerRows: 1, fileHash: out.fileHash };
    const parsed = savePriceImport.inputSchema.parse(saveInput);
    expect(await priceImportValidator.validate(parsed, deps, CTX)).toEqual([]);
    const saved = await savePriceImport.execute(parsed, deps, CTX);
    expect(saved.saved).toBe(2);
  });

  test('stagePriceRows + commitPriceImport: пропущенные строки не блокируют', async () => {
    putFile(deps, 'p.csv', 'Наименование,Цена\nКрепёж,\nБолт М8,10\nГайка М8,5\nИтого,15');
    const staged = await stagePriceRows.execute(
      { path: 'p.csv', supplierId: SUPPLIER_ID, columns: { name: 0, price: 1 }, reset: true },
      deps,
      CTX,
    );
    expect(staged.staged).toBe(2);
    expect(staged.tableDataRows).toBe(2);
    expect(staged.skippedCount).toBe(2);
    expect(staged.rejectedCount).toBe(0);
    const input = { supplierId: SUPPLIER_ID, fileHash: staged.fileHash };
    expect(await stagedImportValidator.validate(input, deps, CTX)).toEqual([]);
    const preview = await previewPriceChanges.execute(input, deps, CTX);
    expect(preview.skippedRowCount).toBe(2);
    const done = await commitPriceImport.execute(input, deps, CTX);
    expect(done.saved).toBe(2);
  });
});

describe('R4-ALG-3: валюта из заголовка столбца цены', () => {
  async function normalizeWith(header: string, extra: Record<string, unknown> = {}) {
    putFile(deps, 'c.csv', `Наименование,${header}\nБолт,12.5`);
    return normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse({
        path: 'c.csv',
        supplierId: SUPPLIER_ID,
        columns: { name: 0, price: 1 },
        ...extra,
      }),
      deps,
      CTX,
    );
  }

  test('USD, ¥, ₽ и руб. из заголовка', async () => {
    expect((await normalizeWith('Цена USD')).items[0]?.currency).toBe('USD');
    expect((await normalizeWith('Цена (¥)')).items[0]?.currency).toBe('CNY');
    expect((await normalizeWith('Цена (₽)')).items[0]?.currency).toBe('RUB');
    expect((await normalizeWith('Цена руб.')).items[0]?.currency).toBe('RUB');
    expect((await normalizeWith('Цена')).items[0]?.currency).toBe('RUB');
  });

  test('совпадающий defaultCurrency допустим, расходящийся - валюта заголовка и предупреждение',
    async () => {
    expect((await normalizeWith('Цена USD', { defaultCurrency: 'USD' })).items[0]?.currency)
      .toBe('USD');
    const out = await normalizeWith('Цена USD', { defaultCurrency: 'RUB' });
    expect(out.items[0]?.currency).toBe('USD');
    expect(out.warnings.join(' ')).toContain('defaultCurrency проигнорирована');
  });

  test('stagePriceRows при расхождении берёт валюту заголовка и предупреждает', async () => {
    putFile(deps, 'c.csv', 'Наименование,Цена EUR\nБолт,12.5');
    const out = await stagePriceRows
      .execute(
        stagePriceRows.inputSchema.parse({
          path: 'c.csv',
          supplierId: SUPPLIER_ID,
          columns: { name: 0, price: 1 },
          defaultCurrency: 'USD',
          reset: true,
        }),
        deps,
        CTX,
      );
    expect(out.staged).toBe(1);
    expect(out.warnings?.join(' ')).toContain('EUR');
  });

  test('savePriceImport: расхождение валюты не блокирует, предупреждение в ответе', async () => {
    putFile(deps, 'c.csv', 'Наименование,Цена USD\nБолт,12.5');
    const norm = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse({
        path: 'c.csv', supplierId: SUPPLIER_ID, columns: { name: 0, price: 1 },
      }),
      deps,
      CTX,
    );
    const input = savePriceImport.inputSchema.parse({
      path: 'c.csv',
      supplierId: SUPPLIER_ID,
      columns: { name: 0, price: 1 },
      defaultCurrency: 'RUB',
      fileHash: norm.fileHash,
    });
    const issues = await priceImportValidator.validate(input, deps, CTX);
    expect(issues.map((i) => i.code)).not.toContain('currency_mismatch');
    const out = await savePriceImport.execute(input, deps, CTX);
    expect(out.warnings?.join(' ')).toContain('defaultCurrency проигнорирована');
  });

  test('новая позиция сотрудника берёт преобладающую валюту поставщика', async () => {
    const usd = (name: string, price: number) => ({
      ...skuItem(name, price, name),
      currency: 'USD',
    });
    await deps.prices.saveImport(SUPPLIER_ID, [usd('A', 1), usd('B', 2), usd('C', 3)], 'seed');
    const out = await recordEmployeePriceUpdates.execute(
      recordEmployeePriceUpdates.inputSchema.parse({
        supplierId: SUPPLIER_ID,
        updates: [{ productName: 'Новая', price: 7, addIfMissing: true }],
      }),
      deps,
      EMPLOYEE_CTX,
    );
    expect(out.applied[0]).toMatchObject({ isNew: true, currency: 'USD' });
  });
});

describe('R4-ALG-9: общий список валют', () => {
  test('символы и коды в ячейке цены', () => {
    expect(parsePriceCell('1200 ¥')).toEqual({ kind: 'ok', value: 1200, currency: 'CNY' });
    expect(parsePriceCell('1200 CNY')).toEqual({ kind: 'ok', value: 1200, currency: 'CNY' });
    expect(parsePriceCell('1200 ₸')).toEqual({ kind: 'ok', value: 1200, currency: 'KZT' });
    expect(parsePriceCell('1200 тенге')).toEqual({ kind: 'ok', value: 1200, currency: 'KZT' });
    expect(parsePriceCell('¥1200')).toEqual({ kind: 'ok', value: 1200, currency: 'CNY' });
    expect(parsePriceCell('100 руб.')).toEqual({ kind: 'ok', value: 100, currency: 'RUB' });
  });

  test('R4-ALG-8 в ячейке цены', () => {
    expect(parsePriceCell('10 20')).toEqual({ kind: 'invalid' });
    expect(parsePriceCell('100 120')).toEqual({ kind: 'ok', value: 100120, currency: undefined });
    expect(parsePriceCell('12 500')).toEqual({ kind: 'ok', value: 12500, currency: undefined });
  });
});

describe('R4-ALG-11: свежесть прайса и правка словами сотрудника', () => {
  test('правка позиции не делает поставщика обновлявшимся, загрузка файла делает', async () => {
    const old = new Date(deps.clock.now().getTime() - STALE_DAYS_AGO * DAY_MS).toISOString();
    await deps.prices.saveImport(
      SUPPLIER_ID,
      [{ ...existingPrice('Болт', 10), sku: 'B1', date: old }],
      'seed',
    );
    const before = await listStalePriceSuppliers.execute({}, deps, CTX);
    expect(before.suppliers[0]).toMatchObject({
      supplierId: SUPPLIER_ID,
      daysSinceUpdate: STALE_DAYS_AGO,
    });

    const edit = await recordEmployeePriceUpdates.execute(
      recordEmployeePriceUpdates.inputSchema.parse({
        supplierId: SUPPLIER_ID,
        updates: [{ sku: 'B1', price: 11 }],
      }),
      deps,
      EMPLOYEE_CTX,
    );
    const input = { supplierId: SUPPLIER_ID, fileHash: edit.fileHash ?? '' };
    await commitPriceImport.execute(input, deps, CTX);
    // Правка словами - предложение, а не база.
    expect((await deps.prices.listBySupplier(SUPPLIER_ID))[0]?.price).toBe(10);
    const after = await listStalePriceSuppliers.execute({}, deps, CTX);
    expect(after.suppliers[0]).toMatchObject({
      supplierId: SUPPLIER_ID,
      daysSinceUpdate: STALE_DAYS_AGO,
    });

    putFile(deps, 'f.csv', 'Наименование,Цена,Артикул\nБолт,11.5,B1');
    const norm = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse({
        path: 'f.csv', supplierId: SUPPLIER_ID, columns: COLUMNS,
      }),
      deps,
      CTX,
    );
    await savePriceImport.execute(
      savePriceImport.inputSchema.parse({
        path: 'f.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, fileHash: norm.fileHash,
      }),
      deps,
      CTX,
    );
    const fresh = await listStalePriceSuppliers.execute({}, deps, CTX);
    expect(fresh.suppliers).toEqual([]);
  });
});
