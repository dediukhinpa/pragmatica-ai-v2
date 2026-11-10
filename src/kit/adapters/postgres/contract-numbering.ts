import { z } from 'zod';
import { formatContractNumber } from '../../domain/contract-number';
import { SHARED_COUNTER_KEY } from '../../ports/contract-numbering';
import type {
  ContractNumberRequest,
  ContractNumbering,
  IssuedContractNumber,
  LatestContractNumber,
} from '../../ports/contract-numbering';
import type { PgClient } from '@business-ai/adapters';
import { parseRows } from '@business-ai/adapters';

const issuedRow = z
  .object({
    operation_key: z.string(),
    legal_entity: z.string(),
    year: z.coerce.number(),
    sequence: z.coerce.number(),
    number: z.string(),
  })
  .transform(
    (row): IssuedContractNumber => ({
      operationKey: row.operation_key,
      legalEntity: row.legal_entity,
      year: row.year,
      sequence: row.sequence,
      number: row.number,
    }),
  );

const latestRow = z.object({ document_date: z.string() });

const SELECT_ISSUED = `SELECT operation_key, legal_entity, year, sequence, number
  FROM contract_numbers WHERE operation_key = $1`;

/** Нумерация договоров в PostgreSQL (таблицы `contract_number*`, миграции 027 и 040). */
export class PostgresContractNumbering implements ContractNumbering {
  constructor(private readonly db: PgClient) {}

  async issue(request: ContractNumberRequest): Promise<IssuedContractNumber> {
    return this.db.transaction(async (tx) => {
      // Блокировка по ключу операции: два одновременных повтора не выдадут два номера.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `contract-number:${request.operationKey}`,
      ]);
      const existing = parseRows(issuedRow, await tx.query(SELECT_ISSUED, [request.operationKey]));
      if (existing[0] !== undefined) return existing[0];
      // Ключ счётчика общий для юрлиц: номер сквозной, юрлицо остаётся только в префиксе.
      // Счётчик растёт одним оператором: строка блокируется до конца транзакции, номера разные.
      // Старт и каждый шаг - не ниже максимума уже выданных за год номеров: если код выложили
      // раньше миграции 040, строки 'ALL' ещё нет, и без этого счёт пошёл бы с 1 поверх 7 и 12.
      const counter = await tx.query(
        `INSERT INTO contract_number_counters (legal_entity, year, last_sequence)
         SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1
           FROM contract_numbers WHERE year = $2
         ON CONFLICT (legal_entity, year)
         DO UPDATE SET last_sequence = GREATEST(
           contract_number_counters.last_sequence,
           (SELECT COALESCE(MAX(sequence), 0) FROM contract_numbers WHERE year = $2)
         ) + 1
         RETURNING last_sequence`,
        [SHARED_COUNTER_KEY, request.year],
      );
      const sequence = z.coerce.number().parse(counter[0]?.['last_sequence']);
      const number = formatContractNumber(request.legalEntity, request.year, sequence);
      await tx.query(
        `INSERT INTO contract_numbers
           (operation_key, legal_entity, year, sequence, number, document_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          request.operationKey,
          request.legalEntity,
          request.year,
          sequence,
          number,
          request.documentDate ?? null,
        ],
      );
      return {
        operationKey: request.operationKey,
        legalEntity: request.legalEntity,
        year: request.year,
        sequence,
        number,
      };
    });
  }

  async find(operationKey: string): Promise<IssuedContractNumber | null> {
    return parseRows(issuedRow, await this.db.query(SELECT_ISSUED, [operationKey]))[0] ?? null;
  }

  async findLatest(
    operationKeyPrefix: string,
    legalEntity: string,
  ): Promise<LatestContractNumber | null> {
    // starts_with, а не LIKE: в ключе встречаются «%» и «_», которые LIKE понял бы как шаблон.
    // Дата договора; у записей до миграции 037 её нет, берётся дата выдачи номера.
    const rows = await this.db.query(
      `SELECT operation_key, legal_entity, year, sequence, number,
              to_char(COALESCE(document_date, created_at::date), 'YYYY-MM-DD') AS document_date
         FROM contract_numbers
        WHERE starts_with(operation_key, $1) AND legal_entity = $2
        ORDER BY created_at DESC, year DESC, sequence DESC
        LIMIT 1`,
      [operationKeyPrefix, legalEntity],
    );
    const issued = parseRows(issuedRow, rows)[0];
    const date = parseRows(latestRow, rows)[0]?.document_date;
    return issued === undefined || date === undefined ? null : { ...issued, documentDate: date };
  }
}
