import { z } from 'zod';
import { type PurchaseRequest, purchaseRequestSchema } from '../../domain/models';
import type { PurchaseRequestRepository } from '../../ports/repositories.owned';
import type { PgClient } from '@business-ai/adapters';
import { isoTimestamp, parseRows } from '@business-ai/adapters';

const requestRow = z
  .object({
    id: z.string(),
    deal_ref: z.string(),
    items: z.string(),
    created_at: isoTimestamp,
  })
  .transform(
    (row): PurchaseRequest =>
      purchaseRequestSchema.parse({
        id: row.id,
        dealRef: row.deal_ref,
        items: JSON.parse(row.items),
        createdAt: row.created_at,
      }),
  );

const COLUMNS = 'id, deal_ref, items::text AS items, created_at';

/** Заявки на расчёт в PostgreSQL. */
export class PostgresPurchaseRequestRepository implements PurchaseRequestRepository {
  constructor(private readonly db: PgClient) {}

  async save(request: PurchaseRequest): Promise<void> {
    // Срок ответа больше не хранится, но колонка sla_deadline в БД NOT NULL, а миграций по
    // решению владельца не делаем: пишем в неё время создания как нейтральную заглушку.
    // Читается заявка без этой колонки, так что значение нигде не используется.
    await this.db.query(
      `INSERT INTO purchase_requests (id, deal_ref, items, created_at, sla_deadline)
       VALUES ($1, $2, $3::text::jsonb, $4::timestamptz, $4::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        request.id,
        request.dealRef,
        JSON.stringify(request.items),
        request.createdAt,
      ],
    );
  }

  async get(id: string): Promise<PurchaseRequest | null> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM purchase_requests WHERE id = $1`,
      [id],
    );
    return parseRows(requestRow, rows)[0] ?? null;
  }

  async listByDeal(dealRef: string): Promise<PurchaseRequest[]> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM purchase_requests WHERE deal_ref = $1 ORDER BY created_at, id`,
      [dealRef],
    );
    return parseRows(requestRow, rows);
  }
}
