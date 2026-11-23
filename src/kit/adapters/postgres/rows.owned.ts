import { z } from 'zod';
import {
  PRICE_QUALIFIERS,
  PRICE_TIER_BASES,
  PRICE_VAT_VALUES,
  priceTierSchema,
  type PriceItem,
} from '../../domain/models';
import type { PgRow } from '@business-ai/adapters';
import { isoTimestamp, numeric, parseRows } from '@business-ai/adapters';

/** Поля позиции цены, общие для `price_items` и `import_staging_items` (без поставщика). */
const priceFields = {
  product_name: z.string(),
  sku: z.string().nullable(),
  price: numeric,
  currency: z.string(),
  price_date: isoTimestamp,
  // jsonb: драйвер отдаёт массив или (в зависимости от драйвера) строку; NULL - одна цена.
  price_tiers: z
    .preprocess(
      (value) => (typeof value === 'string' ? JSON.parse(value) : value),
      z.array(priceTierSchema).nullable(),
    )
    .optional(),
  // Основание тиражей (миграция 034): 'quantity' - по умолчанию, в позицию не попадает.
  price_tier_basis: z.enum(PRICE_TIER_BASES).nullable().optional(),
  // Цена словами (миграция 033): NULL - точная цена.
  price_qualifier: z.enum(PRICE_QUALIFIERS).nullable().optional(),
  price_max: numeric.nullable().optional(),
  // НДС цены (миграция 039): NULL - не размечен, в позицию не попадает.
  price_vat: z.enum(PRICE_VAT_VALUES).nullable().optional(),
};
/** Строка столбцов `priceFields` -> позиция без поставщика (`sku` опускается при NULL). */
function mapPriceFields(
  row: z.infer<z.ZodObject<typeof priceFields>>,
): Omit<PriceItem, 'supplierId'> {
  return {
    productName: row.product_name,
    ...(row.sku === null ? {} : { sku: row.sku }),
    price: row.price,
    currency: row.currency,
    date: row.price_date,
    ...(row.price_tiers == null ? {} : { priceTiers: row.price_tiers }),
    ...(row.price_tier_basis === 'order_sum' ? { priceTierBasis: 'order_sum' as const } : {}),
    ...(row.price_qualifier == null ? {} : { priceQualifier: row.price_qualifier }),
    ...(row.price_max == null ? {} : { priceMax: row.price_max }),
    ...(row.price_vat == null ? {} : { priceVat: row.price_vat }),
  };
}
/** Строка позиции без поставщика (поставщик известен из заголовка загрузки). */
export const priceItemRow = z.object(priceFields).transform(mapPriceFields);
/** Строка позиции цены `price_items` с поставщиком. */
export const priceRow = z
  .object({
    supplier_id: z.string(),
    // Файл прайса (миграция 001, заполняется импортом с диска); NULL - строка без файла.
    source_file: z.string().nullable().optional(),
    // Момент записи строки: выбирается только поиском цен (этап 161), в остальных запросах нет.
    created_at: isoTimestamp.nullable().optional(),
    ...priceFields,
  })
  .transform(
    (row): PriceItem => ({
      supplierId: row.supplier_id,
      ...mapPriceFields(row),
      ...(row.source_file == null ? {} : { sourceFile: row.source_file }),
      ...(row.created_at == null ? {} : { createdAt: row.created_at }),
    }),
  );
const countRow = z.object({ total: numeric });
/** Значение `total` из результата `SELECT count(*) AS total ...`; пустой результат -> 0. */
export function parseCount(rows: PgRow[]): number {
  return parseRows(countRow, rows)[0]?.total ?? 0;
}
