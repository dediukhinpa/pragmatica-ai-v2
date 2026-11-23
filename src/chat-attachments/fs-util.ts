import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { DIR_MODE, FILE_MODE } from './constants';
import type { ChatAttachmentDiskFile } from './types';

const UNKNOWN_CODE = 'unknown';
/** Биты прав группы и прочих: у каталога архива их быть не должно. */
const GROUP_OTHER_BITS = 0o077;
/** Коды, при которых жёсткая ссылка невозможна и файл копируется потоком. */
const LINK_FALLBACK_CODES: readonly string[] = ['EXDEV', 'EPERM', 'EMLINK'];

/** Ошибка архива с собственным кодом (путь небезопасен, источник не файл и т. п.). */
export class ArchiveError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

/** Код ошибки для журнала: `error.code`, иначе `error.name`. Текст ошибки не берётся. */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string' && error.code !== '') return error.code;
    if ('name' in error && typeof error.name === 'string' && error.name !== '') return error.name;
  }
  return UNKNOWN_CODE;
}

/** Совпадает ли код ошибки файловой системы. */
export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** `lstat` без исключения: нет файла или нет доступа - null. Симлинки не разыменовываются. */
export async function lstatOrNull(path: string): Promise<Stats | null> {
  return lstat(path).catch(() => null);
}

/**
 * Убедиться, что `path` - настоящий каталог (не симлинк). `create` создаёт его с правами 0700.
 * Возвращает false, если каталога нет и создавать не просили; на симлинк и не-каталог
 * бросает `unsafe_path`.
 */
export async function ensureDir(path: string, create: boolean): Promise<boolean> {
  let info = await lstatOrNull(path);
  if (info === null) {
    if (!create) return false;
    try {
      await mkdir(path, { mode: DIR_MODE });
      await chmod(path, DIR_MODE);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ArchiveError('unsafe_path');
  // Каталог мог создать другой код (проба патча) с широкими правами: файлы читает только сервис.
  if (create && (info.mode & GROUP_OTHER_BITS) !== 0) {
    await chmod(path, DIR_MODE).catch(() => undefined);
  }
  return true;
}

/** Результат хэширования источника. */
export interface Digest {
  sha256: string;
  size: number;
}

/** sha256 содержимого из памяти. */
export function hashBytes(content: Uint8Array): Digest {
  return { sha256: createHash('sha256').update(content).digest('hex'), size: content.byteLength };
}

/** sha256 файла потоком: на диске должен лежать обычный файл (не симлинк), память не растёт. */
export async function hashDiskFile(path: string): Promise<Digest> {
  const info = await lstat(path);
  if (!info.isFile()) throw new ArchiveError('bad_source');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const part = chunk as Buffer;
    hash.update(part);
    size += part.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Записать содержимое из памяти во временный файл (`wx`: поверх чужого не пишем). */
export async function writeMemoryTemp(temp: string, content: Uint8Array): Promise<void> {
  await writeFile(temp, content, { mode: FILE_MODE, flag: 'wx' });
  await chmod(temp, FILE_MODE);
}

/**
 * Положить файл с диска под временным именем: жёсткая ссылка не копирует данные; на другом
 * томе (EXDEV/EPERM) - копия потоком. Права файла приводятся к 0600.
 */
export async function linkDiskTemp(source: ChatAttachmentDiskFile, temp: string): Promise<void> {
  await link(source.path, temp).catch(async (error: unknown) => {
    if (!LINK_FALLBACK_CODES.includes(errorCode(error))) throw error;
    await copyFile(source.path, temp);
  });
  await chmod(temp, FILE_MODE);
}

/** Удалить файл; сбой не бросает, результат - удалось ли. */
export async function removeFile(path: string): Promise<boolean> {
  return rm(path, { force: true }).then(
    () => true,
    () => false,
  );
}
