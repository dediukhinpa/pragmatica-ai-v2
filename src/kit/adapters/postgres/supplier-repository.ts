import { z } from 'zod';
import {
  cardFromParts,
  duplicateReasons,
  findDuplicateKeys,
  normalizeEmail,
  normalizeInn,
  parseSupplierNote,
  prepareCardForWrite,
  sortDuplicates,
  SUPPLIER_CARD_SOURCES,
  SUPPLIER_NOTES_READ_LIMIT,
  SUPPLIER_STATUSES,
  MAX_CONTACT_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  type DuplicateCandidate,
  type DuplicateMatch,
  type SupplierCard,
  type SupplierContact,
  type SupplierNote,
} from '../../domain/supplier-card';
import { DomainError } from '@business-ai/core';
import { WORD_START_SEPARATORS, wordStartPattern } from '../../domain/product-search';
import { prepareSupplierForWrite } from '../../domain/requisites';
import { type Supplier } from '../../domain/models';
import { type SupplierFullParts } from '../../domain/supplier-card-full';
import type {
  SaveCardOptions,
  SupplierAddressMatch,
  SupplierCardQuery,
  SupplierRepository,
} from '../../ports/repositories.owned';
import type { PgClient, PgParam } from '@business-ai/adapters';
import { isoTimestamp, numeric, parseRows } from '@business-ai/adapters';
import {
  FULL_SELECT_COLUMNS,
  FULL_UPDATE_SQL,
  fullUpdateParams,
  loadFullLists,
  readFullColumns,
  replaceFullLists,
} from './supplier-card-full';

const supplierRow = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    contact_name: z.string().nullable(),
    inn: z.string().nullable(),
    kpp: z.string().nullable(),
    ogrn: z.string().nullable(),
    legal_address: z.string().nullable(),
    bank_name: z.string().nullable(),
    bik: z.string().nullable(),
    settlement_account: z.string().nullable(),
    correspondent_account: z.string().nullable(),
    director_name: z.string().nullable(),
  })
  .transform(
    (row): Supplier => ({
      id: row.id,
      name: row.name,
      ...(row.email === null ? {} : { email: row.email }),
      ...(row.contact_name === null ? {} : { contactName: row.contact_name }),
      ...(row.inn === null ? {} : { inn: row.inn }),
      ...(row.kpp === null ? {} : { kpp: row.kpp }),
      ...(row.ogrn === null ? {} : { ogrn: row.ogrn }),
      ...(row.legal_address === null ? {} : { legalAddress: row.legal_address }),
      ...(row.bank_name === null ? {} : { bankName: row.bank_name }),
      ...(row.bik === null ? {} : { bik: row.bik }),
      ...(row.settlement_account === null ? {} : { settlementAccount: row.settlement_account }),
      ...(row.correspondent_account === null
        ? {}
        : { correspondentAccount: row.correspondent_account }),
      ...(row.director_name === null ? {} : { directorName: row.director_name }),
    }),
  );

/** Строка карточки: столбцы `suppliers` целиком, списки - JSON-текстом. */
const cardRow = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  contact_name: z.string().nullable(),
  inn: z.string().nullable(),
  kpp: z.string().nullable(),
  ogrn: z.string().nullable(),
  legal_address: z.string().nullable(),
  bank_name: z.string().nullable(),
  bik: z.string().nullable(),
  settlement_account: z.string().nullable(),
  correspondent_account: z.string().nullable(),
  director_name: z.string().nullable(),
  website: z.string().nullable(),
  status: z.enum(SUPPLIER_STATUSES),
  categories: z.string(),
  brands: z.string(),
  regions: z.string(),
  payment_terms: z.string().nullable(),
  delivery_terms: z.string().nullable(),
  min_batch: z.string().nullable(),
  lead_time: z.string().nullable(),
  discounts: z.string().nullable(),
  created_by: z.string().nullable(),
  updated_by: z.string().nullable(),
  source: z.enum(SUPPLIER_CARD_SOURCES).nullable(),
  production_city: z.string().nullable(),
  address: z.string().nullable(),
  strengths: z.string().nullable(),
  weaknesses: z.string().nullable(),
  // numeric приходит строкой; NULL остаётся NULL (coerce превратил бы его в 0).
  defect_rate_percent: z.union([z.null(), numeric]),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

const contactRow = z.object({
  supplier_id: z.string(),
  full_name: z.string().nullable(),
  job_title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  messenger: z.string().nullable(),
  is_primary: z.boolean(),
});

const noteRow = z.object({
  supplier_id: z.string(),
  text: z.string(),
  author_id: z.string(),
  created_at: isoTimestamp,
});

const addressRow = z.object({ address: z.string() });

const duplicateRow = z.object({
  id: z.string(),
  name: z.string(),
  inn: z.string().nullable(),
  email: z.string().nullable(),
  contact_emails: z.string(),
});

const jsonList = z
  .string()
  .transform((text): unknown => JSON.parse(text))
  .pipe(z.array(z.string()));

/** Сколько строк просматривает поиск дублей: страховка от слишком частого слова в названии. */
const DUPLICATE_SCAN_LIMIT = 500;
/** Поставщиков в одном ответе поиска карточек не больше. */
const SEARCH_CARDS_MAX_LIMIT = 200;
/** Любое значение LIKE: символы шаблона экранируются обратной косой чертой. */
const LIKE_SPECIALS = /[\\%_]/g;

/** Текст для сравнения подстрокой: как выражение индекса `suppliers_name_trgm_idx`. */
function foldText(value: string): string {
  return value.toLowerCase().replaceAll('ё', 'е');
}

function likeEscape(value: string): string {
  return value.replace(LIKE_SPECIALS, (char) => `\\${char}`);
}

/** Список строк как параметр для `ARRAY(SELECT jsonb_array_elements_text(...))`. */
function jsonParam(values: readonly string[]): string {
  return JSON.stringify(values);
}

const ARRAY_OF = (position: number): string =>
  `ARRAY(SELECT jsonb_array_elements_text($${position}::text::jsonb))`;

const CARD_COLUMNS = `id, name, email, contact_name, inn, kpp, ogrn, legal_address, bank_name,
  bik, settlement_account, correspondent_account, director_name, website, status,
  to_jsonb(categories)::text AS categories, to_jsonb(brands)::text AS brands,
  to_jsonb(regions)::text AS regions, payment_terms, delivery_terms, min_batch, lead_time,
  discounts, created_by, updated_by, source, production_city, address, strengths, weaknesses,
  defect_rate_percent, created_at, updated_at, ${FULL_SELECT_COLUMNS}`;

const COLUMNS = `id, name, email, contact_name, inn, kpp, ogrn, legal_address, bank_name, bik,
  settlement_account, correspondent_account, director_name`;

/** Столбцы `COLUMNS` с префиксом таблицы `s` (для запросов с соединениями). */
const QUALIFIED_COLUMNS = COLUMNS.split(',')
  .map((column) => `s.${column.trim()}`)
  .join(', ');

/** Значение контакта для CHECK таблицы: пустое и слишком длинное не пишутся. */
function contactValue(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' || trimmed.length > max ? null : trimmed;
}

/** Часть `ON CONFLICT DO UPDATE` записи карточки: заменяет все столбцы карточки. */
const CARD_UPDATE_CLAUSE = `UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
           contact_name = EXCLUDED.contact_name, inn = EXCLUDED.inn, kpp = EXCLUDED.kpp,
           ogrn = EXCLUDED.ogrn, legal_address = EXCLUDED.legal_address,
           bank_name = EXCLUDED.bank_name, bik = EXCLUDED.bik,
           settlement_account = EXCLUDED.settlement_account,
           correspondent_account = EXCLUDED.correspondent_account,
           director_name = EXCLUDED.director_name, website = EXCLUDED.website,
           status = EXCLUDED.status, categories = EXCLUDED.categories,
           brands = EXCLUDED.brands, regions = EXCLUDED.regions,
           payment_terms = EXCLUDED.payment_terms, delivery_terms = EXCLUDED.delivery_terms,
           min_batch = EXCLUDED.min_batch, lead_time = EXCLUDED.lead_time,
           discounts = EXCLUDED.discounts,
           created_by = COALESCE(suppliers.created_by, EXCLUDED.created_by),
           updated_by = COALESCE(EXCLUDED.updated_by, suppliers.updated_by),
           source = COALESCE(EXCLUDED.source, suppliers.source),
           production_city = EXCLUDED.production_city, address = EXCLUDED.address,
           strengths = EXCLUDED.strengths, weaknesses = EXCLUDED.weaknesses,
           defect_rate_percent = EXCLUDED.defect_rate_percent,
           updated_at = COALESCE($28::timestamptz, now())`;

/** Миллисекунды: JS-время карточки не знает микросекунд, которые хранит timestamptz. */
const ROW_VERSION_PRECISION = 'milliseconds';

const versionRow = z.object({ stored_at: isoTimestamp });

/**
 * Проверка условий записи под блокировкой карточки: `createOnly` - id свободен,
 * `expectedUpdatedAt` - карточку не меняли после чтения.
 */
async function assertCardVersion(
  db: PgClient,
  id: string,
  options: SaveCardOptions,
): Promise<void> {
  if (options.createOnly !== true && options.expectedUpdatedAt === undefined) return;
  const rows = parseRows(
    versionRow,
    await db.query(
      `SELECT date_trunc('${ROW_VERSION_PRECISION}', updated_at) AS stored_at
       FROM suppliers WHERE id = $1`,
      [id],
    ),
  );
  const stored = rows[0];
  if (options.createOnly === true) {
    if (stored !== undefined) {
      throw new DomainError('conflict', 'Карточка с таким идентификатором уже существует.');
    }
    return;
  }
  if (stored === undefined) {
    throw new DomainError('not_found', 'Карточка для обновления не найдена.');
  }
  const expected = Date.parse(options.expectedUpdatedAt ?? '');
  if (Number.isNaN(expected) || Date.parse(stored.stored_at) !== expected) {
    throw new DomainError('conflict', 'Карточку изменили после чтения: обновите данные.');
  }
}

/** Поставщики в PostgreSQL. */
export class PostgresSupplierRepository implements SupplierRepository {
  constructor(private readonly db: PgClient) {}

  async upsert(input: Supplier): Promise<void> {
    // Невалидные реквизиты отклоняются до записи (DomainError invalid_input).
    const supplier = prepareSupplierForWrite(input);
    const email = contactValue(
      supplier.email === undefined ? undefined : normalizeEmail(supplier.email),
      MAX_EMAIL_LENGTH,
    );
    const contactName = contactValue(supplier.contactName, MAX_CONTACT_NAME_LENGTH);
    const write = async (db: PgClient): Promise<void> => {
      // Если у поставщика есть сохранённые контакты, столбцы email/contact_name - копия
      // основного контакта: их меняет только синхронизация ниже, а не прежний upsert.
      await db.query(
        `INSERT INTO suppliers (id, name, email, contact_name, inn, kpp, ogrn, legal_address,
           bank_name, bik, settlement_account, correspondent_account, director_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
           email = CASE WHEN EXISTS (
               SELECT 1 FROM supplier_contacts c WHERE c.supplier_id = suppliers.id)
             THEN suppliers.email ELSE EXCLUDED.email END,
           contact_name = CASE WHEN EXISTS (
               SELECT 1 FROM supplier_contacts c WHERE c.supplier_id = suppliers.id)
             THEN suppliers.contact_name ELSE EXCLUDED.contact_name END,
           inn = EXCLUDED.inn, kpp = EXCLUDED.kpp,
           ogrn = EXCLUDED.ogrn, legal_address = EXCLUDED.legal_address,
           bank_name = EXCLUDED.bank_name, bik = EXCLUDED.bik,
           settlement_account = EXCLUDED.settlement_account,
           correspondent_account = EXCLUDED.correspondent_account,
           director_name = EXCLUDED.director_name, updated_at = now()`,
        [
          supplier.id,
          supplier.name,
          // Нормализованный адрес пишется как есть: поиск идёт по индексу lower(email), и
          // btrim() в запросе сделал бы индекс непригодным (память сравнивает по trim+lower).
          supplier.email === undefined ? null : normalizeEmail(supplier.email),
          supplier.contactName ?? null,
          supplier.inn ?? null,
          supplier.kpp ?? null,
          supplier.ogrn ?? null,
          supplier.legalAddress ?? null,
          supplier.bankName ?? null,
          supplier.bik ?? null,
          supplier.settlementAccount ?? null,
          supplier.correspondentAccount ?? null,
          supplier.directorName ?? null,
        ],
      );
      if (email === null && contactName === null) return;
      // Прежний email/contactName правят основной контакт; столбцы следуют за ним.
      await db.query(
        `UPDATE supplier_contacts SET email = COALESCE($2, email),
           full_name = COALESCE($3, full_name)
         WHERE supplier_id = $1 AND is_primary`,
        [supplier.id, email, contactName],
      );
      await db.query(
        `UPDATE suppliers s SET email = c.email, contact_name = c.full_name
         FROM supplier_contacts c
         WHERE s.id = $1 AND c.supplier_id = s.id AND c.is_primary`,
        [supplier.id],
      );
    };
    if (email === null && contactName === null) await write(this.db);
    else await this.db.transaction(write);
  }

  async get(id: string): Promise<Supplier | null> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM suppliers WHERE id = $1`, [id]);
    return parseRows(supplierRow, rows)[0] ?? null;
  }

  async search(query: string, limit: number): Promise<Supplier[]> {
    // position() вместо LIKE: символы % и _ в запросе не требуют экранирования.
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM suppliers
       WHERE position(lower($1) in lower(name)) > 0 ORDER BY name, id LIMIT $2`,
      [query, limit],
    );
    return parseRows(supplierRow, rows);
  }

  async findByAddresses(addresses: readonly string[]): Promise<SupplierAddressMatch[]> {
    const wanted = [...new Set(addresses.map(normalizeEmail).filter((value) => value !== ''))];
    if (wanted.length === 0) return [];
    // Без LIMIT: адреса идут по индексам `suppliers_email_idx` и `supplier_contacts_email_idx`;
    // UNION схлопывает случай, когда адрес есть и в `suppliers.email`, и в контакте.
    const rows = await this.db.query(
      `WITH wanted(address) AS (SELECT jsonb_array_elements_text($1::text::jsonb)),
         hits AS (
           SELECT w.address, s.id FROM wanted w JOIN suppliers s ON lower(s.email) = w.address
           UNION
           SELECT w.address, c.supplier_id AS id FROM wanted w
             JOIN supplier_contacts c ON lower(c.email) = w.address)
       SELECT h.address, ${QUALIFIED_COLUMNS}
       FROM hits h JOIN suppliers s ON s.id = h.id
       ORDER BY s.name, s.id, h.address`,
      [jsonParam(wanted)],
    );
    const suppliers = parseRows(supplierRow, rows);
    const matched = parseRows(addressRow, rows);
    return suppliers.flatMap((supplier, index) => {
      const address = matched[index]?.address;
      return address === undefined ? [] : [{ address, supplier }];
    });
  }

  async listPage(afterId: string | null, limit: number): Promise<Supplier[]> {
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM suppliers
       WHERE $1::text IS NULL OR id > $1::text ORDER BY id LIMIT $2::integer`,
      [afterId, Math.max(0, Math.trunc(limit))],
    );
    return parseRows(supplierRow, rows);
  }

  async getCard(id: string): Promise<SupplierCard | null> {
    return (await loadCards(this.db, [id]))[0] ?? null;
  }

  async getCards(ids: readonly string[]): Promise<SupplierCard[]> {
    return loadCards(this.db, [...new Set(ids)]);
  }

  async saveCard(input: SupplierCard, options: SaveCardOptions = {}): Promise<SupplierCard> {
    const { card, supplier } = prepareCardForWrite(input);
    return this.db.transaction(async (tx) => {
      // Запись одной карточки сериализуется по id (в том числе создание: строки ещё нет,
      // и блокировать нечего): проверка существования и версии ниже не гоняется с записью.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `supplier-card:${card.id}`,
      ]);
      await assertCardVersion(tx, card.id, options);
      const written = await tx.query(
        `INSERT INTO suppliers (id, name, email, contact_name, inn, kpp, ogrn, legal_address,
           bank_name, bik, settlement_account, correspondent_account, director_name,
           website, status, categories, brands, regions, payment_terms, delivery_terms,
           min_batch, lead_time, discounts, created_by, updated_by, source,
           created_at, updated_at, production_city, address, strengths, weaknesses,
           defect_rate_percent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           ${ARRAY_OF(16)}, ${ARRAY_OF(17)}, ${ARRAY_OF(18)}, $19, $20, $21, $22, $23, $24,
           $25, $26, COALESCE($27::timestamptz, now()), COALESCE($28::timestamptz, now()),
           $29, $30, $31, $32, $33)
         ON CONFLICT (id) DO ${options.createOnly === true ? 'NOTHING' : CARD_UPDATE_CLAUSE}
         RETURNING id`,
        [
          card.id,
          supplier.name,
          supplier.email ?? null,
          supplier.contactName ?? null,
          supplier.inn ?? null,
          supplier.kpp ?? null,
          supplier.ogrn ?? null,
          supplier.legalAddress ?? null,
          supplier.bankName ?? null,
          supplier.bik ?? null,
          supplier.settlementAccount ?? null,
          supplier.correspondentAccount ?? null,
          supplier.directorName ?? null,
          card.website ?? null,
          card.status,
          jsonParam(card.supplies.categories),
          jsonParam(card.supplies.brands),
          jsonParam(card.supplies.regions),
          card.terms.payment ?? null,
          card.terms.delivery ?? null,
          card.terms.minBatch ?? null,
          card.terms.leadTime ?? null,
          card.terms.discounts ?? null,
          card.createdBy ?? null,
          card.updatedBy ?? null,
          card.source ?? null,
          card.createdAt ?? null,
          card.updatedAt ?? null,
          card.productionCity ?? null,
          card.address ?? null,
          card.strengths ?? null,
          card.weaknesses ?? null,
          card.defectRatePercent ?? null,
        ],
      );
      // Создание: строка уже появилась (прежний upsert вне блокировки) - не затираем её.
      if (written.length === 0) {
        throw new DomainError('conflict', 'Карточка с таким идентификатором уже существует.');
      }
      // Поля полной карточки (разд. 10 ТЗ, миграция 024) пишутся отдельным запросом: так
      // позиционный список основного INSERT не растёт на три десятка параметров.
      await tx.query(FULL_UPDATE_SQL, fullUpdateParams(card.id, card));
      // Столбец `is_draft` (миграция 031) больше не пишется и не читается: черновиков нет,
      // старые черновики считаются боевыми (миграция 042 сбрасывает флаг у существующих строк).
      await replaceFullLists(tx, card.id, card);
      await tx.query('DELETE FROM supplier_contacts WHERE supplier_id = $1', [card.id]);
      // Контакты и заметки - по одному запросу на пачку (jsonb_array_elements), а не по запросу
      // на строку: заметок бывает до сотен, а транзакция держит advisory-блокировку карточки.
      if (card.contacts.length > 0) {
        await tx.query(
          `INSERT INTO supplier_contacts (supplier_id, sort_order, full_name, job_title, email,
             phone, messenger, is_primary)
           SELECT $1, (e.ord - 1)::integer, e.value->>'fullName', e.value->>'position',
                  e.value->>'email', e.value->>'phone', e.value->>'messenger',
                  (e.value->>'isPrimary')::boolean
           FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS e(value, ord)
           ORDER BY e.ord`,
          [card.id, JSON.stringify(card.contacts)],
        );
      }
      if (card.notes.length > 0) await insertNotes(tx, card.id, card.notes);
      const saved = (await loadCards(tx, [card.id]))[0];
      if (saved === undefined) {
        throw new DomainError('external_failure', 'Карточка не прочитана после записи.');
      }
      return saved;
    });
  }

  async searchCards(query: SupplierCardQuery): Promise<SupplierCard[]> {
    const conditions: string[] = [];
    const params: PgParam[] = [];
    const bind = (value: PgParam): number => params.push(value);
    const name = foldText(query.query?.trim() ?? '');
    // Начало слова вместо подстроки: короткое «мед» не должно находить «Медаль» и «медный».
    // Подстрока остаётся предфильтром (триграммный индекс), слово проверяет регулярное выражение.
    const startsWord = (column: string, needle: string): string => {
      const like = `${column} LIKE '%' || $${bind(likeEscape(needle))} || '%'`;
      if (query.wordStart !== true) return like;
      const split = `regexp_replace(${column}, '${WORD_START_SEPARATORS}', ' ', 'g')`;
      const spaced = `(' ' || ${split} || ' ')`;
      return `(${like} AND ${spaced} ~ $${bind(wordStartPattern(needle))})`;
    };
    if (name !== '') conditions.push(startsWord(`replace(lower(s.name), 'ё', 'е')`, name));
    if (query.inn !== undefined) {
      conditions.push(`s.inn = $${bind(normalizeInn(query.inn))}`);
    }
    const email = normalizeEmail(query.email ?? '');
    if (email !== '') {
      const position = bind(email);
      conditions.push(
        `(lower(s.email) = $${position} OR EXISTS (SELECT 1 FROM supplier_contacts c
           WHERE c.supplier_id = s.id AND lower(c.email) = $${position}))`,
      );
    }
    for (const [column, raw] of [
      ['categories', query.category],
      ['brands', query.brand],
    ] as const) {
      const needle = foldText(raw?.trim() ?? '');
      if (needle === '') continue;
      conditions.push(
        `EXISTS (SELECT 1 FROM unnest(s.${column}) v
           WHERE ${startsWord(`replace(lower(v), 'ё', 'е')`, needle)})`,
      );
    }
    const limit = Math.min(Math.max(0, Math.trunc(query.limit)), SEARCH_CARDS_MAX_LIMIT);
    const limitPosition = bind(limit);
    const rows = await this.db.query(
      `SELECT s.id FROM suppliers s
       ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
       ORDER BY s.name, s.id LIMIT $${limitPosition}::integer`,
      params,
    );
    const ids = parseRows(z.object({ id: z.string() }), rows).map((row) => row.id);
    return loadCards(this.db, ids);
  }

  async findDuplicates(candidate: DuplicateCandidate): Promise<DuplicateMatch[]> {
    const wanted = findDuplicateKeys(candidate);
    // Для названия SQL берёт только предварительный отбор по самому длинному слову;
    // точное сравнение нормализованных названий делает код (`normalizeSupplierName`).
    const token = [...wanted.name.split(' ')].sort((a, b) => b.length - a.length)[0] ?? '';
    const select = `SELECT s.id, s.name, s.inn, s.email,
         COALESCE((SELECT jsonb_agg(lower(c.email)) FROM supplier_contacts c
                   WHERE c.supplier_id = s.id AND c.email IS NOT NULL), '[]'::jsonb)::text
           AS contact_emails
       FROM suppliers s`;
    const exclude = (position: number): string =>
      `($${position}::text IS NULL OR s.id <> $${position}::text)`;
    // Сначала точные ключи (ИНН, email): их совпадения без лимита, чтобы дубль не терялся
    // за сотнями тёзок по слову в названии. Затем отбор по названию с лимитом-страховкой.
    const exactRows = await this.db.query(
      `${select}
       WHERE ${exclude(3)} AND (
         ($1::text IS NOT NULL AND s.inn = $1::text)
         OR lower(s.email) = ANY(${ARRAY_OF(2)})
         OR EXISTS (SELECT 1 FROM supplier_contacts c
                    WHERE c.supplier_id = s.id AND lower(c.email) = ANY(${ARRAY_OF(2)})))
       ORDER BY s.name, s.id`,
      [wanted.inn ?? null, jsonParam(wanted.emails), candidate.id ?? null],
    );
    const nameRows =
      wanted.name === '' || token === ''
        ? []
        : await this.db.query(
            `${select}
             WHERE ${exclude(2)}
               AND replace(lower(s.name), 'ё', 'е') LIKE '%' || $1::text || '%'
             ORDER BY s.name, s.id LIMIT ${DUPLICATE_SCAN_LIMIT}`,
            [likeEscape(token), candidate.id ?? null],
          );
    const matches = new Map<string, DuplicateMatch>();
    const candidates = [
      ...parseRows(duplicateRow, exactRows),
      ...parseRows(duplicateRow, nameRows),
    ];
    for (const row of candidates) {
      if (matches.has(row.id)) continue;
      const contactEmails = jsonList.parse(row.contact_emails);
      const keys = findDuplicateKeys({
        name: row.name,
        ...(row.inn === null ? {} : { inn: row.inn }),
        ...(row.email === null ? {} : { email: row.email }),
        contacts: contactEmails.map((email) => ({ email })),
      });
      const reasons = duplicateReasons(wanted, keys);
      const [reason] = reasons;
      if (reason !== undefined) {
        matches.set(row.id, { supplierId: row.id, name: row.name, reason, reasons });
      }
    }
    return sortDuplicates([...matches.values()]);
  }

  async addNote(supplierId: string, input: SupplierNote): Promise<void> {
    const note = parseSupplierNote(input);
    await this.db.transaction(async (tx) => {
      // Та же блокировка, что у записи карточки: повтор не гоняется с первой записью.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `supplier-card:${supplierId}`,
      ]);
      const exists = await tx.query('SELECT 1 AS one FROM suppliers WHERE id = $1', [supplierId]);
      if (exists.length === 0) {
        throw new DomainError('not_found', 'Поставщик не найден: заметка не добавлена.');
      }
      // Повтор после сбоя (та же заметка: текст, автор, момент) ничего не добавляет.
      await insertNote(tx, supplierId, note);
    });
  }
}

/** Добавить заметку, если точно такой (текст, автор, момент) у карточки ещё нет. */
async function insertNote(db: PgClient, supplierId: string, note: SupplierNote): Promise<void> {
  await db.query(
    `INSERT INTO supplier_notes (supplier_id, text, author_id, created_at)
     SELECT $1, $2, $3, $4::timestamptz
     WHERE NOT EXISTS (SELECT 1 FROM supplier_notes n WHERE n.supplier_id = $1
       AND n.text = $2 AND n.author_id = $3 AND n.created_at = $4::timestamptz)`,
    [supplierId, note.text, note.authorId, note.createdAt],
  );
}

/**
 * Добавить пачку заметок одним запросом. Как и `insertNote`, пропускает заметку, которая уже
 * есть у карточки (текст, автор, момент); одинаковые заметки внутри самой пачки сводятся к
 * первой (DISTINCT ON), порядок вставки - порядок пачки.
 */
async function insertNotes(
  db: PgClient,
  supplierId: string,
  notes: readonly SupplierNote[],
): Promise<void> {
  await db.query(
    `INSERT INTO supplier_notes (supplier_id, text, author_id, created_at)
     SELECT $1, d.text, d.author_id, d.created_at FROM (
       SELECT DISTINCT ON (c.text, c.author_id, c.created_at) c.*
       FROM (
         SELECT e.value->>'text' AS text, e.value->>'authorId' AS author_id,
                (e.value->>'createdAt')::timestamptz AS created_at, e.ord
         FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS e(value, ord)
       ) c
       ORDER BY c.text, c.author_id, c.created_at, c.ord
     ) d
     WHERE NOT EXISTS (SELECT 1 FROM supplier_notes n WHERE n.supplier_id = $1
       AND n.text = d.text AND n.author_id = d.author_id AND n.created_at = d.created_at)
     ORDER BY d.ord`,
    [supplierId, JSON.stringify(notes)],
  );
}

/** Карточки по id (в порядке ids): пять запросов на пачку, без запроса на каждую карточку. */
async function loadCards(db: PgClient, ids: readonly string[]): Promise<SupplierCard[]> {
  if (ids.length === 0) return [];
  const idList = jsonParam(ids);
  const rawRows = await db.query(
    `SELECT ${CARD_COLUMNS} FROM suppliers WHERE id = ANY(${ARRAY_OF(1)})`,
    [idList],
  );
  const supplierRows = parseRows(cardRow, rawRows);
  const fullById = new Map<string, SupplierFullParts>();
  for (const raw of rawRows) fullById.set(String(raw['id']), readFullColumns(raw));
  const lists = await loadFullLists(db, idList);
  const contactRows = parseRows(
    contactRow,
    await db.query(
      `SELECT supplier_id, full_name, job_title, email, phone, messenger, is_primary
       FROM supplier_contacts WHERE supplier_id = ANY(${ARRAY_OF(1)})
       ORDER BY supplier_id, sort_order, id`,
      [idList],
    ),
  );
  const noteRows = parseRows(
    noteRow,
    await db.query(
      `SELECT supplier_id, text, author_id, created_at FROM (
         SELECT supplier_id, text, author_id, created_at, id,
                row_number() OVER (PARTITION BY supplier_id ORDER BY created_at DESC, id DESC)
                  AS rn
         FROM supplier_notes WHERE supplier_id = ANY(${ARRAY_OF(1)})) n
       WHERE rn <= $2::integer ORDER BY supplier_id, created_at, id`,
      [idList, SUPPLIER_NOTES_READ_LIMIT],
    ),
  );
  const contacts = new Map<string, SupplierContact[]>();
  for (const row of contactRows) {
    const list = contacts.get(row.supplier_id) ?? [];
    list.push({
      ...(row.full_name === null ? {} : { fullName: row.full_name }),
      ...(row.job_title === null ? {} : { position: row.job_title }),
      ...(row.email === null ? {} : { email: row.email }),
      ...(row.phone === null ? {} : { phone: row.phone }),
      ...(row.messenger === null ? {} : { messenger: row.messenger }),
      isPrimary: row.is_primary,
    });
    contacts.set(row.supplier_id, list);
  }
  const notes = new Map<string, SupplierNote[]>();
  for (const row of noteRows) {
    const list = notes.get(row.supplier_id) ?? [];
    list.push({ text: row.text, authorId: row.author_id, createdAt: row.created_at });
    notes.set(row.supplier_id, list);
  }
  const byId = new Map(supplierRows.map((row) => [row.id, row]));
  const cards: SupplierCard[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const full: SupplierFullParts = {
      ...fullById.get(id),
      ...(lists.entities.has(id) ? { legalEntities: lists.entities.get(id) } : {}),
      ...(lists.materials.has(id) ? { materials: lists.materials.get(id) } : {}),
    };
    cards.push(toCard(row, contacts.get(id) ?? [], notes.get(id) ?? [], full));
  }
  return cards;
}

function toCard(
  row: z.infer<typeof cardRow>,
  contacts: SupplierContact[],
  notes: SupplierNote[],
  full: SupplierFullParts,
): SupplierCard {
  const optional = (value: string | null): string | undefined => value ?? undefined;
  const supplier: Supplier = {
    id: row.id,
    name: row.name,
    ...(row.email === null ? {} : { email: row.email }),
    ...(row.contact_name === null ? {} : { contactName: row.contact_name }),
    ...(row.inn === null ? {} : { inn: row.inn }),
    ...(row.kpp === null ? {} : { kpp: row.kpp }),
    ...(row.ogrn === null ? {} : { ogrn: row.ogrn }),
    ...(row.legal_address === null ? {} : { legalAddress: row.legal_address }),
    ...(row.bank_name === null ? {} : { bankName: row.bank_name }),
    ...(row.bik === null ? {} : { bik: row.bik }),
    ...(row.settlement_account === null ? {} : { settlementAccount: row.settlement_account }),
    ...(row.correspondent_account === null
      ? {}
      : { correspondentAccount: row.correspondent_account }),
    ...(row.director_name === null ? {} : { directorName: row.director_name }),
  };
  return cardFromParts(supplier, {
    ...(row.website === null ? {} : { website: row.website }),
    status: row.status,
    contacts,
    supplies: {
      categories: jsonList.parse(row.categories),
      brands: jsonList.parse(row.brands),
      regions: jsonList.parse(row.regions),
    },
    terms: {
      ...(row.payment_terms === null ? {} : { payment: row.payment_terms }),
      ...(row.delivery_terms === null ? {} : { delivery: row.delivery_terms }),
      ...(row.min_batch === null ? {} : { minBatch: row.min_batch }),
      ...(row.lead_time === null ? {} : { leadTime: row.lead_time }),
      ...(row.discounts === null ? {} : { discounts: row.discounts }),
    },
    notes,
    createdBy: optional(row.created_by),
    createdAt: row.created_at,
    updatedBy: optional(row.updated_by),
    updatedAt: row.updated_at,
    source: row.source ?? undefined,
    productionCity: optional(row.production_city),
    address: optional(row.address),
    strengths: optional(row.strengths),
    weaknesses: optional(row.weaknesses),
    defectRatePercent: row.defect_rate_percent ?? undefined,
    ...full,
  });
}
