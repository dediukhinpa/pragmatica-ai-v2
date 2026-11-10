import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalFileSource, MemoryFileSource } from '@business-ai/adapters';
import { TEMPLATE_NOT_FOUND, readSiteTemplate } from '../../src/agents/site-export/template-source';
import { removeTempDirs, tempDir } from '@business-ai/testing';

/** Чтение чистого шаблона сайта с диска: только чтение, путь задаёт оператор. */

afterAll(removeTempDirs);

const BYTES = new Uint8Array([1, 2, 3]);

function diskWith(files: Record<string, Uint8Array>): { root: string; source: LocalFileSource } {
  const root = tempDir();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return { root, source: new LocalFileSource({ root, stableSeconds: 0 }) };
}

describe('readSiteTemplate', () => {
  test('файл есть: возвращаются байты и путь', async () => {
    const { source } = diskWith({ 'Сайт/шаблон.xlsx': BYTES });
    const result = await readSiteTemplate({
      templateFiles: source,
      siteTemplatePath: 'Сайт/шаблон.xlsx',
    });
    expect(result).toEqual({ status: 'ok', path: 'Сайт/шаблон.xlsx', bytes: BYTES });
  });

  test('файла нет: template_not_found с просьбой прислать шаблон', async () => {
    const { source } = diskWith({});
    const result = await readSiteTemplate({
      templateFiles: source,
      siteTemplatePath: 'Сайт/шаблон.xlsx',
    });
    expect(result.status).toBe(TEMPLATE_NOT_FOUND);
    if (result.status === TEMPLATE_NOT_FOUND) expect(result.message).toContain('прислать');
  });

  test('путь не настроен или нет источника: тоже template_not_found', async () => {
    const { source } = diskWith({});
    expect((await readSiteTemplate({ templateFiles: source })).status).toBe(TEMPLATE_NOT_FOUND);
    expect((await readSiteTemplate({ siteTemplatePath: 'a.xlsx' })).status).toBe(
      TEMPLATE_NOT_FOUND,
    );
  });

  test('выход за корень и символические ссылки не читаются', async () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.xlsx'), BYTES);
    const { root, source } = diskWith({ 'ok.xlsx': BYTES });
    symlinkSync(join(outside, 'secret.xlsx'), join(root, 'link.xlsx'));
    symlinkSync(outside, join(root, 'dir'));
    for (const path of ['../secret.xlsx', 'link.xlsx', 'dir/secret.xlsx', '/etc/passwd']) {
      const attempt = readSiteTemplate({ templateFiles: source, siteTemplatePath: path });
      const result = await attempt.catch((error: unknown) => error);
      // Либо ошибка источника, либо «нет шаблона»: байты чужого файла не отдаются никогда.
      expect(result).not.toMatchObject({ status: 'ok' });
    }
  });

  test('сбой диска (не «нет файла») пробрасывается, а не маскируется', async () => {
    const source = new MemoryFileSource();
    source.read = async () => {
      throw new Error('шара недоступна');
    };
    await expect(
      readSiteTemplate({ templateFiles: source, siteTemplatePath: 'a.xlsx' }),
    ).rejects.toThrow('шара недоступна');
  });
});
