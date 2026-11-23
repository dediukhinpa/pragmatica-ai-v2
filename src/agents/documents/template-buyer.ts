import type { DealDocument } from '../../kit/domain/models';
import type { DocumentsDeps } from './deps';
import { contractTemplateByPath, templateBuyerName } from './template-registry';

/**
 * Документ по шаблону договора или NDA с покупателем, которого задаёт сам шаблон: юрлицо
 * вписано в текст шаблона, и модели незачем угадывать точное написание (она подбирала
 * кавычки и формы и упиралась в «покупатель - не наше юрлицо»). Шаблон не из реестра или
 * юрлицо не найдено в `OWN_COMPANY_NAMES` - документ как был.
 */
export function withTemplateBuyer(
  doc: DealDocument,
  deps: DocumentsDeps,
  templatePath: string | undefined,
): DealDocument {
  if (templatePath === undefined) return doc;
  const template = contractTemplateByPath(templatePath, deps.templatesPrefix ?? '');
  const buyer =
    template === undefined ? undefined : templateBuyerName(template, deps.ownCompanyNames);
  if (buyer === undefined || buyer === doc.buyer) return doc;
  return {
    ...doc,
    buyer,
    fieldSources: { ...doc.fieldSources, buyer: 'knowledge' },
  };
}
