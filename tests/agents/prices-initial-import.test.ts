import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource, MemoryScheduler } from '@business-ai/adapters';
import { INITIAL_IMPORT_RESULT_TIMEOUT_MS } from '../../src/agents/prices/initial-import-summary';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { createToolContext, type ToolContext } from '@business-ai/core';
import {
  diskSyncThreadId,
  priceDiskSyncInput,
  runPriceDiskSync,
} from '../../src/agents/prices/price-disk-sync';
import { normalizePriceTable } from '../../src/agents/prices/normalize-price-table';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { savePriceImport } from '../../src/agents/prices/save-price-import';
import { isDomainError } from '@business-ai/core';
import type { IdGenerator } from '@business-ai/core';
import { CTX, FILE_REF_SECRET } from './support';
import {
  RESPONSIBLE_THREAD,
  buildFullPricesDeps,
  encode,
  type FullPricesDeps,
} from './prices-support';

let counter = 0;
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(counter += 1)}` };
const MTIME = 1_000;
const INITIAL = { initialImport: true } as const;
const COLUMNS = { name: 0, price: 1 };

/** Контекст запуска агента на файл первичного импорта: тред совпадает с тиком синхронизации. */
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
const summaries = (): string[] =>
  deps.chat.outbox
    .filter((item) => item.threadId === RESPONSIBLE_THREAD)
    .map((item) => item.message?.text ?? '');

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  scheduler = new MemoryScheduler(ids);
});

describe('первичный импорт: поручение и сводка', () => {
  test('в поручении агенту: поставщик определён кодом, заводить карточку модель не может', () => {
    const text = priceDiskSyncInput('a/прайс.csv', FILE_REF_SECRET, 's-42');
    expect(text).toContain('supplierId=s-42');
    expect(text).not.toContain('createSupplierFromPrice');
  });

  test('сводка уходит ответственному один раз, когда у всех файлов есть итог', async () => {
    const written = 'Ромашка/прайс.csv';
    const scan = 'Скан/прайс скан.csv';
    put(written, 'Наименование,Цена\nБолт,10\nГайка,5');
    put(scan, 'Наименование,Цена\nБолт,1');
    expect(await runPriceDiskSync(deps, scheduler, INITIAL)).toMatchObject({
      enqueued: 2,
      initialImport: 'completed',
    });
    // Итогов ещё нет: сводки нет.
    expect(summaries()).toEqual([]);

    // Файл 1: поставщика нет - черновик по папке завёл код тика, затем запись цен с его id.
    const ctx = diskCtx(written);
    const draft = await deps.suppliers
      .listPage(null, 100)
      .then((list) => list.find((item) => item.name === 'Ромашка'));
    if (draft === undefined) throw new Error('черновик не заведён');
    const draftCard = await deps.suppliers.getCard(draft.id);
    expect(draftCard).not.toHaveProperty('isDraft');
    const supplierId = draft.id;
    const table = await normalizePriceTable.execute(
      { path: written, supplierId: supplierId, columns: COLUMNS },
      deps,
      ctx,
    );
    const saved = await savePriceImport.execute(
      { path: written, supplierId: supplierId, fileHash: table.fileHash, columns: COLUMNS },
      deps,
      ctx,
    );
    expect(saved).toMatchObject({ supplierId: supplierId, saved: 2 });
    expect(await deps.prices.listBySupplier(supplierId)).toHaveLength(2);
    // Один файл ещё без итога: сводка ждёт.
    expect(await runPriceDiskSync(deps, scheduler, INITIAL)).toMatchObject({ enqueued: 0 });
    expect(summaries()).toEqual([]);

    // Файл 2: скан - пропуск; отдельное сообщение менеджеру не уходит.
    const skipped = await reportToManager.execute(
      { kind: 'scan_skipped', path: scan, fileHash: 'h-scan' },
      deps,
      diskCtx(scan),
    );
    expect(skipped).toEqual({ delivered: false, inSummary: true });
    expect(deps.chat.outbox).toEqual([]);

    await runPriceDiskSync(deps, scheduler, INITIAL);
    const [summary, ...rest] = summaries();
    expect(rest).toEqual([]);
    expect(summary).toContain('Записано: 1 (позиций: 2)');
    expect(summary).toContain('Пропущено: 1');
    expect(summary).toContain('скан без текста');
    expect(summary).toContain('прайс скан.csv');
    expect(summary).toContain('«Ромашка»');

    // Повторный тик сводку не дублирует.
    await runPriceDiskSync(deps, scheduler, INITIAL);
    expect(summaries()).toHaveLength(1);
  });

  test('structure_changed при первичном импорте: needs_review и complex_table', async () => {
    const file = 'Сложный/прайс.csv';
    put(file, 'Наименование,Цена\nБолт,10');
    await runPriceDiskSync(deps, scheduler, INITIAL);
    const out = await reportToManager.execute(
      { kind: 'structure_changed', path: file, fileHash: 'h-complex' },
      deps,
      diskCtx(file),
    );
    expect(out).toEqual({ delivered: false, inSummary: true });
    expect(deps.chat.outbox).toEqual([]);
    await runPriceDiskSync(deps, scheduler, INITIAL);
    const [summary] = summaries();
    expect(summary).toContain('нужна проверка (сложная таблица)');
    expect(summary).not.toContain('изменилась структура');
  });

  test('structure_changed в обычной синхронизации остаётся сообщением о структуре', async () => {
    await runPriceDiskSync(deps, scheduler);
    put('Вега/прайс в.csv', 'Наименование,Цена\nБолт,1');
    await runPriceDiskSync(deps, scheduler);
    const out = await reportToManager.execute(
      { kind: 'structure_changed', path: 'Вега/прайс в.csv', fileHash: 'h-v' },
      deps,
      diskCtx('Вега/прайс в.csv'),
    );
    expect(out).toEqual({ delivered: true });
    const texts = deps.chat.outbox.map((item) => item.message?.text ?? '');
    expect(texts.join('\n')).toContain('изменилась структура');
  });

  test('файл без итога по истечении срока попадает в пропущенные', async () => {
    put('Аква/прайс а.csv', 'Наименование,Цена\nБолт,1');
    await runPriceDiskSync(deps, scheduler, INITIAL);
    (deps.clock as unknown as { advance(ms: number): void }).advance(
      INITIAL_IMPORT_RESULT_TIMEOUT_MS + 1,
    );
    await runPriceDiskSync(deps, scheduler, INITIAL);
    expect(summaries()[0]).toContain('агент не дал результата');
  });

  test('обычная синхронизация итогов не ведёт: инструменты работают как раньше', async () => {
    await runPriceDiskSync(deps, scheduler);
    put('Бета/прайс б.csv', 'Наименование,Цена\nБолт,1');
    await runPriceDiskSync(deps, scheduler);
    const out = await reportToManager.execute(
      { kind: 'scan_skipped', path: 'Бета/прайс б.csv', fileHash: 'h-b' },
      deps,
      diskCtx('Бета/прайс б.csv'),
    );
    expect(out).toEqual({ delivered: true });
    expect(summaries()).toHaveLength(0);
  });
});

describe('первичный импорт: сбой посреди тика не превращает его в baseline', () => {
  /** Ключ списка «известных» файлов в состоянии синхронизации. */
  const KNOWN_KEY = 'known';

  test('сбой записи списка сразу после отметки: повтор импортирует прайсы', async () => {
    put('Ромашка/прайс.csv', 'Наименование,Цена\nБолт,10');
    const state = deps.state;
    if (state === undefined) throw new Error('нет хранилища состояния');
    const realPut = state.put.bind(state);
    let failures = 1;
    state.put = async (namespace, key, value, options) => {
      if (key === KNOWN_KEY && failures > 0) {
        failures -= 1;
        throw new Error('сбой хранилища');
      }
      return realPut(namespace, key, value, options);
    };
    await expect(runPriceDiskSync(deps, scheduler, INITIAL)).rejects.toThrow('сбой хранилища');
    const retry = await runPriceDiskSync(deps, scheduler, INITIAL);
    expect(retry).toMatchObject({ status: 'synced', enqueued: 1 });
  });

  test('сбой чтения диска посреди тика: следующий тик без флага продолжает импорт', async () => {
    put('Ромашка/прайс.csv', 'Наименование,Цена\nБолт,10');
    const files = deps.files;
    const realChanges = files.changesSince.bind(files);
    let failures = 1;
    files.changesSince = async (known) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('диск недоступен');
      }
      return realChanges(known);
    };
    await expect(runPriceDiskSync(deps, scheduler, INITIAL)).rejects.toThrow('диск недоступен');
    // Флаг уже не передаётся: отметка стоит, значит импорт идёт дальше, а не baseline.
    const retry = await runPriceDiskSync(deps, scheduler);
    expect(retry).toMatchObject({ status: 'synced', enqueued: 1 });
  });
});
