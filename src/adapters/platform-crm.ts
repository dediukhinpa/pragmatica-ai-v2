import type { Crm as PlatformCrm, IdempotencyKey } from '@business-ai/core';
import type { PurchaseRequest } from '../kit/domain/models';
import type { Crm } from '../kit/ports/crm.owned';

/**
 * CRM Прагматики поверх платформенного порта. Запись заметок в сделку платформа умеет;
 * разбор заявки по сделке (товарные строки и карта полей) - предметная часть, которой в
 * платформенном порте нет, поэтому здесь заявка по ссылке на сделку не находится
 * (`null`): сотрудника просят прислать заявку текстом. Пробел платформы, см. отчёт манифеста.
 */
export class PlatformBackedCrm implements Crm {
  constructor(private readonly base: PlatformCrm) {}

  async getPurchaseRequest(_dealRef: string): Promise<PurchaseRequest | null> {
    return null;
  }

  addNote(dealRef: string, text: string, key: IdempotencyKey): Promise<void> {
    return this.base.addNote(dealRef, text, key);
  }
}
