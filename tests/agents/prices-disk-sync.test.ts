import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource, MemoryScheduler } from '@business-ai/adapters';
import {
  PRICE_DISK_SYNC_MAX_FILES,
  PRICE_DISK_SYNC_RUN_TASK,
  runPriceDiskSync,
} from '../../src/agents/prices/price-disk-sync';
import { fileRefOf } from '../../src/agents/prices/file-ref';
import type { IdGenerator } from '@business-ai/core';
import { encode, buildFullPricesDeps, type FullPricesDeps } from './prices-support';
import { FILE_REF_SECRET } from './support';

let counter = 0;
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(counter += 1)}` };
const MTIME = 1_000;

/** Синхронизация цен с диска ставит запуски агента только по изменённым прайсам. */
describe('runPriceDiskSync', () => {
  let deps: FullPricesDeps;
  let scheduler: MemoryScheduler;
  let files: MemoryFileSource;
  const put = (path: string, text: string, mtime = MTIME): void =>
    files.put(path, encode(text), mtime);
  const queued = async (): Promise<string[]> =>
    (await scheduler.claimDue(new Date('2100-01-01T00:00:00Z')))
      .filter((task) => task.name === PRICE_DISK_SYNC_RUN_TASK)
      .map((task) => task.payload);

  beforeEach(async () => {
    deps = await buildFullPricesDeps();
    files = deps.files as MemoryFileSource;
    scheduler = new MemoryScheduler(ids);
    put('Старый/прайс старый.csv', 'Наименование,Цена\nБолт,10');
  });

  test('первый запуск только запоминает диск, дальше - только изменённые прайсы', async () => {
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ status: 'baseline' });
    expect(await queued()).toEqual([]);

    put('Новый/прайс новый.csv', 'Наименование,Цена\nГайка,5');
    put('Новый/КП клиенту.csv', 'Наименование,Цена\nГайка,5');
    const result = await runPriceDiskSync(deps, scheduler);
    expect(result).toMatchObject({ status: 'synced', enqueued: 1, deferred: 0 });
    const payloads = await queued();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain(fileRefOf('Новый/прайс новый.csv', FILE_REF_SECRET));

    // Ничего не менялось: повторный тик ничего не ставит.
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 0 });
  });

  test('сверх предела за тик файлы откладываются до следующего тика', async () => {
    await runPriceDiskSync(deps, scheduler);
    const total = PRICE_DISK_SYNC_MAX_FILES + 2;
    for (let i = 0; i < total; i += 1) put(`Альфа/прайс ${i}.csv`, `Наименование,Цена\nБолт,${i + 1}`);
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({
      enqueued: PRICE_DISK_SYNC_MAX_FILES,
      deferred: 2,
    });
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 2, deferred: 0 });
  });

  describe('первичный импорт', () => {
    const INITIAL = { initialImport: true } as const;

    test('без флага существующие прайсы не импортируются (прежнее поведение)', async () => {
      put('Поставщик/прайс 1.csv', 'Наименование,Цена\nБолт,1');
      expect(await runPriceDiskSync(deps, scheduler)).toEqual({
        status: 'baseline',
        enqueued: 0,
        deferred: 0,
      });
      expect(await queued()).toEqual([]);
    });

    test('с флагом ставятся все существующие прайсы, кроме архива и «не брать»', async () => {
      // Настройки области не заданы: архив всё равно не импортируется.
      put('Поставщик/прайс 1.csv', 'Наименование,Цена\nБолт,1');
      put('Архив_цены неактуальные/прайс 2.csv', 'Наименование,Цена\nБолт,2');
      put('Не брать/прайс 3.csv', 'Наименование,Цена\nБолт,3');
      put('Новый/КП клиенту.csv', 'Наименование,Цена\nГайка,5');
      const result = await runPriceDiskSync(deps, scheduler, INITIAL);
      expect(result).toMatchObject({ status: 'synced', enqueued: 2, initialImport: 'completed' });
      const payloads = (await queued()).join('\n');
      expect(payloads).toContain(fileRefOf('Старый/прайс старый.csv', FILE_REF_SECRET));
      expect(payloads).toContain(fileRefOf('Поставщик/прайс 1.csv', FILE_REF_SECRET));
      expect(payloads).not.toContain(fileRefOf('Архив_цены неактуальные/прайс 2.csv', FILE_REF_SECRET));
      expect(payloads).not.toContain(fileRefOf('Не брать/прайс 3.csv', FILE_REF_SECRET));
    });

    test('идёт пачками по лимиту за тик, затем завершается и не повторяется', async () => {
      const total = PRICE_DISK_SYNC_MAX_FILES * 2;
      for (let i = 0; i < total; i += 1) put(`Альфа/прайс ${i}.csv`, `Наименование,Цена\nБолт,${i}`);
      // Всего прайсов total + 1 (старый из beforeEach).
      expect(await runPriceDiskSync(deps, scheduler, INITIAL)).toMatchObject({
        enqueued: PRICE_DISK_SYNC_MAX_FILES,
        deferred: PRICE_DISK_SYNC_MAX_FILES + 1,
        initialImport: 'running',
      });
      expect(await runPriceDiskSync(deps, scheduler, INITIAL)).toMatchObject({
        enqueued: PRICE_DISK_SYNC_MAX_FILES,
        deferred: 1,
        initialImport: 'running',
      });
      expect(await runPriceDiskSync(deps, scheduler, INITIAL)).toMatchObject({
        enqueued: 1,
        deferred: 0,
        initialImport: 'completed',
      });
      // Дальше обычная синхронизация: ничего не изменилось - ничего не ставится.
      expect(await runPriceDiskSync(deps, scheduler, INITIAL)).toMatchObject({ enqueued: 0 });
      expect(await queued()).toHaveLength(total + 1);
    });

    test('включение после обычного baseline тоже импортирует существующие прайсы', async () => {
      await runPriceDiskSync(deps, scheduler);
      expect(await queued()).toEqual([]);
      const result = await runPriceDiskSync(deps, scheduler, INITIAL);
      expect(result).toMatchObject({ enqueued: 1, initialImport: 'completed' });
    });
  });

  test('архив исключается всегда, заданное исключение лишь добавляется к умолчанию', async () => {
    await runPriceDiskSync(deps, scheduler);
    // Пустое выражение и иное выражение не возвращают архив в импорт.
    for (const excludePattern of ['', 'временно']) {
      deps = { ...deps, staleScan: { prefixes: [], excludePattern } };
      put('Архив_цены неактуальные/прайс а.csv', 'Наименование,Цена\nБолт,1');
      put('Архив/прайс б.csv', 'Наименование,Цена\nБолт,2');
      expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 0 });
    }
    // Заданное выражение действует поверх умолчания.
    put('временно/прайс в.csv', 'Наименование,Цена\nБолт,3');
    put('Ромашка/прайс г.csv', 'Наименование,Цена\nБолт,4');
    expect(await runPriceDiskSync(deps, scheduler)).toMatchObject({ enqueued: 1 });
  });
});
