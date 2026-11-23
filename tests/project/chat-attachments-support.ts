import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@business-ai/testing';
import {
  ChatAttachmentArchive,
  CHAT_ATTACHMENTS_DIR,
  type ChatAttachmentInput,
  type ChatAttachmentRecord,
  type ChatAttachmentsConfig,
} from '../../src/chat-attachments';

/** Фиксированное «сейчас» тестов: UTC-полдень. */
export const BASE_TIME = new Date('2026-03-10T12:00:00.000Z');
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
const TEST_MAX_BYTES = 1024 * 1024;
const TEST_MAX_FILE_BYTES = 100_000;
const TEST_MAX_FILES_PER_DAY = 100;

/** Событие журнала, записанное тестовым приёмником. */
export interface LoggedEvent {
  event: string;
  fields: Record<string, string | number>;
}

/** Архив во временном каталоге с управляемыми часами и записью событий. */
export interface Harness {
  intakeRoot: string;
  archiveRoot: string;
  archive: ChatAttachmentArchive;
  events: LoggedEvent[];
  clock: { now: Date };
  config: ChatAttachmentsConfig;
}

/** Настройки по умолчанию для тестов: небольшие пределы, чтобы быстро упираться в них. */
export function testConfig(overrides: Partial<ChatAttachmentsConfig> = {}): ChatAttachmentsConfig {
  return {
    enabled: true,
    retentionDays: 30,
    maxBytes: TEST_MAX_BYTES,
    maxFileBytes: TEST_MAX_FILE_BYTES,
    maxFilesPerThreadDay: TEST_MAX_FILES_PER_DAY,
    ...overrides,
  };
}

/** Новый архив поверх переданного (или нового временного) корня приёма. */
export function makeHarness(
  overrides: Partial<ChatAttachmentsConfig> = {},
  intakeRoot: string = tempDir(),
  clock: { now: Date } = { now: new Date(BASE_TIME) },
): Harness {
  const events: LoggedEvent[] = [];
  const config = testConfig(overrides);
  const archive = new ChatAttachmentArchive({
    intakeRoot,
    config,
    clock: () => new Date(clock.now),
    onEvent: (event, fields) => events.push({ event, fields }),
  });
  return {
    intakeRoot,
    archiveRoot: join(intakeRoot, CHAT_ATTACHMENTS_DIR),
    archive,
    events,
    clock,
    config,
  };
}

/** Входные данные сохранения из памяти; поля можно переопределить. */
export function memoryInput(
  content: string,
  overrides: Partial<ChatAttachmentInput> = {},
  name = 'report.pdf',
): ChatAttachmentInput {
  return {
    threadId: 'thread-1',
    userId: 'u-100',
    botId: 'bot-7',
    agentId: 'documents',
    sourceKey: undefined,
    ...overrides,
    file: { name, content: new TextEncoder().encode(content) },
  } as ChatAttachmentInput;
}

/** sha256 текста, hex. */
export function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Файл-«спул» на диске (как файл очереди чата), возвращает вход для сохранения. */
export function diskInput(
  dir: string,
  content: string,
  overrides: Partial<ChatAttachmentInput> = {},
  name = 'scan.bin',
): ChatAttachmentInput {
  const spool = join(dir, `spool-${sha256Of(content).slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(spool, content, { mode: 0o600 });
  const size = Buffer.byteLength(content);
  return {
    threadId: 'thread-1',
    userId: 'u-100',
    ...overrides,
    file: { name, content: new Uint8Array(0), disk: { path: spool, size } },
  };
}

/** Записи индекса архива по всем дням, по возрастанию имён файлов. */
export function readIndex(archiveRoot: string): ChatAttachmentRecord[] {
  const dir = join(archiveRoot, 'index');
  const names = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  return names
    .sort()
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ChatAttachmentRecord);
}

/** Имена файлов архива (относительные пути `files/<тред>/<имя>`). */
export function listArchivedFiles(archiveRoot: string): string[] {
  const filesDir = join(archiveRoot, 'files');
  const found: string[] = [];
  for (const thread of readdirSync(filesDir)) {
    for (const name of readdirSync(join(filesDir, thread))) found.push(`files/${thread}/${name}`);
  }
  return found.sort();
}

/** Состарить файл: выставить время изменения. */
export function setMtime(path: string, when: Date): void {
  utimesSync(path, when, when);
}
