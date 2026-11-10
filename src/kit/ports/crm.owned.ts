import type { PurchaseRequest } from '../domain/models';
import type { IdempotencyKey } from '@business-ai/core';

/** CRM: источник заявок и приёмник заметок по сделке. */
export interface Crm {
  /** Заявка на расчёт по сделке; null, если нет. */
  getPurchaseRequest(dealRef: string): Promise<PurchaseRequest | null>;
  /**
   * Добавить заметку в сделку. Идемпотентно по ключу. Если такой сделки в этой CRM быть не
   * может (ссылка `text-…`/`task-…` не от портала), заметка тихо не пишется и ошибки нет:
   * «нет такой сделки - не пишем». Сделка, которой нет или к которой нет прав, - по-прежнему
   * отказ адаптера.
   */
  addNote(dealRef: string, text: string, key: IdempotencyKey): Promise<void>;
}
