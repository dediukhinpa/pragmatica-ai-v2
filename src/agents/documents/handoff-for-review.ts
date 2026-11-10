import { z } from 'zod';
import {
  MISMATCH_NOTE,
  buildReviewChecklist,
  warningChecklistItems,
  type ChecklistItem,
  type EmployeeRequisiteUse,
} from '../../kit/domain/supplier-document';
import { REQUISITE_LABELS, type RequisiteField } from '../../kit/domain/requisites';
import { dealDocumentSchema, type DealDocument } from '../../kit/domain/models';
import { describeFieldPath } from '../../kit/domain/document-sources';
import { warningIssue, type ValidationIssue } from '@business-ai/core';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool, type ToolContext } from '@business-ai/core';
import { joinKey, requirePort, toStoredJson } from '@business-ai/core';
import { assertDocumentBuildable, documentWarnings } from './checks';
import { documentFingerprint } from './fingerprint';
import { webFieldsStatus } from './web-confirmation';
import { AWAITING_REVIEW, REVIEW_NAMESPACE, type DocumentsDeps } from './deps';
import { fillTemplateGaps, type TemplateGap } from './template-fields';
import { renderWithMarkers } from './render-with-markers';
import { resolveRenderContext } from './contract-number';
import { DEAL_REF_FIELD, buildRenderData, outputFileName } from './render-data';
import { assertTemplateOwnSideMatches } from './own-requisites';
import { applyOwnSignatory } from './own-signatory';
import { readAllowedTemplate } from './template-access';
import { isNdaTemplatePath } from './template-registry';
import { assessSupplierDocument, checkSupplierDocument } from './supplier-checks';

interface HandoffInput {
  templatePath: string;
  document: DealDocument;
}
interface HandoffOutput {
  /** Единственный статус, который ставит агент; подписывает и согласует человек. */
  status: typeof AWAITING_REVIEW;
  fileName: string;
  checklist: ChecklistItem[];
  /** Чек-лист текстом и указание модели: в чат он не уходит, итог пишет модель. */
  message: string;
  /** Тред, в который ушёл файл (при повторе из кэша - тред исходной передачи). */
  sentToThreadId: string;
  /** Момент передачи (ISO); повтор возвращает исходный момент. */
  sentAt: string;
}

const inputSchema = z.object({ templatePath: z.string().min(1), document: dealDocumentSchema });
const checklistItemSchema = z.object({
  topic: z.enum(['requisites', 'amounts', 'terms', 'payment', 'warnings']),
  label: z.string(),
  value: z.string(),
  source: z.string(),
});

/**
 * Ключ: документ (поставщик, вид, номер, дата, заявка/КП) + отпечаток данных. Тот же
 * документ в тот же тред
 * ревьюера — одна передача; другой тред получателя (idempotencyPredecessor) — новая отправка.
 */
export function handoffKey(input: HandoffInput): string {
  const doc = input.document;
  return joinKey(
    'document-review',
    doc.supplierId ?? doc.seller,
    doc.kind,
    doc.number,
    doc.issuedAt,
    doc.requestId ?? '',
    documentFingerprint(doc),
  );
}

/** Предупреждение: документ передаётся без поставщика из базы (сверять реквизиты не с чем). */
const NOT_SUPPLIER_DOCUMENT_WARNING = warningIssue(
  'not_supplier_document',
  'Поставщик из базы (supplierId) не указан: реквизиты не сверены с базой, проверьте их ' +
    'по первичным документам.',
);

/**
 * Без поставщика из базы реквизиты сверять не с чем, но документ всё равно передаётся:
 * предупреждение попадает в результат и в чек-лист, а не останавливает выдачу.
 */
export const handoffScopeValidator: AgentValidator<DocumentsDeps> = schemaValidator({
  name: 'handoff-scope',
  tool: 'handoffForReview',
  schema: inputSchema,
  check(input) {
    return input.document.supplierId === undefined ? [NOT_SUPPLIER_DOCUMENT_WARNING] : [];
  },
});

/** Реквизиты против карточки, суммы и условия против КП (если есть): как перед выпуском. */
export const handoffSupplierValidator: AgentValidator<DocumentsDeps> = {
  name: 'handoff-supplier-checks',
  appliesTo: ['handoffForReview'],
  async validate(
    input: unknown,
    deps: DocumentsDeps,
    context: ToolContext,
  ): Promise<ValidationIssue[]> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return [];
    return checkSupplierDocument(
      parsed.data.document,
      deps,
      context.threadId,
      parsed.data.templatePath,
    );
  },
};

/** Название стороны в чек-листе и в отметке происхождения (`EmployeeRequisiteUse`). */
const SELLER_FIELD = 'seller';
const SELLER_LABEL = 'Поставщик';

/** Пометки источника для значений, присланных сотрудником (допущены кодом по его сообщениям). */
const SOURCE_FROM_EMPLOYEE = 'со слов сотрудника, в карточке поставщика нет';
const SOURCE_DIVERGES = 'со слов сотрудника, расходится с карточкой поставщика';
/** Значение внесено в документ, но его нет ни в карточке, ни в сообщениях сотрудника. */
const SOURCE_UNCONFIRMED = 'внесено со слов сотрудника, в базе не подтверждено';

/** Человекочитаемое название поля происхождения: сторона или реквизит (без значения). */
function employeeFieldLabel(field: string): string {
  if (field === SELLER_FIELD) return SELLER_LABEL;
  return REQUISITE_LABELS[field as RequisiteField] ?? field;
}

/** Пометка чек-листа: шаблон ещё содержит поле `{{dealRef}}` (сделки больше нет). */
const DEPRECATED_DEAL_REF_ITEM: ChecklistItem = {
  topic: 'requisites',
  label: 'Шаблон документа',
  value: `в шаблоне устаревшее поле ${DEAL_REF_FIELD}`,
  source: 'проверка шаблона кодом; не ошибка, поле заполнено номером заявки или пусто',
};

/**
 * Шаблон использует `dealRef`: рендерер вернул список неиспользованных ключей, и `dealRef` в
 * нём нет. Без списка (рендерер его не отдаёт) считаем, что не использует.
 */
function usesDealRef(unusedKeys: readonly string[] | undefined): boolean {
  return unusedKeys !== undefined && !unusedKeys.includes(DEAL_REF_FIELD);
}

/**
 * Пункты чек-листа с реквизитами «со слов сотрудника»: источник определяет код по сообщениям
 * сотрудника, а не отметка модели. Значения те же, что в документе.
 */
function markEmployeeItems(
  checklist: readonly ChecklistItem[],
  use: EmployeeRequisiteUse,
): ChecklistItem[] {
  const divergent = new Set(use.divergent.map(employeeFieldLabel));
  const fromEmployee = new Set(use.fromEmployee.map(employeeFieldLabel));
  const unconfirmed = new Set(use.unconfirmed.map(employeeFieldLabel));
  const mismatched = new Map(use.mismatched.map((m) => [employeeFieldLabel(m.field), m.cardValue]));
  return checklist.map((item) => {
    // То же для значения, расходящегося с карточкой: источник с ним указывает код и называет
    // значение карточки, иначе проверяющий не увидит, с чем оно расходится.
    const cardValue = item.topic === 'requisites' ? mismatched.get(item.label) : undefined;
    if (cardValue !== undefined) {
      return { ...item, source: `${MISMATCH_NOTE} (в карточке: ${cardValue})` };
    }
    // Отметка модели «сотрудник (чат)» для такого значения вводила бы в заблуждение:
    // сообщений с ним нет, поэтому источник подменяет код.
    if (item.topic === 'requisites' && unconfirmed.has(item.label)) {
      return { ...item, source: SOURCE_UNCONFIRMED };
    }
    if (item.topic !== 'requisites' || !fromEmployee.has(item.label)) return item;
    const source = divergent.has(item.label) ? SOURCE_DIVERGES : SOURCE_FROM_EMPLOYEE;
    return { ...item, source };
  });
}

/** Блок сообщения: что вписано со слов сотрудника и что расходится с карточкой. */
function employeeSection(use: EmployeeRequisiteUse): string[] {
  const divergent = new Set(use.divergent);
  const lines = use.fromEmployee.map((field) => {
    const note = divergent.has(field) ? 'расходится с карточкой поставщика' : 'нет в карточке';
    return `- ${employeeFieldLabel(field)}: ${note}`;
  });
  const unconfirmed = use.unconfirmed.map((field) => `- ${employeeFieldLabel(field)}`);
  const mismatched = use.mismatched.map(
    (m) => `- ${employeeFieldLabel(m.field)} (в карточке: ${m.cardValue})`,
  );
  return [
    ...(lines.length === 0
      ? []
      : [
          'Вписано с ваших слов (из сообщений в этом чате), сверьте с первичными документами:',
          ...lines,
        ]),
    ...(unconfirmed.length === 0
      ? []
      : [
          'Внесено в документ со слов сотрудника, в базе и в сообщениях этого чата не ' +
            'подтверждено, обязательно сверьте с первичными документами:',
          ...unconfirmed,
        ]),
    ...(mismatched.length === 0
      ? []
      : [
          'Внесено в документ со слов сотрудника, отличается от карточки поставщика и не ' +
            'найдено в сообщениях этого чата, обязательно сверьте с первичными документами:',
          ...mismatched,
        ]),
  ];
}

/** Убрать повторы одного замечания (проверки документа и поставщика пересекаются). */
function dedupeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Название пункта чек-листа с пропусками. */
const GAPS_LABEL = 'Не заполнено';

/** Пункт чек-листа: что в документе осталось маркерами `[ЗАПОЛНИТЬ: ...]`. */
function gapsChecklistItem(gaps: readonly TemplateGap[]): ChecklistItem {
  return {
    topic: 'terms',
    label: GAPS_LABEL,
    value: gaps.map((gap) => gap.marker).join('; '),
    source: 'проверка меток шаблона кодом; заполните до подписания',
  };
}

/**
 * Блок в начале чек-листа для модели: пропуски (значений и ПДн в нём нет). Сотруднику в чат
 * он не уходит: пропуски модель перечисляет одним списком в итоге, без вопроса по каждому.
 */
function gapsSection(gaps: readonly TemplateGap[]): string[] {
  if (gaps.length === 0) return [];
  return [
    `В договоре остались пропуски: ${gaps.map((gap) => gap.title).join(', ')}. ` +
      'Заполните до подписания (в файле они помечены «[ЗАПОЛНИТЬ: ...]»).',
    ...gaps.map((gap) => `- ${gap.question}`),
  ];
}

/**
 * Чек-лист для модели (не для чата): что за документ и что проверить, со значениями и источниками.
 * `webPaths` - веб-поля, подтверждённые кнопкой (определяет код, не отметки модели).
 */
function buildHandoffText(
  doc: DealDocument,
  checklist: readonly ChecklistItem[],
  webPaths: readonly string[],
  use: EmployeeRequisiteUse,
  gaps: readonly TemplateGap[] = [],
): string {
  const topics: Array<[ChecklistItem['topic'], string]> = [
    ['warnings', 'Предупреждения'],
    ['requisites', 'Реквизиты'],
    ['amounts', 'Суммы'],
    ['terms', 'Сроки'],
    ['payment', 'Условия оплаты'],
  ];
  const sections = topics.flatMap(([topic, title]) => {
    const items = checklist.filter((item) => item.topic === topic);
    // Блок предупреждений показываем, только если они есть: остальные темы - всегда.
    if (topic === 'warnings' && items.length === 0) return [];
    return [
      `${title}:`,
      ...items.map((item) => `- ${item.label}: ${item.value} (источник: ${item.source})`),
    ];
  });
  const web = webPaths;
  const webSection =
    web.length === 0
      ? []
      : [
          'Взято из интернета (подтверждено сотрудником):',
          ...web.map((path) => `- ${describeFieldPath(doc, path)}`),
        ];
  return [
    ...gapsSection(gaps),
    `Документ ${doc.number} (${doc.kind}) готов к проверке.`,
    'Статус: ожидает проверки. Документ не подписан и не согласован: это делает сотрудник.',
    'Что проверить перед подписанием:',
    ...sections,
    ...employeeSection(use),
    ...webSection,
  ].join('\n');
}

/** Длинные цифровые ряды (ИНН, КПП, ОГРН, БИК, счета): от 9 цифр подряд. */
const LONG_DIGITS = /\d{9,}/g;
const MASKED_REQUISITE = '[из карточки]';

/**
 * Маскирует цифры реквизитов в тексте для модели: ей хватает названий (ИНН, счёт...), а
 * значения остаются в файле. Так в запрос к модели не попадают 10+ цифр подряд.
 */
function maskRequisiteDigits(text: string): string {
  return text.replace(LONG_DIGITS, MASKED_REQUISITE);
}

/** Указание модели: файл ушёл без подписи, итог сотруднику пишет она одним сообщением. */
const HANDOFF_MODEL_INSTRUCTION =
  'Файл отправлен без подписи. В итоговом ответе скажи сам, одним сообщением: что подставлено ' +
  'и откуда, что осталось маркерами «[ЗАПОЛНИТЬ: ...]», что проверить перед подписанием, ' +
  'статус «ожидает проверки», документ не подписан и не согласован. Чек-лист выше не ' +
  'пересылай дословно и не задавай вопрос по каждому маркеру.';

/**
 * Передать готовый документ с поставщиком сотруднику на проверку и подписание: файл, чек-лист
 * и статус «ожидает проверки». Подписанным или согласованным агент документ не помечает.
 */
export const handoffForReview = defineTool<HandoffInput, HandoffOutput, DocumentsDeps>({
  name: 'handoffForReview',
  description:
    'Передать готовый документ с поставщиком сотруднику на проверку и подписание: файл ' +
    'документа (без подписи) и чек-лист «что проверить перед подписанием» (реквизиты, суммы, ' +
    'сроки, условия оплаты: значение из документа и его источник). Статус только «ожидает проверки»; ' +
    'документ не подписывается и не согласуется. Перед передачей код сверяет реквизиты с ' +
    'базой и суммы с КП (если указана заявка), проверяет подтверждение полей из интернета. ' +
    'Расхождения, пропуски, неподтверждённые данные из интернета, суммы и контрольные суммы ' +
    'реквизитов не блокируют: они идут в чек-лист и в warnings (чек-лист приходит тебе в ' +
    'message, в чат он не уходит: перечисли главное сотруднику одним итоговым сообщением). ' +
    'Один документ передаётся один раз.',
  sideEffect: true,
  // Другая формулировка полей от модели на повторе даст второй файл и чек-лист ревьюеру:
  // оборванный ход повторяется только по кнопке человека.
  replay: 'confirm',
  inputSchema,
  outputSchema: z.object({
    status: z.literal(AWAITING_REVIEW),
    fileName: z.string(),
    checklist: z.array(checklistItemSchema),
    message: z.string(),
    sentToThreadId: z.string(),
    sentAt: z.string(),
  }),
  idempotencyKey: handoffKey,
  // Получатель - тред ревьюера либо тред диалога: в ключ входит именно он (R4-AGT-6).
  idempotencyPredecessor: async (_input, deps, threadId) => deps.reviewerThreadId ?? threadId,
  async execute(input, deps, context) {
    // Поля, реквизиты и КП уже проверили валидаторы декларации до вызова. Источники, сверка с
    // базой и КП повторяются здесь: передача не зависит от состава декларации.
    const doc = input.document;
    await assertDocumentBuildable(doc, deps);
    const { issues, employee } = await assessSupplierDocument(
      doc,
      deps,
      context.threadId,
      input.templatePath,
    );
    // Блокировок нет (решение владельца 03.11): все замечания - предупреждения, они идут в
    // чек-лист и в начало сообщения. Это и проверки самого документа (суммы, НДС, реквизиты,
    // веб-поля), и сверка с карточкой и КП, и отсутствие поставщика.
    const warnings = dedupeIssues([
      ...(await documentWarnings(doc, deps, context.threadId, input.templatePath)),
      ...issues,
      ...(doc.supplierId === undefined ? [NOT_SUPPLIER_DOCUMENT_WARNING] : []),
    ]);
    const state = requirePort(deps.state, 'хранилище статусов документов');
    const supplier = doc.supplierId === undefined ? null : await deps.suppliers.get(doc.supplierId);
    // Поставщика с таким id нет: не отказ, а предупреждение supplier_not_found уже в списке;
    // чек-лист строится без карточки (значения в документе - со слов сотрудника).
    // КП берём, только если документ ссылается на заявку и поставщик известен; нет КП -
    // предупреждение `quote_not_found` уже в списке. NDA с КП не сверяется.
    const isNda = isNdaTemplatePath(input.templatePath, deps.templatesPrefix ?? '');
    const quote =
      isNda || doc.supplierId === undefined || doc.requestId === undefined
        ? null
        : await requirePort(deps.quotes, 'хранилище КП').get(doc.requestId, doc.supplierId);
    const printed = await readAllowedTemplate(deps, input.templatePath);
    // Этап 230: напечатанные в шаблоне наши реквизиты должны совпадать с записью БД.
    await assertTemplateOwnSideMatches(deps, printed, context.signal);
    // Подписант нашей стороны - из записи БД (в шаблоне на шаре напечатан прежний).
    const template = await applyOwnSignatory(deps, printed, context.signal);
    // Данных шаблона договора достаточно, иначе сотрудника спросят, а не оборвут сборку.
    // Номер договора и текущий год задаёт код: значение модели в number перекрывается.
    const resolved = await resolveRenderContext(doc, deps, template.path, 'issue', {
      initiator: context.initiator,
      parties: true,
    });
    const data = buildRenderData(resolved.document, resolved.options);
    // Пропуски не останавливают передачу: на их месте маркеры [ЗАПОЛНИТЬ: ...], а список
    // уходит в чек-лист и в начало сообщения. Статус остаётся «ожидает проверки».
    const filled = fillTemplateGaps(template.path, data, doc, deps.templatesPrefix);
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
    // Предупреждения сборки (лишние ключи модели) - в тот же список проверяющему.
    warnings.push(...filled.warnings);
    // Подтверждённые кнопкой веб-поля берутся из состояния; неподтверждённые уже в warnings.
    const web = await webFieldsStatus(doc, deps, context.threadId);
    const checklist = markEmployeeItems(
      buildReviewChecklist(doc, supplier, quote, {
        webPaths: new Set(web.paths),
        confirmed: web.status === 'confirmed',
      }),
      employee,
    );
    // Что подставила система, а не сотрудник: проверяющий видит это в чек-листе
    checklist.push(...resolved.notes);
    // Расхождения с КП («в документе 120, в КП 100»), карточкой и пропуски проверок.
    checklist.unshift(...warningChecklistItems(warnings));
    // Пропуски идут первым пунктом: их надо закрыть до подписания.
    if (rendered.gaps.length > 0) checklist.unshift(gapsChecklistItem(rendered.gaps));
    if (usesDealRef(file.unusedKeys)) checklist.push(DEPRECATED_DEAL_REF_ITEM);
    const key = handoffKey(input);
    const threadId = deps.reviewerThreadId ?? context.threadId;
    // Ключи канала включают тред получателя: иначе канал отбросил бы отправку в другой.
    const channelKey = `${key}:${threadId}`;
    // В чат уходит только файл: итог говорит одно сообщение модели (решение владельца 03.11,
    // как в правке прайсов), иначе чек-лист дублировал бы её ответ по смыслу.
    await deps.chat.sendFile(threadId, file, channelKey);
    const text = buildHandoffText(
      resolved.document,
      checklist,
      web.paths,
      employee,
      rendered.gaps,
    );
    const sentAt = (deps.clock?.now() ?? new Date()).toISOString();
    const status = {
      status: AWAITING_REVIEW,
      requestId: doc.requestId ?? '',
      kind: doc.kind,
      number: resolved.document.number,
      supplierId: doc.supplierId ?? '',
      fileName: file.name,
      documentHash: documentFingerprint(doc),
      handedAt: sentAt,
    };
    // Для агента сценарий завершён передачей человеку: запись ретенция может удалить через
    // WORKFLOW_STATE_RETENTION_DAYS (повтор передачи защищён ключом идемпотентности рантайма).
    await state.put(
      REVIEW_NAMESPACE,
      joinKey(doc.supplierId ?? '', doc.kind, doc.number, doc.issuedAt, doc.requestId ?? ''),
      toStoredJson(status),
      { done: true },
    );
    return {
      status: AWAITING_REVIEW,
      fileName: file.name,
      checklist,
      sentToThreadId: threadId,
      sentAt,
      message: `${maskRequisiteDigits(text)}\n\n${HANDOFF_MODEL_INSTRUCTION}`,
    };
  },
});
