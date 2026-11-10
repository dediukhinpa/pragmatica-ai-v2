import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryMailboxDirectory } from '@business-ai/adapters';
import {
  ORDER_DIGEST_MAX_ORDERS_LISTED,
  ORDER_DIGEST_OPEN_MAX_DAYS,
} from '../../src/kit/domain/monitoring';
import { bindingThreadId } from '@business-ai/core';
import { hoursToMs } from '../../src/kit/domain/time';
import { closeOrder } from '../../src/agents/order-calc/order-status';
import { createToolContext, recordWorkOwner, type ToolContext } from '@business-ai/core';
import { recordSupplierReply } from '../../src/agents/order-calc/record-supplier-reply';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import { requestTag } from '../../src/agents/order-calc/reply-routing';
import { runOrdersDigest } from '../../src/agents/order-calc/orders-digest';
import { storeReply } from '../../src/agents/order-calc/reply-store';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import { EVENT_SEVERITY } from '@business-ai/adapters';
import { MAIL_OWNER, ORDER_REQUEST, buildOrderDeps, type OrderTestDeps } from './order-support';

const TIMEZONE = 'Europe/Moscow';
/** Просьба из ТЗ разд. 6 проверить статус (ответ мог прийти не по почте). */
const CHECK_STATUS =
  'Проверьте, пожалуйста, статус по этим заявкам: ответ мог прийти в мессенджере или по телефону.';

/** Каталог ящиков: ящик есть, но чтение падает (не «не подключён», а сбой). */
class BrokenMailboxDirectory extends MemoryMailboxDirectory {
  override async forEmployee(): Promise<never> {
    throw new Error('imap down ivanov@company.test');
  }
}
const BOT = 'order-bot';
const THREAD_A = bindingThreadId({ botId: BOT, userId: 'ivanov' });
const THREAD_B = bindingThreadId({ botId: BOT, userId: 'petrov' });

/** Понедельник 09:30 по Москве (06:30 UTC): окно - пятница, суббота и воскресенье. */
const MONDAY_MORNING = '2026-10-12T06:30:00.000Z';
const FRIDAY_SENT = '2026-10-09T08:00:00.000Z';
const SATURDAY_SENT = '2026-10-10T09:00:00.000Z';
const THURSDAY_SENT = '2026-10-08T12:00:00.000Z';
const MONDAY_EARLY_SENT = '2026-10-12T05:00:00.000Z';
/** Ответ поставщика пришёл в выходные, после отправки запроса. */
const REPLY_AT = '2026-10-10T12:00:00.000Z';

/** Ход сотрудника в его треде связки. */
function chatCtx(threadId: string): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'test-agent',
    operationId: 'op-chat',
    initiator: { kind: 'user', userId: threadId },
  });
}

interface SendOptions {
  suppliers?: string[];
  sentAt: string;
  /** Тред сотрудника, начавшего заявку (владелец); без него адресат - менеджер по умолчанию. */
  thread?: string;
  /** Владелец ящика; по умолчанию владелец ящика тестовой сборки. */
  mailboxOwnerId?: string;
  /** `prepared` (по умолчанию) - текст подготовлен в чате; `sent` - запись прежнего формата. */
  state?: 'prepared' | 'sent';
}

/** Название заявки теста по её id: `req-wed` -> «товар wed» (без `req-` в тексте сводки). */
const titleOf = (requestId: string): string => `товар ${requestId.replace(/^req-/, '')}`;

/** Записать «запросы отправлены» и владельца заявки. */
async function sendRequests(
  deps: OrderTestDeps,
  requestId: string,
  options: SendOptions,
): Promise<void> {
  const suppliers = options.suppliers ?? ['s1', 's2'];
  // Заявка с названием по позиции: в сводке сотрудник видит его, а не идентификатор.
  if ((await deps.requests.get(requestId)) === null) {
    await deps.requests.save({
      ...ORDER_REQUEST,
      id: requestId,
      items: [{ name: titleOf(requestId), quantity: 1, unit: 'шт' }],
    });
  }
  await saveSent(deps, {
    requestId,
    supplierIds: suppliers,
    sentAt: options.sentAt,
    sentBySupplier: Object.fromEntries(suppliers.map((id) => [id, options.sentAt])),
    mailboxOwnerId: options.mailboxOwnerId ?? MAIL_OWNER,
    state: options.state ?? 'prepared',
  });
  if (options.thread !== undefined) {
    await recordWorkOwner(deps.state, workSubject.order(requestId), chatCtx(options.thread));
  }
}

/** Ответ поставщика уже сохранён: по умолчанию подтверждённое письмо по почте. */
async function replyFrom(
  deps: OrderTestDeps,
  requestId: string,
  supplierId: string,
  receivedAt = REPLY_AT,
  extra: { senderUnverified?: boolean } = {},
): Promise<void> {
  await storeReply(deps.state, requestId, {
    id: `out:${requestId}:${supplierId}`,
    channel: 'email',
    supplierId,
    text: 'Цена 50',
    receivedAt,
    attachments: [],
    ...(extra.senderUnverified === true ? { senderUnverified: true } : {}),
  });
}

function setNow(deps: OrderTestDeps, iso: string): void {
  deps.clock = new FixedClock(new Date(iso));
}

const run = (deps: OrderTestDeps) => runOrdersDigest(deps, { timezone: TIMEZONE });

const HEADLINE = 'План на день:';

/** Сообщения сводки (в чат попадают и показы записей инструментов). */
function digests(deps: OrderTestDeps, threadId?: string): string[] {
  const records = threadId === undefined ? deps.chat.outbox : deps.chat.outboxOf(threadId);
  return records
    .map((record) => record.message?.text ?? '')
    .filter((text) => text.startsWith(HEADLINE));
}

/** Реплика сотрудника с номером хода: показ записи и «да» - разные реплики. */
function turnCtx(threadId: string, turnNumber: number): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'test-agent',
    operationId: `op-turn-${turnNumber}`,
    // Ящик заявок теста - у MAIL_OWNER: записывает ответ владелец заявки.
    initiator: { kind: 'user', userId: MAIL_OWNER },
    turnNumber,
  });
}

/** Сотрудник сообщает ответ поставщика по телефону и подтверждает запись. */
async function phoneReply(
  deps: OrderTestDeps,
  requestId: string,
  supplierId: string,
  thread = THREAD_A,
  extra: { declined?: boolean } = {},
): Promise<void> {
  // Заявка нужна записи ответа: проверяется, что она существует.
  if ((await deps.requests.get(requestId)) === null) {
    await deps.requests.save({ ...ORDER_REQUEST, id: requestId });
  }
  const suppliers = (await deps.state.get('order-calc:sent', requestId)) as {
    supplierIds: string[];
  } | null;
  await saveSelection(deps, {
    requestId,
    supplierIds: suppliers?.supplierIds ?? [supplierId],
    createdAt: FRIDAY_SENT,
  });
  const input = {
    requestId,
    supplierId,
    channel: 'phone' as const,
    summary: 'Позвонили, цена 50',
    ...(extra.declined === true ? { declined: true } : {}),
  };
  await recordSupplierReply.execute(input, deps, turnCtx(thread, 1));
  await recordSupplierReply.execute({ ...input, confirmed: true }, deps, turnCtx(thread, 2));
}

/** КП поставщика записано. */
async function saveQuote(
  deps: OrderTestDeps,
  requestId: string,
  supplierId: string,
): Promise<void> {
  await deps.quotes.save({
    id: `quote:${requestId}:${supplierId}`,
    requestId,
    supplierId,
    lines: [{ productName: 'Арматура', unitPrice: 50, quantity: 100, unit: 'м' }],
    currency: 'RUB',
    receivedAt: REPLY_AT,
    gaps: [],
  } as never);
}

describe('Сводка по заказам: когда уходит и что попадает', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    setNow(deps, MONDAY_MORNING);
  });

  test('заказ без ответа виден на 2-й и на 5-й день после отправки', async () => {
    // Запрос подготовлен в среду; пятница - 2-й день, понедельник - 5-й.
    await sendRequests(deps, 'req-wed', {
      sentAt: '2026-10-07T10:00:00.000Z',
      thread: THREAD_A,
      suppliers: ['s1'],
    });
    setNow(deps, '2026-10-09T06:30:00.000Z');
    expect((await run(deps)).status).toBe('sent');
    expect(digests(deps)[0]).toContain(
      'товар wed: подготовили запросы с 07.10. МеталлТорг: нет ответа 2 дня.',
    );
    setNow(deps, MONDAY_MORNING);
    expect((await run(deps)).status).toBe('sent');
    expect(digests(deps)).toHaveLength(2);
    expect(digests(deps)[1]).toContain('МеталлТорг: нет ответа 5 дней.');
  });

  test('заказ виден каждый рабочий день, пока не закрыт', async () => {
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    for (const day of ['12', '13', '14', '15']) {
      setNow(deps, `2026-10-${day}T06:30:00.000Z`);
      expect((await run(deps)).orders).toBe(1);
    }
    expect(digests(deps)).toHaveLength(4);
  });

  test('запрос, подготовленный сегодня, попадёт в сводку завтра', async () => {
    await sendRequests(deps, 'req-mon', { sentAt: MONDAY_EARLY_SENT, thread: THREAD_A });
    expect(await run(deps)).toEqual({ status: 'nothing_to_report', messages: 0, orders: 0 });
    setNow(deps, '2026-10-13T06:30:00.000Z');
    expect((await run(deps)).orders).toBe(1);
  });

  test('заказы, подготовленные в разные дни, видны одним сообщением', async () => {
    await sendRequests(deps, 'req-thu', { sentAt: THURSDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-sat', { sentAt: SATURDAY_SENT, thread: THREAD_A });
    expect(await run(deps)).toEqual({ status: 'sent', messages: 1, orders: 3 });
    const text = digests(deps)[0] ?? '';
    expect(text).toStartWith(HEADLINE);
    // Порядок - по дате отправки.
    expect(text.indexOf('товар thu')).toBeLessThan(text.indexOf('товар fri'));
    expect(text.indexOf('товар fri')).toBeLessThan(text.indexOf('товар sat'));
    expect(text).toContain('ответ мог прийти в мессенджере или по телефону');
  });

  test('до 9:00 по местному времени not_due, с 9:00 уходит', async () => {
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    setNow(deps, '2026-10-12T05:59:00.000Z');
    expect((await run(deps)).status).toBe('not_due');
    expect(deps.chat.outbox).toHaveLength(0);
    setNow(deps, '2026-10-12T06:00:00.000Z');
    expect((await run(deps)).status).toBe('sent');
  });

  test('смена суток считается в поясе бизнеса, а не в UTC', async () => {
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    // 22:00 UTC воскресенья: в Москве уже понедельник, но только 01:00 - рано.
    setNow(deps, '2026-10-11T22:00:00.000Z');
    expect((await runOrdersDigest(deps, { timezone: TIMEZONE })).status).toBe('not_due');
    // Для Владивостока (UTC+10) это понедельник 08:00 - рано; через час - 09:00, уходит.
    expect((await runOrdersDigest(deps, { timezone: 'Asia/Vladivostok' })).status).toBe('not_due');
    setNow(deps, '2026-10-11T23:00:00.000Z');
    expect((await runOrdersDigest(deps, { timezone: 'Asia/Vladivostok' })).status).toBe('sent');
  });

  test('суббота и воскресенье: not_due', async () => {
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    for (const day of ['2026-10-10T10:00:00.000Z', '2026-10-11T10:00:00.000Z']) {
      setNow(deps, day);
      expect((await run(deps)).status).toBe('not_due');
    }
    expect(deps.chat.outbox).toHaveLength(0);
  });
});

describe('Сводка по заказам: ответы из любого канала и закрытие заказа', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    setNow(deps, MONDAY_MORNING);
  });

  test('ответ по телефону меняет строку заказа', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await run(deps);
    expect(digests(deps)[0]).toContain('МеталлТорг: нет ответа 3 дня.');
    await phoneReply(deps, 'req-1', 's1');
    setNow(deps, '2026-10-13T06:30:00.000Z');
    await run(deps);
    const text = digests(deps)[1] ?? '';
    expect(text).toContain('МеталлТорг: ответил (телефон, 12.10), КП ещё не записано.');
    expect(text).toContain('Болтик: нет ответа 4 дня.');
    expect(text).toContain(CHECK_STATUS);
  });

  test('КП записано: строка «КП записано», пока остальные не закрыты заказ виден', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await phoneReply(deps, 'req-1', 's1');
    await saveQuote(deps, 'req-1', 's1');
    await run(deps);
    const text = digests(deps)[0] ?? '';
    expect(text).toContain('МеталлТорг: ответил (телефон, 12.10), КП записано.');
    expect(text).toContain('Болтик: нет ответа 3 дня.');
  });

  test('закрытый заказ пропадает: КП (или отказ) у всех выбранных поставщиков', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-2', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await saveQuote(deps, 'req-1', 's1');
    await saveQuote(deps, 'req-1', 's2');
    // По второму заказу один поставщик с КП, второй явно отказался.
    await saveQuote(deps, 'req-2', 's1');
    await phoneReply(deps, 'req-2', 's2', THREAD_A, { declined: true });
    expect(await run(deps)).toEqual({ status: 'nothing_to_report', messages: 0, orders: 0 });
    expect(digests(deps)).toHaveLength(0);
  });

  test('отказ одного поставщика заказ не закрывает, если второй не ответил', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await phoneReply(deps, 'req-1', 's1', THREAD_A, { declined: true });
    await run(deps);
    const text = digests(deps)[0] ?? '';
    expect(text).toContain('МеталлТорг: отказался давать КП.');
    expect(text).toContain('Болтик: нет ответа 3 дня.');
  });

  test('закрытый сотрудником заказ пропадает из сводки', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-2', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await closeOrder.execute({ requestId: 'req-1' }, deps, turnCtx(THREAD_A, 1));
    await closeOrder.execute({ requestId: 'req-1', confirmed: true }, deps, turnCtx(THREAD_A, 2));
    await run(deps);
    const text = digests(deps)[0] ?? '';
    expect(text).toContain('товар 2');
    expect(text).not.toContain('товар 1');
  });

  test('без почты сводка уходит: ответ по телефону учтён, пометка про почту есть', async () => {
    const withoutMail = { ...deps, mailboxes: undefined };
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await phoneReply(deps, 'req-1', 's2');
    expect((await runOrdersDigest(withoutMail, { timezone: TIMEZONE })).status).toBe('sent');
    const text = digests(deps, THREAD_A)[0] ?? '';
    expect(text).toContain('Болтик: ответил (телефон, 12.10), КП ещё не записано.');
    expect(text).toContain('МеталлТорг: нет ответа 3 дня.');
    expect(text).toContain('Почта не подключена: проверьте статус вручную.');
    expect(text).toContain(CHECK_STATUS);
  });
});

describe('Сводка по заказам: ORDER_DIGEST_OPEN_MAX_DAYS', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    setNow(deps, MONDAY_MORNING);
  });

  test('по умолчанию 14 дней', () => {
    expect(ORDER_DIGEST_OPEN_MAX_DAYS).toBe(14);
  });

  test('заказ старше предела - одной строкой с числом, не по отдельности', async () => {
    // 2026-09-25 - 17 дней до 12.10; 2026-09-28 - ровно 14 дней, ещё в списке.
    await sendRequests(deps, 'req-old', { sentAt: '2026-09-25T10:00:00.000Z', thread: THREAD_A });
    await sendRequests(deps, 'req-old2', { sentAt: '2026-09-24T10:00:00.000Z', thread: THREAD_A });
    await sendRequests(deps, 'req-edge', { sentAt: '2026-09-28T10:00:00.000Z', thread: THREAD_A });
    expect(await run(deps)).toEqual({ status: 'sent', messages: 1, orders: 3 });
    const text = digests(deps)[0] ?? '';
    expect(text).toContain('товар edge');
    expect(text).not.toContain('товар old');
    expect(text).toContain('• и 2 заказа старше 14 дней');
  });

  test('сводка из одних старых заказов тоже уходит', async () => {
    await sendRequests(deps, 'req-old', { sentAt: '2026-09-01T10:00:00.000Z', thread: THREAD_A });
    expect((await run(deps)).status).toBe('sent');
    expect(digests(deps)[0]).toContain('• и 1 заказ старше 14 дней');
  });

  test('предел задаётся параметром', async () => {
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await runOrdersDigest(deps, { timezone: TIMEZONE, openMaxDays: 2 });
    const text = digests(deps)[0] ?? '';
    expect(text).not.toContain('товар fri');
    expect(text).toContain('• и 1 заказ старше 2 дней');
  });

  test('старый заказ с КП у всех в «старых» не считается', async () => {
    await sendRequests(deps, 'req-old', { sentAt: '2026-09-01T10:00:00.000Z', thread: THREAD_A });
    await saveQuote(deps, 'req-old', 's1');
    await saveQuote(deps, 'req-old', 's2');
    expect((await run(deps)).status).toBe('nothing_to_report');
  });
});

describe('Сводка по заказам: план на день', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    setNow(deps, MONDAY_MORNING);
  });

  test('пункт про ответы поставщиков со списком названий, id нет нигде', async () => {
    await sendRequests(deps, 'req-honey', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-plaid', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await run(deps);
    const text = digests(deps)[0] ?? '';
    const lines = text.split('\n');
    expect(lines[0]).toBe('План на день:');
    expect(lines[1]).toBe('1. Проверьте, ответили ли поставщики по вашим запросам цен:');
    expect(lines).toContain('- товар honey');
    expect(lines).toContain('- товар plaid');
    expect(text).toContain('нет ответа');
    expect(text).not.toContain('req-');
  });

  test('одинаковые названия у одного сотрудника различаются датой', async () => {
    const same = { ...ORDER_REQUEST, items: [{ name: 'Пледы', quantity: 1, unit: 'шт' }] };
    await deps.requests.save({ ...same, id: 'req-x1', createdAt: '2026-10-08T09:00:00.000Z' });
    await deps.requests.save({ ...same, id: 'req-x2', createdAt: '2026-10-09T09:00:00.000Z' });
    await sendRequests(deps, 'req-x1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-x2', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await run(deps);
    const text = digests(deps)[0] ?? '';
    expect(text).toContain('- Пледы от 08.10');
    expect(text).toContain('- Пледы от 09.10');
  });
});

describe('Сводка по заказам: содержание и повтор', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    setNow(deps, MONDAY_MORNING);
  });

  test('повтор задачи не дублирует сообщение', async () => {
    await sendRequests(deps, 'req-fri', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    expect((await run(deps)).status).toBe('sent');
    expect((await run(deps)).status).toBe('already_done');
    expect(deps.chat.outbox).toHaveLength(1);
    // Через час того же дня - по-прежнему слот занят.
    deps.clock.advance(hoursToMs(1));
    expect((await run(deps)).status).toBe('already_done');
    expect(deps.chat.outbox).toHaveLength(1);
  });

  test('сбой одного треда: остальные получают, повтор закрыт ключами', async () => {
    await sendRequests(deps, 'req-a', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-b', { sentAt: FRIDAY_SENT, thread: THREAD_B });
    const reply = deps.chat.reply.bind(deps.chat);
    let failOnce = true;
    deps.chat.reply = async (threadId, message, key) => {
      if (threadId === THREAD_A && failOnce) {
        failOnce = false;
        throw new Error('канал недоступен');
      }
      await reply(threadId, message, key);
    };
    await expect(run(deps)).rejects.toThrow();
    expect(deps.chat.outboxOf(THREAD_B)).toHaveLength(1);
    expect((await run(deps)).status).toBe('sent');
    expect(deps.chat.outboxOf(THREAD_A)).toHaveLength(1);
    expect(deps.chat.outboxOf(THREAD_B)).toHaveLength(1);
  });

  test('два сотрудника получают каждый своё', async () => {
    await sendRequests(deps, 'req-a', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-b', { sentAt: FRIDAY_SENT, thread: THREAD_B });
    const result = await run(deps);
    expect(result).toEqual({ status: 'sent', messages: 2, orders: 2 });
    const textA = deps.chat.outboxOf(THREAD_A)[0]?.message?.text ?? '';
    const textB = deps.chat.outboxOf(THREAD_B)[0]?.message?.text ?? '';
    expect(textA).toContain('товар a');
    expect(textA).not.toContain('товар b');
    expect(textB).toContain('товар b');
    expect(textB).not.toContain('товар a');
  });

  test('имя поставщика читается один раз за прогон, а не на каждую заявку', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-2', { sentAt: SATURDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-3', { sentAt: SATURDAY_SENT, thread: THREAD_B });
    const get = deps.suppliers.get.bind(deps.suppliers);
    const asked: string[] = [];
    deps.suppliers.get = async (id) => {
      asked.push(id);
      return get(id);
    };
    expect(await run(deps)).toEqual({ status: 'sent', messages: 2, orders: 3 });
    expect([...asked].sort()).toEqual(['s1', 's2']);
  });

  test('несколько заявок одного сотрудника - одно сообщение, по строке на заказ', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await sendRequests(deps, 'req-2', { sentAt: SATURDAY_SENT, thread: THREAD_A });
    expect(await run(deps)).toEqual({ status: 'sent', messages: 1, orders: 2 });
    expect(deps.chat.outbox).toHaveLength(1);
    const lines = (deps.chat.outbox[0]?.message?.text ?? '').split('\n');
    expect(lines.filter((line) => line.startsWith('• '))).toHaveLength(2);
  });

  test('ответили и не ответили: перечислены по названиям, адресов нет', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await replyFrom(deps, 'req-1', 's1');
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('подготовили запросы с 09.10. МеталлТорг: ответил');
    expect(text).toContain('МеталлТорг: ответил (почта, 10.10), КП ещё не записано.');
    expect(text).toContain('Болтик: нет ответа 3 дня.');
    expect(text).not.toContain('@');
  });

  test('никто не ответил: «нет ответа» у каждого', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг: нет ответа 3 дня.');
    expect(text).toContain('Болтик: нет ответа 3 дня.');
  });

  test('письмо, пришедшее раньше отправки запроса, не считается ответом', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await replyFrom(deps, 'req-1', 's1', THURSDAY_SENT);
    await run(deps);
    expect(deps.chat.outbox[0]?.message?.text).toContain('МеталлТорг: нет ответа 3 дня.');
  });

  test('письмо без подтверждения отправителя не считается ответом', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await replyFrom(deps, 'req-1', 's1', REPLY_AT, { senderUnverified: true });
    await replyFrom(deps, 'req-1', 's2', REPLY_AT, { senderUnverified: true });
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг: нет ответа');
    expect(text).not.toContain('ответил (');
  });

  test('ответили все, КП нет: заказ остаётся, просьба проверить статус на месте', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    await replyFrom(deps, 'req-1', 's1');
    await replyFrom(deps, 'req-1', 's2');
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг: ответил (почта, 10.10), КП ещё не записано.');
    expect(text).toContain('Болтик: ответил (почта, 10.10), КП ещё не записано.');
    expect(text).not.toContain('нет ответа');
    expect(text).toContain(CHECK_STATUS);
  });

  test('пустая сводка: сообщения нет, слот ставится', async () => {
    expect(await run(deps)).toEqual({ status: 'nothing_to_report', messages: 0, orders: 0 });
    expect(deps.chat.outbox).toHaveLength(0);
    expect((await run(deps)).status).toBe('already_done');
  });

  test('лимит строк: остаток числом', async () => {
    const total = ORDER_DIGEST_MAX_ORDERS_LISTED + 3;
    for (let index = 0; index < total; index += 1) {
      const id = `req-${String(index).padStart(2, '0')}`;
      await sendRequests(deps, id, { sentAt: FRIDAY_SENT, thread: THREAD_A, suppliers: ['s1'] });
    }
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text.split('\n').filter((line) => line.startsWith('• ') && line.includes('подготовили'))).toHaveLength(
      ORDER_DIGEST_MAX_ORDERS_LISTED,
    );
    expect(text).toContain('и ещё 3 заявок');
  });

  test('подготовленные запросы: «подготовили», без «ушли» и «отправили»', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A, state: 'prepared' });
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('Арматура: подготовили запросы');
    expect(text).not.toMatch(/ушли|ушёл|отправили|отправлен/);
  });

  test('запись прежнего формата (sent): «отправили запросы»', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A, state: 'sent' });
    await run(deps);
    expect(deps.chat.outbox[0]?.message?.text).toContain('Арматура: отправили запросы');
  });

  test('запрос, подготовленный поздно вечером в пятницу, виден в понедельник', async () => {
    await sendRequests(deps, 'req-late', {
      sentAt: '2026-10-09T20:59:00.000Z',
      thread: THREAD_A,
      state: 'prepared',
    });
    expect(await run(deps)).toEqual({ status: 'sent', messages: 1, orders: 1 });
  });

  test('в журнале нет текстов сообщения и адресов', async () => {
    const logged: string[] = [];
    deps.log = (event, fields) => {
      logged.push(`${event} ${JSON.stringify(fields ?? {})}`);
    };
    const withoutMail = { ...deps, mailboxes: undefined };
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A, state: 'prepared' });
    await runOrdersDigest(withoutMail, { timezone: TIMEZONE });
    const joined = logged.join('\n');
    expect(joined).toContain('order_digest_sent');
    for (const needle of ['МеталлТорг', 'Болтик', 'Проверь', 'req-1', '@', 'ivanov']) {
      expect(joined).not.toContain(needle);
    }
  });
});

describe('Сводка по заказам: ящики сотрудников', () => {
  let deps: OrderTestDeps;
  let boxes: MemoryMailboxDirectory;
  beforeEach(async () => {
    boxes = new MemoryMailboxDirectory();
    boxes.connect('ivanov', 'ivanov@company.test');
    deps = await buildOrderDeps({ mailboxes: boxes });
    setNow(deps, MONDAY_MORNING);
  });

  test('свежее письмо поставщика в ящике владельца считается ответом', async () => {
    await sendRequests(deps, 'req-1', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_A,
      mailboxOwnerId: 'ivanov',
    });
    boxes.deliver('ivanov', {
      id: 'mail-1',
      from: 'sales@metall.test',
      subject: `КП ${requestTag('req-1')}`,
      body: 'Цена 50',
      receivedAt: REPLY_AT,
      attachments: [],
      senderAuth: 'verified',
    });
    await run(deps);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг: ответил (почта, 10.10), КП ещё не записано.');
    expect(text).toContain('Болтик: нет ответа 3 дня.');
    expect(boxes.processedIds('ivanov')).toEqual(['mail-1']);
  });

  test('ящик не подключён: сообщение уходит с пометкой', async () => {
    await sendRequests(deps, 'req-2', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_B,
      mailboxOwnerId: 'petrov',
    });
    expect((await run(deps)).status).toBe('sent');
    const text = deps.chat.outboxOf(THREAD_B)[0]?.message?.text ?? '';
    expect(text).toContain('Почта не подключена: проверьте статус вручную.');
    expect(text).toContain(CHECK_STATUS);
  });

  test('ящик не подключён - info-событие, а не ошибка чтения (этап 217)', async () => {
    const events: string[] = [];
    deps.log = (event) => {
      events.push(event);
    };
    await sendRequests(deps, 'req-2', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_B,
      mailboxOwnerId: 'petrov',
    });
    expect((await run(deps)).status).toBe('sent');
    expect(events).toContain('order_digest_mailbox_not_connected');
    expect(events).not.toContain('order_digest_mailbox_unreadable');
    expect(EVENT_SEVERITY['order_digest_mailbox_not_connected']).toBe('info');
    expect(EVENT_SEVERITY['order_digest_mailbox_unreadable']).toBe('serious');
  });

  test('сбой чтения подключённого ящика остаётся ошибкой (этап 217)', async () => {
    const events: string[] = [];
    const unreadable = await buildOrderDeps({ mailboxes: new BrokenMailboxDirectory() });
    unreadable.log = (event) => {
      events.push(event);
    };
    setNow(unreadable, MONDAY_MORNING);
    await sendRequests(unreadable, 'req-1', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_A,
      mailboxOwnerId: 'ivanov',
    });
    expect((await run(unreadable)).status).toBe('sent');
    expect(events).toContain('order_digest_mailbox_unreadable');
    expect(events).not.toContain('order_digest_mailbox_not_connected');
  });

  test('ящик не читается: пометка «не удалось прочитать», сообщение уходит', async () => {
    const unreadable = await buildOrderDeps({ mailboxes: new BrokenMailboxDirectory() });
    setNow(unreadable, MONDAY_MORNING);
    await sendRequests(unreadable, 'req-1', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_A,
      mailboxOwnerId: 'ivanov',
    });
    expect((await run(unreadable)).status).toBe('sent');
    const text = unreadable.chat.outboxOf(THREAD_A)[0]?.message?.text ?? '';
    expect(text).toContain('Не удалось прочитать почту: проверьте статус вручную.');
    expect(text).not.toContain('Почта не подключена');
  });

  test('ящики сотрудников выключены: читать почту нечем, сообщение уходит с пометкой', async () => {
    await sendRequests(deps, 'req-1', { sentAt: FRIDAY_SENT, thread: THREAD_A });
    const withoutMail = { ...deps, mailboxes: undefined };
    expect((await runOrdersDigest(withoutMail, { timezone: TIMEZONE })).status).toBe('sent');
    const text = deps.chat.outboxOf(THREAD_A)[0]?.message?.text ?? '';
    expect(text).toContain('Почта не подключена: проверьте статус вручную.');
    expect(boxes.processedIds('ivanov')).toEqual([]);
  });

  test('два сотрудника: письмо из ящика одного не попадает в сводку другого', async () => {
    boxes.connect('petrov', 'petrov@company.test');
    await sendRequests(deps, 'req-1', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_A,
      suppliers: ['s1'],
      mailboxOwnerId: 'ivanov',
    });
    await sendRequests(deps, 'req-2', {
      sentAt: FRIDAY_SENT,
      thread: THREAD_B,
      suppliers: ['s1'],
      mailboxOwnerId: 'petrov',
    });
    boxes.deliver('ivanov', {
      id: 'mail-1',
      from: 'sales@metall.test',
      subject: `КП ${requestTag('req-1')}`,
      body: 'Цена 50',
      receivedAt: REPLY_AT,
      attachments: [],
      senderAuth: 'verified',
    });
    await run(deps);
    expect(deps.chat.outboxOf(THREAD_A)[0]?.message?.text).toContain('МеталлТорг: ответил (почта');
    expect(deps.chat.outboxOf(THREAD_B)[0]?.message?.text).toContain('МеталлТорг: нет ответа');
  });
});

