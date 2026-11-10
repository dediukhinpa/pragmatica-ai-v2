import { z } from 'zod';
import type { WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import { PRICE_DISK_SYNC_NAMESPACE } from './price-disk-sync';

/**
 * Файлы диска, поставщика которых код определить не смог (этап 145): вопрос сотруднику
 * задаётся один раз на хэш содержимого, а не каждые 10 минут; ответ сотрудника лежит рядом и
 * подхватывается следующим тиком. Состояние в пространстве `prices:disk-sync` с отдельными
 * префиксами ключей (список известных файлов и отметка первичного импорта не затронуты).
 */

/** Префикс ключа записи «вопрос задан»; дальше - хэш файла. */
export const SUPPLIER_ASK_PREFIX = 'supplier-ask:';
/** Префикс ключа записи «ответ получен». */
const SUPPLIER_ANSWER_PREFIX = 'supplier-answer:';
/** Страница обхода ожидающих файлов и предел страниц. */
const PENDING_PAGE_SIZE = 100;
const PENDING_MAX_PAGES = 20;

const askSchema = z.object({
  /** Путь файла на диске: по нему сотрудник и инструмент ответа находят файл. */
  path: z.string(),
  askedAt: z.string(),
  /**
   * Треды, куда задан вопрос: ответ принимается только из них и от ответственного. Нет поля -
   * вопрос задан до этапа 148 общему адресату.
   */
  threadIds: z.array(z.string()).optional(),
});
export type SupplierAsk = z.infer<typeof askSchema>;

const answerSchema = z.object({ supplierId: z.string(), answeredAt: z.string() });
export type SupplierAnswer = z.infer<typeof answerSchema>;

export function readSupplierAsk(
  state: WorkflowStateStore,
  hash: string,
): Promise<SupplierAsk | null> {
  return readState(state, PRICE_DISK_SYNC_NAMESPACE, `${SUPPLIER_ASK_PREFIX}${hash}`, askSchema);
}

export function writeSupplierAsk(
  state: WorkflowStateStore,
  hash: string,
  ask: SupplierAsk,
): Promise<void> {
  return writeState(state, PRICE_DISK_SYNC_NAMESPACE, `${SUPPLIER_ASK_PREFIX}${hash}`, ask);
}

export function readSupplierAnswer(
  state: WorkflowStateStore,
  hash: string,
): Promise<SupplierAnswer | null> {
  return readState(
    state,
    PRICE_DISK_SYNC_NAMESPACE,
    `${SUPPLIER_ANSWER_PREFIX}${hash}`,
    answerSchema,
  );
}

export function writeSupplierAnswer(
  state: WorkflowStateStore,
  hash: string,
  answer: SupplierAnswer,
): Promise<void> {
  return writeState(state, PRICE_DISK_SYNC_NAMESPACE, `${SUPPLIER_ANSWER_PREFIX}${hash}`, answer);
}

/** Ожидающий ответа файл: хэш и запись вопроса. */
export interface PendingSupplierFile extends SupplierAsk {
  hash: string;
}

/** Файлы, по которым вопрос задан, а ответа ещё нет. */
export async function listPendingSupplierFiles(
  state: WorkflowStateStore,
): Promise<PendingSupplierFile[]> {
  const pending: PendingSupplierFile[] = [];
  const entries = stateEntries(state, PRICE_DISK_SYNC_NAMESPACE, {
    pageSize: PENDING_PAGE_SIZE,
    maxPages: PENDING_MAX_PAGES,
    after: SUPPLIER_ASK_PREFIX.slice(0, -1),
    prefix: SUPPLIER_ASK_PREFIX,
  });
  for await (const entry of entries) {
    const parsed = askSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    const hash = entry.key.slice(SUPPLIER_ASK_PREFIX.length);
    if ((await readSupplierAnswer(state, hash)) === null) pending.push({ ...parsed.data, hash });
  }
  return pending;
}
