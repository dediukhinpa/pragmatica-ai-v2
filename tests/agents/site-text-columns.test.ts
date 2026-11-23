import { describe, expect, test } from 'bun:test';
import { MemorySiteTextEditor } from '../../src/kit/adapters/memory/site-text-editor';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { loadWorkbook } from '../../src/agents/site-export/template-store';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import { SITE_DESCRIPTION_MAX_CHARS } from '../../src/kit/domain/site-export';
import type { SiteTextEditRequest } from '../../src/kit/ports/site-text-editor';
import {
  COLUMNS,
  EXAMPLE_CELLS,
  SHEET_MAIN,
  buildBook,
  buildTemplateWorld,
  type TemplateWorld,
} from './site-template-support';

/**
 * Этап 225: пробелы, предел столбца P (описание) и единица столбца Q (размер) по шапке.
 * Модель правки текстов - заглушка `MemorySiteTextEditor`, настоящая модель не вызывается.
 */

type Cell = { column: string; value: string | number };
const base = {
  requestedByEmployee: false,
  confirmedByEmployee: false,
  overwrite: false,
  stampManager: true,
} as const;
const DESCRIPTION = 'Описание / Легенда';
const name = (value: string): Cell => ({ column: 'Название', value });
const SIZE = 'Размер упаковки';
const MAX = SITE_DESCRIPTION_MAX_CHARS;

/** Описание длиннее предела; числа и артикул стоят в начале. */
const LONG_TEXT = `Кружка 300 мл арт. AB-12. ${'Красивый подарок для коллег. '.repeat(60)}`;
const SHORT_FIXED = 'Кружка 300 мл арт. AB-12. Красивый подарок для коллег.';

const SIZE_HEADER = 'Размер упаковки, мм, (ш-в-г) (размер сувенира)';

function withSizeHeader(text: string, sample?: string) {
  const columns = COLUMNS.map((spec) => (spec.letter === 'Q' ? { ...spec, text } : spec));
  const cells = { ...EXAMPLE_CELLS, ...(sample === undefined ? {} : { Q6: sample }) };
  return buildBook({ columns, cells });
}

async function worldWith(
  options: { diskBytes?: Uint8Array; editor?: MemorySiteTextEditor } = {},
): Promise<{ world: TemplateWorld; id: string }> {
  const world = await buildTemplateWorld({
    diskBytes: options.diskBytes ?? withSizeHeader(SIZE_HEADER, '10x20x30 '),
  });
  if (options.editor !== undefined) world.deps.textEditor = options.editor;
  const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
  return { world, id: out.workbookId ?? '' };
}

async function fill(world: TemplateWorld, id: string, cells: Cell[], row?: number) {
  return fillTemplateRows.execute(
    { ...base, workbookId: id, items: [{ ...(row === undefined ? {} : { row }), cells }] },
    world.deps,
    world.ctx,
  );
}

async function cellsOf(world: TemplateWorld, id: string) {
  const loaded = await loadWorkbook(world.deps, id);
  const model = JSON.parse(new TextDecoder().decode(loaded.bytes)) as {
    cells: Record<string, Record<string, string | number>>;
  };
  return model.cells[SHEET_MAIN] ?? {};
}

describe('пробелы в строковых ячейках', () => {
  test('двойные, по краям, перед знаками и неразрывные приводятся к обычным', async () => {
    const { world, id } = await worldWith();
    const out = await fill(world, id, [
      { column: 'Название', value: '  Кружка  керамическая , белая  ' },
      { column: 'Артикул', value: ' AB-1  ' },
      { column: DESCRIPTION, value: 'Объём  300 мл ( белая ) .' },
    ]);
    expect(out.skippedTotal).toBe(0);
    const cells = await cellsOf(world, id);
    expect(cells['H12']).toBe('Кружка керамическая, белая');
    expect(cells['I12']).toBe('AB-1');
    expect(cells['P12']).toBe('Объём 300 мл (белая).');
  });

  test('числа в ячейках не трогаются', async () => {
    const { world, id } = await worldWith();
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: 'Срок изготовления, недели', value: 3 },
    ]);
    expect((await cellsOf(world, id))['T12']).toBe(3);
  });
});

describe('столбец P без редактора текстов (флаг выключен)', () => {
  test('описание длиннее предела не пишется, причина просит сократить своими словами', async () => {
    const { world, id } = await worldWith();
    expect(LONG_TEXT.length).toBeGreaterThan(MAX);
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: LONG_TEXT },
    ]);
    expect(out.written).toBeGreaterThan(0);
    const skip = out.skipped.find((item) => item.reason === 'value_too_long');
    expect(skip?.message).toContain('1500');
    expect(skip?.message).toContain('своими словами');
    expect((await cellsOf(world, id))['P12']).toBeUndefined();
  });

  test('ровно предел пишется как есть, без обрезки и без правки орфографии', async () => {
    const { world, id } = await worldWith();
    const exact = `Кружка с опечаткой ${'а'.repeat(MAX)}`.slice(0, MAX);
    expect(exact.length).toBe(MAX);
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: exact },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect((await cellsOf(world, id))['P12']).toBe(exact);
  });

  test('повтор с сокращённым текстом принимается', async () => {
    const { world, id } = await worldWith();
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: LONG_TEXT },
    ]);
    const again = await fill(world, id, [{ column: DESCRIPTION, value: SHORT_FIXED }], 12);
    expect(again.skippedTotal).toBe(0);
    expect((await cellsOf(world, id))['P12']).toBe(SHORT_FIXED);
  });

  test('многострочное описание сохраняет переводы строк', async () => {
    const { world, id } = await worldWith();
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: 'Состав:\r\n- кружка  \r\n- ложка' },
    ]);
    expect((await cellsOf(world, id))['P12']).toBe('Состав:\n- кружка\n- ложка');
  });
});

describe('столбец P с редактором текстов (флаг включён)', () => {
  test('длинное описание сжимается моделью, один пакетный вызов на все описания', async () => {
    const editor = new MemorySiteTextEditor((req) => (req.compress ? SHORT_FIXED : req.text));
    const { world, id } = await worldWith({ editor });
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [
          { cells: [name('Кружка'), { column: DESCRIPTION, value: LONG_TEXT }] },
          { cells: [name('Ложка'), { column: DESCRIPTION, value: 'Ложка' }] },
        ],
      },
      world.deps,
      world.ctx,
    );
    expect(out.skippedTotal).toBe(0);
    expect(editor.batches.length).toBe(1);
    expect(editor.batches[0]?.map((req) => req.compress)).toEqual([true, false]);
    expect(editor.batches[0]?.[0]?.maxChars).toBe(MAX);
    const cells = await cellsOf(world, id);
    expect(cells['P12']).toBe(SHORT_FIXED);
    expect(cells['P13']).toBe('Ложка');
  });

  test('орфография правится у коротких текстов, числа и артикулы целы', async () => {
    const editor = new MemorySiteTextEditor((req) => req.text.replace('кружа', 'кружка'));
    const { world, id } = await worldWith({ editor });
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: 'Белая кружа 300 мл, арт. AB-12' },
    ]);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружка 300 мл, арт. AB-12');
  });

  test('ответ модели тоже проходит нормализацию пробелов', async () => {
    const editor = new MemorySiteTextEditor(() => 'Белая  кружка , 300 мл');
    const { world, id } = await worldWith({ editor });
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: 'Белая кружка, 300 мл' },
    ]);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружка, 300 мл');
  });

  test('первый ответ длиннее предела: одна повторная попытка с черновиком и длиной', async () => {
    const seen: SiteTextEditRequest[] = [];
    const editor = new MemorySiteTextEditor((req, attempt) => {
      seen.push(req);
      return attempt === 1 ? LONG_TEXT.slice(0, MAX + 100) : SHORT_FIXED;
    });
    const { world, id } = await worldWith({ editor });
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: LONG_TEXT },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect(editor.batches.length).toBe(2);
    expect(seen[1]?.problem).toContain(String(MAX));
    expect(seen[1]?.draft?.length).toBeGreaterThan(MAX);
    expect((await cellsOf(world, id))['P12']).toBe(SHORT_FIXED);
  });

  test('обе попытки длиннее предела: ячейка не пишется, явная ошибка агенту', async () => {
    const editor = new MemorySiteTextEditor(() => LONG_TEXT);
    const { world, id } = await worldWith({ editor });
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: LONG_TEXT },
    ]);
    expect(editor.batches.length).toBe(2);
    const skip = out.skipped.find((item) => item.reason === 'value_too_long');
    expect(skip?.message).toContain('своими словами');
    expect((await cellsOf(world, id))['P12']).toBeUndefined();
  });

  test('модель изменила число: правка отвергнута, короткий текст остаётся исходным', async () => {
    const editor = new MemorySiteTextEditor((req) => req.text.replace('300', '350'));
    const { world, id } = await worldWith({ editor });
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: 'Белая кружка 300 мл' },
    ]);
    expect(editor.batches.length).toBe(2);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружка 300 мл');
    expect(out.warnings.join('\n')).toContain('правка описания отклонена');
  });

  test('модель изменила артикул или единицу при сжатии: отказ text_invariant_changed', async () => {
    for (const broken of [
      SHORT_FIXED.replace('AB-12', 'AB-13'),
      SHORT_FIXED.replace('300 мл', '300 л'),
      `${SHORT_FIXED} [ORG_1]`,
    ]) {
      const editor = new MemorySiteTextEditor(() => broken);
      const { world, id } = await worldWith({ editor });
      const out = await fill(world, id, [
        { column: 'Название', value: 'Кружка' },
        { column: DESCRIPTION, value: LONG_TEXT },
      ]);
      const skip = out.skipped.find((item) => item.reason === 'text_invariant_changed');
      expect(skip?.message).toContain('своими словами');
      expect((await cellsOf(world, id))['P12']).toBeUndefined();
    }
  });

  test('повторная попытка исправляет нарушение инвариантов', async () => {
    const editor = new MemorySiteTextEditor((_req, attempt) =>
      attempt === 1 ? SHORT_FIXED.replace('300', '350') : SHORT_FIXED,
    );
    const { world, id } = await worldWith({ editor });
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: LONG_TEXT },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect(editor.batches[1]?.[0]?.problem).toContain('350');
    expect((await cellsOf(world, id))['P12']).toBe(SHORT_FIXED);
  });

  test('сжатие может опустить второстепенное число, это предупреждение', async () => {
    const withExtra = `Кружка 300 мл арт. AB-12, высота 5 см. ${'Красивый подарок. '.repeat(100)}`;
    const editor = new MemorySiteTextEditor(() => 'Кружка 300 мл арт. AB-12. Красивый подарок.');
    const { world, id } = await worldWith({ editor });
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: withExtra },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect(out.warnings.join('\n')).toContain('величина 5 см');
  });

  test('без сжатия потеря числа - нарушение (текст остаётся исходным)', async () => {
    const editor = new MemorySiteTextEditor((req) => req.text.replace(' 300 мл', ''));
    const { world, id } = await worldWith({ editor });
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: DESCRIPTION, value: 'Белая кружка 300 мл' },
    ]);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружка 300 мл');
  });

  test('сбой редактора: короткий текст записан, длинный возвращён агенту', async () => {
    const editor = new MemorySiteTextEditor(() => {
      throw new Error('boom');
    });
    const { world, id } = await worldWith({ editor });
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [
          { cells: [name('Кружка'), { column: DESCRIPTION, value: LONG_TEXT }] },
          { cells: [name('Ложка'), { column: DESCRIPTION, value: 'Ложка' }] },
        ],
      },
      world.deps,
      world.ctx,
    );
    const cells = await cellsOf(world, id);
    expect(cells['P12']).toBeUndefined();
    expect(cells['P13']).toBe('Ложка');
    expect(out.skipped.some((item) => item.reason === 'value_too_long')).toBe(true);
    expect(out.warnings.join('\n')).toContain('недоступен');
  });
});

describe('столбец Q: единица из шапки', () => {
  test('см переводятся в мм по шапке, формат как в образце', async () => {
    const { world, id } = await worldWith();
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: SIZE, value: '10 x 20 x 30 см' },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect((await cellsOf(world, id))['Q12']).toBe('100×200×300');
  });

  test('метры переводятся в мм', async () => {
    const { world, id } = await worldWith();
    await fill(world, id, [
      { column: 'Название', value: 'Стойка' },
      { column: SIZE, value: '0,5×1×0,25 м' },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('500×1000×250');
  });

  test('шапка в сантиметрах: значение в мм переводится в см', async () => {
    const { world, id } = await worldWith({
      diskBytes: withSizeHeader('Размер упаковки, см, (ш-в-г)', '10x20x30'),
    });
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: SIZE, value: '125x200x30 мм' },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('12,5×20×3');
  });

  test('шапка без единицы: мм по умолчанию и пометка в ответе', async () => {
    const { world, id } = await worldWith({
      diskBytes: withSizeHeader('Размер упаковки (ш-в-г)', '10x20x30'),
    });
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: SIZE, value: '1x2x3 см' },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('10×20×30');
    expect(out.warnings.join('\n')).toContain('нет единицы');
  });

  test('формат «-» из шапки (ш-в-г) разбирается', async () => {
    const { world, id } = await worldWith();
    await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: SIZE, value: '10-20-30 см' },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('100×200×300');
  });

  test('образец с дефисом в шаблоне формат не меняет: всегда 240×240', async () => {
    const { world, id } = await worldWith({ diskBytes: withSizeHeader(SIZE_HEADER, '10-20-30') });
    await fill(world, id, [name('Кружка'), { column: SIZE, value: '24 × 24 см' }]);
    expect((await cellsOf(world, id))['Q12']).toBe('240×240');
  });

  test('разные записи ввода записываются одинаково: 240×240 и 240×240×50', async () => {
    const { world, id } = await worldWith({
      diskBytes: withSizeHeader(SIZE_HEADER, '10×20×30'),
    });
    await fill(world, id, [name('Кружка'), { column: SIZE, value: '240х240' }], 12);
    await fill(world, id, [name('Чашка'), { column: SIZE, value: '240 - 240 - 50' }], 13);
    const cells = await cellsOf(world, id);
    expect(cells['Q12']).toBe('240×240');
    expect(cells['Q13']).toBe('240×240×50');
  });

  test('неразбираемое значение: отказ с причиной, ячейка пуста', async () => {
    const { world, id } = await worldWith();
    const out = await fill(world, id, [
      { column: 'Название', value: 'Кружка' },
      { column: SIZE, value: 'средняя коробка' },
    ]);
    const skip = out.skipped.find((item) => item.reason === 'size_unparsable');
    expect(skip?.message).toContain('не разобран');
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
  });
});

/** Решения владельца 14 и 15: подписи осей, порядок Ш×В×Г и размер, который не определить. */
describe('столбец Q: порядок Ш×В×Г и неопределимый размер', () => {
  type SizeItem = { name: string; dimensions?: Record<string, string | number>; value?: string };

  async function fillSizes(world: TemplateWorld, id: string, items: SizeItem[]) {
    return fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: items.map((item) => ({
          cells: [
            name(item.name),
            {
              column: SIZE,
              ...(item.dimensions === undefined ? {} : { dimensions: item.dimensions }),
              ...(item.value === undefined ? {} : { value: item.value }),
            },
          ],
        })),
      },
      world.deps,
      world.ctx,
    );
  }

  test('подписи в значении в другом порядке: в ячейку идёт Ш×В×Г', async () => {
    const { world, id } = await worldWith();
    await fillSizes(world, id, [{ name: 'Кружка', value: 'г 110, в 220, ш 260 мм' }]);
    expect((await cellsOf(world, id))['Q12']).toBe('260×220×110');
  });

  test('dimensions: поля в любом порядке, см переводятся в мм шапки', async () => {
    const { world, id } = await worldWith();
    const out = await fillSizes(world, id, [
      { name: 'Кружка', dimensions: { depth: '11 см', width: '26 см', height: '22 см' } },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect((await cellsOf(world, id))['Q12']).toBe('260×220×110');
  });

  test('dimensions: два измерения', async () => {
    const { world, id } = await worldWith();
    await fillSizes(world, id, [{ name: 'Кружка', dimensions: { height: 220, width: 260 } }]);
    expect((await cellsOf(world, id))['Q12']).toBe('260×220');
  });

  test('решение 15: порядок неясен - Q пуста, задача доведена, есть предупреждение, вопросов нет',
    async () => {
      const { world, id } = await worldWith();
      const out = await fillSizes(world, id, [
        { name: 'Кружка', dimensions: { unlabeled: '260x220x110 мм' } },
        { name: 'Блокнот', dimensions: { width: '150 мм', height: '210 мм' } },
        { name: 'Ручка', value: '5-10 см' },
      ]);
      const cells = await cellsOf(world, id);
      // Задача доведена: остальные позиции и названия записаны, файл собран.
      expect(out.written).toBeGreaterThan(0);
      expect(cells['H12']).toBe('Кружка');
      expect(cells['H13']).toBe('Блокнот');
      expect(cells['H14']).toBe('Ручка');
      expect(cells['Q13']).toBe('150×210');
      // Q пуста у позиций без определённого порядка.
      expect(cells['Q12']).toBeUndefined();
      expect(cells['Q14']).toBeUndefined();
      expect(out.sizeUnresolved).toEqual(['Кружка', 'Ручка']);
      // Предупреждение для итогового сообщения - в точной формулировке владельца.
      expect(out.warnings).toContain(
        'Размеры не удалось определить для: Кружка, Ручка. Пришлите данные — дополню',
      );
      // Уточняющих вопросов нет: ни в причинах пропуска, ни в предупреждениях.
      const text = [...out.skipped.map((item) => item.message), ...out.warnings].join('\n');
      expect(text).not.toMatch(/уточни|переспроси|попроси/i);
    },
  );

  test('позиции без неясности предупреждения о размерах не вызывают', async () => {
    const { world, id } = await worldWith();
    const out = await fillSizes(world, id, [{ name: 'Кружка', value: '260×220×110' }]);
    expect(out.sizeUnresolved).toBeUndefined();
    expect(out.warnings.join('\n')).not.toContain('Размеры не удалось определить');
  });

  test('dimensions вместе с value - отказ ячейки, не угадывание', async () => {
    const { world, id } = await worldWith();
    const out = await fillSizes(world, id, [
      { name: 'Кружка', value: '1×2×3', dimensions: { width: '1', height: '2' } },
    ]);
    expect(out.skipped.some((item) => item.reason === 'size_unparsable')).toBe(true);
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
  });
});
