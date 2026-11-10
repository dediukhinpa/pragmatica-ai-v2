import { fieldSourceOf } from '../../kit/domain/document-sources';
import { type DealDocument, type FieldSource } from '../../kit/domain/models';
import type { DocumentsDeps } from './deps';

/** Метка шаблона: должность и ФИО подписанта поставщика в родительном падеже. */
export const SIGNATORY_LABEL = 'seller_representative';
const POSITION_LABEL = 'seller_position';
const DIRECTOR_PATH = 'requisites.directorName';
const POSITION_PATH = `templateFields.${POSITION_LABEL}`;
const SIGNATORY_PATH = `templateFields.${SIGNATORY_LABEL}`;

/** Источник составленного значения - самый слабый из исходных: веб, затем сотрудник. */
function weakestSource(a: FieldSource, b: FieldSource): FieldSource {
  if (a === 'web' || b === 'web') return 'web';
  return a === 'employee' || b === 'employee' ? 'employee' : 'knowledge';
}

/**
 * Документ с `seller_representative`, составленным кодом по ФИО руководителя
 * (`requisites.directorName`) и должности (`seller_position`). Склоняет сервис на РФ: модель
 * видит ФИО токеном, и её пример с токеном выходил в именительном падеже. Значение сотрудника
 * не перекрывается; без исходных полей, их источника или уверенного разбора документ остаётся
 * как был - тогда вопрос задают сотруднику.
 */
export async function withSignatory(doc: DealDocument, deps: DocumentsDeps): Promise<DealDocument> {
  const inflector = deps.signatoryInflector;
  const fields = doc.templateFields ?? {};
  const director = doc.requisites?.['directorName']?.trim() ?? '';
  const position = fields[POSITION_LABEL]?.trim() ?? '';
  if (inflector === undefined || (fields[SIGNATORY_LABEL] ?? '').trim() !== '') return doc;
  if (director === '' || position === '') return doc;
  const directorSource = fieldSourceOf(doc, DIRECTOR_PATH);
  const positionSource = fieldSourceOf(doc, POSITION_PATH);
  if (directorSource === undefined || positionSource === undefined) return doc;
  let text: string | null;
  try {
    text = await inflector.signatoryGenitive(position, director);
  } catch {
    // Сбой сервиса не обрывает сборку: подписанта, как и раньше, назовёт сотрудник.
    return doc;
  }
  if (text === null) return doc;
  return {
    ...doc,
    templateFields: { ...fields, [SIGNATORY_LABEL]: text },
    fieldSources: {
      ...doc.fieldSources,
      [SIGNATORY_PATH]: weakestSource(directorSource, positionSource),
    },
  };
}
