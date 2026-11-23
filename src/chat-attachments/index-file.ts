import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_MODE, REWRITE_PREFIX, TEMP_SUFFIX_BYTES, INDEX_VERSION } from './constants';
import { lstatOrNull, removeFile } from './fs-util';
import type { ChatAttachmentRecord } from './types';

const INDEX_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const INDEX_SUFFIX = '.jsonl';
const DAY_CHARS = 10;
const END_OF_DAY = 'T23:59:59.999Z';
/** Запись только в конец и без перехода по симлинку (на симлинк open даёт ELOOP). */
const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/** Строка индекса: сырой текст и разобранная запись (null - строка не по схеме). */
export interface IndexLine {
  raw: string;
  record: ChatAttachmentRecord | null;
}

/** Индексный файл одного UTC-дня. */
export interface IndexDay {
  /** День `YYYY-MM-DD`. */
  day: string;
  file: string;
  lines: IndexLine[];
}

/** Содержимое индекса; `ok` ложно, если какой-то файл индекса не удалось прочитать. */
export interface LoadedIndex {
  days: IndexDay[];
  ok: boolean;
}

/** UTC-день момента, `YYYY-MM-DD`. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, DAY_CHARS);
}

/** Имя индексного файла дня. */
export function indexFileName(day: string): string {
  return `${day}${INDEX_SUFFIX}`;
}

/** Конец UTC-дня, мс (для просрочки строк, которые не удалось разобрать). */
export function endOfDayMs(day: string): number {
  return Date.parse(`${day}${END_OF_DAY}`);
}

function isStringField(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'string';
}

/** Запись индекса схемы v1 (проверка структуры без доверия к типу). */
export function isRecord(value: unknown): value is ChatAttachmentRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['v'] !== INDEX_VERSION) return false;
  const stringKeys = ['at', 'agent', 'bot', 'thread', 'user', 'name', 'sha256', 'path', 'key'];
  if (!stringKeys.every((key) => isStringField(value, key))) return false;
  return typeof record['size'] === 'number' && Number.isFinite(record['size']);
}

/** Разобрать строку индекса; не по схеме - null. */
export function parseIndexLine(raw: string): ChatAttachmentRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Строки индексного файла; нет файла или это не обычный файл - null. Симлинки не читаются. */
export async function readIndexLines(file: string): Promise<IndexLine[] | null> {
  const info = await lstatOrNull(file);
  if (info === null || !info.isFile()) return null;
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((raw) => raw.trim() !== '')
    .map((raw) => ({ raw, record: parseIndexLine(raw) }));
}

/** Дни, для которых есть индексный файл, по возрастанию. Нет каталога - пусто. */
export async function listIndexDays(indexDir: string): Promise<string[]> {
  const names = await readdir(indexDir).catch(() => [] as string[]);
  const days: string[] = [];
  for (const name of names) {
    const match = INDEX_FILE.exec(name);
    if (match?.[1] !== undefined) days.push(match[1]);
  }
  return days.sort();
}

/**
 * Прочитать индекс целиком (или дни из диапазона `[fromDay, toDay]`). Нечитаемый файл
 * не обрывает чтение: он пропускается, а `ok` становится ложным.
 */
export async function loadIndex(
  indexDir: string,
  range: { fromDay?: string | undefined; toDay?: string | undefined } = {},
): Promise<LoadedIndex> {
  const days: IndexDay[] = [];
  let ok = true;
  for (const day of await listIndexDays(indexDir)) {
    if (range.fromDay !== undefined && day < range.fromDay) continue;
    if (range.toDay !== undefined && day > range.toDay) continue;
    const file = join(indexDir, indexFileName(day));
    try {
      const lines = await readIndexLines(file);
      if (lines !== null) days.push({ day, file, lines });
    } catch {
      ok = false;
    }
  }
  return { days, ok };
}

/** Дописать запись в индекс дня: одна строка JSON, права 0600, симлинк не разыменовывается. */
export async function appendRecord(file: string, record: ChatAttachmentRecord): Promise<void> {
  const handle = await open(file, APPEND_FLAGS, FILE_MODE);
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
}

/** Атомарно переписать индексный файл (временный файл рядом и rename). */
async function rewriteAtomic(indexDir: string, file: string, lines: IndexLine[]): Promise<void> {
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString('hex');
  const temp = join(indexDir, `${REWRITE_PREFIX}${suffix}`);
  try {
    const text = `${lines.map((line) => line.raw).join('\n')}\n`;
    await writeFile(temp, text, { mode: FILE_MODE, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await removeFile(temp);
    throw error;
  }
}

function countRecords(lines: IndexLine[]): number {
  return lines.filter((line) => line.record !== null).length;
}

/**
 * Убрать из индекса строки, отобранные `shouldDrop`. Полностью опустевший файл удаляется,
 * частично изменённый переписывается атомарно. Сбой на одном файле не прерывает обход.
 * Возвращает число убранных разобранных записей.
 */
export async function pruneIndex(
  indexDir: string,
  index: LoadedIndex,
  shouldDrop: (line: IndexLine, day: string) => boolean,
): Promise<number> {
  let dropped = 0;
  for (const entry of index.days) {
    // Пустой индексный файл (например, после сбоя) просто удаляется.
    if (entry.lines.length === 0) {
      await removeFile(entry.file);
      continue;
    }
    const kept = entry.lines.filter((line) => !shouldDrop(line, entry.day));
    if (kept.length === entry.lines.length) continue;
    const done =
      kept.length === 0
        ? await removeFile(entry.file)
        : await rewriteAtomic(indexDir, entry.file, kept).then(
            () => true,
            () => false,
          );
    if (done) dropped += countRecords(entry.lines) - countRecords(kept);
  }
  return dropped;
}
