import { beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import { editPriceInFile } from '../../src/price-edit-direct';
import { loadFollowup } from '../../src/price-edit-followup';
import { PriceEditRefusedError, type PriceEditRefusal } from '../../src/price-edit-refusal';
import { resetSpotCache } from '../../src/price-spots';
import type {
  PdfPriceSpot,
  PriceSpotMap,
  PriceSpotReader,
} from '../../src/price-spots-client';
import { MemoryPriceFileEditor } from '../../src/kit/adapters/memory/price-file-editor';
import type {
  EditPricesRequest,
  EditedPriceFile,
  SkippedPriceEdit,
} from '../../src/kit/ports/price-file-editor';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Правка цены в тексте PDF вне таблиц с линиями (этап 9r): кандидаты ищутся среди мест `page/spot`
 * вместе с ячейками таблиц, правка уходит с `page`/`spot`, в ответе вместо строки - текст вокруг
 * числа и «Страница N», причины отказа сервиса названы по-человечески. Данные синтетические.
 */

const PDF_NAME = 'Offer_autumn.pdf';
const PDF_MIME = 'application/pdf';

const TEXT = [
  '## Страница 1',
  '',
  'Итого за единицу: 1 250,00 USD',
  '',
  '## Страница 2',
  '',
  '| Item | Price |',
  '| --- | --- |',
  '| Bolt | 400,00 |',
].join('\n');
const TABLES = [
  [
    ['Item', 'Price'],
    ['Bolt', '400,00'],
  ],
];

const SENTENCE: PdfPriceSpot = {
  kind: 'pdf',
  page: 1,
  spot: 0,
  text: '1 250,00',
  context: 'Итого за единицу: 1 250,00 USD',
  textTable: null,
  row: null,
  col: null,
  header: null,
};
const COLUMN: PdfPriceSpot = {
  kind: 'pdf',
  page: 3,
  spot: 2,
  text: '980,50',
  context: 'Item B | 980,50 | USD',
  textTable: 0,
  row: 2,
  col: 1,
  header: 'Price',
};
/** Тот же 400,00, что в таблице страницы 2: неоднозначность «таблица или текст». */
const SAME_AS_CELL: PdfPriceSpot = {
  kind: 'pdf',
  page: 3,
  spot: 5,
  text: '400,00',
  context: 'Скидка поставщика 400,00 USD',
  textTable: null,
  row: null,
  col: null,
  header: null,
};

function parsed(): ParsedDocument {
  return {
    text: TEXT,
    tables: TABLES,
    needsOcr: false,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: false,
    warnings: [],
  };
}

/** Редактор-заглушка: запоминает запрос, часть правок «пропускает» или отказывает целиком. */
class RecordingEditor extends MemoryPriceFileEditor {
  requests: EditPricesRequest[] = [];
  skip: (edit: EditPricesRequest['edits'][number]) => string | undefined = () => undefined;
  refuse: PriceEditRefusal[] | undefined;

  override async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    this.requests.push(request);
    if (this.refuse !== undefined) throw new PriceEditRefusedError(this.refuse);
    const skipped: SkippedPriceEdit[] = [];
    for (const edit of request.edits) {
      const reason = this.skip(edit);
      if (reason === undefined) continue;
      skipped.push({
        ...(edit.table === undefined ? {} : { table: edit.table }),
        row: edit.row,
        col: edit.col,
        reason,
        ...(edit.page === undefined ? {} : { page: edit.page }),
        ...(edit.spot === undefined ? {} : { spot: edit.spot }),
      });
    }
    return {
      fileName: request.fileName,
      mimeType: PDF_MIME,
      bytes: new TextEncoder().encode('edited'),
      changed: request.edits.length - skipped.length,
      skipped,
    };
  }
}

class StubSpotReader implements PriceSpotReader {
  constructor(private map: PriceSpotMap | null) {}
  async read(): Promise<PriceSpotMap | null> {
    return this.map;
  }
}

function mapOf(spots: PdfPriceSpot[]): PriceSpotMap {
  return { spots, unreachable: [], truncated: false };
}

let deps: FullPricesDeps;
let ctx: ToolContext;
let editor: RecordingEditor;
let path = '';

async function setup(reader: PriceSpotReader | undefined): Promise<void> {
  resetSpotCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-pdf-spots', EMPLOYEE_THREAD);
  editor = new RecordingEditor();
  const parser: DocumentParser = { parse: async () => parsed() };
  deps = {
    ...deps,
    parser,
    priceFileEditor: editor,
    ...(reader === undefined ? {} : { priceSpots: reader }),
  };
  const stored = await deps.intake.put(
    EMPLOYEE_THREAD,
    PDF_NAME,
    new TextEncoder().encode('%PDF-1.7\n'),
  );
  path = stored.path;
}

beforeEach(async () => {
  await setup(new StubSpotReader(mapOf([SENTENCE, COLUMN, SAME_AS_CELL])));
});

describe('цена в тексте pdf вне таблиц', () => {
  test('правка уходит с page/spot, row=0, col=0, без table, с expected', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits).toEqual([
      { row: 0, col: 0, page: 1, spot: 0, value: 1300, expected: 1250 },
    ]);
  });

  test('место - «Страница N», вместо строки - текст вокруг числа, textBlock=true', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300, page: 1 }] },
      deps,
      ctx,
    );
    expect(out.delivered).toBe(true);
    expect(out.changes).toEqual([
      {
        place: 'Страница 1',
        row: 'Итого за единицу: 1 250,00 USD',
        textBlock: true,
        oldPrice: 1250,
        newPrice: 1300,
      },
    ]);
  });

  test('число в колонке без линий: заголовок столбца в changes', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 980.5, newPrice: 990, rowText: 'item b' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changes[0]).toMatchObject({ place: 'Страница 3', header: 'Price' });
    expect(editor.requests[0]?.edits[0]).toMatchObject({ page: 3, spot: 2, expected: 980.5 });
  });

  test('ожидание ответа хранит page/spot и отрывок для названия позиции', async () => {
    await editPriceInFile.execute({ path, edits: [{ oldPrice: 1250, newPrice: 1300 }] }, deps, ctx);
    const state = deps.state;
    if (state === undefined) throw new Error('нет состояния');
    const followup = await loadFollowup(state, EMPLOYEE_THREAD, deps.clock.now());
    expect(followup?.changes[0]).toMatchObject({
      place: 'Страница 1',
      table: 0,
      row: 0,
      col: 0,
      page: 1,
      spot: 0,
      rowCells: ['Итого за единицу: 1 250,00 USD'],
      oldPrice: 1250,
      newPrice: 1300,
    });
    expect(followup?.changes[0]).not.toHaveProperty('slide');
  });

  test('слайд к pdf не подходит: число не находится', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300, slide: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(editor.requests).toHaveLength(0);
  });

  test('на странице такого числа нет: not_found, а не «номера не определены»', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300, page: 7 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(out.message).not.toContain('Номера страниц');
  });

  test('без клиента карты (флаг выключен) число в тексте не находится, как в 9q', async () => {
    await setup(undefined);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(editor.requests).toHaveLength(0);
  });

  test('сервис не вернул карту: правка ячейки таблицы работает как прежде', async () => {
    await setup(new StubSpotReader(null));
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits).toEqual([
      { table: 0, row: 1, col: 1, value: 450, expected: 400 },
    ]);
  });
});

describe('таблицы и места pdf вместе', () => {
  test('число и в ячейке, и в тексте: вопрос с вариантами «таблица» и «текст»', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('ambiguous');
    expect(editor.requests).toHaveLength(0);
    expect(out.variants).toHaveLength(2);
    expect(out.variants[0]).toMatchObject({ table: 0, row: 1 });
    expect(out.variants[0]?.textBlock).toBeUndefined();
    expect(out.variants[1]).toMatchObject({ place: 'Страница 3', textBlock: true });
    expect(out.variants[1]).not.toHaveProperty('table');
  });

  test('слова из строки различают место: «скидка» - текст, а не ячейка', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450, rowText: 'скидка' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits[0]).toMatchObject({ page: 3, spot: 5 });
  });

  test('строка таблицы (row) относится к ячейкам: место pdf не берётся', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450, row: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits[0]).toMatchObject({ table: 0, row: 1, col: 1 });
    expect(editor.requests[0]?.edits[0]).not.toHaveProperty('page');
  });

  test('два числа pdf: разные правки в одном вызове', async () => {
    const out = await editPriceInFile.execute(
      {
        path,
        edits: [
          { oldPrice: 1250, newPrice: 1300 },
          { oldPrice: 980.5, newPrice: 990 },
        ],
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits.map((edit) => [edit.page, edit.spot])).toEqual([
      [1, 0],
      [3, 2],
    ]);
  });
});

describe('отказ и пропуск сервиса по числу в тексте pdf', () => {
  test('no_fit: причина названа по месту, предложена xlsx-копия только с согласия', async () => {
    editor.refuse = [{ code: 'no_fit', page: 1, spot: 0 }];
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1250000 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('unsupported_format');
    expect(out.delivered).toBe(false);
    expect(out.skipped).toEqual([
      {
        position: 'Страница 1, текст «Итого за единицу: 1 250,00 USD»',
        reason: 'новое число длиннее старого и не помещается на его месте',
      },
    ]);
    expect(out.message).toContain('Страница 1, текст «Итого за единицу');
    expect(out.message).toContain('не помещается');
    expect(out.message).toContain('xlsx-копию');
    expect(out.message).toContain('ТОЛЬКО с его согласия');
  });

  test('коды 1.1.9 называются понятно, а не машинным кодом', async () => {
    editor.refuse = [
      { code: 'price_not_isolated', page: 1, spot: 0 },
      { code: 'negative_in_text', page: 1, spot: 0 },
      { code: 'spot_not_found', page: 1, spot: 0 },
      { code: 'unsupported_layout', page: 1, spot: 0 },
      { code: 'glyph_missing', page: 1, spot: 0 },
      { code: 'background_unclear', page: 1, spot: 0 },
    ];
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300 }] },
      deps,
      ctx,
    );
    const reasons = out.skipped.map((item) => item.reason).join(' | ');
    expect(reasons).toContain('слита с другим текстом');
    expect(reasons).toContain('минус');
    expect(reasons).toContain('файл отличается от разобранного');
    expect(reasons).toContain('повёрнуты');
    expect(reasons).toContain('нет нужных цифр');
    expect(reasons).toContain('цвет фона');
    expect(reasons).not.toMatch(/negative_in_text|spot_not_found|unsupported_layout/u);
  });

  test('отказ по ячейке таблицы - прежний текст и прежнее место', async () => {
    editor.refuse = [{ code: 'no_fit', table: 0, row: 1, col: 1 }];
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 400, newPrice: 450, row: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('unsupported_format');
    expect(out.skipped[0]).toMatchObject({
      row: 1,
      reason: 'новая цена не помещается на месте старой',
    });
    expect(out.message).toContain('строка «Bolt | 400,00»');
  });

  test('пропуск mismatch с page/spot: число названо страницей и текстом', async () => {
    editor.skip = () => 'mismatch';
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1250, newPrice: 1300 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('nothing_changed');
    expect(out.delivered).toBe(false);
    expect(out.skipped).toEqual([
      { position: 'Страница 1, текст «Итого за единицу: 1 250,00 USD»', reason: 'mismatch' },
    ]);
  });

  test('одну правку сервис пропустил, другую записал: в ответе только записанная', async () => {
    editor.skip = (edit) => (edit.spot === 2 ? 'mismatch' : undefined);
    const out = await editPriceInFile.execute(
      {
        path,
        edits: [
          { oldPrice: 1250, newPrice: 1300 },
          { oldPrice: 980.5, newPrice: 990 },
        ],
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changes.map((change) => change.oldPrice)).toEqual([1250]);
    expect(out.skippedCount).toBe(1);
  });
});
