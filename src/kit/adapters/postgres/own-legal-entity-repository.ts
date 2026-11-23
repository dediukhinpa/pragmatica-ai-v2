import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import {
  ownEntityCodeSchema,
  ownEntityData,
  parseOwnLegalEntityData,
  type OwnEntityCode,
  type OwnLegalEntity,
} from '../../domain/own-legal-entity';
import type {
  OwnLegalEntityRepository,
  SaveOwnLegalEntityItem,
  SaveOwnLegalEntityOptions,
  SaveOwnLegalEntityResult,
} from '../../ports/own-legal-entities';
import type { PgClient } from '@business-ai/adapters';
import { isoTimestamp, parseRows } from '@business-ai/adapters';

/** Необязательное поле: NULL из БД - поля нет (а не `undefined` со значением). */
const optionalText = z
  .string()
  .nullable()
  .transform((value) => value ?? undefined);

const entityRow = z.object({
  code: z.string(),
  full_name: z.string(),
  short_name: z.string(),
  inn: z.string(),
  kpp: z.string(),
  ogrn: optionalText,
  legal_address: z.string(),
  postal_address: optionalText,
  actual_address: optionalText,
  bank_name: z.string(),
  bik: z.string(),
  settlement_account: z.string(),
  correspondent_account: z.string(),
  signatory_position: z.string(),
  signatory_name: z.string(),
  signatory_basis: z.string(),
  phone: optionalText,
  email: optionalText,
  updated_at: isoTimestamp,
  updated_by: z.string(),
});
type EntityRow = z.infer<typeof entityRow>;

const COLUMNS = `code, full_name, short_name, inn, kpp, ogrn, legal_address, postal_address,
  actual_address, bank_name, bik, settlement_account, correspondent_account, signatory_position,
  signatory_name, signatory_basis, phone, email, updated_at, updated_by`;

/** Строка БД -> запись; повреждённые данные (ручная правка мимо кода) заново проверяются схемой. */
function toEntity(row: EntityRow): OwnLegalEntity {
  const code = ownEntityCodeSchema.safeParse(row.code);
  if (!code.success) {
    throw new DomainError('external_failure', 'В таблице реквизитов неизвестный код юрлица.');
  }
  const data = {
    fullName: row.full_name,
    shortName: row.short_name,
    inn: row.inn,
    kpp: row.kpp,
    ogrn: row.ogrn,
    legalAddress: row.legal_address,
    postalAddress: row.postal_address,
    actualAddress: row.actual_address,
    bankName: row.bank_name,
    bik: row.bik,
    settlementAccount: row.settlement_account,
    correspondentAccount: row.correspondent_account,
    signatoryPosition: row.signatory_position,
    signatoryName: row.signatory_name,
    signatoryBasis: row.signatory_basis,
    phone: row.phone,
    email: row.email,
  };
  try {
    return {
      ...parseOwnLegalEntityData(ownEntityData(data as never)),
      code: code.data,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  } catch {
    // Значения в сообщение не попадают: только факт, что запись не проходит проверку.
    throw new DomainError('external_failure', 'Реквизиты юрлица в базе повреждены.');
  }
}

/** Условие конфликта: обновление существующей записи (проверка ожидания уже сделана). */
const ON_CONFLICT_UPDATE = `ON CONFLICT (code) DO UPDATE SET
           full_name = EXCLUDED.full_name, short_name = EXCLUDED.short_name, inn = EXCLUDED.inn,
           kpp = EXCLUDED.kpp, ogrn = EXCLUDED.ogrn, legal_address = EXCLUDED.legal_address,
           postal_address = EXCLUDED.postal_address, actual_address = EXCLUDED.actual_address,
           bank_name = EXCLUDED.bank_name, bik = EXCLUDED.bik,
           settlement_account = EXCLUDED.settlement_account,
           correspondent_account = EXCLUDED.correspondent_account,
           signatory_position = EXCLUDED.signatory_position,
           signatory_name = EXCLUDED.signatory_name, signatory_basis = EXCLUDED.signatory_basis,
           phone = EXCLUDED.phone, email = EXCLUDED.email, updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`;

/**
 * Создание: записи быть не должно. Строки нет, поэтому `FOR UPDATE` ничего не блокирует, и две
 * параллельные загрузки обе прошли бы проверку; `DO NOTHING` отдаёт проигравшей пустой ответ
 * (она ждёт коммита победителя на уникальном индексе) - это `conflict`.
 */
const ON_CONFLICT_SKIP = 'ON CONFLICT (code) DO NOTHING RETURNING code';

const CONFLICT_TEXT =
  'Реквизиты изменились с момента подготовки правки: повторите её по актуальной записи.';

const INSERT_SQL = `INSERT INTO own_legal_entities (code, full_name, short_name, inn, kpp, ogrn,
           legal_address, postal_address, actual_address, bank_name, bik, settlement_account,
           correspondent_account, signatory_position, signatory_name, signatory_basis, phone,
           email, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19::timestamptz, $20)`;

/** Одна запись внутри открытой транзакции (общая для `save` и `saveMany`). */
async function saveInTransaction(
  tx: PgClient,
  item: SaveOwnLegalEntityItem,
): Promise<SaveOwnLegalEntityResult> {
  const { code, options } = item;
  const d = item.data;
  const expected = options.expectedUpdatedAt;
  let current: { updated_at: string } | undefined;
  if (expected !== null) {
    // Блокировка строки: две правки одной записи идут по очереди, вторая видит новую запись.
    const locked = await tx.query(
      'SELECT updated_at FROM own_legal_entities WHERE code = $1 FOR UPDATE',
      [code],
    );
    current = parseRows(z.object({ updated_at: isoTimestamp }), locked)[0];
    if (expected !== undefined && (current?.updated_at ?? null) !== expected) {
      throw new DomainError('conflict', CONFLICT_TEXT);
    }
  }
  const params = [
    code,
    d.fullName,
    d.shortName,
    d.inn,
    d.kpp,
    d.ogrn ?? null,
    d.legalAddress,
    d.postalAddress ?? null,
    d.actualAddress ?? null,
    d.bankName,
    d.bik,
    d.settlementAccount,
    d.correspondentAccount,
    d.signatoryPosition,
    d.signatoryName,
    d.signatoryBasis,
    d.phone ?? null,
    d.email ?? null,
    options.at,
    options.updatedBy,
  ];
  const conflictClause = expected === null ? ON_CONFLICT_SKIP : ON_CONFLICT_UPDATE;
  const rows = await tx.query(`${INSERT_SQL}\n         ${conflictClause}`, params);
  if (expected === null && rows.length === 0) throw new DomainError('conflict', CONFLICT_TEXT);
  return {
    entity: { ...d, code, updatedAt: options.at, updatedBy: options.updatedBy },
    created: expected === null || current === undefined,
  };
}

/** Реквизиты наших юрлиц в PostgreSQL (таблица own_legal_entities, миграция 041). */
export class PostgresOwnLegalEntityRepository implements OwnLegalEntityRepository {
  constructor(private readonly db: PgClient) {}

  async get(code: OwnEntityCode): Promise<OwnLegalEntity | null> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM own_legal_entities WHERE code = $1`,
      [code],
    );
    const row = parseRows(entityRow, rows)[0];
    return row === undefined ? null : toEntity(row);
  }

  async list(): Promise<OwnLegalEntity[]> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM own_legal_entities ORDER BY code COLLATE "C"`,
    );
    return parseRows(entityRow, rows).map(toEntity);
  }

  async save(
    code: OwnEntityCode,
    data: Parameters<OwnLegalEntityRepository['save']>[1],
    options: SaveOwnLegalEntityOptions,
  ): Promise<SaveOwnLegalEntityResult> {
    const [saved] = await this.saveMany([{ code, data, options }]);
    if (saved === undefined) throw new DomainError('external_failure', 'Запись не выполнена.');
    return saved;
  }

  async saveMany(items: readonly SaveOwnLegalEntityItem[]): Promise<SaveOwnLegalEntityResult[]> {
    // Данные проверяются до транзакции: невалидная запись не открывает её вовсе.
    const checked = items.map((item) => ({
      ...item,
      data: parseOwnLegalEntityData(ownEntityData(item.data)),
    }));
    return this.db.transaction(async (tx) => {
      const saved: SaveOwnLegalEntityResult[] = [];
      for (const item of checked) saved.push(await saveInTransaction(tx, item));
      return saved;
    });
  }
}
