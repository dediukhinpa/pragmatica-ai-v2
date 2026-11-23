import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { HttpPriceFileEditor } from '../../src/kit/adapters/http/http-price-file-editor';
import { PriceEditRefusedError } from '../../src/price-edit-refusal';

/**
 * Правка числа в тексте PDF (этап 9r): `page` и `spot` уходят в тело сервиса вместе с row=0,
 * col=0 и expected (table не задаётся), неполный и смешанный локатор отклоняется до запроса,
 * 422 `edit_refused` с `page/spot` разбирается в причины по местам, ячейки таблиц остаются
 * прежними. Данные синтетические.
 */

afterAll(removeTempDirs);

const BYTES = new TextEncoder().encode('синтетический pdf');
const OK_FILE = Buffer.from('x').toString('base64');
const META = { file_name: 'p.pdf', mime_type: 'application/pdf', changed: 1, skipped: [] };
const SPOT_EDIT = { row: 0, col: 0, value: 1300, expected: 1250, page: 2, spot: 4 };

interface Seen {
  edits: Array<Record<string, unknown>>;
  url: string;
}

function editorWith(
  reply: () => Response,
  seen: Seen = { edits: [], url: '' },
): HttpPriceFileEditor {
  return new HttpPriceFileEditor({
    baseUrl: 'http://docs.test',
    fetchFn: async (url, init) => {
      seen.url = String(url);
      const body = init.body;
      if (body instanceof FormData) {
        seen.edits = JSON.parse(String(body.get('edits'))) as Array<Record<string, unknown>>;
      } else if (body instanceof ReadableStream) {
        await new Response(body).arrayBuffer();
      }
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

describe('локатор места pdf в теле правки', () => {
  test('page и spot уходят с row=0, col=0, table=null и expected', async () => {
    const seen: Seen = { edits: [], url: '' };
    const editor = editorWith(
      () => Response.json({ ...META, content_base64: OK_FILE }),
      seen,
    );
    await editor.editPrices({ fileName: 'p.pdf', bytes: BYTES, edits: [SPOT_EDIT] });
    expect(seen.edits).toEqual([
      { sheet: null, table: null, row: 0, col: 0, value: 1300, expected: 1250, page: 2, spot: 4 },
    ]);
    expect(seen.edits[0]).not.toHaveProperty('slide');
  });

  test('правка ячейки таблицы pdf: полей page и spot в теле нет', async () => {
    const seen: Seen = { edits: [], url: '' };
    const editor = editorWith(() => Response.json({ ...META, content_base64: OK_FILE }), seen);
    await editor.editPrices({
      fileName: 'p.pdf',
      bytes: BYTES,
      edits: [{ table: 1, row: 2, col: 1, value: 5, expected: 4 }],
    });
    expect(seen.edits).toEqual([{ sheet: null, table: 1, row: 2, col: 1, value: 5, expected: 4 }]);
  });

  test('ячейка и место pdf в одном запросе: у каждой своё тело', async () => {
    const seen: Seen = { edits: [], url: '' };
    const editor = editorWith(
      () => Response.json({ ...META, changed: 2, content_base64: OK_FILE }),
      seen,
    );
    await editor.editPrices({
      fileName: 'p.pdf',
      bytes: BYTES,
      edits: [{ table: 0, row: 1, col: 1, value: 5, expected: 4 }, SPOT_EDIT],
    });
    expect(seen.edits[0]).not.toHaveProperty('page');
    expect(seen.edits[1]).toMatchObject({ page: 2, spot: 4 });
  });

  test('только страница или только место: отказ до запроса', async () => {
    let called = false;
    const editor = editorWith(() => {
      called = true;
      return Response.json({});
    });
    for (const half of [{ page: 2 }, { spot: 4 }]) {
      const error = await failureOf(
        editor.editPrices({
          fileName: 'p.pdf',
          bytes: BYTES,
          edits: [{ row: 0, col: 0, value: 9, expected: 8, ...half }],
        }),
      );
      expect(String(error)).toContain('страница и номер места');
    }
    expect(called).toBe(false);
  });

  test('слайд и страница вместе: отказ до запроса', async () => {
    let called = false;
    const editor = editorWith(() => {
      called = true;
      return Response.json({});
    });
    const error = await failureOf(
      editor.editPrices({
        fileName: 'p.pdf',
        bytes: BYTES,
        edits: [{ ...SPOT_EDIT, slide: 1, shape: '4', paragraph: 0, start: 0 }],
      }),
    );
    expect(String(error)).toContain('один вид адреса');
    expect(called).toBe(false);
  });

  test('файл на диске: тот же локатор уходит в тело', async () => {
    const path = join(tempDir(), 'source.pdf');
    writeFileSync(path, BYTES);
    let sent = '';
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      fetchFn: async (_url, init) => {
        if (init.body instanceof ReadableStream) {
          sent = await new Response(init.body).text();
        }
        return Response.json({ ...META, content_base64: OK_FILE });
      },
    });
    await editor.editPricesFile({
      fileName: 'p.pdf',
      file: { path, size: BYTES.byteLength },
      edits: [SPOT_EDIT],
    });
    expect(sent).toContain('"page":2');
    expect(sent).toContain('"spot":4');
  });
});

describe('отказ 422 edit_refused с page и spot', () => {
  const BODY = {
    detail: {
      error: 'edit_refused',
      reasons: [
        { code: 'no_fit', table: null, row: null, col: null, page: 2, spot: 4 },
        { code: 'glyph_missing', table: 0, row: 3, col: 2 },
        { code: 'encrypted', table: null, row: null, col: null },
      ],
    },
  };

  test('у места pdf в причине есть страница и номер, у ячейки и файла - как прежде', async () => {
    const editor = editorWith(() => Response.json(BODY, { status: 422 }));
    const error = await failureOf(
      editor.editPrices({ fileName: 'p.pdf', bytes: BYTES, edits: [SPOT_EDIT] }),
    );
    expect(error).toBeInstanceOf(PriceEditRefusedError);
    expect((error as PriceEditRefusedError).reasons).toEqual([
      { code: 'no_fit', page: 2, spot: 4 },
      { code: 'glyph_missing', table: 0, row: 3, col: 2 },
      { code: 'encrypted' },
    ]);
  });
});

describe('пропуск правки с page и spot в ответе', () => {
  test('skipped с page/spot доходит до порта', async () => {
    const editor = editorWith(() =>
      Response.json({
        ...META,
        changed: 0,
        skipped: [
          { sheet: null, table: null, row: 0, col: 0, reason: 'mismatch', page: 2, spot: 4 },
        ],
        content_base64: OK_FILE,
      }),
    );
    const edited = await editor.editPrices({
      fileName: 'p.pdf',
      bytes: BYTES,
      edits: [SPOT_EDIT],
    });
    expect(edited.skipped).toEqual([{ row: 0, col: 0, reason: 'mismatch', page: 2, spot: 4 }]);
  });

  test('прежний пропуск без page и spot: полей нет', async () => {
    const editor = editorWith(() =>
      Response.json({
        ...META,
        changed: 0,
        skipped: [{ sheet: null, table: 1, row: 2, col: 1, reason: 'text', page: null }],
        content_base64: OK_FILE,
      }),
    );
    const edited = await editor.editPrices({
      fileName: 'p.pdf',
      bytes: BYTES,
      edits: [{ table: 1, row: 2, col: 1, value: 5 }],
    });
    expect(edited.skipped).toEqual([{ table: 1, row: 2, col: 1, reason: 'text' }]);
  });
});
