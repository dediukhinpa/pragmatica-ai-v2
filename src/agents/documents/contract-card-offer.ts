import { z } from 'zod';
import { DOCUMENT_KINDS } from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import {
  lookupInputShape,
  lookupOutputSchema,
  lookupSupplierInBase,
  runSupplierLookup,
} from '../suppliers/supplier-lookup';
import type { DocumentsDeps } from './deps';
import { disabledKindMessage } from './enabled-kinds';

/**
 * Поиск поставщика для агента «Подготовка документов» (этап 219). Предложение завести
 * карточку поставщика, которого нет в базе, делается только для договора (NDA тоже
 * `kind=contract`), и только если вид `contract` включён в `DOCUMENTS_ENABLED_KINDS`: по КП,
 * счёту и закрывающим карточку не предлагают.
 *
 * Ограничение держится на модели лишь отчасти. Вид документа в момент поиска код не знает
 * (поиск идёт до сборки), поэтому его называет модель, и назвать `contract` для счёта она
 * технически может; код этого не проверяет. Что делает код: при любом другом виде (и при
 * выключенном `contract`) предложение не регистрируется, ответ - `offer: 'not_offered'`, а
 * `recordSupplierLookupDecision` по такому поиску вернёт `not_asked`, то есть карточка без
 * зарегистрированного вопроса не создаётся. Карточка в любом случае создаётся только после
 * явного «да» сотрудника.
 */

/** Вид документа, для которого предлагают завести карточку. */
const OFFER_KIND = 'contract';

const inputSchema = z.object({
  ...lookupInputShape,
  /** Вид документа, который готовится в этом ходе. */
  documentKind: z.enum(DOCUMENT_KINDS),
});
type Input = z.infer<typeof inputSchema>;

/** Найти поставщика в общей базе; предложение завести карточку - только для договора. */
export const lookupSupplierInBaseForDocuments = defineTool<
  Input,
  z.infer<typeof lookupOutputSchema>,
  DocumentsDeps
>({
  name: lookupSupplierInBase.name,
  description:
    lookupSupplierInBase.description +
    ' documentKind - вид документа, который готовишь (contract - договор или NDA, ' +
    'commercial_offer, invoice, closing). Вопрос о добавлении поставщика возвращается только ' +
    'для договора (documentKind=contract); для других документов предложение не делается ' +
    '(offer=not_offered) - не спрашивай.',
  inputSchema,
  outputSchema: lookupOutputSchema,
  async execute({ documentKind, ...query }, host, context) {
    // Предложение - только для договора и только когда договоры вообще готовятся.
    const offerAllowed =
      documentKind === OFFER_KIND && disabledKindMessage(host, OFFER_KIND) === undefined;
    return runSupplierLookup(query, host, context, offerAllowed);
  },
});
