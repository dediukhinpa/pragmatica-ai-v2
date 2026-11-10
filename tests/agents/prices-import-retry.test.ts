import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource, MemoryScheduler } from '@business-ai/adapters';
import { INITIAL_IMPORT_RESULT_TIMEOUT_MS } from '../../src/agents/prices/initial-import-summary';
import {
  PRICE_DISK_SYNC_MAX_FILES,
  diskSyncThreadId,
  runPriceDiskSync,
} from '../../src/agents/prices/price-disk-sync';
import {
  applyPriceImportRetry,
  planPriceImportRetry,
  runPriceRetryTick,
} from '../../src/agents/prices/disk-sync-retry';
import {
  readDiskSyncOutcome,
  recordDiskSyncOutcome,
} from '../../src/agents/prices/disk-sync-outcome';
import type { IdGenerator } from '@business-ai/core';
import { SUPPLIER_ID, existingPrice } from './support';
import {
  RESPONSIBLE_THREAD,
  buildFullPricesDeps,
  encode,
  type FullPricesDeps,
} from './prices-support';

let counter = 0;
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(counter += 1)}` };
const INITIAL = { initialImport: true } as const;
const MTIME = 1_000;
const RETRY_NS_ATTEMPT_ONE = 1;

const WRITTEN = ['Записаны/записан 1.csv', 'Записаны/записан 2.csv'];
const REVIEW = ['Проверка/проверка 1.csv', 'Проверка/проверка 2.csv'];
const SCAN = 'Сканы/скан.csv';
const STALE = 'Зависшие/зависший.csv';
const FRESH = 'Свежие/свежий.csv';
const ALL = [...WRITTEN, ...REVIEW, SCAN, STALE, FRESH];

let deps: FullPricesDeps;
let scheduler: MemoryScheduler;
const clockOf = (): { advance(ms: number): void } =>
  deps.clock as unknown as { advance(ms: number): void };
const summaries = (): string[] =>
  deps.chat.outbox
    .filter((item) => item.threadId === RESPONSIBLE_THREAD)
    .map((item) => item.message?.text ?? '');
const onDisk = () => deps.files.list();
const statusOf = async (path: string) =>
  (await readDiskSyncOutcome(deps.state!, diskSyncThreadId(path)))?.status;

/** Первичный импорт 7 файлов за два тика, затем итоги по файлам как после работы агента. */
async function importedWithMixedOutcomes(): Promise<void> {
  for (const path of ALL) (deps.files as MemoryFileSource).put(path, encode('Наименование,Цена\nБолт,1'), MTIME);
  await runPriceDiskSync(deps, scheduler, INITIAL);
  await runPriceDiskSync(deps, scheduler, INITIAL);
  const record = (path: string, patch: Parameters<typeof recordDiskSyncOutcome>[2]) =>
    recordDiskSyncOutcome(deps, diskSyncThreadId(path), patch);
  for (const path of WRITTEN) await record(path, { status: 'written', rows: 10 });
  await record(REVIEW[0]!, { status: 'skipped', reason: 'needs_review:price_tiers_by_quantity' });
  await record(REVIEW[1]!, { status: 'skipped', reason: 'needs_review:duplicate_row' });
  await record(SCAN, { status: 'skipped', reason: 'scan_skipped' });
  // Два файла так и остались «в очереди»; один из них свежий (его заново поставили позже).
  clockOf().advance(INITIAL_IMPORT_RESULT_TIMEOUT_MS + 1);
  await record(FRESH, { status: 'queued' });
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  scheduler = new MemoryScheduler(ids);
  retryKeys = [];
  const realSchedule = scheduler.schedule.bind(scheduler);
  scheduler.schedule = (name, payload, runAt, key) => {
    if (key.startsWith('prices-disk-retry')) retryKeys.push(key);
    return realSchedule(name, payload, runAt, key);
  };
  await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Болт', 10)], 'seed');
});

/** Ключи задач догрузки, которые ставились в очередь (с повторами вызова). */
let retryKeys: string[] = [];

describe('догрузка: план', () => {
  test('не запускался или идёт - догружать нельзя', async () => {
    expect((await planPriceImportRetry(deps.state!, [], new Date())).blocked).toContain('не запускался');
    (deps.files as MemoryFileSource).put('Альфа/a.csv', encode('x'), MTIME);
    for (let i = 0; i < 2; i += 1) await runPriceDiskSync(deps, scheduler, INITIAL);
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    expect(plan.blocked).toBeUndefined();
  });

  test('written не попадает в план ни при каком выборе причины', async () => {
    await importedWithMixedOutcomes();
    for (const reason of [undefined, 'needs_review', 'no_result', 'scan_skipped', 'duplicate_row']) {
      const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now(), reason);
      expect(plan.alreadyWritten).toBe(WRITTEN.length);
      for (const path of WRITTEN) {
        expect(plan.candidates.map((c) => c.path)).not.toContain(path);
      }
    }
  });

  test('все: skipped и просроченный queued; свежий queued не трогается', async () => {
    await importedWithMixedOutcomes();
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    expect(plan.candidates.map((c) => c.path).sort()).toEqual([...REVIEW, SCAN, STALE].sort());
    expect(plan.inFlight).toBe(1);
  });

  test('по коду причины и по коду замечания', async () => {
    await importedWithMixedOutcomes();
    const byCode = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now(), 'needs_review');
    expect(byCode.candidates.map((c) => c.path).sort()).toEqual([...REVIEW].sort());
    expect(byCode.otherReasons).toBe(2);
    const byIssue = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now(), 'duplicate_row');
    expect(byIssue.candidates.map((c) => c.path)).toEqual([REVIEW[1]!]);
  });

  test('пачка --limit: сначала без результата агента, остальные - следующей попыткой', async () => {
    await importedWithMixedOutcomes();
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now(), undefined, 2);
    expect(plan.candidates.map((c) => c.path)).toEqual([STALE, REVIEW[0]!]);
    expect(plan.overLimit).toBe(2);
    expect(plan.alreadyWritten).toBe(WRITTEN.length);
  });

  test('--file: только названные файлы, written не берётся даже по имени', async () => {
    await importedWithMixedOutcomes();
    const nameOf = (path: string): string => path.replace(/^.*\//, '');
    const wanted = [nameOf(REVIEW[0]!), nameOf(WRITTEN[0]!)];
    const plan = await planPriceImportRetry(
      deps.state!,
      await onDisk(),
      deps.clock.now(),
      undefined,
      undefined,
      wanted,
    );
    expect(plan.candidates.map((c) => c.path)).toEqual([REVIEW[0]!]);
    expect(plan.alreadyWritten).toBe(WRITTEN.length);
    expect(plan.otherReasons).toBeGreaterThan(0);
  });

  test('--file вместе с причиной: нужны оба условия', async () => {
    await importedWithMixedOutcomes();
    const name = REVIEW[0]!.replace(/^.*\//, '');
    const plan = await planPriceImportRetry(
      deps.state!,
      await onDisk(),
      deps.clock.now(),
      'no_result',
      undefined,
      [name],
    );
    expect(plan.candidates).toEqual([]);
  });

  test('пачки по очереди догружают всё, written не попадает ни в одну', async () => {
    await importedWithMixedOutcomes();
    const seen: string[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now(), undefined, 2);
      if (plan.candidates.length === 0) break;
      expect(plan.candidates.some((c) => WRITTEN.includes(c.path))).toBe(false);
      seen.push(...plan.candidates.map((c) => c.path));
      // Агент разобрал пачку: файлы записаны, следующая попытка берёт оставшиеся.
      for (const c of plan.candidates) {
        await recordDiskSyncOutcome(deps, c.threadId, { status: 'written', rows: 1 });
      }
    }
    expect(seen.sort()).toEqual([...REVIEW, SCAN, STALE].sort());
  });
});

describe('догрузка: постановка в очередь', () => {
  test('в очередь только skipped и просроченные queued; written и цены не тронуты', async () => {
    await importedWithMixedOutcomes();
    const pricesBefore = await deps.prices.listBySupplier(SUPPLIER_ID);
    const writtenBefore = await Promise.all(
      WRITTEN.map((p) => readDiskSyncOutcome(deps.state!, diskSyncThreadId(p))),
    );
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    const applied = await applyPriceImportRetry(deps.state!, plan, deps.clock.now());
    expect(applied).toMatchObject({ queued: 4, attempt: RETRY_NS_ATTEMPT_ONE });
    // Тик ставит пачками по лимиту за тик: 4 <= 5, одним тиком.
    const tick = await runPriceRetryTick(deps, scheduler);
    expect(tick).toMatchObject({ enqueued: 4, remaining: 0, skippedWritten: 0 });
    // Задачи только на 4 отложенных файла, ни одной на записанные.
    expect(retryKeys.sort()).toEqual(
      [...REVIEW, SCAN, STALE].map((p) => `prices-disk-retry:${diskSyncThreadId(p)}:1`).sort(),
    );
    for (const path of [...REVIEW, SCAN, STALE]) expect(await statusOf(path)).toBe('queued');
    expect((await readDiskSyncOutcome(deps.state!, diskSyncThreadId(REVIEW[0]!)))?.attempt).toBe(1);
    const writtenAfter = await Promise.all(
      WRITTEN.map((p) => readDiskSyncOutcome(deps.state!, diskSyncThreadId(p))),
    );
    expect(writtenAfter).toEqual(writtenBefore);
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toEqual(pricesBefore);
  });

  test('повторный --apply ничего не добавляет (пока попытка идёт и после постановки)', async () => {
    await importedWithMixedOutcomes();
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    await applyPriceImportRetry(deps.state!, plan, deps.clock.now());
    // Очередь догрузки уже записана: тот же план второй раз не принимается.
    const again = await applyPriceImportRetry(deps.state!, plan, deps.clock.now());
    expect(again.queued).toBe(0);
    const second = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    expect(second.blocked).toContain('ещё идёт');
    await runPriceRetryTick(deps, scheduler);
    // Задачи на тот же файл и попытку второй раз не создаются (ключ задачи).
    await runPriceRetryTick(deps, scheduler);
    const after = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    expect(after.blocked).toContain('ещё идёт');
    const third = await applyPriceImportRetry(deps.state!, after, deps.clock.now());
    expect(third.queued).toBe(0);
    // Всего 4 задачи: повторы ничего не добавили.
    expect(retryKeys).toHaveLength(4);
  });

  test('файл стал written между планом и постановкой - в очередь не уходит', async () => {
    await importedWithMixedOutcomes();
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    // Агент успел записать файл уже после плана.
    await recordDiskSyncOutcome(deps, diskSyncThreadId(REVIEW[0]!), { status: 'written', rows: 3 });
    const applied = await applyPriceImportRetry(deps.state!, plan, deps.clock.now());
    expect(applied).toMatchObject({ queued: 3, skippedWritten: 1 });
    // И даже уже после записи очереди: на тике итог перечитывается ещё раз.
    await recordDiskSyncOutcome(deps, diskSyncThreadId(SCAN), { status: 'written', rows: 1 });
    const tick = await runPriceRetryTick(deps, scheduler);
    expect(tick).toMatchObject({ enqueued: 2, skippedWritten: 1 });
    expect(await statusOf(SCAN)).toBe('written');
    expect(await statusOf(REVIEW[0]!)).toBe('written');
  });

  test('пачками с прежним лимитом за тик', async () => {
    const many = Array.from({ length: PRICE_DISK_SYNC_MAX_FILES + 2 }, (_, i) => `Много/файл ${i}.csv`);
    for (const path of many) (deps.files as MemoryFileSource).put(path, encode('x'), MTIME);
    for (let i = 0; i < 3; i += 1) await runPriceDiskSync(deps, scheduler, INITIAL);
    for (const path of many) {
      await recordDiskSyncOutcome(deps, diskSyncThreadId(path), {
        status: 'skipped',
        reason: 'needs_review',
      });
    }
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    await applyPriceImportRetry(deps.state!, plan, deps.clock.now());
    expect((await runPriceRetryTick(deps, scheduler)).enqueued).toBe(PRICE_DISK_SYNC_MAX_FILES);
    expect((await runPriceRetryTick(deps, scheduler)).enqueued).toBe(2);
  });
});

describe('догрузка: сводка', () => {
  test('после догрузки одна сводка с разделением первый проход / догрузка', async () => {
    await importedWithMixedOutcomes();
    const plan = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now(), 'needs_review');
    await applyPriceImportRetry(deps.state!, plan, deps.clock.now());
    await runPriceRetryTick(deps, scheduler);
    // Итогов от агента ещё нет: сводки нет.
    expect(summaries()).toEqual([]);
    await recordDiskSyncOutcome(deps, diskSyncThreadId(REVIEW[0]!), { status: 'written', rows: 7 });
    await recordDiskSyncOutcome(deps, diskSyncThreadId(REVIEW[1]!), {
      status: 'skipped',
      reason: 'needs_review:duplicate_row',
    });
    await runPriceRetryTick(deps, scheduler);
    const [text, ...rest] = summaries();
    expect(rest).toEqual([]);
    expect(text).toContain('Записано в первый проход: 2 (позиций: 20)');
    expect(text).toContain('Записано при догрузке: 1 (позиций: 7)');
    expect(text).toContain('повторяющиеся строки');
    // Повторный тик сводку не дублирует.
    await runPriceRetryTick(deps, scheduler);
    expect(summaries()).toHaveLength(1);
  });

  test('следующая попытка возможна после сводки и получает новый номер', async () => {
    await importedWithMixedOutcomes();
    const first = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    await applyPriceImportRetry(deps.state!, first, deps.clock.now());
    await runPriceRetryTick(deps, scheduler);
    clockOf().advance(INITIAL_IMPORT_RESULT_TIMEOUT_MS + 1);
    await runPriceRetryTick(deps, scheduler);
    expect(summaries()).toHaveLength(1);
    const next = await planPriceImportRetry(deps.state!, await onDisk(), deps.clock.now());
    expect(next.attempt).toBe(2);
    expect(next.blocked).toBeUndefined();
  });
});
