import { DomainError, employeeOfThread } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import { loadWorkOwner, resolveDelegationInitiator } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import type { OrderCalcDeps } from './deps';
import { loadSent } from './state';

/** Текст отказа без ПДн: ни имён, ни id чужого сотрудника. */
export const ORDER_NOT_YOURS_MESSAGE =
  'Заявку ведёт другой сотрудник: изменить её из вашего чата нельзя. Ничего не изменено.';

/** Поля контекста, по которым определяется вызывающий. */
export type OrderCallerContext = Pick<ToolContext, 'initiator' | 'threadId'>;

/** Тот же сотрудник: совпал сам тред либо сотрудник тредов связки «сотрудник + бот». */
function sameEmployee(ownerThread: string, userId: string, threadId: string): boolean {
  if (ownerThread === threadId) return true;
  const ownerUser = employeeOfThread(ownerThread);
  return ownerUser !== null && (ownerUser === userId || ownerUser === employeeOfThread(threadId));
}

/**
 * Владелец заявки: сотрудник, чей ящик записан в отправке (`SentRecord.mailboxOwnerId`), и/или
 * тред, где он начал работу по заявке (`workSubject.order`). Изменять заявку по идентификатору
 * может только он. Ход без человека (плановый запуск, неопределённый инициатор) проходит.
 * Заявка без владельца никого не ограничивает: её ещё никто не вёл.
 * @throws DomainError('access_denied') если заявку ведёт другой сотрудник.
 */
export async function assertOrderOwner(
  deps: OrderCalcDeps,
  requestId: string,
  context: OrderCallerContext,
): Promise<void> {
  const caller = resolveDelegationInitiator(context.initiator);
  // Нет человека (плановый запуск) или он не определён: сравнивать не с кем. Записи по решению
  // сотрудника (closeOrder, recordSupplierReply) такой ход и так не пускает охраной хода чата.
  if (caller.kind === 'unknown' || caller.userId === undefined) return;
  const { userId } = caller;
  const sent = await loadSent(deps, requestId);
  const mailboxOwner = sent?.mailboxOwnerId;
  if (mailboxOwner !== undefined && mailboxOwner !== userId) {
    throw new DomainError('access_denied', ORDER_NOT_YOURS_MESSAGE);
  }
  const owner = await loadWorkOwner(deps.state, workSubject.order(requestId));
  if (owner !== null && !sameEmployee(owner, userId, context.threadId)) {
    throw new DomainError('access_denied', ORDER_NOT_YOURS_MESSAGE);
  }
}
