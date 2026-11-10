import type { CachedSupplierRating, SupplierRatingCache } from '../../ports/supplier-rating-cache';

/** Кэш оценок поставщиков в памяти: одна, последняя запись на поставщика. */
export class MemorySupplierRatingCache implements SupplierRatingCache {
  private readonly bySupplier = new Map<string, CachedSupplierRating>();
  /** Сколько раз кэш просили сохранить запись (для проверок в тестах). */
  puts = 0;

  async get(supplierId: string, factsHash: string): Promise<CachedSupplierRating | null> {
    const entry = this.bySupplier.get(supplierId);
    return entry !== undefined && entry.factsHash === factsHash ? { ...entry } : null;
  }

  async put(entry: CachedSupplierRating): Promise<void> {
    this.puts += 1;
    this.bySupplier.set(entry.supplierId, { ...entry });
  }
}
