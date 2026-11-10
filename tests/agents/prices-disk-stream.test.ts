import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalFileSource } from '@business-ai/adapters';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import type { DiskFile, DocumentParser, ParsedDocument } from '@business-ai/core';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { CTX, buildPricesDeps } from './support';

afterAll(removeTempDirs);

let deps: Awaited<ReturnType<typeof buildPricesDeps>>;
beforeEach(async () => {
  deps = await buildPricesDeps();
});

const OLD_SECONDS = 3600;
const MS = 1000;

/** Разбор, который записывает, каким путём пришёл файл. */
class RecordingParser implements DocumentParser {
  readonly calls: Array<'bytes' | 'disk'> = [];
  readonly diskFiles: DiskFile[] = [];

  private doc(): ParsedDocument {
    return {
      text: '| a | b |\n|---|---|\n| x | 1 |',
      tables: [[['a', 'b'], ['x', '1']]],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  }

  async parse(): Promise<ParsedDocument> {
    this.calls.push('bytes');
    return this.doc();
  }

  async parseFile(_name: string, file: DiskFile): Promise<ParsedDocument> {
    this.calls.push('disk');
    this.diskFiles.push(file);
    return this.doc();
  }
}

/** Этап 239e: прайс с шары не читается в память ядра, а уходит в сервис разбора по пути. */
describe('readPriceFile: файл сетевого диска уходит в разбор потоком', () => {
  test('источник с openFile: parseFile по пути, чтение в память не вызывается', async () => {
    const root = tempDir();
    const absolute = join(root, 'прайс.csv');
    writeFileSync(absolute, 'Наименование,Цена\nБолт,10\n');
    const old = new Date(Date.now() - OLD_SECONDS * MS);
    utimesSync(absolute, old, old);
    const local = new LocalFileSource({ root });
    let reads = 0;
    const files = Object.assign(Object.create(local) as LocalFileSource, {
      read: async (path: string) => {
        reads += 1;
        return local.read(path);
      },
    });
    const parser = new RecordingParser();
    const out = await readPriceFile.execute(
      { path: 'прайс.csv' },
      { ...deps, files, parser },
      CTX,
    );
    expect(out.tableCount).toBe(1);
    expect(parser.calls).toEqual(['disk']);
    expect(parser.diskFiles[0]?.size).toBe(statSync(absolute).size);
    expect(reads).toBe(0);
  });

  test('источник без openFile (память): разбор байтами, как раньше', async () => {
    deps.files = Object.assign(deps.files, {});
    const parser = new RecordingParser();
    const memory = deps.files as unknown as { put(p: string, b: Uint8Array, m: number): void };
    memory.put('прайс.csv', new TextEncoder().encode('Наименование,Цена\nБолт,10\n'), 1_000);
    await readPriceFile.execute({ path: 'прайс.csv' }, { ...deps, parser }, CTX);
    expect(parser.calls).toEqual(['bytes']);
  });
});
