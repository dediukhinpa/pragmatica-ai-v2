import { beforeEach, describe, expect, test } from 'bun:test';
import { MemorySupplierPriceScripts } from '../../src/kit/adapters/memory/supplier-price-scripts';
import { MAX_LISTED_PRICE_FILES, listPriceFiles } from '../../src/agents/prices/list-price-files';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { priceImportValidator, savePriceImport } from '../../src/agents/prices/save-price-import';
import { recordEmployeePriceUpdates } from '../../src/agents/prices/employee-updates';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import {
  issuesToWarnings,
  writeImport,
  type ImportCandidate,
} from '../../src/agents/prices/import-checks';
import { listProposals } from '../../src/agents/prices/price-proposals';
import { runDataScript } from '../../src/agents/prices/run-data-script';
import { isDomainError } from '@business-ai/core';
import { type PriceItem } from '../../src/kit/domain/models';
import type {
  JsonValue,
  ScriptRunOutcome,
  ScriptRunRequest,
  ScriptSandbox,
} from '@business-ai/core';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';
import { CTX, SUPPLIER_ID, existingPrice, priceCsv, putFile } from './support';

/** Этап 177: у агента прайсов вместо отказа - результат и предупреждения (не диск). */

const STATS = {
  durationMs: 1,
  queueMs: 0,
  codeBytes: 1,
  inBytes: 1,
  fileBytes: 0,
  outBytes: 1,
  exitCode: 0,
  uidSwitched: true,
};
const FILE = 'Прайсы/металл.csv';
const CODE = 'def run(tables, source):\n    return []\n';

class FakeSandbox implements ScriptSandbox {
  constructor(private readonly result: JsonValue) {}
  async run(_request: ScriptRunRequest): Promise<ScriptRunOutcome> {
    return { ok: true, result: this.result, stats: STATS };
  }
}

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
});

/** Кандидат из чата с заведомо сомнительными данными: счёт строк, дубль, дата из будущего. */
function doubtful(source: ImportCandidate['source']): ImportCandidate {
  const future: PriceItem = { ...existingPrice('Гайка', 5), date: '2999-01-01T00:00:00.000Z' };
  return {
    supplierId: SUPPLIER_ID,
    importId: `imp-${String(source)}`,
    sourceRowCount: 10,
    items: [existingPrice('Болт', 12), existingPrice('Болт', 13), future],
    truncated: true,
    source,
    sourceDate: '2026-10-24T09:00:00.000Z',
  };
}

describe('A1-A6: замечания к данным не из диска - предупреждения', () => {
  test('чат: строки, дубль, усечение, дата - результат и warnings, дубль не включён', async () => {
    const result = await writeImport(deps, doubtful('intake'), 'key-chat');
    expect(result.status).toBe('proposed_not_written');
    // Болт (первое вхождение) и Гайка; второй Болт с другой ценой выбирать нельзя.
    expect(result.proposed).toBe(2);
    const text = result.warnings.join(' | ');
    expect(text).toContain('В исходнике 10 строк');
    expect(text).toContain('Дубль позиции');
    expect(text).toContain('прочитан не целиком');
    expect(text).toContain('из будущего');
    const proposals = await listProposals(deps.state, SUPPLIER_ID);
    expect(proposals[0]?.items.map((item) => item.price)).toEqual([12, 5]);
    // В базу цен ничего не попало.
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).map((item) => item.price)).toEqual([10]);
  });

  test('диск: то же самое по-прежнему validation_failed (запись в базу цен)', async () => {
    const error = await writeImport(deps, doubtful('disk'), 'key-disk').catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('validation_failed');
  });

  test('чужой поставщик в предложении остаётся блоком (чужие данные)', async () => {
    const candidate = doubtful('mail');
    const foreign = { ...existingPrice('Чужое', 1), supplierId: 'other' };
    const error = await writeImport(deps, { ...candidate, items: [foreign] }, 'key-foreign')
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('validation_failed');
  });

  test('валидатор фиксации: staging из чата не блокируется, диск блокируется', async () => {
    for (const source of ['employee', 'disk'] as const) {
      const fileHash = `h-${source}`;
      await deps.state.put(IMPORT_META_NAMESPACE, stagingImportId(SUPPLIER_ID, fileHash), {
        source: source === 'employee' ? 'intake' : 'disk',
        notes: [],
      });
      await deps.staging.append(
        stagingImportId(SUPPLIER_ID, fileHash),
        { supplierId: SUPPLIER_ID, fileHash },
        { key: 'k', table: '0', tableRows: 5, items: [existingPrice('Болт', 12)] },
        deps.clock.now(),
      );
      const commit = { supplierId: SUPPLIER_ID, fileHash };
      const codes = (await stagedImportValidator.validate(commit, deps, CTX)).map((i) => i.code);
      expect(codes).toEqual(source === 'disk' ? ['row_count_mismatch'] : []);
      if (source === 'employee') {
        const out = await commitPriceImport.execute(commit, deps, CTX);
        expect(out.status).toBe('proposed_not_written');
        expect(out.warnings?.join(' ')).toContain('В исходнике 5 строк');
      }
    }
  });

  test('A9: нераспознанная строка файла из чата - предложение и warnings с номером', async () => {
    const csv = 'Наименование,Цена\nБолт,12\nГайка,не число\n';
    const put = await deps.intake.put('emp-thread', 'price.csv', new TextEncoder().encode(csv));
    const ctx = { ...CTX, threadId: 'emp-thread' };
    const args = {
      path: put.path,
      supplierId: SUPPLIER_ID,
      tableIndex: 0,
      headerRows: 1,
      columns: { name: 0, price: 1 },
    };
    const norm = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse(args),
      deps,
      ctx,
    );
    const input = savePriceImport.inputSchema.parse({ ...args, fileHash: norm.fileHash });
    const issues = await priceImportValidator.validate(input, deps, ctx);
    expect(issues).toEqual([]);
    const out = await savePriceImport.execute(input, deps, ctx);
    expect(out.status).toBe('proposed_not_written');
    expect(out.proposed).toBe(1);
    expect(out.warnings?.join(' ')).toContain('не удалось разобрать');
  });

  test('A14: сто дублей - одна строка предупреждения, а не «ещё N не показано»', () => {
    const issues = Array.from({ length: 100 }, (_, i) => ({
      code: 'duplicate_row',
      message: `Дубль позиции: Товар ${i}.`,
    }));
    const warnings = issuesToWarnings(issues);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('замечаний: 100');
    expect(warnings[0]).toContain('Товар 0');
  });
});

describe('B1-B6: сверка скрипта', () => {
  const run = (items: JsonValue) => {
    deps.scriptSandbox = new FakeSandbox(items);
    deps.priceScripts = new MemorySupplierPriceScripts();
    return runDataScript.execute(
      { code: CODE, fileRef: FILE, resultKind: 'price_items', supplierId: SUPPLIER_ID },
      deps,
      CTX,
    );
  };
  const summaryOf = (out: unknown) => (out as { summary: Record<string, JsonValue> }).summary;

  test('B2: разные цены у одного ключа - принято, первое вхождение, warnings', async () => {
    putFile(deps, FILE, priceCsv([['Болт', 10], ['Болт', 11], ['Гайка', 5]]));
    const out = await run([
      { name: 'Болт', price: 10 },
      { name: 'Болт', price: 11 },
      { name: 'Гайка', price: 5 },
    ]);
    expect(out).toMatchObject({ ok: true });
    const summary = summaryOf(out);
    expect(summary['staged']).toBe(2);
    expect(JSON.stringify(summary['warnings'])).toContain('Дублей ключа');
  });

  test('B3: немонотонные тиражи - принято с предупреждением', async () => {
    putFile(deps, FILE, 'Наименование,Цена\nБолт,10\nБолт 100 шт,12\n');
    const out = await run([
      {
        name: 'Болт',
        price: 10,
        tiers: [
          { min_quantity: 1, price: 10 },
          { min_quantity: 100, price: 12 },
        ],
      },
    ]);
    expect(out).toMatchObject({ ok: true });
    expect(JSON.stringify(summaryOf(out)['warnings'])).toContain('Тиражи должны идти');
  });

  test('B5: негодная позиция исключена, остальные приняты', async () => {
    putFile(deps, FILE, priceCsv([['Болт', 10], ['Гайка', 5]]));
    const out = await run([{ name: 'Болт', price: 10 }, { name: 'Гайка', price: 'пять' }]);
    expect(out).toMatchObject({ ok: true });
    const summary = summaryOf(out);
    expect(summary['staged']).toBe(1);
    expect(JSON.stringify(summary['warnings'])).toContain('non_numeric_price');
  });

  test('B6: название длиннее 500 знаков обрезано, позиция принята', async () => {
    const long = `Болт ${'х'.repeat(600)}`;
    putFile(deps, FILE, priceCsv([['Болт', 10], ['Гайка', 5]]));
    const out = await run([{ name: long, price: 10 }, { name: 'Гайка', price: 5 }]);
    expect(out).toMatchObject({ ok: true });
    expect(JSON.stringify(summaryOf(out)['warnings'])).toContain('обрезан');
  });

  test('B4: цена, которой нет в исходнике, остаётся блоком (не выдумывать)', async () => {
    putFile(deps, FILE, priceCsv([['Болт', 10], ['Гайка', 5]]));
    const out = await run([{ name: 'Болт', price: 10 }, { name: 'Гайка', price: 777 }]);
    expect(out).toMatchObject({ ok: false });
  });
});

describe('C1-C4: лимиты не режут просьбу', () => {
  const EMPLOYEE_CTX = {
    ...CTX,
    threadId: 'emp',
    initiator: { kind: 'user' as const, userId: 'u1' },
  };

  test('C1/C2: 250 правок целиком, длинная пометка обрезана с предупреждением', async () => {
    const base = Array.from({ length: 250 }, (_, i) => existingPrice(`Товар ${i}`, 10));
    await deps.prices.saveImport(SUPPLIER_ID, base, 'seed-many');
    const updates = base.map((item, i) => ({
      productName: item.productName,
      price: 20,
      ...(i === 0 ? { note: 'н'.repeat(300) } : {}),
    }));
    const parsed = recordEmployeePriceUpdates.inputSchema.parse({
      supplierId: SUPPLIER_ID,
      updates,
    });
    const out = await recordEmployeePriceUpdates.execute(parsed, deps, EMPLOYEE_CTX);
    expect(out.applied).toHaveLength(250);
    expect(out.warnings?.join(' ')).toContain('обрезана');
  });

  test('C3: четыре столбца варианта - все идут в название, лимит снят', async () => {
    const header = 'Наименование,Цена,Размер,Цвет,Вес,Фасовка';
    putFile(deps, 'v.csv', `${header}\nБолт,12,M8,чёрный,2кг,коробка`);
    const out = await normalizePriceTable.execute(
      normalizePriceTable.inputSchema.parse({
        path: 'v.csv',
        supplierId: SUPPLIER_ID,
        columns: { name: 0, price: 1, variantColumns: [2, 3, 4, 5] },
      }),
      deps,
      CTX,
    );
    expect(out.items[0]?.productName).toContain('коробка');
  });

  test('C4: 450 файлов - три страницы по offset, ничего не потеряно', async () => {
    const total = MAX_LISTED_PRICE_FILES * 2 + 50;
    for (let i = 0; i < total; i += 1) putFile(deps, `p${i}.csv`, 'x');
    const seen = new Set<string>();
    let offset = 0;
    let pages = 0;
    for (;;) {
      const out = await listPriceFiles.execute({ offset }, deps, CTX);
      out.files.forEach((file) => seen.add(file.path));
      pages += 1;
      if (out.nextOffset === undefined) break;
      offset = out.nextOffset;
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(total);
  });
});

describe('E: промпт без отказа и допроса', () => {
  test('нет формулировок остановки, есть список предупреждений', () => {
    for (const phrase of [
      'Жду ответа',
      'получи подтверждение',
      'не записывай их без явного подтверждения',
      'не сохраняй: сообщи менеджеру',
      'спроси менеджера через отчёт',
      'currency_mismatch - не',
    ]) {
      expect(PRICES_PROMPT).not.toContain(phrase);
    }
    expect(PRICES_PROMPT).toContain('ОДИН список предупреждений');
  });
});
