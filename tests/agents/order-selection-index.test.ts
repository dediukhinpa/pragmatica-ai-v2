import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  INBOX_CURSOR_NAMESPACE,
  OPEN_SELECTION_BACKFILL_NAMESPACE,
  OPEN_SELECTION_NAMESPACE,
  SELECTION_NAMESPACE,
  STATE_SCAN_MAX_PAGES,
  STATE_SCAN_PAGE,
} from '../../src/agents/order-calc/deps';
import { createToolContext } from '@business-ai/core';
import { listOpenSelections } from '../../src/agents/order-calc/open-selections';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import type { InboxMessage, JsonValue, WorkflowStateEntry } from '@business-ai/core';
import { buildOrderDeps, MAIL_OWNER, type OrderTestDeps } from './order-support';
import { MANAGER_THREAD } from './support';

const SENT_AT = '2026-03-01T00:00:00.000Z';
const AFTER = '2026-03-02T00:00:00.000Z';
/** Больше предела обхода (STATE_SCAN_PAGE x STATE_SCAN_MAX_PAGES = 10 000 записей). */
const OVER_LIMIT = STATE_SCAN_PAGE * STATE_SCAN_MAX_PAGES + 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Хранилище, считающее обращения `list` по пространствам. */
class CountingStore extends MemoryWorkflowStateStore {
  listCalls = new Map<string, number>();
  override async list(
    namespace: string,
    afterKey: string | null,
    limit: number,
  ): Promise<WorkflowStateEntry[]> {
    this.listCalls.set(namespace, (this.listCalls.get(namespace) ?? 0) + 1);
    return super.list(namespace, afterKey, limit);
  }
}

const READER_CTX = createToolContext({
  threadId: MANAGER_THREAD,
  agentId: 'test-agent',
  operationId: 'op-plan',
  initiator: { kind: 'scheduler' },
});

/** Тесты с массовым заполнением состояния: под нагрузкой хоста им нужен запас по времени. */
const SLOW_TEST_MS = 30_000;

let deps: OrderTestDeps;
let store: CountingStore;
let events: Array<{ event: string; fields: Record<string, unknown> | undefined }>;

const selectionValue = (requestId: string, supplierIds: string[]): JsonValue => ({
  requestId,
  supplierIds,
  createdAt: SENT_AT,
});

/** Выбор старого формата: записан только в пространство выборов, индекса нет. */
async function putLegacySelection(requestId: string, supplierIds = ['s1']): Promise<void> {
  await store.put(SELECTION_NAMESPACE, requestId, selectionValue(requestId, supplierIds));
}

/** Массовые выборы-заполнители, уже закрытые просрочкой: ключи идут раньше целевого. */
async function fillLegacy(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await store.put(SELECTION_NAMESPACE, `a-${String(i).padStart(6, '0')}`, {
      requestId: `a-${i}`,
      supplierIds: ['s9'],
      createdAt: '2020-01-01T00:00:00.000Z',
    });
  }
}

function mail(id: string): InboxMessage {
  return {
    id,
    from: 'sales@metall.test',
    subject: 'КП',
    body: 'Арматура 50 руб.',
    receivedAt: AFTER,
    attachments: [],
  };
}

beforeEach(async () => {
  deps = await buildOrderDeps();
  store = new CountingStore();
  deps.state = store;
  events = [];
  deps.log = (event, fields) => events.push({ event, fields });
});

describe('индекс открытых выборов', () => {
  test('saveSelection пишет и выбор, и индекс; листинг отдаёт выбор', async () => {
    await saveSelection(deps, { requestId: 'req-1', supplierIds: ['s1'], createdAt: SENT_AT });
    expect(await store.get(OPEN_SELECTION_NAMESPACE, 'req-1')).toEqual(
      selectionValue('req-1', ['s1']),
    );
    expect(await listOpenSelections(deps)).toEqual([
      { requestId: 'req-1', supplierIds: ['s1'], createdAt: SENT_AT },
    ]);
  });

  test('после записи запроса всем выбранным выбор снимается с индекса', async () => {
    await saveSelection(deps, { requestId: 'req-1', supplierIds: ['s1'], createdAt: SENT_AT });
    await saveSent(deps, { requestId: 'req-1', supplierIds: ['s1'], sentAt: SENT_AT });
    expect(await listOpenSelections(deps)).toEqual([]);
    expect(await store.get(OPEN_SELECTION_NAMESPACE, 'req-1')).toBeNull();
    // Сам выбор остаётся: его читают другие инструменты.
    expect(await store.get(SELECTION_NAMESPACE, 'req-1')).not.toBeNull();
  });

  test('запрос ушёл части поставщиков: в индексе остаются остальные', async () => {
    await saveSelection(deps, {
      requestId: 'req-1',
      supplierIds: ['s1', 's2'],
      createdAt: SENT_AT,
    });
    await saveSent(deps, { requestId: 'req-1', supplierIds: ['s1'], sentAt: SENT_AT });
    const [open] = await listOpenSelections(deps);
    expect(open?.supplierIds).toEqual(['s2']);
  });

  test('выбор старше окна ответов снимается с индекса', async () => {
    await saveSelection(deps, { requestId: 'req-1', supplierIds: ['s1'], createdAt: SENT_AT });
    deps.clock.advance(120 * DAY_MS);
    expect(await listOpenSelections(deps)).toEqual([]);
    expect(await store.get(OPEN_SELECTION_NAMESPACE, 'req-1')).toBeNull();
  });
});

describe('запасной путь: выборы без индекса', () => {
  test('старый выбор подхватывается однократным внесением в индекс', async () => {
    await putLegacySelection('req-old');
    expect(await listOpenSelections(deps)).toHaveLength(1);
    expect(await store.get(OPEN_SELECTION_NAMESPACE, 'req-old')).not.toBeNull();
    expect(await store.get(OPEN_SELECTION_BACKFILL_NAMESPACE, 'v1')).not.toBeNull();
    expect(events.map((item) => item.event)).toContain('order_selection_index_backfilled');
  });

  test('после отметки пространство выборов больше не обходится', async () => {
    await putLegacySelection('req-old');
    await listOpenSelections(deps);
    store.listCalls.clear();
    await listOpenSelections(deps);
    expect(store.listCalls.get(SELECTION_NAMESPACE)).toBeUndefined();
  });

  test('внесение не затирает запись, сделанную новым кодом', async () => {
    await putLegacySelection('req-1', ['s1']);
    await saveSelection(deps, { requestId: 'req-1', supplierIds: ['s1', 's2'], createdAt: SENT_AT });
    const [open] = await listOpenSelections(deps);
    expect(open?.supplierIds).toEqual(['s1', 's2']);
  });

  test('старый выбор не теряется, даже когда выборов больше предела обхода', async () => {
    await fillLegacy(OVER_LIMIT);
    await putLegacySelection('zz-legacy-last');
    const open = await listOpenSelections(deps);
    expect(open.map((item) => item.requestId)).toEqual(['zz-legacy-last']);
  }, SLOW_TEST_MS);
});

describe('больше 10 тыс. выборов', () => {
  test('свежий выбор находится по индексу, хотя его ключ за пределом обхода выборов', async () => {
    await fillLegacy(OVER_LIMIT);
    await listOpenSelections(deps);
    await saveSelection(deps, { requestId: 'zz-fresh', supplierIds: ['s1'], createdAt: SENT_AT });
    store.listCalls.clear();
    const open = await listOpenSelections(deps);
    expect(open.map((item) => item.requestId)).toEqual(['zz-fresh']);
    // Один вызов list по индексу, а не 50 страниц по выборам.
    expect(store.listCalls.get(OPEN_SELECTION_NAMESPACE)).toBe(1);
    expect(store.listCalls.get(SELECTION_NAMESPACE)).toBeUndefined();
  }, SLOW_TEST_MS);

  test('письмо до записи запроса не пропускается, а после записи разбирается', async () => {
    await fillLegacy(OVER_LIMIT);
    await listOpenSelections(deps);
    await saveSelection(deps, { requestId: 'zz-fresh', supplierIds: ['s1'], createdAt: SENT_AT });
    deps.mailboxes.deliver(MAIL_OWNER, mail('m1'));
    // Письмо уже в ящике, запрос ещё не записан; ответ разберётся после записи.
    await saveSent(deps, {
      requestId: 'zz-fresh',
      supplierIds: ['s1'],
      sentAt: SENT_AT,
      mailboxOwnerId: MAIL_OWNER,
    });
    const result = await readSupplierReplies.execute({ requestId: 'zz-fresh' }, deps, READER_CTX);
    expect(result.replies.map((reply) => reply.replyId)).toEqual(['in:m1']);
    expect(await store.get(INBOX_CURSOR_NAMESPACE, MAIL_OWNER)).toEqual({ cursor: '1' });
  }, SLOW_TEST_MS);

  test('индекс длиннее предела: обход усекается и пишется в журнал', async () => {
    await store.put(OPEN_SELECTION_BACKFILL_NAMESPACE, 'v1', { doneAt: SENT_AT });
    for (let i = 0; i < OVER_LIMIT; i += 1) {
      const id = `r-${String(i).padStart(6, '0')}`;
      await store.put(OPEN_SELECTION_NAMESPACE, id, selectionValue(id, ['s1']));
    }
    const open = await listOpenSelections(deps);
    expect(open).toHaveLength(STATE_SCAN_PAGE * STATE_SCAN_MAX_PAGES);
    const limit = events.find((item) => item.event === 'order_state_scan_limit');
    expect(limit?.fields?.['namespace']).toBe(OPEN_SELECTION_NAMESPACE);
  }, SLOW_TEST_MS);
});
