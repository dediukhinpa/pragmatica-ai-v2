import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const PROJECT_TESTS = join(REPO_ROOT, 'tests', 'project');
const MAX_LINE = 100;

/** Файлы корня src, написанные руками (остальное генерирует tools/sync-agents.sh). */
const OWNED_ROOT_FILES = [
  'access-actions.ts',
  'background-cli.ts',
  'background-crm-sync.ts',
  'background-mail-backfill.ts',
  'background-mail-survey.ts',
  'background-wiring.ts',
  'lifecycle-disk-sync.ts',
  'chat-hooks.ts',
  'config.ts',
  'eval.ts',
  'event-severity.ts',
  'index.ts',
  'main.ts',
  'ports.ts',
  'project.ts',
  'runtime.ts',
  'schedules.ts',
];

/** Платформенные файлы, которых в проекте быть не должно: их держит пакет платформы. */
const PLATFORM_FILES = [
  'compose-production.ts',
  'production-config.ts',
  'chat-pump.ts',
  'job-worker.ts',
  'service.ts',
];

function filesIn(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesIn(path, found);
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('границы проекта и платформы', () => {
  test('корень src содержит только файлы манифеста и каталоги проекта', () => {
    const entries = readdirSync(SRC_ROOT).sort();
    const files = entries.filter((name) => statSync(join(SRC_ROOT, name)).isFile());
    expect(files).toEqual([...OWNED_ROOT_FILES].sort());
    const dirs = entries.filter((name) => statSync(join(SRC_ROOT, name)).isDirectory());
    expect(dirs).toEqual(['adapters', 'agents', 'assembly', 'kit']);
  });

  test('копий платформенных файлов в src нет', () => {
    const names = filesIn(SRC_ROOT).map((path) => path.split('/').pop() ?? '');
    for (const platformFile of PLATFORM_FILES) expect(names).not.toContain(platformFile);
  });

  test('код проекта не лезет внутрь пакетов платформы мимо их публичных входов', () => {
    const offenders: string[] = [];
    const deepImport = /from\s+'@business-ai\/[a-z-]+\/(?!compose'|setup')[^']*'/;
    for (const path of [...filesIn(SRC_ROOT), ...filesIn(PROJECT_TESTS)]) {
      if (deepImport.test(readFileSync(path, 'utf8'))) offenders.push(relative(REPO_ROOT, path));
    }
    expect(offenders).toEqual([]);
  });

  test('написанные руками файлы не длиннее 100 знаков в строке', () => {
    const owned = [
      ...OWNED_ROOT_FILES.map((name) => join(SRC_ROOT, name)),
      ...filesIn(join(SRC_ROOT, 'adapters')),
      ...filesIn(join(SRC_ROOT, 'assembly')),
      ...filesIn(PROJECT_TESTS),
    ];
    const long: string[] = [];
    for (const path of owned) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.length > MAX_LINE) long.push(`${relative(REPO_ROOT, path)}:${index + 1}`);
        });
    }
    expect(long).toEqual([]);
  });

  test('в коде проекта нет упоминаний инструментов разработки', () => {
    const banned = /claude|anthropic/i;
    const offenders = [...filesIn(join(SRC_ROOT, 'assembly')), ...filesIn(PROJECT_TESTS)]
      .filter((path) => !path.endsWith('boundaries.test.ts'))
      .filter((path) => banned.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });
});
