import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { type PriceItem } from '../../domain/models';
import type {
  ImportStaging,
  StagedImport,
  StagingChunk,
  StagingHeader,
} from '../../ports/import-staging';
import type { PgClient } from '@business-ai/adapters';
import { parseCount, priceItemRow } from './rows.owned';
import { parseRows } from '@business-ai/adapters';

const headerRow = z.object({
  supplier_id: z.string(),
  file_hash: z.string(),
  sources: z.union([z.string(), z.record(z.number())]),
});

/**
 * Служебные ключи в `sources` (jsonb; отдельных столбцов нет, миграция не нужна): имена
 * таблиц исходника - числа строк данных; `!truncated` - признак усечения парсером;
 * `!skipped:<ключ куска>` - строки «не позиция» этого куска.
 */
const TRUNCATED_KEY = '!truncated';
const SKIPPED_PREFIX = '!skipped:';
const RESERVED_PREFIX = '!';

interface SourcesSummary {
  sourceRowCount: number;
  skippedRowCount: number;
  truncated: boolean;
}

/** Источники приходят из jsonb объектом или строкой (зависит от драйвера). */
function summarizeSources(sources: string | Record<string, number>): SourcesSummary {
  const table =
    typeof sources === 'string' ? z.record(z.number()).parse(JSON.parse(sources)) : sources;
  let sourceRowCount = 0;
  let skippedRowCount = 0;
  for (const [key, rows] of Object.entries(table)) {
    if (key.startsWith(SKIPPED_PREFIX)) skippedRowCount += rows;
    else if (!key.startsWith(RESERVED_PREFIX)) sourceRowCount += rows;
  }
  return { sourceRowCount, skippedRowCount, truncated: (table[TRUNCATED_KEY] ?? 0) > 0 };
}

/**
 * Staging импорта прайсов в PostgreSQL. Позиции кусков вставляются одним запросом
 * (jsonb_array_elements), параллельные добавления в один импорт сериализуются блокировкой
 * строки импорта.
 */
export class PostgresImportStaging implements ImportStaging {
  constructor(private readonly db: PgClient) {}

  async append(
    importId: string,
    header: StagingHeader,
    chunk: StagingChunk,
    now: Date,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO import_staging (import_id, supplier_id, file_hash, created_at)
         VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT (import_id) DO NOTHING`,
        [importId, header.supplierId, header.fileHash, now.toISOString()],
      );
      const current = parseRows(
        headerRow,
        await tx.query(
          `SELECT supplier_id, file_hash, sources FROM import_staging
           WHERE import_id = $1 FOR UPDATE`,
          [importId],
        ),
      )[0];
      if (
        current === undefined ||
        current.supplier_id !== header.supplierId ||
        current.file_hash !== header.fileHash
      ) {
        throw new DomainError(
          'conflict',
          `Импорт ${importId} начат для другого файла или поставщика.`,
        );
      }
      const accepted = await tx.query(
        `INSERT INTO import_staging_chunks (import_id, chunk_key) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING chunk_key`,
        [importId, chunk.key],
      );
      const sources: Record<string, number> = { [chunk.table]: chunk.tableRows };
      if (chunk.truncated === true) sources[TRUNCATED_KEY] = 1;
      if (accepted.length > 0) sources[`${SKIPPED_PREFIX}${chunk.key}`] = chunk.skippedRows ?? 0;
      await tx.query(
        `UPDATE import_staging SET sources = sources || $2::text::jsonb WHERE import_id = $1`,
        [importId, JSON.stringify(sources)],
      );
      if (accepted.length > 0 && chunk.items.length > 0) {
        await tx.query(
          `INSERT INTO import_staging_items
             (import_id, product_name, sku, price, currency, price_date, price_tiers,
              price_qualifier, price_max, price_tier_basis)
           SELECT $1, e.value->>'productName', e.value->>'sku',
                  (e.value->>'price')::numeric, e.value->>'currency',
                  (e.value->>'date')::timestamptz, e.value->'priceTiers',
                  e.value->>'priceQualifier', (e.value->>'priceMax')::numeric,
                  COALESCE(e.value->>'priceTierBasis', 'quantity')
           FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS e(value, ord)
           ORDER BY e.ord`,
          [importId, JSON.stringify(chunk.items)],
        );
      }
      return parseCount(
        await tx.query(
          'SELECT count(*) AS total FROM import_staging_items WHERE import_id = $1',
          [importId],
        ),
      );
    });
  }

  async load(importId: string): Promise<StagedImport | null> {
    const header = parseRows(
      headerRow,
      await this.db.query(
        'SELECT supplier_id, file_hash, sources FROM import_staging WHERE import_id = $1',
        [importId],
      ),
    )[0];
    if (header === undefined) return null;
    const rows = await this.db.query(
      `SELECT product_name, sku, price, currency, price_date, price_tiers,
              price_qualifier, price_max, price_tier_basis FROM import_staging_items
       WHERE import_id = $1 ORDER BY id`,
      [importId],
    );
    const summary = summarizeSources(header.sources);
    return {
      importId,
      supplierId: header.supplier_id,
      fileHash: header.file_hash,
      ...summary,
      items: parseRows(priceItemRow, rows).map((item) => ({
        supplierId: header.supplier_id,
        ...item,
      })),
    };
  }

  async exists(importId: string): Promise<boolean> {
    // Заголовок импорта есть ровно тогда, когда `load` вернул бы не null.
    const rows = await this.db.query(
      'SELECT EXISTS (SELECT 1 FROM import_staging WHERE import_id = $1) AS present',
      [importId],
    );
    return parseRows(z.object({ present: z.boolean() }), rows)[0]?.present === true;
  }

  async discard(importId: string): Promise<void> {
    await this.db.query('DELETE FROM import_staging WHERE import_id = $1', [importId]);
  }

  async purgeStale(before: Date): Promise<number> {
    const rows = await this.db.query(
      `DELETE FROM import_staging WHERE created_at < $1::timestamptz RETURNING import_id`,
      [before.toISOString()],
    );
    return rows.length;
  }
}
