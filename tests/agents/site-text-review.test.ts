import { describe, expect, test } from 'bun:test';
import { MemorySiteTextEditor } from '../../src/kit/adapters/memory/site-text-editor';
import { SITE_EXPORT_PROMPT } from '../../src/agents/site-export/prompt';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { loadWorkbook } from '../../src/agents/site-export/template-store';
import { openChatTemplate } from '../../src/agents/site-export/open-chat-template';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import { textColumnKinds } from '../../src/agents/site-export/template-columns';
import { SITE_DESCRIPTION_MAX_CHARS } from '../../src/kit/domain/site-export';
import type {
  SiteTextEditOptions,
  SiteTextEditRequest,
  SiteTextEditResult,
  SiteTextEditor,
} from '../../src/kit/ports/site-text-editor';
import {
  COLUMNS,
  EXAMPLE_CELLS,
  SHEET_MAIN,
  buildBook,
  buildTemplateWorld,
  headersOf,
  type TemplateWorld,
} from './site-template-support';

/** Ревью этапа 225: порядок «план - модель - повторная проверка», пакеты, id, единицы, роли. */

type Cell = {
  column: string;
  value?: string | number;
  dimensions?: Record<string, string | number>;
};
const base = {
  requestedByEmployee: false,
  confirmedByEmployee: false,
  overwrite: false,
  stampManager: true,
} as const;
const DESCRIPTION = 'Описание / Легенда';
const SIZE = 'Размер упаковки';
const MAX = SITE_DESCRIPTION_MAX_CHARS;
const BATCH = 15;
const LONG_TEXT = `Кружка 300 мл арт. AB-12. ${'Красивый подарок для коллег. '.repeat(60)}`;
const SHORT_FIXED = 'Кружка 300 мл арт. AB-12. Красивый подарок для коллег.';
const name = (value: string): Cell => ({ column: 'Название', value });

function bookWith(options: {
  sizeHeader?: string;
  extra?: Array<{ letter: string; col: number; text: string }>;
  cells?: Record<string, string | number>;
}): Uint8Array {
  const columns = [
    ...COLUMNS.map((spec) =>
      spec.letter === 'Q' && options.sizeHeader !== undefined
        ? { ...spec, text: options.sizeHeader }
        : spec,
    ),
    ...(options.extra ?? []).map((item) => ({ ...item, yellow: true })),
  ];
  return buildBook({ columns, cells: { ...EXAMPLE_CELLS, Q6: '10x20x30', ...options.cells } });
}

async function worldWith(
  options: { diskBytes?: Uint8Array; editor?: SiteTextEditor } = {},
): Promise<{ world: TemplateWorld; id: string }> {
  const world = await buildTemplateWorld({ diskBytes: options.diskBytes ?? bookWith({}) });
  if (options.editor !== undefined) world.deps.textEditor = options.editor;
  const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
  return { world, id: out.workbookId ?? '' };
}

async function fillItems(
  world: TemplateWorld,
  id: string,
  items: Array<{ row?: number; cells: Cell[] }>,
) {
  return fillTemplateRows.execute({ ...base, workbookId: id, items }, world.deps, world.ctx);
}

async function cellsOf(world: TemplateWorld, id: string) {
  const loaded = await loadWorkbook(world.deps, id);
  const model = JSON.parse(new TextDecoder().decode(loaded.bytes)) as {
    cells: Record<string, Record<string, string | number>>;
  };
  return model.cells[SHEET_MAIN] ?? {};
}

describe('1. Q: единица в значении и единица шапки в ответе', () => {
  test('промпт требует единицу в значении и не утверждает «одни числа»', () => {
    expect(SITE_EXPORT_PROMPT).not.toContain('(сейчас мм)');
    expect(SITE_EXPORT_PROMPT).not.toContain('в ячейке одни числа');
    expect(SITE_EXPORT_PROMPT).toContain('ВСЕГДА указывай единицу');
  });

  test('ответ называет фактическую единицу шапки', async () => {
    const { world, id } = await worldWith({
      diskBytes: bookWith({ sizeHeader: 'Размер упаковки, см, (ш-в-г)' }),
    });
    const out = await fillItems(world, id, [
      { cells: [name('Кружка'), { column: SIZE, value: '100x200x300 мм' }] },
    ]);
    expect(out.sizeUnits).toEqual([
      { column: 'Размер упаковки, см, (ш-в-г)', unit: 'см', assumed: false },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('10×20×30');
  });

  test('единицы в шапке нет: в ответе мм по умолчанию и признак assumed', async () => {
    const { world, id } = await worldWith({
      diskBytes: bookWith({ sizeHeader: 'Размер упаковки (ш-в-г)' }),
    });
    const out = await fillItems(world, id, [
      { cells: [name('Кружка'), { column: SIZE, value: '1x2x3 см' }] },
    ]);
    expect(out.sizeUnits?.[0]).toMatchObject({ unit: 'мм', assumed: true });
  });

  test('шапка в см, значение без единицы: отказ с причиной, называющей см', async () => {
    const { world, id } = await worldWith({
      diskBytes: bookWith({ sizeHeader: 'Размер упаковки, см, (ш-в-г)' }),
    });
    const out = await fillItems(world, id, [
      { cells: [name('Кружка'), { column: SIZE, value: '10x20x30' }] },
    ]);
    const skip = out.skipped.find((item) => item.reason === 'size_unparsable');
    expect(skip?.message).toContain('см');
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
  });
});

describe('3. модель получает только ячейки, прошедшие план', () => {
  test('дубль колонки, чужая непустая ячейка и защищённая строка в модель не уходят', async () => {
    const editor = new MemorySiteTextEditor();
    // Присланный файл: примеры в строках 12-13 остаются, чужое описание стоит в P13.
    const world = await buildTemplateWorld();
    world.deps.textEditor = editor;
    world.setChatFile('мой.xlsx', bookWith({ cells: { P13: 'Чужое описание' } }));
    const id = (await openChatTemplate.execute({}, world.deps, world.ctx)).workbookId ?? '';
    const out = await fillItems(world, id, [
      {
        cells: [
          name('Кружка'),
          { column: DESCRIPTION, value: 'Первое описание' },
          { column: DESCRIPTION, value: 'Второе описание' },
        ],
      },
      { row: 13, cells: [{ column: DESCRIPTION, value: LONG_TEXT }] },
      { row: 5, cells: [{ column: DESCRIPTION, value: 'Защищённая строка' }] },
    ]);
    const sent = editor.batches.flat().map((request) => request.text);
    expect(sent).toEqual(['Первое описание']);
    const reasons = out.skipped.map((item) => item.reason);
    expect(reasons).toContain('duplicate_in_request');
    expect(reasons).toContain('cell_not_empty');
    expect(reasons).toContain('protected_area');
    expect(reasons).not.toContain('value_too_long');
  });

  test('после правки план пересчитан: сжатое описание записано, строки не потеряны', async () => {
    const editor = new MemorySiteTextEditor((req) => (req.compress ? SHORT_FIXED : req.text));
    const { world, id } = await worldWith({ editor });
    const out = await fillItems(world, id, [
      { cells: [name('Кружка'), { column: DESCRIPTION, value: LONG_TEXT }] },
    ]);
    expect(out.skippedTotal).toBe(0);
    const cells = await cellsOf(world, id);
    expect(cells['P12']).toBe(SHORT_FIXED);
    expect(cells['AD12']).toBeDefined();
  });

  test('описание не прошло проверку: остальные ячейки строки пишутся', async () => {
    const editor = new MemorySiteTextEditor(() => 'Кружка 999 мл');
    const { world, id } = await worldWith({ editor });
    const out = await fillItems(world, id, [
      { cells: [name('Кружка'), { column: DESCRIPTION, value: LONG_TEXT }] },
    ]);
    expect(out.skipped.some((item) => item.column === DESCRIPTION)).toBe(true);
    const cells = await cellsOf(world, id);
    expect(cells['H12']).toBe('Кружка');
    expect(cells['P12']).toBeUndefined();
  });
});

describe('6. сбой одного пакета не выбрасывает успешные', () => {
  const items = Array.from({ length: BATCH + 1 }, (_, index) => ({
    cells: [name(`Кружка ${index}`), { column: DESCRIPTION, value: `Белая кружа ${index}` }],
  }));
  const fixTypo = (text: string): string => text.replace('кружа', 'кружка');

  test('упал первый пакет: второй принят, повтор идёт только по упавшему', async () => {
    const editor = new MemorySiteTextEditor((request, attempt) => {
      if (request.id === '0:1' && attempt === 1) throw new Error('boom');
      return fixTypo(request.text);
    });
    const { world, id } = await worldWith({ editor });
    const out = await fillItems(world, id, items);
    expect(out.skippedTotal).toBe(0);
    expect(editor.batches.map((batch) => batch.length)).toEqual([BATCH, 1, BATCH]);
    const cells = await cellsOf(world, id);
    for (let index = 0; index <= BATCH; index += 1) {
      expect(cells[`P${12 + index}`]).toBe(`Белая кружка ${index}`);
    }
    expect(out.warnings.join('\n')).not.toContain('недоступен');
  });

  test('упавший пакет не лечится: остальные правки записаны, предупреждение о сбое', async () => {
    const editor = new MemorySiteTextEditor((request) => {
      if (request.id === '0:1') throw new Error('boom');
      return fixTypo(request.text);
    });
    const { world, id } = await worldWith({ editor });
    const out = await fillItems(world, id, items);
    expect(out.warnings.join('\n')).toContain('недоступен');
    const cells = await cellsOf(world, id);
    expect(cells[`P${12 + BATCH}`]).toBe(`Белая кружка ${BATCH}`);
    expect(cells['P12']).toBe('Белая кружа 0');
  });
});

/** Редактор с заданными ответами по номеру вызова; запоминает параметры вызовов. */
class ScriptedEditor implements SiteTextEditor {
  readonly calls: Array<{ requests: SiteTextEditRequest[]; options: SiteTextEditOptions }> = [];

  constructor(
    private readonly script: (
      requests: readonly SiteTextEditRequest[],
      call: number,
    ) => SiteTextEditResult[],
  ) {}

  async edit(
    requests: readonly SiteTextEditRequest[],
    options: SiteTextEditOptions,
  ): Promise<SiteTextEditResult[]> {
    this.calls.push({ requests: [...requests], options });
    return this.script(requests, this.calls.length);
  }
}

describe('9. ответ модели: множество id сверяется', () => {
  const item = { cells: [name('Кружка'), { column: DESCRIPTION, value: 'Белая кружа 300 мл' }] };

  test('чужой id в ответе: пакет отвергнут, повтор принят', async () => {
    const editor = new ScriptedEditor((requests, call) =>
      call === 1
        ? [
            { id: 'чужой', text: 'Не наше' },
            ...requests.map((request) => ({ id: request.id, text: 'Белая кружка 300 мл!' })),
          ]
        : requests.map((request) => ({ id: request.id, text: 'Белая кружка 300 мл' })),
    );
    const { world, id } = await worldWith({ editor });
    const out = await fillItems(world, id, [item]);
    expect(out.skippedTotal).toBe(0);
    expect(editor.calls.length).toBe(2);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружка 300 мл');
  });

  test('повторяющийся id: ни один из дублей не принимается, повтор принят', async () => {
    const editor = new ScriptedEditor((requests, call) =>
      call === 1
        ? requests.flatMap((request) => [
            { id: request.id, text: 'Дубль один 300 мл' },
            { id: request.id, text: 'Дубль два 300 мл' },
          ])
        : requests.map((request) => ({ id: request.id, text: 'Белая кружка 300 мл' })),
    );
    const { world, id } = await worldWith({ editor });
    await fillItems(world, id, [item]);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружка 300 мл');
    expect(editor.calls.length).toBe(2);
  });

  test('оба раза чужие id: записан исходный короткий текст, есть предупреждение', async () => {
    const editor = new ScriptedEditor(() => [{ id: 'чужой', text: 'Не наше' }]);
    const { world, id } = await worldWith({ editor });
    const out = await fillItems(world, id, [item]);
    expect((await cellsOf(world, id))['P12']).toBe('Белая кружа 300 мл');
    expect(out.warnings.join('\n')).toContain('отклонена');
  });
});

describe('8. тред запроса к модели - тред агента', () => {
  test('редактору передаётся threadId хода', async () => {
    const editor = new MemorySiteTextEditor();
    const { world, id } = await worldWith({ editor });
    await fillItems(world, id, [
      { cells: [name('Кружка'), { column: DESCRIPTION, value: 'Белая кружка' }] },
    ]);
    expect(editor.threadIds).toEqual([world.ctx.threadId]);
  });
});

describe('7. Q: числовое значение, разряды, порядок осей', () => {
  test('ширина числом без единицы при шапке в мм записывается', async () => {
    const { world, id } = await worldWith();
    const out = await fillItems(world, id, [
      { cells: [name('Шар'), { column: SIZE, dimensions: { width: 25 } }] },
    ]);
    expect(out.skippedTotal).toBe(0);
    expect((await cellsOf(world, id))['Q12']).toBe('25');
  });

  test('одно число без подписи: Q пуста, позиция в предупреждении', async () => {
    const { world, id } = await worldWith();
    const out = await fillItems(world, id, [
      { cells: [name('Шар'), { column: SIZE, value: 25 }] },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
    expect(out.sizeUnresolved).toEqual(['Шар']);
    expect(out.warnings).toContain(
      'Размеры не удалось определить для: Шар. Пришлите данные — дополню',
    );
  });

  test('«1 000x200x300» - тысяча', async () => {
    const { world, id } = await worldWith();
    await fillItems(world, id, [
      { cells: [name('Стойка'), { column: SIZE, value: '1 000x200x300' }] },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('1000×200×300');
  });

  test('подписи «Д×Ш×В»: «длина» с шириной неоднозначна, значения не переставляются', async () => {
    const { world, id } = await worldWith();
    const out = await fillItems(world, id, [
      { cells: [name('Стойка'), { column: SIZE, value: '30 (Д) x 20 (Ш) x 10 (В) мм' }] },
    ]);
    const skip = out.skipped.find((item) => item.reason === 'size_order_unclear');
    expect(skip?.message).toContain('Размеры не удалось определить');
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
    expect(out.warnings.join('\n')).toContain('Размеры не удалось определить для: Стойка');
  });

  test('подписи «Г×В×Ш» переставляются в Ш×В×Г по смыслу', async () => {
    const { world, id } = await worldWith();
    await fillItems(world, id, [
      { cells: [name('Стойка'), { column: SIZE, value: '10 (Г) x 20 (В) x 30 (Ш) мм' }] },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('30×20×10');
  });

  test('шапка с латинской mm распознана', async () => {
    const { world, id } = await worldWith({
      diskBytes: bookWith({ sizeHeader: 'Размер упаковки, cm, (ш-в-г)' }),
    });
    await fillItems(world, id, [
      { cells: [name('Кружка'), { column: SIZE, value: '125x200x30 мм' }] },
    ]);
    expect((await cellsOf(world, id))['Q12']).toBe('12,5×20×3');
  });
});

describe('5. пробелы: строгий режим для артикулов, ссылок и формул', () => {
  test('артикул и ссылка: только края; название - полная нормализация', async () => {
    const { world, id } = await worldWith();
    await fillItems(world, id, [
      {
        cells: [
          { column: 'Название', value: ' Кружка  белая , 300 мл ' },
          { column: 'Артикул', value: ' AB  12 , x ' },
          { column: 'Основное фото', value: ' https://x.example/a ?q=1 ' },
        ],
      },
    ]);
    const cells = await cellsOf(world, id);
    expect(cells['H12']).toBe('Кружка белая, 300 мл');
    expect(cells['I12']).toBe('AB  12 , x');
    expect(cells['J12']).toBe('https://x.example/a ?q=1');
  });
});

describe('10. роль колонки P/Q: неоднозначность - без роли', () => {
  const kindsOf = (...texts: string[]) =>
    textColumnKinds(
      headersOf(
        texts.map((text, index) => ({
          letter: 'ABCDEF'[index] ?? 'Z',
          col: index + 1,
          text,
          yellow: true,
        })),
      ),
    );

  test('единственные «Описание» и «Размер упаковки» получают роли', () => {
    const { kinds, ambiguous } = kindsOf('Описание / Легенда', 'Размер упаковки, мм', 'Название');
    expect(kinds.get('A')).toBe('description');
    expect(kinds.get('B')).toBe('size');
    expect(ambiguous).toEqual([]);
  });

  test('«Описание» - слово целиком; две «Описание ...» - без роли', () => {
    expect(kindsOf('Описания товара').kinds.size).toBe(0);
    const two = kindsOf('Описание / Легенда', 'Описание фото');
    expect(two.kinds.size).toBe(0);
    expect(two.ambiguous).toEqual(['description']);
  });

  test('две колонки «Размер упаковки ...» - без роли', () => {
    const two = kindsOf('Размер упаковки, мм', 'Размер упаковки подарочной');
    expect(two.kinds.size).toBe(0);
    expect(two.ambiguous).toEqual(['size']);
  });

  test('подсказка «(ш-в-г)» работает, только если «Размер упаковки» в шапке нет', () => {
    expect(kindsOf('Габариты (ш-в-г), см').kinds.get('A')).toBe('size');
    const both = kindsOf('Габариты (ш-в-г), см', 'Размер упаковки, мм');
    expect(both.kinds.get('B')).toBe('size');
    expect(both.kinds.has('A')).toBe(false);
  });

  test('в записи: две «Описание...» - проверка не выполняется, предупреждение', async () => {
    const { world, id } = await worldWith({
      diskBytes: bookWith({ extra: [{ letter: 'R', col: 18, text: 'Описание фото' }] }),
    });
    const out = await fillItems(world, id, [
      { cells: [name('Кружка'), { column: DESCRIPTION, value: LONG_TEXT }] },
    ]);
    expect(out.warnings.join('\n')).toContain('неоднозначн');
    expect(out.skipped.some((item) => item.reason === 'value_too_long')).toBe(false);
  });
});
