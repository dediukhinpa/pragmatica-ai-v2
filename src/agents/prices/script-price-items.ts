import { z } from 'zod';
import {
  MAX_PRICE_TIERS,
  PRICE_QUALIFIERS,
  PRICE_TIER_BASES,
  type PriceItem,
  type PriceTier,
} from '../../kit/domain/models';
import { DEFAULT_PRICE_CURRENCY } from './deps';

/**
 * Контракт результата `price_items` (этап 111, тема 3): позиции, которые вернул скрипт в
 * песочнице. Песочница проверяет форму сама; ядро проверяет её второй раз перед staging и
 * превращает в обычные `PriceItem`, которые идут в тот же staging и тот же валидатор импорта,
 * что и разбор таблицы кодом.
 */

/** Самое длинное название, вариант, артикул позиции, символов. */
export const TEXT_MAX_CHARS = 500;
const CURRENCY_CODE = /^[A-Z]{3}$/u;
const WHOLE_WORD_BOUNDARY = '(?<![\\p{L}\\p{N}])';
const WHOLE_WORD_END = '(?![\\p{L}\\p{N}])';

/** Тираж позиции: порог (штуки или сумма заказа), цена, признак цены. */
const scriptTierSchema = z
  .object({
    min_quantity: z.number().int().positive(),
    price: z.number().positive(),
    qualifier: z.enum(PRICE_QUALIFIERS).optional(),
    max: z.number().positive().optional(),
  })
  .strict();

/** Позиция прайса из скрипта. Лишние ключи - ошибка, как в песочнице. */
export const scriptPriceItemSchema = z
  .object({
    name: z.string().trim().min(1).max(TEXT_MAX_CHARS),
    variant: z.string().trim().max(TEXT_MAX_CHARS).optional(),
    sku: z.string().trim().max(TEXT_MAX_CHARS).optional(),
    price: z.number().positive(),
    currency: z.string().regex(CURRENCY_CODE).optional(),
    tiers: z.array(scriptTierSchema).max(MAX_PRICE_TIERS).optional(),
    tier_basis: z.enum(PRICE_TIER_BASES).optional(),
    price_qualifier: z.enum(PRICE_QUALIFIERS).optional(),
    price_max: z.number().positive().optional(),
    note: z.string().max(TEXT_MAX_CHARS).optional(),
  })
  .strict();
export type ScriptPriceItem = z.infer<typeof scriptPriceItemSchema>;

/** Замечание к позиции результата: номер позиции (с 1) и поле, не прошедшее контракт. */
interface ScriptItemIssue {
  index: number;
  /** Имя поля (`price`, `name`...) либо `item`, если негодна вся позиция. */
  field: string;
}

/** Результат разбора присланного списка. */
export interface ParsedScriptItems {
  items: ScriptPriceItem[];
  /** Позиции, не прошедшие контракт (номера с 1). */
  invalid: ScriptItemIssue[];
  /** Номера позиций (с 1), у которых слишком длинный текст обрезан до предела (этап 177). */
  textTrimmed?: number[] | undefined;
  /** Сколько тиражей сверх `MAX_PRICE_TIERS` отброшено у всех позиций (этап 181). */
  tiersDropped?: number | undefined;
}

/**
 * Тиражи сверх `MAX_PRICE_TIERS` отбрасываются (остаются первые), а не отказывают позицию.
 * Возвращает значение и число отброшенных тиражей.
 */
function trimExtraTiers(value: unknown): { value: unknown; dropped: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, dropped: 0 };
  }
  const tiers: unknown = (value as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers) || tiers.length <= MAX_PRICE_TIERS) return { value, dropped: 0 };
  return {
    value: { ...value, tiers: tiers.slice(0, MAX_PRICE_TIERS) },
    dropped: tiers.length - MAX_PRICE_TIERS,
  };
}

const TEXT_FIELDS = ['name', 'variant', 'sku', 'note'] as const;

/**
 * Слишком длинный текст позиции обрезается, а не отбрасывает позицию (этап 177: лимит символов
 * не должен резать просьбу). Возвращает значение с обрезанными полями и признак обрезки.
 */
function trimLongText(value: unknown): { value: unknown; trimmed: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, trimmed: false };
  }
  const copy: Record<string, unknown> = { ...value };
  let trimmed = false;
  for (const field of TEXT_FIELDS) {
    const text = copy[field];
    if (typeof text === 'string' && text.trim().length > TEXT_MAX_CHARS) {
      copy[field] = text.trim().slice(0, TEXT_MAX_CHARS);
      trimmed = true;
    }
  }
  return { value: copy, trimmed };
}

/** Проверить список позиций скрипта контрактом; негодные отдаются номерами, без значений. */
export function parseScriptItems(raw: readonly unknown[]): ParsedScriptItems {
  const items: ScriptPriceItem[] = [];
  const invalid: ScriptItemIssue[] = [];
  const textTrimmed: number[] = [];
  let tiersDropped = 0;
  raw.forEach((original, position) => {
    const cut = trimExtraTiers(original);
    tiersDropped += cut.dropped;
    const { value, trimmed } = trimLongText(cut.value);
    if (trimmed) textTrimmed.push(position + 1);
    const parsed = scriptPriceItemSchema.safeParse(value);
    if (parsed.success) items.push(parsed.data);
    else {
      const field = parsed.error.issues[0]?.path[0];
      invalid.push({ index: position + 1, field: typeof field === 'string' ? field : 'item' });
    }
  });
  return { items, invalid, textTrimmed, tiersDropped };
}

function containsWhole(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${WHOLE_WORD_BOUNDARY}${escaped}${WHOLE_WORD_END}`, 'iu').test(text);
}

/** Название с вариантом (как у разбора таблицы): вариант, уже названный, не повторяется. */
function nameWithVariant(item: ScriptPriceItem): string {
  const variant = item.variant ?? '';
  if (variant === '' || containsWhole(item.name, variant)) return item.name;
  return `${item.name} ${variant}`;
}

/** Артикул с вариантом: у вариантов одного артикула ключ позиции иначе совпал бы. */
function skuWithVariant(item: ScriptPriceItem): string | undefined {
  const sku = item.sku ?? '';
  if (sku === '') return undefined;
  const variant = item.variant ?? '';
  return variant === '' || containsWhole(sku, variant) ? sku : `${sku} / ${variant}`;
}

function toTier(tier: z.infer<typeof scriptTierSchema>): PriceTier {
  return {
    minQuantity: tier.min_quantity,
    price: tier.price,
    ...(tier.qualifier === undefined ? {} : { qualifier: tier.qualifier }),
    ...(tier.max === undefined ? {} : { max: tier.max }),
  };
}

/** Параметры превращения позиций скрипта в позиции прайса. */
export interface ScriptItemsContext {
  supplierId: string;
  /** Дата цены (ISO), как у разбора таблицы - момент разбора. */
  date: string;
  /** Валюта, если позиция её не назвала; нет - рубли. */
  defaultCurrency?: string | undefined;
}

/**
 * Позиции скрипта -> позиции прайса. Поведение как у разбора таблицы: основание тиража хранится
 * только `order_sum`, признак цены и верхняя граница переносятся, цена позиции с тиражами
 * остаётся такой, какую вернул скрипт (расхождение с первым тиражом ловит сверка).
 */
export function toPriceItems(
  items: readonly ScriptPriceItem[],
  context: ScriptItemsContext,
): PriceItem[] {
  const fallback = context.defaultCurrency ?? DEFAULT_PRICE_CURRENCY;
  return items.map((item): PriceItem => {
    const sku = skuWithVariant(item);
    const tiers = item.tiers === undefined || item.tiers.length === 0 ? undefined : item.tiers;
    return {
      supplierId: context.supplierId,
      productName: nameWithVariant(item),
      ...(sku === undefined ? {} : { sku }),
      price: item.price,
      currency: item.currency ?? fallback,
      date: context.date,
      ...(tiers === undefined ? {} : { priceTiers: tiers.map(toTier) }),
      ...(tiers !== undefined && item.tier_basis === 'order_sum'
        ? { priceTierBasis: 'order_sum' as const }
        : {}),
      ...(item.price_qualifier === undefined ? {} : { priceQualifier: item.price_qualifier }),
      ...(item.price_max === undefined ? {} : { priceMax: item.price_max }),
    };
  });
}
