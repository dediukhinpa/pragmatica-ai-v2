import { z } from 'zod';
import { dealDocumentSchema, type DealDocument } from '../../kit/domain/models';
import { warningIssue, type ValidationIssue } from '@business-ai/core';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { joinKey } from '@business-ai/core';
import {
  assertDocumentBuildable,
  checkDocumentFields,
  checkDocumentSources,
  checkParties,
} from './checks';
import { documentFingerprint } from './fingerprint';
import type { DocumentsDeps } from './deps';
import { fillTemplateGaps } from './template-fields';
import { renderWithMarkers } from './render-with-markers';
import { resolveRenderContext } from './contract-number';
import { buildRenderData, outputFileName } from './render-data';
import { assertTemplateOwnSideMatches } from './own-requisites';
import { applyOwnSignatory } from './own-signatory';
import { readAllowedTemplate } from './template-access';
import { classifySupplierDocument } from './supplier-checks';
import { withIssueDate } from './issue-date';

interface SaveDocumentInput {
  templatePath: string;
  document: DealDocument;
}
interface SaveDocumentOutput {
  delivered: boolean;
  fileName: string;
  /** Тред, в который ушёл файл (при повторе из кэша - тред исходной отправки). */
  sentToThreadId: string;
  /** Момент отправки файла (ISO); повтор возвращает исходный момент, а не текущий. */
  sentAt: string;
  /** Пропуски (в файле маркеры) и предупреждения сборки: перечислить сотруднику списком. */
  unfilled: string[];
}

const inputSchema = z.object({ templatePath: z.string().min(1), document: dealDocumentSchema });

/**
 * Ключ: поставщик (иначе продавец) + вид + номер + дата + заявка/КП (если есть) + шаблон +
 * отпечаток данных (без id и отметок источников). Изменились данные — это новая операция.
 * Тред добавляется отдельно (idempotencyPredecessor): тот же документ из другого треда
 * должен реально уйти в этот тред, а не вернуть «отправлено» из кэша без отправки.
 */
export function saveDocumentKey(input: SaveDocumentInput): string {
  const doc = input.document;
  return joinKey(
    'document',
    doc.supplierId ?? doc.seller,
    doc.kind,
    doc.number,
    doc.issuedAt,
    doc.requestId ?? '',
    input.templatePath,
    documentFingerprint(doc),
  );
}

/** Валидатор перед выпуском: обязательные поля, суммы, даты (только предупреждения). */
export const documentFieldsValidator: AgentValidator<DocumentsDeps> = schemaValidator({
  name: 'document-fields',
  tool: 'saveDocument',
  appliesTo: ['saveDocument', 'handoffForReview'],
  schema: inputSchema,
  check(input, deps) {
    return checkDocumentFields(withIssueDate(input.document, deps), deps, input.templatePath);
  },
});

/** Валидатор перед выпуском: известность сторон (ходит в базу поставщиков). */
export const documentPartiesValidator: AgentValidator<DocumentsDeps> = {
  name: 'document-parties',
  appliesTo: ['saveDocument', 'handoffForReview'],
  async validate(input: unknown, deps: DocumentsDeps): Promise<ValidationIssue[]> {
    const parsed = inputSchema.safeParse(input);
    // Некорректные аргументы уже отмечает валидатор полей.
    if (!parsed.success) return [];
    return checkParties(parsed.data.document, deps);
  },
};

/**
 * Валидатор перед выпуском: источники полей и подтверждение полей из интернета кнопкой.
 * Нет отметки или подтверждения - предупреждение, документ всё равно собирается.
 */
export const documentSourcesValidator: AgentValidator<DocumentsDeps> = schemaValidator({
  name: 'document-sources',
  tool: 'saveDocument',
  appliesTo: ['saveDocument', 'handoffForReview'],
  schema: inputSchema,
  check(input, deps, context) {
    return checkDocumentSources(input.document, deps, context.threadId);
  },
});

/** Предупреждение saveDocument для документа с поставщиком. */
const USE_HANDOFF_MESSAGE =
  'Документ с поставщиком лучше передавать сотруднику через handoffForReview ' +
  '(файл, чек-лист и статус «ожидает проверки»): saveDocument не сверяет реквизиты и КП.';

/**
 * Документ с поставщиком лучше выдавать через handoffForReview (с чек-листом и статусом
 * «ожидает проверки»). Это предупреждение, а не отказ: файл сотруднику всё равно уходит.
 * Что документ «с поставщиком», определяет код по виду, реквизитам и сторонам
 * (classifySupplierDocument), а не заполненный моделью supplierId.
 */
export const supplierDocumentViaHandoffValidator: AgentValidator<DocumentsDeps> = {
  name: 'supplier-document-via-handoff',
  appliesTo: ['saveDocument'],
  async validate(input: unknown, deps: DocumentsDeps): Promise<ValidationIssue[]> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return [];
    const signs = await classifySupplierDocument(parsed.data.document, deps);
    if (signs.length === 0) return [];
    return [warningIssue('use_handoff_for_review', USE_HANDOFF_MESSAGE)];
  },
};

/** Выпустить документ: отдать файл сотруднику в чат. */
export const saveDocument = defineTool<SaveDocumentInput, SaveDocumentOutput, DocumentsDeps>({
  name: 'saveDocument',
  description:
    'Выпустить документ: отрисовать шаблон и отправить файл сотруднику в чат. Только для ' +
    'документов клиенту от нашего юрлица (КП, счёт). Договор, ' +
    'закрывающие и любой документ с реквизитами или продавцом-поставщиком лучше передавать ' +
    'через handoffForReview (предупреждение use_handoff_for_review). Необратимо; перед ' +
    'выпуском рантайм проверяет суммы, НДС и подтверждение веб-данных: замечания не ' +
    'блокируют выдачу, они приходят в warnings, пропуски и предупреждения сборки - в ' +
    'unfilled (перечисли их сотруднику одним списком после выдачи).',
  sideEffect: true,
  // Другая формулировка полей от модели на повторе даст второй файл сотруднику:
  // оборванный ход повторяется только по кнопке человека.
  replay: 'confirm',
  inputSchema,
  outputSchema: z.object({
    delivered: z.boolean(),
    fileName: z.string(),
    sentToThreadId: z.string(),
    sentAt: z.string(),
    unfilled: z.array(z.string()),
  }),
  idempotencyKey: saveDocumentKey,
  // Файл уходит в тред диалога: повтор в том же треде не дублирует отправку, из другого -
  // отправляет файл туда (R4-AGT-6).
  idempotencyPredecessor: async (_input, _deps, threadId) => threadId,
  async execute(input, deps, context) {
    // Поля, суммы и стороны проверили валидаторы декларации: их замечания - предупреждения.
    // Здесь останавливает только выключенный вид документа.
    await assertDocumentBuildable(input.document, deps);
    const printed = await readAllowedTemplate(deps, input.templatePath);
    // Этап 230: напечатанные в шаблоне наши реквизиты должны совпадать с записью БД.
    await assertTemplateOwnSideMatches(deps, printed, context.signal);
    // Подписант нашей стороны - из записи БД (в шаблоне на шаре напечатан прежний).
    const template = await applyOwnSignatory(deps, printed, context.signal);
    // Данных шаблона договора достаточно, иначе сотрудника спросят, а не оборвут сборку.
    // Номер договора и текущий год задаёт код: значение модели в number перекрывается.
    const resolved = await resolveRenderContext(input.document, deps, template.path, 'issue', {
      initiator: context.initiator,
      parties: true,
    });
    const data = buildRenderData(resolved.document, resolved.options);
    // Пропуски не останавливают выдачу: на их месте маркеры [ЗАПОЛНИТЬ: ...].
    const filled = fillTemplateGaps(template.path, data, input.document, deps.templatesPrefix);
    const rendered = await renderWithMarkers(
      deps.renderer,
      {
        template: { kind: 'bytes', content: template.content },
        templatePath: template.path,
        outputName: outputFileName(resolved.document),
      },
      filled,
    );
    const file = rendered.file;
    const key = saveDocumentKey(input);
    // Файл уходит в тред, в котором идёт диалог: его даёт рантайм, а не настройка агента.
    // Ключ канала включает тред: иначе канал сам отбросил бы отправку в другой тред.
    await deps.chat.sendFile(context.threadId, file, `${key}:${context.threadId}`);
    const sentAt = (deps.clock?.now() ?? new Date()).toISOString();
    return {
      delivered: true,
      fileName: file.name,
      sentToThreadId: context.threadId,
      sentAt,
      unfilled: [...rendered.gaps.map((gap) => gap.question), ...rendered.warnings],
    };
  },
});
