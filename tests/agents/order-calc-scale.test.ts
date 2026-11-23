import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  UNASSIGNED_FILES_NAMESPACE,
  UNASSIGNED_MAIL_NAMESPACE,
} from '../../src/agents/order-calc/deps';
import {
  assignSupplierMail,
  listUnassignedMail,
  parseRouteButton,
  requestToken,
} from '../../src/agents/order-calc/reply-routing';
import {
  attachmentKey,
  loadAttachmentBody,
  loadReplies,
  repliesNamespace,
  replyFilesNamespace,
  replyKey,
  storeEmail,
} from '../../src/agents/order-calc/reply-store';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import type { InboxMessage, JsonValue, WorkflowStateEntry } from '@business-ai/core';
import {
  buildOrderDeps,
  routeButtonAt,
  type OrderTestDeps,
  MAIL_OWNER,
  READER_CTX as CTX,
} from './order-support';
import { MANAGER_THREAD } from './support';

const SENT_AT = '2026-03-01T00:00:00.000Z';
const AFTER = '2026-03-02T00:00:00.000Z';
const BIG_BODY = 'A'.repeat(200_000);

/** Хранилище с журналом: сколько записей и каких ключей отдал `list`. */
class JournalStore extends MemoryWorkflowStateStore {
  listedKeys: string[] = [];
  override async list(
    namespace: string,
    afterKey: string | null,
    limit: number,
  ): Promise<WorkflowStateEntry[]> {
    const page = await super.list(namespace, afterKey, limit);
    this.listedKeys.push(...page.map((entry) => `${namespace}|${entry.key}`));
    return page;
  }
}

let deps: OrderTestDeps;
let store: JournalStore;

function mail(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id,
    from: 'sales@metall.test',
    subject: 'КП',
    body: 'Арматура 50 руб.',
    receivedAt: AFTER,
    attachments: [],
    ...overrides,
  };
}

async function open(requestId: string, supplierIds = ['s1']): Promise<void> {
  await saveSelection(deps, { requestId, supplierIds, createdAt: SENT_AT });
  await saveSent(deps, { requestId, supplierIds, sentAt: SENT_AT, mailboxOwnerId: MAIL_OWNER });
}

beforeEach(async () => {
  deps = await buildOrderDeps();
  store = new JournalStore();
  deps.state = store;
});

const attachmentMail = {
  id: 'm1',
  subject: 'КП',
  body: 'во вложении',
  receivedAt: AFTER,
  attachments: [{ fileName: 'kp.csv', mimeType: 'text/csv', sizeBytes: 9, base64: 'QUJD' }],
};

describe('R5-CORE-7: вложения ответов в отдельном пространстве', () => {
  test('новое вложение пишется в своё пространство, не в пространство ответов', async () => {
    await storeEmail(deps.state, 'req-1', attachmentMail, 's1');
    expect(await store.get(replyFilesNamespace('req-1'), attachmentKey('in:m1', 0))).toEqual({
      base64: 'QUJD',
    });
    expect(await store.get(repliesNamespace('req-1'), attachmentKey('in:m1', 0))).toBeNull();
    expect(await loadAttachmentBody(deps.state, 'req-1', 'in:m1', 0)).toEqual({ base64: 'QUJD' });
  });

  test('вложение прежнего формата (в пространстве ответов) по-прежнему читается', async () => {
    await store.put(repliesNamespace('req-1'), attachmentKey('in:old', 0), { base64: 'T0xE' });
    expect(await loadAttachmentBody(deps.state, 'req-1', 'in:old', 0)).toEqual({ base64: 'T0xE' });
    expect(await loadAttachmentBody(deps.state, 'req-1', 'in:none', 0)).toBeNull();
  });

  test('loadReplies не вычитывает тела вложений, ни новых, ни прежних', async () => {
    for (let index = 0; index < 5; index += 1) {
      // Прежний формат: тела лежат рядом с ответами.
      await store.put(repliesNamespace('req-1'), attachmentKey(`in:old${index}`, 0), {
        base64: BIG_BODY,
      });
      const file = { fileName: 'kp.csv', mimeType: 'text/csv', sizeBytes: 9, base64: BIG_BODY };
      await storeEmail(
        deps.state,
        'req-1',
        { ...attachmentMail, id: `n${index}`, attachments: [file] },
        's1',
      );
    }
    store.listedKeys = [];
    const replies = await loadReplies(deps.state, 'req-1');
    expect(replies).toHaveLength(5);
    // До правки в выдачу попадали все `a:`-записи (по 200 КБ каждая).
    expect(store.listedKeys.filter((key) => key.includes('|a:'))).toEqual([]);
  });

  test('письмо на разнесении: вложение в своём пространстве, разнесение его находит', async () => {
    await open('req-1');
    await open('req-2');
    const bytes = new TextEncoder().encode('Поз,Цена\nA,5');
    deps.mailboxes.deliver(MAIL_OWNER,
      mail('m1', { attachments: [{ fileName: 'kp.csv', mimeType: 'text/csv', bytes }] }),
    );
    await readSupplierReplies.execute({ requestId: 'req-1' }, deps, CTX);
    const key = attachmentKey('m1', 0);
    expect(await store.get(UNASSIGNED_FILES_NAMESPACE, key)).not.toBeNull();
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, key)).toBeNull();
    const press = parseRouteButton(await routeButtonAt(deps.state, 1));
    if (press === null) throw new Error('кнопка не разобрана');
    const outcome = await assignSupplierMail(deps.state, deps.clock, {
      ...press,
      userId: 'manager',
      threadId: MANAGER_THREAD,
    });
    expect(outcome).toEqual({ kind: 'assigned', requestId: 'req-2' });
    expect(await loadAttachmentBody(deps.state, 'req-2', 'in:m1', 0)).not.toBeNull();
  });

  test('письмо на разнесении прежнего формата (вложение рядом с письмом) разносится', async () => {
    await open('req-1');
    await open('req-2');
    const base = {
      messageId: 'old1',
      token: 'tok-old',
      subject: 'КП',
      body: 'текст',
      receivedAt: AFTER,
      attachments: [{ fileName: 'kp.csv', mimeType: 'text/csv', sizeBytes: 3 }],
      candidates: [
        { requestId: 'req-1', supplierId: 's1' },
        { requestId: 'req-2', supplierId: 's1' },
      ],
      threadIds: [MANAGER_THREAD],
      askedThreadIds: [MANAGER_THREAD],
    };
    await store.put(UNASSIGNED_MAIL_NAMESPACE, replyKey('old1'), base as unknown as JsonValue);
    await store.put(UNASSIGNED_MAIL_NAMESPACE, attachmentKey('old1', 0), { base64: 'QUJD' });
    expect((await listUnassignedMail(deps.state)).map((item) => item.messageId)).toEqual(['old1']);
    const outcome = await assignSupplierMail(deps.state, deps.clock, {
      mailToken: 'tok-old',
      requestToken: requestToken('req-2'),
      userId: 'manager',
      threadId: MANAGER_THREAD,
    });
    expect(outcome).toEqual({ kind: 'assigned', requestId: 'req-2' });
    expect(await loadAttachmentBody(deps.state, 'req-2', 'in:old1', 0)).toEqual({
      base64: 'QUJD',
    });
  });
});

describe('R5-CORE-9: пустой ящик не читает справочник и историю отправок', () => {
  test('ни suppliers.get, ни чтения SENT, пока в ящике нет писем', async () => {
    for (let index = 0; index < 20; index += 1) {
      const email = `x${index}@t.test`;
      await deps.suppliers.upsert({ id: `x${index}`, name: `П${index}`, email });
      await open(`req-${index}`, [`x${index}`]);
    }
    let gets = 0;
    const realGet = deps.suppliers.get.bind(deps.suppliers);
    deps.suppliers.get = async (id: string) => {
      gets += 1;
      return realGet(id);
    };
    store.listedKeys = [];
    await readSupplierReplies.execute({ requestId: 'req-0' }, deps, CTX);
    expect(gets).toBe(0);
    expect(store.listedKeys.filter((key) => key.startsWith('order-calc:sent|'))).toEqual([]);
  });

  test('есть письмо: справочник и история читаются, письмо привязано', async () => {
    await open('req-1');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    const out = await readSupplierReplies.execute({ requestId: 'req-1' }, deps, CTX);
    expect(out.replies.map((reply) => reply.replyId)).toEqual(['in:m1']);
  });
});
