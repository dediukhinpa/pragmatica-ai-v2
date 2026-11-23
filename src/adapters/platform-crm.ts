import type { Crm as PlatformCrm, IdempotencyKey } from '@business-ai/core';
import type { PurchaseRequest } from '../kit/domain/models';
import type { Crm } from '../kit/ports/crm.owned';

/** Чтение заявки по сделке: то, что проекту нужно от разбора сделки портала. */
export interface PurchaseRequestReader {
  getPurchaseRequest(dealRef: string): Promise<PurchaseRequest | null>;
}

/**
 * CRM Прагматики поверх платформенного порта. Запись заметок в сделку платформа умеет;
 * разбор заявки по сделке (товарные строки и карта полей `BITRIX24_DEAL_FIELD_MAP`) -
 * предметная часть, её даёт проектный читатель (`DealPurchaseRequestReader`). Читателя нет
 * (портал не настроен) - заявка по ссылке на сделку не находится (`null`): сотрудника просят
 * прислать заявку текстом.
 */
export class PlatformBackedCrm implements Crm {
  constructor(
    private readonly base: PlatformCrm,
    private readonly requests?: PurchaseRequestReader | undefined,
  ) {}

  async getPurchaseRequest(dealRef: string): Promise<PurchaseRequest | null> {
    if (this.requests === undefined) return null;
    return this.requests.getPurchaseRequest(dealRef);
  }

  addNote(dealRef: string, text: string, key: IdempotencyKey): Promise<void> {
    return this.base.addNote(dealRef, text, key);
  }
}
