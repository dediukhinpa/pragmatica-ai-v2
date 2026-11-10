import { z } from 'zod';
import type { ParsedDocument } from '@business-ai/core';
import { DomainError } from '@business-ai/core';
import { defineTool, type ToolContext } from '@business-ai/core';
import { failureName, recordWorkOwner, stableHash } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import type { PricesDeps } from './deps';
import {
  MAX_SKIPPED_LISTED,
  openPriceTable,
  priceTableInputShape,
  rejectedSchema,
  skippedSchema,
  type PriceTableInput,
} from './normalize-price-table';
import { runSavedScript, type SavedScriptOutcome } from './script-import';
import { recordSource, stagingImportId } from './staging-source';
import { appendSourceCells, discardSourceCells } from './source-cells';

export { stagingImportId } from './staging-source';
import { sourceSizeOf, type PriceSource } from './price-sources';
import {
  loadImportMeta,
  loadMail,
  parseMailPath,
  saveImportMeta,
  saveMail,
  type ImportMeta,
} from './price-state';
import { hiddenTableWarnings } from './sheet-tables';
import {
  countDataRows,
  currencyMismatchWarning,
  parseTableRows,
  resolveTableCurrency,
  tierWarnings,
} from './table-rows';

/** Максимум строк таблицы, которые разбираются и кладутся в staging за один вызов. */
export const STAGE_CHUNK_ROWS = 10_000;
/** Сколько отклонённых строк показываем агенту (остальные только числом). */
export const MAX_REJECTED_LISTED = 50;

interface StageInput extends PriceTableInput {
  fromRow?: number | undefined;
  toRow?: number | undefined;
  reset: boolean;
}
interface StageOutput {
  supplierId: string;
  fileHash: string;
  importId: string;
  /** Позиций добавлено этим вызовом. */
  staged: number;
  /** Позиций в импорте всего. */
  totalStaged: number;
  /** Строк данных в таблице исходника. */
  tableDataRows: number;
  /** С какой строки продолжать; null, если таблица обработана до конца. */
  nextRow: number | null;
  rejectedCount: number;
  rejected: Array<z.infer<typeof rejectedSchema>>;
  /** Строк «не позиция» в этом куске (группы, «по запросу», итоги, шапка): не блокируют. */
  skippedCount: number;
  skippedRows: Array<z.infer<typeof skippedSchema>>;
  /** Парсер обрезал файл по лимитам: такой импорт зафиксировать нельзя. */
  truncated: boolean;
  /**
   * Предупреждения этого куска (этап 177): валюта заголовка вместо аргумента, файл прочитан не
   * целиком, нераспознанные строки. Фиксацию они не блокируют для предложения (не диск).
   */
  warnings?: string[] | undefined;
  /** Файл разобран сохранённым скриптом поставщика (без столбцов): остальные вызовы не нужны. */
  viaSavedScript?: boolean | undefined;
  /** Сохранённый скрипт не подошёл (ошибка или не прошёл сверку): разбор обычным путём. */
  savedScriptFailed?: boolean | undefined;
}

/**
 * Разобрать кусок таблицы большого прайса и сложить позиции в staging. Позиции в модель
 * не возвращаются: их разбирает и хранит код, фиксирует `commitPriceImport`.
 */
export const stagePriceRows = defineTool<StageInput, StageOutput, PricesDeps>({
  name: 'stagePriceRows',
  scriptFallbackOnError: true,
  description:
    'Разобрать кусок таблицы большого прайса и добавить позиции в staging (позиции не ' +
    `возвращаются). Столбцы как в normalizePriceTable (в том числе variantColumns, group, ` +
    `groupHeaderRows: одинаковые во всех кусках). Укажите поставщика, таблицу, число строк заголовка, столбцы, диапазон ` +
    `строк fromRow..toRow (не больше ${STAGE_CHUNK_ROWS} за вызов; без них - с начала). ` +
    'Повторите с fromRow=nextRow, пока nextRow не станет null; для каждой таблицы-листа ' +
    'отдельно. reset=true только в самом первом вызове: удаляет ранее добавленное. ' +
    'Валюта берётся из заголовка столбца цены; defaultCurrency нужен, только если её там ' +
    'нет. Строки «не позиция» (группы, «по запросу», итоги, шапка) возвращаются в ' +
    'skippedRows и запись не блокируют. truncated=true - файл прочитан не целиком: ' +
    'укажите это в предупреждениях (для файла с диска фиксация будет заблокирована). ' +
    'Затем commitPriceImport.',
  // Шаг записи, а не чтения: отказ по пределу результатов хода оставлял файл без итога.
  budgetExempt: true,
  inputSchema: z.object({
    ...priceTableInputShape,
    fromRow: z.number().int().nonnegative().optional(),
    toRow: z.number().int().positive().optional(),
    reset: z.boolean().default(false),
  }),
  outputSchema: z.object({
    supplierId: z.string(),
    fileHash: z.string(),
    importId: z.string(),
    staged: z.number().int(),
    totalStaged: z.number().int(),
    tableDataRows: z.number().int(),
    nextRow: z.number().int().nullable(),
    rejectedCount: z.number().int(),
    rejected: z.array(rejectedSchema),
    skippedCount: z.number().int(),
    skippedRows: z.array(skippedSchema),
    truncated: z.boolean(),
    warnings: z.array(z.string()).optional(),
    viaSavedScript: z.boolean().optional(),
    savedScriptFailed: z.boolean().optional(),
  }),
  async execute(input, deps, context) {
    const { source, parsed, table } = await openPriceTable(deps, input, context);
    // Сохранённый скрипт поставщика идёт первым и без модели; не подошёл - обычный разбор.
    const auto = await autoScriptStep(deps, input, { source, parsed }, context);
    if (auto.output !== null) return auto.output;
    const fromRow = Math.max(input.fromRow ?? input.headerRows, input.headerRows);
    const toRow = Math.min(input.toRow ?? Infinity, fromRow + STAGE_CHUNK_ROWS, table.length);
    if (fromRow >= table.length) {
      throw new DomainError(
        'invalid_input',
        `Строка ${fromRow} вне таблицы (в таблице ${table.length} строк).`,
      );
    }
    // Валюта из заголовка столбца цены; расхождение с defaultCurrency - не отказ: берётся
    // валюта заголовка (она в файле), аргумент игнорируется с предупреждением (этап 177).
    const currency = resolveTableCurrency(
      table,
      input.headerRows,
      input.columns,
      input.defaultCurrency,
    );
    const currencyCode = currency.kind === 'ok' ? currency.currency : currency.header;
    const warnings: string[] = [];
    if (currency.kind === 'mismatch') {
      warnings.push(currencyMismatchWarning(currency.header, currency.explicit));
    }
    warnings.push(...tierWarnings(input.columns));
    warnings.push(...hiddenTableWarnings(parsed, input.tableIndex));
    if (parsed.truncated) {
      warnings.push('Файл прочитан не целиком (лимиты разбора): часть позиций не попала.');
    }
    const importId = stagingImportId(input.supplierId, source.hash);
    if (input.reset) {
      await deps.staging.discard(importId);
      await discardSourceCells(deps, importId);
    }
    const rows = parseTableRows(
      table,
      {
        supplierId: input.supplierId,
        headerRows: input.headerRows,
        columns: input.columns,
        defaultCurrency: currencyCode,
        date: deps.clock.now().toISOString(),
      },
      fromRow,
      toRow,
    );
    if (rows.rejected.length > 0) {
      warnings.push(
        `Строк, которые не удалось разобрать: ${rows.rejected.length} (пропущены, значения не ` +
          'подставлены).',
      );
    }
    // Ключ куска включает разбор: тот же диапазон с другими столбцами это другой кусок,
    // и его дубли поймает проверка при фиксации.
    const key = stableHash({
      table: input.tableIndex,
      fromRow,
      toRow,
      headerRows: input.headerRows,
      columns: input.columns,
      defaultCurrency: currencyCode,
    });
    const tableDataRows = countDataRows(table, input.headerRows, input.columns);
    const totalStaged = await deps.staging.append(
      importId,
      { supplierId: input.supplierId, fileHash: source.hash },
      {
        key,
        table: String(input.tableIndex),
        tableRows: tableDataRows,
        items: rows.items,
        skippedRows: rows.skipped.length,
        // Признак усечения парсером хранится в staging: фиксация его проверяет (R4-AGT-2).
        truncated: parsed.truncated,
      },
      deps.clock.now(),
    );
    await recordSource(deps, importId, source.path, source.meta);
    // Координаты цен нужны правке цен в исходном файле; их сбой не должен ронять разбор прайса:
    // без записи правка на месте просто недоступна (как для старых импортов).
    await appendSourceCells(
      deps,
      importId,
      {
        path: source.path,
        fileName: source.name,
        table: input.tableIndex,
        sheet: parsed.tableNames?.[input.tableIndex],
      },
      rows.cells,
    ).catch((error: unknown) => {
      deps.log?.('price_source_cells_failed', { error: failureName(error) });
    });
    // Импорт начал сотрудник в чате: итог и файл изменений вернутся к нему (первый владелец).
    await recordWorkOwner(deps.state, workSubject.import(source.hash), context, deps.log);
    return {
      supplierId: input.supplierId,
      fileHash: source.hash,
      importId,
      staged: rows.items.length,
      totalStaged,
      tableDataRows,
      nextRow: toRow < table.length ? toRow : null,
      rejectedCount: rows.rejected.length,
      rejected: rows.rejected.slice(0, MAX_REJECTED_LISTED),
      skippedCount: rows.skipped.length,
      skippedRows: rows.skipped.slice(0, MAX_SKIPPED_LISTED),
      truncated: parsed.truncated,
      warnings,
      ...(auto.failed ? { savedScriptFailed: true } : {}),
    };
  },
});

/** Итог шага «сохранённый скрипт»: готовый ответ либо продолжение обычным путём. */
interface AutoScriptStep {
  output: StageOutput | null;
  failed: boolean;
}

/**
 * Шаг «СНАЧАЛА сохранённый скрипт» (этап 111, тема 3). Работает при первом вызове по файлу
 * (`reset` или staging ещё нет); в файле, уже разобранном скриптом, остальные вызовы - пустые.
 */
async function autoScriptStep(
  deps: PricesDeps,
  input: StageInput,
  opened: { source: PriceSource; parsed: ParsedDocument },
  context: ToolContext,
): Promise<AutoScriptStep> {
  const { source, parsed } = opened;
  const importId = stagingImportId(input.supplierId, source.hash);
  const base = { supplierId: input.supplierId, fileHash: source.hash, importId };
  const doneByScript = (total: number): StageOutput => ({
    ...base,
    staged: 0,
    totalStaged: total,
    tableDataRows: total,
    nextRow: null,
    rejectedCount: 0,
    rejected: [],
    skippedCount: 0,
    skippedRows: [],
    truncated: parsed.truncated,
    viaSavedScript: true,
  });
  if (!input.reset && (await loadImportMeta(deps, importId))?.viaScript === true) {
    const staged = await deps.staging.load(importId);
    // Метаданные без staging (его сбросили): «готово» с нулём строк было бы ложью - обычный путь.
    if (staged !== null) return { output: doneByScript(staged.items.length), failed: false };
  }
  if (!input.reset && (await deps.staging.exists(importId))) return { output: null, failed: false };
  let outcome: SavedScriptOutcome;
  try {
    outcome = await runSavedScript(
      deps,
      input.supplierId,
      {
        name: source.name,
        read: () => source.read(),
        size: sourceSizeOf(source),
        parse: async () => parsed,
        price: source,
      },
      context,
    );
  } catch {
    // Сбой песочницы не должен останавливать разбор: дальше обычный путь.
    outcome = { status: 'failed', code: 'unavailable' };
  }
  if (outcome.status === 'applied') {
    return { output: { ...doneByScript(outcome.staged), staged: outcome.staged }, failed: false };
  }
  return { output: null, failed: outcome.status === 'failed' };
}

