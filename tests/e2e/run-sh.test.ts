import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/** Корень репозитория v2 (тест лежит в tests/e2e/). */
const ROOT = join(import.meta.dir, '..', '..');
const RUN_SH = join(ROOT, 'e2e/run.sh');
/** Каталоги платформы, которые нужны её run.sh. */
const PLATFORM_DIRS = ['services', 'gateway', 'vendor', 'db'];

/** Поддельное дерево платформы: достаточно файлов, которые читает сборка зеркала. */
function makeFakePlatform(root: string, platformFixtures: string[]): void {
  for (const dir of PLATFORM_DIRS) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(root, 'e2e/fixtures'), { recursive: true });
  writeFileSync(join(root, 'e2e/run.sh'), '#!/usr/bin/env bash\nexit 0\n');
  for (const name of platformFixtures) writeFileSync(join(root, 'e2e/fixtures', name), '# x\n');
}

function buildFarm(platform: string, farm: string): { status: number | null; err: string } {
  const run = spawnSync('bash', [RUN_SH], {
    encoding: 'utf-8',
    env: { ...process.env, BAI_PLATFORM_DIR: platform, E2E_FARM_ONLY: farm },
  });
  return { status: run.status, err: run.stderr };
}

describe('e2e/run.sh: зеркало дерева платформы', () => {
  let temp = '';

  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'e2e-run-sh-test.'));
  });

  afterAll(() => {
    if (temp !== '') rmSync(temp, { recursive: true, force: true });
  });

  test('каталоги платформы подключены ссылками, run.sh платформы - ссылка', () => {
    const platform = join(temp, 'platform');
    makeFakePlatform(platform, ['make_fixtures.py', 'make_photo_text.py']);
    const farm = join(temp, 'farm');
    expect(buildFarm(platform, farm).status).toBe(0);
    for (const dir of PLATFORM_DIRS) {
      expect(readlinkSync(join(farm, dir))).toBe(join(platform, dir));
    }
    expect(readlinkSync(join(farm, 'e2e/run.sh'))).toBe(join(platform, 'e2e/run.sh'));
  });

  test('сценарии, lib и настройки bun берутся из проекта', () => {
    const farm = join(temp, 'farm');
    for (const name of ['tests', 'lib', 'load', 'bunfig.toml', 'register-project.ts']) {
      expect(readlinkSync(join(farm, 'e2e', name))).toBe(join(ROOT, 'e2e', name));
    }
  });

  test('шаблоны документов проекта видны как docs в корне зеркала', () => {
    expect(readlinkSync(join(temp, 'farm/docs'))).toBe(join(ROOT, 'docs'));
  });

  test('фикстуры: платформенные и проектные рядом, make_fixtures.py - склейка', () => {
    const fixtures = join(temp, 'farm/e2e/fixtures');
    const names = readdirSync(fixtures).sort();
    expect(names).toContain('make_platform_fixtures.py');
    expect(names).toContain('make_project_fixtures.py');
    expect(names).toContain('make_photo_text.py');
    expect(names).toContain('make_table_price.py');
    expect(lstatIsLink(join(fixtures, 'make_fixtures.py'))).toBe(false);
    expect(readlinkSync(join(fixtures, 'make_project_fixtures.py'))).toBe(
      join(ROOT, 'e2e/fixtures/make_fixtures.py'),
    );
  });

  test('одноимённая фикстура платформы и проекта - ошибка, а не молчаливая подмена', () => {
    const platform = join(temp, 'platform-clash');
    makeFakePlatform(platform, ['make_fixtures.py', 'make_table_price.py']);
    const result = buildFarm(platform, join(temp, 'farm-clash'));
    expect(result.status).not.toBe(0);
    expect(result.err).toContain('make_table_price.py');
  });

  test('без дерева платформы прогон не начинается', () => {
    const result = buildFarm(join(temp, 'нет-такого'), join(temp, 'farm-none'));
    expect(result.status).not.toBe(0);
    expect(result.err).toContain('BAI_PLATFORM_DIR');
    expect(existsSync(join(temp, 'farm-none/e2e/run.sh'))).toBe(false);
  });
});

function lstatIsLink(path: string): boolean {
  return lstatSync(path).isSymbolicLink();
}

describe('e2e/run.sh: самоконтроль скрипта', () => {
  test('синтаксис bash корректен', () => {
    expect(spawnSync('bash', ['-n', RUN_SH]).status).toBe(0);
  });

  test('порты проекта лежат в выделенном диапазоне 20600-20649', () => {
    const source = Bun.file(RUN_SH);
    return source.text().then((text) => {
      const ports = [...text.matchAll(/^PORT_[A-Z]+=(\d+)$/gm)].map((m) => Number(m[1]));
      expect(ports.length).toBeGreaterThanOrEqual(7);
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(20600);
        expect(port).toBeLessThanOrEqual(20649);
      }
    });
  });
});
