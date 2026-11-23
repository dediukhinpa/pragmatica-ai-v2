import { describe, expect, test } from 'bun:test';
import { HttpPriceFileEditor } from '../../src/kit/adapters/http/http-price-file-editor';

/**
 * Правка числа в текстовом блоке слайда (этап 9q): локатор slide/shape/paragraph/start уходит в
 * тело сервиса, пропуск с локатором из ответа доходит до порта, неполный локатор отклоняется до
 * запроса, а правка ячейки таблицы остаётся прежней (без новых полей в теле). Данные
 * синтетические.
 */

const BYTES = new TextEncoder().encode('синтетический файл');
const OK_FILE = Buffer.from('x').toString('base64');

/** Запрос, который получил «сервис»: правки из поля `edits` формы. */
interface Seen {
  edits: Array<Record<string, unknown>>;
}

function editorWith(reply: unknown, seen: Seen): HttpPriceFileEditor {
  return new HttpPriceFileEditor({
    baseUrl: 'http://docs.test',
    fetchFn: async (_url, init) => {
      const body = init.body;
      if (!(body instanceof FormData)) throw new Error('ожидалась форма multipart');
      seen.edits = JSON.parse(String(body.get('edits'))) as Array<Record<string, unknown>>;
      return Response.json(reply);
    },
  });
}

/** Правка числа в тексте слайда 3: фигура в группе, второй абзац. */
const SPOT_EDIT = {
  row: 0,
  col: 0,
  value: 700,
  expected: 680,
  slide: 3,
  shape: '7/12',
  paragraph: 1,
  start: 9,
};
const META = { file_name: 'p.pptx', mime_type: 'application/octet-stream', changed: 1 };

describe('локатор текстового блока в теле правки', () => {
  test('slide, shape, paragraph и start уходят вместе с row=0, col=0 и expected', async () => {
    const seen: Seen = { edits: [] };
    const editor = editorWith({ ...META, skipped: [], content_base64: OK_FILE }, seen);
    await editor.editPrices({ fileName: 'p.pptx', bytes: BYTES, edits: [SPOT_EDIT] });
    expect(seen.edits).toEqual([
      {
        sheet: null,
        table: null,
        row: 0,
        col: 0,
        value: 700,
        expected: 680,
        slide: 3,
        shape: '7/12',
        paragraph: 1,
        start: 9,
      },
    ]);
  });

  test('правка таблицы: полей локатора в теле нет', async () => {
    const seen: Seen = { edits: [] };
    const editor = editorWith({ ...META, skipped: [], content_base64: OK_FILE }, seen);
    await editor.editPrices({
      fileName: 'p.pptx',
      bytes: BYTES,
      edits: [{ table: 1, row: 2, col: 1, value: 700, expected: 680 }],
    });
    expect(seen.edits).toEqual([
      { sheet: null, table: 1, row: 2, col: 1, value: 700, expected: 680 },
    ]);
    expect(Object.keys(seen.edits[0] ?? {})).not.toContain('slide');
  });

  test('смешанные правки: у каждой своё тело', async () => {
    const seen: Seen = { edits: [] };
    const editor = editorWith({ ...META, changed: 2, skipped: [], content_base64: OK_FILE }, seen);
    await editor.editPrices({
      fileName: 'p.pptx',
      bytes: BYTES,
      edits: [
        { table: 0, row: 1, col: 1, value: 5, expected: 4 },
        { row: 0, col: 0, value: 9, expected: 8, slide: 2, shape: '4', paragraph: 0, start: 0 },
      ],
    });
    expect(seen.edits).toHaveLength(2);
    expect(seen.edits[0]).not.toHaveProperty('slide');
    expect(seen.edits[1]).toMatchObject({ slide: 2, shape: '4', paragraph: 0, start: 0 });
  });

  test('неполный локатор отклоняется до запроса', async () => {
    let called = false;
    const editor = new HttpPriceFileEditor({
      baseUrl: 'http://docs.test',
      fetchFn: async () => {
        called = true;
        return Response.json({});
      },
    });
    const attempt = editor.editPrices({
      fileName: 'p.pptx',
      bytes: BYTES,
      edits: [{ row: 0, col: 0, value: 9, expected: 8, slide: 2, shape: '4' }],
    });
    await expect(attempt).rejects.toThrow('задано не полностью');
    expect(called).toBe(false);
  });
});

describe('пропуск правки с локатором в ответе сервиса', () => {
  test('skipped с slide/shape/paragraph/start принимается и доходит до порта', async () => {
    const seen: Seen = { edits: [] };
    const editor = editorWith(
      {
        ...META,
        changed: 0,
        skipped: [
          {
            sheet: null,
            table: null,
            row: 0,
            col: 0,
            reason: 'mismatch',
            slide: 3,
            shape: '7/12',
            paragraph: 1,
            start: 9,
          },
        ],
        content_base64: OK_FILE,
      },
      seen,
    );
    const edited = await editor.editPrices({
      fileName: 'p.pptx',
      bytes: BYTES,
      edits: [SPOT_EDIT],
    });
    expect(edited.skipped).toEqual([
      { row: 0, col: 0, reason: 'mismatch', slide: 3, shape: '7/12', paragraph: 1, start: 9 },
    ]);
  });

  test('прежний пропуск ячейки таблицы: полей локатора нет', async () => {
    const seen: Seen = { edits: [] };
    const editor = editorWith(
      {
        ...META,
        changed: 0,
        skipped: [
          { sheet: null, table: 1, row: 2, col: 1, reason: 'text', slide: null, shape: null },
        ],
        content_base64: OK_FILE,
      },
      seen,
    );
    const edited = await editor.editPrices({
      fileName: 'p.pptx',
      bytes: BYTES,
      edits: [{ table: 1, row: 2, col: 1, value: 9, expected: 8 }],
    });
    expect(edited.skipped).toEqual([{ table: 1, row: 2, col: 1, reason: 'text' }]);
  });
});
