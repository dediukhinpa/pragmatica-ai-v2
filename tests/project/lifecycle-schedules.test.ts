import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryFileSource, MemoryScheduler } from '@business-ai/adapters';
import type { IdGenerator, ScheduledTask } from '@business-ai/core';
import type { DefaultJobsOptions } from '@business-ai/core/compose';
import { PRICE_DISK_SYNC_RUN_TASK } from '../../src/agents/prices/price-disk-sync';
import { DISK_SYNC_RUN_JOB } from '../../src/lifecycle-disk-sync';
import { clearPragmatikaRuntime, setPragmatikaRuntime } from '../../src/runtime';
import { PRICE_DISK_SYNC_JOB, PROJECT_SCHEDULES } from '../../src/schedules';
import { buildFullPricesDeps } from '../agents/prices-support';
import { encode } from '../agents/prices-support';

/** Подключение закрытия итога файла диска к плановым задачам проекта. */

const MTIME = 1_000;
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z');
const NO_TASK = {} as unknown as ScheduledTask;

let counter = 0;
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-${(counter += 1)}` };

afterEach(() => {
  clearPragmatikaRuntime();
});

function scheduleOf(name: string) {
  const found = PROJECT_SCHEDULES.find((schedule) => schedule.name === name);
  if (found === undefined) throw new Error(`нет задачи ${name}`);
  return found;
}

describe('запуск агента на файл диска - задача проекта', () => {
  test('обработчик зарегистрирован, повторной постановки у него нет', () => {
    const schedule = scheduleOf(DISK_SYNC_RUN_JOB);
    expect(schedule.repeat).toBeUndefined();
    expect(schedule.enabled).toBeUndefined();
    expect(schedule.name).not.toBe(PRICE_DISK_SYNC_RUN_TASK);
  });

  test('тик синхронизации диска ставит запуск задачей проекта, а не agent.run', async () => {
    const prices = await buildFullPricesDeps();
    const scheduler = new MemoryScheduler(ids);
    const files = prices.files as MemoryFileSource;
    files.put('Старый/прайс старый.csv', encode('Наименование,Цена\nБолт,10'), MTIME);
    setPragmatikaRuntime({
      clock: prices.clock,
      state: prices.state!,
      prices,
      priceDiskSyncEnabled: true,
      priceDiskInitialImportEnabled: false,
      monitoringEnabled: false,
      timezone: 'UTC',
      orderDigestOpenMaxDays: 1,
    } as unknown as Parameters<typeof setPragmatikaRuntime>[0]);
    const options = { app: { scheduler }, log: () => undefined } as unknown as DefaultJobsOptions;
    const tick = scheduleOf(PRICE_DISK_SYNC_JOB).handler(options);
    await tick(NO_TASK, new Date(0));
    files.put('Новый/прайс новый.csv', encode('Наименование,Цена\nГайка,5'), MTIME);
    await tick(NO_TASK, new Date(0));
    const names = (await scheduler.claimDue(FAR_FUTURE)).map((task) => task.name);
    expect(names).toEqual([DISK_SYNC_RUN_JOB]);
  });
});
