import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryAuditRepository,
  MemoryIntakeStore,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import type { ChatEvent, ProjectContext } from '@business-ai/core';
import { tempDir } from '@business-ai/testing';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import {
  CHAT_ATTACHMENTS_EVICT_ACTION,
  agentOfBot,
  auditChatAttachments,
  wireChatAttachments,
} from '../../src/assembly/chat-attachments';
import { CHAT_ATTACHMENTS_DIR, type ChatAttachmentRecord } from '../../src/chat-attachments';
import type { PragmatikaConfig } from '../../src/config';
import { clearPragmatikaRuntime, setPragmatikaRuntime } from '../../src/runtime';
import {
  CHAT_ATTACHMENTS_PURGE_JOB,
  PROJECT_SCHEDULES,
} from '../../src/schedules';
import { RecordingChannel, buildPump, recordingRuntime } from './chat-support';

/** Срок и объём по умолчанию, как у боевой конфигурации. */
const RETENTION_DAYS = 30;
const MAX_BYTES = 3 * 1024 * 1024 * 1024;
const MS_PER_DAY = 86_400_000;

interface WiringOptions {
  enabled?: boolean;
  root?: string;
  maxBytes?: number;
  chatBots?: Record<string, string>;
}

/** Контекст сборки с тем, что читает `wireChatAttachments`; остальное проекту не нужно. */
function makeContext(options: WiringOptions = {}) {
  const channel = new RecordingChannel();
  const logs: Array<{ event: string; fields: unknown }> = [];
  const audit = new MemoryAuditRepository();
  const clock = new FixedClock();
  const root = options.root ?? tempDir();
  const ctx = {
    config: {
      intake: { root },
      service: { chatBots: options.chatBots ?? { 'bot-docs': 'documents' } },
    },
    project: {
      CHAT_ATTACHMENTS_STORE_ENABLED: options.enabled === false ? 'false' : 'true',
      CHAT_ATTACHMENTS_RETENTION_DAYS: RETENTION_DAYS,
      CHAT_ATTACHMENTS_MAX_BYTES: options.maxBytes ?? MAX_BYTES,
    },
    services: {
      chat: channel,
      audit,
      clock,
      log: (event: string, fields?: unknown) => logs.push({ event, fields }),
    },
  } as unknown as ProjectContext<PragmatikaConfig>;
  return { ctx, channel, logs, audit, clock, root };
}

function fileEvent(name: string, text: string, extra: Partial<ChatEvent> = {}): ChatEvent {
  return {
    kind: 'file',
    threadId: 'thread-1',
    userId: 'u-100',
    botId: 'bot-docs',
    sourceKey: `evt-${name}`,
    file: { name, mimeType: 'application/octet-stream', content: new TextEncoder().encode(text) },
    ...extra,
  } as ChatEvent;
}

function recordsOf(root: string): ChatAttachmentRecord[] {
  const dir = join(root, CHAT_ATTACHMENTS_DIR, 'index');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ChatAttachmentRecord);
}


describe('перехват файлов канала (этап 9s)', () => {
  test('файл любого бота сохраняется: агент, бот, сотрудник и тред попадают в индекс', async () => {
    const { ctx, channel, root } = makeContext();
    wireChatAttachments(ctx);
    await channel.emit(fileEvent('Счёт 5.pdf', 'содержимое'));
    const [record, ...rest] = recordsOf(root);
    expect(rest).toHaveLength(0);
    expect(record?.agent).toBe('documents');
    expect(record?.bot).toBe('bot-docs');
    expect(record?.user).toBe('u-100');
    expect(record?.name).toBe('Счёт 5.pdf');
    expect(record?.key).toBe('evt-Счёт 5.pdf');
  });

  test('не файловые события (сообщение, кнопка) ничего не сохраняют', async () => {
    const { ctx, channel, root } = makeContext();
    wireChatAttachments(ctx);
    await channel.emit({ kind: 'message', threadId: 't', userId: 'u', text: 'привет' });
    await channel.emit({ kind: 'button', threadId: 't', userId: 'u', buttonId: 'x' } as ChatEvent);
    expect(recordsOf(root)).toHaveLength(0);
  });

  test('режим одного бота: агент по умолчанию, бот пустой', async () => {
    const { ctx, channel, root } = makeContext();
    wireChatAttachments(ctx);
    await channel.emit(fileEvent('a.txt', 'a', { botId: undefined }));
    const [record] = recordsOf(root);
    expect(record?.agent).toBe(ORDER_CALC_AGENT_ID);
    expect(record?.bot).toBe('');
  });

  test('неизвестный бот: агент пустой, файл всё равно сохранён', async () => {
    const { ctx, channel, root } = makeContext();
    wireChatAttachments(ctx);
    await channel.emit(fileEvent('a.txt', 'a', { botId: 'bot-unknown' }));
    expect(recordsOf(root)[0]?.agent).toBe('');
  });

  test('файл на диске (спул) сохраняется без чтения в память', async () => {
    const { ctx, channel, root } = makeContext();
    wireChatAttachments(ctx);
    const spool = join(tempDir(), 'big.bin');
    writeFileSync(spool, 'x'.repeat(5000));
    const event = fileEvent('big.bin', '', {
      file: {
        name: 'big.bin',
        mimeType: 'application/octet-stream',
        content: new Uint8Array(0),
        disk: { path: spool, size: 5000, dispose: async () => undefined },
      },
    } as Partial<ChatEvent>);
    await channel.emit(event);
    expect(recordsOf(root)[0]?.size).toBe(5000);
  });

  test('флаг выключен: обработчик не ставится, файлы не сохраняются', async () => {
    const { ctx, channel, root } = makeContext({ enabled: false });
    wireChatAttachments(ctx);
    expect(channel.handlers).toHaveLength(0);
    await channel.emit(fileEvent('a.txt', 'a'));
    expect(existsSync(join(root, CHAT_ATTACHMENTS_DIR))).toBe(false);
  });

  test('сбой записи не бросается наружу: событие доходит до остальных обработчиков', async () => {
    const root = tempDir();
    // Корень приёма - обычный файл: каталог архива создать нельзя.
    const blocked = join(root, 'not-a-dir');
    writeFileSync(blocked, 'x');
    const { ctx, channel, logs } = makeContext({ root: blocked });
    wireChatAttachments(ctx);
    let reached = false;
    channel.onEvent(async () => {
      reached = true;
    });
    await channel.emit(fileEvent('a.txt', 'a'));
    expect(reached).toBe(true);
    expect(logs.some((entry) => entry.event === 'chat_attachment_failed')).toBe(true);
  });

  test('каталог только для чтения: ответ ходу не ломается', async () => {
    const root = tempDir();
    mkdirSync(join(root, CHAT_ATTACHMENTS_DIR), { recursive: true });
    chmodSync(join(root, CHAT_ATTACHMENTS_DIR), 0o500);
    const { ctx, channel, logs } = makeContext({ root });
    wireChatAttachments(ctx);
    let reached = false;
    channel.onEvent(async () => {
      reached = true;
    });
    await channel.emit(fileEvent('a.txt', 'a'));
    chmodSync(join(root, CHAT_ATTACHMENTS_DIR), 0o700);
    expect(reached).toBe(true);
    expect(logs.some((entry) => entry.event === 'chat_attachment_failed')).toBe(true);
  });

  test('в журнале службы нет имён файлов и содержимого', async () => {
    const { ctx, channel, logs } = makeContext();
    wireChatAttachments(ctx);
    await channel.emit(fileEvent('Секретный договор.pdf', 'паспорт 4500 123456'));
    const text = JSON.stringify(logs);
    expect(text).not.toContain('Секретный');
    expect(text).not.toContain('паспорт');
    expect(logs.some((entry) => entry.event === 'chat_attachment_saved')).toBe(true);
  });

  test('вытеснение по объёму пишет событие в журнал и аудит', async () => {
    const { ctx, channel, logs, audit } = makeContext({ maxBytes: 4000 });
    wireChatAttachments(ctx);
    await channel.emit(fileEvent('a.bin', 'a'.repeat(1500), { sourceKey: 'k1' } as never));
    await channel.emit(fileEvent('b.bin', 'b'.repeat(1500), { sourceKey: 'k2' } as never));
    await channel.emit(fileEvent('c.bin', 'c'.repeat(1500), { sourceKey: 'k3' } as never));
    expect(logs.some((entry) => entry.event === CHAT_ATTACHMENTS_EVICT_ACTION)).toBe(true);
    // Аудит пишется без ожидания: даём ему завершиться.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entries = await audit.list('chat-attachments');
    expect(entries.some((entry) => entry.action === CHAT_ATTACHMENTS_EVICT_ACTION)).toBe(true);
  });
});

describe('агент бота', () => {
  test('бот из CHAT_BOTS, неизвестный бот, режим одного бота', () => {
    expect(agentOfBot({ b1: 'prices' }, 'b1')).toBe('prices');
    expect(agentOfBot({ b1: 'prices' }, 'zz')).toBe('');
    expect(agentOfBot(undefined, undefined)).toBe(ORDER_CALC_AGENT_ID);
  });
});

describe('аудит архива', () => {
  test('сбой аудита не бросается', async () => {
    const broken = {
      append: async () => {
        throw new Error('db down');
      },
      list: async () => [],
    };
    await auditChatAttachments(broken, new FixedClock(), 'x', { files: 1 });
  });
});

describe('ежедневная очистка', () => {
  test('задача есть в расписании: раз в сутки, выключается флагом', () => {
    const job = PROJECT_SCHEDULES.find((item) => item.name === CHAT_ATTACHMENTS_PURGE_JOB);
    expect(job).toBeDefined();
    expect(job?.repeat).toEqual({ everyMs: MS_PER_DAY, firstRunDelayMs: 900_000 });
    const on = { project: { CHAT_ATTACHMENTS_STORE_ENABLED: 'true' } };
    const off = { project: { CHAT_ATTACHMENTS_STORE_ENABLED: 'false' } };
    expect(job?.enabled?.(on as never)).toBe(true);
    expect(job?.enabled?.(off as never)).toBe(false);
  });

  test('обработчик удаляет просроченное и пишет числа в журнал и аудит', async () => {
    const { ctx, channel, root, audit, clock } = makeContext();
    const archive = wireChatAttachments(ctx);
    setPragmatikaRuntime({ chatAttachments: archive } as never);
    try {
      await channel.emit(fileEvent('old.txt', 'старый'));
      const job = PROJECT_SCHEDULES.find((item) => item.name === CHAT_ATTACHMENTS_PURGE_JOB);
      const logged: Array<{ event: string; fields: unknown }> = [];
      const handler = job?.handler({
        audit,
        clock,
        log: (event: string, fields?: unknown) => logged.push({ event, fields }),
        app: {},
      } as never);
      // Через 31 сутки запись просрочена.
      const later = new Date(Date.now() + (RETENTION_DAYS + 1) * MS_PER_DAY);
      await handler?.({} as never, later);
      expect(recordsOf(root)).toHaveLength(0);
      expect(logged[0]?.event).toBe('chat_attachments_purged');
      expect(JSON.stringify(logged)).not.toContain('old.txt');
      const entries = await audit.list('chat-attachments');
      expect(entries.some((entry) => entry.action === 'chat_attachments_purge')).toBe(true);
    } finally {
      clearPragmatikaRuntime();
    }
  });

  test('без архива в рантайме обработчик молчит и не падает', async () => {
    clearPragmatikaRuntime();
    const job = PROJECT_SCHEDULES.find((item) => item.name === CHAT_ATTACHMENTS_PURGE_JOB);
    const options = { audit: new MemoryAuditRepository(), log: () => undefined };
    const handler = job?.handler(options as never);
    await handler?.({} as never, new Date());
  });
});

describe('насос чата: сохранение не меняет то, что получает агент', () => {
  /** Три файла подряд склеиваются в один ход (окно подписи закрывается по числу). */
  async function runThreeFiles(withArchive: boolean): Promise<{ inputs: string[]; root: string }> {
    const { ctx, channel, root } = makeContext();
    if (withArchive) wireChatAttachments(ctx);
    const { runtime, inputs } = recordingRuntime();
    buildPump({
      channel,
      runtime,
      agent: 'documents',
      intake: new MemoryIntakeStore(),
      state: new MemoryWorkflowStateStore(),
    });
    for (const [index, name] of ['a.txt', 'b.txt', 'c.txt'].entries()) {
      await channel.emit(fileEvent(name, `файл ${index}`, { botId: undefined }));
    }
    // Ход идёт в очереди насоса: ждём, пока агент получит вход.
    for (let attempt = 0; attempt < 200 && inputs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { inputs: inputs.map((item) => item.input), root };
  }

  test('склеенные файлы сохраняются все, вход агента тот же, что без архива', async () => {
    const without = await runThreeFiles(false);
    const withArchive = await runThreeFiles(true);
    expect(withArchive.inputs).toEqual(without.inputs);
    expect(withArchive.inputs.length).toBeGreaterThan(0);
    expect(recordsOf(withArchive.root).map((item) => item.name).sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
  });
});
