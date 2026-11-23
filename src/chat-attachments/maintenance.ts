import { readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FILES_DIR,
  MS_PER_DAY,
  REWRITE_PREFIX,
  TEMP_MAX_AGE_MS,
  TEMP_PREFIX,
  THREAD_DIR_CHARS,
} from './constants';
import { lstatOrNull, removeFile } from './fs-util';
import { endOfDayMs, loadIndex, pruneIndex, type IndexLine } from './index-file';
import type { EvictResult, PurgeResult } from './types';

const THREAD_DIR_NAME = new RegExp(`^[0-9a-f]{${THREAD_DIR_CHARS}}$`);

/** Каталоги архива (абсолютные пути). */
export interface Layout {
  root: string;
  filesDir: string;
  indexDir: string;
}

/** Файл архива, найденный при сканировании. */
export interface ScannedFile {
  /** Относительный путь `files/<тред>/<имя>`: так он записан в индексе. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/** Снимок каталога `files`: файлы, временные файлы и каталоги тредов. */
export interface StoreScan {
  files: ScannedFile[];
  temps: ScannedFile[];
  threadDirs: string[];
}

/**
 * Обойти `files/<тред>/*`. Симлинки и посторонние имена не учитываются и не трогаются.
 * Нет каталога - пустой снимок.
 */
export async function scanStore(filesDir: string): Promise<StoreScan> {
  const scan: StoreScan = { files: [], temps: [], threadDirs: [] };
  for (const thread of await readdir(filesDir).catch(() => [] as string[])) {
    if (!THREAD_DIR_NAME.test(thread)) continue;
    const dir = join(filesDir, thread);
    const dirInfo = await lstatOrNull(dir);
    if (dirInfo === null || !dirInfo.isDirectory()) continue;
    scan.threadDirs.push(dir);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const abs = join(dir, name);
      const info = await lstatOrNull(abs);
      if (info === null || !info.isFile()) continue;
      const rel = `${FILES_DIR}/${thread}/${name}`;
      const entry = { rel, abs, size: info.size, mtimeMs: info.mtimeMs };
      (name.startsWith(TEMP_PREFIX) ? scan.temps : scan.files).push(entry);
    }
  }
  return scan;
}

/** Сумма размеров файлов архива (временные файлы записи не считаются). */
export async function measureStore(filesDir: string): Promise<number> {
  const scan = await scanStore(filesDir);
  return scan.files.reduce((sum, file) => sum + file.size, 0);
}

/** Убрать пустые каталоги тредов; непустой `rmdir` не тронет. */
async function dropEmptyDirs(dirs: string[]): Promise<void> {
  for (const dir of dirs) await rmdir(dir).catch(() => undefined);
}

/** Убрать остатки атомарной перезаписи индекса (`.rewrite-*`) старше часа. */
async function removeStaleRewrites(
  indexDir: string,
  now: Date,
): Promise<{ count: number; bytes: number }> {
  const stale = { count: 0, bytes: 0 };
  for (const name of await readdir(indexDir).catch(() => [] as string[])) {
    if (!name.startsWith(REWRITE_PREFIX)) continue;
    const path = join(indexDir, name);
    const info = await lstatOrNull(path);
    if (info === null || !info.isFile()) continue;
    if (info.mtimeMs >= now.getTime() - TEMP_MAX_AGE_MS) continue;
    if (!(await removeFile(path))) continue;
    stale.count += 1;
    stale.bytes += info.size;
  }
  return stale;
}

/** Жива ли строка индекса на момент `cutoffMs`; строка не по схеме живёт до конца своего дня. */
function isAlive(line: IndexLine, day: string, cutoffMs: number): boolean {
  if (line.record === null) return endOfDayMs(day) >= cutoffMs;
  const at = Date.parse(line.record.at);
  return (Number.isNaN(at) ? endOfDayMs(day) : at) >= cutoffMs;
}

/**
 * Очистка по сроку. Запись старше `retentionDays` удаляется из индекса; файл удаляется, когда у
 * него не осталось живых записей; файл без единой записи удаляется по mtime (сирота после
 * сбоя индекса), `.tmp-*` старше часа - тоже. Если индекс прочитан не целиком, файлы не
 * удаляются вовсе (иначе можно снести файл с живой записью в нечитаемом файле индекса).
 */
export async function purgeStore(
  layout: Layout,
  now: Date,
  retentionDays: number,
): Promise<PurgeResult> {
  const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
  const result: PurgeResult = { files: 0, records: 0, bytes: 0, orphans: 0 };
  const index = await loadIndex(layout.indexDir);
  const live = new Set<string>();
  const known = new Set<string>();
  for (const entry of index.days) {
    for (const line of entry.lines) {
      if (line.record === null) continue;
      known.add(line.record.path);
      if (isAlive(line, entry.day, cutoff)) live.add(line.record.path);
    }
  }
  const scan = await scanStore(layout.filesDir);
  if (index.ok) {
    for (const file of scan.files) {
      if (live.has(file.rel)) continue;
      const expired = known.has(file.rel);
      if (!expired && file.mtimeMs >= cutoff) continue;
      if (!(await removeFile(file.abs))) continue;
      result.bytes += file.size;
      if (expired) result.files += 1;
      else result.orphans += 1;
    }
  }
  for (const temp of scan.temps) {
    if (temp.mtimeMs >= now.getTime() - TEMP_MAX_AGE_MS) continue;
    if (!(await removeFile(temp.abs))) continue;
    result.bytes += temp.size;
    result.orphans += 1;
  }
  await dropEmptyDirs(scan.threadDirs);
  const staleRewrites = await removeStaleRewrites(layout.indexDir, now);
  result.orphans += staleRewrites.count;
  result.bytes += staleRewrites.bytes;
  result.records = await pruneIndex(
    layout.indexDir,
    index,
    (line, day) => !isAlive(line, day, cutoff),
  );
  return result;
}

/** Итог вытеснения плюс сколько байт осталось в архиве. */
export interface EvictOutcome extends EvictResult {
  remaining: number;
}

/**
 * Удалять файлы от самого старого (по последней записи индекса, без записи - по mtime), пока
 * сумма размеров не станет не больше `targetBytes`. Записи индекса удалённых файлов убираются.
 */
export async function evictToTarget(layout: Layout, targetBytes: number): Promise<EvictOutcome> {
  const scan = await scanStore(layout.filesDir);
  let total = scan.files.reduce((sum, file) => sum + file.size, 0);
  if (total <= targetBytes) return { evicted: 0, bytes: 0, remaining: total };
  const index = await loadIndex(layout.indexDir);
  const lastSeen = new Map<string, number>();
  for (const entry of index.days) {
    for (const line of entry.lines) {
      if (line.record === null) continue;
      const at = Date.parse(line.record.at);
      const previous = lastSeen.get(line.record.path) ?? Number.NEGATIVE_INFINITY;
      if (!Number.isNaN(at) && at > previous) lastSeen.set(line.record.path, at);
    }
  }
  const order = scan.files
    .map((file) => ({ file, age: lastSeen.get(file.rel) ?? file.mtimeMs }))
    .sort((a, b) => a.age - b.age || a.file.rel.localeCompare(b.file.rel));
  const gone = new Set<string>();
  let bytes = 0;
  for (const { file } of order) {
    if (total <= targetBytes) break;
    if (!(await removeFile(file.abs))) continue;
    gone.add(file.rel);
    total -= file.size;
    bytes += file.size;
  }
  if (gone.size > 0) {
    await pruneIndex(layout.indexDir, index, (line) => {
      return line.record !== null && gone.has(line.record.path);
    });
    await dropEmptyDirs(scan.threadDirs);
  }
  return { evicted: gone.size, bytes, remaining: total };
}
