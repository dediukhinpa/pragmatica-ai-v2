import { z } from 'zod';
import { dealDocumentSchema, type DealDocument } from '../../kit/domain/models';
import { isBlockingIssue } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { checkDocument } from './checks';
import type { DocumentsDeps } from './deps';

interface ValidateDocumentInput {
  document: DealDocument;
  /** Шаблон документа (путь из findTemplate): для NDA сверка с КП не применяется. */
  templatePath?: string | undefined;
}
interface ValidateDocumentOutput {
  ok: boolean;
  /** Ошибки блокируют выдачу, предупреждения (`warning`) - напоминание сотруднику. */
  issues: Array<{ code: string; message: string; severity: 'error' | 'warning' }>;
}

/** Проверка документа до выпуска; те же проверки повторяет saveDocument. */
export const validateDocument = defineTool<
  ValidateDocumentInput,
  ValidateDocumentOutput,
  DocumentsDeps
>({
  name: 'validateDocument',
  description:
    'Проверить документ: обязательные поля, суммы, даты, сверка с КП и известность ' +
    'сторон; для документа с поставщиком (определяет код) - поставщик из базы, реквизиты и ' +
    'сверка с КП (для NDA передай templatePath: сверки с КП нет). Возвращает замечания ' +
    'с severity: error блокирует выдачу, warning - напоминание (документ всё равно ' +
    'выдаётся, перечисли предупреждения сотруднику); ok=true, если ошибок нет.',
  inputSchema: z.object({
    document: dealDocumentSchema,
    templatePath: z.string().min(1).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    issues: z.array(
      z.object({ code: z.string(), message: z.string(), severity: z.enum(['error', 'warning']) }),
    ),
  }),
  async execute(input, deps, context) {
    const issues = await checkDocument(
      input.document,
      deps,
      context.threadId,
      input.templatePath,
    );
    return {
      ok: !issues.some(isBlockingIssue),
      issues: issues.map((issue) => ({ ...issue, severity: issue.severity ?? 'error' })),
    };
  },
});
