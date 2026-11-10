import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryMailboxDirectory,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import {
  INBOX_CURSOR_NAMESPACE,
  UNASSIGNED_MAIL_NAMESPACE,
} from '../../src/agents/order-calc/deps';
import {
  createToolContext,
  recordHandoffAnswer,
  saveHandoff,
  type HandoffRecord,
} from '@business-ai/core';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import type {
  EmployeeMailbox,
  InboxMessage,
  MailboxDirectory,
  OutgoingMail,
} from '@business-ai/core';
import { buildOrderDeps, type OrderTestDeps, MAIL_OWNER } from './order-support';
import { MANAGER_THREAD } from './support';

const SENT_AT = '2026-03-01T00:00:00.000Z';
const AFTER = '2026-03-02T00:00:00.000Z';
const S1_EMAIL = 'sales@metall.test';
const NEW_PRIMARY = 'new@metall.test';
const SECOND_CONTACT = 'second@metall.test';
const OUTSIDER = 'someone@else.test';

let deps: OrderTestDeps;

const SCHEDULER_CTX = createToolContext({
  threadId: MANAGER_THREAD,
  agentId: 'test-agent',
  operationId: 'op-plan',
  initiator: { kind: 'scheduler' },
});
const read = (requestId: string) =>
  readSupplierReplies.execute({ requestId }, deps, SCHEDULER_CTX);
const replyIds = async (requestId: string): Promise<string[]> =>
  (await read(requestId)).replies.map((reply) => reply.replyId);

function mail(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id,
    from: S1_EMAIL,
    subject: 'КП',
    body: 'Арматура 50 руб.',
    receivedAt: AFTER,
    attachments: [],
    ...overrides,
  };
}

async function select(requestId: string, supplierIds = ['s1']): Promise<void> {
  await saveSelection(deps, { requestId, supplierIds, createdAt: SENT_AT });
}
async function markSent(requestId: string, messageId?: string, supplierIds = ['s1']) {
  await saveSent(deps, {
    requestId,
    supplierIds,
    sentAt: SENT_AT,
    ...(messageId === undefined ? {} : { messageIds: { s1: messageId } }),
    mailboxOwnerId: MAIL_OWNER,
  });
}
async function open(requestId: string, messageId?: string): Promise<void> {
  await select(requestId);
  await markSent(requestId, messageId);
}

/** Карточка s1: основной контакт и дополнительные (прежний основной адрес мог исчезнуть). */
async function setContacts(emails: Array<{ email: string; isPrimary: boolean }>): Promise<void> {
  const card = await deps.suppliers.getCard('s1');
  if (card === null) throw new Error('нет карточки s1');
  await deps.suppliers.saveCard({ ...card, contacts: emails.map((c) => ({ ...c })) });
}

beforeEach(async () => {
  deps = await buildOrderDeps();
});

describe('R6-07-03: ответ привязывается по всем адресам контактов поставщика', () => {
  test('основным сделан другой контакт: ответ с прежнего адреса не теряется', async () => {
    await open('req-1');
    await setContacts([
      { email: NEW_PRIMARY, isPrimary: true },
      { email: S1_EMAIL, isPrimary: false },
    ]);
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    expect(await replyIds('req-1')).toEqual(['in:m1']);
  });

  test('ответил второй контакт: письмо привязывается', async () => {
    await open('req-1');
    await setContacts([
      { email: S1_EMAIL, isPrimary: true },
      { email: SECOND_CONTACT, isPrimary: false },
    ]);
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1', { from: SECOND_CONTACT }));
    expect(await replyIds('req-1')).toEqual(['in:m1']);
  });

  test('адрес удалён из карточки: ответ на наше письмо (inReplyTo) не теряется', async () => {
    await open('req-1', 'box-1');
    await setContacts([{ email: NEW_PRIMARY, isPrimary: true }]);
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1', { inReplyTo: 'box-1', senderAuth: 'verified' }));
    const result = await read('req-1');
    expect(result.replies.map((reply) => reply.replyId)).toEqual(['in:m1']);
    // Адрес не из базы: отправитель считается не подтверждённым, менеджер это видит.
    expect(result.replies[0]?.senderVerified).toBe(false);
  });

  test('чужой адрес без ссылки на наше письмо не привязывается', async () => {
    await open('req-1', 'box-1');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1', { from: OUTSIDER }));
    deps.mailboxes.deliver(MAIL_OWNER, mail('m2', { from: OUTSIDER, inReplyTo: 'чужое' }));
    expect(await replyIds('req-1')).toEqual([]);
  });
});

describe('R6-01-06: письмо до записи SentRecord не теряется за курсором', () => {
  test('ответ пришёл раньше записи об отправке: после записи он разбирается', async () => {
    await select('req-1');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    // Чей ящик читать, до записи об отправке неизвестно: ящик не тронут, курсор не сдвинут.
    expect(await replyIds('req-1')).toEqual([]);
    expect(await deps.state.get(INBOX_CURSOR_NAMESPACE, MAIL_OWNER)).toBeNull();
    await markSent('req-1');
    expect(await replyIds('req-1')).toEqual(['in:m1']);
    expect(await deps.state.get(INBOX_CURSOR_NAMESPACE, MAIL_OWNER)).toEqual({ cursor: '1' });
    // Повторное чтение не задваивает ответ.
    expect((await read('req-1')).newCount).toBe(0);
  });

  test('письмо поставщика, которого не выбирали, ничего не откладывает', async () => {
    await select('req-1', ['s2']);
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    expect(await replyIds('req-1')).toEqual([]);
    const entries = await deps.state.list(UNASSIGNED_MAIL_NAMESPACE, null, 10);
    expect(entries).toEqual([]);
  });

  test('до записи об отправке письмо не копится: ни на разнесении, ни в ответах', async () => {
    await select('req-1');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    await read('req-1');
    deps.clock.advance(130 * 24 * 60 * 60 * 1000);
    expect(await deps.state.list(UNASSIGNED_MAIL_NAMESPACE, null, 10)).toEqual([]);
    expect(await replyIds('req-1')).toEqual([]);
    expect(deps.mailboxes.processedIds(MAIL_OWNER)).toEqual([]);
  });
});

describe('R6-10-01: содержимое письма не загружено - ответ не сохраняется пустым', () => {
  test('слишком большое письмо: нет пустого ответа, видна причина, курсор не молчит', async () => {
    await open('req-1');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1', { body: '', contentOmitted: 'too_large' }));
    const result = await read('req-1');
    expect(result.replies).toEqual([]);
    expect(result.contentOmitted).toEqual([
      { supplierId: 's1', receivedAt: AFTER, reason: 'too_large', managerNotified: true },
    ]);
    const asked = deps.chat.outbox.filter((item) => item.threadId === MANAGER_THREAD);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message?.text).toContain('слишком большое');
    // Письмо не помечено обработанным, но курсор двигается: запись о нём лежит в состоянии.
    expect(deps.mailboxes.processedIds(MAIL_OWNER)).toEqual([]);
    expect(await deps.state.get(INBOX_CURSOR_NAMESPACE, MAIL_OWNER)).toEqual({ cursor: '1' });
    // Повторное чтение вопрос не дублирует.
    await read('req-1');
    expect(deps.chat.outbox.filter((item) => item.threadId === MANAGER_THREAD)).toHaveLength(1);
  });

  test('письмо чужого отправителя без содержимого: ни вопроса, ни перечитывания', async () => {
    await open('req-1');
    const stranger = { from: OUTSIDER, body: '', contentOmitted: 'sender_not_allowed' } as const;
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1', stranger));
    const result = await read('req-1');
    expect(result.contentOmitted).toEqual([]);
    expect(deps.chat.outbox).toEqual([]);
  });

  describe('ящик сотрудника с перечитыванием по id', () => {
    interface StubBox extends EmployeeMailbox {
      calls: string[];
      failReads: number;
    }
    let box: StubBox;
    let omitted: InboxMessage;

    /** Ящик: список отдаёт письмо без содержимого, `getMessage` - полное (если не «упало»). */
    function makeBox(reason: NonNullable<InboxMessage['contentOmitted']>): StubBox {
      const full = mail('m1');
      omitted = { ...full, body: '', contentOmitted: reason };
      const stub: StubBox = {
        calls: [],
        failReads: 0,
        employeeId: 'u1',
        address: 'ivanov@company.test',
        async fetchNew(cursor: string) {
          const first = cursor === '';
          return { messages: first ? [omitted] : [], nextCursor: first ? '1' : cursor };
        },
        async markProcessed() {},
        async getMessage(id: string) {
          stub.calls.push(id);
          if (stub.failReads > 0) {
            stub.failReads -= 1;
            throw new Error('сервер недоступен');
          }
          return full;
        },
        async send(_mail: OutgoingMail) {
          throw new Error('не используется');
        },
      };
      return stub;
    }

    async function buildMailboxDeps(): Promise<void> {
      const directory: MailboxDirectory = { forEmployee: async () => box };
      deps = await buildOrderDeps({ mailboxes: directory as unknown as MemoryMailboxDirectory });
      await select('req-1');
      await saveSent(deps, {
        requestId: 'req-1',
        supplierIds: ['s1'],
        sentAt: SENT_AT,
        mailboxOwnerId: 'u1',
      });
    }

    test('отправитель не в списке адаптера: письмо перечитывается и сохраняется', async () => {
      box = makeBox('sender_not_allowed');
      await buildMailboxDeps();
      const result = await read('req-1');
      expect(result.replies.map((reply) => reply.text)).toEqual(['Арматура 50 руб.']);
      expect(result.contentOmitted).toEqual([]);
      expect(box.calls).toEqual(['m1']);
      expect(deps.chat.outbox).toEqual([]);
    });

    test('перечитать не удалось: сотрудник предупреждён, позже письмо подхватывается', async () => {
      box = makeBox('fetch_failed');
      box.failReads = 1;
      await buildMailboxDeps();
      const first = await read('req-1');
      expect(first.replies).toEqual([]);
      expect(first.contentOmitted).toHaveLength(1);
      expect(deps.chat.outbox.filter((item) => item.threadId === MANAGER_THREAD)).toHaveLength(1);
      // Курсор ушёл вперёд, но письмо не потеряно: следующий проход перечитывает его по id.
      const second = await read('req-1');
      expect(second.replies.map((reply) => reply.replyId)).toEqual(['in:m1']);
      expect(second.contentOmitted).toEqual([]);
    });

    test('письмо постороннего отправителя без содержимого не перечитывается', async () => {
      box = makeBox('sender_not_allowed');
      omitted = { ...omitted, from: OUTSIDER };
      await buildMailboxDeps();
      const result = await read('req-1');
      // Тело чужого письма не скачивается: требование этапа 57 для больших ящиков.
      expect(box.calls).toEqual([]);
      expect(result.replies).toEqual([]);
      expect(result.contentOmitted).toEqual([]);
      expect(deps.chat.outbox).toEqual([]);
    });

    test('слишком большое письмо повторно не перечитывается', async () => {
      box = makeBox('too_large');
      await buildMailboxDeps();
      await read('req-1');
      await read('req-1');
      expect(box.calls).toEqual([]);
    });
  });
});

describe('R6-07-01: \\u0000 и одиночный суррогат не блокируют запись состояния', () => {
  test('письмо с NUL привязывается, текст очищен, следующее письмо не блокируется', async () => {
    await open('req-1');
    const dirty = mail('m1', { subject: 'цена\u0000', body: 'Цена\u0000 100' });
    deps.mailboxes.deliver(MAIL_OWNER, dirty);
    deps.mailboxes.deliver(MAIL_OWNER, mail('m2', { body: 'Вторая 200' }));
    const result = await read('req-1');
    expect(result.replies.map((reply) => reply.text)).toEqual(['Цена 100', 'Вторая 200']);
    expect(JSON.stringify(result)).not.toContain('\\u0000');
  });
});

describe('R6-10-03: подтверждение по кнопке не обходит общую проверку нажатия', () => {
  test('ответ менеджера по передаче с пробельной личностью не принимается', async () => {
    const state = new MemoryWorkflowStateStore();
    const now = new Date('2026-10-11T10:00:00.000Z');
    const record: HandoffRecord = {
      id: 'ho-abcdef0123456789',
      from: 'order-calc',
      to: 'prices',
      status: 'awaiting_human',
      depth: 1,
      chain: ['order-calc', 'prices'],
      userId: 'user-a',
      replyThreadId: 'chat-1',
      parentThreadId: 'chat-1',
      input: 'ввод',
      predecessor: 'none',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      notified: false,
      round: 1,
      question: 'Подтвердить?',
      askedAt: now.toISOString(),
      answerDeadline: new Date(now.getTime() + 60_000).toISOString(),
      questionThreadId: 'chat-1',
    };
    await saveHandoff(state, record);
    const outcome = await recordHandoffAnswer(state, new FixedClock(now), {
      handoffId: record.id,
      round: 1,
      text: 'Да',
      userId: '   ',
      threadId: 'chat-1',
    });
    expect(outcome).toEqual({ kind: 'no_identity' });
  });
});

describe('R6-fix: повторный разбор ожидающего письма не теряет запись при сбое', () => {
  const SECOND_MAIL = 'm2';

  /** Ящик: m1 без содержимого (первое перечитывание падает), во втором проходе приходит m2. */
  function makeReplayBox(): { box: EmployeeMailbox; failReads: { left: number } } {
    const full = mail('m1');
    const omitted: InboxMessage = { ...full, body: '', contentOmitted: 'fetch_failed' };
    const failReads = { left: 1 };
    const box: EmployeeMailbox = {
      employeeId: 'u1',
      address: 'ivanov@company.test',
      async fetchNew(cursor: string) {
        if (cursor === '') return { messages: [omitted], nextCursor: '1' };
        if (cursor === '1') return { messages: [mail(SECOND_MAIL)], nextCursor: '2' };
        return { messages: [], nextCursor: cursor };
      },
      async markProcessed() {},
      async getMessage() {
        if (failReads.left > 0) {
          failReads.left -= 1;
          throw new Error('сервер недоступен');
        }
        return full;
      },
      async send(_mail: OutgoingMail) {
        throw new Error('не используется');
      },
    };
    return { box, failReads };
  }

  /** Состояние, в котором m1 лежит в ожидающих, а ближайший поиск поставщика упадёт один раз. */
  async function prepare(): Promise<{ failLookup: { left: number } }> {
    const { box } = makeReplayBox();
    const directory: MailboxDirectory = { forEmployee: async () => box };
    deps = await buildOrderDeps({ mailboxes: directory as unknown as MemoryMailboxDirectory });
    await select('req-1');
    await saveSent(deps, {
      requestId: 'req-1',
      supplierIds: ['s1'],
      sentAt: SENT_AT,
      mailboxOwnerId: 'u1',
    });
    const failLookup = { left: 0 };
    const original = deps.suppliers.findByAddresses.bind(deps.suppliers);
    deps.suppliers.findByAddresses = async (addresses) => {
      if (failLookup.left > 0) {
        failLookup.left -= 1;
        throw new Error('база недоступна');
      }
      return original(addresses);
    };
    return { failLookup };
  }

  test('сбой при разборе перечитанного письма: запись открыта, письмо не теряется', async () => {
    const { failLookup } = await prepare();
    // Проход 1: m1 без содержимого, перечитать не удалось - письмо ждёт.
    await read('req-1');
    failLookup.left = 1;
    // Проход 2: перечитывание удалось, но разбор упал. Ошибка не должна стереть запись.
    await read('req-1').catch(() => undefined);
    const third = await read('req-1');
    expect(third.replies.map((reply) => reply.replyId).sort()).toEqual(['in:m1', 'in:m2']);
  });

  test('сбой в одной ожидающей записи не блокирует чтение новых писем ящика', async () => {
    const { failLookup } = await prepare();
    await read('req-1');
    failLookup.left = 1;
    const second = await read('req-1');
    expect(second.replies.map((reply) => reply.replyId)).toContain(`in:${SECOND_MAIL}`);
    const third = await read('req-1');
    expect(third.replies.map((reply) => reply.replyId).sort()).toEqual(['in:m1', 'in:m2']);
  });
});
