import { z } from 'zod';
import { readState, writeState } from '@business-ai/core';
import type { WorkflowStateStore } from '@business-ai/core';
import { priceItemKey } from './kit/domain/price-diff';
import type { PriceItem } from './kit/domain/models';
import { priceFileStream } from './kit/domain/price-file-stream';

/**
 * Реестр цен, записанных в базу по «да» сотрудника после правки файла (этап 9q). В таблице цен
 * нет поля «автор» и «источник», поэтому аудит (дата, автор, имя файла) и правило «более старый
 * файл с диска не затирает цены сотрудника» держатся здесь, в состоянии сценариев, без миграции.
 *
 * Правило сравнения: у прайса с диска «дата прайса» - дата в имени файла (так же её читает
 * проверка устаревших прайсов). Цена сотрудника, записанная позже конца этой даты, остаётся;
 * файл с той же или более поздней датой заменяет её как обычно. Если в имени файла даты нет,
 * порядок неизвестен: файл заменяет цену, как раньше (иначе цену сотрудника не обновить никогда).
 */

/** Пространство состояния; ключ записи - идентификатор поставщика. */
export const EMPLOYEE_FILE_EDITS_NAMESPACE = 'prices:employee-file-edits';

/** Метка источника в аудите и в ключе импорта. */
export const EMPLOYEE_FILE_EDIT_SOURCE = 'сотрудник, правка файла';
/** Префикс ключа идемпотентной записи в базу (виден в `price_items.import_key`). */
export const EMPLOYEE_FILE_EDIT_KEY_PREFIX = 'employee-file-edit';

/** Сколько позиций одного поставщика держим в реестре (старейшие вытесняются). */
export const EMPLOYEE_FILE_EDITS_MAX = 2000;
/** Сколько дней запись о правке имеет силу: дальше файл с диска заменяет цену как обычно. */
export const EMPLOYEE_FILE_EDIT_TTL_DAYS = 365;
const MS_PER_DAY = 86_400_000;
/** Конец суток для даты файла: 23:59:59.999 по UTC. */
const END_OF_DAY_MS = MS_PER_DAY - 1;
/** Допуск сравнения цен: база хранит цену с фиксированным числом знаков. */
const PRICE_EPSILON = 1e-6;
/** Месяцев в году и сдвиг для вычисления последнего дня месяца. */
const MONTHS_IN_YEAR = 12;

const entrySchema = z.object({
  /** Когда сотрудник подтвердил запись (ISO). */
  editedAt: z.string(),
  /** Имя файла сотрудника, из которого правка. */
  fileName: z.string(),
  /** Тред чата сотрудника (автор). */
  author: z.string(),
  /** Цена, записанная в базу, и прежняя цена в базе. */
  price: z.number(),
  previousPrice: z.number().optional(),
});
export type EmployeeFileEdit = z.infer<typeof entrySchema>;

const registrySchema = z.object({ entries: z.record(z.string(), entrySchema) });

/** Прочитать реестр поставщика; нет состояния или записи - пусто. */
export async function loadEmployeeFileEdits(
  state: WorkflowStateStore | undefined,
  supplierId: string,
): Promise<Record<string, EmployeeFileEdit>> {
  if (state === undefined) return {};
  const value = await readState(state, EMPLOYEE_FILE_EDITS_NAMESPACE, supplierId, registrySchema);
  return value?.entries ?? {};
}

/** Дополнить реестр новыми записями; лишние старейшие и просроченные убираются. */
export async function saveEmployeeFileEdits(
  state: WorkflowStateStore | undefined,
  supplierId: string,
  added: Readonly<Record<string, EmployeeFileEdit>>,
  now: Date,
): Promise<void> {
  if (state === undefined) return;
  const current = await loadEmployeeFileEdits(state, supplierId);
  const limit = now.getTime() - EMPLOYEE_FILE_EDIT_TTL_DAYS * MS_PER_DAY;
  const merged = Object.entries({ ...current, ...added })
    .filter(([, entry]) => Date.parse(entry.editedAt) > limit)
    .sort((a, b) => Date.parse(b[1].editedAt) - Date.parse(a[1].editedAt))
    .slice(0, EMPLOYEE_FILE_EDITS_MAX);
  await writeState(state, EMPLOYEE_FILE_EDITS_NAMESPACE, supplierId, {
    entries: Object.fromEntries(merged),
  });
}

/** Ключ реестра: тот же, что у позиции в прайсе. */
export function employeeEditKey(item: Pick<PriceItem, 'sku' | 'productName'>): string {
  return priceItemKey(item);
}

/** Последний момент даты файла из его имени (конец дня или конец месяца); null - даты нет. */
export function fileDateEnd(sourceFile: string): number | null {
  const date = priceFileStream(sourceFile).date;
  if (date === null) return null;
  const monthIndex = date.month - 1;
  if (monthIndex < 0 || monthIndex >= MONTHS_IN_YEAR) return null;
  // Без дня - конец месяца (день 0 следующего месяца).
  const day = date.day ?? new Date(Date.UTC(date.year, monthIndex + 1, 0)).getUTCDate();
  return Date.UTC(date.year, monthIndex, day) + END_OF_DAY_MS;
}

/** Результат сверки набора с диска с реестром. */
export interface ProtectedImport {
  /** Набор к записи: позиции, чью цену сотрудник записал позже даты файла, остались прежними. */
  items: PriceItem[];
  /** Сколько позиций оставлено с ценой сотрудника. */
  kept: number;
}

/**
 * Не дать более старому файлу с диска затереть цены, записанные сотрудником. Позиция остаётся,
 * только если (а) она есть в реестре, (б) в базе сейчас именно эта запись (цена и дата не
 * менялись другим импортом) и (в) запись сотрудника позже даты файла.
 */
export function protectEmployeeEdits(
  incoming: readonly PriceItem[],
  replaced: readonly PriceItem[],
  registry: Readonly<Record<string, EmployeeFileEdit>>,
  sourceFile: string | undefined,
): ProtectedImport {
  const items = [...incoming];
  if (sourceFile === undefined || Object.keys(registry).length === 0) return { items, kept: 0 };
  const fileEnd = fileDateEnd(sourceFile);
  if (fileEnd === null) return { items, kept: 0 };
  const current = new Map<string, PriceItem>();
  for (const row of replaced) current.set(priceItemKey(row), row);
  let kept = 0;
  const result = items.map((item) => {
    const key = priceItemKey(item);
    const entry = registry[key];
    const row = current.get(key);
    if (entry === undefined || row === undefined) return item;
    const stillOurs =
      Math.abs(row.price - entry.price) < PRICE_EPSILON &&
      Date.parse(row.date) === Date.parse(entry.editedAt);
    if (!stillOurs || Date.parse(entry.editedAt) <= fileEnd) return item;
    kept += 1;
    return row;
  });
  return { items: result, kept };
}
