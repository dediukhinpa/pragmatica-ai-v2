import { DomainError } from '@business-ai/core';
import { supplierQuoteSchema, type SupplierQuote } from '../../domain/models';
import type { SupplierQuoteRepository } from '../../ports/supplier-quote-repository';

interface StoredQuote {
  quote: SupplierQuote;
  version: number;
}

/** Ключ КП: пара «заявка и поставщик» (разделитель не встречается в id: NUL). */
const keyOf = (requestId: string, supplierId: string): string => `${requestId}\0${supplierId}`;

/** Сравнение по кодовым точкам, как в БД (COLLATE "C"), а не по локали. */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** КП поставщиков в памяти процесса. */
export class MemorySupplierQuoteRepository implements SupplierQuoteRepository {
  private readonly items = new Map<string, StoredQuote>();

  async save(quote: SupplierQuote): Promise<number> {
    const parsed = supplierQuoteSchema.safeParse(quote);
    if (!parsed.success) {
      throw new DomainError('invalid_input', `КП не записано: ${parsed.error.message}`);
    }
    const key = keyOf(quote.requestId, quote.supplierId);
    const version = (this.items.get(key)?.version ?? 0) + 1;
    this.items.set(key, { quote: structuredClone(parsed.data), version });
    return version;
  }

  async get(requestId: string, supplierId: string): Promise<SupplierQuote | null> {
    const found = this.items.get(keyOf(requestId, supplierId));
    return found === undefined ? null : structuredClone(found.quote);
  }

  async listByRequest(requestId: string): Promise<SupplierQuote[]> {
    return [...this.items.values()]
      .filter((stored) => stored.quote.requestId === requestId)
      .map((stored) => structuredClone(stored.quote))
      .sort((a, b) => byCodePoint(a.supplierId, b.supplierId));
  }

  async listBySupplier(supplierId: string): Promise<SupplierQuote[]> {
    return [...this.items.values()]
      .filter((stored) => stored.quote.supplierId === supplierId)
      .map((stored) => structuredClone(stored.quote))
      .sort((a, b) => byCodePoint(a.requestId, b.requestId));
  }

  async listRequestIdsBySupplier(supplierId: string, limit: number): Promise<string[]> {
    return (await this.listBySupplier(supplierId))
      .slice(0, Math.max(limit, 0))
      .map((quote) => quote.requestId);
  }
}
