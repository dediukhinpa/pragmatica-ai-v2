import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChannel, ChatFile, ChatMessage, TempDiskFile } from '@business-ai/core';
import {
  FLUSH_MAX_ATTEMPTS,
  LAST_FILE_MAX_BYTES,
  LAST_FILE_TTL_MS,
  LAST_FILES_TOTAL_MAX_BYTES,
  TURN_FAILED_NOTE_TEXT,
  configureTurnFileBuffer,
  currentTurnFiles,
  fileSendFailedText,
  flushTurnFiles,
  isTurnFileBufferEnabled,
  lastTurnFileOf,
  resetTurnFileBufferForTests,
  runWithTurnFiles,
  turnFileChat,
} from '../../src/turn-file-buffer';

const THREAD = 'thread-1';
const MIB = 1024 * 1024;
const FAST_RETRY_MS = 1;

/** Вызов отправки файла, записанный подменой канала. */
interface SentFile {
  threadId: string;
  name: string;
  text: string;
  key: string;
}

/** Подменный канал: пишет вызовы; сбои задаются числом первых отказов. */
class FakeChat implements ChatChannel {
  readonly files: SentFile[] = [];
  readonly replies: Array<{ threadId: string; text: string; key: string }> = [];
  failFileTimes = 0;
  fileAttempts = 0;
  onEvent(): void {}
  async reply(threadId: string, message: ChatMessage, key: string): Promise<void> {
    this.replies.push({ threadId, text: message.text, key });
  }
  async sendFile(threadId: string, file: ChatFile, key: string): Promise<void> {
    this.fileAttempts += 1;
    if (this.failFileTimes > 0) {
      this.failFileTimes -= 1;
      throw new Error('секретный текст ошибки канала');
    }
    const text = new TextDecoder().decode(file.content);
    this.files.push({ threadId, name: file.name, text, key });
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const xlsx = (name: string, text: string): ChatFile => ({
  name,
  mimeType: 'application/vnd.ms-excel',
  content: bytes(text),
});

let events: Array<{ event: string; fields: Record<string, unknown> }> = [];
const log = (event: string, fields: Record<string, unknown> = {}): void => {
  events.push({ event, fields });
};

beforeEach(() => {
  events = [];
  resetTurnFileBufferForTests();
  configureTurnFileBuffer({ enabled: true, log, retryDelayMs: FAST_RETRY_MS });
});
afterEach(() => resetTurnFileBufferForTests());

describe('буфер файлов хода', () => {
  test('красный-до: выключенный буфер шлёт оба файла сразу, как на бою', async () => {
    configureTurnFileBuffer({ enabled: false, log });
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('price.xlsx', 'неполный'), 'k1');
      await chat.sendFile(THREAD, xlsx('price.xlsx', 'полный'), 'k2');
    });
    expect(isTurnFileBufferEnabled()).toBe(false);
    expect(inner.files.map((f) => f.text)).toEqual(['неполный', 'полный']);
  });

  test('две правки одного файла за ход: после flush один sendFile со второй правкой', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('price.xlsx', 'неполный'), 'k1');
      await chat.sendFile(THREAD, xlsx('price.xlsx', 'полный'), 'k2');
      return currentTurnFiles();
    });
    expect(store).toBeDefined();
    expect(inner.files).toHaveLength(0);
    await flushTurnFiles(store!, 'ok');
    expect(inner.files).toEqual([
      { threadId: THREAD, name: 'price.xlsx', text: 'полный', key: 'k2' },
    ]);
  });

  test('разные имена: уходят оба, в порядке первой регистрации имени', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('a.xlsx', 'a1'), 'k1');
      await chat.sendFile(THREAD, xlsx('b.xlsx', 'b1'), 'k2');
      await chat.sendFile(THREAD, xlsx('a.xlsx', 'a2'), 'k3');
      return currentTurnFiles();
    });
    await flushTurnFiles(store!, 'ok');
    expect(inner.files.map((f) => `${f.name}:${f.text}`)).toEqual(['a.xlsx:a2', 'b.xlsx:b1']);
  });

  test('тот же файл в разных тредах - разные файлы', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile('t1', xlsx('a.xlsx', 'x'), 'k1');
      await chat.sendFile('t2', xlsx('a.xlsx', 'y'), 'k2');
      return currentTurnFiles();
    });
    await flushTurnFiles(store!, 'ok');
    expect(inner.files).toHaveLength(2);
  });

  test('вне контекста хода файл уходит сразу', async () => {
    const inner = new FakeChat();
    await turnFileChat(inner).sendFile(THREAD, xlsx('a.xlsx', 'x'), 'k1');
    expect(inner.files).toHaveLength(1);
    expect(currentTurnFiles()).toBeUndefined();
  });

  test('повторный flush ничего не шлёт', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('a.xlsx', 'x'), 'k1');
      return currentTurnFiles();
    });
    await flushTurnFiles(store!, 'ok');
    await flushTurnFiles(store!, 'ok');
    await flushTurnFiles(store!, 'failed');
    expect(inner.files).toHaveLength(1);
    expect(inner.replies).toHaveLength(0);
  });

  test('после flush новый файл в том же ходе уходит сразу, а не теряется', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    await runWithTurnFiles(async () => {
      const store = currentTurnFiles()!;
      await flushTurnFiles(store, 'ok');
      await chat.sendFile(THREAD, xlsx('a.xlsx', 'x'), 'k1');
    });
    expect(inner.files).toHaveLength(1);
  });

  test("outcome 'failed': файл и одна пометка на тред со стабильным ключом", async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const run = async () =>
      runWithTurnFiles(async () => {
        await chat.sendFile(THREAD, xlsx('a.xlsx', 'x'), 'k1');
        await chat.sendFile(THREAD, xlsx('b.xlsx', 'y'), 'k2');
        return currentTurnFiles()!;
      });
    const first = await run();
    await flushTurnFiles(first, 'failed');
    expect(inner.files).toHaveLength(2);
    expect(inner.replies).toHaveLength(1);
    expect(inner.replies[0]?.text).toBe(TURN_FAILED_NOTE_TEXT);
    const second = await run();
    await flushTurnFiles(second, 'failed');
    // тот же набор ключей - тот же ключ идемпотентности пометки
    expect(inner.replies[1]?.key).toBe(inner.replies[0]?.key);
  });

  test('сбой три раза: журнал без имени и текста ошибки, пометка, без исключения', async () => {
    const inner = new FakeChat();
    inner.failFileTimes = FLUSH_MAX_ATTEMPTS;
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('секрет.xlsx', 'x'), 'k1');
      return currentTurnFiles()!;
    });
    await flushTurnFiles(store, 'ok');
    expect(inner.fileAttempts).toBe(FLUSH_MAX_ATTEMPTS);
    expect(events.some((e) => e.event === 'turn_file_send_failed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('секрет');
    expect(inner.replies.map((r) => r.text)).toEqual([fileSendFailedText('секрет.xlsx')]);
    expect(lastTurnFileOf(THREAD)).toBeUndefined();
  });

  test('сбой один раз: повторная попытка доставляет файл', async () => {
    const inner = new FakeChat();
    inner.failFileTimes = 1;
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('a.xlsx', 'x'), 'k1');
      return currentTurnFiles()!;
    });
    await flushTurnFiles(store, 'ok');
    expect(inner.files).toHaveLength(1);
    expect(inner.replies).toHaveLength(0);
  });

  test('файл на диске: содержимое сохраняется, оригинал можно удалять после sendFile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-file-'));
    const path = join(dir, 'big.xlsx');
    writeFileSync(path, 'содержимое с диска');
    let disposed = 0;
    const disk: TempDiskFile = {
      path,
      size: bytes('содержимое с диска').byteLength,
      dispose: async () => {
        disposed += 1;
        rmSync(path);
      },
    };
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    try {
      const store = await runWithTurnFiles(async () => {
        const file: ChatFile = { name: 'big.xlsx', mimeType: 'x', content: new Uint8Array(), disk };
        try {
          await chat.sendFile(THREAD, file, 'k1');
        } finally {
          await file.disk?.dispose();
        }
        return currentTurnFiles()!;
      });
      expect(disposed).toBe(1);
      await flushTurnFiles(store, 'ok');
      expect(inner.files[0]?.text).toBe('содержимое с диска');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('превышение предела отложенного: файл уходит сразу, событие в журнал', async () => {
    const limit = 10;
    configureTurnFileBuffer({
      enabled: true,
      log,
      retryDelayMs: FAST_RETRY_MS,
      pendingMaxBytes: limit,
    });
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('a.xlsx', '123456'), 'k1');
      await chat.sendFile(THREAD, xlsx('b.xlsx', '1234567'), 'k2');
      return currentTurnFiles()!;
    });
    expect(inner.files.map((f) => f.name)).toEqual(['b.xlsx']);
    expect(events.some((e) => e.event === 'turn_file_defer_skipped')).toBe(true);
    await flushTurnFiles(store, 'ok');
    expect(inner.files.map((f) => f.name)).toEqual(['b.xlsx', 'a.xlsx']);
  });

  test('необязательные методы канала делегируются только если они есть', async () => {
    const bare = turnFileChat(new FakeChat());
    expect(bare.typing).toBeUndefined();
    expect(bare.updateMessage).toBeUndefined();
    const calls: string[] = [];
    const rich: ChatChannel = {
      ...new FakeChat(),
      onEvent: () => undefined,
      reply: async () => undefined,
      sendFile: async () => undefined,
      typing: async (t) => void calls.push(`typing:${t}`),
      updateMessage: async (t, d) => void calls.push(`update:${t}:${d}`),
    };
    const wrapped = turnFileChat(rich);
    await wrapped.typing?.('t');
    await wrapped.updateMessage?.('t', 'd', { text: 'x' });
    expect(calls).toEqual(['typing:t', 'update:t:d']);
  });
});

describe('кэш последнего файла', () => {
  test('сразу отправленный и flush-файл попадают в кэш; последний перекрывает', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    await chat.sendFile(THREAD, xlsx('a.xlsx', 'первый'), 'k1');
    expect(lastTurnFileOf(THREAD)?.name).toBe('a.xlsx');
    const store = await runWithTurnFiles(async () => {
      await chat.sendFile(THREAD, xlsx('b.xlsx', 'второй'), 'k2');
      return currentTurnFiles()!;
    });
    expect(lastTurnFileOf(THREAD)?.name).toBe('a.xlsx');
    await flushTurnFiles(store, 'ok');
    const last = lastTurnFileOf(THREAD);
    expect(last?.name).toBe('b.xlsx');
    expect(new TextDecoder().decode(last?.content)).toBe('второй');
    expect(Number.isNaN(Date.parse(last?.sentAt ?? ''))).toBe(false);
  });

  test('срок жизни: через 6 часов файл не отдаётся', async () => {
    const inner = new FakeChat();
    const now = Date.now();
    const spy = spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      await turnFileChat(inner).sendFile(THREAD, xlsx('a.xlsx', 'x'), 'k1');
      spy.mockReturnValue(now + LAST_FILE_TTL_MS - 1);
      expect(lastTurnFileOf(THREAD)).toBeDefined();
      spy.mockReturnValue(now + LAST_FILE_TTL_MS + 1);
      expect(lastTurnFileOf(THREAD)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test('слишком большой файл в кэш не кладётся', async () => {
    const inner = new FakeChat();
    const big: ChatFile = {
      name: 'big.xlsx',
      mimeType: 'x',
      content: new Uint8Array(LAST_FILE_MAX_BYTES + 1),
    };
    await turnFileChat(inner).sendFile(THREAD, big, 'k1');
    expect(inner.files).toHaveLength(1);
    expect(lastTurnFileOf(THREAD)).toBeUndefined();
  });

  test('общий предел: вытесняются самые старые', async () => {
    const inner = new FakeChat();
    const chat = turnFileChat(inner);
    const size = LAST_FILE_MAX_BYTES;
    const count = LAST_FILES_TOTAL_MAX_BYTES / size + 1;
    for (let i = 0; i < count; i += 1) {
      const content = new Uint8Array(size);
      await chat.sendFile(`t${i}`, { name: 'f', mimeType: 'x', content }, `k${i}`);
    }
    expect(lastTurnFileOf('t0')).toBeUndefined();
    expect(lastTurnFileOf(`t${count - 1}`)).toBeDefined();
    expect(LAST_FILES_TOTAL_MAX_BYTES / MIB).toBeGreaterThan(0);
  });
});
