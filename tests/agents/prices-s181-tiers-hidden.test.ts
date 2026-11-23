import { beforeEach, describe, expect, test } from 'bun:test';
import { MemorySupplierPriceScripts } from '../../src/kit/adapters/memory/supplier-price-scripts';
import { MAX_PRICE_TIERS } from '../../src/kit/domain/models';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { runDataScript } from '../../src/agents/prices/run-data-script';
import type {
  JsonValue,
  ParsedDocument,
  ScriptRunOutcome,
  ScriptRunRequest,
  ScriptSandbox,
} from '@business-ai/core';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';
import { CTX, SUPPLIER_ID, putFile } from './support';

/** Этап 181 (п.4): тиражи сверх лимита и скрытые листы - предупреждение, а не отказ/пропуск. */

const TIER_COUNT = MAX_PRICE_TIERS + 3;
const HEAD = ['Наименование', ...Array.from({ length: TIER_COUNT }, (_, i) => `от ${(i + 1) * 10}`)];
const ROW = ['Ручка', ...Array.from({ length: TIER_COUNT }, (_, i) => String(100 - i))];
const CSV = [HEAD.join(','), ROW.join(',')].join('\n');
const TIERS = Array.from({ length: TIER_COUNT }, (_, i) => ({
  column: i + 1,
  minQuantity: (i + 1) * 10,
}));
const INPUT = { path: 't.csv', supplierId: SUPPLIER_ID, columns: { name: 0, priceTiers: TIERS } };

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

describe('тиражи сверх MAX_PRICE_TIERS', () => {
  test('normalizePriceTable: первые 8, предупреждение с числом отброшенных', async () => {
    putFile(deps, 't.csv', CSV);
    const out = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse(INPUT),
      deps,
      CTX,
    );
    expect(out.rejected).toEqual([]);
    expect(out.items[0]?.priceTiers).toHaveLength(MAX_PRICE_TIERS);
    expect(out.items[0]?.priceTiers?.[0]?.minQuantity).toBe(10);
    expect(out.warnings.join(' ')).toContain(`отброшено: ${TIER_COUNT - MAX_PRICE_TIERS}`);
  });

  test('savePriceImport и stagePriceRows тоже несут предупреждение', async () => {
    putFile(deps, 't.csv', CSV);
    const norm = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse(INPUT),
      deps,
      CTX,
    );
    const staged = await stagePriceRows.execute(
      stagePriceRows.inputSchema.parse({ ...INPUT, reset: true }),
      deps,
      CTX,
    );
    expect(staged.warnings?.join(' ')).toContain('отброшено: 3');
    const saved = await savePriceImport.execute(
      savePriceImport.inputSchema.parse({ ...INPUT, fileHash: norm.fileHash }),
      deps,
      CTX,
    );
    expect(saved.warnings?.join(' ')).toContain('отброшено: 3');
  });

  test('скрипт: лишние тиражи обрезаны, позиция принята, предупреждение в сводке', async () => {
    const file = 'Прайсы/тиражи.csv';
    putFile(deps, file, 'Наименование,Цена\nРучка,100\n');
    const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
      min_quantity: (i + 1) * 10,
      price: 100,
    }));
    class Fake implements ScriptSandbox {
      async run(_request: ScriptRunRequest): Promise<ScriptRunOutcome> {
        const result: JsonValue = [{ name: 'Ручка', price: 100, tiers }];
        return {
          ok: true,
          result,
          stats: {
            durationMs: 1, queueMs: 0, codeBytes: 1, inBytes: 1, fileBytes: 0, outBytes: 1,
            exitCode: 0, uidSwitched: true,
          },
        };
      }
    }
    deps.scriptSandbox = new Fake();
    deps.priceScripts = new MemorySupplierPriceScripts();
    const out = await runDataScript.execute(
      { code: 'def run(t, s):\n    return []\n', fileRef: file, resultKind: 'price_items',
        supplierId: SUPPLIER_ID },
      deps,
      CTX,
    );
    expect(out).toMatchObject({ ok: true });
    expect(JSON.stringify(out)).toContain('отброшено тиражей: 3');
  });
});

describe('скрытый лист в разборе', () => {
  const TABLE = [['Товар', 'Цена'], ['Лента', '10']];
  const text = [
    '## Лист: Скрытый [hidden]',
    '| Товар | Цена |',
    '| --- | --- |',
    '| Лента | 10 |',
  ].join('\n');
  const parsed: ParsedDocument = {
    text,
    tables: [TABLE],
    needsOcr: false,
    hasHiddenContent: true,
    hiddenSheets: ['Скрытый'],
    truncated: false,
    warnings: [],
  };

  test('normalizePriceTable читает таблицу и предупреждает, что лист скрыт', async () => {
    putFile(deps, 'h.xlsx', 'x');
    const stub = { ...deps, parser: { parse: async () => parsed } };
    const out = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse({
        path: 'h.xlsx',
        supplierId: SUPPLIER_ID,
        columns: { name: 0, price: 1 },
      }),
      stub,
      CTX,
    );
    expect(out.items).toHaveLength(1);
    expect(out.warnings.join(' ')).toContain('скрытого листа «Скрытый»');
  });
});
