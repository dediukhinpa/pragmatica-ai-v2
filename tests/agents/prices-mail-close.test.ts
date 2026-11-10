import { describe, expect, test } from 'bun:test';
import { MAIL_FILE_NAMESPACE } from '../../src/agents/prices/deps';
import { saveMail, type MailRecord } from '../../src/agents/prices/price-state';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import type { JsonValue } from '@business-ai/core';
import { buildMailboxPricesDeps } from './prices-support';

/** Считает чтения и записи содержимого вложений: закрытие письма их трогать не должно. */
class FileTrafficStore extends MemoryWorkflowStateStore {
  fileReads = 0;
  fileWrites = 0;

  override async get(namespace: string, key: string): Promise<JsonValue | null> {
    if (namespace === MAIL_FILE_NAMESPACE) this.fileReads += 1;
    return super.get(namespace, key);
  }

  override async put(
    namespace: string,
    key: string,
    value: JsonValue,
    options?: { done?: boolean },
  ): Promise<void> {
    if (namespace === MAIL_FILE_NAMESPACE) this.fileWrites += 1;
    return super.put(namespace, key, value, options);
  }
}

const FUTURE_MS = 60_000;
const ATTACHMENTS = 3;

function record(status: MailRecord['status']): MailRecord {
  return {
    id: 'u1:m1',
    from: 'a@b.ru',
    subject: 'Прайс',
    receivedAt: '2026-01-01T00:00:00.000Z',
    bodyExcerpt: 'текст',
    status,
    attachments: Array.from({ length: ATTACHMENTS }, (_, index) => ({
      index,
      fileName: `f${index}.xlsx`,
      mimeType: 'application/octet-stream',
      sizeBytes: 10,
      isScan: false,
      stored: index !== 1,
    })),
  };
}

interface Setup {
  store: FileTrafficStore;
  save: (r: MailRecord) => Promise<void>;
}

async function setup(): Promise<Setup> {
  const store = new FileTrafficStore();
  const base = await buildMailboxPricesDeps();
  const deps = { ...base, state: store };
  for (const index of [0, 1, 2]) {
    await store.put(MAIL_FILE_NAMESPACE, `a:u1:m1#${index}`, { base64: 'AAAA' });
  }
  store.fileWrites = 0;
  return { store, save: (r) => saveMail(deps, r) };
}

describe('закрытие письма: вложения', () => {
  test('помечаются done без чтения и перезаписи содержимого', async () => {
    const { store, save } = await setup();
    await save(record('handled'));
    expect(store.fileReads).toBe(0);
    expect(store.fileWrites).toBe(0);
    // Ретенция удаляет сохранённые вложения (0 и 2); несохранённое (1) осталось живым.
    await store.purgeOlderThan(new Date(Date.now() + FUTURE_MS));
    expect(await store.get(MAIL_FILE_NAMESPACE, 'a:u1:m1#0')).toBeNull();
    expect(await store.get(MAIL_FILE_NAMESPACE, 'a:u1:m1#1')).toEqual({ base64: 'AAAA' });
    expect(await store.get(MAIL_FILE_NAMESPACE, 'a:u1:m1#2')).toBeNull();
  });

  test('открытое письмо вложения не трогает', async () => {
    const { store, save } = await setup();
    await save(record('new'));
    expect(await store.purgeOlderThan(new Date(Date.now() + FUTURE_MS))).toBe(0);
  });

  test('уже удалённое вложение не мешает закрытию и не создаётся заново', async () => {
    const { store, save } = await setup();
    await store.delete(MAIL_FILE_NAMESPACE, 'a:u1:m1#0');
    await save(record('handled'));
    expect(await store.list(MAIL_FILE_NAMESPACE, null, 10)).toHaveLength(2);
  });
});
