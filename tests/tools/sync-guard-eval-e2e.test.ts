import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/** Корень репозитория v2 (тест лежит в tests/tools/). */
const ROOT = join(import.meta.dir, '..', '..');
const MANIFEST_PATH = join(ROOT, 'tools/sync-eval-e2e-manifest.tsv');
/** Каталоги, которые целиком принадлежат sync-eval-e2e: чужих файлов в них быть не должно. */
const GENERATED_ROOTS = [
  'eval/cases/',
  'eval/recordings/',
  'eval/reports/',
  'eval/environments/',
  'eval/scripts/',
  'e2e/tests/',
  'e2e/fixtures/',
  'e2e/load/',
];
/** Файлы проекта, которые лежат среди сгенерированных и пишутся руками. */
const HAND_WRITTEN = [
  'eval/index.ts',
  'eval/cases.ts',
  'eval/paths.ts',
  'eval/cli.ts',
  'eval/handoff-cli.ts',
  'eval/synthetic/index.ts',
  'tests/eval/register-eval.ts',
  'tests/eval/project-spec.test.ts',
  'e2e/lib/project-env.ts',
  // Сценарий проекта (не из SRC): текст сообщения сотрудника через канал чата и мост проекта.
  'e2e/tests/z-documents-employee-requisites-chat.test.ts',
  'e2e/register-project.ts',
  'e2e/bunfig.toml',
  'e2e/run.sh',
];
const SRC_HEADER = '# src=';
const SHA_LENGTH = 64;
/** Длина полного хэша коммита git. */
const COMMIT_LENGTH = 40;

interface ManifestRow {
  path: string;
  sha256: string;
}

function manifestLines(): string[] {
  return readFileSync(MANIFEST_PATH, 'utf-8').split('\n');
}

/** Разобрать манифест: `путь<TAB>sha256`, строки с `#` пропускаются. */
function readManifest(): ManifestRow[] {
  return manifestLines()
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [path = '', sha256 = ''] = line.split('\t');
      return { path, sha256 };
    });
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
}

describe('eval и e2e, порождённые sync-eval-e2e, не правят руками', () => {
  const rows = readManifest();

  test('в заголовке манифеста записан коммит старого репозитория', () => {
    const header = manifestLines().find((line) => line.startsWith(SRC_HEADER));
    expect(header).toBeDefined();
    expect((header ?? '').length).toBe(SRC_HEADER.length + COMMIT_LENGTH);
  });

  test('манифест не пуст, суммы выглядят как sha256, файлы существуют', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.sha256.length !== SHA_LENGTH)).toEqual([]);
    expect(rows.filter((row) => !existsSync(join(ROOT, row.path))).map((r) => r.path)).toEqual([]);
  });

  test('контрольные суммы совпадают с манифестом', () => {
    const changed = rows.filter((row) => sha256Of(row.path) !== row.sha256).map((r) => r.path);
    expect(changed).toEqual([]);
  });

  test('в порождённых каталогах нет файлов вне манифеста', () => {
    const known = new Set(rows.map((row) => row.path));
    const handWritten = new Set(HAND_WRITTEN);
    const glob = new Bun.Glob('**/*');
    const extra: string[] = [];
    for (const prefix of GENERATED_ROOTS) {
      for (const file of glob.scanSync({ cwd: join(ROOT, prefix), onlyFiles: true })) {
        if (!known.has(prefix + file) && !handWritten.has(prefix + file)) extra.push(prefix + file);
      }
    }
    expect(extra).toEqual([]);
  });

  test('ручные файлы существуют и не попали в манифест', () => {
    const known = new Set(rows.map((row) => row.path));
    expect(HAND_WRITTEN.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
    expect(HAND_WRITTEN.filter((path) => known.has(path))).toEqual([]);
  });

  test('в tests/eval лишь порождённые файлы и ручные из списка', () => {
    const known = new Set(rows.map((row) => row.path));
    const handWritten = new Set(HAND_WRITTEN);
    const glob = new Bun.Glob('**/*');
    const extra: string[] = [];
    for (const file of glob.scanSync({ cwd: join(ROOT, 'tests/eval'), onlyFiles: true })) {
      const path = `tests/eval/${file}`;
      if (!known.has(path) && !handWritten.has(path)) extra.push(path);
    }
    expect(extra).toEqual([]);
  });
});
