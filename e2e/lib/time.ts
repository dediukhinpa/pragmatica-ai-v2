import type { FixedClock } from '@business-ai/adapters';
import { addDays, isWorkingDay, localDateKey, startOfLocalDay } from '@business-ai/core';
import { waitFor } from './handoff-core';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
/** Час сводки по заказам (`ORDER_DIGEST_HOUR`) в сутках. */
const DIGEST_HOUR = 9;
/** За сколько до сводки проверяется «ещё нет», мин. */
const BEFORE_DIGEST_MINUTES = 15;
/** Префикс записи журнала службы о завершённом тике мониторинга. */
const TICK_EVENT = 'monitoring_tick ';
const DUTY_FAILED_EVENT = 'monitoring_duty_failed';

/** Что нужно для перевода времени: часы теста и журнал службы. */
export interface TickHost {
  clock: FixedClock | undefined;
  logs: readonly string[];
}

/** 9:00 по местному времени следующего рабочего дня (строго после даты `from`). */
export function nextWorkday0900(from: Date, timeZone: string): Date {
  let day = addDays(localDateKey(from, timeZone), 1);
  while (!isWorkingDay(day)) day = addDays(day, 1);
  return new Date(startOfLocalDay(day, timeZone).getTime() + DIGEST_HOUR * MS_PER_HOUR);
}

/** 8:45 того же дня, что и 9:00 `at`: проверка «сводки ещё нет». */
export function beforeDigest(at: Date): Date {
  return new Date(at.getTime() - BEFORE_DIGEST_MINUTES * MS_PER_MINUTE);
}

/** Сколько тиков мониторинга служба уже отработала. */
export function tickCount(host: Pick<TickHost, 'logs'>): number {
  return host.logs.filter((line) => line.startsWith(TICK_EVENT)).length;
}

/** Ждёт завершения первого тика после старта службы (он идёт сразу). */
export async function waitFirstTick(host: Pick<TickHost, 'logs'>): Promise<void> {
  await waitFor('первый тик мониторинга', () => tickCount(host) >= 1);
}

/**
 * Переводит часы на `at` и ждёт, пока воркер выполнит ровно ещё один тик из очереди. Сбой
 * обязанности обрывает ожидание сразу с текстом записи журнала.
 */
export async function advanceTo(host: TickHost, at: Date): Promise<void> {
  const { clock } = host;
  if (clock === undefined) throw new Error('мир запущен без FixedClock: advanceTo недоступен');
  const before = tickCount(host);
  clock.advance(at.getTime() - clock.now().getTime());
  await waitFor(`тик на ${at.toISOString()}`, () => {
    const failed = host.logs.find((line) => line.startsWith(DUTY_FAILED_EVENT));
    if (failed !== undefined) throw new Error(`обязанность упала: ${failed}`);
    return tickCount(host) > before;
  });
}

/** Переводит часы сначала на 8:45, затем на 9:00 следующего рабочего дня (по тику на шаг). */
export async function advanceToNextDigest(host: TickHost, timeZone: string): Promise<void> {
  const { clock } = host;
  if (clock === undefined) throw new Error('мир запущен без FixedClock');
  const target = nextWorkday0900(clock.now(), timeZone);
  await advanceTo(host, beforeDigest(target));
  await advanceTo(host, target);
}
