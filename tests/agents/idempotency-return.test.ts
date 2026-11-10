import { beforeEach, describe, expect, test } from 'bun:test';
import { commitPriceImport } from '../../src/agents/prices/commit-price-import';
import { recordQuote } from '../../src/agents/order-calc/record-quote';
import { recordSelection } from '../../src/agents/order-calc/record-selection';
import { remindManager } from '../../src/agents/order-calc/remind-manager';
import { resolveOperationKey, type AnyToolDefinition } from '@business-ai/core';
import { saveSelection, saveSent, loadSent } from '../../src/agents/order-calc/state';
import { scheduleReminder } from '../../src/agents/order-calc/schedule-reminder';
import { storeReply } from '../../src/agents/order-calc/reply-store';
import { CREATED_AT, CTX, SUPPLIER_ID } from './support';
import { MAIL_OWNER, REQUEST_ID, buildOrderDeps, prepareRequestsText } from './order-support';
import { buildFullPricesDeps, skuItem, stageDiskCsv, type FullPricesDeps } from './prices-support';

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', 100, 'B1')], 'seed');
});

const keyOf = (tool: AnyToolDefinition, input: unknown, fallback = '') =>
  resolveOperationKey(tool, input, deps, CTX.threadId, fallback);
const priceNow = async () => (await deps.prices.listBySupplier(SUPPLIER_ID))[0]?.price;

async function commit(price: number): Promise<string> {
  const { fileHash } = await stageDiskCsv(deps, [['Болт', price, 'B1']]);
  const input = { supplierId: SUPPLIER_ID, fileHash };
  const key = await keyOf(commitPriceImport, input);
  await commitPriceImport.execute(input, deps, CTX);
  return key;
}

describe('D-6: возврат A -> B -> A (прайс)', () => {
  test('возврат к прежней цене применяется, ключи различаются', async () => {
    const first = await commit(110);
    await commit(120);
    expect(await priceNow()).toBe(120);
    const third = await commit(110);
    expect(await priceNow()).toBe(110);
    expect(third).not.toBe(first);
  });

  test('настоящий повтор (то же состояние до операции) даёт тот же ключ', async () => {
    const { fileHash } = await stageDiskCsv(deps, [['Болт', 110, 'B1']]);
    const input = { supplierId: SUPPLIER_ID, fileHash };
    expect(await keyOf(commitPriceImport, input)).toBe(await keyOf(commitPriceImport, input));
  });
});

describe('D-6: возврат A -> B -> A (КП и выбор)', () => {
  const quoteArgs = (price: number) => ({
    requestId: REQUEST_ID,
    supplierId: 's1',
    sourceRef: 'out:r1',
    currency: 'RUB',
    lines: [{ productName: 'Арматура', unitPrice: price, quantity: 100 }],
  });

  /** КП принимается только из сохранённого ответа этого поставщика (R3-SEC-2). */
  const seedReply = (order: Awaited<ReturnType<typeof buildOrderDeps>>) =>
    storeReply(order.state, REQUEST_ID, {
      id: 'out:r1',
      channel: 'email',
      supplierId: 's1',
      text: 'КП',
      attachments: [],
    });

  test('КП: возврат к прежней цене даёт новый ключ, повтор - прежний', async () => {
    const order = await buildOrderDeps();
    await seedReply(order);
    const key = (price: number) =>
      resolveOperationKey(recordQuote, quoteArgs(price), order, CTX.threadId, '');
    const first = await key(50);
    await recordQuote.execute(quoteArgs(50), order, CTX);
    // Повтор после записи: состояние совпало с содержимым, запись не переписывается.
    const savedAt = (await order.quotes.get(REQUEST_ID, 's1'))?.receivedAt;
    await recordQuote.execute(quoteArgs(50), order, CTX);
    expect((await order.quotes.get(REQUEST_ID, 's1'))?.receivedAt).toBe(savedAt);
    await recordQuote.execute(quoteArgs(60), order, CTX);
    const back = await key(50);
    expect(back).not.toBe(first);
    expect(await key(50)).toBe(back);
  });

  test('выбор: возврат к прежнему набору даёт новый ключ', async () => {
    const order = await buildOrderDeps();
    const key = (ids: string[]) =>
      resolveOperationKey(
        recordSelection,
        { requestId: REQUEST_ID, supplierIds: ids },
        order,
        CTX.threadId,
        '',
      );
    const first = await key(['s1']);
    const select = (supplierIds: string[]) =>
      saveSelection(order, { requestId: REQUEST_ID, supplierIds, createdAt: CREATED_AT });
    await select(['s1']);
    await select(['s2']);
    expect(await key(['s1'])).not.toBe(first);
  });
});

describe('D-7: ключи не глушат разные операции', () => {
  test('текст запроса: после появления контакта он готовится и оставшемуся адресату', async () => {
    const order = await buildOrderDeps();
    await saveSelection(order, {
      requestId: REQUEST_ID,
      supplierIds: ['s1', 's3'],
      createdAt: CREATED_AT,
    });
    const shownTexts = (): string =>
      order.chat.outbox.flatMap((record) => record.message?.text ?? []).join('\n');
    // s3 без контакта: текст готов обоим, у s3 вместо адреса пометка.
    await prepareRequestsText(order);
    expect(shownTexts()).toContain('sales@metall.test');
    expect(shownTexts()).toContain('адрес не найден, уточните контакт');
    expect(Object.keys((await loadSent(order, REQUEST_ID))?.sentBySupplier ?? {}).sort()).toEqual([
      's1',
      's3',
    ]);
    // Контакт появился: повтор того же вызова готовит текст заново, уже с адресом s3.
    await order.suppliers.upsert({ id: 's3', name: 'БезКонтакта', email: 'new@x.test' });
    await prepareRequestsText(order);
    expect(shownTexts()).toContain('new@x.test');
    expect(
      Object.keys((await loadSent(order, REQUEST_ID))?.sentBySupplier ?? {}).sort(),
    ).toEqual(['s1', 's3']);
    // Письма агент не отправляет ни в первый, ни во второй раз.
    expect(order.mailboxes.sentBy(MAIL_OWNER)).toEqual([]);
  });

  test('напоминания: новая рассылка даёт новую задачу и новое сообщение менеджеру', async () => {
    const order = await buildOrderDeps();
    const input = { requestId: REQUEST_ID };
    await saveSent(order, {
      requestId: REQUEST_ID,
      supplierIds: ['s1'],
      sentAt: CREATED_AT,
      sentBySupplier: { s1: CREATED_AT },
    });
    const first = await scheduleReminder.execute(input, order, CTX);
    expect((await scheduleReminder.execute(input, order, CTX)).taskId).toBe(first.taskId);
    await remindManager.execute(input, order, CTX);
    await remindManager.execute(input, order, CTX);
    expect(order.chat.outbox).toHaveLength(1);
    const key1 = await resolveOperationKey(remindManager, input, order, CTX.threadId, '');

    await saveSent(order, {
      requestId: REQUEST_ID,
      supplierIds: ['s1', 's2'],
      sentAt: CREATED_AT,
      sentBySupplier: { s1: CREATED_AT, s2: CREATED_AT },
    });
    expect(await resolveOperationKey(remindManager, input, order, CTX.threadId, '')).not.toBe(
      key1,
    );
    const second = await scheduleReminder.execute(input, order, CTX);
    expect(second.taskId).not.toBe(first.taskId);
    await remindManager.execute(input, order, CTX);
    expect(order.chat.outbox).toHaveLength(2);
  });
});
