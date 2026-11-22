import { beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import {
  PRICE_EDIT_FOLLOWUP_NAMESPACE,
  PRICE_EDIT_FOLLOWUP_TTL_MS,
  closePendingPriceEdit,
  getPendingPriceEdit,
  loadFollowup,
} from '../../src/price-edit-followup';
import { editPriceInFile, resultNameFromSource } from '../../src/price-edit-direct';
import { MemoryPriceFileEditor } from '../../src/kit/adapters/memory/price-file-editor';
import type { EditPricesRequest, EditedPriceFile } from '../../src/kit/ports/price-file-editor';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Правка цены в файле сотрудника сразу, без поставщика (этап 9p): координаты ячейки из места
 * («слайд 11»), вопросы только про неоднозначную цену, ожидание ответа про базу.
 */

const PPTX_NAME = 'Прайс_спецпредложение.pptx';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Часы тестов: понедельник 2026-10-12 (FixedClock по умолчанию - 2026-01-01, берём его). */

/** Презентация: слайд 2 и слайд 11 с таблицами цен; цена 680 на слайде 11 и на слайде 2. */
const SLIDE_2 = [
  ['Позиция', 'Цена'],
  ['Болт М8', '680'],
  ['Гайка М8', '25'],
];
const SLIDE_11 = [
  ['Позиция', 'Цена'],
  ['Шайба', '12.5'],
  ['Саморез', '680'],
];
const TEXT = [
  '## Слайд 2: Крепёж',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Болт М8 | 680 |',
  '| Гайка М8 | 25 |',
  '',
  '## Слайд 11: Метизы',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Шайба | 12.5 |',
  '| Саморез | 680 |',
].join('\n');

function parsedDeck(tables: string[][][], text: string): ParsedDocument {
  return {
    text,
    tables,
    needsOcr: false,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: false,
    warnings: [],
  };
}

/** Редактор-заглушка: запоминает запрос и возвращает «исправленную» копию. */
class RecordingEditor extends MemoryPriceFileEditor {
  requests: EditPricesRequest[] = [];

  override async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    this.requests.push(request);
    return {
      fileName: request.fileName,
      mimeType: PPTX_MIME,
      bytes: new TextEncoder().encode('edited'),
      changed: request.edits.length,
      skipped: [],
    };
  }
}

let deps: FullPricesDeps;
let ctx: ToolContext;
let editor: RecordingEditor;
let path = '';

async function setup(tables: string[][][] = [SLIDE_2, SLIDE_11], text = TEXT): Promise<void> {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-direct', EMPLOYEE_THREAD);
  editor = new RecordingEditor();
  const parser: DocumentParser = {
    parse: async () => parsedDeck(tables, text),
  };
  deps = { ...deps, parser, priceFileEditor: editor };
  const stored = await deps.intake.put(
    EMPLOYEE_THREAD,
    PPTX_NAME,
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  );
  path = stored.path;
}

beforeEach(async () => {
  await setup();
});

describe('правка по месту: слайд', () => {
  test('«на слайде 11 цену 680 замени на 700»: правится слайд 11, файл в чат', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 11 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.delivered).toBe(true);
    // координаты: таблица 1 (слайд 11), строка 2, столбец цены
    expect(editor.requests).toHaveLength(1);
    expect(editor.requests[0]?.edits).toEqual([
      { table: 1, row: 2, col: 1, value: 700, expected: 680 },
    ]);
    expect(out.changes).toEqual([
      expect.objectContaining({ place: 'Слайд 11', oldPrice: 680, newPrice: 700 }),
    ]);
    expect(out.changes[0]?.row).toContain('Саморез');
    expect(deps.chat.outbox.some((item) => item.file !== undefined)).toBe(true);
  });

  test('поставщик не определён: supplier=null, имя результата от исходного файла', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 2 }] },
      deps,
      ctx,
    );
    expect(out.supplier).toBeNull();
    const sent = deps.chat.outbox.find((item) => item.file !== undefined);
    expect(sent?.file?.name).toBe('Прайс_спецпредложение_новые_цены_01.01.2026.pptx');
  });

  test('известный поставщик: имя результата с названием поставщика', async () => {
    const out = await editPriceInFile.execute(
      { path, supplierId: 's1', edits: [{ oldPrice: 680, newPrice: 700, slide: 2 }] },
      deps,
      ctx,
    );
    expect(out.supplier).toEqual({ id: 's1', name: 'МеталлТорг' });
    const sent = deps.chat.outbox.find((item) => item.file !== undefined);
    expect(sent?.file?.name).toContain('МеталлТорг');
  });

  test('слово из строки различает одинаковые цены без указания слайда', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 690, rowText: 'болт' }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(editor.requests[0]?.edits[0]).toMatchObject({ table: 0, row: 1, col: 1 });
  });
});

describe('единственный допустимый вопрос до правки - неоднозначное место', () => {
  test('цена 680 на двух слайдах без места: файл не правится, есть варианты', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('ambiguous');
    expect(out.delivered).toBe(false);
    expect(editor.requests).toHaveLength(0);
    expect(out.variants.map((variant) => variant.place)).toEqual(['Слайд 2', 'Слайд 11']);
    expect(out.variants[1]?.rowPreview).toContain('Саморез');
    // ничего не отправлено и ожидание не заведено
    expect(deps.chat.outbox.filter((item) => item.file !== undefined)).toHaveLength(0);
    expect(await loadFollowup(deps.state, EMPLOYEE_THREAD, deps.clock.now())).toBeNull();
  });

  test('цены на этом месте нет: not_found, файл не правится', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 999, newPrice: 1000, slide: 2 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(editor.requests).toHaveLength(0);
    expect(out.message).toContain('Не угадывай');
  });

  test('цены на указанном слайде нет, она на другом: not_found', async () => {
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 12.5, newPrice: 13, slide: 2 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
    expect(editor.requests).toHaveLength(0);
  });

  test('шапка таблицы с числом не считается ценой, если строка не названа', async () => {
    await setup([[['Цена 2026', '2026'], ['Болт', '5']]], '## Слайд 1\n\n| a | b |\n');
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 2026, newPrice: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
  });
});

describe('ожидание ответа про базу', () => {
  async function sendEdit(): Promise<void> {
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700, slide: 11 }] },
      deps,
      ctx,
    );
  }

  test('после правки в треде лежит ожидание: что изменено, поставщик не определён', async () => {
    await sendEdit();
    const pending = await getPendingPriceEdit.execute({}, deps, ctx);
    expect(pending.pending).toBe(true);
    expect(pending.followup?.supplier).toBeNull();
    expect(pending.followup?.sourceName).toBe(PPTX_NAME);
    expect(pending.followup?.changes[0]).toMatchObject({
      place: 'Слайд 11',
      oldPrice: 680,
      newPrice: 700,
    });
    expect(pending.followup?.changes[0]?.rowCells).toContain('Саморез');
  });

  test('сама правка в базу ничего не пишет: цены поставщика прежние', async () => {
    await deps.prices.saveImport('s1', [], 'seed');
    const before = await deps.prices.listBySupplier('s1');
    await sendEdit();
    expect(await deps.prices.listBySupplier('s1')).toEqual(before);
  });

  test('«нет»: ожидание закрыто, база не менялась', async () => {
    await sendEdit();
    const closed = await closePendingPriceEdit.execute({ decision: 'declined' }, deps, ctx);
    expect(closed.closed).toBe(true);
    expect(closed.message).toContain('база не менялась');
    expect((await getPendingPriceEdit.execute({}, deps, ctx)).pending).toBe(false);
  });

  test('без ответа ожидание живёт сутки, потом сбрасывается', async () => {
    await sendEdit();
    const before = await deps.state.get(PRICE_EDIT_FOLLOWUP_NAMESPACE, EMPLOYEE_THREAD);
    expect(before).not.toBeNull();
    const later = new Date(deps.clock.now().getTime() + PRICE_EDIT_FOLLOWUP_TTL_MS - 1000);
    expect(await loadFollowup(deps.state, EMPLOYEE_THREAD, later)).not.toBeNull();
    const expired = new Date(deps.clock.now().getTime() + PRICE_EDIT_FOLLOWUP_TTL_MS + 1000);
    expect(await loadFollowup(deps.state, EMPLOYEE_THREAD, expired)).toBeNull();
    expect(await deps.state.get(PRICE_EDIT_FOLLOWUP_NAMESPACE, EMPLOYEE_THREAD)).toBeNull();
  });

  test('ожидания нет: «да» не к чему привязать, инструмент так и говорит', async () => {
    const pending = await getPendingPriceEdit.execute({}, deps, ctx);
    expect(pending.pending).toBe(false);
    expect(pending.message).toContain('Ничего не записывай в базу');
  });

  test('новая правка в том же треде заменяет прежнее ожидание', async () => {
    await sendEdit();
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 25, newPrice: 30, slide: 2 }] },
      deps,
      ctx,
    );
    const pending = await getPendingPriceEdit.execute({}, deps, ctx);
    expect(pending.followup?.changes).toHaveLength(1);
    expect(pending.followup?.changes[0]).toMatchObject({ place: 'Слайд 2', newPrice: 30 });
  });
});

describe('защита от ошибок', () => {
  test('новая цена равна старой - отказ без правки', async () => {
    await expect(
      editPriceInFile.execute(
        { path, edits: [{ oldPrice: 680, newPrice: 680, slide: 2 }] },
        deps,
        ctx,
      ),
    ).rejects.toThrow('править нечего');
  });

  test('две правки в одну ячейку - отказ', async () => {
    await expect(
      editPriceInFile.execute(
        {
          path,
          edits: [
            { oldPrice: 680, newPrice: 700, slide: 2 },
            { oldPrice: 680, newPrice: 710, slide: 2 },
          ],
        },
        deps,
        ctx,
      ),
    ).rejects.toThrow('одну и ту же ячейку');
  });

  test('текст «от 680» не считается обычной ценой', async () => {
    await setup([[['Позиция', 'Цена'], ['Болт', 'от 680']]], '## Слайд 3\n\n| a | b |\n');
    const out = await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 700 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_found');
  });

  test('имя результата: каталог и недопустимые знаки убираются, расширение прежнее', () => {
    expect(resultNameFromSource('Папка/Акция: «лето».pptx', '2026-10-12', '.pptx')).toBe(
      'Акция_ «лето»_новые_цены_12.10.2026.pptx',
    );
  });
});
