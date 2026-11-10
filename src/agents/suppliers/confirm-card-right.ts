import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../kit/domain/access.owned';
import { DomainError } from '@business-ai/core';
import type { AccessPolicy } from '@business-ai/core';

/**
 * Итог проверки права записи в общую базу поставщиков (`suppliers.confirm_card`, этап 234):
 * `allowed` - руководитель отдела; `denied` - не руководитель (или права не настроены);
 * `unavailable` - справочник руководителей или сама политика дали сбой, право неизвестно.
 */
export type ConfirmCardVerdict = 'allowed' | 'denied' | 'unavailable';

/** Причина решения политики, означающая сбой справочника, а не отказ сотруднику. */
const DIRECTORY_UNAVAILABLE = 'directory_unavailable';

/** Текст для не-руководителя: карточку в общей базе заводит руководитель отдела. */
export const CONFIRM_CARD_DENIED_TEXT =
  'Завести карточку в общей базе может руководитель отдела: передайте данные ему.';
/** Текст про временный сбой проверки права: это не отказ, повтор после восстановления пройдёт. */
export const CONFIRM_CARD_UNAVAILABLE_TEXT =
  'Не удалось проверить, что сотрудник руководитель отдела: справочник временно недоступен. ' +
  'Это временный сбой, повторите позже.';

/**
 * Ошибка для инструментов, которые отвечают исключением: рантайм ошибки не кэширует, поэтому
 * повтор того же вызова после восстановления справочника пройдёт заново.
 */
export function confirmCardUnavailableError(): DomainError {
  return new DomainError('access_denied', CONFIRM_CARD_UNAVAILABLE_TEXT);
}

/**
 * Проверить право записи в общую базу с различением отказа и сбоя. Сбой не должен выглядеть как
 * «вы не руководитель»: отказ вызывающий код может запомнить, сбой - нет. Нет политики - отказ
 * (запись без неё запрещена). Любое исключение политики - `unavailable`: доступ при этом не
 * открывается.
 */
export async function confirmCardVerdict(
  access: AccessPolicy | undefined,
  request: { userId: string; botId: string },
): Promise<ConfirmCardVerdict> {
  if (access === undefined) return 'denied';
  const full = { ...request, action: ACTION_CONFIRM_SUPPLIER_CARD };
  try {
    if (access.decide === undefined) return (await access.isAllowed(full)) ? 'allowed' : 'denied';
    const decision = await access.decide(full);
    if (decision.allowed) return 'allowed';
    return decision.reason === DIRECTORY_UNAVAILABLE ? 'unavailable' : 'denied';
  } catch {
    return 'unavailable';
  }
}
