import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/** Корень репозитория v2 (тест лежит в tests/tools/). */
const ROOT = join(import.meta.dir, '..', '..');
const MANIFEST = 'tools/sync-eval-e2e-manifest.tsv';
const SRC_REPO = process.env['SRC_REPO'] ?? join(homedir(), 'pragmatika-purchasing');
const SRC_HEADER = '# src=';
/** Сколько ждать один запуск синхронизации (порождение + пересъёмка записей), мс. */
const RUN_TIMEOUT_MS = 180_000;
/** Каталоги, которые копируются во временный репозиторий целиком. */
const COPIED = ['tools', 'eval', 'e2e', 'tests/eval'];
/** Каталоги и файлы, на которые во временном репозитории ставятся ссылки. */
const LINKED = ['src', 'node_modules', 'package.json', 'tsconfig.json', 'bunfig.toml'];
/** Порождённое, что перед первым запуском удаляется: проверка «с нуля». */
const WIPED = ['eval/cases', 'eval/recordings', 'eval/reports', 'e2e/tests', 'e2e/fixtures'];
const UNCHANGED_LINE = 'добавлено 0, изменено 0, удалено 0';

function manifestRows(root: string): string[] {
  return readFileSync(join(root, MANIFEST), 'utf-8')
    .split('\n')
    .filter((line) => line !== '');
}

function sourceCommit(): string {
  const header = manifestRows(ROOT).find((line) => line.startsWith(SRC_HEADER));
  return (header ?? '').slice(SRC_HEADER.length);
}

function commitAvailable(commit: string): boolean {
  if (commit === '' || !existsSync(SRC_REPO)) return false;
  const probe = spawnSync('git', ['-C', SRC_REPO, 'cat-file', '-e', `${commit}^{commit}`]);
  return probe.status === 0;
}

function runSync(repo: string, commit: string): { status: number | null; out: string } {
  const run = spawnSync('bash', [join(repo, 'tools/sync-eval-e2e.sh'), commit], {
    encoding: 'utf-8',
    env: { ...process.env, SRC_REPO, GIT_PAGER: 'cat' },
    timeout: RUN_TIMEOUT_MS,
  });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
}

const commit = sourceCommit();
const available = commitAvailable(commit);

const runSlow = available && process.env['SKIP_SLOW_SYNC_TESTS'] !== '1';

describe.skipIf(!runSlow)('tools/sync-eval-e2e.sh: воспроизводимость и идемпотентность', () => {
  let temp = '';
  let first = { status: 0 as number | null, out: '' };

  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'sync-eval-e2e-test.'));
    for (const dir of COPIED) cpSync(join(ROOT, dir), join(temp, dir), { recursive: true });
    for (const name of LINKED) symlinkSync(join(ROOT, name), join(temp, name));
    for (const dir of WIPED) rmSync(join(temp, dir), { recursive: true, force: true });
    first = runSync(temp, commit);
  }, RUN_TIMEOUT_MS);

  afterAll(() => {
    if (temp !== '') rmSync(temp, { recursive: true, force: true });
  });

  test('синхронизация с нуля завершается успешно и применяет патчи', () => {
    expect(first.out).toContain('применено патчей проекта');
    expect(first.status).toBe(0);
  });

  test('порождённое дерево совпадает с зафиксированным в репозитории (манифест)', () => {
    expect(manifestRows(temp)).toEqual(manifestRows(ROOT));
  });

  test('повторный запуск ничего не меняет', () => {
    const second = runSync(temp, commit);
    expect(second.status).toBe(0);
    expect(second.out).toContain(UNCHANGED_LINE);
    expect(manifestRows(temp)).toEqual(manifestRows(ROOT));
  }, RUN_TIMEOUT_MS);
});

describe('tools/sync-eval-e2e.sh: аргументы', () => {
  test('без коммита завершается с ошибкой, не трогая репозиторий', () => {
    const run = spawnSync('bash', [join(ROOT, 'tools/sync-eval-e2e.sh')], { encoding: 'utf-8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('коммит старого репо');
  });
});
