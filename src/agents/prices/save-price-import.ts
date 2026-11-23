import { z } from 'zod';
import { countPriceForms, type PriceItem } from '../../kit/domain/models';
import { type ValidationIssue } from '@business-ai/core';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool, type ToolContext } from '@business-ai/core';
import { mailboxThreadScope } from '@business-ai/core';
import type { PricesDeps } from './deps';
import {
  blockingIssues,
  checkImport,
  limitIssues,
  writeImport,
  type ImportCandidate,
  type ImportWriteResult,
} from './import-checks';
import {
  parsePriceTable,
  priceTableInputShape,
  type PriceTableInput,
} from './normalize-price-table';
import { priceListHash } from './employee-updates';
import { recordDiskSyncOutcome } from './disk-sync-outcome';
import { isIntakePath } from '@business-ai/core';
import { loadMail, parseMailPath, type MailAccess, type PriceSourceKind } from './price-state';
import { stagingImportId } from './staging-source';
import { currencyMismatchWarning, tierWarnings } from './table-rows';

/** Сколько нераспознанных строк называем в предупреждении; остальное - числом. */
const REJECTED_IN_WARNING = 5;

interface SavePriceImportInput extends PriceTableInput {
  /** Отпечаток файла, который читал агент: если файл с тех пор сменился, запись не идёт. */
  fileHash: string;
}

const inputSchema = z.object({ ...priceTableInputShape, fileHash: z.string().min(1) });

/** Результат записи прайса: общий для `savePriceImport` и `commitPriceImport`. */
export const priceImportOutputSchema = z.object({
  supplierId: z.string(),
  saved: z.number().int(),
  /** Новые и изменившие цену позиции. */
  changed: z.number().int(),
  /**
   * written - записано в базу (только файл с диска); proposed_not_written - источник не диск:
   * цены сохранены как неподтверждённое предложение для внесения сотрудником на диск.
   */
  status: z.enum(['written', 'proposed_not_written']).optional(),
  /** Позиций в неподтверждённом предложении. */
  proposed: z.number().int().optional(),
  /**
   * Предупреждения (этап 177): сомнительное в данных, что не помешало результату (дубли,
   * число строк, нераспознанные строки, дата, валюта). Покажите сотруднику одним списком.
   */
  warnings: z.array(z.string()).optional(),
});
export type PriceImportOutput = z.infer<typeof priceImportOutputSchema>;

/** Итог первичного импорта: записанный из файла прайс (нет записи о файле - ничего не делает). */
export async function recordWritten(
  deps: PricesDeps,
  threadId: string,
  status: ImportWriteResult['status'],
  items: readonly PriceItem[],
  target: { supplierId: string; path?: string | undefined },
): Promise<void> {
  if (status !== 'written') return;
  const forms = countPriceForms(items);
  await recordDiskSyncOutcome(deps, threadId, {
    status: 'written',
    supplierId: target.supplierId,
    ...(target.path === undefined ? {} : { path: target.path }),
    rows: items.length,
    fromRows: forms.from,
    rangeRows: forms.range,
    cellTierRows: forms.cellTier,
  });
}

/** Ответ модели: при предложении saved=0, в базу ничего не записано. */
export function importOutput(
  supplierId: string,
  total: number,
  result: ImportWriteResult,
  extraWarnings: readonly string[] = [],
): PriceImportOutput {
  const all = [...extraWarnings, ...result.warnings];
  const warnings = all.length === 0 ? {} : { warnings: all };
  if (result.status === 'written') {
    return { supplierId, saved: total, changed: result.changed, ...warnings };
  }
  return {
    ...warnings,
    supplierId,
    saved: 0,
    changed: result.changed,
    status: result.status,
    proposed: result.proposed,
  };
}

/** Ключ импорта: один и тот же файл (по хэшу) для одного поставщика сохраняется один раз. */
export function priceImportKey(input: { supplierId: string; fileHash: string }): string {
  return `price-import:${input.supplierId}:${input.fileHash}`;
}

/** Состояние-предшественник импорта: прайс поставщика в базе до записи. */
export async function priceBaseOf(
  input: { supplierId: string },
  deps: PricesDeps,
): Promise<string> {
  return priceListHash(await deps.prices.listBySupplier(input.supplierId));
}

/** Набор для записи, собранный кодом из файла, и замечания к самому файлу. */
interface FileCandidate {
  candidate: ImportCandidate;
  fileIssues: ValidationIssue[];
  /** Разобранная таблица (для предупреждения о валюте). */
  table: Awaited<ReturnType<typeof parsePriceTable>>;
}

/**
 * Перечитать файл и собрать набор для записи. Модель передаёт только указатель (путь,
 * таблица, колонки) и отпечаток файла, который она читала: позиции, число строк и поставщика
 * в позициях задаёт код. Выдуманный или устаревший отпечаток - замечание, а не новый импорт.
 */
async function fileCandidate(
  deps: PricesDeps,
  input: SavePriceImportInput,
  access: MailAccess,
): Promise<FileCandidate> {
  const table = await parsePriceTable(deps, input, access);
  const fileIssues: ValidationIssue[] = [];
  if (table.source.hash !== input.fileHash) {
    fileIssues.push({
      code: 'file_hash_mismatch',
      message: 'fileHash не совпадает с файлом по этому path: прочитайте файл заново.',
    });
  }
  if (table.rejected.length > 0) {
    // Нераспознанные строки пропущены, значения не подставляются; номера и причины - сотруднику.
    const listed = table.rejected
      .slice(0, REJECTED_IN_WARNING)
      .map((row) => `строка ${row.row}: ${row.reason}`)
      .join('; ');
    fileIssues.push({
      code: 'rows_rejected',
      message:
        `Строк, которые не удалось разобрать и они пропущены: ${table.rejected.length} ` +
        `(${listed}).`,
    });
  }
  // Малый прайс из письма: отправителя проверяет код по записи письма, а не модель (R6-02-03).
  const mail = parseMailPath(input.path);
  const record = mail === null ? null : await loadMail(deps, mail.messageId, access);
  const senderUnverified = record === null ? undefined : record.senderVerified !== true;
  const source: PriceSourceKind =
    record !== null ? 'mail' : isIntakePath(input.path) ? 'intake' : 'disk';
  return {
    candidate: {
      supplierId: input.supplierId,
      // Импорт привязан к настоящему отпечатку файла, а не к присланному моделью.
      importId: stagingImportId(input.supplierId, table.source.hash),
      sourceRowCount: table.sourceRowCount,
      items: table.items,
      // Признак усечения проверяет checkImport одинаково для файла и staging (R4-AGT-2).
      truncated: table.truncated,
      ...(senderUnverified === undefined ? {} : { senderUnverified }),
      source,
      // Путь файла на диске (не ссылка из чата): замена идёт в пределах файла.
      ...(source === 'disk' ? { sourceFile: table.source.path } : {}),
      ...(record === null ? {} : { sourceDate: record.receivedAt }),
    },
    fileIssues,
    table,
  };
}

/**
 * Валидатор перед сохранением: файл тот же, что читал агент, число строк, дубли; скачки цены
 * относительно базы не блокируют (уходят в файл изменений). Позиции берутся из файла.
 */
export const priceImportValidator: AgentValidator<PricesDeps> = schemaValidator({
  name: 'price-import',
  tool: 'savePriceImport',
  schema: inputSchema,
  async check(input, deps, context) {
    const { candidate, fileIssues } = await fileCandidate(deps, input, context);
    const issues = [...fileIssues, ...(await checkImport(deps, candidate)).issues];
    // Для предложения (не диск) остаются только жёсткие замечания, остальное - предупреждения.
    return limitIssues(await blockingIssues(deps, candidate, issues));
  },
});

/** Заменить прайс поставщика позициями из файла (необратимо). */
export const savePriceImport = defineTool<SavePriceImportInput, PriceImportOutput, PricesDeps>({
  name: 'savePriceImport',
  scriptFallbackOnError: true,
  description:
    'Сохранить небольшой прайс поставщика. В базу пишется только файл с сетевого диска; файл ' +
    'из чата или письма возвращает status=proposed_not_written (saved=0): цены сохранены как ' +
    'неподтверждённое предложение, отправьте сотруднику файл изменений для внесения на диск. ' +
    'Передайте path, supplierId, fileHash (из ' +
    'readPriceFile или normalizePriceTable), tableIndex, headerRows и columns, как в ' +
    'normalizePriceTable. Позиции не передаются: код сам перечитывает файл по path и сверяет ' +
    'fileHash. Перед записью проверяются число строк и дубли. Для файла с ' +
    'диска при замечаниях запись не выполняется (blocked); для файла из чата или письма ' +
    'замечания не блокируют, а приходят в warnings (покажите их сотруднику одним списком). ' +
    'Заменяет прайс поставщика целиком.',
  sideEffect: true,
  inputSchema,
  outputSchema: priceImportOutputSchema,
  idempotencyKey: priceImportKey,
  // Для файла из письма в режиме ящиков в ключ входит тред: кэш не отдаётся чужому ящику.
  idempotencyPredecessor: async (input, deps, threadId) => {
    const base = await priceBaseOf(input, deps);
    const fromMail = parseMailPath(input.path) !== null;
    const scope = mailboxThreadScope(fromMail && deps.mailboxes !== undefined, threadId);
    return scope === '' ? base : `${base}.${scope}`;
  },
  async execute(input, deps, context) {
    const { candidate, fileIssues, table } = await fileCandidate(deps, input, context);
    const currencyWarnings = [
      ...(table.currencyConflict === null
        ? []
        : [
            currencyMismatchWarning(
              table.currencyConflict.header,
              table.currencyConflict.explicit,
            ),
          ]),
      ...tierWarnings(input.columns),
      ...table.sheetWarnings,
    ];
    const result = await writeImport(deps, candidate, priceImportKey(input), fileIssues);
    await recordWritten(deps, context.threadId, result.status, candidate.items, {
      supplierId: input.supplierId,
      path: candidate.sourceFile,
    });
    return importOutput(input.supplierId, candidate.items.length, result, currencyWarnings);
  },
});
