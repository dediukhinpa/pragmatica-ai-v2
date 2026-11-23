import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { loadComparison } from './quote-summary';

const flagSchema = z.object({
  code: z.string(),
  supplierId: z.string().optional(),
  productName: z.string().optional(),
});
const cellSchema = z.object({
  supplierId: z.string(),
  state: z.enum(['priced', 'no_price', 'not_covered']),
  /** Цена в другой единице, чем в заявке: в минимумах и итоге не участвует. */
  unitDiffers: z.boolean().optional(),
  packIssue: z.enum(['pack_size', 'min_order']).optional(),
  unitPrice: z.number().optional(),
  lineTotal: z.number().optional(),
  deliveryDays: z.number().optional(),
});

const outputSchema = z.object({
  requestId: z.string(),
  /** Отпечаток набора КП: его передают в sendQuoteSummary. */
  quotesHash: z.string(),
  baseCurrency: z.string(),
  rows: z.array(
    z.object({
      itemName: z.string(),
      cells: z.array(cellSchema),
      minUnitPrice: z.number().optional(),
      minSupplierIds: z.array(z.string()),
      maxUnitPrice: z.number().optional(),
      maxSupplierIds: z.array(z.string()),
      /** Условия цены, фасовка или партия различаются: минимум и максимум не названы. */
      incomparable: z.boolean().optional(),
    }),
  ),
  suppliers: z.array(
    z.object({
      supplierId: z.string(),
      replied: z.boolean(),
      currency: z.string().optional(),
      orderTotal: z.number().optional(),
      pricedItems: z.number().int(),
      totalItems: z.number().int(),
      unitMismatchItems: z.number().int(),
      deliveryDays: z.number().optional(),
      paymentTerms: z.string().optional(),
      validUntil: z.string().optional(),
      expired: z.boolean(),
      comparable: z.boolean(),
      incomparableReasons: z.array(z.enum(['vat_mixed', 'pack_size', 'min_order'])),
    }),
  ),
  notRepliedSupplierIds: z.array(z.string()),
  /**
   * Из «не ответивших» те, кто ответил в каком-то канале (почта, телефон, мессенджер), но КП по
   * ним ещё не записано: про них нельзя говорить «не ответил».
   */
  answeredWithoutQuoteIds: z.array(z.string()),
  flags: z.array(flagSchema),
});

/**
 * Сравнить сохранённые КП по заявке (без LLM, считает код). Названия поставщиков модели не
 * отдаются: только их id; тексты предупреждений с названиями строит sendQuoteSummary.
 */
export const compareQuotesTool = defineTool<
  { requestId: string },
  z.infer<typeof outputSchema>,
  OrderCalcDeps
>({
  name: 'compareQuotes',
  description:
    'Сравнить КП поставщиков по заявке: таблица «позиция × поставщик» (цена за единицу, ' +
    'сумма, срок), минимум и максимум по позиции, итог по заказу у каждого, предупреждения ' +
    '(нет цены, цена в другой единице, КП просрочено, другая валюта, ответил не по всем ' +
    'позициям, не ответил, условия цены различаются, фасовка и партия не подходят под ' +
    'количество: тогда минимум не назван, incomparable=true). Цены в другой единице в ' +
    'минимумы и итог не входят. ' +
    'Валюты не пересчитываются. Победителя функция не выбирает: решает менеджер. ' +
    'Возвращает quotesHash для sendQuoteSummary.',
  inputSchema: z.object({ requestId: z.string().min(1) }),
  outputSchema,
  async execute(input, deps) {
    const { comparison, quotesHash, answeredWithoutQuote } = await loadComparison(
      deps,
      input.requestId,
    );
    return {
      requestId: comparison.requestId,
      quotesHash,
      baseCurrency: comparison.baseCurrency,
      rows: comparison.rows.map((row) => ({
        itemName: row.itemName,
        cells: row.cells.map((cell) => ({
          supplierId: cell.supplierId,
          state: cell.state,
          ...(cell.unitDiffers === true ? { unitDiffers: true } : {}),
          ...(cell.packIssue === undefined ? {} : { packIssue: cell.packIssue }),
          ...(cell.unitPrice === undefined ? {} : { unitPrice: cell.unitPrice }),
          ...(cell.lineTotal === undefined ? {} : { lineTotal: cell.lineTotal }),
          ...(cell.deliveryDays === undefined ? {} : { deliveryDays: cell.deliveryDays }),
        })),
        ...(row.minUnitPrice === undefined ? {} : { minUnitPrice: row.minUnitPrice }),
        minSupplierIds: row.minSupplierIds,
        ...(row.maxUnitPrice === undefined ? {} : { maxUnitPrice: row.maxUnitPrice }),
        maxSupplierIds: row.maxSupplierIds,
        ...(row.incomparable === true ? { incomparable: true } : {}),
      })),
      suppliers: comparison.suppliers.map((s) => ({
        supplierId: s.supplierId,
        replied: s.replied,
        ...(s.currency === undefined ? {} : { currency: s.currency }),
        ...(s.orderTotal === undefined ? {} : { orderTotal: s.orderTotal }),
        pricedItems: s.pricedItems,
        totalItems: s.totalItems,
        unitMismatchItems: s.unitMismatchItems,
        ...(s.deliveryDays === undefined ? {} : { deliveryDays: s.deliveryDays }),
        ...(s.paymentTerms === undefined ? {} : { paymentTerms: s.paymentTerms }),
        ...(s.validUntil === undefined ? {} : { validUntil: s.validUntil }),
        expired: s.expired,
        comparable: s.comparable,
        incomparableReasons: s.incomparableReasons,
      })),
      notRepliedSupplierIds: comparison.notRepliedSupplierIds,
      answeredWithoutQuoteIds: answeredWithoutQuote.map((item) => item.supplierId),
      flags: comparison.flags.map(({ code, supplierId, productName }) => ({
        code,
        ...(supplierId === undefined ? {} : { supplierId }),
        ...(productName === undefined ? {} : { productName }),
      })),
    };
  },
});
