import { beforeEach, describe, expect, test } from 'bun:test';
import { closeOrder, orderStatus } from '../../src/agents/order-calc/order-status';
import { confirmQuoteReplacement } from '../../src/agents/order-calc/confirm-quote-replacement';
import { createToolContext, recordWorkOwner, type ToolContext } from '@business-ai/core';
import { loadReplies } from '../../src/agents/order-calc/reply-store';
import { recordSupplierReply } from '../../src/agents/order-calc/record-supplier-reply';
import { saveSelection, saveSent, loadSelection } from '../../src/agents/order-calc/state';
import { scheduleReminder } from '../../src/agents/order-calc/schedule-reminder';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import { isOrderClosed } from '../../src/agents/order-calc/order-progress';
import { bindingThreadId, isDomainError } from '@business-ai/core';
import { MAIL_OWNER, ORDER_REQUEST, buildOrderDeps, type OrderTestDeps } from './order-support';
import { CREATED_AT } from './support';

const BOT = 'order-bot';
const REQUEST_ID = ORDER_REQUEST.id;
const OWNER_THREAD = bindingThreadId({ botId: BOT, userId: MAIL_OWNER });
const STRANGER = 'u2';
const STRANGER_THREAD = bindingThreadId({ botId: BOT, userId: STRANGER });
const REPLY_INPUT = {
  requestId: REQUEST_ID,
  supplierId: 's1',
  channel: 'phone' as const,
  summary: 'Позвонили, цена 50',
};

/** Ход сотрудника в его треде связки с номером реплики. */
function turn(userId: string, threadId: string, turnNumber = 1): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'test-agent',
    operationId: `op-${userId}-${turnNumber}`,
    initiator: { kind: 'user', userId },
    turnNumber,
  });
}

/** Код ошибки инструмента (null - вызов прошёл). */
async function errorCode(run: Promise<unknown>): Promise<string | null> {
  const caught = await run.then(
    () => null,
    (error: unknown) => error,
  );
  return isDomainError(caught) ? caught.code : null;
}

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps();
  await deps.requests.save(ORDER_REQUEST);
  await saveSelection(deps, { requestId: REQUEST_ID, supplierIds: ['s1'], createdAt: CREATED_AT });
  await saveSent(deps, {
    requestId: REQUEST_ID,
    supplierIds: ['s1'],
    sentAt: CREATED_AT,
    mailboxOwnerId: MAIL_OWNER,
  });
  // Заявку начал сотрудник u1 в своём чате.
  await recordWorkOwner(deps.state, workSubject.order(REQUEST_ID), turn(MAIL_OWNER, OWNER_THREAD));
});

describe('заявка принадлежит тому, кто её ведёт', () => {
  test('recordSupplierReply: чужая заявка - access_denied, БД не меняется', async () => {
    const outboxBefore = deps.chat.outbox.length;
    const code = await errorCode(
      recordSupplierReply.execute(REPLY_INPUT, deps, turn(STRANGER, STRANGER_THREAD)),
    );
    expect(code).toBe('access_denied');
    expect(deps.chat.outbox.length).toBe(outboxBefore);
    expect(await loadReplies(deps.state, REQUEST_ID)).toEqual([]);
  });

  test('recordSupplierReply: владелец записывает ответ как обычно', async () => {
    const owner = turn(MAIL_OWNER, OWNER_THREAD, 1);
    const shown = await recordSupplierReply.execute(REPLY_INPUT, deps, owner);
    expect(shown.status).toBe('needs_confirmation');
    const saved = await recordSupplierReply.execute(
      { ...REPLY_INPUT, confirmed: true },
      deps,
      turn(MAIL_OWNER, OWNER_THREAD, 2),
    );
    expect(saved.status).toBe('recorded');
  });

  test('recordSupplierReply: чужой не подтвердит показ владельца', async () => {
    await recordSupplierReply.execute(REPLY_INPUT, deps, turn(MAIL_OWNER, OWNER_THREAD, 1));
    const code = await errorCode(
      recordSupplierReply.execute(
        { ...REPLY_INPUT, confirmed: true },
        deps,
        turn(STRANGER, STRANGER_THREAD, 2),
      ),
    );
    expect(code).toBe('access_denied');
    expect(await loadReplies(deps.state, REQUEST_ID)).toEqual([]);
  });

  test('closeOrder: чужая заявка - access_denied, заказ остаётся открытым', async () => {
    const outboxBefore = deps.chat.outbox.length;
    const input = { requestId: REQUEST_ID };
    expect(
      await errorCode(closeOrder.execute(input, deps, turn(STRANGER, STRANGER_THREAD, 1))),
    ).toBe('access_denied');
    expect(
      await errorCode(
        closeOrder.execute(
          { ...input, confirmed: true },
          deps,
          turn(STRANGER, STRANGER_THREAD, 2),
        ),
      ),
    ).toBe('access_denied');
    expect(deps.chat.outbox.length).toBe(outboxBefore);
    expect(await isOrderClosed(deps, REQUEST_ID)).toBe(false);
  });

  test('closeOrder: владелец закрывает заказ двумя репликами', async () => {
    const input = { requestId: REQUEST_ID };
    await closeOrder.execute(input, deps, turn(MAIL_OWNER, OWNER_THREAD, 1));
    const closed = await closeOrder.execute(
      { ...input, confirmed: true },
      deps,
      turn(MAIL_OWNER, OWNER_THREAD, 2),
    );
    expect(closed.status).toBe('closed');
    expect(await isOrderClosed(deps, REQUEST_ID)).toBe(true);
  });

  test('confirmQuoteReplacement и scheduleReminder: чужая заявка отклоняется', async () => {
    const stranger = turn(STRANGER, STRANGER_THREAD);
    expect(
      await errorCode(
        confirmQuoteReplacement.execute(
          { requestId: REQUEST_ID, supplierId: 's1' },
          deps,
          stranger,
        ),
      ),
    ).toBe('access_denied');
    const reminder = scheduleReminder;
    expect(
      await errorCode(reminder.execute({ requestId: REQUEST_ID }, deps, stranger)),
    ).toBe('access_denied');
  });

  test('читающий orderStatus чужой заявки не ограничен', async () => {
    const status = await orderStatus.execute(
      { requestId: REQUEST_ID },
      deps,
      turn(STRANGER, STRANGER_THREAD),
    );
    expect(status.requestId).toBe(REQUEST_ID);
    expect(await loadSelection(deps, REQUEST_ID)).not.toBeNull();
  });
});
