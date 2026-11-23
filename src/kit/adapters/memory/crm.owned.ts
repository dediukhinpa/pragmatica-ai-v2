import type { PurchaseRequest } from '../../domain/models';
import type { Crm } from '../../ports/crm.owned';
import type { IdempotencyKey } from '@business-ai/core';

/** CRM в памяти. */
export class MemoryCrm implements Crm {
  readonly notes = new Map<string, string[]>();
  private readonly seen = new Set<IdempotencyKey>();

  constructor(private readonly requests: ReadonlyMap<string, PurchaseRequest> = new Map()) {}

  async getPurchaseRequest(dealRef: string): Promise<PurchaseRequest | null> {
    return this.requests.get(dealRef) ?? null;
  }

  async addNote(dealRef: string, text: string, key: IdempotencyKey): Promise<void> {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.notes.set(dealRef, [...(this.notes.get(dealRef) ?? []), text]);
  }
}
