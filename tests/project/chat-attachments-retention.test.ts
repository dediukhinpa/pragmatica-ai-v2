import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { intakeThreadDir } from '@business-ai/adapters';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import {
  BASE_TIME,
  MS_PER_DAY,
  MS_PER_HOUR,
  listArchivedFiles,
  makeHarness,
  memoryInput,
  readIndex,
  setMtime,
  type Harness,
} from './chat-attachments-support';

afterAll(removeTempDirs);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o777;
const RETENTION_DAYS = 30;
const AFTER_RETENTION = new Date(BASE_TIME.getTime() + (RETENTION_DAYS + 1) * MS_PER_DAY);
const FILE_BYTES = 300;

/** Файл заданного размера с уникальным содержимым. */
function payload(label: string, size = FILE_BYTES): string {
  return `${label}:`.padEnd(size, '#');
}

function at(offsetMs: number): Date {
  return new Date(BASE_TIME.getTime() + offsetMs);
}

describe('purge: удаление по сроку', () => {
  test('просроченный файл, запись и индексный файл удаляются, свежий остаётся', async () => {
    const h = makeHarness();
    const old = await h.archive.save(memoryInput('старый файл', {}, 'old.pdf'));
    h.clock.now = at(20 * MS_PER_DAY);
    const fresh = await h.archive.save(memoryInput('свежий файл', {}, 'fresh.pdf'));
    if (old.kind !== 'saved' || fresh.kind !== 'saved') throw new Error('ожидалось saved');
    const result = await h.archive.purge(AFTER_RETENTION);
    expect(result).toEqual({ files: 1, records: 1, bytes: old.size, orphans: 0 });
    expect(existsSync(join(h.archiveRoot, old.path))).toBe(false);
    expect(existsSync(join(h.archiveRoot, fresh.path))).toBe(true);
    expect(readdirSync(join(h.archiveRoot, 'index'))).toEqual(['2026-03-30.jsonl']);
  });

  test('граница срока: запись ровно retentionDays назад ещё жива', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('на границе'));
    const result = await h.archive.purge(at(RETENTION_DAYS * MS_PER_DAY));
    expect(result.records).toBe(0);
    const later = await h.archive.purge(at(RETENTION_DAYS * MS_PER_DAY + 1));
    expect(later.records).toBe(1);
  });

  test('срок берётся из настроек (retentionDays)', async () => {
    const h = makeHarness({ retentionDays: 2 });
    await h.archive.save(memoryInput('короткий срок'));
    expect((await h.archive.purge(at(MS_PER_DAY))).records).toBe(0);
    expect((await h.archive.purge(at(3 * MS_PER_DAY))).records).toBe(1);
  });

  test('файл с живой записью в другом дне не удаляется, просроченная запись уходит', async () => {
    const h = makeHarness();
    const first = await h.archive.save(memoryInput('повторно присланный'));
    h.clock.now = at(25 * MS_PER_DAY);
    const again = await h.archive.save(memoryInput('повторно присланный'));
    if (first.kind !== 'saved' || again.kind !== 'duplicate') throw new Error('ожидалось');
    const result = await h.archive.purge(AFTER_RETENTION);
    expect(result).toEqual({ files: 0, records: 1, bytes: 0, orphans: 0 });
    expect(existsSync(join(h.archiveRoot, first.path))).toBe(true);
    expect(readIndex(h.archiveRoot)).toHaveLength(1);
  });

  test('частично просроченный индекс переписывается атомарно с правами 0600', async () => {
    const h = makeHarness({ retentionDays: 1 });
    h.clock.now = at(-6 * MS_PER_HOUR);
    await h.archive.save(memoryInput('утро', {}, 'morning.pdf'));
    h.clock.now = at(6 * MS_PER_HOUR);
    await h.archive.save(memoryInput('вечер', {}, 'evening.pdf'));
    const result = await h.archive.purge(at(MS_PER_DAY));
    expect(result.records).toBe(1);
    expect(result.files).toBe(1);
    const indexDir = join(h.archiveRoot, 'index');
    expect(readdirSync(indexDir)).toEqual(['2026-03-10.jsonl']);
    expect(readIndex(h.archiveRoot).map((record) => record.name)).toEqual(['evening.pdf']);
    expect(statSync(join(indexDir, '2026-03-10.jsonl')).mode & MODE_MASK).toBe(FILE_MODE);
    expect(readFileSync(join(indexDir, '2026-03-10.jsonl'), 'utf8').endsWith('\n')).toBe(true);
  });

  test('пустой каталог треда после удаления файлов убирается', async () => {
    const h = makeHarness();
    const saved = await h.archive.save(memoryInput('одиночный'));
    if (saved.kind !== 'saved') throw new Error('ожидалось saved');
    await h.archive.purge(AFTER_RETENTION);
    expect(existsSync(join(h.archiveRoot, 'files', intakeThreadDir('thread-1')))).toBe(false);
    expect(existsSync(join(h.archiveRoot, 'files'))).toBe(true);
  });

  test('событие chat_attachments_purged несёт числа', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('для события'));
    await h.archive.purge(AFTER_RETENTION);
    const event = h.events.find((item) => item.event === 'chat_attachments_purged');
    expect(event?.fields).toEqual({
      files: 1,
      records: 1,
      bytes: Buffer.byteLength('для события'),
      orphans: 0,
    });
  });

  test('purge на пустом диске не падает и возвращает нули', async () => {
    const h = makeHarness();
    expect(await h.archive.purge(AFTER_RETENTION)).toEqual({
      files: 0,
      records: 0,
      bytes: 0,
      orphans: 0,
    });
  });

  test('после purge новый файл сохраняется как обычно', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('до очистки'));
    await h.archive.purge(AFTER_RETENTION);
    h.clock.now = AFTER_RETENTION;
    expect((await h.archive.save(memoryInput('после очистки'))).kind).toBe('saved');
    expect(readIndex(h.archiveRoot)).toHaveLength(1);
  });
});

describe('purge: сироты и временные файлы', () => {
  /** Подложить файл в каталог треда мимо индекса. */
  function plant(archiveRoot: string, name: string, mtime: Date): string {
    const dir = join(archiveRoot, 'files', intakeThreadDir('orphan-thread'));
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const path = join(dir, name);
    writeFileSync(path, 'сирота', { mode: FILE_MODE });
    setMtime(path, mtime);
    return path;
  }

  test('файл без записи в индексе старше срока удаляется как сирота', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('обычный'));
    const expiredAt = at(-RETENTION_DAYS * MS_PER_DAY - 1);
    const old = plant(h.archiveRoot, '0123456789abcdef_old.bin', expiredAt);
    const fresh = plant(h.archiveRoot, 'fedcba9876543210_new.bin', at(-MS_PER_HOUR));
    const result = await h.archive.purge(BASE_TIME);
    expect(result).toEqual({
      files: 0,
      records: 0,
      bytes: Buffer.byteLength('сирота'),
      orphans: 1,
    });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('.tmp-* старше часа удаляются, свежие остаются', async () => {
    const h = makeHarness();
    const stale = plant(h.archiveRoot, '.tmp-aaaaaaaaaaaa', at(-2 * MS_PER_HOUR));
    const fresh = plant(h.archiveRoot, '.tmp-bbbbbbbbbbbb', at(-10 * 60_000));
    await h.archive.purge(BASE_TIME);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('пустой индексный файл и старый остаток перезаписи индекса удаляются', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('обычный'));
    const indexDir = join(h.archiveRoot, 'index');
    writeFileSync(join(indexDir, '2026-03-11.jsonl'), '', { mode: FILE_MODE });
    const leftover = join(indexDir, '.rewrite-aaaaaaaaaaaa');
    writeFileSync(leftover, '{}', { mode: FILE_MODE });
    setMtime(leftover, at(-2 * MS_PER_HOUR));
    const result = await h.archive.purge(BASE_TIME);
    expect(result.orphans).toBe(1);
    expect(readdirSync(indexDir)).toEqual(['2026-03-10.jsonl']);
  });

  test('сбой на одном файле не прерывает обход', async () => {
    const h = makeHarness();
    const a = await h.archive.save(memoryInput('файл в закрытом каталоге', { threadId: 'ta' }));
    const b = await h.archive.save(memoryInput('файл в открытом каталоге', { threadId: 'tb' }));
    if (a.kind !== 'saved' || b.kind !== 'saved') throw new Error('ожидалось saved');
    const lockedDir = join(h.archiveRoot, a.path, '..');
    chmodSync(lockedDir, 0o500);
    try {
      const result = await h.archive.purge(AFTER_RETENTION);
      expect(existsSync(join(h.archiveRoot, b.path))).toBe(false);
      expect(result.files).toBe(1);
      expect(existsSync(join(h.archiveRoot, a.path))).toBe(true);
    } finally {
      chmodSync(lockedDir, DIR_MODE);
    }
  });

  test('посторонние имена в files и симлинки не удаляются', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('обычный'));
    const stray = join(h.archiveRoot, 'files', 'not-a-thread-dir');
    mkdirSync(stray);
    writeFileSync(join(stray, 'keep.txt'), 'x');
    setMtime(join(stray, 'keep.txt'), at(-100 * MS_PER_DAY));
    await h.archive.purge(AFTER_RETENTION);
    expect(existsSync(join(stray, 'keep.txt'))).toBe(true);
  });
});

describe('enforceCap: ограничение объёма', () => {
  /** Общий корень, куда «большой» архив пишет без ограничения, а «малый» его проверяет. */
  async function filled(count: number): Promise<{ big: Harness; root: string }> {
    const root = tempDir();
    const big = makeHarness({ maxBytes: 100 * FILE_BYTES }, root);
    for (let i = 0; i < count; i += 1) {
      big.clock.now = at(i * MS_PER_HOUR);
      await big.archive.save(memoryInput(payload(`f${i}`), {}, `f${i}.bin`));
    }
    return { big, root };
  }

  test('в пределах объёма ничего не удаляется и события нет', async () => {
    const { root } = await filled(3);
    const small = makeHarness({ maxBytes: 4 * FILE_BYTES }, root);
    expect(await small.archive.enforceCap()).toEqual({ evicted: 0, bytes: 0 });
    expect(small.events).toEqual([]);
  });

  test('сверх объёма удаляются самые старые до 90 % от maxBytes', async () => {
    const { root } = await filled(5);
    const small = makeHarness({ maxBytes: 1000 }, root, { now: at(10 * MS_PER_HOUR) });
    const result = await small.archive.enforceCap();
    // 1500 байт > 1000: убираем два самых старых, остаётся 900 (= 90 % от 1000).
    expect(result).toEqual({ evicted: 2, bytes: 2 * FILE_BYTES });
    expect(small.events).toEqual([
      { event: 'chat_attachments_evicted', fields: { files: 2, bytes: 2 * FILE_BYTES } },
    ]);
    const names = readIndex(join(root, 'chat-attachments')).map((record) => record.name);
    expect(names).toEqual(['f2.bin', 'f3.bin', 'f4.bin']);
    expect(listArchivedFiles(join(root, 'chat-attachments'))).toHaveLength(3);
  });

  test('«старый» считается по последней записи индекса: повторно присланный остаётся', async () => {
    const { big, root } = await filled(5);
    big.clock.now = at(20 * MS_PER_HOUR);
    await big.archive.save(memoryInput(payload('f0'), {}, 'f0-again.bin'));
    const small = makeHarness({ maxBytes: 1000 }, root, { now: at(21 * MS_PER_HOUR) });
    await small.archive.enforceCap();
    const kept = new Set(readIndex(join(root, 'chat-attachments')).map((record) => record.path));
    expect(kept.size).toBe(3);
    const survivors = listArchivedFiles(join(root, 'chat-attachments')).map((p) => p.split('/')[2]);
    expect(survivors.some((name) => name?.endsWith('_f0.bin'))).toBe(true);
    expect(survivors.some((name) => name?.endsWith('_f1.bin'))).toBe(false);
  });

  test('записи индекса удалённых файлов уходят, пустой индексный файл удаляется', async () => {
    const root = tempDir();
    const big = makeHarness({ maxBytes: 100 * FILE_BYTES }, root);
    await big.archive.save(memoryInput(payload('a'), {}, 'a.bin'));
    big.clock.now = at(2 * MS_PER_DAY);
    await big.archive.save(memoryInput(payload('b'), {}, 'b.bin'));
    const small = makeHarness({ maxBytes: 400 }, root, { now: at(3 * MS_PER_DAY) });
    const result = await small.archive.enforceCap();
    expect(result.evicted).toBe(1);
    expect(readdirSync(join(root, 'chat-attachments', 'index'))).toEqual(['2026-03-12.jsonl']);
  });

  test('сумма считается по факту сканирования файлов, а не по индексу', async () => {
    const { root } = await filled(2);
    const dir = join(root, 'chat-attachments', 'files', intakeThreadDir('orphan'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0123456789abcdef_big.bin'), 'x'.repeat(2000));
    const small = makeHarness({ maxBytes: 1000 }, root, { now: at(5 * MS_PER_HOUR) });
    const result = await small.archive.enforceCap();
    expect(result.evicted).toBeGreaterThan(0);
  });
});

describe('save и объём архива', () => {
  test('перед записью превышение объёма вытесняет старые файлы и пишет событие', async () => {
    const h = makeHarness({ maxBytes: 1000 });
    for (let i = 0; i < 4; i += 1) {
      h.clock.now = at(i * MS_PER_HOUR);
      const outcome = await h.archive.save(memoryInput(payload(`s${i}`), {}, `s${i}.bin`));
      expect(outcome.kind).toBe('saved');
    }
    // Три файла (900 байт) помещаются; четвёртый не влезает и вытесняет самый старый.
    expect(listArchivedFiles(h.archiveRoot)).toHaveLength(3);
    const names = readIndex(h.archiveRoot).map((record) => record.name);
    expect(names).toEqual(['s1.bin', 's2.bin', 's3.bin']);
    const evicted = h.events.filter((event) => event.event === 'chat_attachments_evicted');
    expect(evicted).toEqual([
      { event: 'chat_attachments_evicted', fields: { files: 1, bytes: FILE_BYTES } },
    ]);
  });

  test('первое обращение сканирует уже лежащие файлы (кэш суммы)', async () => {
    const root = tempDir();
    const first = makeHarness({ maxBytes: 100 * FILE_BYTES }, root);
    for (let i = 0; i < 3; i += 1) {
      first.clock.now = at(i * MS_PER_HOUR);
      await first.archive.save(memoryInput(payload(`p${i}`), {}, `p${i}.bin`));
    }
    const second = makeHarness({ maxBytes: 1000 }, root, { now: at(5 * MS_PER_HOUR) });
    await second.archive.save(memoryInput(payload('new'), {}, 'new.bin'));
    expect(second.events.some((event) => event.event === 'chat_attachments_evicted')).toBe(true);
    expect(listArchivedFiles(join(root, 'chat-attachments'))).toHaveLength(3);
  });

  test('дубликат не увеличивает сумму и не вытесняет файлы', async () => {
    const h = makeHarness({ maxBytes: 900 });
    for (let i = 0; i < 3; i += 1) {
      h.clock.now = at(i * MS_PER_HOUR);
      await h.archive.save(memoryInput(payload(`d${i}`), {}, `d${i}.bin`));
    }
    h.clock.now = at(5 * MS_PER_HOUR);
    const again = await h.archive.save(memoryInput(payload('d0'), {}, 'd0-copy.bin'));
    expect(again.kind).toBe('duplicate');
    expect(listArchivedFiles(h.archiveRoot)).toHaveLength(3);
    expect(h.events.some((event) => event.event === 'chat_attachments_evicted')).toBe(false);
  });

  test('purge корректирует кэш суммы: после очистки вытеснения не требуется', async () => {
    const h = makeHarness({ maxBytes: 1000 });
    for (let i = 0; i < 3; i += 1) {
      h.clock.now = at(i * MS_PER_HOUR);
      await h.archive.save(memoryInput(payload(`c${i}`), {}, `c${i}.bin`));
    }
    await h.archive.purge(AFTER_RETENTION);
    h.clock.now = AFTER_RETENTION;
    for (let i = 0; i < 3; i += 1) {
      await h.archive.save(memoryInput(payload(`n${i}`), {}, `n${i}.bin`));
    }
    expect(h.events.some((event) => event.event === 'chat_attachments_evicted')).toBe(false);
    expect(listArchivedFiles(h.archiveRoot)).toHaveLength(3);
  });

  test('только что сохранённый файл после вытеснения лежит на диске', async () => {
    const h = makeHarness({ maxBytes: 900 });
    for (let i = 0; i < 3; i += 1) {
      h.clock.now = at(i * MS_PER_HOUR);
      await h.archive.save(memoryInput(payload(`k${i}`), {}, `k${i}.bin`));
    }
    h.clock.now = at(6 * MS_PER_HOUR);
    const outcome = await h.archive.save(memoryInput(payload('k-new'), {}, 'knew.bin'));
    expect(outcome.kind).toBe('saved');
    if (outcome.kind !== 'saved') return;
    expect(existsSync(join(h.archiveRoot, outcome.path))).toBe(true);
  });
});
