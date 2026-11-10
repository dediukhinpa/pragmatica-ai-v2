import { z } from 'zod';
import {
  REQUISITE_LABELS,
  checkSupplierRequisites,
  supplierRequisitesRecord,
} from '../../kit/domain/requisites';
import { defineTool } from '@business-ai/core';
import type { DocumentsDeps } from './deps';

interface RequisitesOutput {
  found: boolean;
  name?: string | undefined;
  /** Заполненные реквизиты как в базе: переписывай в документ ровно так. */
  requisites: Record<string, string>;
  /** Чего не хватает для договора (названия реквизитов). */
  missing: string[];
  /** Что не прошло контрольные суммы. */
  invalid: Array<{ requisite: string; reason: string }>;
  /** Реквизиты полны и корректны; false - не отказ, недостающее станет маркерами. */
  complete: boolean;
}

/** Реквизиты поставщика из базы поставщиков, с проверкой полноты и контрольных сумм. */
export const getSupplierRequisites = defineTool<
  { supplierId: string },
  RequisitesOutput,
  DocumentsDeps
>({
  name: 'getSupplierRequisites',
  description:
    'Реквизиты поставщика из базы по supplierId: ИНН, КПП, ОГРН, адрес, банк, БИК, счета, ' +
    'подписант. Проверяет полноту и контрольные суммы. complete=false: сообщи сотруднику, ' +
    'каких реквизитов не хватает (в документе они будут отмечены маркерами); не придумывай ' +
    'их. Если вернулось ' +
    'warning (карточка не проверена), передай его сотруднику: реквизиты не проверены.',
  inputSchema: z.object({ supplierId: z.string().min(1) }),
  outputSchema: z.object({
    found: z.boolean(),
    name: z.string().optional(),
    requisites: z.record(z.string()),
    missing: z.array(z.string()),
    invalid: z.array(z.object({ requisite: z.string(), reason: z.string() })),
    complete: z.boolean(),
  }),
  async execute(input, deps) {
    const supplier = await deps.suppliers.get(input.supplierId);
    if (supplier === null) {
      return { found: false, requisites: {}, missing: [], invalid: [], complete: false };
    }
    const check = checkSupplierRequisites(supplier);
    return {
      found: true,
      name: supplier.name,
      requisites: supplierRequisitesRecord(supplier),
      missing: check.missing.map((field) => REQUISITE_LABELS[field]),
      invalid: check.invalid.map((item) => ({
        requisite: REQUISITE_LABELS[item.field],
        reason: item.reason,
      })),
      complete: check.missing.length === 0 && check.invalid.length === 0,
    };
  },
});
