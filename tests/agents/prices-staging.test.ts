import { beforeEach, describe, expect, test } from 'bun:test';
import { MAX_ISSUES_LISTED } from '../../src/agents/prices/import-checks';
import { MAX_MARKDOWN_CHARS, readPriceFile } from '../../src/agents/prices/read-price-file';
import {
  MAX_REJECTED_LISTED,
  STAGE_CHUNK_ROWS,
  stagePriceRows,
} from '../../src/agents/prices/stage-price-rows';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { isDomainError } from '@business-ai/core';
import { callTool, say, scriptedRuntime, type StepFn } from '../kit/adapters/mastra/support';
import {
  CTX,
  MODEL_ALIAS,
  SUPPLIER_ID,
  buildPricesDeps,
  existingPrice,
  lastToolResult,
  putFile,
} from './support';

const COLUMNS = { name: 0, price: 1 };
/** Строк, чтобы markdown заведомо не поместился в одну страницу. */
const BIG_ROWS = 3_000;
const CHUNK_ROWS = 1_500;
/** Ответ stagePriceRows: счётчики и короткий список отклонённых, но не позиции. */
const STAGE_REPLY_MAX_CHARS = 1_000;

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
beforeEach(async () => {
  deps = await buildPricesDeps();
});

/** Прайс на `count` позиций: «Товар 0001», цена 100 + номер. */
function bigCsv(count: number): string {
  const rows = Array.from({ length: count }, (_, i) => `Товар ${i + 1},${100 + i}`);
  return ['Наименование,Цена', ...rows].join('\n');
}

const stageArgs = (extra: Record<string, unknown> = {}) => ({
  path: 'price.csv',
  supplierId: SUPPLIER_ID,
  columns: COLUMNS,
  ...extra,
});

async function fileHash(path = 'price.csv'): Promise<string> {
  return (await readPriceFile.execute({ path }, deps, CTX)).hash;
}

describe('readPriceFile: страницы', () => {
  test('маленький файл целиком на одной странице: nextCursor=null', async () => {
    putFile(deps, 'price.csv', bigCsv(3));
    const out = await readPriceFile.execute({ path: 'price.csv' }, deps, CTX);
    expect(out.nextCursor).toBeNull();
    expect(out.tableRows).toEqual([4]);
    expect(out.truncated).toBe(false);
  });

  test('большой файл читается по курсору: страницы не пересекаются и покрывают всё', async () => {
    putFile(deps, 'price.csv', bigCsv(BIG_ROWS));
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await readPriceFile.execute({ path: 'price.csv', cursor }, deps, CTX);
      expect(out.markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS + 200);
      expect(out.truncated).toBe(false);
      for (const match of out.markdown.matchAll(/^\| (\d+) \|/gm)) seen.push(Number(match[1]));
      cursor = out.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    // Строки таблицы 0..BIG_ROWS, каждая ровно один раз и по порядку.
    expect(seen).toEqual(Array.from({ length: BIG_ROWS + 1 }, (_, i) => i));
  });

  test('несколько таблиц-листов: страница может захватить несколько, номера сквозные', async () => {
    const parse = async () => ({
      text: '',
      tables: [[['a', '1'], ['b', '2']], [['c', '3']]],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    });
    putFile(deps, 'two.csv', 'x');
    const stub = { ...deps, parser: { parse } };
    const out = await readPriceFile.execute({ path: 'two.csv' }, stub, CTX);
    expect(out.markdown).toContain('Таблица 0');
    expect(out.markdown).toContain('Таблица 1');
    expect(out.tableRows).toEqual([2, 1]);
    expect(out.nextCursor).toBeNull();
  });

  test('текст без таблиц тоже постраничный', async () => {
    const parse = async () => ({
      text: 'я'.repeat(MAX_MARKDOWN_CHARS + 10),
      tables: [],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    });
    putFile(deps, 'doc.txt', 'x');
    const stub = { ...deps, parser: { parse } };
    const first = await readPriceFile.execute({ path: 'doc.txt' }, stub, CTX);
    expect(first.markdown).toHaveLength(MAX_MARKDOWN_CHARS);
    const second = await readPriceFile.execute(
      { path: 'doc.txt', cursor: first.nextCursor ?? undefined },
      stub,
      CTX,
    );
    expect(second.markdown).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
  });

  test('чужой курсор: invalid_input', async () => {
    putFile(deps, 'price.csv', bigCsv(3));
    for (const cursor of ['abc', '9:0']) {
      const error = await readPriceFile
        .execute({ path: 'price.csv', cursor }, deps, CTX)
        .catch((e) => e);
      expect(isDomainError(error) && error.code).toBe('invalid_input');
    }
  });
});

describe('stagePriceRows', () => {
  test('кусками складывает позиции в staging, позиции в ответ не возвращаются', async () => {
    putFile(deps, 'price.csv', bigCsv(10));
    const first = await stagePriceRows.execute(stageArgs({ toRow: 5, reset: true }), deps, CTX);
    expect(first).toMatchObject({ staged: 4, totalStaged: 4, nextRow: 5, tableDataRows: 10 });
    expect(first).not.toHaveProperty('items');
    const second = await stagePriceRows.execute(stageArgs({ fromRow: first.nextRow }), deps, CTX);
    expect(second).toMatchObject({ staged: 6, totalStaged: 10, nextRow: null });
    const staged = await deps.staging.load(stagingImportId(SUPPLIER_ID, await fileHash()));
    expect(staged?.items).toHaveLength(10);
    expect(staged?.sourceRowCount).toBe(10);
  });

  test('повтор того же куска не плодит дубли', async () => {
    putFile(deps, 'price.csv', bigCsv(4));
    await stagePriceRows.execute(stageArgs(), deps, CTX);
    const again = await stagePriceRows.execute(stageArgs(), deps, CTX);
    expect(again.totalStaged).toBe(4);
  });

  test('размер куска ограничен константой, nextRow ведёт дальше', async () => {
    const rows = STAGE_CHUNK_ROWS + 5;
    putFile(deps, 'price.csv', bigCsv(rows));
    const out = await stagePriceRows.execute(stageArgs(), deps, CTX);
    expect(out.staged).toBe(STAGE_CHUNK_ROWS);
    expect(out.nextRow).toBe(STAGE_CHUNK_ROWS + 1);
  });

  test('отклонённые строки: число точное, список ограничен', async () => {
    const bad = Array.from({ length: MAX_REJECTED_LISTED + 5 }, (_, i) => `Т${i},12abc`);
    putFile(deps, 'price.csv', ['Наименование,Цена', 'Болт,10', ...bad].join('\n'));
    const out = await stagePriceRows.execute(stageArgs(), deps, CTX);
    expect(out.staged).toBe(1);
    expect(out.rejectedCount).toBe(MAX_REJECTED_LISTED + 5);
    expect(out.rejected).toHaveLength(MAX_REJECTED_LISTED);
  });

  test('reset начинает импорт заново', async () => {
    putFile(deps, 'price.csv', bigCsv(4));
    await stagePriceRows.execute(stageArgs(), deps, CTX);
    const out = await stagePriceRows.execute(stageArgs({ reset: true }), deps, CTX);
    expect(out.totalStaged).toBe(4);
  });

  test('неизвестный поставщик, нет таблицы, строка вне таблицы', async () => {
    putFile(deps, 'price.csv', bigCsv(2));
    const code = async (args: Record<string, unknown>) => {
      const error = await stagePriceRows.execute(args, deps, CTX).catch((e) => e);
      return isDomainError(error) ? error.code : null;
    };
    expect(await code(stageArgs({ supplierId: 'нет' }))).toBe('not_found');
    expect(await code(stageArgs({ tableIndex: 4 }))).toBe('invalid_input');
    expect(await code(stageArgs({ fromRow: 99 }))).toBe('invalid_input');
  });
});

describe('commitPriceImport и валидатор фиксации', () => {
  async function stageAll(count: number): Promise<string> {
    putFile(deps, 'price.csv', bigCsv(count));
    const out = await stagePriceRows.execute(stageArgs(), deps, CTX);
    return out.fileHash;
  }
  const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });

  test('полный импорт проходит проверки, прайс заменяется целиком, staging очищается', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Старый товар', 5)], 'seed');
    const hash = await stageAll(20);
    expect(await stagedImportValidator.validate(args(hash), deps, CTX)).toEqual([]);
    const out = await commitPriceImport.execute(args(hash), deps, CTX);
    expect(out).toEqual({ supplierId: SUPPLIER_ID, saved: 20, changed: 20 });
    const stored = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(stored).toHaveLength(20);
    expect(stored.map((i) => i.productName)).not.toContain('Старый товар');
    expect(await deps.staging.load(stagingImportId(SUPPLIER_ID, hash))).toBeNull();
  });

  test('пропущенный кусок: число строк не сходится, фиксация заблокирована', async () => {
    putFile(deps, 'price.csv', bigCsv(10));
    const first = await stagePriceRows.execute(stageArgs({ toRow: 4 }), deps, CTX);
    const issues = await stagedImportValidator.validate(args(first.fileHash), deps, CTX);
    expect(issues.map((i) => i.code)).toEqual(['row_count_mismatch']);
  });

  test('пересекающиеся куски с разным разбором дают дубли', async () => {
    putFile(deps, 'price.csv', bigCsv(6));
    await stagePriceRows.execute(stageArgs({ toRow: 4 }), deps, CTX);
    const second = await stagePriceRows.execute(
      stageArgs({ fromRow: 2, defaultCurrency: 'USD' }),
      deps,
      CTX,
    );
    const issues = await stagedImportValidator.validate(args(second.fileHash), deps, CTX);
    expect(issues.map((i) => i.code)).toContain('duplicate_row');
  });

  test('замечаний много: показывается не больше лимита и сводка', async () => {
    putFile(deps, 'price.csv', bigCsv(MAX_ISSUES_LISTED * 2));
    await stagePriceRows.execute(stageArgs({ toRow: MAX_ISSUES_LISTED * 2 + 1 }), deps, CTX);
    const second = await stagePriceRows.execute(
      stageArgs({ defaultCurrency: 'USD', reset: false }),
      deps,
      CTX,
    );
    const issues = await stagedImportValidator.validate(args(second.fileHash), deps, CTX);
    expect(issues.length).toBeLessThanOrEqual(MAX_ISSUES_LISTED + 1);
    expect(issues.at(-1)?.code).toBe('more_issues');
  });

  test('скачок цены относительно базы фиксацию не блокирует', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Товар 1', 10)], 'seed');
    const hash = await stageAll(3);
    const issues = await stagedImportValidator.validate(args(hash), deps, CTX);
    // Скачок уходит в файл изменений на проверку, решения человека для записи не нужно.
    expect(issues).toEqual([]);
  });

  test('без добавленных позиций: staging_not_found и not_found', async () => {
    const issues = await stagedImportValidator.validate(args('нет'), deps, CTX);
    expect(issues.map((i) => i.code)).toEqual(['staging_not_found']);
    const error = await commitPriceImport.execute(args('нет'), deps, CTX).catch((e) => e);
    expect(isDomainError(error) && error.code).toBe('not_found');
  });

  test('ключ идемпотентности и признак побочного эффекта', async () => {
    expect(commitPriceImport.sideEffect).toBe(true);
    expect(commitPriceImport.idempotencyKey?.(args('h1'))).toBe(
      `price-import:${SUPPLIER_ID}:h1`,
    );
    expect(stagedImportValidator.appliesTo).toEqual(['commitPriceImport']);
  });
});

describe('агент «Актуализация прайса (ИИ агент)»: большой прайс за несколько шагов', () => {
  const runtimeFor = (steps: StepFn) =>
    scriptedRuntime(createPricesAgent({ model: MODEL_ALIAS }), deps, steps);

  test('прайс больше лимита: страницы, staging и сохранение целиком', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Товар 1', 100)], 'seed');
    putFile(deps, 'price.csv', bigCsv(BIG_ROWS));
    let fileHashSeen = '';
    const { gateway, runtime, spec } = runtimeFor((request, call) => {
      if (call === 0) return callTool('c0', 'readPriceFile', { path: 'price.csv' });
      if (call === 1) {
        const page = lastToolResult(request);
        fileHashSeen = String(page.hash);
        // Прайс не поместился на страницу: агент видит курсор и читает дальше.
        expect(page.nextCursor).not.toBeNull();
        return callTool('c1', 'readPriceFile', { path: 'price.csv', cursor: page.nextCursor });
      }
      if (call === 2) {
        return callTool('c2', 'stagePriceRows', {
          ...stageArgs({ toRow: CHUNK_ROWS + 1, reset: true }),
        });
      }
      if (call === 3) {
        const chunk = lastToolResult(request);
        return callTool('c3', 'stagePriceRows', stageArgs({ fromRow: chunk.nextRow }));
      }
      if (call === 4) {
        const chunk = lastToolResult(request);
        expect(chunk).toMatchObject({ nextRow: null, totalStaged: BIG_ROWS });
        return callTool('c4', 'commitPriceImport', {
          supplierId: SUPPLIER_ID,
          fileHash: fileHashSeen,
        });
      }
      if (call === 5) {
        const saved = lastToolResult(request);
        return callTool('c5', 'reportToManager', {
          kind: 'import_done',
          path: 'price.csv',
          fileHash: fileHashSeen,
          updated: saved.changed,
          needsReview: 0,
        });
      }
      return say('Большой прайс загружен');
    });
    const result = await runtime.run(spec, 't1', 'проверь прайсы');
    expect(result).toMatchObject({ status: 'completed', output: 'Большой прайс загружен' });
    const stored = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(stored).toHaveLength(BIG_ROWS);
    expect(stored[0]).toMatchObject({ productName: 'Товар 1', price: 100 });
    expect(stored.at(-1)).toMatchObject({ productName: `Товар ${BIG_ROWS}` });
    expect(await deps.staging.load(stagingImportId(SUPPLIER_ID, fileHashSeen))).toBeNull();
    expect(deps.chat.outbox[0]?.message?.text).toContain(`обновил ${BIG_ROWS - 1} позиций`);
    // Позиции прайса в модель не возвращаются: ответ stagePriceRows короткий.
    const staged = gateway.requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === 'tool' && m.content.includes('totalStaged'));
    expect(staged.length).toBeGreaterThan(0);
    for (const message of staged) {
      expect(message.content.length).toBeLessThan(STAGE_REPLY_MAX_CHARS);
    }
  });

  test('пропущен кусок: commit заблокирован валидатором, старый прайс цел', async () => {
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Товар 1', 100)], 'seed');
    putFile(deps, 'price.csv', bigCsv(BIG_ROWS));
    let hash = '';
    const { gateway, runtime, spec } = runtimeFor((request, call) => {
      if (call === 0) {
        return callTool('c0', 'stagePriceRows', stageArgs({ toRow: CHUNK_ROWS + 1 }));
      }
      if (call === 1) {
        hash = String(lastToolResult(request).fileHash);
        return callTool('c1', 'commitPriceImport', { supplierId: SUPPLIER_ID, fileHash: hash });
      }
      return say('Не все строки загружены, нужна проверка');
    });
    await runtime.run(spec, 't1', 'x');
    const last = gateway.requests[2]?.messages.filter((m) => m.role === 'tool').at(-1)?.content;
    expect(last).toContain('НЕ выполнено');
    expect(last).toContain('row_count_mismatch');
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(1);
  });
});
