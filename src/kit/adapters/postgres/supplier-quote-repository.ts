import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { supplierQuoteSchema, type SupplierQuote } from '../../domain/models';
import type { SupplierQuoteRepository } from '../../ports/supplier-quote-repository';
import type { PgClient } from '@business-ai/adapters';
import { isoTimestamp, parseRows } from '@business-ai/adapters';

const quoteRow = z
  .object({
    request_id: z.string(),
    supplier_id: z.string(),
    id: z.string(),
    currency: z.string(),
    received_at: isoTimestamp,
    valid_until: isoTimestamp.nullable(),
    delivery_days: z.number().int().nullable(),
    payment_terms: z.string().nullable(),
    notes: z.string().nullable(),
    source_ref: z.string().nullable(),
    lines: z.string(),
    gaps: z.string(),
  })
  .transform((row): SupplierQuote => {
    // jsonb после записи проверенного КП всё равно разбираем схемой: порча данных в БД
    // (ручная правка, старая версия формы) не должна молча попасть в агент.
    const parsed = supplierQuoteSchema.safeParse({
      id: row.id,
      requestId: row.request_id,
      supplierId: row.supplier_id,
      lines: JSON.parse(row.lines),
      currency: row.currency,
      receivedAt: row.received_at,
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
      ...(row.delivery_days === null ? {} : { deliveryDays: row.delivery_days }),
      ...(row.payment_terms === null ? {} : { paymentTerms: row.payment_terms }),
      ...(row.notes === null ? {} : { notes: row.notes }),
      ...(row.source_ref === null ? {} : { sourceRef: row.source_ref }),
      gaps: JSON.parse(row.gaps),
    });
    if (!parsed.success) {
      throw new DomainError(
        'external_failure',
        `КП ${row.request_id}/${row.supplier_id} в базе повреждено.`,
      );
    }
    return parsed.data;
  });

const COLUMNS = `request_id, supplier_id, id, currency, received_at, valid_until, delivery_days,
  payment_terms, notes, source_ref, lines::text AS lines, gaps::text AS gaps`;

const versionRow = z.object({ version: z.coerce.number().int() });

/** КП поставщиков в PostgreSQL (таблица supplier_quotes, одно актуальное КП на пару). */
export class PostgresSupplierQuoteRepository implements SupplierQuoteRepository {
  constructor(private readonly db: PgClient) {}

  async save(quote: SupplierQuote): Promise<number> {
    const parsed = supplierQuoteSchema.safeParse(quote);
    if (!parsed.success) {
      throw new DomainError('invalid_input', `КП не записано: ${parsed.error.message}`);
    }
    const q = parsed.data;
    const rows = await this.db.query(
      `INSERT INTO supplier_quotes (request_id, supplier_id, id, currency, received_at,
         valid_until, delivery_days, payment_terms, notes, source_ref, lines, gaps)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10,
         $11::text::jsonb, $12::text::jsonb)
       ON CONFLICT (request_id, supplier_id) DO UPDATE SET
         id = EXCLUDED.id, currency = EXCLUDED.currency, received_at = EXCLUDED.received_at,
         valid_until = EXCLUDED.valid_until, delivery_days = EXCLUDED.delivery_days,
         payment_terms = EXCLUDED.payment_terms, notes = EXCLUDED.notes,
         source_ref = EXCLUDED.source_ref, lines = EXCLUDED.lines, gaps = EXCLUDED.gaps,
         version = supplier_quotes.version + 1, updated_at = now()
       RETURNING version`,
      [
        q.requestId,
        q.supplierId,
        q.id,
        q.currency,
        q.receivedAt,
        q.validUntil ?? null,
        q.deliveryDays ?? null,
        q.paymentTerms ?? null,
        q.notes ?? null,
        q.sourceRef ?? null,
        JSON.stringify(q.lines),
        JSON.stringify(q.gaps),
      ],
    );
    const row = parseRows(versionRow, rows)[0];
    if (row === undefined) throw new DomainError('external_failure', 'КП не записано.');
    return row.version;
  }

  async get(requestId: string, supplierId: string): Promise<SupplierQuote | null> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM supplier_quotes WHERE request_id = $1 AND supplier_id = $2`,
      [requestId, supplierId],
    );
    return parseRows(quoteRow, rows)[0] ?? null;
  }

  async listByRequest(requestId: string): Promise<SupplierQuote[]> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM supplier_quotes WHERE request_id = $1
       ORDER BY supplier_id COLLATE "C"`,
      [requestId],
    );
    return parseRows(quoteRow, rows);
  }

  async listBySupplier(supplierId: string): Promise<SupplierQuote[]> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM supplier_quotes WHERE supplier_id = $1
       ORDER BY request_id COLLATE "C"`,
      [supplierId],
    );
    return parseRows(quoteRow, rows);
  }

  async listRequestIdsBySupplier(supplierId: string, limit: number): Promise<string[]> {
    // Те же фильтр и порядок, что у `listBySupplier`, но только id заявок и не больше `limit`.
    const rows = await this.db.query(
      `SELECT DISTINCT request_id COLLATE "C" AS request_id FROM supplier_quotes
       WHERE supplier_id = $1 ORDER BY 1 LIMIT $2`,
      [supplierId, Math.max(limit, 0)],
    );
    return parseRows(z.object({ request_id: z.string() }), rows).map((row) => row.request_id);
  }
}
