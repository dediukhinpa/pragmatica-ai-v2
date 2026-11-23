import { z } from 'zod';
import type { ValidationIssue } from '@business-ai/core';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { requirePort, sendExportedFile } from '@business-ai/core';
import { SUMMARY_FILE_FORMAT, type OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import { buildQuoteSheets, buildQuoteSummaryText, loadComparison } from './quote-summary';
import { loadProposal, orderRecipient } from './state';
import { fileSafeLabel, requestLabel } from './request-title';

interface SummaryInput {
  requestId: string;
  quotesHash: string;
}
interface SummaryOutput {
  delivered: boolean;
  fileName: string;
  answered: number;
  notAnswered: number;
}

const inputSchema = z.object({ requestId: z.string().min(1), quotesHash: z.string().min(1) });

/** Ключ: заявка + набор КП. Тот же набор повторно не отправляется, новое КП — новая сводка. */
function summaryKey(input: SummaryInput): string {
  return `order-quote-summary:${input.requestId}:${input.quotesHash}`;
}

/** Сводка уходит по актуальному набору КП: после нового КП нужен свежий compareQuotes. */
export const quoteSummaryValidator: AgentValidator<OrderCalcDeps> = schemaValidator({
  name: 'quote-summary',
  tool: 'sendQuoteSummary',
  schema: inputSchema,
  async check(input, deps) {
    const { comparison, quotesHash } = await loadComparison(deps, input.requestId);
    if (comparison.suppliers.every((s) => !s.replied)) {
      return [{ code: 'no_quotes', message: 'КП ещё не сохранены (recordQuote): сводить нечего.' }];
    }
    if (quotesHash !== input.quotesHash) {
      return [
        {
          code: 'quotes_changed',
          message: 'Набор КП изменился: вызовите compareQuotes и возьмите свежий quotesHash.',
        },
      ];
    }
    return [];
  },
});

/** Отправить менеджеру по закупу сводку по КП (текст) и файл-таблицу. Выбора поставщика нет. */
export const sendQuoteSummary = defineTool<SummaryInput, SummaryOutput, OrderCalcDeps>({
  name: 'sendQuoteSummary',
  description:
    'Отправить менеджеру по закупу сводку по КП: краткий текст (кто ответил, кто нет, ' +
    'минимумы, предупреждения) и файл с листами «Сравнение», «Условия», «Не ответили». ' +
    'Передай requestId и quotesHash из compareQuotes. Один набор КП отправляется один раз. ' +
    'Сводка не содержит рекомендации: поставщика выбирает менеджер.',
  sideEffect: true,
  inputSchema,
  outputSchema: z.object({
    delivered: z.boolean(),
    fileName: z.string(),
    answered: z.number().int(),
    notAnswered: z.number().int(),
  }),
  idempotencyKey: summaryKey,
  async execute(input, deps, context) {
    await assertOrderOwner(deps, input.requestId, context);
    const exporter = requirePort(deps.tableExporter, 'выгрузка таблиц');
    const { comparison, unverifiedSupplierIds, answeredWithoutQuote } = await loadComparison(
      deps,
      input.requestId,
    );
    const proposal = await loadProposal(deps, input.requestId);
    const threadId = await orderRecipient(deps, input.requestId, proposal);
    // Название заявки вместо id и в имени файла: сотрудник ищет файл по продукции.
    const label = await requestLabel(deps, input.requestId);
    const fileName = `КП_${fileSafeLabel(label)}.${SUMMARY_FILE_FORMAT}`;
    const sheets = buildQuoteSheets(comparison, answeredWithoutQuote);
    const file = await exporter.export(sheets, SUMMARY_FILE_FORMAT, fileName);
    const summary = buildQuoteSummaryText(
      comparison,
      unverifiedSupplierIds,
      answeredWithoutQuote,
      label,
    );
    await sendExportedFile(deps.chat, threadId, summary, file, summaryKey(input));
    return {
      delivered: true,
      fileName: file.fileName,
      answered: comparison.suppliers.filter((s) => s.replied).length,
      notAnswered: comparison.notRepliedSupplierIds.filter(
        (id) => !answeredWithoutQuote.some((item) => item.supplierId === id),
      ).length,
    };
  },
});
