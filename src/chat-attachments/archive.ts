import { randomBytes } from 'node:crypto';
import { link, mkdir, readdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { intakeThreadDir } from '@business-ai/adapters';
import {
  CAP_TARGET_RATIO,
  CHAT_ATTACHMENTS_DIR,
  DEFAULT_FIND_LIMIT,
  DIR_MODE,
  FILES_DIR,
  HASH_PREFIX_CHARS,
  HASH_SEPARATOR,
  INDEX_DIR,
  INDEX_VERSION,
  MAX_ORIGINAL_NAME_CHARS,
  RECENT_KEYS_LIMIT,
  TEMP_PREFIX,
  TEMP_SUFFIX_BYTES,
  THREAD_DIR_CHARS,
} from './constants';
import {
  ArchiveError,
  ensureDir,
  errorCode,
  hasCode,
  hashBytes,
  hashDiskFile,
  linkDiskTemp,
  lstatOrNull,
  removeFile,
  writeMemoryTemp,
  type Digest,
} from './fs-util';
import {
  appendRecord,
  dayOf,
  indexFileName,
  listIndexDays,
  loadIndex,
  readIndexLines,
} from './index-file';
import { evictToTarget, measureStore, purgeStore, type Layout } from './maintenance';
import { RecentKeys } from './recent-keys';
import { safeAttachmentName } from './safe-name';
import type {
  ChatAttachmentArchiveOptions,
  ChatAttachmentEventSink,
  ChatAttachmentInput,
  ChatAttachmentQuery,
  ChatAttachmentRecord,
  ChatAttachmentsConfig,
  EvictResult,
  PurgeResult,
  SaveOutcome,
  SkipReason,
} from './types';

/** Путь файла архива: `files/<каталог треда>/<префикс sha256>_<имя без разделителей>`. */
const LOCATE_PATH = new RegExp(
  `^${FILES_DIR}/[0-9a-f]{${THREAD_DIR_CHARS}}/[0-9a-f]{${HASH_PREFIX_CHARS}}` +
    `${HASH_SEPARATOR}[^/\\\\\\u0000]+$`,
);
const KEY_SEPARATOR = '|';

/** Счётчик файлов треда за один UTC-день. */
interface DayCounts {
  day: string;
  counts: Map<string, number>;
}

/**
 * Архив файлов чатов ботов: каждый присланный сотрудником файл хранится `retentionDays` суток
 * в `<INTAKE_ROOT>/chat-attachments/`, а индекс «кто, когда, какому боту, что» ведётся по
 * UTC-дням в JSONL. Сохранение не влияет на то, что идёт агенту и модели, и никогда не
 * бросает исключение наружу: сбой превращается в код в журнале и в итог `failed`.
 */
export class ChatAttachmentArchive {
  /** Корень архива: `<корень приёма>/chat-attachments`. */
  readonly root: string;
  private readonly intakeRoot: string;
  private readonly layout: Layout;
  private readonly config: ChatAttachmentsConfig;
  private readonly clock: () => Date;
  private readonly sink: ChatAttachmentEventSink | undefined;
  private readonly recent = new RecentKeys(RECENT_KEYS_LIMIT);
  private recentLoaded = false;
  private dayCounts: DayCounts | null = null;
  private totalBytes: number | null = null;
  /** Очередь: запись, очистка и вытеснение идут по одному, кэши не расходятся с диском. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: ChatAttachmentArchiveOptions) {
    this.intakeRoot = options.intakeRoot;
    this.root = join(options.intakeRoot, CHAT_ATTACHMENTS_DIR);
    this.layout = {
      root: this.root,
      filesDir: join(this.root, FILES_DIR),
      indexDir: join(this.root, INDEX_DIR),
    };
    this.config = options.config;
    this.clock = options.clock ?? ((): Date => new Date());
    this.sink = options.onEvent;
  }

  /**
   * Сохранить файл. Никогда не бросает: ошибка даёт `failed` с кодом (`error.code` либо
   * `error.name`), намеренный пропуск - `skipped` с причиной.
   */
  async save(input: ChatAttachmentInput): Promise<SaveOutcome> {
    try {
      const outcome = await this.saveChecked(input);
      this.report(outcome);
      return outcome;
    } catch (error) {
      const outcome: SaveOutcome = { kind: 'failed', code: errorCode(error) };
      this.report(outcome);
      return outcome;
    }
  }

  /**
   * Очистка по сроку (см. `purgeStore`). Сбой всего обхода не бросает: в журнал уходит код,
   * результат содержит то, что успели сделать.
   */
  async purge(now: Date): Promise<PurgeResult> {
    return this.exclusive(async () => {
      try {
        const result = await purgeStore(this.layout, now, this.config.retentionDays);
        this.dayCounts = null;
        // Сумма пересчитается сканированием при ближайшей записи: так она не расходится с диском.
        this.totalBytes = null;
        this.emit('chat_attachments_purged', { ...result });
        return result;
      } catch (error) {
        this.emit('chat_attachment_failed', { code: errorCode(error) });
        return { files: 0, records: 0, bytes: 0, orphans: 0 };
      }
    });
  }

  /**
   * Если сумма размеров файлов больше `maxBytes`, удалить самые старые, пока она не станет не
   * больше 90 % от `maxBytes`. Событие `chat_attachments_evicted` - при `evicted > 0`.
   */
  async enforceCap(): Promise<EvictResult> {
    return this.exclusive(async () => {
      try {
        const total = await measureStore(this.layout.filesDir);
        this.totalBytes = total;
        if (total <= this.config.maxBytes) return { evicted: 0, bytes: 0 };
        return await this.evictTo(this.capTarget());
      } catch (error) {
        this.emit('chat_attachment_failed', { code: errorCode(error) });
        return { evicted: 0, bytes: 0 };
      }
    });
  }

  /**
   * Найти записи индекса (для CLI) по возрастанию времени. Возвращаются самые свежие `limit`
   * (по умолчанию 200) подходящих записей.
   */
  async find(query: ChatAttachmentQuery = {}): Promise<ChatAttachmentRecord[]> {
    const index = await loadIndex(this.layout.indexDir, {
      fromDay: query.from === undefined ? undefined : dayOf(query.from),
      toDay: query.to === undefined ? undefined : dayOf(query.to),
    });
    const threadDir = query.thread === undefined ? undefined : intakeThreadDir(query.thread);
    const needle = query.name?.toLowerCase();
    const sha = query.sha?.toLowerCase();
    const found: ChatAttachmentRecord[] = [];
    for (const entry of index.days) {
      for (const { record } of entry.lines) {
        if (record === null) continue;
        const at = Date.parse(record.at);
        if (query.user !== undefined && record.user !== query.user) continue;
        if (query.bot !== undefined && record.bot !== query.bot) continue;
        if (query.agent !== undefined && record.agent !== query.agent) continue;
        if (query.thread !== undefined) {
          if (record.thread !== query.thread && record.thread !== threadDir) continue;
        }
        if (needle !== undefined && !record.name.toLowerCase().includes(needle)) continue;
        if (sha !== undefined && !record.sha256.startsWith(sha)) continue;
        if (query.from !== undefined && at < query.from.getTime()) continue;
        if (query.to !== undefined && at > query.to.getTime()) continue;
        found.push(record);
      }
    }
    const limit = query.limit ?? DEFAULT_FIND_LIMIT;
    const ordered = found
      .map((record, order) => ({ record, order, at: Date.parse(record.at) }))
      .sort((a, b) => a.at - b.at || a.order - b.order);
    return ordered.slice(-limit).map((item) => item.record);
  }

  /**
   * Абсолютный путь файла по относительному пути из индекса. Выход за корень, симлинки на
   * любом уровне и не-файлы дают `null`; наружу не бросает.
   */
  async locate(relPath: string): Promise<string | null> {
    if (!LOCATE_PATH.test(relPath)) return null;
    try {
      const [, thread] = relPath.split('/');
      const chain = [
        this.root,
        this.layout.filesDir,
        join(this.layout.filesDir, thread ?? ''),
      ];
      for (const dir of chain) {
        const info = await lstatOrNull(dir);
        if (info === null || info.isSymbolicLink() || !info.isDirectory()) return null;
      }
      const absolute = join(this.root, relPath);
      const file = await lstatOrNull(absolute);
      return file !== null && file.isFile() ? absolute : null;
    } catch {
      return null;
    }
  }

  // --- сохранение ---

  private async saveChecked(input: ChatAttachmentInput): Promise<SaveOutcome> {
    if (!this.config.enabled) return skipped('disabled');
    const declared = input.file.disk?.size ?? input.file.content.byteLength;
    if (declared <= 0) return skipped('empty');
    if (declared > this.config.maxFileBytes) return skipped('too_large');
    // Хэш считается вне очереди: файл на диске читается потоком и не держит остальные записи.
    const digest =
      input.file.disk === undefined
        ? hashBytes(input.file.content)
        : await hashDiskFile(input.file.disk.path);
    if (digest.size <= 0) return skipped('empty');
    if (digest.size > this.config.maxFileBytes) return skipped('too_large');
    return this.exclusive(() => this.admit(input, digest));
  }

  /** Запись под очередью: дубликат, лимиты, место, файл и строка индекса. */
  private async admit(input: ChatAttachmentInput, digest: Digest): Promise<SaveOutcome> {
    const now = this.clock();
    const day = dayOf(now);
    const thread = intakeThreadDir(input.threadId);
    const prefix = `${digest.sha256.slice(0, HASH_PREFIX_CHARS)}${HASH_SEPARATOR}`;
    await this.ensureLayout();
    await this.loadRecentKeys();
    const threadPath = join(this.layout.filesDir, thread);
    const known = await this.findKnown(threadPath, prefix);
    const token = redeliveryToken(input.sourceKey, digest.sha256);
    if (known !== null && token !== null && this.recent.has(token)) {
      await touch(join(threadPath, known), now);
      return duplicateOutcome(thread, known, digest);
    }
    if ((await this.threadCount(day, thread)) >= this.config.maxFilesPerThreadDay) {
      return skipped('thread_limit');
    }
    if (known === null && !(await this.makeRoom(digest.size))) return skipped('no_space');
    await ensureDir(threadPath, true);
    const name = known ?? `${prefix}${safeAttachmentName(input.file.name)}`;
    const created = known === null && (await this.place(input, threadPath, name));
    await touch(join(threadPath, name), now);
    if (created && this.totalBytes !== null) this.totalBytes += digest.size;
    const record = buildRecord(input, digest, thread, name, now);
    await appendRecord(join(this.layout.indexDir, indexFileName(day)), record);
    this.bumpCount(day, thread);
    if (token !== null) this.recent.add(token);
    return {
      kind: created ? 'saved' : 'duplicate',
      path: record.path,
      sha256: digest.sha256,
      size: digest.size,
    };
  }

  /**
   * Записать файл под итоговым именем: во временный `.tmp-<hex>` и жёсткой ссылкой на место, так
   * читатели не увидят недописанный файл. Возвращает false, если такой файл уже появился.
   */
  private async place(input: ChatAttachmentInput, dir: string, name: string): Promise<boolean> {
    const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString('hex');
    const temp = join(dir, `${TEMP_PREFIX}${suffix}`);
    const target = join(dir, name);
    try {
      if (input.file.disk === undefined) await writeMemoryTemp(temp, input.file.content);
      else await linkDiskTemp(input.file.disk, temp);
      await link(temp, target);
      return true;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const info = await lstatOrNull(target);
      if (info === null || !info.isFile()) throw new ArchiveError('unsafe_path');
      return false;
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /** Имя уже лежащего в каталоге треда файла с тем же sha256; нет каталога - null. */
  private async findKnown(threadPath: string, prefix: string): Promise<string | null> {
    if (!(await ensureDir(threadPath, false))) return null;
    for (const name of await readdir(threadPath)) {
      if (name.startsWith(TEMP_PREFIX) || !name.startsWith(prefix)) continue;
      const info = await lstatOrNull(join(threadPath, name));
      if (info === null) continue;
      if (!info.isFile()) throw new ArchiveError('unsafe_path');
      return name;
    }
    return null;
  }

  /** Каталоги архива с правами 0700; симлинк вместо каталога - `unsafe_path`. */
  private async ensureLayout(): Promise<void> {
    await mkdir(this.intakeRoot, { recursive: true, mode: DIR_MODE });
    await ensureDir(this.root, true);
    await ensureDir(this.layout.filesDir, true);
    await ensureDir(this.layout.indexDir, true);
  }

  // --- объём ---

  private capTarget(): number {
    return Math.floor(this.config.maxBytes * CAP_TARGET_RATIO);
  }

  /** Освободить место под файл `size`; false, если файл не поместится и после вытеснения. */
  private async makeRoom(size: number): Promise<boolean> {
    const { maxBytes } = this.config;
    if (size > maxBytes) return false;
    this.totalBytes ??= await measureStore(this.layout.filesDir);
    if (this.totalBytes + size <= maxBytes) return true;
    await this.evictTo(Math.min(this.capTarget(), maxBytes - size));
    return (this.totalBytes ?? 0) + size <= maxBytes;
  }

  private async evictTo(target: number): Promise<EvictResult> {
    const outcome = await evictToTarget(this.layout, target);
    this.totalBytes = outcome.remaining;
    const result = { evicted: outcome.evicted, bytes: outcome.bytes };
    if (result.evicted > 0) {
      this.dayCounts = null;
      this.emit('chat_attachments_evicted', { files: result.evicted, bytes: result.bytes });
    }
    return result;
  }

  // --- кэши ---

  /** Сколько файлов тред получил за UTC-день: один раз читаем индекс дня, дальше считаем сами. */
  private async threadCount(day: string, thread: string): Promise<number> {
    if (this.dayCounts?.day !== day) {
      const counts = new Map<string, number>();
      const lines = await readIndexLines(join(this.layout.indexDir, indexFileName(day)));
      for (const { record } of lines ?? []) {
        if (record !== null) counts.set(record.thread, (counts.get(record.thread) ?? 0) + 1);
      }
      this.dayCounts = { day, counts };
    }
    return this.dayCounts.counts.get(thread) ?? 0;
  }

  private bumpCount(day: string, thread: string): void {
    if (this.dayCounts?.day !== day) return;
    this.dayCounts.counts.set(thread, (this.dayCounts.counts.get(thread) ?? 0) + 1);
  }

  /** Последние ключи событий из индекса: повторная доставка после перезапуска тоже отсеется. */
  private async loadRecentKeys(): Promise<void> {
    if (this.recentLoaded) return;
    const chunks: string[][] = [];
    let collected = 0;
    for (const day of (await listIndexDays(this.layout.indexDir)).reverse()) {
      const lines = await readIndexLines(join(this.layout.indexDir, indexFileName(day)));
      const tokens: string[] = [];
      for (const { record } of lines ?? []) {
        const token = record === null ? null : redeliveryToken(record.key, record.sha256);
        if (token !== null) tokens.push(token);
      }
      chunks.unshift(tokens);
      collected += tokens.length;
      if (collected >= RECENT_KEYS_LIMIT) break;
    }
    for (const token of chunks.flat()) this.recent.add(token);
    this.recentLoaded = true;
  }

  // --- служебное ---

  /** Выполнить задачу после всех предыдущих; сбой одной не ломает очередь. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private report(outcome: SaveOutcome): void {
    if (outcome.kind === 'skipped') {
      this.emit('chat_attachment_skipped', { reason: outcome.reason });
    } else if (outcome.kind === 'failed') {
      this.emit('chat_attachment_failed', { code: outcome.code });
    } else {
      this.emit('chat_attachment_saved', {
        size: outcome.size,
        dup: outcome.kind === 'duplicate' ? 1 : 0,
      });
    }
  }

  /** Событие в журнал службы; сбой приёмника не должен ломать ход. */
  private emit(event: string, fields: Record<string, string | number>): void {
    try {
      this.sink?.(event, fields);
    } catch {
      // Журнал вторичен: ошибка приёмника сохранению не мешает.
    }
  }
}

function skipped(reason: SkipReason): SaveOutcome {
  return { kind: 'skipped', reason };
}

/**
 * Признак повторной доставки: ключ события вместе с хэшем, потому что в одном событии
 * бывает несколько файлов.
 */
function redeliveryToken(key: string | undefined, sha256: string): string | null {
  return key === undefined || key === '' ? null : `${key}${KEY_SEPARATOR}${sha256}`;
}

function duplicateOutcome(thread: string, name: string, digest: Digest): SaveOutcome {
  return {
    kind: 'duplicate',
    path: `${FILES_DIR}/${thread}/${name}`,
    sha256: digest.sha256,
    size: digest.size,
  };
}

function buildRecord(
  input: ChatAttachmentInput,
  digest: Digest,
  thread: string,
  name: string,
  now: Date,
): ChatAttachmentRecord {
  return {
    v: INDEX_VERSION,
    at: now.toISOString(),
    agent: input.agentId ?? '',
    bot: input.botId ?? '',
    thread,
    user: input.userId,
    name: input.file.name.slice(0, MAX_ORIGINAL_NAME_CHARS),
    sha256: digest.sha256,
    size: digest.size,
    path: `${FILES_DIR}/${thread}/${name}`,
    key: input.sourceKey ?? '',
  };
}

/** Обновить mtime (повторная отправка продлевает срок); сбой не критичен. */
async function touch(path: string, when: Date): Promise<void> {
  await utimes(path, when, when).catch(() => undefined);
}
