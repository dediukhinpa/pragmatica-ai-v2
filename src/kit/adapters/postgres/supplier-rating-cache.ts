import { z } from 'zod';
import {
  SUPPLIER_RATING_SOURCES,
  type CachedSupplierRating,
  type SupplierRatingCache,
} from '../../ports/supplier-rating-cache';
import type { PgClient } from '@business-ai/adapters';
import { isoTimestamp, numeric, parseRows } from '@business-ai/adapters';

const cacheRow = z
  .object({
    supplier_id: z.string(),
    facts_hash: z.string(),
    score: numeric,
    rationale: z.string(),
    source: z.enum(SUPPLIER_RATING_SOURCES),
    created_at: isoTimestamp,
  })
  .transform(
    (row): CachedSupplierRating => ({
      supplierId: row.supplier_id,
      factsHash: row.facts_hash,
      score: row.score,
      rationale: row.rationale,
      source: row.source,
      createdAt: row.created_at,
    }),
  );

/** Кэш оценок поставщиков в PostgreSQL (`supplier_rating_cache`, миграция 026). */
export class PostgresSupplierRatingCache implements SupplierRatingCache {
  constructor(private readonly db: PgClient) {}

  async get(supplierId: string, factsHash: string): Promise<CachedSupplierRating | null> {
    const rows = await this.db.query(
      `SELECT supplier_id, facts_hash, score, rationale, source, created_at
       FROM supplier_rating_cache WHERE supplier_id = $1 AND facts_hash = $2`,
      [supplierId, factsHash],
    );
    return parseRows(cacheRow, rows)[0] ?? null;
  }

  async put(entry: CachedSupplierRating): Promise<void> {
    // Запись и вытеснение прежних записей поставщика - одной транзакцией: между ними не
    // остаётся окна, в котором читатель увидел бы пустой кэш поставщика.
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO supplier_rating_cache
           (supplier_id, facts_hash, score, rationale, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (supplier_id, facts_hash) DO UPDATE
           SET score = EXCLUDED.score, rationale = EXCLUDED.rationale,
               source = EXCLUDED.source, created_at = EXCLUDED.created_at`,
        [entry.supplierId, entry.factsHash, entry.score, entry.rationale, entry.source,
          entry.createdAt],
      );
      await tx.query(
        'DELETE FROM supplier_rating_cache WHERE supplier_id = $1 AND facts_hash <> $2',
        [entry.supplierId, entry.factsHash],
      );
    });
  }
}
