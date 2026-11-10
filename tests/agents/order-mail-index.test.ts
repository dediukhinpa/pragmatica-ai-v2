import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  MAIL_INDEX_BACKFILL_NAMESPACE,
  UNASSIGNED_MAIL_NAMESPACE,
  STATE_SCAN_MAX_PAGES,
  STATE_SCAN_PAGE,
} from '../../src/agents/order-calc/deps';
import {
  assignSupplierMail,
  listUnassignedMailFor,
  mailToken,
  parseRouteButton,
  requestToken,
} from '../../src/agents/order-calc/reply-routing';
import { createToolContext } from '@business-ai/core';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import type { InboxMessage, JsonValue, WorkflowStateEntry } from '@business-ai/core';
import { buildOrderDeps, MAIL_OWNER, routeButtonAt, type OrderTestDeps } from './order-support';
import { MANAGER_THREAD } from './support';

const SENT_AT = '2026-03-01T00:00:00.000Z';
const AFTER = '2026-03-02T00:00:00.000Z';
const S1_EMAIL = 'sales@metall.test';
/** Больше предела обхода (STATE_SCAN_PAGE x STATE_SCAN_MAX_PAGES = 10 000 записей). */
const OVER_LIMIT = STATE_SCAN_PAGE * STATE_SCAN_MAX_PAGES + 500;
const WHO = { userId: 'manager-1', threadId: MANAGER_THREAD };

/** Хранилище с журналом: с какого ключа пространства писем читал каждый `list`. */
class JournalStore extends MemoryWorkflowStateStore {
  starts: string[] = [];
  override async list(
    namespace: string,
    afterKey: string | null,
    limit: number,
  ): Promise<WorkflowStateEntry[]> {
    if (namespace === UNASSIGNED_MAIL_NAMESPACE) this.starts.push(afterKey ?? '');
    return super.list(namespace, afterKey, limit);
  }
}

const SCHEDULER_CTX = createToolContext({
  threadId: MANAGER_THREAD,
  agentId: 'test-agent',
  operationId: 'op-plan',
  initiator: { kind: 'scheduler' },
});

/** Тесты с массовым заполнением состояния: под нагрузкой хоста им нужен запас по времени. */
const SLOW_TEST_MS = 30_000;

let deps: OrderTestDeps;
let store: JournalStore;

const read = (requestId: string) =>
  readSupplierReplies.execute({ requestId }, deps, SCHEDULER_CTX);

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

async function open(requestId: string, supplierIds = ['s1']): Promise<void> {
  await saveSelection(deps, { requestId, supplierIds, createdAt: SENT_AT });
  await saveSent(deps, { requestId, supplierIds, sentAt: SENT_AT, mailboxOwnerId: MAIL_OWNER });
}

/** Письмо на разнесении старого формата: основная запись есть, указателей нет. */
function legacyUnassigned(messageId: string, requestIds: string[]): JsonValue {
  return {
    messageId,
    token: mailToken(messageId),
    subject: 'КП',
    body: 'Арматура',
    receivedAt: AFTER,
    attachments: [],
    candidates: requestIds.map((requestId) => ({ requestId, supplierId: 's1' })),
    threadIds: [MANAGER_THREAD],
    askedThreadIds: [MANAGER_THREAD],
  };
}

const putLegacy = (messageId: string, requestIds: string[]): Promise<void> =>
  store.put(UNASSIGNED_MAIL_NAMESPACE, `m:${messageId}`, legacyUnassigned(messageId, requestIds));

/**
 * Обходы основных записей писем (с начала `m:` или `h:`) за время журнала. Чтение указателей
 * начинается с их префикса (`r:`, `t:`, `hr:`) и в эту выборку не входит.
 */
const mailScans = (): string[] => store.starts.filter((key) => key === 'm:' || key === 'h:');

beforeEach(async () => {
  deps = await buildOrderDeps();
  store = new JournalStore();
  deps.state = store;
});

describe('вторичные ключи писем на разнесении', () => {
  test('письмо без привязки записывается вместе с указателями t: и r:', async () => {
    await open('req-1');
    await open('req-2');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    await read('req-1');
    const token = mailToken('m1');
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, `t:${token}`)).toEqual({ messageId: 'm1' });
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'r:req-1:m1')).toEqual({ messageId: 'm1' });
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'r:req-2:m1')).toEqual({ messageId: 'm1' });
  });

  test('список по заявке и кнопка разнесения не обходят основные записи', async () => {
    await open('req-1');
    await open('req-2');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    const first = await read('req-1');
    expect(first.unassigned).toHaveLength(1);
    // id прежней кнопки берётся до замера: поиск письма для теста сам обходит пространство.
    const buttonId = await routeButtonAt(deps.state, 1);
    store.starts = [];
    expect((await read('req-2')).unassigned).toHaveLength(1);
    const press = parseRouteButton(buttonId);
    if (press === null) throw new Error('кнопка не разобрана');
    const outcome = await assignSupplierMail(deps.state, deps.clock, { ...press, ...WHO });
    expect(outcome).toEqual({ kind: 'assigned', requestId: 'req-2' });
    expect(mailScans()).toEqual([]);
  });

  test('после разнесения письмо уходит из списков, повторное нажатие даёт «уже разнесено»', async () => {
    await open('req-1');
    await open('req-2');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    await read('req-1');
    const press = parseRouteButton(await routeButtonAt(deps.state, 1));
    if (press === null) throw new Error('кнопка не разобрана');
    await assignSupplierMail(deps.state, deps.clock, { ...press, ...WHO });
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'r:req-1:m1')).toBeNull();
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'r:req-2:m1')).toBeNull();
    expect((await read('req-1')).unassigned).toEqual([]);
    const again = await assignSupplierMail(deps.state, deps.clock, {
      ...press,
      ...WHO,
      requestToken: requestToken('req-1'),
    });
    expect(again).toEqual({ kind: 'already_assigned', requestId: 'req-2' });
  });
});

describe('запасной путь: письма без указателей', () => {
  test('старая запись находится по заявке и вносится в индекс однократно', async () => {
    await putLegacy('old-1', ['req-1']);
    const found = await listUnassignedMailFor(deps, 'req-1');
    expect(found.map((item) => item.messageId)).toEqual(['old-1']);
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'r:req-1:old-1')).not.toBeNull();
    expect(await store.get(MAIL_INDEX_BACKFILL_NAMESPACE, 'v1')).not.toBeNull();
    store.starts = [];
    await listUnassignedMailFor(deps, 'req-1');
    expect(mailScans()).toEqual([]);
  });

  test('кнопка старого письма срабатывает: письмо находится по отпечатку', async () => {
    await open('req-1');
    await putLegacy('old-1', ['req-1']);
    const press = { mailToken: mailToken('old-1'), requestToken: requestToken('req-1') };
    const outcome = await assignSupplierMail(deps.state, deps.clock, { ...press, ...WHO });
    expect(outcome).toEqual({ kind: 'assigned', requestId: 'req-1' });
  });

  test('письмо без указателя, записанное после внесения, находится ограниченным обходом', async () => {
    await open('req-1');
    await listUnassignedMailFor(deps, 'req-1');
    await putLegacy('late-1', ['req-1']);
    const press = { mailToken: mailToken('late-1'), requestToken: requestToken('req-1') };
    const outcome = await assignSupplierMail(deps.state, deps.clock, { ...press, ...WHO });
    expect(outcome).toEqual({ kind: 'assigned', requestId: 'req-1' });
  });

  test('неизвестный отпечаток по-прежнему даёт unknown_mail', async () => {
    const press = { mailToken: 'нет-такого', requestToken: requestToken('req-1') };
    const outcome = await assignSupplierMail(deps.state, deps.clock, { ...press, ...WHO });
    expect(outcome).toEqual({ kind: 'unknown_mail' });
  });
});

describe('больше 10 тыс. писем на разнесении', () => {
  async function fill(): Promise<void> {
    for (let i = 0; i < OVER_LIMIT; i += 1) {
      await putLegacy(`a-${String(i).padStart(6, '0')}`, ['req-other']);
    }
  }

  test('письмо за пределом обхода находится по заявке и по кнопке', async () => {
    await open('req-1');
    await fill();
    await putLegacy('zzz-last', ['req-1']);
    const found = await listUnassignedMailFor(deps, 'req-1');
    expect(found.map((item) => item.messageId)).toEqual(['zzz-last']);
    const press = { mailToken: mailToken('zzz-last'), requestToken: requestToken('req-1') };
    const outcome = await assignSupplierMail(deps.state, deps.clock, { ...press, ...WHO });
    expect(outcome).toEqual({ kind: 'assigned', requestId: 'req-1' });
  }, SLOW_TEST_MS);

  test('после внесения запрос по заявке не обходит основные записи', async () => {
    await open('req-1');
    await fill();
    await listUnassignedMailFor(deps, 'req-1');
    store.starts = [];
    await listUnassignedMailFor(deps, 'req-1');
    expect(mailScans()).toEqual([]);
  }, SLOW_TEST_MS);
});

describe('письма без содержимого: указатели hr:', () => {
  const heldRecord = (messageId: string, requestId: string): JsonValue => ({
    messageId,
    token: mailToken(messageId),
    subject: 'КП',
    body: '',
    receivedAt: AFTER,
    attachments: [],
    supplierIds: ['s1'],
    contentOmitted: 'too_large',
    candidates: [{ requestId, supplierId: 's1' }],
    threadIds: [MANAGER_THREAD],
    notifiedThreadIds: [MANAGER_THREAD],
    attempts: 0,
  });

  test('новое письмо без содержимого получает указатель и видно в ответе чтения', async () => {
    await open('req-1');
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1', { body: '', contentOmitted: 'too_large' }));
    const result = await read('req-1');
    expect(result.contentOmitted.map((item) => item.reason)).toEqual(['too_large']);
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'hr:req-1:m1')).toEqual({ messageId: 'm1' });
  });

  test('старая запись h: без указателя подхватывается однократным внесением', async () => {
    await open('req-1');
    await store.put(UNASSIGNED_MAIL_NAMESPACE, 'h:old-h', heldRecord('old-h', 'req-1'));
    const result = await read('req-1');
    expect(result.contentOmitted.map((item) => item.reason)).toEqual(['too_large']);
    expect(await store.get(UNASSIGNED_MAIL_NAMESPACE, 'hr:req-1:old-h')).not.toBeNull();
  });
});
