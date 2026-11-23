import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { dealDocumentSchema, type DealDocument } from '../../kit/domain/models';
import type { RenderValue } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import type { DocumentsDeps } from './deps';
import { resolveRenderContext } from './contract-number';
import { buildRenderData, termDate } from './render-data';
import { WORKING_DAY_TERM_LABELS, checkTemplateFields } from './template-fields';
import { isTemplatePathAllowed } from './template-access';

interface CheckTemplateFieldsInput {
  templatePath: string;
  document: DealDocument;
}
interface CheckTemplateFieldsOutput {
  /** Шаблон из реестра договоров и NDA; false - проверка для него не применяется. */
  known: boolean;
  templateId?: string | undefined;
  complete: boolean;
  /** Пропуски человеческими словами (по одному на поле): в файле маркеры, не допрос. */
  questions: string[];
  /** Метки без значения (для журнала и отладки; сотруднику показывай questions). */
  missingLabels: string[];
  /** Ключи templateFields, которые не принимаются. */
  rejectedKeys: string[];
  /** Ключи requisites, которых нет среди реквизитов поставщика. */
  rejectedRequisites: string[];
  /** Сроки, которые сотрудник назвал датой, а код перевёл в рабочие дни (покажи в сводке). */
  workingDayTerms: WorkingDayTerm[];
}

interface WorkingDayTerm {
  label: string;
  /** Как назвал сотрудник: «до 05.11.2026». */
  asNamed: string;
  workingDays: number;
}

/** Сроки датой, которые сборка перевела в число рабочих дней. */
function workingDayTerms(
  doc: DealDocument,
  fields: Readonly<Record<string, RenderValue>>,
): WorkingDayTerm[] {
  const terms: WorkingDayTerm[] = [];
  for (const label of WORKING_DAY_TERM_LABELS) {
    const asNamed = doc.templateFields?.[label]?.trim() ?? '';
    const value = fields[label];
    const workingDays = typeof value === 'string' ? Number(value) : Number.NaN;
    if (termDate(asNamed) !== undefined && Number.isInteger(workingDays)) {
      terms.push({ label, asNamed, workingDays });
    }
  }
  return terms;
}

/**
 * Проверить до сборки, что у выбранного шаблона договора или NDA есть все метки. Ничего не
 * собирает и не отправляет: только список вопросов сотруднику.
 */
export const checkTemplateFieldsTool = defineTool<
  CheckTemplateFieldsInput,
  CheckTemplateFieldsOutput,
  DocumentsDeps
>({
  name: 'checkTemplateFields',
  description:
    'Проверить, что для выбранного шаблона договора или NDA заполнены все поля, ДО сборки. ' +
    'complete=false: questions - это список пропусков, а не вопросы сотруднику; не задавай их, ' +
    'собирай документ дальше: на месте пропусков встанут маркеры «[ЗАПОЛНИТЬ: поле]», ' +
    'перечисли их в итоге. Если значение сотрудник назвал сам, впиши его в ' +
    'document.templateFields (ключ - метка из missingLabels). Значения не выдумывай. ' +
    'Номер договора, ставку ' +
    'НДС, суммы и ' +
    'пропись код считает сам. Реквизиты поставщика через templateFields не ' +
    'передаются; в requisites допустимы только поля карточки поставщика.',
  inputSchema: z.object({ templatePath: z.string().min(1), document: dealDocumentSchema }),
  outputSchema: z.object({
    known: z.boolean(),
    templateId: z.string().optional(),
    complete: z.boolean(),
    questions: z.array(z.string()),
    missingLabels: z.array(z.string()),
    rejectedKeys: z.array(z.string()),
    rejectedRequisites: z.array(z.string()),
    workingDayTerms: z.array(
      z.object({ label: z.string(), asNamed: z.string(), workingDays: z.number() }),
    ),
  }),
  async execute(input, deps, context) {
    if (!isTemplatePathAllowed(deps, input.templatePath)) {
      throw new DomainError(
        'access_denied',
        'Этот шаблон не входит в список разрешённых: выберите шаблон из findTemplate.',
      );
    }
    // Проверка номер не тратит: берётся уже выданный или временная отметка.
    const resolved = await resolveRenderContext(input.document, deps, input.templatePath, 'peek', {
      initiator: context.initiator,
      parties: true,
    });
    const data = buildRenderData(resolved.document, resolved.options);
    const check = checkTemplateFields(
      input.templatePath,
      data,
      input.document,
      deps.templatesPrefix,
    );
    return {
      known: check.template !== undefined,
      templateId: check.template?.id,
      complete: check.complete,
      questions: [...check.missing, ...check.invalid].map((item) => item.question),
      missingLabels: [...check.missing, ...check.invalid].map((item) => item.label),
      rejectedKeys: check.rejectedKeys,
      rejectedRequisites: check.rejectedRequisites,
      workingDayTerms: workingDayTerms(input.document, data.fields),
    };
  },
});
