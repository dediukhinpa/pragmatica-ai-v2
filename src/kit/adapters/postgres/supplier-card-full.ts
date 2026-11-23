import { z } from 'zod';
import {
  DOCUMENT_FLOWS,
  MATERIAL_KINDS,
  PACKAGING_KINDS,
  PACKAGING_PRICINGS,
  SUPPLIER_KINDS,
  type SupplierFullKey,
  type SupplierFullParts,
  type SupplierLegalEntity,
  type SupplierMaterial,
} from '../../domain/supplier-card-full';
import { VAT_MODES } from '../../domain/supplier-card-values';
import type { PgClient, PgParam, PgRow } from '@business-ai/adapters';
import { numeric, parseRows } from '@business-ai/adapters';

/**
 * Поля полной карточки поставщика (миграция 024): столбцы `suppliers`, таблицы
 * `supplier_legal_entities` и `supplier_materials`. Соответствие «поле - столбец» задано одной
 * таблицей: из неё строятся чтение, запись и проверка формата строки.
 */

type ColumnKind = 'text' | 'int' | 'num' | 'bool' | 'list' | 'json';

interface FullColumn {
  key: Exclude<SupplierFullKey, 'legalEntities' | 'materials'>;
  column: string;
  kind: ColumnKind;
  /** Схема значения, если оно из перечисления. */
  schema?: z.ZodTypeAny;
}

const FULL_COLUMNS: readonly FullColumn[] = [
  { key: 'logoRef', column: 'logo_ref', kind: 'text' },
  { key: 'supplierKind', column: 'supplier_kind', kind: 'text', schema: z.enum(SUPPLIER_KINDS) },
  { key: 'foundedYear', column: 'founded_year', kind: 'int' },
  { key: 'agencyDiscountPercent', column: 'agency_discount_percent', kind: 'num' },
  { key: 'minOrderAmount', column: 'min_order_amount', kind: 'text' },
  { key: 'samplesAvailable', column: 'samples_available', kind: 'bool' },
  { key: 'samplesQuantity', column: 'samples_quantity', kind: 'int' },
  { key: 'samplesTerms', column: 'samples_terms', kind: 'text' },
  { key: 'paymentNotes', column: 'payment_notes', kind: 'text' },
  { key: 'vatMode', column: 'vat_mode', kind: 'text', schema: z.enum(VAT_MODES) },
  { key: 'vatRatePercent', column: 'vat_rate_percent', kind: 'num' },
  { key: 'freeDelivery', column: 'free_delivery', kind: 'text' },
  { key: 'documentFlow', column: 'document_flow', kind: 'text', schema: z.enum(DOCUMENT_FLOWS) },
  { key: 'contractNotes', column: 'contract_notes', kind: 'text' },
  { key: 'packaging', column: 'packaging', kind: 'text', schema: z.enum(PACKAGING_KINDS) },
  {
    key: 'packagingPricing',
    column: 'packaging_pricing',
    kind: 'text',
    schema: z.enum(PACKAGING_PRICINGS),
  },
  { key: 'technologies', column: 'technologies', kind: 'list' },
  { key: 'personalizationTypes', column: 'personalization_types', kind: 'list' },
  { key: 'technicalRequirements', column: 'technical_requirements', kind: 'text' },
  { key: 'pragmatikaPortfolio', column: 'pragmatika_portfolio', kind: 'text' },
  { key: 'transportInfo', column: 'transport_info', kind: 'text' },
  { key: 'marketingSupport', column: 'marketing_support', kind: 'text' },
  { key: 'trainingFormats', column: 'training_formats', kind: 'list' },
  { key: 'exclusivity', column: 'exclusivity', kind: 'text' },
  { key: 'hasOwnDesigners', column: 'has_own_designers', kind: 'bool' },
  { key: 'designServices', column: 'design_services', kind: 'text' },
  { key: 'hasQualityControl', column: 'has_quality_control', kind: 'bool' },
  { key: 'additionalServices', column: 'additional_services', kind: 'text' },
  { key: 'claimsHandling', column: 'claims_handling', kind: 'text' },
  { key: 'competitiveAdvantages', column: 'competitive_advantages', kind: 'text' },
  { key: 'customers', column: 'customers', kind: 'text' },
  { key: 'turnoverRub', column: 'turnover_rub', kind: 'num' },
  { key: 'turnoverByYear', column: 'turnover_by_year', kind: 'json' },
  { key: 'okved', column: 'okved', kind: 'text' },
  { key: 'employeeCount', column: 'employee_count', kind: 'int' },
];

/** Столбцы для SELECT: списки отдаются JSON-текстом, как `categories` в карточке. */
export const FULL_SELECT_COLUMNS = FULL_COLUMNS.map((item) => {
  if (item.kind === 'list') return `to_jsonb(${item.column})::text AS ${item.column}`;
  // jsonb-столбец отдаётся текстом: драйвер возвращает его по-разному, текст - всегда одинаково.
  if (item.kind === 'json') return `${item.column}::text AS ${item.column}`;
  return item.column;
}).join(', ');

const jsonStrings = z
  .string()
  .transform((text): unknown => JSON.parse(text))
  .pipe(z.array(z.string()));

/** Оборот по годам: JSON-текст массива `{ year, rub }` (столбец `turnover_by_year`). */
const jsonTurnoverYears = z
  .string()
  .transform((text): unknown => JSON.parse(text))
  .pipe(z.array(z.object({ year: z.number().int(), rub: z.number() })));

/** Схема одного столбца по его виду (NULL допустим у всех, кроме списков). */
function columnSchema(item: FullColumn): z.ZodTypeAny {
  if (item.kind === 'list') return jsonStrings;
  if (item.kind === 'json') return jsonTurnoverYears.nullable();
  if (item.kind === 'int' || item.kind === 'num') return z.union([z.null(), numeric]);
  if (item.kind === 'bool') return z.boolean().nullable();
  return (item.schema ?? z.string()).nullable();
}

/** Поля полной карточки из строки `suppliers` (без организаций и материалов). */
export function readFullColumns(row: PgRow): SupplierFullParts {
  const result: Record<string, unknown> = {};
  for (const item of FULL_COLUMNS) {
    const value: unknown = columnSchema(item).parse(row[item.column]);
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[item.key] = value;
  }
  return result as SupplierFullParts;
}

/** Значение поля как параметр запроса: списки - JSON-текстом, отсутствие - NULL. */
function paramOf(card: SupplierFullParts, item: FullColumn): PgParam {
  const value: unknown = card[item.key];
  if (item.kind === 'list') return JSON.stringify(value ?? []);
  if (item.kind === 'json') return value === undefined ? null : JSON.stringify(value);
  return value === undefined ? null : (value as string | number | boolean);
}

/** SQL записи столбцов полной карточки: `$1` - id карточки, дальше по порядку полей. */
export const FULL_UPDATE_SQL = `UPDATE suppliers SET ${FULL_COLUMNS.map((item, index) =>
  item.kind === 'list'
    ? `${item.column} = ARRAY(SELECT jsonb_array_elements_text($${index + 2}::text::jsonb))`
    : item.kind === 'json'
      ? `${item.column} = $${index + 2}::text::jsonb`
      : `${item.column} = $${index + 2}`,
).join(', ')} WHERE id = $1`;

/** Параметры для `FULL_UPDATE_SQL`. */
export function fullUpdateParams(id: string, card: SupplierFullParts): PgParam[] {
  return [id, ...FULL_COLUMNS.map((item) => paramOf(card, item))];
}

const entityRow = z.object({
  supplier_id: z.string(),
  name: z.string(),
  inn: z.string().nullable(),
});

const materialRow = z.object({
  supplier_id: z.string(),
  kind: z.enum(MATERIAL_KINDS),
  ref: z.string(),
  title: z.string().nullable(),
});

/** Заменить организации и материалы карточки (порядок - порядок массива). */
export async function replaceFullLists(
  db: PgClient,
  id: string,
  card: SupplierFullParts,
): Promise<void> {
  await db.query('DELETE FROM supplier_legal_entities WHERE supplier_id = $1', [id]);
  await db.query('DELETE FROM supplier_materials WHERE supplier_id = $1', [id]);
  const entities = card.legalEntities ?? [];
  if (entities.length > 0) {
    await db.query(
      `INSERT INTO supplier_legal_entities (supplier_id, sort_order, name, inn)
       SELECT $1, (e.ord - 1)::integer, e.value->>'name', e.value->>'inn'
       FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS e(value, ord)
       ORDER BY e.ord`,
      [id, JSON.stringify(entities)],
    );
  }
  const materials = card.materials ?? [];
  if (materials.length > 0) {
    await db.query(
      `INSERT INTO supplier_materials (supplier_id, sort_order, kind, ref, title)
       SELECT $1, (e.ord - 1)::integer, e.value->>'kind', e.value->>'ref', e.value->>'title'
       FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS e(value, ord)
       ORDER BY e.ord`,
      [id, JSON.stringify(materials)],
    );
  }
}

/** Организации и материалы пачки карточек: два запроса, результат по id карточки. */
export async function loadFullLists(
  db: PgClient,
  idList: string,
): Promise<{
  entities: Map<string, SupplierLegalEntity[]>;
  materials: Map<string, SupplierMaterial[]>;
}> {
  const entityRows = parseRows(
    entityRow,
    await db.query(
      `SELECT supplier_id, name, inn FROM supplier_legal_entities
       WHERE supplier_id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::text::jsonb)))
       ORDER BY supplier_id, sort_order, id`,
      [idList],
    ),
  );
  const materialRows = parseRows(
    materialRow,
    await db.query(
      `SELECT supplier_id, kind, ref, title FROM supplier_materials
       WHERE supplier_id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::text::jsonb)))
       ORDER BY supplier_id, sort_order, id`,
      [idList],
    ),
  );
  const entities = new Map<string, SupplierLegalEntity[]>();
  for (const row of entityRows) {
    const list = entities.get(row.supplier_id) ?? [];
    list.push({ name: row.name, ...(row.inn === null ? {} : { inn: row.inn }) });
    entities.set(row.supplier_id, list);
  }
  const materials = new Map<string, SupplierMaterial[]>();
  for (const row of materialRows) {
    const list = materials.get(row.supplier_id) ?? [];
    list.push({
      kind: row.kind,
      ref: row.ref,
      ...(row.title === null ? {} : { title: row.title }),
    });
    materials.set(row.supplier_id, list);
  }
  return { entities, materials };
}
