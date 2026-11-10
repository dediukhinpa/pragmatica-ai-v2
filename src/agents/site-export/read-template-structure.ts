import { z } from 'zod';
import type { TemplateCellValue, TemplateRow } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { SiteExportDeps } from './deps';
import { columnRole, lookupColumn, normalizeText, type ColumnRole } from './template-columns';
import { loadWorkbook, requireWorkbook } from './template-store';

/** Списки короче или равные этому числу значений отдаются целиком. */
export const LIST_INLINE_MAX = 40;
/** Для длинного списка без фильтра показываем начало этой длины. */
export const LIST_PREVIEW_COUNT = 15;
/** Сколько значений отдаёт поиск по подстроке одной колонки. */
export const LIST_SEARCH_MAX = 100;
/** Сколько строк с примерами и сколько ячеек в строке показываем. */
export const EXAMPLE_ROWS_MAX = 5;
export const EXAMPLE_CELLS_MAX = 40;
/** Длина текста ячейки в примерах и описании колонок. */
export const CELL_TEXT_MAX = 80;

const inputSchema = z.object({
  workbookId: z.string().min(1),
  /** Лист по имени; по умолчанию первый (рабочий лист оператора). */
  sheet: z.string().min(1).optional(),
  /**
   * Колонка (заголовок или буква), чьи допустимые значения нужны подробно. Без неё длинные
   * списки показываются сокращённо.
   */
  listColumn: z.string().min(1).optional(),
  /** Подстрока для поиска среди значений списка колонки `listColumn` (без учёта регистра). */
  listFilter: z.string().optional(),
  /** Показать строки с примерами и пояснения над шапкой. */
  includeExamples: z.boolean().default(false),
});

const columnSchema = z.object({
  letter: z.string(),
  name: z.string(),
  yellow: z.boolean(),
  /** operator, first_load, manager, last_correction, plain. */
  role: z.string(),
  hasList: z.boolean(),
  listSize: z.number().int().optional(),
  /** Значения списка: все (короткий список) или начало (длинный). */
  allowedValues: z.array(z.union([z.string(), z.number()])).optional(),
  listShownPartly: z.boolean().optional(),
  /** Формулу списка не удалось вычислить: значения неизвестны, спроси сотрудника. */
  listUnresolved: z.boolean().optional(),
});

const cellTextSchema = z.object({ ref: z.string(), text: z.string() });
const rowsSchema = z.array(z.object({ row: z.number().int(), cells: z.array(cellTextSchema) }));

const outputSchema = z.object({
  workbookId: z.string(),
  revision: z.number().int(),
  fileName: z.string(),
  sheets: z.array(z.string()),
  sheet: z.string(),
  headerRow: z.number().int(),
  columns: z.array(columnSchema),
  nameColumn: z.string().nullable(),
  skuColumn: z.string().nullable(),
  firstFreeRow: z.number().int(),
  nextRowAfterData: z.number().int(),
  /** Результат поиска по списку (если задан listColumn): значения и общий размер списка. */
  listSearch: z
    .object({
      column: z.string(),
      total: z.number().int(),
      matched: z.number().int(),
      values: z.array(z.union([z.string(), z.number()])),
    })
    .optional(),
  /** Для listColumn, которую не удалось найти или назвали неоднозначно. */
  listColumnProblem: z.string().optional(),
  aboveRows: rowsSchema.optional(),
  exampleRows: rowsSchema.optional(),
  examplesTruncated: z.boolean().optional(),
});

function clip(text: string): string {
  return text.length > CELL_TEXT_MAX ? `${text.slice(0, CELL_TEXT_MAX)}...` : text;
}

function showRows(rows: readonly TemplateRow[], limit: number): z.infer<typeof rowsSchema> {
  return rows.slice(0, limit).map((row) => ({
    row: row.row,
    cells: row.cells.slice(0, EXAMPLE_CELLS_MAX).map((cell) => ({
      ref: cell.ref,
      text: clip(String(cell.date ?? cell.value ?? (cell.formula ? '(формула)' : ''))),
    })),
  }));
}

/**
 * Структура рабочей книги: листы, колонки шапки со статусом «жёлтая», допустимые значения
 * списков, первая свободная строка и примеры.
 */
export const readTemplateStructure = defineTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'readTemplateStructure',
  description:
    'Прочитать структуру рабочей книги workbookId: листы, колонки шапки (строка 11) с буквой, ' +
    'признаком yellow (по заливке в файле; по умолчанию заполняются только жёлтые), ролью ' +
    '(operator - не менять никогда; first_load - не заполнять; manager и last_correction ' +
    'ставит код) и допустимыми значениями списков. Короткие списки (до 40 значений) идут ' +
    'целиком, длинные сокращённо: для полного поиска задай listColumn и listFilter ' +
    '(подстрока). firstFreeRow - первая строка, куда писать новую позицию. includeExamples ' +
    'покажет пояснения над шапкой и заполненные строки. Значения для колонок со списком ' +
    'бери только из этих списков.',
  inputSchema,
  outputSchema,
  async execute(input, deps, context) {
    assertEmployeeChatTurn(context);
    const workbook = requireWorkbook(deps);
    const loaded = await loadWorkbook(deps, input.workbookId);
    const structure = await workbook.inspect({
      bytes: loaded.bytes,
      headerRow: loaded.record.headerRow,
      sheet: input.sheet,
      signal: context.signal,
    });
    const columns = structure.headers.map((header) => {
      const values = header.allowedValues;
      const role: ColumnRole = columnRole(header);
      const base = {
        letter: header.letter,
        name: clip(header.text),
        yellow: header.yellow,
        role,
        hasList: values !== null,
      };
      if (header.listUnresolved) return { ...base, listUnresolved: true };
      if (values === null) return base;
      const inline = values.length <= LIST_INLINE_MAX;
      return {
        ...base,
        listSize: values.length,
        allowedValues: inline ? values : values.slice(0, LIST_PREVIEW_COUNT),
        ...(inline ? {} : { listShownPartly: true }),
      };
    });
    const out: z.infer<typeof outputSchema> = {
      workbookId: loaded.id,
      revision: loaded.record.revision,
      fileName: loaded.record.fileName,
      sheets: structure.sheets,
      sheet: structure.sheet,
      headerRow: structure.headerRow,
      columns,
      nameColumn: structure.nameColumn,
      skuColumn: structure.skuColumn,
      firstFreeRow: structure.firstFreeRow,
      nextRowAfterData: structure.nextRowAfterData,
    };
    if (input.listColumn !== undefined) {
      const found = lookupColumn(structure.headers, input.listColumn);
      if (found.status === 'ok') {
        const all: readonly TemplateCellValue[] = found.header.allowedValues ?? [];
        const filter = normalizeText(input.listFilter ?? '');
        const matched = all.filter((item) => filter === '' || normalizeText(item).includes(filter));
        out.listSearch = {
          column: found.header.text,
          total: all.length,
          matched: matched.length,
          values: matched.slice(0, LIST_SEARCH_MAX),
        };
      } else {
        out.listColumnProblem =
          found.status === 'ambiguous'
            ? `Название подходит к нескольким колонкам: ${found.candidates.join('; ')}.`
            : 'Такой колонки нет в шапке.';
      }
    }
    if (input.includeExamples) {
      out.aboveRows = showRows(structure.aboveRows, structure.aboveRows.length);
      out.exampleRows = showRows(structure.exampleRows, EXAMPLE_ROWS_MAX);
      out.examplesTruncated =
        structure.examplesTruncated || structure.exampleRows.length > EXAMPLE_ROWS_MAX;
    }
    return out;
  },
});
