import { z } from 'zod';
import type { TemplateCellValue } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { SiteExportDeps } from './deps';
import { findHeader } from './template-columns';
import { loadWorkbook, requireWorkbook } from './template-store';

/**
 * Цена для сайта (решение владельца, этап 158): стоимость = цена поставщика x 1,7 x 1,22; если
 * цена поставщика уже с НДС, то цена x 1,7. Результат округляется до целого рубля. Множители
 * заданы в процентах целыми числами, чтобы не копить ошибку двоичных дробей.
 */

/** Наценка 1,7 в процентах. */
export const SITE_MARKUP_PERCENT = 170;
/** Цена с НДС 22 %: множитель 1,22 в процентах. */
export const SITE_VAT_FACTOR_PERCENT = 122;
/** Знаменатель процентов. */
const PERCENT = 100;
/** Округление стоимости: до целого рубля. Единственное место, где это задано. */
export const SITE_COST_ROUND = Math.round;
/** Знаков для сглаживания двоичной ошибки перед округлением. */
const FLOAT_GUARD_DIGITS = 6;

/** Стоимость для сайта в целых рублях. */
export function computeSiteCost(supplierPrice: number, priceIncludesVat: boolean): number {
  const marked = (supplierPrice * SITE_MARKUP_PERCENT) / PERCENT;
  const total = priceIncludesVat ? marked : (marked * SITE_VAT_FACTOR_PERCENT) / PERCENT;
  return SITE_COST_ROUND(Number(total.toFixed(FLOAT_GUARD_DIGITS)));
}

/** Интервал цен подписи списка: (от, до] в рублях. Границы бесконечные у крайних подписей. */
export interface PriceInterval {
  label: TemplateCellValue;
  /** Нижняя граница не включается. */
  from: number;
  /** Верхняя граница включается. */
  to: number;
}

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const NUMBER = '(\\d[\\d\\s\\u00a0]*(?:[.,]\\d+)?)';
const UNIT = '(?:\\s*(тыс|млн)[а-я.]*)?';
const DASH = '[-\\u2010-\\u2015\\u2212]';
const UP_TO = new RegExp(`^до\\s*${NUMBER}${UNIT}`);
const MORE_THAN = new RegExp(`^(?:более|свыше|от|>)\\s*${NUMBER}${UNIT}`);
const BETWEEN = new RegExp(`^${NUMBER}\\s*${UNIT}\\s*${DASH}\\s*${NUMBER}${UNIT}`);

function amount(raw: string | undefined, unit: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  if (unit === 'тыс') return value * THOUSAND;
  if (unit === 'млн') return value * MILLION;
  return value;
}

/**
 * Разобрать подпись списка «по цене» в интервал: «до 500 руб.», «до 1 тыс.», «2-5 тыс.»,
 * «более 20 тыс.». Не разобралась - null. Единица «тыс.» в конце диапазона относится к обоим
 * его краям. Граница «до N» включается в этот интервал, следующий интервал начинается выше неё.
 */
export function parsePriceLabel(label: TemplateCellValue): PriceInterval | null {
  const text = String(label).toLowerCase().replace(/\s+/g, ' ').trim();
  const up = UP_TO.exec(text);
  if (up !== null) {
    const to = amount(up[1], up[2]);
    return to === null ? null : { label, from: Number.NEGATIVE_INFINITY, to };
  }
  const more = MORE_THAN.exec(text);
  if (more !== null) {
    const from = amount(more[1], more[2]);
    return from === null ? null : { label, from, to: Number.POSITIVE_INFINITY };
  }
  const between = BETWEEN.exec(text);
  if (between !== null) {
    const unit = between[4] ?? between[2];
    const from = amount(between[1], between[2] ?? unit);
    const to = amount(between[3], between[4] ?? unit);
    return from === null || to === null ? null : { label, from, to };
  }
  return null;
}

/** Выбор значения списка «по цене» для стоимости. */
export type PriceRangeChoice =
  | { status: 'ok'; value: TemplateCellValue }
  /** Ни одна подпись не разобралась: оставь ячейку пустой и предупреди в итоге. */
  | { status: 'list_unparsed'; labels: TemplateCellValue[] }
  /** Стоимость не попала ни в один интервал списка (дыра в границах). */
  | { status: 'no_interval'; labels: TemplateCellValue[] };

/**
 * Выбрать значение «по цене» для стоимости из фактического списка колонки. Подписи разбираются
 * текстом, а не зашитыми строками, поэтому работает и с другими формулировками списка.
 * Допущение: верхняя граница интервала включается («до 1 тыс.» содержит 1000, «2-5 тыс.» - 5000).
 */
export function pickPriceRange(
  cost: number,
  labels: readonly TemplateCellValue[],
): PriceRangeChoice {
  const intervals = labels
    .map(parsePriceLabel)
    .filter((interval): interval is PriceInterval => interval !== null);
  if (intervals.length === 0) return { status: 'list_unparsed', labels: [...labels] };
  // Минимальная верхняя граница среди подходящих: результат не зависит от порядка списка.
  const hit = intervals
    .filter((interval) => cost > interval.from && cost <= interval.to)
    .reduce<PriceInterval | undefined>(
      (best, interval) => (best === undefined || interval.to < best.to ? interval : best),
      undefined,
    );
  return hit === undefined
    ? { status: 'no_interval', labels: [...labels] }
    : { status: 'ok', value: hit.label };
}

const inputSchema = z.object({
  /** Цена поставщика за штуку (рубли), больше нуля. */
  supplierPrice: z.number().positive(),
  /** Цена поставщика уже включает НДС. */
  priceIncludesVat: z.boolean(),
  /**
   * Рабочая книга: из неё берётся фактический список колонки «по цене». Без неё список
   * передаётся в `rangeLabels`; нет ни того, ни другого - вернётся только стоимость.
   */
  workbookId: z.string().min(1).optional(),
  rangeLabels: z.array(z.union([z.string(), z.number()])).max(100).optional(),
});

const outputSchema = z.object({
  /** Стоимость для сайта, целых рублей: пишется в колонку «Стоимость». */
  cost: z.number().int(),
  formula: z.string(),
  rangeStatus: z.enum(['ok', 'list_unparsed', 'no_interval', 'no_list']),
  /** Значение колонки «по цене» из списка файла (только при ok). */
  rangeValue: z.union([z.string(), z.number()]).optional(),
  /** Список колонки, если выбрать автоматически не вышло. */
  rangeLabels: z.array(z.union([z.string(), z.number()])).optional(),
});

/** Стоимость для сайта по цене поставщика и значение колонки «по цене». */
export const computeSitePrice = defineTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'computeSitePrice',
  description:
    'Посчитать стоимость для сайта по цене поставщика: цена x 1,7 x 1,22, а если цена ' +
    'поставщика уже с НДС (priceIncludesVat=true), то цена x 1,7; результат округлён до ' +
    'целого рубля. Вместе со стоимостью выбирает значение колонки «по цене» из ФАКТИЧЕСКОГО ' +
    'списка файла (передай workbookId): верхняя граница интервала входит в него, то есть ' +
    '1000 руб. - «до 1 тыс.», 5000 - «2-5 тыс.». Цену бери из базы прайсов (gatherItemData, ' +
    'источник - диск) или из материала сотрудника; цена, которую назвал сам сотрудник, ' +
    'важнее. Не знаешь, с НДС цена или без, спроси сотрудника. rangeStatus не ok: ячейку ' +
    '«по цене» оставь пустой и вынеси в предупреждения итога, что диапазон не определён.',
  inputSchema,
  outputSchema,
  async execute(input, deps, context) {
    // Чтение книги - только в ходе сотрудника, как у остальных инструментов шаблона.
    if (input.workbookId !== undefined) assertEmployeeChatTurn(context);
    const cost = computeSiteCost(input.supplierPrice, input.priceIncludesVat);
    const formula = input.priceIncludesVat
      ? `${input.supplierPrice} x 1,7 = ${cost}`
      : `${input.supplierPrice} x 1,7 x 1,22 = ${cost}`;
    let labels: readonly TemplateCellValue[] | null = input.rangeLabels ?? null;
    if (labels === null && input.workbookId !== undefined) {
      const loaded = await loadWorkbook(deps, input.workbookId);
      const structure = await requireWorkbook(deps).inspect({
        bytes: loaded.bytes,
        headerRow: loaded.record.headerRow,
      });
      labels = findHeader(structure.headers, 'price_range')?.allowedValues ?? null;
    }
    if (labels === null || labels.length === 0) return { cost, formula, rangeStatus: 'no_list' };
    const choice = pickPriceRange(cost, labels);
    if (choice.status === 'ok') {
      return { cost, formula, rangeStatus: 'ok', rangeValue: choice.value };
    }
    return { cost, formula, rangeStatus: choice.status, rangeLabels: choice.labels };
  },
});
