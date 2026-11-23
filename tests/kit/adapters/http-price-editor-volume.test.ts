import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DocumentsResultVolume } from '@business-ai/adapters';
import { FileSpool, SpoolFullError } from '@business-ai/adapters';
import { HttpPriceFileEditor } from '../../../src/kit/adapters/http/http-price-file-editor';
import { degradingServiceCode, ServiceError } from '@business-ai/adapters';
import { removeTempDirs, tempDir } from '@business-ai/testing';

/**
 * Результат правки приходит не телом ответа, а файлом на общем томе: ядро проверяет имя, размер
 * и хэш, грузит файл потоком и удаляет его (этап 231). Сбои чтения ответа становятся ошибкой
 * сервиса с признаком повторяемости. Данные синтетические.
 */

afterAll(removeTempDirs);

const EDITS = [{ row: 1, col: 1, value: 11 }];
const SUBDIR = 'documents-out';
const RESULT = new TextEncoder().encode('новая книга после правки цен');
const STORED_NAME = `${'ab'.repeat(16)}.bin`;
const SOURCE_BODY = 'Наименование;Цена\nБолт;10';
const META = {
  file_name: 'p.xlsx',
  mime_type: 'application/octet-stream',
  changed: 1,
  skipped: [],
};

interface Rig {
  root: string;
  out: string;
  spoolDir: string;
  spool: FileSpool;
  volume: DocumentsResultVolume;
}

function rig(): Rig {
  const base = tempDir();
  const root = join(base, 'exchange');
  const out = join(root, SUBDIR);
  mkdirSync(out, { recursive: true });
  const spoolDir = join(base, 'spool');
  return {
    root,
    out,
    spoolDir,
    spool: new FileSpool({ dir: spoolDir }),
    volume: new DocumentsResultVolume(root),
  };
}

function sourceFile(): { path: string; size: number } {
  const path = join(tempDir(), 'source.csv');
  writeFileSync(path, SOURCE_BODY);
  return { path, size: Buffer.byteLength(SOURCE_BODY) };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Файл результата, как его кладёт сервис документов (имя `<32 hex>.bin`). */
function putResult(out: string, bytes: Uint8Array = RESULT): void {
  writeFileSync(join(out, STORED_NAME), bytes);
}

function info(overrides: Partial<{ name: string; size: number; sha256: string }> = {}) {
  return { name: STORED_NAME, size: RESULT.length, sha256: sha256(RESULT), ...overrides };
}

function volumeReply(result: Record<string, unknown>): Response {
  return Response.json({ ...META, result }, { headers: { 'x-result-delivery': 'volume' } });
}

function base64Reply(): Response {
  return Response.json({ ...META, content_base64: Buffer.from(RESULT).toString('base64') });
}

/** Дочитать тело запроса, как это делает сервис, чтобы поток отправки завершился. */
async function drain(init: RequestInit): Promise<void> {
  await new Response(init.body as ReadableStream<Uint8Array>).arrayBuffer();
}

async function leftovers(dir: string): Promise<string[]> {
  return existsSync(dir) ? readdir(dir) : [];
}

function edit(editor: HttpPriceFileEditor): Promise<unknown> {
  return editor.editPricesFile({ fileName: 'p.xlsx', file: sourceFile(), edits: EDITS });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('ожидался отказ');
}

describe('результат на общем томе', () => {
  test('ядро просит том заголовком, берёт файл с тома, dispose его удаляет', async () => {
    const r = rig();
    const seen: Array<Record<string, string>> = [];
    putResult(r.out);
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      resultVolume: r.volume,
      fetchFn: async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        await drain(init);
        return volumeReply(info());
      },
    });
    const edited = await editor.editPricesFile({
      fileName: 'p.xlsx',
      file: sourceFile(),
      edits: EDITS,
    });
    expect(seen[0]?.['x-result-delivery']).toBe('volume');
    expect(edited.file.path).toBe(join(r.out, STORED_NAME));
    expect(edited.file.size).toBe(RESULT.length);
    expect(readFileSync(edited.file.path)).toEqual(Buffer.from(RESULT));
    expect(edited.changed).toBe(1);
    expect(await leftovers(r.spoolDir)).toEqual([]);
    await edited.file.dispose();
    expect(existsSync(join(r.out, STORED_NAME))).toBe(false);
  });

  test('размер не совпал: отказ как неверный ответ сервиса, файл с тома убран', async () => {
    const r = rig();
    putResult(r.out);
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      resultVolume: r.volume,
      fetchFn: async (_url, init) => {
        await drain(init);
        return volumeReply(info({ size: RESULT.length + 1 }));
      },
    });
    const error = await failureOf(edit(editor));
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).kind).toBe('format');
    expect(existsSync(join(r.out, STORED_NAME))).toBe(false);
  });

  test('хэш не совпал: отказ как неверный ответ сервиса, файл с тома убран', async () => {
    const r = rig();
    putResult(r.out);
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      resultVolume: r.volume,
      fetchFn: async (_url, init) => {
        await drain(init);
        return volumeReply(info({ sha256: sha256(new Uint8Array(1)) }));
      },
    });
    const error = await failureOf(edit(editor));
    expect((error as ServiceError).kind).toBe('format');
    expect(existsSync(join(r.out, STORED_NAME))).toBe(false);
  });

  test.each([
    '../secret.bin',
    '/etc/passwd',
    'sub/dir.bin',
    `${'ab'.repeat(16)}.txt`,
    'short.bin',
    `${'AB'.repeat(16)}.bin`,
  ])('имя «%s» не из формата сервиса: отказ без чтения', async (name) => {
    const r = rig();
    writeFileSync(join(r.root, 'secret.bin'), RESULT);
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      resultVolume: r.volume,
      fetchFn: async (_url, init) => {
        await drain(init);
        return volumeReply(info({ name }));
      },
    });
    const error = await failureOf(edit(editor));
    expect((error as ServiceError).kind).toBe('format');
    // файл вне подкаталога сервиса не тронут
    expect(existsSync(join(r.root, 'secret.bin'))).toBe(true);
  });

  test('символическая ссылка вместо файла не принимается, целевой файл цел', async () => {
    const r = rig();
    const outside = join(r.root, 'outside.bin');
    writeFileSync(outside, RESULT);
    symlinkSync(outside, join(r.out, STORED_NAME));
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      resultVolume: r.volume,
      fetchFn: async (_url, init) => {
        await drain(init);
        return volumeReply(info());
      },
    });
    const error = await failureOf(edit(editor));
    expect((error as ServiceError).kind).toBe('format');
    expect(existsSync(outside)).toBe(true);
  });

  test('прежний сервис отвечает base64 без заголовка: результат ложится в спул', async () => {
    const r = rig();
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      resultVolume: r.volume,
      fetchFn: async (_url, init) => {
        await drain(init);
        return base64Reply();
      },
    });
    const edited = await editor.editPricesFile({
      fileName: 'p.xlsx',
      file: sourceFile(),
      edits: EDITS,
    });
    expect(readFileSync(edited.file.path)).toEqual(Buffer.from(RESULT));
    expect(edited.file.path.startsWith(r.spoolDir)).toBe(true);
    await edited.file.dispose();
    expect(await leftovers(r.spoolDir)).toEqual([]);
  });

  test('том не подключён: заголовка нет, работает прежний путь', async () => {
    const r = rig();
    const seen: Array<Record<string, string>> = [];
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      fetchFn: async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        await drain(init);
        return base64Reply();
      },
    });
    const edited = await editor.editPricesFile({
      fileName: 'p.xlsx',
      file: sourceFile(),
      edits: EDITS,
    });
    expect(seen[0]?.['x-result-delivery']).toBeUndefined();
    await edited.file.dispose();
  });
});

describe('сбои чтения ответа сервиса документов', () => {
  /** Ответ 200, чьё тело обрывается так, как задал тест. */
  function brokenBody(
    fail: (signal: AbortSignal | null | undefined) => Promise<never>,
  ): (url: string, init: RequestInit) => Promise<Response> {
    return async (_url, init) => {
      await drain(init);
      const head = '{"file_name":"p.xlsx","content_base64":"QUJD';
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          await fail(init.signal);
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
  }

  async function run(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
    const r = rig();
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: r.spool,
      timeoutMs: 200,
      fetchFn,
    });
    const error = await failureOf(edit(editor));
    return { error, left: await leftovers(r.spoolDir) };
  }

  test('таймаут посреди тела: ошибка сервиса «timeout», повторяемая, спул пуст', async () => {
    const { error, left } = await run(
      brokenBody(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      ),
    );
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).kind).toBe('timeout');
    expect((error as ServiceError).retryable).toBe(true);
    expect(degradingServiceCode(error)).toBe('timeout');
    expect(left).toEqual([]);
  });

  test('обрыв соединения посреди тела: ошибка сервиса «stream», повторяемая', async () => {
    const { error, left } = await run(brokenBody(() => Promise.reject(new Error('terminated'))));
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).kind).toBe('stream');
    expect((error as ServiceError).retryable).toBe(true);
    expect(degradingServiceCode(error)).toBe('stream');
    expect(left).toEqual([]);
  });

  test('ответ не в ожидаемом формате (битый base64): ошибка формата, не повторяемая', async () => {
    const { error, left } = await run(async (_url, init) => {
      await drain(init);
      return new Response('{"file_name":"p.xlsx","content_base64":"@@@@"}', { status: 200 });
    });
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).kind).toBe('format');
    expect((error as ServiceError).retryable).toBe(false);
    expect(left).toEqual([]);
  });

  test('спул заполнен: отказ «нет места», а не сбой сети', async () => {
    const r = rig();
    const full = new FileSpool({ dir: r.spoolDir, maxBytes: 1 });
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      spool: full,
      fetchFn: async (_url, init) => {
        await drain(init);
        return base64Reply();
      },
    });
    expect(await failureOf(edit(editor))).toBeInstanceOf(SpoolFullError);
  });
});
