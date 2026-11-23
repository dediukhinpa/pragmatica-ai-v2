import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { intakeThreadDir } from '@business-ai/adapters';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { ChatAttachmentArchive } from '../../src/chat-attachments';
import {
  diskInput,
  listArchivedFiles,
  makeHarness,
  memoryInput,
  readIndex,
  setMtime,
  sha256Of,
  testConfig,
  BASE_TIME,
  MS_PER_DAY,
} from './chat-attachments-support';

afterAll(removeTempDirs);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o777;
const HASH_CHARS = 16;
const STALE_MTIME = new Date('2020-01-01T00:00:00.000Z');

describe('сохранение из памяти', () => {
  test('файл ложится в files/<хэш треда>/<sha256[0..16]>_<имя>', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('содержимое файла'));
    const sha = sha256Of('содержимое файла');
    const dir = intakeThreadDir('thread-1');
    expect(outcome).toEqual({
      kind: 'saved',
      path: `files/${dir}/${sha.slice(0, HASH_CHARS)}_report.pdf`,
      sha256: sha,
      size: Buffer.byteLength('содержимое файла'),
    });
    expect(dir).toMatch(/^[0-9a-f]{16}$/);
    const saved = readFileSync(join(h.archiveRoot, (outcome as { path: string }).path), 'utf8');
    expect(saved).toBe('содержимое файла');
  });

  test('в каталоге треда не остаётся временных файлов', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('abc'));
    expect(listArchivedFiles(h.archiveRoot).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  test('событие saved несёт только размер и признак дубликата', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('abcd', {}, 'секретное-имя.docx'));
    expect(h.events).toEqual([{ event: 'chat_attachment_saved', fields: { size: 4, dup: 0 } }]);
    expect(JSON.stringify(h.events)).not.toContain('секретное');
  });

  test('имя с выходом из каталога остаётся внутри корня архива', async () => {
    const h = makeHarness();
    const names = ['../x', '../../escape.txt', 'a/b', '.hidden', 'n\0ul', 'я'.repeat(400)];
    for (const [index, name] of names.entries()) {
      const outcome = await h.archive.save(memoryInput(`данные-${index}`, {}, name));
      expect(outcome.kind).toBe('saved');
    }
    const files = listArchivedFiles(h.archiveRoot);
    expect(files).toHaveLength(names.length);
    for (const rel of files) {
      expect(rel).toMatch(/^files\/[0-9a-f]{16}\/[0-9a-f]{16}_[^/\\\0]+$/);
      expect(rel.split('/').pop()?.slice(HASH_CHARS + 1).startsWith('.')).toBe(false);
    }
    expect(existsSync(join(h.intakeRoot, 'escape.txt'))).toBe(false);
    expect(existsSync(join(h.archiveRoot, 'x'))).toBe(false);
  });

  test('любое расширение принимается (в отличие от приёма)', async () => {
    const h = makeHarness();
    for (const name of ['a.exe', 'b.sh', 'c.zip', 'd']) {
      const outcome = await h.archive.save(memoryInput(`x-${name}`, {}, name));
      expect(outcome.kind).toBe('saved');
    }
  });

  test('параллельные сохранения не теряют записи индекса', async () => {
    const h = makeHarness();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        h.archive.save(memoryInput(`файл ${i}`, {}, `f${i}.txt`)),
      ),
    );
    expect(results.every((result) => result.kind === 'saved')).toBe(true);
    expect(readIndex(h.archiveRoot)).toHaveLength(20);
  });
});

describe('устойчивость', () => {
  test('сбой приёмника событий не ломает сохранение', async () => {
    const root = tempDir();
    const harness = makeHarness({}, root);
    const archive = new ChatAttachmentArchive({
      intakeRoot: root,
      config: harness.config,
      onEvent: () => {
        throw new Error('журнал недоступен');
      },
    });
    expect((await archive.save(memoryInput('данные'))).kind).toBe('saved');
  });

  test('без onEvent и clock архив работает на системных часах', async () => {
    const root = tempDir();
    const archive = new ChatAttachmentArchive({ intakeRoot: root, config: testConfig() });
    const outcome = await archive.save(memoryInput('данные'));
    expect(outcome.kind).toBe('saved');
    const [record] = await archive.find({});
    expect(Date.now() - Date.parse(record?.at ?? '')).toBeLessThan(MS_PER_DAY);
  });
});

describe('сохранение с диска', () => {
  test('файл с диска попадает в архив, содержимое совпадает', async () => {
    const h = makeHarness();
    const spoolDir = tempDir();
    const outcome = await h.archive.save(diskInput(spoolDir, 'байты со спула'));
    expect(outcome.kind).toBe('saved');
    if (outcome.kind !== 'saved') return;
    expect(outcome.sha256).toBe(sha256Of('байты со спула'));
    expect(outcome.size).toBe(Buffer.byteLength('байты со спула'));
    expect(readFileSync(join(h.archiveRoot, outcome.path), 'utf8')).toBe('байты со спула');
  });

  test('исходный файл на диске остаётся нетронутым', async () => {
    const h = makeHarness();
    const input = diskInput(tempDir(), 'спул остаётся');
    await h.archive.save(input);
    const source = input.file.disk?.path ?? '';
    expect(readFileSync(source, 'utf8')).toBe('спул остаётся');
  });

  test('размер берётся с диска, а не из пустого content', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(diskInput(tempDir(), '12345'));
    expect(outcome).toMatchObject({ kind: 'saved', size: 5 });
  });

  test('отсутствующий файл на диске даёт failed, а не исключение', async () => {
    const h = makeHarness();
    const input = diskInput(tempDir(), 'будет удалён');
    const disk = input.file.disk;
    if (disk === undefined) throw new Error('нет disk');
    const broken = { ...disk, path: '/nonexistent/x' };
    const missing = { ...input, file: { ...input.file, disk: broken } };
    const outcome = await h.archive.save(missing);
    expect(outcome).toEqual({ kind: 'failed', code: 'ENOENT' });
    expect(h.events.at(-1)).toEqual({
      event: 'chat_attachment_failed',
      fields: { code: 'ENOENT' },
    });
  });

  test('символическая ссылка вместо файла на диске не принимается', async () => {
    const h = makeHarness();
    const dir = tempDir();
    writeFileSync(join(dir, 'real'), 'данные');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const outcome = await h.archive.save({
      threadId: 'thread-1',
      userId: 'u-1',
      file: { name: 'l', content: new Uint8Array(0), disk: { path: join(dir, 'link'), size: 12 } },
    });
    expect(outcome.kind).toBe('failed');
  });
});

describe('дубликаты и повторная доставка', () => {
  test('тот же файл в том же треде не пишется заново, mtime обновляется', async () => {
    const h = makeHarness();
    const first = await h.archive.save(memoryInput('одинаковое', {}, 'a.pdf'));
    if (first.kind !== 'saved') throw new Error('ожидалось saved');
    const absolute = join(h.archiveRoot, first.path);
    utimesSync(absolute, STALE_MTIME, STALE_MTIME);
    const second = await h.archive.save(memoryInput('одинаковое', {}, 'b-other-name.pdf'));
    expect(second).toEqual({ ...first, kind: 'duplicate' });
    expect(listArchivedFiles(h.archiveRoot)).toHaveLength(1);
    expect(statSync(absolute).mtimeMs).toBeGreaterThan(STALE_MTIME.getTime());
    expect(h.events.at(-1)).toEqual({
      event: 'chat_attachment_saved',
      fields: { size: first.size, dup: 1 },
    });
  });

  test('дубликат получает новую запись индекса с исходным именем', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('одинаковое', {}, 'a.pdf'));
    await h.archive.save(memoryInput('одинаковое', {}, 'b.pdf'));
    const records = readIndex(h.archiveRoot);
    expect(records.map((record) => record.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(new Set(records.map((record) => record.path)).size).toBe(1);
  });

  test('тот же файл в другом треде сохраняется отдельно', async () => {
    const h = makeHarness();
    const one = await h.archive.save(memoryInput('общий', { threadId: 't-a' }));
    const two = await h.archive.save(memoryInput('общий', { threadId: 't-b' }));
    expect(one.kind).toBe('saved');
    expect(two.kind).toBe('saved');
    expect(listArchivedFiles(h.archiveRoot)).toHaveLength(2);
  });

  test('повторная доставка того же события не добавляет запись индекса', async () => {
    const h = makeHarness();
    const input = memoryInput('вложение события', { sourceKey: 'evt-1' });
    const first = await h.archive.save(input);
    const again = await h.archive.save(input);
    expect(first.kind).toBe('saved');
    expect(again.kind).toBe('duplicate');
    expect(readIndex(h.archiveRoot)).toHaveLength(1);
  });

  test('одно событие с несколькими файлами пишет запись на каждый файл', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('первый', { sourceKey: 'evt-2' }, 'one.pdf'));
    await h.archive.save(memoryInput('второй', { sourceKey: 'evt-2' }, 'two.pdf'));
    expect(readIndex(h.archiveRoot)).toHaveLength(2);
  });

  test('тот же файл другим событием (другой key) даёт новую запись', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('повтор', { sourceKey: 'evt-3' }));
    await h.archive.save(memoryInput('повтор', { sourceKey: 'evt-4' }));
    expect(readIndex(h.archiveRoot).map((record) => record.key)).toEqual(['evt-3', 'evt-4']);
  });

  test('ключи события помнятся и после перезапуска (читаются из индекса)', async () => {
    const root = tempDir();
    const first = makeHarness({}, root);
    await first.archive.save(memoryInput('перезапуск', { sourceKey: 'evt-5' }));
    const restarted = makeHarness({}, root, first.clock);
    const outcome = await restarted.archive.save(memoryInput('перезапуск', { sourceKey: 'evt-5' }));
    expect(outcome.kind).toBe('duplicate');
    expect(readIndex(restarted.archiveRoot)).toHaveLength(1);
  });

  test('помнятся только последние 1000 ключей', async () => {
    const h = makeHarness({ maxFilesPerThreadDay: 5000 });
    const total = 1002;
    for (let i = 0; i < total; i += 1) {
      await h.archive.save(memoryInput(`файл-${i}`, { sourceKey: `k-${i}` }, `f${i}.txt`));
    }
    // Самый старый ключ вытеснен: повтор считается новой доставкой.
    await h.archive.save(memoryInput('файл-0', { sourceKey: 'k-0' }, 'f0.txt'));
    expect(readIndex(h.archiveRoot)).toHaveLength(total + 1);
    // Свежий ключ ещё помнится.
    await h.archive.save(memoryInput(`файл-${total - 1}`, { sourceKey: `k-${total - 1}` }));
    expect(readIndex(h.archiveRoot)).toHaveLength(total + 1);
  }, 60_000);
});

describe('пропуски', () => {
  test('выключенное хранение: skipped disabled, на диск ничего не пишется', async () => {
    const h = makeHarness({ enabled: false });
    const outcome = await h.archive.save(memoryInput('данные'));
    expect(outcome).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(existsSync(h.archiveRoot)).toBe(false);
    expect(h.events).toEqual([
      { event: 'chat_attachment_skipped', fields: { reason: 'disabled' } },
    ]);
  });

  test('пустой файл (из памяти и с диска): skipped empty', async () => {
    const h = makeHarness();
    expect(await h.archive.save(memoryInput(''))).toEqual({ kind: 'skipped', reason: 'empty' });
    const input = diskInput(tempDir(), '');
    expect(await h.archive.save(input)).toEqual({ kind: 'skipped', reason: 'empty' });
  });

  test('файл больше maxFileBytes: skipped too_large', async () => {
    const h = makeHarness({ maxFileBytes: 10 });
    expect(await h.archive.save(memoryInput('x'.repeat(11)))).toEqual({
      kind: 'skipped',
      reason: 'too_large',
    });
    expect((await h.archive.save(memoryInput('x'.repeat(10)))).kind).toBe('saved');
    const big = await h.archive.save(diskInput(tempDir(), 'y'.repeat(11)));
    expect(big).toEqual({ kind: 'skipped', reason: 'too_large' });
  });

  test('лимит файлов на тред за UTC-сутки: skipped thread_limit', async () => {
    const h = makeHarness({ maxFilesPerThreadDay: 2 });
    expect((await h.archive.save(memoryInput('1'))).kind).toBe('saved');
    expect((await h.archive.save(memoryInput('2'))).kind).toBe('saved');
    expect(await h.archive.save(memoryInput('3'))).toEqual({
      kind: 'skipped',
      reason: 'thread_limit',
    });
    // Другой тред не затронут.
    expect((await h.archive.save(memoryInput('4', { threadId: 'other' }))).kind).toBe('saved');
    // Следующие UTC-сутки — лимит обнуляется.
    h.clock.now = new Date(BASE_TIME.getTime() + MS_PER_DAY);
    expect((await h.archive.save(memoryInput('5'))).kind).toBe('saved');
  });

  test('счётчик суток переживает перезапуск (читается из индекса)', async () => {
    const root = tempDir();
    const first = makeHarness({ maxFilesPerThreadDay: 1 }, root);
    await first.archive.save(memoryInput('1'));
    const restarted = makeHarness({ maxFilesPerThreadDay: 1 }, root, first.clock);
    expect(await restarted.archive.save(memoryInput('2'))).toEqual({
      kind: 'skipped',
      reason: 'thread_limit',
    });
  });

  test('файл больше всего архива: skipped no_space, остальные файлы целы', async () => {
    const h = makeHarness({ maxBytes: 100, maxFileBytes: 1000 });
    expect((await h.archive.save(memoryInput('мало'))).kind).toBe('saved');
    expect(await h.archive.save(memoryInput('x'.repeat(101)))).toEqual({
      kind: 'skipped',
      reason: 'no_space',
    });
    expect(listArchivedFiles(h.archiveRoot)).toHaveLength(1);
  });

  test('события skipped несут только причину', async () => {
    const h = makeHarness({ maxFileBytes: 1 });
    await h.archive.save(memoryInput('too big', {}, 'секрет.pdf'));
    expect(h.events).toEqual([
      { event: 'chat_attachment_skipped', fields: { reason: 'too_large' } },
    ]);
  });
});

describe('сбои записи и права', () => {
  test('каталог только для чтения: failed с кодом, исключения нет', async () => {
    const h = makeHarness();
    chmodSync(h.intakeRoot, 0o500);
    try {
      const outcome = await h.archive.save(memoryInput('данные'));
      expect(outcome).toEqual({ kind: 'failed', code: 'EACCES' });
      expect(h.events.at(-1)).toEqual({
        event: 'chat_attachment_failed',
        fields: { code: 'EACCES' },
      });
    } finally {
      chmodSync(h.intakeRoot, DIR_MODE);
    }
  });

  test('после починки прав следующий файл сохраняется', async () => {
    const h = makeHarness();
    chmodSync(h.intakeRoot, 0o500);
    await h.archive.save(memoryInput('первый'));
    chmodSync(h.intakeRoot, DIR_MODE);
    expect((await h.archive.save(memoryInput('второй'))).kind).toBe('saved');
  });

  test('каталоги 0700, файлы и индекс 0600', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('права'));
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    const file = join(h.archiveRoot, outcome.path);
    const threadDir = join(file, '..');
    const dayIndex = join(h.archiveRoot, 'index', '2026-03-10.jsonl');
    for (const dir of [h.archiveRoot, join(h.archiveRoot, 'files'), threadDir]) {
      expect(statSync(dir).mode & MODE_MASK).toBe(DIR_MODE);
    }
    expect(statSync(join(h.archiveRoot, 'index')).mode & MODE_MASK).toBe(DIR_MODE);
    expect(statSync(file).mode & MODE_MASK).toBe(FILE_MODE);
    expect(statSync(dayIndex).mode & MODE_MASK).toBe(FILE_MODE);
  });

  test('файл с диска с широкими правами в архиве получает 0600', async () => {
    const h = makeHarness();
    const input = diskInput(tempDir(), 'широкие права');
    chmodSync(input.file.disk?.path ?? '', 0o644);
    const outcome = await h.archive.save(input);
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    expect(statSync(join(h.archiveRoot, outcome.path)).mode & MODE_MASK).toBe(FILE_MODE);
  });
});

describe('символические ссылки', () => {
  test('каталог треда — симлинк наружу: failed, наружу ничего не пишется', async () => {
    const h = makeHarness();
    const outside = tempDir();
    mkdirSync(join(h.archiveRoot, 'files'), { recursive: true });
    symlinkSync(outside, join(h.archiveRoot, 'files', intakeThreadDir('thread-1')));
    const outcome = await h.archive.save(memoryInput('утечка'));
    expect(outcome).toEqual({ kind: 'failed', code: 'unsafe_path' });
    expect(existsSync(join(outside, 'x'))).toBe(false);
    const link = join(h.archiveRoot, 'files', intakeThreadDir('thread-1'));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('корень архива — симлинк: failed', async () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, 'chat-attachments'));
    const h = makeHarness({}, root);
    const outcome = await h.archive.save(memoryInput('утечка'));
    expect(outcome).toEqual({ kind: 'failed', code: 'unsafe_path' });
    expect(existsSync(join(outside, 'files'))).toBe(false);
  });

  test('файл индекса дня — симлинк: запись не следует за ссылкой', async () => {
    const h = makeHarness();
    const outside = tempDir();
    const target = join(outside, 'stolen.jsonl');
    writeFileSync(target, '');
    mkdirSync(join(h.archiveRoot, 'index'), { recursive: true });
    symlinkSync(target, join(h.archiveRoot, 'index', '2026-03-10.jsonl'));
    const outcome = await h.archive.save(memoryInput('утечка в индекс'));
    expect(outcome.kind).toBe('failed');
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  test('mtime старого файла не влияет на сохранение нового', async () => {
    const h = makeHarness();
    const first = await h.archive.save(memoryInput('старый'));
    if (first.kind !== 'saved') throw new Error('ожидалось saved');
    setMtime(join(h.archiveRoot, first.path), STALE_MTIME);
    expect((await h.archive.save(memoryInput('новый'))).kind).toBe('saved');
  });
});

describe('платформенная ретенция приёма', () => {
  test('purgeOlderThan приёма не видит каталог chat-attachments', async () => {
    const { LocalIntakeStore } = await import('@business-ai/adapters');
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('переживёт приём'));
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    const absolute = join(h.archiveRoot, outcome.path);
    setMtime(absolute, STALE_MTIME);
    setMtime(join(absolute, '..'), STALE_MTIME);
    setMtime(h.archiveRoot, STALE_MTIME);
    const store = new LocalIntakeStore({ root: h.intakeRoot });
    const removed = await store.purgeOlderThan(new Date(BASE_TIME.getTime() + MS_PER_DAY));
    expect(removed).toBe(0);
    expect(existsSync(absolute)).toBe(true);
  });
});
