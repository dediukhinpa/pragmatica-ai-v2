import type { ChecklistItem } from '../../kit/domain/supplier-document';
import type { DealDocument } from '../../kit/domain/models';
import { parseDocumentDate } from './render-data';
import { templateHasLabel } from './template-fields';
import type { ContractTemplate } from './template-registry';

/** Пометка источника в чек-листе: сотрудник значение не называл, его подставила система. */
export const SYSTEM_DEFAULT_SOURCE =
  'подставлено системой по умолчанию (сотрудник не называл); проверьте, что это верно';

/** Номер спецификации и технического задания по умолчанию: первое приложение к договору. */
const DEFAULT_ATTACHMENT_NUMBER = '1';
/** Месяцев в году: гарантия «1 год» = 12 месяцев. */
const MONTHS_IN_YEAR = 12;
/** Остатки от деления на 10 и 100 для склонения «месяц / месяца / месяцев». */
const DECIMAL = 10;
const HUNDRED = 100;
const TEENS_FROM = 11;
const TEENS_TO = 14;
const FEW_MAX = 4;
/** «12», «12 мес.», «12 месяцев», «1 год», «2 года», «5 лет». */
const MONTHS_TEXT = /^(\d{1,3})\s*(мес\S*)?$/iu;
const YEARS_TEXT = /^(\d{1,2})\s*(?:год\S*|лет)$/iu;

/** Результат подстановки значений по умолчанию: документ и пункты для чек-листа. */
export interface DefaultsResult {
  document: DealDocument;
  notes: ChecklistItem[];
}

/** Поле `templateFields` не заполнено сотрудником. */
function isBlank(fields: Readonly<Record<string, string>>, label: string): boolean {
  return (fields[label] ?? '').trim() === '';
}

/** Склонение «N месяц / месяца / месяцев». */
export function monthsPhrase(count: number): string {
  const lastTwo = count % HUNDRED;
  const last = count % DECIMAL;
  if (lastTwo >= TEENS_FROM && lastTwo <= TEENS_TO) return `${count} месяцев`;
  if (last === 1) return `${count} месяц`;
  return last >= 2 && last <= FEW_MAX ? `${count} месяца` : `${count} месяцев`;
}

/** Число месяцев из текста гарантии («12», «12 мес.», «1 год»); не разобрать - undefined. */
export function parseWarrantyMonths(raw: string): number | undefined {
  const text = raw.trim();
  const months = MONTHS_TEXT.exec(text)?.[1];
  const years = YEARS_TEXT.exec(text)?.[1];
  const value =
    months !== undefined
      ? Number(months)
      : years !== undefined
        ? Number(years) * MONTHS_IN_YEAR
        : undefined;
  return value !== undefined && value > 0 ? value : undefined;
}

/** Документ с добавленными полями шаблона и отметкой их источника. */
function withDefaults(doc: DealDocument, added: Readonly<Record<string, string>>): DealDocument {
  if (Object.keys(added).length === 0) return doc;
  const marks = Object.fromEntries(
    Object.keys(added).map((label) => [`templateFields.${label}`, 'knowledge' as const]),
  );
  return {
    ...doc,
    templateFields: { ...doc.templateFields, ...added },
    fieldSources: { ...doc.fieldSources, ...marks },
  };
}

/**
 * Спецификация и ТЗ к договору: номер 1 и дата договора, если сотрудник их не назвал. Сотрудник
 * всегда может назвать другие (его значение в `templateFields` главнее). Дата договора
 * нераспознана - дату спецификации не подставляем: её спросят вместе с датой договора.
 */
function attachmentDefaults(doc: DealDocument): DefaultsResult {
  const fields = doc.templateFields ?? {};
  const added: Record<string, string> = {};
  if (isBlank(fields, 'spec_number')) added['spec_number'] = DEFAULT_ATTACHMENT_NUMBER;
  if (isBlank(fields, 'tz_number')) added['tz_number'] = DEFAULT_ATTACHMENT_NUMBER;
  if (isBlank(fields, 'spec_date') && parseDocumentDate(doc.issuedAt) !== undefined) {
    added['spec_date'] = doc.issuedAt;
  }
  const notes: ChecklistItem[] = [];
  if (added['spec_number'] !== undefined || added['spec_date'] !== undefined) {
    notes.push({
      topic: 'terms',
      label: 'Спецификация (Приложение № 1): номер и дата',
      value: `№ ${added['spec_number'] ?? fields['spec_number'] ?? ''}, дата договора`,
      source: SYSTEM_DEFAULT_SOURCE,
    });
  }
  if (added['tz_number'] !== undefined) {
    notes.push({
      topic: 'terms',
      label: 'Техническое задание (Приложение № 2): номер',
      value: `№ ${added['tz_number']}`,
      source: SYSTEM_DEFAULT_SOURCE,
    });
  }
  return { document: withDefaults(doc, added), notes };
}

/**
 * Гарантия одним значением: `warranty_months` и `warranty_period` описывают один срок. Одно из
 * них код выводит из другого. Неразбираемое значение не трогаем: спросят то, чего не хватает.
 * Только шаблоны, где есть оба поля (`hasMonths`); у остальных `warranty_period` как был.
 */
function warrantyDefaults(doc: DealDocument, hasMonths: boolean): DefaultsResult {
  const fields = doc.templateFields ?? {};
  const added: Record<string, string> = {};
  const months = fields['warranty_months'] ?? '';
  const period = fields['warranty_period'] ?? '';
  if (hasMonths && period.trim() === '' && months.trim() !== '') {
    const count = parseWarrantyMonths(months);
    if (count !== undefined) added['warranty_period'] = monthsPhrase(count);
  } else if (hasMonths && months.trim() === '' && period.trim() !== '') {
    const count = parseWarrantyMonths(period);
    if (count !== undefined) added['warranty_months'] = String(count);
  }
  const derived = Object.values(added)[0];
  const notes: ChecklistItem[] =
    derived === undefined
      ? []
      : [
          {
            topic: 'terms',
            label: 'Гарантийный срок (договор и спецификация)',
            value: derived,
            source: 'выведено системой из названного срока гарантии',
          },
        ];
  return { document: withDefaults(doc, added), notes };
}

/**
 * Значения договора, которые код подставляет сам: № и дата спецификации, № ТЗ, согласованная
 * гарантия. Только для четырёх договоров на поставку; NDA и прочие шаблоны - без изменений.
 */
export function withContractDefaults(
  doc: DealDocument,
  template?: ContractTemplate,
): DefaultsResult {
  if (doc.kind !== 'contract' || template === undefined || template.variant === 'nda') {
    return { document: doc, notes: [] };
  }
  const attachments = attachmentDefaults(doc);
  const warranty = warrantyDefaults(
    attachments.document,
    templateHasLabel(template.id, 'warranty_months'),
  );
  return {
    document: warranty.document,
    notes: [...attachments.notes, ...warranty.notes],
  };
}
