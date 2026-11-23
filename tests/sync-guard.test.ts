import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/** Корень репозитория v2 (тест лежит в tests/). */
const ROOT = join(import.meta.dir, '..');
const MANIFEST_PATH = join(ROOT, 'tools/sync-manifest.tsv');
/** Каталоги, которые целиком принадлежат sync-agents: проектных файлов в них быть не должно. */
const GENERATED_ROOTS = ['src/agents/', 'src/kit/', 'tests/agents/', 'tests/kit/'];

interface ManifestRow {
  path: string;
  sha256: string;
}

/** Разобрать манифест синхронизации: `путь<TAB>sha256`, строки с `#` пропускаются. */
function readManifest(): ManifestRow[] {
  return readFileSync(MANIFEST_PATH, 'utf-8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [path = '', sha256 = ''] = line.split('\t');
      return { path, sha256 };
    });
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
}

describe('сгенерированные файлы не правят руками', () => {
  const rows = readManifest();

  test('манифест не пуст и ссылается на существующие файлы', () => {
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows.filter((row) => !existsSync(join(ROOT, row.path)));
    expect(missing).toEqual([]);
  });

  test('контрольные суммы сгенерированных файлов совпадают с манифестом', () => {
    const changed = rows.filter((row) => sha256Of(row.path) !== row.sha256).map((r) => r.path);
    expect(changed).toEqual([]);
  });

  test('в сгенерированных каталогах нет файлов вне манифеста', () => {
    const known = new Set(rows.map((row) => row.path));
    const glob = new Bun.Glob('**/*');
    const extra: string[] = [];
    for (const prefix of GENERATED_ROOTS) {
      for (const file of glob.scanSync({ cwd: join(ROOT, prefix), onlyFiles: true })) {
        if (!known.has(prefix + file)) extra.push(prefix + file);
      }
    }
    expect(extra).toEqual([]);
  });
});
