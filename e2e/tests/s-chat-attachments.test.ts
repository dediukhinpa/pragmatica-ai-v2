import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { DOCUMENTS_AGENT_ID } from '../../src/agents/documents/deps';
import type { ChatAttachmentRecord } from '../../src/chat-attachments';
import { buildApp, e2eEnv } from '../lib/project-env';
import type { E2eApp } from '../lib/project-env';

/**
 * Сценарий s9s: каждый файл, присланный боту в чат, сохраняется в архиве тома приёма
 * (`<INTAKE_ROOT>/chat-attachments`). Настоящая сборка `composeProduction` с манифестом проекта:
 * проверяется, что перехват файловых событий канала подключён в боевой сборке (а не только в
 * тестах обвязки), что агент и бот попадают в индекс и что не файловые события ничего не пишут.
 */

const BOT_DOCUMENTS = 'documents';
const BOT_PRICES = 'prices';
const USER = 'emp-e2e-s9s';
const OTHER_USER = 'emp-e2e-s9s-other';
const ARCHIVE_DIR = 'chat-attachments';
const THREAD_HASH = /^[0-9a-f]{16}$/;
const FILE_BODY = 'Синтетический счёт для проверки архива';

let ctx: E2eApp;

function archiveRoot(): string {
  return join(e2eEnv().intakeRoot, ARCHIVE_DIR);
}

function recordsOf(user: string): ChatAttachmentRecord[] {
  const dir = join(archiveRoot(), 'index');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ChatAttachmentRecord)
    .filter((record) => record.user === user);
}

function fileEvent(bot: string, user: string, name: string, body: string, key: string) {
  return {
    kind: 'file' as const,
    threadId: `${bot}/${user}`,
    userId: user,
    botId: bot,
    sourceKey: key,
    file: {
      name,
      mimeType: 'application/octet-stream',
      content: new TextEncoder().encode(body),
    },
  };
}

beforeAll(() => {
  ctx = buildApp(new Map(), {
    CHAT_BOTS: JSON.stringify({
      [BOT_DOCUMENTS]: DOCUMENTS_AGENT_ID,
      [BOT_PRICES]: PRICES_AGENT_ID,
    }),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

describe('сценарий s9s: архив файлов чатов ботов', () => {
  test('файл бота документов и бота прайсов сохранён, индекс знает агента и сотрудника', async () => {
    await ctx.chat.emit(fileEvent(BOT_DOCUMENTS, USER, 'Счёт 5.pdf', FILE_BODY, 'e2e-s9s-1'));
    await ctx.chat.emit(fileEvent(BOT_PRICES, USER, 'Прайс.xlsx', 'прайс', 'e2e-s9s-2'));
    const records = recordsOf(USER);
    expect(records.map((record) => record.name).sort()).toEqual(['Прайс.xlsx', 'Счёт 5.pdf']);
    const bill = records.find((record) => record.name === 'Счёт 5.pdf');
    expect(bill?.agent).toBe(DOCUMENTS_AGENT_ID);
    expect(bill?.bot).toBe(BOT_DOCUMENTS);
    expect(bill?.sha256).toBe(createHash('sha256').update(FILE_BODY).digest('hex'));
    expect(bill?.thread).toMatch(THREAD_HASH);
    const path = join(archiveRoot(), bill?.path ?? 'нет');
    expect(readFileSync(path, 'utf8')).toBe(FILE_BODY);
    // Права как у тома приёма: только владелец процесса.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  test('повторная доставка того же события не плодит запись; другой файл - новая', async () => {
    const event = fileEvent(BOT_DOCUMENTS, OTHER_USER, 'Акт.docx', 'акт', 'e2e-s9s-3');
    await ctx.chat.emit(event);
    await ctx.chat.emit(event);
    expect(recordsOf(OTHER_USER)).toHaveLength(1);
    await ctx.chat.emit(
      fileEvent(BOT_DOCUMENTS, OTHER_USER, 'Акт 2.docx', 'другой акт', 'e2e-s9s-4'),
    );
    expect(recordsOf(OTHER_USER)).toHaveLength(2);
  });

  test('сообщения и кнопки ничего не сохраняют', async () => {
    const before = recordsOf(USER).length;
    await ctx.chat.emit({
      kind: 'message',
      threadId: `${BOT_DOCUMENTS}/${USER}`,
      userId: USER,
      botId: BOT_DOCUMENTS,
      text: 'привет',
    });
    expect(recordsOf(USER)).toHaveLength(before);
  });
});
