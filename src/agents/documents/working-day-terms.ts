import type { DealDocument } from '../../kit/domain/models';
import { termInWorkingDays } from './render-data';
import { TERMS_FROM_CONTRACT_DATE } from './template-fields';

/**
 * Документ, в котором сроки шаблона, считающиеся от даты договора, переведены из даты
 * («до 05.11.2026») в число рабочих дней. Остальные сроки и сроки числом - как были.
 */
export function withWorkingDayTerms(doc: DealDocument, templateId?: string): DealDocument {
  const labels = templateId === undefined ? [] : (TERMS_FROM_CONTRACT_DATE[templateId] ?? []);
  const fields = doc.templateFields;
  if (fields === undefined || labels.length === 0) return doc;
  const converted = { ...fields };
  for (const label of labels) {
    const value = fields[label];
    if (value !== undefined) converted[label] = termInWorkingDays(value, doc.issuedAt);
  }
  return { ...doc, templateFields: converted };
}
