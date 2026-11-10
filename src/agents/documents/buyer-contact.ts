import { isDomainError } from '@business-ai/core';
import { type DealDocument } from '../../kit/domain/models';
import type { TurnInitiator } from '@business-ai/core';
import { resolveBuyerContact } from '../../kit/application/deal-manager';
import type { DocumentsDeps } from './deps';

/** Откуда взят контакт «От Заказчика». */
export type BuyerContactSource = 'deal_manager' | 'requester';

/** Поля контакта «От Заказчика» в метках шаблона. */
const NAME_LABEL = 'buyer_contact_name';
const PHONE_LABEL = 'buyer_contact_phone';
const EMAIL_LABEL = 'buyer_contact_email';

/**
 * Найденный контакт «От Заказчика»: персональные данные, только для параметров сборки.
 * `values` - найденные поля по меткам шаблона; `source` - откуда они (для чек-листа).
 */
export interface FoundBuyerContact {
  values: Readonly<Record<string, string>>;
  source: BuyerContactSource;
}

/**
 * Ссылка на сделку документа. requestId задаёт модель, поэтому при настроенном хранилище
 * заявок берётся `dealRef` только существующей заявки; неизвестная заявка - ничего не
 * подставляем (контакт спросят у сотрудника). Без хранилища заявок (в проде оно задано
 * вместе с `dealManagers`, см. compose-production) id заявки служит ссылкой на сделку:
 * это режим тестов и урезанных сборок, где перевести id нечем. Документ без заявки сделки
 * не имеет.
 */
async function dealRefOf(doc: DealDocument, deps: DocumentsDeps): Promise<string | undefined> {
  const requestId = doc.requestId;
  if (requestId === undefined || requestId === '') return undefined;
  if (deps.requests === undefined) return requestId;
  return (await deps.requests.get(requestId))?.dealRef;
}

/** Только найденные (не пустые) поля контакта по меткам шаблона. */
function labelled(contact: {
  name: string | null;
  phone: string | null;
  email: string | null;
}): Record<string, string> {
  return {
    ...(contact.name === null ? {} : { [NAME_LABEL]: contact.name }),
    ...(contact.phone === null ? {} : { [PHONE_LABEL]: contact.phone }),
    ...(contact.email === null ? {} : { [EMAIL_LABEL]: contact.email }),
  };
}

/**
 * Автор запроса (запасной путь, когда менеджера сделки нет): профиль сотрудника портала по id
 * из контекста хода. Плановые и системные ходы сотрудника не имеют - запасного пути нет. Сбой
 * портала не обрывает сборку: контакт, как раньше, спросят у сотрудника.
 */
async function requesterContact(
  deps: DocumentsDeps,
  initiator: TurnInitiator | undefined,
): Promise<Record<string, string>> {
  if (deps.dealManagers === undefined || initiator?.kind !== 'user') return {};
  try {
    const user = await deps.dealManagers.findUser(initiator.userId);
    return user === null ? {} : labelled(user);
  } catch (error) {
    if (isDomainError(error) && error.code === 'external_failure') return {};
    throw error;
  }
}

/**
 * Контакт «От Заказчика»: сначала менеджер сделки по заявке, затем автор запроса, иначе ничего
 * (вопрос сотруднику). Контакт берётся от одного человека целиком: недостающее поле менеджера
 * не добирается из профиля другого. Значения нигде не логируются и в результат инструментов не
 * попадают. Без `dealManagers` или не для договора - ничего.
 */
export async function findBuyerContact(
  doc: DealDocument,
  deps: DocumentsDeps,
  initiator?: TurnInitiator,
): Promise<FoundBuyerContact | undefined> {
  if (deps.dealManagers === undefined || doc.kind !== 'contract') return undefined;
  const dealRef = await dealRefOf(doc, deps);
  if (dealRef !== undefined) {
    const manager = labelled(await resolveBuyerContact({ dealManagers: deps.dealManagers }, dealRef));
    if (Object.keys(manager).length > 0) return { values: manager, source: 'deal_manager' };
  }
  const requester = await requesterContact(deps, initiator);
  return Object.keys(requester).length === 0
    ? undefined
    : { values: requester, source: 'requester' };
}
