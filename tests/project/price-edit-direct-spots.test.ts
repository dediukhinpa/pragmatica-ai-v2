import { beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import { editPriceInFile } from '../../src/price-edit-direct';
import {
  getPendingPriceEdit,
  loadFollowup,
  priceEditFollowupSchema,
} from '../../src/price-edit-followup';
import { resetSpotCache } from '../../src/price-spots';
import type { PriceSpot, PriceSpotMap, PriceSpotReader } from '../../src/price-spots-client';
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
 * Правка цены в текстовом блоке слайда (этап 9q): кандидаты ищутся среди чисел вне таблиц и
 * складываются с таблицами, правка уходит с локатором, в ответе вместо строки - текст вокруг
 * числа. Ячейки таблиц работают как раньше. Данные синтетические.
 */

const PPTX_NAME = 'Акции_осень.pptx';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const TEXT = [
  '## Слайд 2: Крепёж',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Болт М8 | 680 |',
  '',
  '## Слайд 3: Акции',
  '',
  'Акция недели: 680 ₽ за штуку',
].join('\n');
const TABLES = [
  [
    ['Позиция', 'Цена'],
    ['Болт М8', '680'],
  ],
];

const PROMO: PriceSpot = {
  slide: 3,
  shape: '7/12',
  paragraph: 0,
  start: 14,
  text: '680 ₽',
  context: 'Акция недели: 680 ₽ за штуку',
};
const SET: PriceSpot = {
  slide: 3,
  shape: '8',
  paragraph: 2,
  start: 6,
  text: '1 200,50 руб.',
  context: 'Набор 1 200,50 руб. при заказе от 10 шт',
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

/** Редактор-заглушка: запоминает запрос, часть правок «пропускает» по ключу `skip`. */
class RecordingEditor extends MemoryPriceFileEditor {
  requests: EditPricesRequest[] = [];
  skip: (edit: EditPricesRequest['edits'][number]) => string | undefined = () => undefined;

  override async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    this.requests.push(request);
    const skipped: SkippedPriceEdit[] = [];
    for (const edit of request.edits) {
      const reason = this.skip(edit);
      if (reason === undefined) continue;
      skipped.push({
        ...(edit.table === undefined ? {} : { table: edit.table }),
        row: edit.row,
        col: edit.col,
        reason,
        ...(edit.slide === undefined ? {} : { slide: edit.slide }),
        ...(edit.shape === undefined ? {} : { shape: edit.shape }),
        ...(edit.paragraph === undefined ? {} : { paragraph: edit.paragraph }),
        ...(edit.start === undefined ? {} : { start: edit.start }),
      });
    }
    return {
      fileName: request.fileName,
      mimeType: PPTX_MIME,
      bytes: new TextEncoder().encode('edited'),
      changed: request.edits.length - skipped.length,
      skipped,
    };
  }
}

/** Клиент карты: отдаёт заданную карту либо `null`. */
class StubSpotReader implements PriceSpotReader {
  calls = 0;
  constructor(private map: PriceSpotMap | null) {}
  async read(): Promise<PriceSpotMap | null> {
    this.calls += 1;
    return this.map;
  }
}

function mapOf(spots: PriceSpot[], truncated = false): PriceSpotMap {
  return { spots, unreachable: [], truncated };
}

let deps: FullPricesDeps;
let ctx: ToolContext;
let editor: RecordingEditor;
let path = '';

async function setup(reader: PriceSpotReader | undefined): Promise<void> {
  resetSpotCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-spots', EMPLOYEE_THREAD);
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
    PPTX_NAME,
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  );
  path = stored.path;
}

beforeEach(async () => {
  await setup(new StubSpotReader(mapOf([PROMO, SET])));
});

describe('цена только в текстовом блоке', () => {
  test('правка уходит с локатором, row=0, col=0, без table, с expected', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1200.5, newPrice: 1300 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits).toEqual([
      {
        row: 0,
        col: 0,
        slide: 3,
        shape: '8',
        paragraph: 2,
        start: 6,
        value: 1300,
        expected: 1200.5,
      },
    ]);
  });

  test('место - «Слайд N», вместо строки - текст вокруг числа', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 3 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.delivered).toBe(true);
    expect(out.changes).toEqual([
      {
        place: 'Слайд 3',
        row: 'Акция недели: 680 ₽ за штуку',
        textBlock: true,
        oldPrice: 680,
        newPrice: 700,
      },
    ]);
    expect(deps.chat.outbox.some((item) => item.file !== undefined)).toBe(true);
  });

  test('без клиента карты (флаг выключен) число вне таблицы не находится, как в 9p', async () => {
    await setup(undefined);
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 1200.5, newPrice: 1300 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(editor.requests).toHaveLength(0);
  });

  test('сервис не вернул карту: только таблицы, правка таблицы работает', async () => {
    await setup(new StubSpotReader(null));
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits).toEqual([
      { table: 0, row: 1, col: 1, value: 700, expected: 680 },
    ]);
  });
});

describe('неоднозначность считается по сумме таблиц и текстовых блоков', () => {
  test('680 в таблице слайда 2 и в тексте слайда 3: вопрос с двумя вариантами', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('ambiguous');
    expect(editor.requests).toHaveLength(0);
    expect(out.variants.map((variant) => variant.place)).toEqual(['Слайд 2', 'Слайд 3']);
    expect(out.variants[0]).toMatchObject({ table: 0, row: 1 });
    expect(out.variants[0]?.textBlock).toBeUndefined();
    expect(out.variants[1]).toMatchObject({ textBlock: true });
    expect(out.variants[1]?.rowPreview).toContain('Акция недели');
    expect(out.variants[1]).not.toHaveProperty('table');
  });

  test('слайд различает: слайд 2 - таблица, слайд 3 - текстовый блок', async () => {
    const table = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 2 }] },
      deps,
      ctx,
    );
    expect(table.status).toBe('sent');
    expect(editor.requests[0]?.edits[0]).toMatchObject({ table: 0, row: 1, col: 1 });
    expect(editor.requests[0]?.edits[0]).not.toHaveProperty('slide');
  });

  test('слова из текста различают без слайда', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, rowText: 'акция недели' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits[0]).toMatchObject({ slide: 3, shape: '7/12' });
  });

  test('номер таблицы и строка относятся только к таблицам', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, table: 0, row: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits[0]).toEqual({
      table: 0,
      row: 1,
      col: 1,
      value: 700,
      expected: 680,
    });
  });

  test('два одинаковых числа в тексте одного слайда: тоже вопрос', async () => {
    const twin: PriceSpot = { ...PROMO, shape: '9', paragraph: 1 };
    await setup(new StubSpotReader(mapOf([PROMO, twin])));
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 3 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('ambiguous');
    expect(out.variants).toHaveLength(2);
  });

  test('сообщение «не найдено» предупреждает, что карта обрезана', async () => {
    await setup(new StubSpotReader(mapOf([PROMO], true)));
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 5, newPrice: 6 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(out.message).toContain('обрезал');
  });
});

describe('пропуски сервиса и ожидание ответа', () => {
  test('пропущенное число называется слайдом и текстом, правка не засчитывается', async () => {
    editor.skip = (edit) => (edit.slide === undefined ? undefined : 'mismatch');
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 3 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('nothing_changed');
    expect(out.delivered).toBe(false);
    expect(out.skipped).toEqual([
      { position: 'Слайд 3, текст «Акция недели: 680 ₽ за штуку»', reason: 'mismatch' },
    ]);
    expect(deps.chat.outbox.filter((item) => item.file !== undefined)).toHaveLength(0);
  });

  test('одно число записано, другое пропущено: в изменениях только записанное', async () => {
    editor.skip = (edit) => (edit.shape === '8' ? 'text' : undefined);
    const out = await editPriceInFile.execute(
      {
        path,
        edits: [
          { oldPrice: 680, newPrice: 700, slide: 3 },
          { oldPrice: 1200.5, newPrice: 1300 },
        ],
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.changes.map((change) => change.newPrice)).toEqual([700]);
    expect(out.skippedCount).toBe(1);
    const pending = await getPendingPriceEdit.execute({}, deps, ctx);
    expect(pending.followup?.changes).toHaveLength(1);
  });

  test('ожидание хранит локатор и отрывок текста; прежние поля на месте', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 3 }] },
      deps,
      ctx,
    );
    const pending = await getPendingPriceEdit.execute({}, deps, ctx);
    expect(pending.followup?.changes[0]).toMatchObject({
      place: 'Слайд 3',
      table: 0,
      row: 0,
      col: 0,
      slide: 3,
      shape: '7/12',
      paragraph: 0,
      start: 14,
      context: 'Акция недели: 680 ₽ за штуку',
      rowCells: ['Акция недели: 680 ₽ за штуку'],
      oldPrice: 680,
      newPrice: 700,
    });
    const stored = await loadFollowup(deps.state, EMPLOYEE_THREAD, deps.clock.now());
    expect(stored?.supplier).toBeNull();
  });

  test('ожидание таблицы без локатора: новых полей нет', async () => {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 2 }] },
      deps,
      ctx,
    );
    const pending = await getPendingPriceEdit.execute({}, deps, ctx);
    const change = pending.followup?.changes[0];
    expect(change).toMatchObject({ place: 'Слайд 2', table: 0, row: 1, col: 1 });
    expect(change).not.toHaveProperty('slide');
    expect(change).not.toHaveProperty('context');
  });
});

describe('ожидание, записанное до 9q, читается', () => {
  test('схема принимает изменение без полей локатора и с ними', () => {
    const base = {
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      sourceName: 'a.pptx',
      resultName: 'b.pptx',
      supplier: null,
    };
    const old = {
      place: 'Слайд 2',
      table: 0,
      row: 1,
      col: 1,
      rowCells: ['Болт М8', '680'],
      oldPrice: 680,
      newPrice: 700,
    };
    expect(priceEditFollowupSchema.safeParse({ ...base, changes: [old] }).success).toBe(true);
    const spot = { ...old, table: 0, row: 0, col: 0, slide: 3, shape: '7/12', paragraph: 0 };
    const withSpot = { ...spot, start: 14, context: 'Акция 680 ₽' };
    expect(priceEditFollowupSchema.safeParse({ ...base, changes: [withSpot] }).success).toBe(true);
  });
});
