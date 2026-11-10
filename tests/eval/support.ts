import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'bun:test';

const created: string[] = [];

/** Временный каталог теста; удаляется после каждого теста. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-test-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});
