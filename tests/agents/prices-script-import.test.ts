import { beforeEach, describe, expect, test } from 'bun:test';
import { MemorySupplierPriceScripts } from '../../src/kit/adapters/memory/supplier-price-scripts';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { scriptTurnOf, type ScriptTurnCounters } from '@business-ai/core';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { tableFormFingerprint } from '../../src/agents/prices/table-form';
import { runDataScript } from '../../src/agents/prices/run-data-script';
import { isDomainError } from '@business-ai/core';
import type {
  JsonValue,
  ScriptRunOutcome,
  ScriptRunRequest,
  ScriptSandbox,
} from '@business-ai/core';
import { buildFullPricesDeps, type FullPricesDeps } from './prices-support';
import { CTX, SUPPLIER_ID, priceCsv, putFile } from './support';

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
const FILE_SAME_FORM = 'Прайсы/металл-новый.csv';
const CODE = 'def run(tables, source):\n    return []\n';
const COLUMNS = { name: 0, price: 1 };

/** Фейковая песочница: отвечает по очереди заданными исходами и запоминает запросы. */
class FakeSandbox implements ScriptSandbox {
  readonly requests: ScriptRunRequest[] = [];
  constructor(private readonly replies: Array<ScriptRunOutcome | Error>) {}
  async run(request: ScriptRunRequest): Promise<ScriptRunOutcome> {
    this.requests.push(request);
    const next = this.replies.length > 1 ? this.replies.shift() : this.replies[0];
    if (next === undefined) throw new Error('нет ответа');
    if (next instanceof Error) throw next;
    return next;
  }
}

const ok = (result: JsonValue): ScriptRunOutcome => ({ ok: true, result, stats: STATS });
const ITEMS = [
  { name: 'Болт', price: 10 },
  { name: 'Гайка', price: 5 },
];

let deps: FullPricesDeps;
let scripts: MemorySupplierPriceScripts;
const events: string[] = [];

beforeEach(async () => {
  events.length = 0;
  deps = await buildFullPricesDeps();
  scripts = new MemorySupplierPriceScripts();
  deps.priceScripts = scripts;
  deps.dataScriptLog = (event) => void events.push(event);
  putFile(deps, FILE, priceCsv([['Болт', 10], ['Гайка', 5]]));
  putFile(deps, FILE_SAME_FORM, priceCsv([['Болт', 11], ['Гайка', 6]]));
});

const runScript = (input: Record<string, unknown>, ctx = CTX) =>
  runDataScript.execute(
    { code: CODE, fileRef: FILE, resultKind: 'price_items', supplierId: SUPPLIER_ID, ...input },
    deps,
    ctx,
  );

const stage = (path: string, reset = true) =>
  stagePriceRows.execute(
    { path, supplierId: SUPPLIER_ID, tableIndex: 0, headerRows: 1, columns: COLUMNS, reset },
    deps,
    CTX,
  );

async function formOf(path: string): Promise<string> {
  return tableFormFingerprint((await deps.parser.parse(path, await deps.files.read(path))).tables);
}

describe('runDataScript price_items -> staging', () => {
  test('позиции идут в staging того же импорта; модели сводка и образец', async () => {
    // Сверка по покрытию: цены и названия позиций обязаны быть в исходнике.
    putFile(deps, FILE, priceCsv([['Болт', 10], ['Гайка', 5], ['Шайба М8', 1]]));
    deps.scriptSandbox = new FakeSandbox([
      ok([...ITEMS, { name: 'Шайба', variant: 'М8', price: 1, currency: 'USD' }]),
    ]);
    const out = await runScript({}).catch((e: unknown) => e);
    // В таблице две строки данных, позиций три: трёхкратный запас допускает.
    expect(out).toMatchObject({ ok: true, resultKind: 'price_items' });
    const summary = (out as { summary: Record<string, JsonValue> }).summary;
    expect(summary).toMatchObject({
      accepted: true,
      staged: 3,
      withVariants: 1,
      currencyAssumed: 2,
    });
    expect(JSON.stringify(summary['sample'])).toContain('Шайба М8');
    const importId = stagingImportId(SUPPLIER_ID, String(summary['fileHash']));
    const staged = await deps.staging.load(importId);
    expect(staged?.items.map((item) => item.productName)).toEqual(['Болт', 'Гайка', 'Шайба М8']);
    expect(staged?.items[2]?.currency).toBe('USD');
  });

  test('запись только через commitPriceImport и его валидатор (диск - в базу)', async () => {
    deps.scriptSandbox = new FakeSandbox([ok(ITEMS)]);
    const out = await runScript({});
    const fileHash = String((out.summary as Record<string, JsonValue>)['fileHash']);
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toEqual([]);
    const args = { supplierId: SUPPLIER_ID, fileHash };
    expect(await stagedImportValidator.validate(args, deps, CTX)).toEqual([]);
    const done = await commitPriceImport.execute(args, deps, CTX);
    expect(done).toMatchObject({ saved: 2 });
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).map((i) => i.productName)).toEqual([
      'Болт',
      'Гайка',
    ]);
  });

  test('тираж по сумме заказа и признак цены доходят до staging', async () => {
    putFile(deps, FILE, priceCsv([['Одеяло', 1200], ['Одеяло опт', 1100], ['Подушка', 300]]));
    deps.scriptSandbox = new FakeSandbox([
      ok([
        {
          name: 'Одеяло',
          price: 1200,
          tier_basis: 'order_sum',
          tiers: [
            { min_quantity: 62000, price: 1200 },
            { min_quantity: 102000, price: 1100 },
          ],
          price_qualifier: 'from',
        },
        { name: 'Подушка', price: 300 },
      ]),
    ]);
    const out = await runScript({});
    const fileHash = String((out.summary as Record<string, JsonValue>)['fileHash']);
    const staged = await deps.staging.load(stagingImportId(SUPPLIER_ID, fileHash));
    expect(staged?.items[0]).toMatchObject({ priceTierBasis: 'order_sum', priceQualifier: 'from' });
    expect(staged?.items[0]?.priceTiers).toHaveLength(2);
  });

  test('сверка не прошла: попытка неудачна, issues в ответе, скрипт не сохранён', async () => {
    deps.scriptSandbox = new FakeSandbox([
      ok([{ name: 'Болт', price: 10 }, { name: 'Гайка', price: 777 }]),
    ]);
    const counters: ScriptTurnCounters = { steps: 1, stepLimit: 10 };
    const out = await runScript({}, { ...CTX, scriptTurn: scriptTurnOf(counters) });
    expect(out).toMatchObject({ ok: false, error: { code: 'reconcile_failed' } });
    const summary = out.summary as { accepted: boolean; issues: Array<{ code: string }> };
    expect(summary.accepted).toBe(false);
    expect(summary.issues.map((i) => i.code)).toContain('price_not_in_source');
    expect(counters.scriptHelped).not.toBe(true);
    expect(await scripts.findLatest(SUPPLIER_ID, await formOf(FILE))).toBeNull();
  });

  test('без supplierId и для неизвестного поставщика - отказ', async () => {
    deps.scriptSandbox = new FakeSandbox([ok(ITEMS)]);
    const noSupplier = await runScript({ supplierId: undefined }).catch((e: unknown) => e);
    expect(isDomainError(noSupplier) && noSupplier.code === 'invalid_input').toBe(true);
    const unknown = await runScript({ supplierId: 'nope' }).catch((e: unknown) => e);
    expect(isDomainError(unknown) && unknown.code === 'not_found').toBe(true);
  });

  test('скрипт сохраняется за поставщиком; правка по просьбе - версия и «было/стало»', async () => {
    // Новая цена правки должна быть в исходнике: строка «Болт опт» есть в файле. Строк больше
    // двух, чтобы обе версии скрипта использовали не меньше 80 % строк с ценами (порог сверки).
    putFile(
      deps,
      FILE,
      priceCsv([['Болт', 10], ['Гайка', 5], ['Шайба', 3], ['Шуруп', 2], ['Болт опт', 12]]),
    );
    const rest = [
      { name: 'Гайка', price: 5 },
      { name: 'Шайба', price: 3 },
      { name: 'Шуруп', price: 2 },
    ];
    const sandbox = new FakeSandbox([
      ok([{ name: 'Болт', price: 10 }, ...rest]),
      ok([{ name: 'Болт', price: 12 }, ...rest]),
    ]);
    deps.scriptSandbox = sandbox;
    await runScript({});
    const form = await formOf(FILE);
    expect(await scripts.findLatest(SUPPLIER_ID, form)).toMatchObject({
      version: 1,
      createdBy: 'agent',
      code: CODE,
    });
    const fixed = 'def run(tables, source):\n    return [1]\n';
    const out = await runScript({ code: fixed, onEmployeeRequest: true });
    const summary = out.summary as Record<string, JsonValue>;
    expect(summary['diff']).toMatchObject({
      before: 4,
      after: 4,
      changed: 1,
      added: 0,
      removed: 0,
    });
    expect(JSON.stringify(summary['diff'])).toContain('"was":"10"');
    expect(await scripts.findLatest(SUPPLIER_ID, form)).toMatchObject({
      version: 2,
      createdBy: 'employee_request',
      code: fixed,
    });
    // Без просьбы сотрудника разницы в ответе нет.
    const again = await runScript({ code: fixed });
    expect((again.summary as Record<string, JsonValue>)['diff']).toBeUndefined();
  });

  test('сводка первичного импорта учитывает файл, разобранный скриптом', async () => {
    deps.scriptSandbox = new FakeSandbox([ok(ITEMS)]);
    const { queueDiskSyncOutcome, readDiskSyncOutcome } = await import(
      '../../src/agents/prices'
    );
    await queueDiskSyncOutcome(deps.state, CTX.threadId, 'run-1', FILE, '2026-10-27T00:00:00Z');
    await runScript({});
    expect((await readDiskSyncOutcome(deps.state, CTX.threadId))?.viaScript).toBe(true);
  });
});

describe('сохранённый скрипт идёт первым в обычном разборе', () => {
  async function saveScriptFor(path: string): Promise<void> {
    await scripts.save({
      supplierId: SUPPLIER_ID,
      formHash: await formOf(path),
      code: CODE,
      createdBy: 'agent',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  }

  test('форма та же: скрипт запущен ядром без модели, позиции в staging', async () => {
    await saveScriptFor(FILE);
    const sandbox = new FakeSandbox([
      ok([{ name: 'Болт', price: 11 }, { name: 'Гайка', price: 6 }]),
    ]);
    deps.scriptSandbox = sandbox;
    const out = await stage(FILE_SAME_FORM);
    expect(out).toMatchObject({ viaSavedScript: true, staged: 2, totalStaged: 2, nextRow: null });
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.requests[0]?.code).toBe(CODE);
    expect(sandbox.requests[0]?.resultKind).toBe('price_items');
    const staged = await deps.staging.load(stagingImportId(SUPPLIER_ID, out.fileHash));
    expect(staged?.items.map((item) => item.price)).toEqual([11, 6]);
    // Повторный вызов по другой таблице файла - пустой: скрипт разобрал файл целиком.
    const next = await stage(FILE_SAME_FORM, false);
    expect(next).toMatchObject({ viaSavedScript: true, staged: 0, totalStaged: 2 });
    expect(sandbox.requests).toHaveLength(1);
    // Фиксация - тем же путём, версия скрипта не менялась.
    const args = { supplierId: SUPPLIER_ID, fileHash: out.fileHash };
    expect(await stagedImportValidator.validate(args, deps, CTX)).toEqual([]);
    expect(await commitPriceImport.execute(args, deps, CTX)).toMatchObject({ saved: 2 });
    expect(scripts.versions(SUPPLIER_ID, await formOf(FILE))).toHaveLength(1);
  });

  test('метаданные «разобран скриптом», а staging нет: не «готово с нулём строк»', async () => {
    await saveScriptFor(FILE);
    const sandbox = new FakeSandbox([
      ok([{ name: 'Болт', price: 11 }, { name: 'Гайка', price: 6 }]),
    ]);
    deps.scriptSandbox = sandbox;
    const first = await stage(FILE_SAME_FORM);
    await deps.staging.discard(stagingImportId(SUPPLIER_ID, first.fileHash));
    const again = await stage(FILE_SAME_FORM, false);
    expect(again.totalStaged).toBe(2);
    expect(sandbox.requests).toHaveLength(2);
  });

  test('версия, не подтверждённая фиксацией, сама не запускается; после фиксации - да', async () => {
    const sandbox = new FakeSandbox([
      ok(ITEMS),
      ok([{ name: 'Болт', price: 11 }, { name: 'Гайка', price: 6 }]),
    ]);
    deps.scriptSandbox = sandbox;
    const out = await runScript({});
    const fileHash = String((out.summary as Record<string, JsonValue>)['fileHash']);
    expect(scripts.versions(SUPPLIER_ID, await formOf(FILE))).toHaveLength(1);
    const early = await stage(FILE_SAME_FORM);
    expect(early.viaSavedScript).toBeUndefined();
    expect(sandbox.requests).toHaveLength(1);
    await commitPriceImport.execute({ supplierId: SUPPLIER_ID, fileHash }, deps, CTX);
    const later = await stage(FILE_SAME_FORM);
    expect(later).toMatchObject({ viaSavedScript: true, staged: 2 });
    expect(sandbox.requests).toHaveLength(2);
  });

  test('не прошёл сверку: обычный путь, savedScriptFailed, позиции из столбцов', async () => {
    await saveScriptFor(FILE);
    deps.scriptSandbox = new FakeSandbox([
      ok([{ name: 'Болт', price: 11 }, { name: 'болт', price: 6 }]),
    ]);
    const out = await stage(FILE_SAME_FORM);
    expect(out.viaSavedScript).toBeUndefined();
    expect(out).toMatchObject({ savedScriptFailed: true, staged: 2, totalStaged: 2 });
    expect(events).toContain('saved_script_run');
  });

  test('ошибка скрипта и недоступная песочница: обычный путь', async () => {
    await saveScriptFor(FILE);
    deps.scriptSandbox = new FakeSandbox([
      {
        ok: false,
        error: { code: 'user_exception', type: 'KeyError', line: 3, policy: null },
        stats: STATS,
      },
    ]);
    expect(await stage(FILE_SAME_FORM)).toMatchObject({ savedScriptFailed: true, staged: 2 });
    deps.scriptSandbox = new FakeSandbox([new Error('down')]);
    expect(await stage(FILE_SAME_FORM)).toMatchObject({ savedScriptFailed: true, staged: 2 });
  });

  test('другая форма таблицы или нет скрипта: песочница не вызывается', async () => {
    const sandbox = new FakeSandbox([ok(ITEMS)]);
    deps.scriptSandbox = sandbox;
    expect(await stage(FILE)).toMatchObject({ staged: 2 });
    putFile(deps, 'Прайсы/другой.csv', 'Товар,Стоимость,Склад\nБолт,10,5\nГайка,5,3');
    await saveScriptFor(FILE);
    const other = await stagePriceRows.execute(
      {
        path: 'Прайсы/другой.csv',
        supplierId: SUPPLIER_ID,
        tableIndex: 0,
        headerRows: 1,
        columns: COLUMNS,
        reset: true,
      },
      deps,
      CTX,
    );
    expect(other).toMatchObject({ staged: 2 });
    expect(other.viaSavedScript).toBeUndefined();
    expect(sandbox.requests).toHaveLength(0);
  });

  test('без песочницы или без хранилища скриптов поведение прежнее', async () => {
    await saveScriptFor(FILE);
    expect(await stage(FILE_SAME_FORM)).toMatchObject({ staged: 2 });
    deps.scriptSandbox = new FakeSandbox([ok(ITEMS)]);
    deps.priceScripts = undefined;
    const out = await stage(FILE_SAME_FORM);
    expect(out.viaSavedScript).toBeUndefined();
    expect(out.savedScriptFailed).toBeUndefined();
  });
});
