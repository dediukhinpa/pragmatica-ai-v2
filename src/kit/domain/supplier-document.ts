import { FIELD_SOURCE_LABELS, fieldSourceOf } from './document-sources';
import { parseIsoDeadline } from './iso-datetime';
import type { DealDocument, DocumentKind, QuoteLine, Supplier, SupplierQuote } from './models';
import { canonicalFieldValue, valueInEmployeeText } from './employee-text';
import {
  REQUISITE_FIELDS,
  REQUISITE_LABELS,
  invalidRequisiteChecks,
  supplierRequisitesRecord,
  type RequisiteField,
} from './requisites';
import { normalizeItemName } from './quotes';
import { fromMinorUnits, lineCents, sameMoney } from './money';
import { sameUnit } from './units';
import { warningIssue } from '@business-ai/core';
import type { ValidationIssue } from '@business-ai/core';

const sameText = (a: string, b: string): boolean => normalizeItemName(a) === normalizeItemName(b);

/** Виды документов, которые всегда составляются с поставщиком (договор, закрывающие). */
const SUPPLIER_DOCUMENT_KINDS: ReadonlySet<DocumentKind> = new Set(['contract', 'closing']);

/** Признак, по которому код относит документ к документам с поставщиком. */
export type SupplierDocumentSign =
  'kind' | 'supplier_id' | 'requisites' | 'seller_not_own' | 'party_is_supplier';

/**
 * Название стороны для сравнения: NFKC, без регистра, «ё» = «е», пробелы схлопнуты. Буквы
 * разных алфавитов не приравниваются: «OOO» латиницей остаётся чужим названием.
 */
export function normalizePartyName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/** Сторона документа - собственное юрлицо (точное совпадение после нормализации). */
export function isOwnCompany(name: string, ownCompanyNames: readonly string[]): boolean {
  const wanted = normalizePartyName(name);
  return wanted !== '' && ownCompanyNames.some((own) => normalizePartyName(own) === wanted);
}

/**
 * Признаки документа с поставщиком по самим данным документа. Решает код, а не поле, которое
 * заполняет модель: вид «договор/закрывающие», указанный поставщик, любые реквизиты или
 * продавец, который не является нашим юрлицом. Пустой список - документ клиенту от своего
 * юрлица (КП, счёт). Совпадение стороны с поставщиком из базы проверяет слой приложения.
 */
export function supplierDocumentSigns(
  doc: DealDocument,
  ownCompanyNames: readonly string[],
): SupplierDocumentSign[] {
  const signs: SupplierDocumentSign[] = [];
  if (SUPPLIER_DOCUMENT_KINDS.has(doc.kind)) signs.push('kind');
  if (doc.supplierId !== undefined) signs.push('supplier_id');
  if (Object.values(doc.requisites ?? {}).some((value) => value.trim() !== '')) {
    signs.push('requisites');
  }
  if (!isOwnCompany(doc.seller, ownCompanyNames)) signs.push('seller_not_own');
  return signs;
}

/** Сумма КП по позициям заявки с ценой (количество КП, иначе из строки документа). */
export function quoteTotal(
  quote: SupplierQuote,
  fallbackQuantity: (productName: string) => number | undefined = () => undefined,
): number {
  // Каждая строка округляется до копеек отдельно, сумма - в целых копейках (R3-ALG-19/20).
  let sumCents = 0;
  for (const line of quote.lines) {
    if (line.isReplacement === true || line.unitPrice === undefined) continue;
    const quantity = line.quantity ?? fallbackQuantity(line.productName);
    if (quantity !== undefined) sumCents += lineCents(quantity, line.unitPrice);
  }
  return fromMinorUnits(sumCents);
}

/** Имя «поля» названия стороны в списках происхождения значений. */
const SELLER_FIELD = 'seller';

/** Какие значения документа допущены по сообщениям сотрудника (имена полей, без значений). */
export interface EmployeeRequisiteUse {
  /** Поля («seller» и имена реквизитов), значение которых сотрудник прислал в чате. */
  fromEmployee: string[];
  /** Из них: значение расходится с карточкой поставщика, а не дополняет её. */
  divergent: string[];
  /**
   * Реквизиты, которых нет ни в карточке, ни в сообщениях сотрудника: значение всё равно
   * вносится в документ (решение владельца), но проверяющий должен знать, что оно не из базы.
   */
  unconfirmed: string[];
  /**
   * Реквизиты, значение которых расходится с карточкой и не найдено в сообщениях сотрудника:
   * значение тоже вносится в документ (решение владельца), а в предупреждении нужно значение
   * из карточки, чтобы проверяющий видел, с чем именно оно расходится.
   */
  mismatched: Array<{ field: string; cardValue: string }>;
}

/** Замечания по реквизитам документа и происхождение допущенных значений. */
export interface DocumentRequisitesAssessment {
  issues: ValidationIssue[];
  employee: EmployeeRequisiteUse;
}

/** Длина расчётного и корреспондентского счёта. */
const ACCOUNT_DIGITS = /^\d{20}$/u;
const ACCOUNT_FIELDS: ReadonlySet<string> = new Set(['settlementAccount', 'correspondentAccount']);

/** Формат значений от сотрудника: контрольные суммы и длина счетов; без значений в тексте. */
function employeeFormatIssues(
  doc: DealDocument,
  supplier: Supplier,
  fields: readonly RequisiteField[],
): ValidationIssue[] {
  if (fields.length === 0) return [];
  const record: Record<string, string> = {};
  for (const field of fields) {
    const value = doc.requisites?.[field]?.trim();
    if (value !== undefined) record[field] = value;
  }
  // БИК для сверки счетов берётся из документа, иначе из карточки.
  const bik = doc.requisites?.bik?.trim() || supplier.bik;
  if (bik !== undefined && bik !== '') record.bik = bik;
  const wrong = new Map<string, string>();
  for (const { field, reason } of invalidRequisiteChecks(record)) wrong.set(field, reason);
  for (const field of fields) {
    const value = record[field];
    if (ACCOUNT_FIELDS.has(field) && value !== undefined && !ACCOUNT_DIGITS.test(value)) {
      wrong.set(field, 'ожидается 20 цифр');
    }
  }
  return fields
    .filter((field) => wrong.has(field))
    .map((field) =>
      warningIssue(
        'employee_requisite_invalid',
        `Реквизит «${REQUISITE_LABELS[field]}» из сообщений сотрудника не проходит проверку ` +
          `формата (${wrong.get(field) ?? ''}): внесён как назван, проверьте значение.`,
      ),
    );
}

/** Формулировка предупреждения о значении, расходящемся с карточкой (без значения карточки). */
export const MISMATCH_NOTE = 'внесено со слов сотрудника, отличается от карточки поставщика';

/**
 * Реквизиты в документе против базы поставщиков и сообщений сотрудника. Значение, которого нет
 * в карточке или которое с ней расходится, допускается, только если код нашёл его в тексте
 * сообщений сотрудника этого треда (`employeeText`, нормализованный); отметка источника в
 * документе роли не играет. Допущенное значение проходит формальную проверку.
 */
export function assessDocumentRequisites(
  doc: DealDocument,
  supplier: Supplier,
  employeeText = '',
): DocumentRequisitesAssessment {
  const issues: ValidationIssue[] = [];
  const fromEmployee: string[] = [];
  const divergent: string[] = [];
  const unconfirmed: string[] = [];
  const mismatched: Array<{ field: string; cardValue: string }> = [];
  if (!sameText(doc.seller, supplier.name)) {
    if (valueInEmployeeText(SELLER_FIELD, doc.seller, employeeText)) {
      fromEmployee.push(SELLER_FIELD);
      divergent.push(SELLER_FIELD);
    } else {
      issues.push({
        code: 'seller_mismatch',
        severity: 'warning',
        message:
          'Название поставщика в документе не совпадает с карточкой поставщика в базе ' +
          'и не найдено в ваших сообщениях.',
      });
    }
  }
  const expected = supplierRequisitesRecord(supplier);
  const employeeFields: RequisiteField[] = [];
  for (const field of REQUISITE_FIELDS) {
    const wanted = expected[field];
    const actual = doc.requisites?.[field]?.trim();
    const label = REQUISITE_LABELS[field];
    if (wanted === undefined) {
      if (actual === undefined || actual === '') continue;
      if (valueInEmployeeText(field, actual, employeeText)) {
        fromEmployee.push(field);
        employeeFields.push(field);
      } else {
        // Значение вносится в документ (render-data берёт все поля реквизитов), поэтому
        // замечание не обещает обратного: сотрудник должен проверить его по первичным документам.
        unconfirmed.push(field);
        issues.push({
          code: 'requisite_not_in_base',
          severity: 'warning',
          message:
            `Значение реквизита «${label}» внесено со слов сотрудника, в базе не подтверждено: ` +
            'нет ни в карточке поставщика, ни в ваших сообщениях. Сверьте с первичными ' +
            'документами.',
        });
      }
      continue;
    }
    if (actual === undefined || actual === '') {
      issues.push({
        code: 'requisite_absent_in_document',
        severity: 'warning',
        message: `В документе нет реквизита «${label}», в базе он есть.`,
      });
    } else if (actual !== wanted) {
      if (valueInEmployeeText(field, actual, employeeText)) {
        fromEmployee.push(field);
        employeeFields.push(field);
        if (canonicalFieldValue(field, actual) !== canonicalFieldValue(field, wanted)) {
          divergent.push(field);
        }
      } else {
        // Значение вносится в документ (render-data берёт все поля реквизитов), поэтому
        // замечание не обещает обратного. Значение карточки называем: без него проверяющий не
        // увидит, с чем расходится внесённое. Значения сотрудника в замечании по-прежнему нет.
        mismatched.push({ field, cardValue: wanted });
        issues.push({
          code: 'requisite_mismatch',
          severity: 'warning',
          message:
            `Значение реквизита «${label}» ${MISMATCH_NOTE} (в карточке: ${wanted}). ` +
            'В ваших сообщениях этого значения нет. Сверьте с первичными документами.',
        });
      }
    }
  }
  issues.push(...employeeFormatIssues(doc, supplier, employeeFields));
  const known: ReadonlySet<string> = new Set(REQUISITE_FIELDS);
  for (const [field, value] of Object.entries(doc.requisites ?? {})) {
    if (!known.has(field) && value.trim() !== '') {
      issues.push({
        code: 'requisite_not_in_base',
        severity: 'warning',
        message:
          `Поле реквизитов «${field.slice(0, REQUISITE_KEY_ECHO_CHARS)}» не из карточки ` +
          'поставщика и в документ не подставляется.',
      });
    }
  }
  return { issues, employee: { fromEmployee, divergent, unconfirmed, mismatched } };
}

/** Замечания по реквизитам документа (см. `assessDocumentRequisites`). */
export function checkDocumentRequisites(
  doc: DealDocument,
  supplier: Supplier,
  employeeText = '',
): ValidationIssue[] {
  return assessDocumentRequisites(doc, supplier, employeeText).issues;
}

/**
 * Документ против сохранённого КП поставщика: валюта, позиции, цены, количества, итог, условия
 * оплаты и срок поставки. Любое расхождение — замечание: сверяет код, а не агент. Все они
 * предупреждения: сотрудник мог договориться с поставщиком иначе, чем в КП, поэтому документ
 * выдаётся, а расхождение («в документе 120, в КП 100») попадает в чек-лист.
 */
export function checkDocumentAgainstQuote(
  doc: DealDocument,
  quote: SupplierQuote,
  now?: Date,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (doc.currency !== quote.currency) {
    issues.push({
      code: 'currency_differs_from_quote',
      severity: 'warning',
      message: `Валюта документа ${doc.currency}, в КП ${quote.currency}.`,
    });
  }
  if (quote.gaps.some((gap) => gap.code === 'no_price')) {
    issues.push({
      code: 'quote_incomplete',
      severity: 'warning',
      message: 'В КП нет цены по некоторым позициям: уточните цены у поставщика до подписания.',
    });
  }
  if (
    now !== undefined &&
    quote.validUntil !== undefined &&
    // Дата без времени - конец суток по МСК (D-14); нечитаемое значение считается истёкшим.
    (parseIsoDeadline(quote.validUntil) ?? Number.NEGATIVE_INFINITY) < now.getTime()
  ) {
    issues.push({
      code: 'quote_expired',
      severity: 'warning',
      message: `КП действовало до ${quote.validUntil}: уточните условия у менеджера.`,
    });
  }
  const quoteLines = quote.lines.filter((line) => line.isReplacement !== true);
  // Названия нормализуются один раз; первая строка с таким названием - как у `find`.
  const quoteByName = new Map<string, QuoteLine>();
  for (const candidate of quoteLines) {
    const name = normalizeItemName(candidate.productName);
    if (!quoteByName.has(name)) quoteByName.set(name, candidate);
  }
  const docLineByName = new Map<string, DealDocument['lines'][number]>();
  for (const docLine of doc.lines) {
    const name = normalizeItemName(docLine.name);
    if (!docLineByName.has(name)) docLineByName.set(name, docLine);
  }
  for (const line of doc.lines) {
    const match = quoteByName.get(normalizeItemName(line.name));
    if (match === undefined) {
      issues.push(
        warningIssue('line_not_in_quote', `«${line.name}» нет в КП поставщика.`),
      );
      continue;
    }
    if (match.unitPrice === undefined || !sameMoney(match.unitPrice, line.unitPrice)) {
      issues.push({
        code: 'price_differs_from_quote',
        severity: 'warning',
        message:
          `«${line.name}»: цена в документе ${line.unitPrice}, ` +
          `в КП ${match.unitPrice ?? 'не указана'}.`,
      });
    }
    if (match.quantity !== undefined && match.quantity !== line.quantity) {
      issues.push({
        code: 'quantity_differs_from_quote',
        severity: 'warning',
        message: `«${line.name}»: количество в документе ${line.quantity}, в КП ${match.quantity}.`,
      });
    }
    // Единица: цена за упаковку и за штуку несопоставимы, пересчёта нет (R3-ALG-8).
    if (match.unit !== undefined) {
      if (line.unit === undefined) {
        issues.push({
          code: 'unit_missing_in_document',
          severity: 'warning',
          message: `«${line.name}»: в КП единица «${match.unit}», в документе единица не указана.`,
        });
      } else if (!sameUnit(line.unit, match.unit)) {
        issues.push({
          code: 'unit_differs_from_quote',
          severity: 'warning',
          message: `«${line.name}»: единица в документе «${line.unit}», в КП «${match.unit}».`,
        });
      }
    }
    // Срок по строке: свой срок строки КП важнее общего срока КП (как в сравнении КП).
    const wantedDays = match.deliveryDays ?? quote.deliveryDays;
    const actualDays = line.deliveryDays ?? doc.deliveryDays;
    if (match.deliveryDays !== undefined && actualDays !== wantedDays) {
      issues.push({
        code: 'delivery_differs_from_quote',
        severity: 'warning',
        message:
          `«${line.name}»: срок поставки в документе ${actualDays ?? 'не указан'}, ` +
          `в КП ${wantedDays} дн.`,
      });
    }
  }
  for (const line of quoteLines) {
    if (line.unitPrice !== undefined && !docLineByName.has(normalizeItemName(line.productName))) {
      issues.push({
        code: 'quote_line_missing',
        severity: 'warning',
        message: `Позиция «${line.productName}» из КП не попала в документ.`,
      });
    }
  }
  const expectedTotal = quoteTotal(
    quote,
    (name) => docLineByName.get(normalizeItemName(name))?.quantity,
  );
  if (!sameMoney(expectedTotal, doc.total)) {
    issues.push({
      code: 'total_differs_from_quote',
      severity: 'warning',
      message: `Сумма в документе ${doc.total}, по КП ${expectedTotal}.`,
    });
  }
  if (
    quote.paymentTerms === undefined
      ? doc.paymentTerms !== undefined
      : !sameText(doc.paymentTerms ?? '', quote.paymentTerms)
  ) {
    issues.push({
      code: 'payment_terms_differ_from_quote',
      severity: 'warning',
      message:
        `Условия оплаты в документе («${doc.paymentTerms ?? 'нет'}») ` +
        `не совпадают с КП («${quote.paymentTerms ?? 'нет'}»).`,
    });
  }
  if (quote.deliveryDays !== undefined && doc.deliveryDays !== quote.deliveryDays) {
    issues.push({
      code: 'delivery_differs_from_quote',
      severity: 'warning',
      message:
        `Срок поставки в документе ${doc.deliveryDays ?? 'не указан'}, ` +
        `в КП ${quote.deliveryDays} дн.`,
    });
  }
  return issues;
}

/** Сколько знаков чужого ключа реквизитов повторяем в замечании. */
const REQUISITE_KEY_ECHO_CHARS = 40;

/** Тема чек-листа проверки перед подписанием. */
export type ChecklistTopic = 'requisites' | 'amounts' | 'terms' | 'payment' | 'warnings';

/** Пункт чек-листа: что проверить, значение из документа и источник значения. */
export interface ChecklistItem {
  topic: ChecklistTopic;
  label: string;
  value: string;
  source: string;
}

/** Источник пункта-предупреждения: его находит код, а не сотрудник и не модель. */
const SOURCE_CODE_CHECK = 'проверка кода; сверьте до подписания';

/** Пункты чек-листа из предупреждений проверок (расхождения с КП, карточкой, пропуски). */
export function warningChecklistItems(issues: readonly ValidationIssue[]): ChecklistItem[] {
  return issues
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => ({
      topic: 'warnings' as const,
      label: 'Предупреждение',
      value: issue.message,
      source: SOURCE_CODE_CHECK,
    }));
}

/** Источники значений в чек-листе. */
const SOURCE_SUPPLIER_CARD = 'карточка поставщика в базе';
const SOURCE_QUOTE = 'КП поставщика';

/** Пометка чек-листа, когда выбранного КП нет и суммы сверить не с чем. */
const NO_QUOTE_CHECK_NOTE = 'с КП не сверялось';

/** Подтверждение веб-полей, как его знает код (состояние кнопки), а не документ. */
export interface ChecklistWebOptions {
  /** Поля из интернета (отмеченные моделью и опознанные кодом); пусто - как по отметкам. */
  webPaths?: ReadonlySet<string>;
  /** Сотрудник подтвердил эти поля кнопкой. */
  confirmed?: boolean;
}

/** Путь или его родитель входит в набор. */
function coveredBy(set: ReadonlySet<string>, path: string): boolean {
  let current = path;
  for (;;) {
    if (set.has(current)) return true;
    const cut = current.lastIndexOf('.');
    if (cut < 0) return false;
    current = current.slice(0, cut);
  }
}

/** Источник пункта: отметка документа важнее значения по умолчанию (карточка или КП). */
function sourceLabel(
  doc: DealDocument,
  path: string,
  fallback: string,
  web: ChecklistWebOptions,
): string {
  const source = fieldSourceOf(doc, path);
  const isWeb = source === 'web' || (web.webPaths !== undefined && coveredBy(web.webPaths, path));
  if (isWeb) {
    // «Подтверждено» только по состоянию кнопки: отметка модели его не даёт.
    const mark = web.confirmed === true ? 'подтверждено сотрудником' : 'не подтверждено';
    return `${FIELD_SOURCE_LABELS.web}; ${mark}`;
  }
  if (source === undefined || source === 'knowledge') return fallback;
  return FIELD_SOURCE_LABELS[source];
}

/** Чек-лист «что проверить перед подписанием»: значения документа и источник каждого. */
export function buildReviewChecklist(
  doc: DealDocument,
  // Поставщика из базы может не быть: договор выдаётся и без него (реквизиты из документа).
  supplier: Supplier | null,
  quote: SupplierQuote | null,
  web: ChecklistWebOptions = {},
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const requisites: Record<string, string> =
    supplier === null ? {} : supplierRequisitesRecord(supplier);
  // Без карточки значения в документе - со слов сотрудника, а не из базы.
  const cardSource = supplier === null ? FIELD_SOURCE_LABELS.employee : SOURCE_SUPPLIER_CARD;
  items.push({
    topic: 'requisites',
    label: 'Поставщик',
    value: doc.seller,
    source: sourceLabel(doc, 'seller', cardSource, web),
  });
  for (const field of REQUISITE_FIELDS) {
    const value = doc.requisites?.[field] ?? requisites[field];
    if (value !== undefined) {
      items.push({
        topic: 'requisites',
        label: REQUISITE_LABELS[field],
        value,
        source: sourceLabel(doc, `requisites.${field}`, cardSource, web),
      });
    }
  }
  const quoted = quote !== null;
  if (!quoted) {
    items.push({
      topic: 'amounts',
      label: 'Сверка с КП',
      value: NO_QUOTE_CHECK_NOTE,
      source: FIELD_SOURCE_LABELS.employee,
    });
  }
  const base = quoted ? SOURCE_QUOTE : FIELD_SOURCE_LABELS.employee;
  doc.lines.forEach((line, index) => {
    items.push({
      topic: 'amounts',
      label: line.name,
      value: `${line.quantity} × ${line.unitPrice} ${doc.currency}`,
      source: sourceLabel(doc, `lines.${index}.unitPrice`, base, web),
    });
  });
  items.push({
    topic: 'amounts',
    label: 'Итого',
    value: `${doc.total} ${doc.currency}`,
    source: sourceLabel(doc, 'total', base, web),
  });
  items.push({
    topic: 'terms',
    label: 'Срок поставки',
    value: doc.deliveryDays === undefined ? 'не указан' : `${doc.deliveryDays} дн.`,
    source: sourceLabel(doc, 'deliveryDays', base, web),
  });
  if (quote !== null) {
    items.push({
      topic: 'terms',
      label: 'КП действует до',
      value: quote.validUntil ?? 'не указано',
      source: SOURCE_QUOTE,
    });
  }
  items.push({
    topic: 'payment',
    label: 'Условия оплаты',
    value: doc.paymentTerms ?? 'не указаны',
    source: sourceLabel(doc, 'paymentTerms', base, web),
  });
  return items;
}
