import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIntakeStore } from '@business-ai/adapters';
import {
  SCRIPT_RESULT_SAMPLE_SIZE as PRICE_ITEMS_SAMPLE_SIZE,
  SCRIPT_FIX_STEPS,
  SCRIPT_RESULT_MAX_CHARS,
  SCRIPT_TABLE_MAX_ROWS,
  createToolContext,
  scriptTurnOf,
  type ScriptTurnCounters,
} from '@business-ai/core';
import { fileRefOf } from '../../src/agents/prices/file-ref';
import {
  runDataScript as documentsRunDataScript,
} from '../../src/agents/documents/run-data-script';
import { runDataScript as runDataScriptForPrices } from '../../src/agents/prices/run-data-script';
import { DomainError, isDomainError } from '@business-ai/core';
import type {
  JsonValue,
  ScriptRunOutcome,
  ScriptRunRequest,
  ScriptSandbox,
} from '@business-ai/core';
import { CTX, FILE_REF_SECRET, buildDocumentsDeps, buildPricesDeps, putFile } from './support';

const STATS = {
  durationMs: 5,
  queueMs: 0,
  codeBytes: 10,
  inBytes: 20,
  fileBytes: 0,
  outBytes: 8,
  exitCode: 0,
  uidSwitched: true,
};
const PRICE_FILE = 'Прайсы/металл.csv';
const CSV = 'Наименование,Цена\nБолт,10\nГайка,5';
const CODE = 'def run(tables, source):\n    return 1\n';
const FAIL_LINE = 12;

/** Фейковая песочница: запоминает запросы, отвечает заданным исходом. */
class FakeSandbox implements ScriptSandbox {
  readonly requests: ScriptRunRequest[] = [];
  constructor(private readonly reply: () => ScriptRunOutcome | Error) {}
  async run(request: ScriptRunRequest): Promise<ScriptRunOutcome> {
    this.requests.push(request);
    const outcome = this.reply();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

const ok = (result: JsonValue): ScriptRunOutcome => ({ ok: true, result, stats: STATS });
const userError: ScriptRunOutcome = {
  ok: false,
  error: { code: 'user_exception', type: 'ValueError', line: FAIL_LINE, policy: null },
  stats: STATS,
};

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
const events: Array<{ event: string; fields: Record<string, unknown> }> = [];

beforeEach(async () => {
  events.length = 0;
  deps = await buildPricesDeps();
  putFile(deps, PRICE_FILE, CSV);
  deps.dataScriptLog = (event, fields = {}) => void events.push({ event, fields });
});

const run = (
  input: { code?: string; fileRef?: string; resultKind: 'price_items' | 'table' | 'value' },
  context = CTX,
) => runDataScriptForPrices.execute({ code: CODE, ...input }, deps, context);

describe('runDataScript: успех', () => {
  test('value: ядро читает настоящие таблицы и байты файла, песочнице уходит json', async () => {
    const sandbox = new FakeSandbox(() => ok({ total: 15 }));
    deps.scriptSandbox = sandbox;
    const out = await run({ fileRef: PRICE_FILE, resultKind: 'value' });
    expect(out).toMatchObject({ ok: true, resultKind: 'value', value: { total: 15 } });
    const request = sandbox.requests[0];
    expect(request?.resultKind).toBe('json');
    expect(request?.tables).toEqual([[['Наименование', 'Цена'], ['Болт', '10'], ['Гайка', '5']]]);
    expect(request?.agent).toBe('test-agent');
    expect(new TextDecoder().decode(request?.file)).toBe(CSV);
    expect(events.find((e) => e.event === 'data_script_run')?.fields).toMatchObject({
      agent: 'test-agent',
      result_kind: 'value',
      outcome: 'ok',
    });
    expect(JSON.stringify(events)).not.toContain('Болт');
  });

  test('fileref: разрешается кодом так же, как у readPriceFile', async () => {
    deps.scriptSandbox = new FakeSandbox(() => ok([]));
    const ref = fileRefOf(PRICE_FILE, FILE_REF_SECRET);
    const out = await run({ fileRef: ref, resultKind: 'table' });
    expect(out).toMatchObject({ ok: true, rowCount: 0 });
  });

  test('table: строки сверх предела обрезаются, rowCount полный', async () => {
    const rows = Array.from({ length: SCRIPT_TABLE_MAX_ROWS + 50 }, (_, i) => [String(i)]);
    deps.scriptSandbox = new FakeSandbox(() => ok(rows));
    const out = await run({ fileRef: PRICE_FILE, resultKind: 'table' });
    expect(out).toMatchObject({ ok: true, truncated: true, rowCount: rows.length });
    expect((out.value as unknown[]).length).toBe(SCRIPT_TABLE_MAX_ROWS);
  });

  test('value больше предела: ошибка попытки result_too_large, данные не уходят', async () => {
    deps.scriptSandbox = new FakeSandbox(() => ok('x'.repeat(SCRIPT_RESULT_MAX_CHARS + 1)));
    const out = await run({ fileRef: PRICE_FILE, resultKind: 'value' });
    expect(out).toMatchObject({ ok: false, error: { code: 'result_too_large' } });
    expect(out.value).toBeUndefined();
  });

  test('price_items: модели только сводка (число и образец), не все позиции', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ name: `Позиция ${i}`, price: i + 1 }));
    deps.scriptSandbox = new FakeSandbox(() => ok(items));
    // У агента прайсов price_items идёт в staging (тема 3); сводка по умолчанию - у остальных.
    deps.priceItemsHandler = undefined;
    const docDeps = await buildDocumentsDeps();
    const intake = new MemoryIntakeStore();
    await intake.put(CTX.threadId, 'a.csv', new TextEncoder().encode(CSV));
    docDeps.intake = intake;
    docDeps.scriptSandbox = deps.scriptSandbox;
    docDeps.parser = deps.parser;
    const out = await documentsRunDataScript.execute(
      { code: CODE, resultKind: 'price_items' },
      docDeps,
      CTX,
    );
    expect(out.summary).toEqual({ count: 8, sample: items.slice(0, PRICE_ITEMS_SAMPLE_SIZE) });
    expect(out.value).toBeUndefined();
  });

  test('price_items: обработчик из зависимости (точка расширения темы 3) получает все позиции', async () => {
    const items = [{ name: 'А', price: 1 }, { name: 'Б', price: 2 }];
    deps.scriptSandbox = new FakeSandbox(() => ok(items));
    let seen: readonly JsonValue[] = [];
    deps.priceItemsHandler = async (all, context) => {
      seen = all;
      return { staged: all.length, source: context.sourceName };
    };
    const out = await run({ fileRef: PRICE_FILE, resultKind: 'price_items' });
    expect(seen).toEqual(items);
    expect(out.summary).toEqual({ staged: 2, source: PRICE_FILE });
  });
});

describe('runDataScript: ошибки', () => {
  test('ошибка скрипта: код, тип исключения и строка; тексты не передаются', async () => {
    deps.scriptSandbox = new FakeSandbox(() => userError);
    const out = await run({ fileRef: PRICE_FILE, resultKind: 'value' });
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'user_exception', type: 'ValueError', line: FAIL_LINE },
    });
  });

  test('песочница недоступна: исключение external_failure и событие без данных', async () => {
    const down = new DomainError('external_failure', 'нет');
    deps.scriptSandbox = new FakeSandbox(() => down);
    const error = await run({ fileRef: PRICE_FILE, resultKind: 'value' }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'external_failure').toBe(true);
    expect(events.map((e) => e.event)).toContain('data_script_unavailable');
  });

  test('песочница не подключена: not_configured', async () => {
    const error = await run({ fileRef: PRICE_FILE, resultKind: 'value' }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'not_configured').toBe(true);
  });

  test('скан: отказ, в песочницу ничего не уходит', async () => {
    const sandbox = new FakeSandbox(() => ok(1));
    deps.scriptSandbox = sandbox;
    putFile(deps, 'scan.csv', '   ');
    const error = await run({ fileRef: 'scan.csv', resultKind: 'value' }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'invalid_input').toBe(true);
    expect(sandbox.requests).toHaveLength(0);
  });
});

describe('runDataScript: доступ к данным', () => {
  test('несуществующий файл диска: not_found, песочница не вызывается', async () => {
    const sandbox = new FakeSandbox(() => ok(1));
    deps.scriptSandbox = sandbox;
    const error = await run({ fileRef: 'нет/такого.csv', resultKind: 'value' }).catch((e) => e);
    expect(isDomainError(error) && error.code === 'not_found').toBe(true);
    expect(sandbox.requests).toHaveLength(0);
  });

  test('вложение другого диалога недоступно (хранилище читает в пределах треда)', async () => {
    const intake = new MemoryIntakeStore();
    deps.intake = intake;
    const sandbox = new FakeSandbox(() => ok(1));
    deps.scriptSandbox = sandbox;
    const stored = await intake.put('чужой-тред', 'прайс.csv', new TextEncoder().encode(CSV));
    const error = await run({ fileRef: stored.path, resultKind: 'value' }).catch((e) => e);
    expect(isDomainError(error) && error.code === 'not_found').toBe(true);
    expect(sandbox.requests).toHaveLength(0);
  });

  test('без fileRef берётся единственное вложение этого диалога', async () => {
    const intake = new MemoryIntakeStore();
    deps.intake = intake;
    const sandbox = new FakeSandbox(() => ok(7));
    deps.scriptSandbox = sandbox;
    await intake.put(CTX.threadId, 'прайс.csv', new TextEncoder().encode(CSV));
    const out = await run({ resultKind: 'value' });
    expect(out).toMatchObject({ ok: true, value: 7 });
    expect(sandbox.requests[0]?.tables[0]?.length).toBe(3);
  });

  test('без fileRef и без вложений: данных нет, отказ; несколько вложений - просьба указать', async () => {
    const intake = new MemoryIntakeStore();
    deps.intake = intake;
    deps.scriptSandbox = new FakeSandbox(() => ok(1));
    const none = await run({ resultKind: 'value' }).catch((e: unknown) => e);
    expect(isDomainError(none) && none.message).toContain('нет вложений');
    const bytes = new TextEncoder().encode(CSV);
    await intake.put(CTX.threadId, 'a.csv', bytes);
    await intake.put(CTX.threadId, 'b.csv', new TextEncoder().encode('x,y\n1,2'));
    const many = await run({ resultKind: 'value' }).catch((e: unknown) => e);
    expect(isDomainError(many) && many.message).toContain('несколько вложений');
  });

  test('агент без файлов (документы): путь диска не принимается, нужно вложение диалога', async () => {
    const docDeps = await buildDocumentsDeps();
    docDeps.scriptSandbox = new FakeSandbox(() => ok(1));
    docDeps.intake = new MemoryIntakeStore();
    docDeps.parser = deps.parser;
    const error = await documentsRunDataScript
      .execute({ code: CODE, fileRef: PRICE_FILE, resultKind: 'value' }, docDeps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code === 'invalid_input').toBe(true);
  });
});

describe('runDataScript: большой файл вложения (этап 231)', () => {
  const BIG_BYTES = 15 * 1024 * 1024;

  /** Приём, который считает полные чтения файла в память (`read`). */
  class CountingIntake extends MemoryIntakeStore {
    reads = 0;
    override async read(...args: Parameters<MemoryIntakeStore['read']>) {
      this.reads += 1;
      return super.read(...args);
    }
    override async openFile(threadId: string, path: string) {
      const bytes = await super.read(threadId, path);
      const dir = mkdtempSync(join(tmpdir(), 'script-intake-'));
      const target = join(dir, 'file');
      writeFileSync(target, bytes);
      return { path: target, size: bytes.length };
    }
  }

  test('крупнее предела песочницы: файл не читается в память, разбор идёт по пути', async () => {
    const intake = new CountingIntake();
    deps.intake = intake;
    const sandbox = new FakeSandbox(() => ok(1));
    deps.scriptSandbox = sandbox;
    const parsedFrom: string[] = [];
    const inner = deps.parser;
    deps.parser = {
      parse: (name, content) => inner.parse(name, content),
      parseFile: async (name, file) => {
        parsedFrom.push(file.path);
        return inner.parse(name, new TextEncoder().encode(CSV));
      },
    };
    const head = new TextEncoder().encode(`${CSV}\n`);
    const big = new Uint8Array(BIG_BYTES).fill(0x20);
    big.set(head);
    await intake.put(CTX.threadId, 'big.csv', big);
    const out = await run({ resultKind: 'value' });
    expect(out).toMatchObject({ ok: true, value: 1 });
    expect(parsedFrom).toHaveLength(1);
    expect(intake.reads).toBe(0);
    expect(sandbox.requests[0]?.file).toBeUndefined();
  });

  test('малый файл по-прежнему уходит песочнице байтами', async () => {
    const intake = new CountingIntake();
    deps.intake = intake;
    const sandbox = new FakeSandbox(() => ok(1));
    deps.scriptSandbox = sandbox;
    await intake.put(CTX.threadId, 'small.csv', new TextEncoder().encode(CSV));
    await run({ resultKind: 'value' });
    expect(new TextDecoder().decode(sandbox.requests[0]?.file)).toBe(CSV);
  });
});

describe('счёт попыток скрипта в ходе', () => {
  function counters(steps: number, stepLimit: number): ScriptTurnCounters {
    return { steps, stepLimit };
  }
  function contextWith(c: ScriptTurnCounters) {
    return createToolContext({
      threadId: CTX.threadId,
      agentId: CTX.agentId,
      operationId: 'op',
      scriptTurn: scriptTurnOf(c),
    });
  }

  test('первая попытка поднимает предел шагов на 6 один раз за ход', () => {
    const c = counters(3, 10);
    const turn = scriptTurnOf(c);
    expect(turn.beginAttempt()).toEqual({ allowed: true, attemptsLeft: SCRIPT_FIX_STEPS - 1 });
    expect(c.stepLimit).toBe(10 + SCRIPT_FIX_STEPS);
    turn.finishAttempt(true);
    c.steps = 5;
    turn.beginAttempt();
    expect(c.stepLimit).toBe(10 + SCRIPT_FIX_STEPS);
  });

  test('6 шагов без годного результата: серия исчерпана, дальше отказ', () => {
    const c = counters(2, 10);
    const turn = scriptTurnOf(c);
    let last = { exhausted: false };
    for (let step = 0; step < SCRIPT_FIX_STEPS; step += 1) {
      c.steps = 2 + step;
      expect(turn.beginAttempt().allowed).toBe(true);
      last = turn.finishAttempt(false);
    }
    expect(last.exhausted).toBe(true);
    expect(c.scriptExhausted).toBe(true);
    expect(turn.beginAttempt().allowed).toBe(false);
  });

  test('годный результат закрывает серию: новая серия получает свои 6 шагов без нового подъёма', () => {
    const c = counters(1, 10);
    const turn = scriptTurnOf(c);
    turn.beginAttempt();
    turn.finishAttempt(false);
    c.steps = 3;
    turn.beginAttempt();
    turn.finishAttempt(true);
    expect(c.scriptHelped).toBe(true);
    c.steps = 8;
    expect(turn.beginAttempt().attemptsLeft).toBe(SCRIPT_FIX_STEPS - 1);
    expect(c.stepLimit).toBe(10 + SCRIPT_FIX_STEPS);
  });

  test('инструмент: исчерпание даёт scriptDidNotHelp и событие, повтор - отказ без запуска', async () => {
    const sandbox = new FakeSandbox(() => userError);
    deps.scriptSandbox = sandbox;
    const c = counters(1, 10);
    const outs = [];
    for (let step = 0; step < SCRIPT_FIX_STEPS + 1; step += 1) {
      c.steps = 1 + step;
      outs.push(await run({ fileRef: PRICE_FILE, resultKind: 'value' }, contextWith(c)));
    }
    expect(outs[0]?.attemptsLeft).toBe(SCRIPT_FIX_STEPS - 1);
    expect(outs[SCRIPT_FIX_STEPS - 1]).toMatchObject({ scriptDidNotHelp: true, attemptsLeft: 0 });
    expect(outs[SCRIPT_FIX_STEPS]).toMatchObject({ error: { code: 'attempts_exhausted' } });
    expect(sandbox.requests).toHaveLength(SCRIPT_FIX_STEPS);
    expect(events.map((e) => e.event)).toContain('script_attempts_exhausted');
  });
});
