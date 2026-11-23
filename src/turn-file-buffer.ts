import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ChatChannel, ChatFile, ChatMessage, IdempotencyKey } from '@business-ai/core';

/**
 * Один файл правки за ход сотрудника (этап 9u, живой баг: агент прайсов за один ход прислал
 * сотруднику два файла правки, первый неполный, потом полный, потом третий).
 *
 * Все пути отправки файла правки вызывают `chat.sendFile`. Для агента прайсов в `deps.chat`
 * стоит обёртка `turnFileChat`: в ХОДЕ СОТРУДНИКА она не шлёт файл сразу, а откладывает в
 * хранилище хода; файл с тем же именем в том же треде заменяет прежний. В конце хода обёртка
 * рантайма (`assembly/turn-runtime-wrap.ts`) вызывает `flushTurnFiles`: каждый накопленный файл
 * уходит ОДИН раз. Вне хода сотрудника (плановый запуск, вложенный ход без внешнего контекста)
 * и при выключенном буфере файл уходит сразу, как раньше.
 *
 * Здесь же кэш последнего отправленного файла треда (для повторной отправки «той же копии»).
 * В журнал идут только коды и числа: имён файлов и текстов ошибок там нет.
 */

const BYTES_IN_MIB = 1024 * 1024;

/** Предел суммарно отложенного на ход: сверх него файл уходит сразу (старое поведение). */
export const PENDING_MAX_BYTES = 256 * BYTES_IN_MIB;

/** Файл крупнее этого в кэш последнего файла не кладётся. */
export const LAST_FILE_MAX_BYTES = 64 * BYTES_IN_MIB;

/** Общий размер кэша последних файлов; сверх него вытесняются самые старые. */
export const LAST_FILES_TOTAL_MAX_BYTES = 256 * BYTES_IN_MIB;

/** Срок жизни записи кэша последнего файла: 6 часов. */
export const LAST_FILE_TTL_MS = 6 * 60 * 60 * 1000;

/** Сколько раз пробуем отправить отложенный файл при сбое канала. */
export const FLUSH_MAX_ATTEMPTS = 3;

/** Пауза между попытками отправки отложенного файла. */
export const FLUSH_RETRY_DELAY_MS = 500;

/** Размер порции при чтении файла с диска через собственный способ открытия. */
const DISK_READ_CHUNK_BYTES = BYTES_IN_MIB;

/** Длина (в символах) хэша в ключе идемпотентности пометки. */
const NOTE_KEY_HASH_LENGTH = 32;

/** События журнала. */
export const TURN_FILE_DEFER_SKIPPED_EVENT = 'turn_file_defer_skipped';
export const TURN_FILE_SEND_FAILED_EVENT = 'turn_file_send_failed';
export const TURN_FILE_NOTE_FAILED_EVENT = 'turn_file_note_failed';
export const TURN_FILE_FLUSHED_EVENT = 'turn_file_flushed';

/** Что увидит сотрудник, если файл не удалось отправить (имя файла в кавычках-ёлочках). */
export function fileSendFailedText(fileName: string): string {
  return `Файл «${fileName}» не удалось отправить: попробуйте ещё раз или напишите руководителю.`;
}

/** Пометка после файлов, если ход закончился ошибкой. */
export const TURN_FAILED_NOTE_TEXT =
  'Ход закончился ошибкой, поэтому отправлены правки, собранные до неё. Файл может не ' +
  'содержать последних правок: повторите просьбу, если нужно.';

/** Журнал буфера: только коды и числа. */
type BufferLog = (event: string, fields?: Record<string, string | number>) => void;

/** Настройка буфера. */
export interface TurnFileBufferOptions {
  /** Включён ли буфер; `false` - файлы уходят сразу, как раньше. */
  enabled: boolean;
  /** Журнал службы; нет - события не пишутся. */
  log?: BufferLog | undefined;
  /** Пауза между попытками отправки (по умолчанию `FLUSH_RETRY_DELAY_MS`; в тестах короче). */
  retryDelayMs?: number | undefined;
  /** Предел отложенного на ход (по умолчанию `PENDING_MAX_BYTES`; в тестах меньше). */
  pendingMaxBytes?: number | undefined;
}

/** Текущая настройка: читается при каждом вызове, поэтому выключатель действует сразу. */
const config: {
  enabled: boolean;
  log: BufferLog | undefined;
  retryDelayMs: number;
  pendingMaxBytes: number;
} = {
  enabled: false,
  log: undefined,
  retryDelayMs: FLUSH_RETRY_DELAY_MS,
  pendingMaxBytes: PENDING_MAX_BYTES,
};

/** Настроить буфер (вызывает сборка; повтор безопасен). */
export function configureTurnFileBuffer(options: TurnFileBufferOptions): void {
  config.enabled = options.enabled;
  config.log = options.log;
  config.retryDelayMs = options.retryDelayMs ?? FLUSH_RETRY_DELAY_MS;
  config.pendingMaxBytes = options.pendingMaxBytes ?? PENDING_MAX_BYTES;
}

/** Включён ли буфер сейчас. */
export function isTurnFileBufferEnabled(): boolean {
  return config.enabled;
}

/** Записать событие; сбой журнала не должен ломать отправку файла сотруднику. */
function emit(event: string, fields?: Record<string, string | number>): void {
  try {
    config.log?.(event, fields);
  } catch {
    // Журнал вторичен.
  }
}

/** Последний отправленный файл треда (содержимое в памяти). */
export interface LastTurnFile {
  name: string;
  mimeType: string;
  content: Uint8Array;
  /** Когда файл отправлен (ISO). */
  sentAt: string;
}

/** Запись кэша: файл и момент отправки в миллисекундах (для срока жизни). */
interface LastFileEntry {
  file: LastTurnFile;
  sentAtMs: number;
}

/** Кэш последних файлов; порядок вставки = от старых к новым. */
const lastFiles = new Map<string, LastFileEntry>();

/** Суммарный размер кэша. */
function lastFilesTotalBytes(): number {
  let total = 0;
  for (const entry of lastFiles.values()) total += entry.file.content.byteLength;
  return total;
}

/** Убрать просроченные записи. */
function purgeExpiredLastFiles(nowMs: number): void {
  for (const [threadId, entry] of lastFiles) {
    if (nowMs - entry.sentAtMs > LAST_FILE_TTL_MS) lastFiles.delete(threadId);
  }
}

/** Запомнить успешно отправленный файл треда (если он не слишком велик). */
function rememberSentFile(threadId: string, file: Omit<LastTurnFile, 'sentAt'>): void {
  if (file.content.byteLength > LAST_FILE_MAX_BYTES) return;
  const nowMs = Date.now();
  purgeExpiredLastFiles(nowMs);
  lastFiles.delete(threadId);
  const sentAt = new Date(nowMs).toISOString();
  lastFiles.set(threadId, { file: { ...file, sentAt }, sentAtMs: nowMs });
  let total = lastFilesTotalBytes();
  for (const [oldId, entry] of lastFiles) {
    if (total <= LAST_FILES_TOTAL_MAX_BYTES) break;
    lastFiles.delete(oldId);
    total -= entry.file.content.byteLength;
  }
}

/** Последний ОТПРАВЛЕННЫЙ файл треда из кэша в памяти; просроченный не отдаётся. */
export function lastTurnFileOf(chatThreadId: string): LastTurnFile | undefined {
  const entry = lastFiles.get(chatThreadId);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.sentAtMs > LAST_FILE_TTL_MS) {
    lastFiles.delete(chatThreadId);
    return undefined;
  }
  return entry.file;
}

/** Отложенный файл: канал, в который он уйдёт в конце хода. */
interface PendingFile {
  inner: ChatChannel;
  threadId: string;
  name: string;
  mimeType: string;
  content: Uint8Array;
  key: IdempotencyKey;
}

/** Хранилище отложенных файлов одного хода. */
export interface TurnFileStore {
  /** Ключ `${threadId}\u0000${name}` -> файл; порядок = порядок первой регистрации имени. */
  readonly pending: Map<string, PendingFile>;
  /** Сколько байт отложено сейчас. */
  pendingBytes: number;
  /** После flush ход закончен: новые файлы уходят сразу, а не теряются в пустом хранилище. */
  closed: boolean;
}

/** Создать пустое хранилище хода. */
export function createTurnFileStore(): TurnFileStore {
  return { pending: new Map(), pendingBytes: 0, closed: false };
}

const turnContext = new AsyncLocalStorage<TurnFileStore>();

/** Выполнить работу внутри данного хранилища (нужно потокам: каждый `next()` в контексте). */
export function runInTurnFileStore<T>(store: TurnFileStore, work: () => T): T {
  return turnContext.run(store, work);
}

/**
 * Выполнить работу внутри контекста хода. Хранилище создаётся, если его ещё нет в текущем
 * контексте; вложенный вызов использует внешнее хранилище.
 */
export function runWithTurnFiles<T>(work: () => T): T {
  const outer = turnContext.getStore();
  return outer !== undefined ? work() : turnContext.run(createTurnFileStore(), work);
}

/** Хранилище текущего хода; нет - мы вне хода сотрудника. */
export function currentTurnFiles(): TurnFileStore | undefined {
  return turnContext.getStore();
}

/** Файл на диске из `ChatFile`. */
type DiskSource = NonNullable<ChatFile['disk']>;

/** Прочитать файл с диска в память (по собственному способу открытия, если он задан). */
async function readDiskFile(disk: DiskSource): Promise<Uint8Array> {
  if (disk.open === undefined) return new Uint8Array(await Bun.file(disk.path).arrayBuffer());
  const handle = await disk.open();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const buffer = new Uint8Array(DISK_READ_CHUNK_BYTES);
      const read = await handle.read(buffer);
      if (read <= 0) break;
      chunks.push(buffer.subarray(0, read));
      total += read;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  } finally {
    await handle.close();
  }
}

/** Размер файла: у файла на диске - размер диска, иначе длина содержимого. */
function sizeOfFile(file: ChatFile): number {
  return file.disk !== undefined ? file.disk.size : file.content.byteLength;
}

/** Отправить файл сразу и запомнить в кэше последнего (для файла на диске - по возможности). */
async function sendNow(
  inner: ChatChannel,
  threadId: string,
  file: ChatFile,
  key: IdempotencyKey,
): Promise<void> {
  await inner.sendFile(threadId, file, key);
  try {
    if (file.disk === undefined) {
      const { name, mimeType, content } = file;
      rememberSentFile(threadId, { name, mimeType, content });
    } else if (file.disk.size <= LAST_FILE_MAX_BYTES) {
      // Вызывающий убирает диск только после возврата, поэтому читать ещё можно.
      const content = await readDiskFile(file.disk);
      rememberSentFile(threadId, { name: file.name, mimeType: file.mimeType, content });
    }
  } catch {
    // Кэш вторичен: сбой чтения диска не отменяет уже отправленный файл.
  }
}

/** Отложить файл в хранилище хода. Вернуть `false`, если откладывать нельзя (лимит, чтение). */
async function deferFile(
  store: TurnFileStore,
  inner: ChatChannel,
  threadId: string,
  file: ChatFile,
  key: IdempotencyKey,
): Promise<boolean> {
  const mapKey = `${threadId}\u0000${file.name}`;
  const previous = store.pending.get(mapKey);
  const baseBytes = store.pendingBytes - (previous?.content.byteLength ?? 0);
  if (baseBytes + sizeOfFile(file) > config.pendingMaxBytes) {
    emit(TURN_FILE_DEFER_SKIPPED_EVENT, { reason: 'limit', pendingBytes: store.pendingBytes });
    return false;
  }
  let content = file.content;
  if (file.disk !== undefined) {
    // Диск вызывающий освободит сразу после sendFile: содержимое забираем в память сейчас.
    try {
      content = await readDiskFile(file.disk);
    } catch {
      const pendingBytes = store.pendingBytes;
      emit(TURN_FILE_DEFER_SKIPPED_EVENT, { reason: 'disk_read', pendingBytes });
      return false;
    }
  }
  // Хранилище могло закрыться, пока читали диск: тогда файл уходит сразу.
  if (store.closed) return false;
  const replaced = store.pending.get(mapKey);
  const replacedBytes = replaced?.content.byteLength ?? 0;
  store.pendingBytes = store.pendingBytes - replacedBytes + content.byteLength;
  // Map.set по существующему ключу сохраняет позицию: порядок = первая регистрация имени.
  store.pending.set(mapKey, {
    inner,
    threadId,
    name: file.name,
    mimeType: file.mimeType,
    content,
    key,
  });
  return true;
}

/** Метка: канал уже обёрнут (повторная обёртка не откладывает дважды). */
const wrappedChannels = new WeakSet<ChatChannel>();

/**
 * Обёртка канала: `sendFile` в ходе сотрудника откладывает файл до конца хода; остальные
 * методы делегируются, необязательные (`typing`, `updateMessage`) - только если они есть у канала.
 */
export function turnFileChat(inner: ChatChannel): ChatChannel {
  if (wrappedChannels.has(inner)) return inner;
  const chat: ChatChannel = {
    onEvent: (handler) => inner.onEvent(handler),
    reply: (threadId, message, key) => inner.reply(threadId, message, key),
    sendFile: async (threadId, file, key) => {
      const store = currentTurnFiles();
      if (!config.enabled || store === undefined || store.closed) {
        await sendNow(inner, threadId, file, key);
        return;
      }
      if (await deferFile(store, inner, threadId, file, key)) return;
      await sendNow(inner, threadId, file, key);
    },
  };
  const typing = inner.typing;
  if (typing !== undefined) chat.typing = (threadId) => typing.call(inner, threadId);
  const updateMessage = inner.updateMessage;
  if (updateMessage !== undefined) {
    chat.updateMessage = (threadId, draftId, message, options) =>
      options === undefined
        ? updateMessage.call(inner, threadId, draftId, message)
        : updateMessage.call(inner, threadId, draftId, message, options);
  }
  wrappedChannels.add(chat);
  return chat;
}

/** Пауза между попытками. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Отправить отложенный файл с повторами; `true` - дошёл. */
async function sendPending(file: PendingFile): Promise<boolean> {
  for (let attempt = 1; attempt <= FLUSH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await file.inner.sendFile(
        file.threadId,
        { name: file.name, mimeType: file.mimeType, content: file.content },
        file.key,
      );
      rememberSentFile(file.threadId, {
        name: file.name,
        mimeType: file.mimeType,
        content: file.content,
      });
      return true;
    } catch {
      if (attempt < FLUSH_MAX_ATTEMPTS) await sleep(config.retryDelayMs);
    }
  }
  const bytes = file.content.byteLength;
  emit(TURN_FILE_SEND_FAILED_EVENT, { attempts: FLUSH_MAX_ATTEMPTS, bytes });
  return false;
}

/** Текстовая пометка сотруднику; сбой пометки только в журнал. */
async function sendNote(
  inner: ChatChannel,
  threadId: string,
  text: string,
  key: IdempotencyKey,
): Promise<void> {
  const message: ChatMessage = { text };
  try {
    await inner.reply(threadId, message, key);
  } catch {
    emit(TURN_FILE_NOTE_FAILED_EVENT);
  }
}

/** Стабильный ключ пометки: хэш треда и ключей его файлов (повтор не дублирует пометку). */
function noteKey(kind: string, threadId: string, keys: readonly string[]): IdempotencyKey {
  const hash = createHash('sha256')
    .update([threadId, ...keys].join('\u0000'))
    .digest('hex')
    .slice(0, NOTE_KEY_HASH_LENGTH);
  return `turn-file-${kind}:${hash}`;
}

/**
 * Отправить накопленные за ход файлы по одному разу (по порядку первой регистрации имени).
 * Хранилище очищается и закрывается: повторный вызов ничего не шлёт. `failed` добавляет после
 * файлов одну пометку на тред. Исключения наружу не бросает (только журнал).
 */
export async function flushTurnFiles(
  store: TurnFileStore,
  outcome: 'ok' | 'failed',
): Promise<void> {
  try {
    const files = [...store.pending.values()];
    store.pending.clear();
    store.pendingBytes = 0;
    store.closed = true;
    if (files.length === 0) return;
    const threads = new Map<string, { inner: ChatChannel; keys: string[] }>();
    let sent = 0;
    for (const file of files) {
      const thread = threads.get(file.threadId) ?? { inner: file.inner, keys: [] };
      thread.keys.push(file.key);
      threads.set(file.threadId, thread);
      if (await sendPending(file)) {
        sent += 1;
      } else {
        const key = noteKey('failed-file', file.threadId, [file.key]);
        await sendNote(file.inner, file.threadId, fileSendFailedText(file.name), key);
      }
    }
    if (outcome === 'failed') {
      for (const [threadId, thread] of threads) {
        const key = noteKey('failed-turn', threadId, thread.keys);
        await sendNote(thread.inner, threadId, TURN_FAILED_NOTE_TEXT, key);
      }
    }
    const failedTurn = outcome === 'failed' ? 1 : 0;
    emit(TURN_FILE_FLUSHED_EVENT, { files: files.length, sent, failedTurn });
  } catch {
    // Конец хода не должен падать из-за отправки файла.
  }
}

/** Сбросить кэш и настройки (только для тестов). */
export function resetTurnFileBufferForTests(): void {
  lastFiles.clear();
  config.enabled = false;
  config.log = undefined;
  config.retryDelayMs = FLUSH_RETRY_DELAY_MS;
  config.pendingMaxBytes = PENDING_MAX_BYTES;
}
