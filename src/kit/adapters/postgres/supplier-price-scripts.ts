import { z } from 'zod';
import {
  PRICE_SCRIPT_AUTHORS,
  PRICE_SCRIPT_KEEP_VERSIONS,
  type NewSupplierPriceScript,
  type SupplierPriceScript,
  type SupplierPriceScriptRepository,
} from '../../ports/supplier-price-scripts';
import type { PgClient } from '@business-ai/adapters';
import { isoTimestamp, parseRows } from '@business-ai/adapters';

const scriptRow = z
  .object({
    supplier_id: z.string(),
    form_hash: z.string(),
    version: z.coerce.number().int(),
    code: z.string(),
    created_by: z.enum(PRICE_SCRIPT_AUTHORS),
    created_at: isoTimestamp,
  })
  .transform(
    (row): SupplierPriceScript => ({
      supplierId: row.supplier_id,
      formHash: row.form_hash,
      version: row.version,
      code: row.code,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }),
  );

const COLUMNS = 'supplier_id, form_hash, version, code, created_by, created_at';

/** Скрипты разбора прайсов в PostgreSQL (`supplier_price_scripts`, миграция 035). */
export class PostgresSupplierPriceScripts implements SupplierPriceScriptRepository {
  constructor(private readonly db: PgClient) {}

  async findLatest(supplierId: string, formHash: string): Promise<SupplierPriceScript | null> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM supplier_price_scripts
       WHERE supplier_id = $1 AND form_hash = $2 ORDER BY version DESC LIMIT 1`,
      [supplierId, formHash],
    );
    return parseRows(scriptRow, rows)[0] ?? null;
  }

  async save(script: NewSupplierPriceScript): Promise<SupplierPriceScript> {
    // Номер версии и вытеснение старых - одна транзакция под блокировкой пары: два
    // параллельных сохранения не получат один номер.
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `price-script:${script.supplierId}:${script.formHash}`,
      ]);
      const rows = await tx.query(
        `INSERT INTO supplier_price_scripts
           (supplier_id, form_hash, version, code, created_by, created_at)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5::timestamptz
         FROM supplier_price_scripts WHERE supplier_id = $1 AND form_hash = $2
         RETURNING ${COLUMNS}`,
        [script.supplierId, script.formHash, script.code, script.createdBy, script.createdAt],
      );
      const saved = parseRows(scriptRow, rows)[0];
      if (saved === undefined) throw new Error('supplier_price_scripts: запись не вернулась');
      await tx.query(
        `DELETE FROM supplier_price_scripts
         WHERE supplier_id = $1 AND form_hash = $2 AND version <= $3`,
        [script.supplierId, script.formHash, saved.version - PRICE_SCRIPT_KEEP_VERSIONS],
      );
      return saved;
    });
  }
}
