import { describe, expect, test } from 'bun:test';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { loadWorkbook, saveWorkbook } from '../../src/agents/site-export/template-store';
import { openChatTemplate } from '../../src/agents/site-export/open-chat-template';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import {
  EXAMPLE_CELLS,
  SHEET_CONTENT,
  SHEET_MAIN,
  buildBook,
  buildTemplateWorld,
  type TemplateWorld,
} from './site-template-support';

/** fillTemplateRows: правила владельца проверяются кодом, а не промптом. */

type Cell = { column: string; value: string | number };
const name = (value: string): Cell => ({ column: 'Название', value });
const confirmed = { confirmedByEmployee: true } as const;
const item = (cells: Cell[], row?: number) => ({ ...(row === undefined ? {} : { row }), cells });
const base = {
  requestedByEmployee: false,
  confirmedByEmployee: false,
  overwrite: false,
  stampManager: true,
} as const;

/** Полный набор значений позиции без цены/диапазона: все жёлтые колонки со списками. */
const full = (name: string, sku?: string): Cell[] => [
  { column: 'Название', value: name },
  ...(sku === undefined ? [] : [{ column: 'Артикул', value: sku }]),
  { column: 'Срок изготовления, недели', value: 3 },
  { column: 'Упаковка', value: 'ПОДАРОЧНАЯ' },
  { column: 'Направления', value: 'Категория A' },
  { column: 'по цене', value: '2-5 тыс.' },
];

async function cleanBook(world: TemplateWorld): Promise<string> {
  const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
  return out.workbookId ?? '';
}

async function cellsOf(world: TemplateWorld, id: string, sheet = SHEET_MAIN) {
  const loaded = await loadWorkbook(world.deps, id);
  const model = JSON.parse(new TextDecoder().decode(loaded.bytes)) as {
    cells: Record<string, Record<string, string | number>>;
    sheets: string[];
  };
  return { cells: model.cells[sheet] ?? {}, sheets: model.sheets };
}

describe('запись позиций', () => {
  test('позиции идут подряд с первой свободной строки, значение списка канонично', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [item(full('Тюбинг', 'T-1')), item(full('Кружка'))],
      },
      world.deps,
      world.ctx,
    );
    expect(out.rows).toEqual([
      { item: 0, row: 12 },
      { item: 1, row: 13 },
    ]);
    expect(out.skippedTotal).toBe(0);
    const { cells } = await cellsOf(world, id);
    expect(cells['H12']).toBe('Тюбинг');
    expect(cells['I12']).toBe('T-1');
    expect(cells['I13']).toBeUndefined();
    // Канонический регистр из списка и число остаётся числом.
    expect(cells['U12']).toBe('подарочная');
    expect(cells['T12']).toBe(3);
    expect(out.nextFreeRow).toBe(14);
    expect(out.structureUnchanged).toBe(true);
    expect(out.sheetsCount).toBe(4);
  });

  test('несколько сотен позиций за один вызов', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const items = Array.from({ length: 300 }, (_, n) => item(full(`Позиция ${n + 1}`)));
    const args = { ...base, workbookId: id, items };
    const out = await fillTemplateRows.execute(args, world.deps, world.ctx);
    expect(out.rows[299]?.row).toBe(311);
    expect(out.skippedTotal).toBe(0);
    expect(out.missingListValues).toEqual([]);
  });

  test('значение вне списка отклоняется с подсказкой, ячейка пуста', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [item([name('Кепка'), { column: 'Упаковка', value: 'подар' }])],
      },
      world.deps,
      world.ctx,
    );
    expect(out.skipped[0]).toMatchObject({ reason: 'not_in_list', column: 'Упаковка' });
    expect(out.skipped[0]?.hint).toContain('подарочная');
    expect((await cellsOf(world, id)).cells['U12']).toBeUndefined();
    expect(out.written).toBeGreaterThan(0);
  });

  test('список колонок со списком: незаполненные по позициям возвращаются явно', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [
          item([name('Кепка'), { column: 'Срок изготовления, недели', value: 2 }]),
        ],
      },
      world.deps,
      world.ctx,
    );
    const missing = out.missingListValues[0];
    expect(missing).toMatchObject({ row: 12, position: 'Кепка' });
    const names = missing?.columns.map((column) => column.column) ?? [];
    expect(names).toEqual([
      'Упаковка (подарочная)',
      'Направления',
      'по цене',
    ]);
    expect(missing?.columns[2]?.options.length).toBeGreaterThan(0);
  });

  test('полностью заполненная позиция не попадает в missingListValues', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item(full('Кепка'))] },
      world.deps,
      world.ctx,
    );
    expect(out.missingListValues).toEqual([]);
  });
});

describe('менеджер, дата, месяц загрузки, оператор', () => {
  test('AD - имя из личности, AE - текущая дата числом-датой, AF и AI пустые', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item(full('Кепка'))] },
      world.deps,
      world.ctx,
    );
    const { cells } = await cellsOf(world, id);
    expect(cells['AD12']).toBe('Иван Тестов');
    expect(cells['AE12']).toBe('2026-11-02');
    expect(cells['AF12']).toBeUndefined();
    expect(cells['AI12']).toBeUndefined();
    expect(out.stamped).toMatchObject({ managerName: 'Иван Тестов', date: '2026-11-02' });
  });

  test('автополя не затирают чужое даже при overwrite, свою запись обновляют', async () => {
    const world = await buildTemplateWorld();
    const foreign = { ...EXAMPLE_CELLS, AD14: 'Чужой Менеджер' };
    world.setChatFile('мой.xlsx', buildBook({ cells: foreign }));
    const id = (await openChatTemplate.execute({}, world.deps, world.ctx)).workbookId ?? '';
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        overwrite: true,
        requestedByEmployee: true,
        requestQuote: 'перезапиши название',
        items: [item([name('Кепка')], 14)],
      },
      world.deps,
      world.ctx,
    );
    const { cells } = await cellsOf(world, id);
    expect(cells['AD14']).toBe('Чужой Менеджер');
    expect(cells['AE14']).toBe('2026-11-02');
    expect(out.stamped.notStamped).toEqual([
      expect.objectContaining({ row: 14, reason: 'cell_not_empty' }),
    ]);
    expect(out.overwrittenCells).not.toContain('AD14');
  });

  test('явный менеджер отклонён - в notStamped есть пометка', async () => {
    const world = await buildTemplateWorld();
    const foreign = { ...EXAMPLE_CELLS, AD14: 'Чужой Менеджер' };
    world.setChatFile('мой.xlsx', buildBook({ cells: foreign }));
    const id = (await openChatTemplate.execute({}, world.deps, world.ctx)).workbookId ?? '';
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        requestQuote: 'менеджер Пётр Иванов',
        items: [item([name('Кепка'), { column: 'Менеджер', value: 'Пётр Иванов' }], 14)],
      },
      world.deps,
      world.ctx,
    );
    expect(out.skipped.find((entry) => entry.reason === 'cell_not_empty')).toBeDefined();
    expect(out.stamped.notStamped).toEqual([
      expect.objectContaining({ row: 14, reason: 'explicit_value_rejected' }),
    ]);
  });

  test('имя из текста модели не принимается; неизвестная личность - предупреждение', async () => {
    const world = await buildTemplateWorld({ identity: null });
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [item([...full('Кепка'), { column: 'Менеджер', value: 'Пётр Выдуманный' }])],
      },
      world.deps,
      world.ctx,
    );
    const { cells } = await cellsOf(world, id);
    expect(cells['AD12']).toBeUndefined();
    expect(cells['AE12']).toBe('2026-11-02');
    expect(out.skipped.some((skip) => skip.reason === 'set_by_code')).toBe(true);
    expect(out.askEmployee).toEqual([]);
    expect(out.warnings.join(' ')).toContain('Менеджер не проставлен');
    expect(out.stamped.notStamped.some((entry) => entry.reason === 'value_unknown')).toBe(true);
  });

  test('AF не заполняется по умолчанию, но пишется по явной просьбе с цитатой', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const afCell = [{ column: 'месяц первичной загрузки', value: 'ноябрь 2026' }];
    const refused = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item([...full('Кепка'), ...afCell])] },
      world.deps,
      world.ctx,
    );
    expect(refused.skipped[0]).toMatchObject({ reason: 'not_filled_by_rule' });
    const allowed = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        requestQuote: 'проставь месяц первичной загрузки: ноябрь 2026',
        items: [item(afCell, 12)],
      },
      world.deps,
      world.ctx,
    );
    expect(allowed.skippedTotal).toBe(0);
    expect((await cellsOf(world, id)).cells['AF12']).toBe('ноябрь 2026');
  });

  test('Оператор и строки 1-11 защищены даже при всех флагах', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        requestQuote: 'впиши оператора и поправь шапку',
        confirmedByEmployee: true,
        overwrite: true,
        items: [
          item([{ column: 'Оператор', value: 'Иванов' }], 12),
          item([{ column: 'Название', value: 'Другая шапка' }], 11),
          item([{ column: 'Название', value: 'Пояснение' }], 1),
        ],
      },
      world.deps,
      world.ctx,
    );
    expect(out.skipped.map((skip) => skip.reason)).toEqual([
      'protected_area',
      'protected_area',
      'protected_area',
    ]);
    expect(out.written).toBe(0);
    const { cells } = await cellsOf(world, id);
    expect(cells['AI12']).toBeUndefined();
    expect(cells['H11']).toBe('Название');
    expect(cells['A1']).toBe('Пояснение к шаблону');
  });
});

describe('нежёлтые колонки и листы 2-4', () => {
  test('нежёлтая колонка отклоняется, с просьбой и цитатой - пишется из списка файла', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const cells = [{ column: 'Раздел', value: 'раздел b' }];
    const refused = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item([...full('Кепка'), ...cells])] },
      world.deps,
      world.ctx,
    );
    expect(refused.skipped[0]).toMatchObject({ reason: 'not_yellow_column' });
    const noQuote = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        items: [item(cells, 12)],
      },
      world.deps,
      world.ctx,
    );
    expect(noQuote.skipped[0]?.reason).toBe('not_yellow_column');
    expect(noQuote.warnings.join(' ')).toContain('requestQuote');
    const ok = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        requestQuote: 'укажи раздел Раздел B',
        items: [item(cells, 12)],
      },
      world.deps,
      world.ctx,
    );
    expect(ok.skippedTotal).toBe(0);
    expect((await cellsOf(world, id)).cells['A12']).toBe('Раздел B');
    const bad = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        requestQuote: 'укажи раздел Мебель',
        items: [item([{ column: 'Раздел', value: 'Мебель' }], 12)],
      },
      world.deps,
      world.ctx,
    );
    // Значение назвал сотрудник (цитата): пишется как есть, сайт-риск идёт предупреждением.
    expect(bad.skippedTotal).toBe(0);
    expect((await cellsOf(world, id)).cells['A12']).toBe('Мебель');
    expect(bad.warnings.join(' ')).toContain('нет в списке файла');
  });

  test('листы 2-4: нужны просьба и подтверждение, лист и число листов не меняются', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const cell = [{ column: 'C', value: 'Новая категория' }];
    const args = { ...base, workbookId: id, sheet: SHEET_CONTENT, items: [item(cell, 5)] };
    const none = await fillTemplateRows.execute(args, world.deps, world.ctx);
    expect(none.skipped[0]?.reason).toBe('other_sheet_needs_confirmation');
    const halfway = await fillTemplateRows.execute(
      { ...args, requestedByEmployee: true, requestQuote: 'добавь категорию' },
      world.deps,
      world.ctx,
    );
    expect(halfway.skipped[0]?.reason).toBe('other_sheet_needs_confirmation');
    expect(halfway.skipped[0]?.message).toContain('сайт может не принять');
    const ok = await fillTemplateRows.execute(
      { ...args, requestedByEmployee: true, requestQuote: 'добавь категорию', ...confirmed },
      world.deps,
      world.ctx,
    );
    expect(ok.written).toBe(1);
    const after = await cellsOf(world, id, SHEET_CONTENT);
    expect(after.cells['C5']).toBe('Новая категория');
    expect(after.sheets.length).toBe(4);
    expect(ok.stamped.managerName).toBeUndefined();
  });
});

describe('присланный файл дополняется, чужое не затирается', () => {
  async function opened(world: TemplateWorld): Promise<string> {
    world.setChatFile('мой.xlsx', buildBook({ cells: EXAMPLE_CELLS }));
    const out = await openChatTemplate.execute({}, world.deps, world.ctx);
    return out.workbookId ?? '';
  }

  test('новая позиция идёт с первой свободной строки, примеры остаются', async () => {
    const world = await buildTemplateWorld();
    const id = await opened(world);
    const out = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item(full('Кепка', 'K-1'))] },
      world.deps,
      world.ctx,
    );
    expect(out.rows[0]?.row).toBe(14);
    const { cells } = await cellsOf(world, id);
    expect(cells['H12']).toBe('Пример изделия');
    expect(cells['H14']).toBe('Кепка');
  });

  test('чужая непустая ячейка не затирается; с overwrite и просьбой - заменяется', async () => {
    const world = await buildTemplateWorld();
    const id = await opened(world);
    const target = item([{ column: 'Название', value: 'Подмена' }], 12);
    const refused = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [target] },
      world.deps,
      world.ctx,
    );
    expect(refused.skipped[0]).toMatchObject({ reason: 'cell_not_empty' });
    expect(refused.skipped[0]?.message).toContain('Пример изделия');
    expect(refused.written).toBe(0);
    expect((await cellsOf(world, id)).cells['H12']).toBe('Пример изделия');
    const forced = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        overwrite: true,
        requestedByEmployee: true,
        requestQuote: 'замени название в строке 12',
        items: [target],
      },
      world.deps,
      world.ctx,
    );
    expect(forced.overwrittenCells).toContain('H12');
    expect((await cellsOf(world, id)).cells['H12']).toBe('Подмена');
  });

  test('свою запись можно исправить без флага перезаписи', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const first = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item(full('Кепка'))] },
      world.deps,
      world.ctx,
    );
    const row = first.rows[0]?.row ?? 0;
    const fix = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item([name('Кепка синяя')], row)] },
      world.deps,
      world.ctx,
    );
    expect(fix.skippedTotal).toBe(0);
    expect((await cellsOf(world, id)).cells['H12']).toBe('Кепка синяя');
    expect(fix.revision).toBe(2);
  });

  test('повтор позиции без row не плодит дубль', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const request = { ...base, workbookId: id, items: [item(full('Кепка', 'K-1'))] };
    const first = await fillTemplateRows.execute(request, world.deps, world.ctx);
    const again = await fillTemplateRows.execute(request, world.deps, world.ctx);
    expect(first.written).toBeGreaterThan(0);
    expect(again.written).toBe(0);
    expect(again.skipped[0]).toMatchObject({ reason: 'already_written', row: first.rows[0]?.row });
    expect(again.nextFreeRow).toBeUndefined();
  });

  test('книга изменилась между чтением и сохранением - понятная ошибка', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const real = world.deps.workbook.writeCells.bind(world.deps.workbook);
    // Другой вызов успевает сохранить книгу, пока наш ждёт ответа сервиса документов.
    world.deps.workbook.writeCells = async (request) => {
      const result = await real(request);
      const current = await loadWorkbook(world.deps, id);
      await saveWorkbook(world.deps, id, {
        ...current.record,
        bytes: current.bytes,
        revision: current.record.revision + 1,
      });
      return result;
    };
    await expect(
      fillTemplateRows.execute(
        { ...base, workbookId: id, items: [item(full('Кепка'))] },
        world.deps,
        world.ctx,
      ),
    ).rejects.toThrow('другой вызов');
  });

  test('колонка не найдена и неоднозначное имя не записываются', async () => {
    const world = await buildTemplateWorld();
    const id = await cleanBook(world);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        items: [item([{ column: 'Цвет', value: 'красный' }, { column: 'Оп', value: 'x' }])],
      },
      world.deps,
      world.ctx,
    );
    const reasons = out.skipped.map((skip) => skip.reason);
    expect(reasons).toEqual(['column_not_found', 'column_ambiguous']);
    expect(out.written).toBe(0);
  });
});
