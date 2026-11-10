import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { loadWorkbook } from '../../src/agents/site-export/template-store';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import { sendTemplateFile } from '../../src/agents/site-export/send-template-file';
import { SITE_EXPORT_PROMPT } from '../../src/agents/site-export/prompt';
import {
  convertSize,
  convertSizeParts,
  type SizeConversion,
} from '../../src/agents/site-export/size-units';
import {
  SHEET_CONTENT,
  SHEET_MAIN,
  buildTemplateWorld,
  type TemplateWorld,
} from './site-template-support';

/**
 * Ревью 239a (столбец Q): разряды и пробелы, подписи через «х», dimensions без единиц,
 * предупреждение о размерах от кода, одно число без подписи, запятая «1,200», схема value,
 * метки позиций между пакетами. Шапка Q в тестовом шаблоне - в мм.
 */

const SIZE = 'Размер упаковки';
const SKU = 'Артикул';
const base = {
  requestedByEmployee: false,
  confirmedByEmployee: false,
  overwrite: false,
  stampManager: true,
} as const;
const WARNING_PREFIX = 'Размеры не удалось определить для:';

type SizeCell = {
  column: string;
  value?: string | number;
  dimensions?: Record<string, string | number>;
};
type Item = { row?: number; cells: SizeCell[] };

function expectUnclear(result: SizeConversion): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.kind).toBe('order_unclear');
}

function expectValue(input: string, expected: string, unit: 'мм' | 'см' = 'мм'): void {
  expect(convertSize(input, unit)).toEqual({ ok: true, value: expected });
}

async function worldWithBook(): Promise<{ world: TemplateWorld; id: string }> {
  const world = await buildTemplateWorld();
  const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
  return { world, id: out.workbookId ?? '' };
}

async function fill(world: TemplateWorld, id: string, items: Item[], extra = {}) {
  return fillTemplateRows.execute(
    { ...base, workbookId: id, items, ...extra },
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

const named = (title: string, size: SizeCell): Item => ({
  cells: [{ column: 'Название', value: title }, size],
});

describe('В1: числа через пробел не склеиваются в одно число', () => {
  test.each(['260 220 110', '260 220 110 мм', '260 220', '260 220 мм'])(
    '«%s» без разделителя - порядок неясен, а не 260220110',
    (input) => expectUnclear(convertSize(input, 'мм')),
  );

  test('в шапке см та же запись не превращается в 26022011', () => {
    expectUnclear(convertSize('260 220 110 мм', 'см'));
  });

  test('unlabeled «260 220» и «260 220 110» ничего не записывает', () => {
    expectUnclear(convertSizeParts({ unlabeled: '260 220' }, 'мм'));
    expectUnclear(convertSizeParts({ unlabeled: '260 220 110' }, 'мм'));
  });

  test('разряды однозначны только как «1 200» (одна цифра перед группой)', () => {
    expectValue('1 200×800×600', '1200×800×600');
    expectValue('1 200 x 2 400 x 300 мм', '1200×2400×300');
    expect(convertSizeParts({ width: '1 200 мм' }, 'мм')).toEqual({ ok: true, value: '1200' });
  });

  test('«12 500×200» и «1 200 300» разрядами не считаются', () => {
    expectUnclear(convertSize('12 500×200', 'мм'));
    expectUnclear(convertSize('1 200 300', 'мм'));
  });

  test('в ячейку unlabeled «260 220» не попадает: Q пуста, предупреждение есть', async () => {
    const { world, id } = await worldWithBook();
    const out = await fill(world, id, [
      named('Кружка', { column: SIZE, dimensions: { unlabeled: '260 220' } }),
    ]);
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
    expect(out.sizeUnresolved).toEqual(['Кружка']);
    expect(out.warnings).toContain(`${WARNING_PREFIX} Кружка. Пришлите данные — дополню`);
  });
});

describe('В2: подписи с «х»/«x»/«×» между буквами и сокращения', () => {
  test.each([
    ['ШхВхГ кириллицей', 'ШхВхГ 260х220х110 мм'],
    ['ШxВxГ латиницей', 'ШxВxГ 260x220x110 мм'],
    ['подпись после значения', '260x220x110 mm (ШxВxГ)'],
    ['единица после списка подписей', 'Ш×В×Г, мм: 260×220×110'],
    ['единица после списка с х', 'ШхВхГ, мм: 260х220х110'],
    ['сокращения с точкой', 'шир. 260, выс. 220, гл. 110 мм'],
    ['сокращения: длина, высота, глубина', 'дл. 260, выс. 220, гл. 110 мм'],
    ['слово «Габариты»', 'Габариты 260×220×110 (Ш×В×Г)'],
    ['слово «Размеры упаковки»', 'Размеры упаковки: ШхВхГ 260х220х110 мм'],
    ['W x H x D', 'WxHxD 260x220x110 mm'],
    ['с пробелами вокруг х', 'Ш х В х Г 260 х 220 х 110 мм'],
    ['порядок источника другой', 'ГхШхВ 110х260х220 мм'],
  ])('%s', (_name, input) => expectValue(input, '260×220×110'));

  test('ДхШхВ: длина с шириной - порядок неясен, а не запись в порядке источника', () => {
    expectUnclear(convertSize('ДхШхВ 300х200х100 мм', 'мм'));
    expectUnclear(convertSize('LxWxH 300x200x100', 'мм'));
  });

  test('отказ не просит записать числа в порядке источника и без подписей', () => {
    const result = convertSize('большая коробка', 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('10×20×30');
      expect(result.message).toContain('dimensions');
      expect(result.message).toContain('не переставляй');
    }
  });

  test('«2023 г» - не подпись глубины: отказ про лишний текст, а не про оси', () => {
    const result = convertSize('2023 г', 'мм');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('лишний текст');
  });
});

describe('В3: dimensions без единиц', () => {
  test('все поля без единиц при шапке в мм - принимаются как мм', () => {
    expect(convertSizeParts({ width: 260, height: 220, depth: 110 }, 'мм')).toEqual({
      ok: true,
      value: '260×220×110',
    });
  });

  test('все поля без единиц при шапке в см - отказ size_unparsable', () => {
    const result = convertSizeParts({ width: 26, height: 22, depth: 11 }, 'см');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unparsable');
      expect(result.message).toContain('см');
    }
  });

  test('единица только у части полей - отказ, поле не берёт единицу соседа', () => {
    for (const parts of [
      { width: '26 см', height: 22, depth: '11' },
      { width: 26, height: 22, depth: '11 см' },
    ]) {
      const result = convertSizeParts(parts, 'мм');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('unparsable');
        expect(result.message).toContain('у каждого');
      }
    }
  });

  test('промпт: единица в каждом поле dimensions, без единиц - только при шапке в мм', () => {
    expect(SITE_EXPORT_PROMPT).toContain('в КАЖДОМ');
    expect(SITE_EXPORT_PROMPT).toContain('все поля без единиц и шапка в мм');
  });
});

describe('В4: предупреждение о размерах формирует код', () => {
  test('промпт не разрешает «оставь размер пустым»: всегда unlabeled', () => {
    expect(SITE_EXPORT_PROMPT).not.toMatch(/оставь размер пустым|либо оставь размер/);
    expect(SITE_EXPORT_PROMPT).toContain('ВСЕГДА передай числа как dimensions.unlabeled');
  });

  test('неразобранная запись тоже попадает в предупреждение', async () => {
    const { world, id } = await worldWithBook();
    const out = await fill(world, id, [
      named('Кружка', { column: SIZE, value: 'средняя коробка' }),
    ]);
    expect(out.sizeUnresolved).toEqual(['Кружка']);
    expect(out.warnings).toContain(`${WARNING_PREFIX} Кружка. Пришлите данные — дополню`);
  });

  test('список копится между пакетами и приходит в ответе sendTemplateFile', async () => {
    const { world, id } = await worldWithBook();
    await fill(world, id, [
      named('Кружка', { column: SIZE, dimensions: { unlabeled: '260x220x110' } }),
    ]);
    const second = await fill(world, id, [
      named('Блокнот', { column: SIZE, dimensions: { unlabeled: '150 210' } }),
      named('Ручка', { column: SIZE, value: '260×220×110' }),
    ]);
    // Последний пакет перечисляет и позицию первого пакета.
    expect(second.sizeUnresolved).toEqual(['Кружка', 'Блокнот']);
    expect(second.warnings).toContain(
      `${WARNING_PREFIX} Кружка, Блокнот. Пришлите данные — дополню`,
    );
    const sent = await sendTemplateFile.execute({ workbookId: id }, world.deps, world.ctx);
    expect(sent.sizeUnresolved).toEqual(['Кружка', 'Блокнот']);
    expect(sent.warnings).toEqual([
      `${WARNING_PREFIX} Кружка, Блокнот. Пришлите данные — дополню`,
    ]);
  });

  test('без нерешённых размеров sendTemplateFile предупреждений не добавляет', async () => {
    const { world, id } = await worldWithBook();
    await fill(world, id, [named('Кружка', { column: SIZE, value: '260×220×110' })]);
    const sent = await sendTemplateFile.execute({ workbookId: id }, world.deps, world.ctx);
    expect(sent.sizeUnresolved).toBeUndefined();
    expect(sent.warnings).toBeUndefined();
  });

  test('позиция, которую исправили (та же строка), из предупреждения уходит', async () => {
    const { world, id } = await worldWithBook();
    const first = await fill(world, id, [
      named('Кружка', { column: SIZE, dimensions: { unlabeled: '260 220 110' } }),
    ]);
    const row = first.rows[0]?.row ?? 0;
    expect(row).toBeGreaterThan(0);
    const parts = { width: '26 см', height: '22 см', depth: '11 см' };
    const fixed = await fill(world, id, [{ row, cells: [{ column: SIZE, dimensions: parts }] }]);
    expect(fixed.sizeUnresolved).toBeUndefined();
    expect((await cellsOf(world, id))[`Q${row}`]).toBe('260×220×110');
    const sent = await sendTemplateFile.execute({ workbookId: id }, world.deps, world.ctx);
    expect(sent.warnings).toBeUndefined();
  });

  test('предупреждение сохраняется, даже если в пакете ничего не записано', async () => {
    const { world, id } = await worldWithBook();
    // Название уже стоит в строке 12 как «чужое»: запись в пакете не пройдёт, Q тоже.
    await fill(world, id, [named('Кружка', { column: SIZE, value: '260×220×110' })]);
    const unclear = { column: SIZE, dimensions: { unlabeled: '1 2' } };
    const out = await fill(world, id, [{ row: 12, cells: [unclear] }]);
    expect(out.written).toBe(0);
    expect(out.warnings.join('\n')).toContain(WARNING_PREFIX);
    const sent = await sendTemplateFile.execute({ workbookId: id }, world.deps, world.ctx);
    expect(sent.warnings?.[0]).toContain(WARNING_PREFIX);
  });
});

describe('В5: одно число без подписи', () => {
  test.each(['260', '260 мм', '5 см'])('«%s» - порядок неясен', (input) => {
    expectUnclear(convertSize(input, 'мм'));
  });

  test('число (не строка) и unlabeled с одним числом - тоже', () => {
    expectUnclear(convertSize(260, 'мм'));
    expectUnclear(convertSizeParts({ unlabeled: '260' }, 'мм'));
  });

  test('с подписью ширины и в поле width записывается', () => {
    expectValue('ширина 260 мм', '260');
    expect(convertSizeParts({ width: 260 }, 'мм')).toEqual({ ok: true, value: '260' });
  });

  test('в ячейку Q пусто, позиция в предупреждении', async () => {
    const { world, id } = await worldWithBook();
    const out = await fill(world, id, [named('Шар', { column: SIZE, value: '260' })]);
    expect((await cellsOf(world, id))['Q12']).toBeUndefined();
    expect(out.sizeUnresolved).toEqual(['Шар']);
  });
});

describe('В6: запятая «1,200» - тысяча или десятичная дробь', () => {
  test('«1,200×800×600 мм» - отказ, а не 1,2×800×600', () => {
    for (const input of ['1,200×800×600 мм', '1.200×800×600', 'ш 1,200, в 800, г 600 мм']) {
      const result = convertSize(input, 'мм');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('unparsable');
        expect(result.message).toContain('запись неоднозначна');
      }
    }
  });

  test('dimensions: «1,200» рядом с целыми - тот же отказ', () => {
    const parts = { width: '1,200 мм', height: '800 мм', depth: '600 мм' };
    expect(convertSizeParts(parts, 'мм').ok).toBe(false);
  });

  test('десятичная дробь с другим числом знаков и малые соседи - записываются', () => {
    expectValue('1,5×800×600 мм', '1,5×800×600');
    expectValue('1,200×0,5×0,3 м', '1200×500×300');
  });
});

describe('В7: value необязателен только вместе с dimensions', () => {
  const schema = fillTemplateRows.inputSchema;
  const wrap = (cell: Record<string, unknown>) => ({
    ...base,
    workbookId: 'wb',
    items: [{ cells: [cell] }],
  });

  test('ячейка без value и без dimensions - отказ схемы с понятным текстом', () => {
    const parsed = schema.safeParse(wrap({ column: 'Название' }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('нужен value');
  });

  test('value или dimensions по отдельности проходят схему', () => {
    expect(schema.safeParse(wrap({ column: 'Название', value: 'Кружка' })).success).toBe(true);
    expect(
      schema.safeParse(wrap({ column: SIZE, dimensions: { width: 1, height: 2 } })).success,
    ).toBe(true);
  });

  test('dimensions в колонке не про размер - явный отказ с причиной', async () => {
    const { world, id } = await worldWithBook();
    const out = await fill(world, id, [
      { cells: [{ column: 'Название', dimensions: { width: 1, height: 2 } }] },
    ]);
    const skip = out.skipped.find((item) => item.reason === 'size_unparsable');
    expect(skip?.message).toContain('только для столбца «Размер упаковки»');
    expect(skip?.reason).not.toBe('empty_value');
  });

  test('dimensions на листах 2-4 - явный отказ, а не empty_value', async () => {
    const { world, id } = await worldWithBook();
    const out = await fill(
      world,
      id,
      [{ row: 5, cells: [{ column: 'C', dimensions: { width: 1, height: 2 } }] }],
      {
        sheet: SHEET_CONTENT,
        requestedByEmployee: true,
        requestQuote: 'добавь категорию',
        confirmedByEmployee: true,
      },
    );
    expect(out.skipped.map((item) => item.reason)).toEqual(['size_unparsable']);
    expect(out.skipped[0]?.message).toContain('главного листа');
  });
});

describe('В8: метка позиции без названия уникальна между пакетами', () => {
  test('«строка N» из плана, а не «позиция 1» в каждом пакете', async () => {
    const { world, id } = await worldWithBook();
    const unclear = { column: SIZE, dimensions: { unlabeled: '10 20' } };
    const first = await fill(world, id, [{ cells: [{ column: SKU, value: 'A-1' }, unclear] }]);
    const second = await fill(world, id, [{ cells: [{ column: SKU, value: 'A-2' }, unclear] }]);
    expect(first.sizeUnresolved).toEqual(['строка 12']);
    expect(second.sizeUnresolved).toEqual(['строка 12', 'строка 13']);
    expect(second.sizeUnresolved?.join(' ')).not.toContain('позиция');
  });

  test('одинаковое название у разных строк уточняется строкой', async () => {
    const { world, id } = await worldWithBook();
    const unclear = { column: SIZE, dimensions: { unlabeled: '10 20' } };
    const withSku = (sku: string): Item => ({
      cells: [{ column: 'Название', value: 'Кружка' }, { column: SKU, value: sku }, unclear],
    });
    const out = await fill(world, id, [withSku('A-1'), withSku('A-2')]);
    expect(out.sizeUnresolved).toEqual(['Кружка', 'Кружка (строка 13)']);
  });
});

describe('В9: стиль', () => {
  const DIR = join(import.meta.dir, '../../src/agents/site-export');
  const MAX_LINE = 100;

  test.each([
    'size-axes.ts',
    'size-units.ts',
    'size-unresolved.ts',
    'prepare-cells.ts',
    'send-template-file.ts',
  ])('в %s нет строк длиннее 100 знаков', (file) => {
    const long = readFileSync(join(DIR, file), 'utf8')
      .split('\n')
      .filter((line) => [...line].length > MAX_LINE);
    expect(long).toEqual([]);
  });
});
