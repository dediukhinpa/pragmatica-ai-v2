import { z } from 'zod';
import { DOCUMENT_KINDS } from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { enrichSourcesFingerprint, runDocumentEnrich } from '../suppliers/document-enrich';
import {
  MAX_SOURCE_TEXT_LENGTH,
  enrichCardAnswer,
  enrichCardInputSchema,
  enrichCardOutputSchema,
  ENRICH_STATUSES,
} from '../suppliers/enrich-card-tool';
import type { DocumentsDeps } from './deps';
import { disabledKindMessage } from './enabled-kinds';
import { readEmployeeText } from './employee-messages';
import { preparedContractSuppliers } from './prepared-contract';

/**
 * Дополнение карточки поставщика данными договора (этап 219). Ограничено кодом, а не
 * словами модели:
 * - договор определяется записью о сборке (`prepareSupplierDocument` с `kind=contract` по этому
 *   поставщику в этом треде), а не полем `documentKind`, которое модель может назвать как угодно;
 * - принимаются только поля, которые договор даёт поставщику: реквизиты, адрес, сайт, контакты,
 *   условия, примечания, юрлица. Прочие поля карточки в схеме инструмента отсутствуют;
 * - источник, фильтр значений нашей компании и проверка свободных полей - общий
 *   `runDocumentEnrich` (`suppliers/document-enrich.ts`).
 */

/** Вид документа, по которому карточку разрешено дополнять. */
const ENRICH_KIND = 'contract';

/** Ответ-отказ: дополнение не по собранному договору этого поставщика. */
const NOT_CONTRACT_STATUS = 'not_contract' as const;

const NOT_CONTRACT_TEXT =
  'Карточку поставщика из документа дополняют только по договору (documentKind=contract); ' +
  'для этого документа ничего не записано. Продолжайте работу.';
const NOT_PREPARED_TEXT =
  'В этом чате не собран договор с этим поставщиком (prepareSupplierDocument, kind=contract, ' +
  'тот же supplierId): ничего не записано. Соберите договор и повторите вызов после него.';

/** Поля, которые может дать договор; остальное в схему инструмента не входит. */
const CONTRACT_FIELDS = {
  supplierId: true,
  origin: true,
  sourceLabel: true,
  sourceText: true,
  inn: true,
  kpp: true,
  ogrn: true,
  legalAddress: true,
  directorName: true,
  website: true,
  contacts: true,
  terms: true,
  paymentNotes: true,
  contractNotes: true,
  legalEntities: true,
} as const;

const inputSchema = enrichCardInputSchema.pick(CONTRACT_FIELDS).extend({
  /** Вид документа, из которого берутся сведения: принимается только contract. */
  documentKind: z.enum(DOCUMENT_KINDS),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = enrichCardOutputSchema.extend({
  status: z.enum([...ENRICH_STATUSES, NOT_CONTRACT_STATUS]),
});
type Output = z.infer<typeof outputSchema>;

/** Хвост текста: у сообщений сотрудника самое свежее в конце. */
function tail(text: string): string {
  return text.length <= MAX_SOURCE_TEXT_LENGTH ? text : text.slice(-MAX_SOURCE_TEXT_LENGTH);
}

/** Карточка, которую можно дополнять: из входа или единственный поставщик собранного договора. */
function targetSupplier(input: Input, prepared: readonly string[]): string | undefined {
  if (input.supplierId !== undefined) {
    return prepared.includes(input.supplierId) ? input.supplierId : undefined;
  }
  return prepared.length === 1 ? prepared[0] : undefined;
}

/** Дополнить карточку поставщика сведениями из договора (только договор, только поставщик). */
export const enrichSupplierCardFromContract = defineTool<Input, Output, DocumentsDeps>({
  name: 'enrichSupplierCard',
  description:
    'Дополнить карточку поставщика из базы сведениями из договора, который ты собрал в этом ' +
    'чате (после prepareSupplierDocument с kind=contract по этому поставщику; иначе вернётся ' +
    'not_contract). Передайте documentKind=contract, supplierId из базы и ТОЛЬКО значения ' +
    'самого поставщика (сторона «Поставщик»/«Продавец»): реквизиты, юридический адрес, сайт, ' +
    'контакты, условия оплаты и поставки, примечания, юрлица. Реквизиты нашей компании и ' +
    'покупателя не передавайте - код их отбросит. sourceText - фрагмент присланного ' +
    'договора дословно из того, что вернул readChatAttachments (страница сайта и пересказ не ' +
    'принимаются); слова сотрудника код берёт из его сообщений в этом чате сам. Условия и ' +
    'примечания передавайте дословной цитатой: пересказ отклоняется. Код пишет только пустые ' +
    'поля и добавляет заметку «Дополнено из документа»; заполненные поля не меняются, ' +
    'расхождения с карточкой возвращаются в conflicts и не записываются. Новых карточек ' +
    'инструмент не заводит. Не выдумывайте значения.',
  sideEffect: true,
  // Другая формулировка полей на повторе даёт вторую заметку: повтор оборванного хода - по кнопке.
  replay: 'confirm',
  inputSchema,
  outputSchema,
  idempotencyKey: (input) => `suppliers-enrich:${stableHash(input)}`,
  // Отказ до сборки договора не должен закешироваться: ключ учитывает записи, от которых зависит
  // решение (собранные договоры, прочитанные файлы, слова сотрудника).
  async idempotencyPredecessor(_input, deps, threadId) {
    const prepared = await preparedContractSuppliers(deps.state, threadId);
    const employeeText = tail(await readEmployeeText(deps.state, threadId));
    return enrichSourcesFingerprint(deps, threadId, [prepared.join(','), employeeText]);
  },
  async execute({ documentKind, ...fields }, deps, context) {
    const disabled = disabledKindMessage(deps, ENRICH_KIND);
    if (documentKind !== ENRICH_KIND || disabled !== undefined) {
      return {
        ...enrichCardAnswer('failed', ''),
        status: NOT_CONTRACT_STATUS,
        message: disabled ?? NOT_CONTRACT_TEXT,
      };
    }
    const prepared = await preparedContractSuppliers(deps.state, context.threadId);
    const supplierId = targetSupplier({ documentKind, ...fields }, prepared);
    if (supplierId === undefined) {
      return {
        ...enrichCardAnswer('failed', ''),
        status: NOT_CONTRACT_STATUS,
        message: NOT_PREPARED_TEXT,
      };
    }
    // Слова сотрудника - из сохранённых сообщений треда, не из пересказа модели.
    const employeeText = tail(await readEmployeeText(deps.state, context.threadId));
    return runDocumentEnrich({ ...fields, supplierId }, deps, context, employeeText);
  },
});
