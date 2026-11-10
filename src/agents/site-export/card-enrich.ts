import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { enrichSourcesFingerprint, runDocumentEnrich } from '../suppliers/document-enrich';
import { enrichCardInputSchema, enrichCardOutputSchema } from '../suppliers/enrich-card-tool';
import type { SiteExportDeps } from './deps';

/**
 * Дополнение карточки поставщика свежими сведениями из документа для агента «Актуализация
 * сайта» (этап 219). Источник - только текст файлов и фото, которые агент прочитал из чата
 * (`readChatAttachments`): страницы сайтов (`gatherItemData`, веб-поиск) источником не служат,
 * потому что `sourceText` принимается, только если он дословно есть в прочитанных вложениях.
 * Значения нашей компании отбрасываются, свободные поля пишутся только дословно из документа
 * (общий `runDocumentEnrich`). Вызывается после заполнения файла и отчёта менеджеру
 * (`reportToManager`); файл и столбцы выгрузки это не меняет.
 */

/** Поля, которые материал выгрузки даёт о поставщике и его продукции. */
const SITE_FIELDS = {
  supplierId: true,
  origin: true,
  sourceLabel: true,
  sourceText: true,
  website: true,
  contacts: true,
  terms: true,
  categories: true,
  brands: true,
  technologies: true,
  personalizationTypes: true,
} as const;

const inputSchema = enrichCardInputSchema.pick(SITE_FIELDS);
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof enrichCardOutputSchema>;

/** Дополнить карточку поставщика из документа выгрузки (только документ, только поставщик). */
export const enrichSupplierCardFromExportMaterial = defineTool<Input, Output, SiteExportDeps>({
  name: 'enrichSupplierCard',
  description:
    'Дополнить карточку поставщика из базы свежими сведениями из присланного документа (прайс, ' +
    'КП, письмо, файл), которых в карточке нет. Вызывайте ПОСЛЕ заполнения файла и отчёта ' +
    'менеджеру. Передайте supplierId из базы и ТОЛЬКО значения самого поставщика: сайт, ' +
    'контакты, условия оплаты и доставки, категории, бренды, технологии, виды персонализации. ' +
    'sourceText - фрагмент документа дословно из того, что вернул readChatAttachments; сведения ' +
    'со страниц сайтов и из веб-поиска не принимаются. Условия и списки передавайте дословной ' +
    'цитатой: пересказ отклоняется. Реквизиты нашей компании и покупателя не передавайте: код ' +
    'их отбросит. Код пишет только пустые поля и добавляет заметку «Дополнено из документа»; ' +
    'заполненные поля не меняются, расхождения возвращаются в conflicts и не записываются. ' +
    'Новых карточек инструмент не заводит. Не выдумывайте значения.',
  sideEffect: true,
  // Другая формулировка полей на повторе даёт вторую заметку: повтор оборванного хода - по кнопке.
  replay: 'confirm',
  inputSchema,
  outputSchema: enrichCardOutputSchema,
  idempotencyKey: (input) => `suppliers-enrich:${stableHash(input)}`,
  // Ключ учитывает прочитанные файлы: отказ до чтения вложения не должен закешироваться.
  async idempotencyPredecessor(_input, deps, threadId) {
    return enrichSourcesFingerprint(deps, threadId, []);
  },
  async execute(input, deps, context) {
    // У агента нет хранилища слов сотрудника: единственный источник - прочитанные файлы.
    return runDocumentEnrich(input, deps, context, '');
  },
});
