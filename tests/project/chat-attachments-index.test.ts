import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { intakeThreadDir } from '@business-ai/adapters';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import {
  BASE_TIME,
  MS_PER_DAY,
  MS_PER_HOUR,
  makeHarness,
  memoryInput,
  readIndex,
  sha256Of,
  type Harness,
} from './chat-attachments-support';

afterAll(removeTempDirs);

const HASH_CHARS = 16;

/** Три файла разных людей, ботов и дней для проверки поиска. */
async function seed(h: Harness): Promise<void> {
  await h.archive.save(
    memoryInput(
      'счёт',
      { userId: 'ivanov', botId: 'bot-a', agentId: 'prices', threadId: 't1' },
      'Счёт-1.pdf',
    ),
  );
  h.clock.now = new Date(BASE_TIME.getTime() + MS_PER_HOUR);
  await h.archive.save(
    memoryInput(
      'договор',
      { userId: 'petrov', botId: 'bot-b', agentId: 'docs', threadId: 't2' },
      'Договор.docx',
    ),
  );
  h.clock.now = new Date(BASE_TIME.getTime() + 2 * MS_PER_DAY);
  await h.archive.save(
    memoryInput(
      'прайс',
      { userId: 'ivanov', botId: 'bot-b', agentId: 'prices', threadId: 't1' },
      'прайс.xlsx',
    ),
  );
}

describe('индекс сохранённых файлов', () => {
  test('запись содержит все поля схемы v1', async () => {
    const h = makeHarness();
    await h.archive.save(
      memoryInput(
        'данные',
        { sourceKey: 'evt-9', botId: 'bot-7', agentId: 'documents' },
        'Акт №1.pdf',
      ),
    );
    const [record] = readIndex(h.archiveRoot);
    const sha = sha256Of('данные');
    expect(record).toEqual({
      v: 1,
      at: '2026-03-10T12:00:00.000Z',
      agent: 'documents',
      bot: 'bot-7',
      thread: intakeThreadDir('thread-1'),
      user: 'u-100',
      name: 'Акт №1.pdf',
      sha256: sha,
      size: Buffer.byteLength('данные'),
      path: `files/${intakeThreadDir('thread-1')}/${sha.slice(0, HASH_CHARS)}_Акт №1.pdf`,
      key: 'evt-9',
    });
  });

  test('неизвестные агент и бот пишутся пустой строкой, а не пропускаются', async () => {
    const h = makeHarness();
    await h.archive.save({
      threadId: 'thread-1',
      userId: 'u-1',
      file: { name: 'a.txt', content: new TextEncoder().encode('x') },
    });
    const [record] = readIndex(h.archiveRoot);
    expect(record).toMatchObject({ agent: '', bot: '', key: '' });
  });

  test('исходное имя сохраняется как прислали, а на диске имя очищено', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('данные', {}, '../x'));
    const [record] = readIndex(h.archiveRoot);
    expect(record?.name).toBe('../x');
    expect(record?.path.endsWith('_x')).toBe(true);
  });

  test('файл индекса назван по UTC-дню получения', async () => {
    const h = makeHarness();
    h.clock.now = new Date('2026-03-10T23:59:59.000Z');
    await h.archive.save(memoryInput('один'));
    h.clock.now = new Date('2026-03-11T00:00:01.000Z');
    await h.archive.save(memoryInput('два'));
    expect(readdirSync(join(h.archiveRoot, 'index')).sort()).toEqual([
      '2026-03-10.jsonl',
      '2026-03-11.jsonl',
    ]);
  });

  test('по одному JSON на строку, строка заканчивается переводом строки', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('один'));
    await h.archive.save(memoryInput('два'));
    const raw = readFileSync(join(h.archiveRoot, 'index', '2026-03-10.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test('имя с переводом строки не ломает построчный формат', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('данные', {}, 'a\nb.txt'));
    const raw = readFileSync(join(h.archiveRoot, 'index', '2026-03-10.jsonl'), 'utf8');
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
    expect(readIndex(h.archiveRoot)[0]?.name).toBe('a\nb.txt');
  });

  test('имена файлов не попадают в события журнала', async () => {
    const h = makeHarness({ maxFileBytes: 5 });
    await h.archive.save(memoryInput('мало', {}, 'ЛичноеИмя.pdf'));
    await h.archive.save(memoryInput('слишком много данных', {}, 'ДругоеИмя.pdf'));
    await h.archive.purge(new Date(BASE_TIME.getTime() + 60 * MS_PER_DAY));
    const text = JSON.stringify(h.events);
    expect(text).not.toContain('Имя');
    expect(h.events.length).toBeGreaterThan(0);
  });
});

describe('поиск find', () => {
  test('без условий возвращает всё по возрастанию времени', async () => {
    const h = makeHarness();
    await seed(h);
    const found = await h.archive.find({});
    const names = found.map((record) => record.name);
    expect(names).toEqual(['Счёт-1.pdf', 'Договор.docx', 'прайс.xlsx']);
  });

  test('фильтры user, bot, agent', async () => {
    const h = makeHarness();
    await seed(h);
    expect((await h.archive.find({ user: 'ivanov' })).map((r) => r.name)).toEqual([
      'Счёт-1.pdf',
      'прайс.xlsx',
    ]);
    expect((await h.archive.find({ bot: 'bot-b' })).map((r) => r.name)).toEqual([
      'Договор.docx',
      'прайс.xlsx',
    ]);
    expect((await h.archive.find({ agent: 'docs' })).map((r) => r.name)).toEqual(['Договор.docx']);
    expect(await h.archive.find({ user: 'ivanov', bot: 'bot-a', agent: 'docs' })).toEqual([]);
  });

  test('фильтр thread принимает и исходный id треда, и хэш каталога', async () => {
    const h = makeHarness();
    await seed(h);
    expect(await h.archive.find({ thread: 't2' })).toHaveLength(1);
    expect(await h.archive.find({ thread: intakeThreadDir('t1') })).toHaveLength(2);
    expect(await h.archive.find({ thread: 'нет-такого' })).toEqual([]);
  });

  test('имя ищется подстрокой без учёта регистра', async () => {
    const h = makeHarness();
    await seed(h);
    const byName = await h.archive.find({ name: 'ДОГОВОР' });
    expect(byName.map((r) => r.name)).toEqual(['Договор.docx']);
    expect((await h.archive.find({ name: '.xls' })).map((r) => r.name)).toEqual(['прайс.xlsx']);
    expect(await h.archive.find({ name: 'zzz' })).toEqual([]);
  });

  test('диапазон дат from/to включительно', async () => {
    const h = makeHarness();
    await seed(h);
    const from = new Date(BASE_TIME.getTime() + 30 * 60_000);
    const to = new Date(BASE_TIME.getTime() + MS_PER_DAY);
    expect((await h.archive.find({ from, to })).map((r) => r.name)).toEqual(['Договор.docx']);
    expect(await h.archive.find({ from: to })).toHaveLength(1);
    expect(await h.archive.find({ to: BASE_TIME })).toHaveLength(1);
  });

  test('префикс sha256', async () => {
    const h = makeHarness();
    await seed(h);
    const sha = sha256Of('договор');
    expect((await h.archive.find({ sha: sha.slice(0, 8) })).map((r) => r.name)).toEqual([
      'Договор.docx',
    ]);
    expect(await h.archive.find({ sha: sha.slice(0, 8).toUpperCase() })).toHaveLength(1);
    expect(await h.archive.find({ sha: 'ffffffffffff' })).toEqual([]);
  });

  test('лимит: по умолчанию 200, берутся самые свежие, порядок возрастающий', async () => {
    const h = makeHarness({ maxFilesPerThreadDay: 500 });
    const total = 205;
    for (let i = 0; i < total; i += 1) {
      await h.archive.save(memoryInput(`f-${i}`, {}, `n${String(i).padStart(3, '0')}.txt`));
    }
    const found = await h.archive.find({});
    expect(found).toHaveLength(200);
    expect(found[0]?.name).toBe('n005.txt');
    expect(found.at(-1)?.name).toBe('n204.txt');
    expect(await h.archive.find({ limit: 3 })).toHaveLength(3);
  });

  test('пустой архив: пустой результат без ошибки', async () => {
    const h = makeHarness();
    expect(await h.archive.find({})).toEqual([]);
  });

  test('битые строки индекса пропускаются', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('нормальный'));
    const file = join(h.archiveRoot, 'index', '2026-03-10.jsonl');
    writeFileSync(file, `не json\n{"v":1}\n${readFileSync(file, 'utf8')}`);
    expect(await h.archive.find({})).toHaveLength(1);
  });
});

describe('locate', () => {
  test('путь из индекса превращается в абсолютный путь файла', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('нужный файл'));
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    const absolute = await h.archive.locate(outcome.path);
    expect(absolute).toBe(join(h.archiveRoot, outcome.path));
    expect(readFileSync(absolute ?? '', 'utf8')).toBe('нужный файл');
  });

  test('выход за корень, абсолютные и чужие пути дают null', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('файл'));
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    const bad = [
      '../chat-attachments/files',
      `files/../${outcome.path}`,
      '/etc/passwd',
      outcome.path.replace('files/', '/files/'),
      'index/2026-03-10.jsonl',
      'files/zzzzzzzzzzzzzzzz/abc_x',
      `${outcome.path}/..`,
      `${outcome.path}\0`,
      '',
      'files',
    ];
    for (const path of bad) expect(await h.archive.locate(path)).toBeNull();
  });

  test('несуществующий файл даёт null', async () => {
    const h = makeHarness();
    await h.archive.save(memoryInput('файл'));
    const missing = `files/${intakeThreadDir('thread-1')}/0123456789abcdef_none.txt`;
    expect(await h.archive.locate(missing)).toBeNull();
  });

  test('симлинк на месте файла или каталога треда не разыменовывается', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('настоящий'));
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    const outside = tempDir();
    const secretName = '0123456789abcdef_secret.txt';
    writeFileSync(join(outside, secretName), 'секрет');
    const fakeName = '0123456789abcdef_link.txt';
    const threadDir = join(h.archiveRoot, 'files', intakeThreadDir('thread-1'));
    symlinkSync(join(outside, secretName), join(threadDir, fakeName));
    expect(await h.archive.locate(`files/${intakeThreadDir('thread-1')}/${fakeName}`)).toBeNull();
    const linkDir = join(h.archiveRoot, 'files', 'aaaaaaaaaaaaaaaa');
    symlinkSync(outside, linkDir);
    expect(await h.archive.locate(`files/aaaaaaaaaaaaaaaa/${secretName}`)).toBeNull();
    expect(existsSync(join(outside, secretName))).toBe(true);
  });

  test('каталог вместо файла даёт null', async () => {
    const h = makeHarness();
    const outcome = await h.archive.save(memoryInput('файл'));
    if (outcome.kind !== 'saved') throw new Error('ожидалось saved');
    const dir = outcome.path.split('/').slice(0, 2).join('/');
    expect(await h.archive.locate(dir)).toBeNull();
  });
});
