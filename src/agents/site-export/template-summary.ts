import { z } from 'zod';
import type { TemplateStructure } from '@business-ai/core';

/** Краткая сводка книги для ответа инструмента: без байтов и без длинных списков. */
export const workbookSummarySchema = z.object({
  sheets: z.array(z.string()),
  headerRow: z.number().int(),
  /** Сколько колонок в шапке и сколько из них жёлтые (их заполняем по умолчанию). */
  columns: z.number().int(),
  yellowColumns: z.array(z.string()),
  firstFreeRow: z.number().int(),
  nextRowAfterData: z.number().int(),
  /** Шапка не найдена: строка заголовков пуста, это, скорее всего, не шаблон сайта. */
  headersMissing: z.boolean(),
});
export type WorkbookSummary = z.infer<typeof workbookSummarySchema>;

/** Сводка по результату чтения структуры. */
export function summarizeStructure(structure: TemplateStructure): WorkbookSummary {
  return {
    sheets: structure.sheets,
    headerRow: structure.headerRow,
    columns: structure.headers.length,
    yellowColumns: structure.headers
      .filter((header) => header.yellow)
      .map((header) => `${header.letter}: ${header.text}`),
    firstFreeRow: structure.firstFreeRow,
    nextRowAfterData: structure.nextRowAfterData,
    headersMissing: structure.headers.length === 0,
  };
}
