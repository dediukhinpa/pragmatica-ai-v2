import { describe, expect, test } from 'bun:test';
import {
  HttpPriceSpotReader,
  isUnreachablePage,
  type PdfPriceSpot,
} from '../../src/price-spots-client';

/**
 * Клиент карты чисел вне таблиц для PDF (этап 9r): `POST /parse` с `locations=true`, ответ с
 * `format: "pdf"` разбирается в места `page/spot`, ответ презентации (без `format`) - как раньше,
 * любой сбой или непонятный ответ - `null`. Данные синтетические.
 */

const BYTES = new TextEncoder().encode('синтетический pdf');

/** Места в виде, в котором их отдаёт сервис документов 1.1.9. */
const PDF_LOCATIONS = {
  format: 'pdf',
  pages: 2,
  spots: [
    {
      page: 1,
      spot: 0,
      text: '1 250,00',
      box: [10, 20, 60, 30],
      line: 0,
      context: 'Итого за единицу: 1 250,00 USD',
      text_table: null,
      row: null,
      col: null,
      header: null,
    },
    {
      page: 2,
      spot: 3,
      text: '980,50',
      box: [10, 50, 60, 60],
      line: 4,
      context: 'Item B | 980,50 USD',
      text_table: 0,
      row: 2,
      col: 1,
      header: 'Price',
    },
  ],
  text_tables: [{ index: 0, page: 2, box: [0, 0, 1, 1], rows: 3, cols: 2, grid: [] }],
  unreachable: [{ page: 2, kind: 'rotated' }],
  truncated: false,
};

function readerWith(
  reply: () => Response | Promise<Response>,
  failures: string[] = [],
): HttpPriceSpotReader {
  return new HttpPriceSpotReader({
    baseUrl: 'http://docs.test',
    onFailure: (reason) => failures.push(reason),
    fetchFn: async () => reply(),
  });
}

describe('карта мест pdf', () => {
  test('format=pdf: места page/spot с контекстом и подсказкой таблицы без линий', async () => {
    const reader = readerWith(() => Response.json({ markdown: '#', locations: PDF_LOCATIONS }));
    const map = await reader.read({ name: 'Прайс.pdf', bytes: BYTES });
    expect(map).not.toBeNull();
    const [text, column] = map?.spots ?? [];
    expect(text).toEqual({
      kind: 'pdf',
      page: 1,
      spot: 0,
      text: '1 250,00',
      context: 'Итого за единицу: 1 250,00 USD',
      textTable: null,
      row: null,
      col: null,
      header: null,
    } satisfies PdfPriceSpot);
    expect(column).toMatchObject({ kind: 'pdf', page: 2, spot: 3, textTable: 0, header: 'Price' });
    expect(map?.truncated).toBe(false);
  });

  test('недоступные страницы приходят как {page, kind}', async () => {
    const reader = readerWith(() => Response.json({ locations: PDF_LOCATIONS }));
    const map = await reader.read({ name: 'a.PDF', bytes: BYTES });
    expect(map?.unreachable).toEqual([{ page: 2, kind: 'rotated' }]);
    expect(map?.unreachable.every(isUnreachablePage)).toBe(true);
  });

  test('обрезанная карта сохраняет признак truncated', async () => {
    const reader = readerWith(() =>
      Response.json({ locations: { ...PDF_LOCATIONS, truncated: true } }),
    );
    expect((await reader.read({ name: 'a.pdf', bytes: BYTES }))?.truncated).toBe(true);
  });

  test('без контекста и подсказок: значения по умолчанию', async () => {
    const reader = readerWith(() =>
      Response.json({
        locations: { format: 'pdf', spots: [{ page: 1, spot: 0, text: '100' }] },
      }),
    );
    const map = await reader.read({ name: 'a.pdf', bytes: BYTES });
    expect(map?.spots[0]).toMatchObject({ kind: 'pdf', context: '', header: null, row: null });
    expect(map?.unreachable).toEqual([]);
  });

  test('pptx без поля format читается как раньше (kind=pptx)', async () => {
    const reader = readerWith(() =>
      Response.json({
        locations: {
          spots: [
            { slide: 1, shape: '5', paragraph: 0, start: 0, text: '680 ₽', context: 'Акция' },
          ],
        },
      }),
    );
    const map = await reader.read({ name: 'a.pptx', bytes: BYTES });
    expect(map?.spots[0]).toMatchObject({ kind: 'pptx', slide: 1, shape: '5' });
  });
});

describe('сбои и непонятные ответы pdf дают null', () => {
  test('сервис без поля locations (платформа без правки pdf): null без причины сбоя', async () => {
    const failures: string[] = [];
    const reader = readerWith(() => Response.json({ markdown: '#' }), failures);
    expect(await reader.read({ name: 'a.pdf', bytes: BYTES })).toBeNull();
    expect(failures).toEqual([]);
  });

  test('место без страницы: ответ не по схеме, null и причина', async () => {
    const failures: string[] = [];
    const reader = readerWith(
      () => Response.json({ locations: { format: 'pdf', spots: [{ spot: 0, text: '1' }] } }),
      failures,
    );
    expect(await reader.read({ name: 'a.pdf', bytes: BYTES })).toBeNull();
    expect(failures).toEqual(['invalid response']);
  });

  test('чужой формат карты: null', async () => {
    const reader = readerWith(() =>
      Response.json({ locations: { format: 'docx', spots: [] } }),
    );
    expect(await reader.read({ name: 'a.pdf', bytes: BYTES })).toBeNull();
  });

  test('не-200 и обрыв сети: null, исключения наружу нет', async () => {
    const failures: string[] = [];
    const bad = readerWith(() => new Response('нет', { status: 500 }), failures);
    expect(await bad.read({ name: 'a.pdf', bytes: BYTES })).toBeNull();
    const broken = readerWith(() => {
      throw new Error('обрыв');
    }, failures);
    expect(await broken.read({ name: 'a.pdf', bytes: BYTES })).toBeNull();
    expect(failures).toHaveLength(2);
  });
});
