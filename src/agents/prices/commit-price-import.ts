import { z } from 'zod';
import { DomainError, type ValidationIssue } from '@business-ai/core';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { priceListHash } from './employee-updates';
import type { PricesDeps } from './deps';
import {
  blockingIssues,
  checkImport,
  limitIssues,
  writeImport,
  type ImportCandidate,
} from './import-checks';
import { loadImportMeta } from './price-state';
import { confirmScriptVersion } from './script-import';
import {
  importOutput,
  priceBaseOf,
  priceImportKey,
  priceImportOutputSchema,
  recordWritten,
  type PriceImportOutput,
} from './save-price-import';
import { stagingImportId } from './staging-source';

const inputSchema = z.object({ supplierId: z.string().min(1), fileHash: z.string().min(1) });

interface CommitInput {
  supplierId: string;
  fileHash: string;
}

/**
 * Импорт сотрудника собран поверх прайса, каким он был при записи. Если база с тех пор
 * изменилась (другой импорт или правка), фиксация затёрла бы чужие изменения.
 */
async function staleBaseIssues(
  deps: PricesDeps,
  importId: string,
  existing: Parameters<typeof priceListHash>[0],
  baseHash?: string,
): Promise<ValidationIssue[]> {
  const meta = await loadImportMeta(deps, importId);
  if (meta?.source !== 'employee') return [];
  if (meta.baseHash === (baseHash ?? priceListHash(existing))) return [];
  return [
    {
      code: 'base_changed',
      message:
        'Прайс в базе изменился после записи этих правок: повторите recordEmployeePriceUpdates.',
    },
  ];
}

/** Накопленный импорт как набор для записи; null, если в staging его нет. */
async function stagedCandidate(
  deps: PricesDeps,
  input: CommitInput,
): Promise<ImportCandidate | null> {
  const importId = stagingImportId(input.supplierId, input.fileHash);
  const staged = await deps.staging.load(importId);
  if (staged === null) return null;
  // Файл с диска берётся из происхождения импорта (его пишет код при stagePriceRows): по нему
  // замена идёт в пределах файла, а не всего прайса поставщика.
  const meta = await loadImportMeta(deps, importId);
  const sourceFile = meta?.source === 'disk' ? meta.fileName : undefined;
  return {
    supplierId: input.supplierId,
    importId,
    ...(sourceFile === undefined ? {} : { sourceFile }),
    sourceRowCount: staged.sourceRowCount,
    items: staged.items,
    truncated: staged.truncated,
  };
}

/**
 * Валидатор фиксации: те же проверки, что у `savePriceImport` (число строк исходника, дубли,
 * скачки цены от базы и от подтверждённых цен), но над накопленным staging. Число строк
 * исходника посчитал код при добавлении кусков: пропущенный кусок даёт `row_count_mismatch`.
 */
export const stagedImportValidator: AgentValidator<PricesDeps> = schemaValidator({
  name: 'staged-price-import',
  tool: 'commitPriceImport',
  schema: inputSchema,
  async check(input, deps) {
    const candidate = await stagedCandidate(deps, input);
    if (candidate === null) {
      return [
        {
          code: 'staging_not_found',
          message: 'Нет добавленных позиций для этого файла: сначала stagePriceRows.',
        },
      ];
    }
    // Скачок сверх порога проходит только при записи решения человека на ИМЕННО этот набор:
    // запись делает обработчик кнопки в чате, аргументы модели на это не влияют.
    const verdict = await checkImport(deps, candidate);
    const stale = await staleBaseIssues(
      deps,
      candidate.importId,
      verdict.existing,
      verdict.baseHash,
    );
    // Для предложения (не диск) замечания к данным - предупреждения, блокируют только жёсткие.
    return limitIssues(await blockingIssues(deps, candidate, [...verdict.issues, ...stale]));
  },
});

/** Зафиксировать накопленный в staging прайс: атомарно заменить прайс поставщика. */
export const commitPriceImport = defineTool<CommitInput, PriceImportOutput, PricesDeps>({
  name: 'commitPriceImport',
  scriptFallbackOnError: true,
  description:
    'Зафиксировать прайс, добавленный через stagePriceRows: передайте supplierId и fileHash. ' +
    'В базу пишется только прайс с сетевого диска; из чата, письма или со слов сотрудника - ' +
    'status=proposed_not_written (saved=0): неподтверждённое предложение, сотрудник вносит его ' +
    'на диск по файлу изменений (sendPriceChangeFile). ' +
    'Перед записью рантайм проверяет число строк исходника и дубли (скачки цены не ' +
    'блокируют, они уходят в файл изменений). Для прайса с диска при замечаниях запись не ' +
    'выполняется (blocked); для чата, письма и слов сотрудника замечания не блокируют, а ' +
    'приходят в warnings (покажите их сотруднику одним списком). Заменяет прайс поставщика ' +
    'целиком.',
  sideEffect: true,
  inputSchema,
  outputSchema: priceImportOutputSchema,
  idempotencyKey: priceImportKey,
  idempotencyPredecessor: priceBaseOf,
  async execute(input, deps, context) {
    const candidate = await stagedCandidate(deps, input);
    if (candidate === null) {
      throw new DomainError('not_found', 'Нет добавленных позиций для этого файла.');
    }
    // Проверки повторяются прямо перед записью, от состояния базы на этот момент; запись
    // атомарна и идемпотентна.
    // Прайс читается и хэшируется один раз: вердикт идёт и в проверку основы, и в запись.
    const verdict = await checkImport(deps, candidate);
    const stale = await staleBaseIssues(
      deps,
      candidate.importId,
      verdict.existing,
      verdict.baseHash,
    );
    const result = await writeImport(deps, candidate, priceImportKey(input), stale, verdict);
    await deps.staging.discard(candidate.importId);
    // Зафиксировано (записано или предложено человеку): версия скрипта этого импорта подтверждена.
    await confirmScriptVersion(deps, candidate.importId);
    await recordWritten(deps, context.threadId, result.status, candidate.items, {
      supplierId: input.supplierId,
      path: candidate.sourceFile,
    });
    return importOutput(input.supplierId, candidate.items.length, result);
  },
});
