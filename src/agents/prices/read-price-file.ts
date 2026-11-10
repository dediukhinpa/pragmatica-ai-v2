import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { extensionOf, tablesPageToMarkdown } from '@business-ai/core';
import { SCAN_EXTENSIONS, type PricesDeps } from './deps';
import { parseSource } from './parse-cache';
import { openPriceSource, type PriceSource } from './price-sources';

/** Максимум символов markdown на одной странице ответа: больше модель не прочтёт целиком. */
export const MAX_MARKDOWN_CHARS = 60_000;

/** Префикс курсора текстового документа без таблиц: `text:<смещение>`. */
const TEXT_CURSOR = 'text';
const TABLE_CURSOR = /^(\d+):(\d+)$/;
const TEXT_CURSOR_PATTERN = new RegExp(`^${TEXT_CURSOR}:(\\d+)$`);

export interface ReadPriceFileInput {
  path: string;
  cursor?: string | undefined;
}
export interface ReadPriceFileOutput {
  path: string;
  hash: string;
  markdown: string;
  tableCount: number;
  /** Строк в каждой таблице (листе), включая заголовок: по ним планируются куски. */
  tableRows: number[];
  /** Название листа каждой таблицы (xlsx/xls, видимые листы); пусто, если неизвестно. */
  tableNames: string[];
  /** Курсор следующей страницы; null, если файл прочитан до конца. */
  nextCursor: string | null;
  /** Нужен OCR (скан): файл не обрабатывается, менеджеру уходит сообщение. */
  needsOcr: boolean;
  /**
   * Есть скрытые листы, строки или столбцы. Таблицы скрытых листов (hiddenSheets) читаются и
   * помечены в tableNames «(скрытый лист)», в warnings о них предупреждение; скрытые строки и
   * столбцы остаются в разборе.
   */
  hidden: boolean;
  /** Названия скрытых листов. */
  hiddenSheets: string[];
  /** Парсер сам обрезал файл (свои лимиты): прайс прочитан не целиком, сохранять его нельзя. */
  truncated: boolean;
  /** Предупреждения парсера. */
  warnings: string[];
}

export const readPriceFileOutputSchema = z.object({
  path: z.string(),
  hash: z.string(),
  markdown: z.string(),
  tableCount: z.number().int(),
  tableRows: z.array(z.number().int()),
  tableNames: z.array(z.string()),
  nextCursor: z.string().nullable(),
  needsOcr: z.boolean(),
  hidden: z.boolean(),
  hiddenSheets: z.array(z.string()),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});

function badCursor(): DomainError {
  return new DomainError(
    'invalid_input',
    'Курсор не распознан: берите nextCursor из предыдущего ответа без изменений.',
  );
}

/** Страница текста без таблиц с заданного смещения. */
function textPage(
  text: string,
  cursor: string | undefined,
): { markdown: string; next: string | null } {
  const offset = cursor === undefined ? 0 : Number(TEXT_CURSOR_PATTERN.exec(cursor)?.[1] ?? NaN);
  if (!Number.isInteger(offset) || offset > text.length) throw badCursor();
  const end = offset + MAX_MARKDOWN_CHARS;
  return {
    markdown: text.slice(offset, end),
    next: end < text.length ? `${TEXT_CURSOR}:${end}` : null,
  };
}

/** Страница разобранного файла из любого источника (диск, чат, письмо). */
export async function readPricePage(
  deps: PricesDeps,
  source: PriceSource,
  cursor: string | undefined,
): Promise<ReadPriceFileOutput> {
  const base = { path: source.path, hash: source.hash };
  // Фото и картинки парсеру не отдаём: у них нет текстового слоя по определению.
  if (
    deps.parser.readsImages !== true &&
    SCAN_EXTENSIONS.includes(extensionOf(source.name))
  ) {
    return {
      ...base,
      markdown: '',
      tableCount: 0,
      tableRows: [],
      tableNames: [],
      nextCursor: null,
      needsOcr: true,
      hidden: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  }
  const parsed = await parseSource(deps.parser, source, deps.turnScope);
  const hasRows = parsed.tables.some((table) => table.length > 0);
  const flags = {
    tableCount: parsed.tables.length,
    tableRows: parsed.tables.map((table) => table.length),
    tableNames: parsed.tableNames ?? [],
    // Скан определяет парсер (нет текстового слоя), а не длина текста.
    needsOcr: parsed.needsOcr,
    hidden: parsed.hasHiddenContent,
    hiddenSheets: parsed.hiddenSheets,
    truncated: parsed.truncated,
    warnings: parsed.warnings,
  };
  // Если есть таблицы, текст не дублируем: парсер кладёт в text то же содержимое.
  if (!hasRows) {
    const page = textPage(parsed.text.trim(), cursor);
    return { ...base, ...flags, markdown: page.markdown, nextCursor: page.next };
  }
  const match = cursor === undefined ? null : TABLE_CURSOR.exec(cursor);
  if (cursor !== undefined && match === null) throw badCursor();
  const from = { table: Number(match?.[1] ?? 0), row: Number(match?.[2] ?? 0) };
  if (from.table >= parsed.tables.length) throw badCursor();
  const page = tablesPageToMarkdown(parsed.tables, from, MAX_MARKDOWN_CHARS, parsed.tableNames);
  return {
    ...base,
    ...flags,
    markdown: page.markdown,
    nextCursor: page.next === null ? null : `${page.next.table}:${page.next.row}`,
  };
}

/**
 * Прочитать прайс постранично: агент получает разобранный текст и таблицы, исходник ему
 * недоступен. Большой файл читается по курсору (`nextCursor`), листы — это таблицы.
 */
export const readPriceFile = defineTool<ReadPriceFileInput, ReadPriceFileOutput, PricesDeps>({
  name: 'readPriceFile',
  readsFile: true,
  scriptFallbackOnError: true,
  description:
    'Прочитать файл прайса постранично: таблицы в markdown (строки и столбцы с нуля, номера ' +
    'строк сквозные), tableRows (строк в каждой таблице-листе), nextCursor (передайте его ' +
    'в cursor, чтобы читать дальше; null = файл кончился), флаги needsOcr, truncated и ' +
    'hidden (скрытые листы читаются: в tableNames помечены «(скрытый лист)», в warnings ' +
    'предупреждение), tableNames (название листа каждой таблицы), предупреждения парсера. ' +
    'Для скана текста нет, ' +
    'needsOcr=true.',
  inputSchema: z.object({ path: z.string().min(1), cursor: z.string().min(1).optional() }),
  outputSchema: readPriceFileOutputSchema,
  async execute(input, deps, context) {
    const source = await openPriceSource(deps, input.path, context);
    return readPricePage(deps, source, input.cursor);
  },
});
