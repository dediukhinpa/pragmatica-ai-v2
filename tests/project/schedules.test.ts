import { afterEach, describe, expect, test } from 'bun:test';
import type { ScheduledTask } from '@business-ai/core';
import type { DefaultJobsOptions } from '@business-ai/core/compose';
import { clearPragmatikaRuntime } from '../../src/runtime';
import {
  PRICE_DISK_SYNC_JOB,
  PROJECT_SCHEDULES,
  SUPPLIER_CRM_SYNC_JOB,
  SUPPLIER_MAIL_PROPOSALS_JOB,
} from '../../src/schedules';

const HOUR_MS = 3_600_000;

/** Параметры службы, которых обработчики без собранного приложения не касаются. */
const NO_OPTIONS = {} as unknown as DefaultJobsOptions;

/** Задача и время запуска: обработчикам без собранного приложения они не нужны. */
const NO_TASK = {} as unknown as ScheduledTask;
const NOW = new Date(0);

type EnabledConfig = Parameters<NonNullable<(typeof PROJECT_SCHEDULES)[number]['enabled']>>[0];

/** Конфигурация с нужными флагами (остальные поля обработчику `enabled` не нужны). */
function configOf(project: Record<string, string>, monitoringEnabled = false): EnabledConfig {
  return { project, agents: { monitoringEnabled } } as unknown as EnabledConfig;
}

function scheduleOf(name: string) {
  const found = PROJECT_SCHEDULES.find((schedule) => schedule.name === name);
  if (found === undefined) throw new Error(`нет задачи ${name}`);
  return found;
}

afterEach(() => {
  clearPragmatikaRuntime();
});

describe('плановые задачи Прагматики', () => {
  test('имена уникальны и не совпадают с платформенными', () => {
    const names = PROJECT_SCHEDULES.map((schedule) => schedule.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(PRICE_DISK_SYNC_JOB);
    expect(names).toContain(SUPPLIER_MAIL_PROPOSALS_JOB);
    expect(names).toContain(SUPPLIER_CRM_SYNC_JOB);
    expect(names).not.toContain('agent.run');
  });

  test('мониторинг ставится по MONITORING_ENABLED платформы', () => {
    const schedule = scheduleOf('monitoring.tick');
    expect(schedule.enabled?.(configOf({}, true))).toBe(true);
    expect(schedule.enabled?.(configOf({}, false))).toBe(false);
  });

  test('синхронизация прайсов ставится только при PRICE_DISK_SYNC_ENABLED=true', () => {
    const schedule = scheduleOf(PRICE_DISK_SYNC_JOB);
    expect(schedule.enabled?.(configOf({ PRICE_DISK_SYNC_ENABLED: 'true' }))).toBe(true);
    expect(schedule.enabled?.(configOf({ PRICE_DISK_SYNC_ENABLED: 'false' }))).toBe(false);
    expect(schedule.enabled?.(configOf({}))).toBe(false);
  });

  test('обзор почты тикает раз в час и ставится по своему флагу', () => {
    const schedule = scheduleOf(SUPPLIER_MAIL_PROPOSALS_JOB);
    expect(schedule.repeat?.everyMs).toBe(HOUR_MS);
    expect(schedule.enabled?.(configOf({ SUPPLIER_MAIL_PROPOSALS_ENABLED: 'true' }))).toBe(true);
    expect(schedule.enabled?.(configOf({ SUPPLIER_MAIL_PROPOSALS_ENABLED: 'false' }))).toBe(false);
  });

  test('снятая CRM-синхронизация: обработчик есть, повторной постановки нет', async () => {
    const schedule = scheduleOf(SUPPLIER_CRM_SYNC_JOB);
    expect(schedule.repeat).toBeUndefined();
    await expect(schedule.handler(NO_OPTIONS)(NO_TASK, NOW)).resolves.toBeUndefined();
  });

  test('до сборки агентов обработчики ничего не делают и не падают', async () => {
    clearPragmatikaRuntime();
    for (const name of [PRICE_DISK_SYNC_JOB, SUPPLIER_MAIL_PROPOSALS_JOB]) {
      await expect(scheduleOf(name).handler(NO_OPTIONS)(NO_TASK, NOW)).resolves.toBeUndefined();
    }
  });
});
