import { z } from 'zod';
import { supplierSchema, type Supplier } from '../domain/models';
import type { SupplierRepository } from '../ports/repositories.owned';
import { defineTool } from '@business-ai/core';

/** Лимит выдачи по умолчанию. */
const SEARCH_SUPPLIERS_DEFAULT_LIMIT = 10;
/** Максимальный лимит выдачи. */
const SEARCH_SUPPLIERS_MAX_LIMIT = 50;

interface SearchSuppliersInput {
  query: string;
  limit: number;
}
interface SearchSuppliersOutput {
  suppliers: Supplier[];
}
/** Зависимости инструмента. */
export interface SearchSuppliersDeps {
  suppliers: SupplierRepository;
}

/** Образец инструмента: поиск поставщиков по названию. */
export const searchSuppliers = defineTool<
  SearchSuppliersInput,
  SearchSuppliersOutput,
  SearchSuppliersDeps
>({
  name: 'searchSuppliers',
  description: 'Найти поставщиков по части названия.',
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z
      .number()
      .int()
      .positive()
      .max(SEARCH_SUPPLIERS_MAX_LIMIT)
      .default(SEARCH_SUPPLIERS_DEFAULT_LIMIT),
  }),
  outputSchema: z.object({ suppliers: z.array(supplierSchema) }),
  async execute(input, deps) {
    return { suppliers: await deps.suppliers.search(input.query, input.limit) };
  },
});
