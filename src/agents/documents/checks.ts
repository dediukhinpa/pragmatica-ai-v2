import { DomainError, warningIssue, type ValidationIssue } from '@business-ai/core';
import { checkFieldSources } from '../../kit/domain/document-sources';
import { validateDocumentFields } from '../../kit/domain/validators.owned';
import { type DealDocument } from '../../kit/domain/models';
import { disabledKindMessage } from './enabled-kinds';
import { withIssueDate } from './issue-date';
import { isNdaTemplatePath } from './template-registry';
import { PARTY_LOOKUP_LIMIT, type DocumentsDeps } from './deps';
import { checkSupplierDocument } from './supplier-checks';
import { withTemplateBuyer } from './template-buyer';
import { webConfirmationIssues } from './web-confirmation';

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Известна ли сторона: собственное юрлицо или поставщик из базы (по точному названию). */
async function isKnownParty(name: string, deps: DocumentsDeps): Promise<boolean> {
  const wanted = normalize(name);
  if (wanted === '') return false;
  if (deps.ownCompanyNames.some((own) => normalize(own) === wanted)) return true;
  const found = await deps.suppliers.search(name.trim(), PARTY_LOOKUP_LIMIT);
  return found.some((supplier) => normalize(supplier.name) === wanted);
}

/**
 * Известность сторон: хотя бы одна сторона - своя компания или поставщик из базы. Сверки со
 * сделкой больше нет: позиции и суммы сверяются с выбранным КП (`checkSupplierDocument`).
 */
export async function checkParties(
  doc: DealDocument,
  deps: DocumentsDeps,
): Promise<ValidationIssue[]> {
  const buyerKnown = await isKnownParty(doc.buyer, deps);
  const sellerKnown = await isKnownParty(doc.seller, deps);
  if (!buyerKnown && !sellerKnown) {
    // Новый контрагент не из базы - обычный случай; сотрудник увидит напоминание сверить стороны.
    return [
      warningIssue(
        'party_unknown',
        'Ни покупатель, ни продавец не найдены среди своих юрлиц и поставщиков.',
      ),
    ];
  }
  return [];
}

/**
 * Источники полей и подтверждение веб-данных кнопкой. Подтверждение берётся из состояния
 * треда (его пишет обработчик кнопки), а не из полей документа. Без `threadId` веб-поля
 * считаются неподтверждёнными.
 */
export async function checkDocumentSources(
  doc: DealDocument,
  deps: DocumentsDeps,
  threadId: string | undefined,
): Promise<ValidationIssue[]> {
  return [...checkFieldSources(doc), ...(await webConfirmationIssues(doc, deps, threadId))];
}

/**
 * Документ можно собирать: единственное, что здесь останавливает сборку, - вид документа
 * выключен владельцем (`DOCUMENTS_ENABLED_KINDS`). Всё остальное (поля из интернета без
 * подтверждения, отметки источников, суммы) - предупреждения (`checkDocumentSources`), они
 * идут сотруднику одним списком после выдачи (решение владельца 03.11).
 * @throws DomainError('validation_failed') только для выключенного вида.
 */
export async function assertDocumentBuildable(
  doc: DealDocument,
  deps: DocumentsDeps,
): Promise<void> {
  // Выключенный вид не собирается ни одним путём: ни fillTemplate, ни saveDocument, ни
  // handoffForReview.
  const disabled = disabledKindMessage(deps, doc.kind);
  if (disabled !== undefined) throw new DomainError('validation_failed', disabled);
}

/**
 * У NDA нет позиций, номер и валюту ему не задают: эти замечания общей проверки полей к нему
 * не относятся, чтобы не засорять список предупреждений (остальные - стороны, реквизиты, даты -
 * действуют).
 */
function ndaExempt(issue: ValidationIssue, ndaTemplate: boolean): boolean {
  return (
    ndaTemplate &&
    (issue.code === 'no_lines' ||
      (issue.code === 'missing_field' &&
        (issue.message.includes(' number.') || issue.message.includes(' currency.'))))
  );
}

/** Замечания по полям документа (обязательные, суммы, НДС, даты, контрольные суммы). */
export function checkDocumentFields(
  doc: DealDocument,
  deps: DocumentsDeps,
  templatePath?: string,
): ValidationIssue[] {
  const ndaTemplate = isNdaTemplatePath(templatePath, deps.templatesPrefix ?? '');
  return validateDocumentFields(doc).filter((issue) => !ndaExempt(issue, ndaTemplate));
}

/**
 * Предупреждения о самом документе без сверки с поставщиком: поля, источники, веб-данные,
 * известность сторон. Всё это не блокирует выдачу; список идёт в чек-лист передачи на проверку.
 */
export async function documentWarnings(
  input: DealDocument,
  deps: DocumentsDeps,
  threadId?: string,
  templatePath?: string,
): Promise<ValidationIssue[]> {
  const doc = withIssueDate(withTemplateBuyer(input, deps, templatePath), deps);
  return [
    ...checkDocumentFields(doc, deps, templatePath),
    ...(await checkDocumentSources(doc, deps, threadId)),
    ...(await checkParties(doc, deps)),
  ];
}

/**
 * Все проверки документа: поля, суммы, НДС и контрольные суммы реквизитов (домен), источники
 * полей и подтверждение веб-данных, известность сторон, для документа с поставщиком -
 * реквизиты по карточке и позиции, цены, суммы по выбранному КП. Блокирует только
 * `kind_disabled`, остальное - предупреждения.
 */
export async function checkDocument(
  input: DealDocument,
  deps: DocumentsDeps,
  threadId?: string,
  templatePath?: string,
): Promise<ValidationIssue[]> {
  const doc = withIssueDate(withTemplateBuyer(input, deps, templatePath), deps);
  const disabled = disabledKindMessage(deps, doc.kind);
  return [
    ...(disabled === undefined ? [] : [{ code: 'kind_disabled', message: disabled }]),
    ...(await documentWarnings(input, deps, threadId, templatePath)),
    ...(await checkSupplierDocument(doc, deps, threadId, templatePath)),
  ];
}
