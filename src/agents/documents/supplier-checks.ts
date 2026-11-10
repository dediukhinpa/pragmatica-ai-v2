import {
  assessDocumentRequisites,
  checkDocumentAgainstQuote,
  isOwnCompany,
  normalizePartyName,
  supplierDocumentSigns,
  type EmployeeRequisiteUse,
  type SupplierDocumentSign,
} from '../../kit/domain/supplier-document';
import { warningIssue, type ValidationIssue } from '@business-ai/core';
import { validateSupplierRequisites } from '../../kit/domain/requisites';
import { type DealDocument } from '../../kit/domain/models';
import { requirePort } from '@business-ai/core';
import { PARTY_LOOKUP_LIMIT, type DocumentsDeps } from './deps';
import { readEmployeeText } from './employee-messages';
import { withTemplateBuyer } from './template-buyer';
import { isNdaTemplatePath } from './template-registry';

/** Сколько заявок с КП поставщика называем в замечании. */
const QUOTE_REQUESTS_LISTED = 5;

/** Сторона документа совпадает по названию с поставщиком из базы. */
async function isSupplierFromBase(name: string, deps: DocumentsDeps): Promise<boolean> {
  const wanted = normalizePartyName(name);
  if (wanted === '') return false;
  const found = await deps.suppliers.search(name.trim(), PARTY_LOOKUP_LIMIT);
  return found.some((supplier) => normalizePartyName(supplier.name) === wanted);
}

/**
 * Признаки документа с поставщиком: по данным документа (домен) и по базе - покупатель или
 * продавец совпадает с поставщиком. Определяет код: смена вида документа, пустые реквизиты
 * или пропущенный `supplierId` строгий путь не отключают. Пустой список - документ клиенту.
 */
export async function classifySupplierDocument(
  doc: DealDocument,
  deps: DocumentsDeps,
): Promise<SupplierDocumentSign[]> {
  const signs = supplierDocumentSigns(doc, deps.ownCompanyNames);
  const partyIsSupplier =
    (await isSupplierFromBase(doc.seller, deps)) || (await isSupplierFromBase(doc.buyer, deps));
  return partyIsSupplier ? [...signs, 'party_is_supplier'] : signs;
}

/** Итог проверки документа с поставщиком: замечания и происхождение реквизитов. */
export interface SupplierDocumentAssessment {
  issues: ValidationIssue[];
  /** Значения «со слов сотрудника» и расхождения с карточкой (имена полей, без значений). */
  employee: EmployeeRequisiteUse;
}

/** Без значений от сотрудника (не документ с поставщиком или проверка остановлена раньше). */
function withoutEmployee(issues: ValidationIssue[]): SupplierDocumentAssessment {
  return { issues, employee: { fromEmployee: [], divergent: [], unconfirmed: [], mismatched: [] } };
}

/**
 * Проверки документа с поставщиком: поставщик указан и есть в базе, покупатель - наше юрлицо,
 * реквизиты совпадают с базой или присланы сотрудником в этом треде, а если указана заявка -
 * суммы, позиции, условия совпадают с КП. Возвращает и список реквизитов «со слов сотрудника»
 * (для передачи на проверку). Без `threadId` сообщений сотрудника нет: реквизит вне карточки
 * остаётся замечанием. Документы клиенту от своего юрлица (КП, счета) не затрагиваются.
 */
export async function assessSupplierDocument(
  input: DealDocument,
  deps: DocumentsDeps,
  threadId?: string,
  templatePath?: string,
): Promise<SupplierDocumentAssessment> {
  const doc = withTemplateBuyer(input, deps, templatePath);
  return assessWithBuyer(doc, deps, threadId, templatePath);
}

async function assessWithBuyer(
  doc: DealDocument,
  deps: DocumentsDeps,
  threadId: string | undefined,
  templatePath: string | undefined,
): Promise<SupplierDocumentAssessment> {
  const signs = await classifySupplierDocument(doc, deps);
  if (signs.length === 0) return withoutEmployee([]);
  if (doc.supplierId === undefined) {
    // Без поставщика из базы сверять реквизиты не с чем, но договор всё равно выдаётся:
    // сотрудник получает напоминание сверить реквизиты с первичными документами.
    return withoutEmployee([
      warningIssue(
        'supplier_id_required',
        'Это документ с поставщиком (договор, закрывающие, реквизиты или продавец не наше ' +
          'юрлицо), но поставщик из базы (supplierId) не указан: реквизиты и суммы не ' +
          'сверены с базой и КП, проверьте их по первичным документам.',
      ),
    ]);
  }
  const supplier = await deps.suppliers.get(doc.supplierId);
  if (supplier === null) {
    // Поставщик не найден: сверять реквизиты не с чем, договор всё равно выдаётся.
    return withoutEmployee([
      warningIssue(
        'supplier_not_found',
        `Поставщик ${doc.supplierId} не найден в базе: реквизиты не сверены, проверьте их ` +
          'по первичным документам.',
      ),
    ]);
  }
  const employeeText = await readEmployeeText(deps.state, threadId);
  const requisites = assessDocumentRequisites(doc, supplier, employeeText);
  const { employee } = requisites;
  // Поле, значение которого сотрудник прислал, замечаниями карточки не блокируется:
  // формат самого значения проверен отдельно (employee_requisite_invalid).
  const issues = [
    ...validateSupplierRequisites(supplier, new Set(employee.fromEmployee)),
    ...requisites.issues,
  ];
  if (!isOwnCompany(doc.buyer, deps.ownCompanyNames)) {
    issues.push(
      warningIssue(
        'buyer_not_own_company',
        'Покупатель в документе с поставщиком - не наше юрлицо.',
      ),
    );
  }
  // NDA не привязано к КП: позиций и сумм в нём нет, поэтому у поставщика с КП оно не должно
  // упираться в сверку. Реквизиты и покупатель проверены выше.
  if (isNdaTemplatePath(templatePath, deps.templatesPrefix ?? '')) return { issues, employee };
  // КП необязательно: данные могут прийти из чата. Заявка указана - сверяем с КП по ней.
  if (doc.requestId === undefined) {
    // Заявка не названа, но у поставщика КП есть: напоминаем о сверке (документ выдаётся).
    // Нужны только факт наличия КП и первые id заявок: сами КП не выгружаем.
    const known =
      (await deps.quotes?.listRequestIdsBySupplier(doc.supplierId, QUOTE_REQUESTS_LISTED)) ?? [];
    if (known.length > 0) {
      const requests = known.join(', ');
      issues.push(
        warningIssue(
          'quote_reconcile_required',
          `У поставщика есть сохранённое КП (заявки: ${requests}), а в документе не указана ` +
            'заявка (requestId): суммы не сверены с КП. Сверьте их или уточните у сотрудника, ' +
            'по КП какой заявки составлен документ.',
        ),
      );
    }
    return { issues, employee };
  }
  const quotes = requirePort(deps.quotes, 'хранилище КП');
  const quote = await quotes.get(doc.requestId, doc.supplierId);
  if (quote === null) {
    issues.push(
      warningIssue(
        'quote_not_found',
        `КП поставщика по заявке ${doc.requestId} не сохранено: сверить нечего.`,
      ),
    );
    return { issues, employee };
  }
  issues.push(...checkDocumentAgainstQuote(doc, quote, deps.clock?.now()));
  return { issues, employee };
}

/** Замечания по документу с поставщиком (см. `assessSupplierDocument`). */
export async function checkSupplierDocument(
  doc: DealDocument,
  deps: DocumentsDeps,
  threadId?: string,
  templatePath?: string,
): Promise<ValidationIssue[]> {
  return (await assessSupplierDocument(doc, deps, threadId, templatePath)).issues;
}
