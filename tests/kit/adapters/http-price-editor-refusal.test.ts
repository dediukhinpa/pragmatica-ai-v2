import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { HttpPriceFileEditor } from '../../../src/kit/adapters/http/http-price-file-editor';
import {
  PriceEditRefusedError,
  UnsupportedPriceFormatError,
} from '../../../src/kit/domain/errors.owned';

/**
 * Отказы и смена формата в ответе сервиса правки: 422 `edit_refused` с причинами по местам,
 * 422 `unsupported_format`, поле `converted_from` у старого файла, приведённого к pptx.
 * Данные синтетические, значения цен в ответах не передаются.
 */

afterAll(removeTempDirs);

const EDITS = [{ table: 0, row: 1, col: 2, value: 11 }];
const BYTES = new TextEncoder().encode('синтетический файл');
const REFUSED_BODY = {
  detail: {
    error: 'edit_refused',
    reasons: [
      { code: 'glyph_missing', table: 0, row: 3, col: 2 },
      { code: 'no_fit', table: 0, row: 4, col: 2 },
      { code: 'encrypted', table: null, row: null, col: null },
    ],
  },
};
const META = {
  file_name: 'p.pptx',
  mime_type: 'application/octet-stream',
  changed: 1,
  skipped: [],
};

function editorWith(reply: () => Response): HttpPriceFileEditor {
  return new HttpPriceFileEditor({
    baseUrl: 'http://docs.test',
    fetchFn: async (_url, init) => {
      // Тело уходит multipart: дочитываем его, как это делает сервис
      if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
      return reply();
    },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('ожидался отказ');
}

describe('отказ проверок сервиса: 422 edit_refused', () => {
  test('причины по местам переходят в PriceEditRefusedError', async () => {
    const editor = editorWith(() => Response.json(REFUSED_BODY, { status: 422 }));
    const error = await failureOf(
      editor.editPrices({ fileName: 'p.pdf', bytes: BYTES, edits: EDITS }),
    );
    expect(error).toBeInstanceOf(PriceEditRefusedError);
    expect((error as PriceEditRefusedError).reasons).toEqual([
      { code: 'glyph_missing', table: 0, row: 3, col: 2 },
      { code: 'no_fit', table: 0, row: 4, col: 2 },
      { code: 'encrypted' },
    ]);
  });

  test('тот же отказ при правке файла на диске', async () => {
    const path = join(tempDir(), 'source.pdf');
    writeFileSync(path, BYTES);
    const editor = editorWith(() => Response.json(REFUSED_BODY, { status: 422 }));
    const error = await failureOf(
      editor.editPricesFile({
        fileName: 'p.pdf',
        file: { path, size: BYTES.byteLength },
        edits: EDITS,
      }),
    );
    expect(error).toBeInstanceOf(PriceEditRefusedError);
    expect(error).not.toBeInstanceOf(UnsupportedPriceFormatError);
  });

  test('unsupported_format остаётся прежним отказом формата', async () => {
    const editor = editorWith(() =>
      Response.json({ detail: { error: 'unsupported_format' } }, { status: 422 }),
    );
    const error = await failureOf(
      editor.editPrices({ fileName: 'p.pdf', bytes: BYTES, edits: EDITS }),
    );
    expect(error).toBeInstanceOf(UnsupportedPriceFormatError);
  });

  test('edit_refused без списка причин: отказ с пустым списком, не падение разбора', async () => {
    const editor = editorWith(() =>
      Response.json({ detail: { error: 'edit_refused' } }, { status: 422 }),
    );
    const error = await failureOf(
      editor.editPrices({ fileName: 'p.pdf', bytes: BYTES, edits: EDITS }),
    );
    expect(error).toBeInstanceOf(PriceEditRefusedError);
    expect((error as PriceEditRefusedError).reasons).toEqual([]);
  });
});

describe('смена формата: converted_from', () => {
  test('старый файл, приведённый к pptx: convertedFrom передаётся наружу', async () => {
    const editor = editorWith(() =>
      Response.json({
        ...META,
        converted_from: 'ppt',
        content_base64: Buffer.from('x').toString('base64'),
      }),
    );
    const edited = await editor.editPrices({ fileName: 'p.ppt', bytes: BYTES, edits: EDITS });
    expect(edited.convertedFrom).toBe('ppt');
    expect(edited.fileName).toBe('p.pptx');
  });

  test('обычный файл: поля convertedFrom нет', async () => {
    const editor = editorWith(() =>
      Response.json({ ...META, content_base64: Buffer.from('x').toString('base64') }),
    );
    const edited = await editor.editPrices({ fileName: 'p.pptx', bytes: BYTES, edits: EDITS });
    expect('convertedFrom' in edited).toBe(false);
  });
});
