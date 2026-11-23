import { describe, expect, test } from 'bun:test';
import { loadWorkbook } from '../../src/agents/site-export/template-store';
import { openChatTemplate } from '../../src/agents/site-export/open-chat-template';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import { readEmployeeIdentity } from '../../src/agents/site-export/read-employee-identity';
import { readTemplateStructure } from '../../src/agents/site-export/read-template-structure';
import {
  COLUMNS,
  EXAMPLE_CELLS,
  PRICE_LIST,
  buildBook,
  buildTemplateWorld,
} from './site-template-support';

/** Рабочие книги шаблона: чистая копия с диска, присланный файл, структура, личность. */

describe('prepareCleanTemplate', () => {
  test('копия с диска очищена от примеров, шапка и строки выше целы, диск не тронут', async () => {
    const world = await buildTemplateWorld();
    const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    expect(out.status).toBe('ok');
    expect(out.clearedCells).toBe(Object.keys(EXAMPLE_CELLS).length);
    expect(out.summary?.firstFreeRow).toBe(12);
    expect(out.summary?.headersMissing).toBe(false);
    const loaded = await loadWorkbook(world.deps, out.workbookId ?? '');
    const inspected = await world.deps.workbook.inspect({ bytes: loaded.bytes });
    expect(inspected.exampleRows).toEqual([]);
    expect(inspected.aboveRows.length).toBeGreaterThan(0);
    // Исходный файл на диске остался с примерами.
    const onDisk = await world.deps.workbook.inspect({
      bytes: await world.disk.read('Сайт/шаблон.xlsx'),
    });
    expect(onDisk.exampleRows.length).toBeGreaterThan(0);
    // Байты модели не отдаются.
    expect(JSON.stringify(out)).not.toContain('base64');
  });

  test('жёлтые колонки в сводке определены по заливке', async () => {
    const world = await buildTemplateWorld();
    const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const yellow = COLUMNS.filter((column) => column.yellow).length;
    expect(out.summary?.yellowColumns.length).toBe(yellow);
    expect(out.summary?.yellowColumns.join('|')).not.toContain('Оператор');
  });

  test('нет шаблона на диске: template_not_found с просьбой прислать', async () => {
    const world = await buildTemplateWorld({ diskBytes: null });
    const out = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    expect(out.status).toBe('template_not_found');
    expect(out.message).toContain('прислать');
    expect(out.workbookId).toBeUndefined();
  });

  test('не сотрудник в чате - отказ', async () => {
    const world = await buildTemplateWorld();
    const plan = { ...world.ctx, initiator: { kind: 'scheduler' } } as typeof world.ctx;
    await expect(prepareCleanTemplate.execute({}, world.deps, plan)).rejects.toThrow();
  });
});

describe('openChatTemplate', () => {
  test('присланный файл НЕ очищается: примеры остаются', async () => {
    const world = await buildTemplateWorld();
    world.setChatFile('мой.xlsx', buildBook({ cells: EXAMPLE_CELLS }));
    const out = await openChatTemplate.execute({}, world.deps, world.ctx);
    expect(out.status).toBe('ok');
    expect(out.fileName).toBe('мой.xlsx');
    expect(out.summary?.firstFreeRow).toBe(14);
    const loaded = await loadWorkbook(world.deps, out.workbookId ?? '');
    expect(loaded.record.source).toBe('chat_file');
    expect(world.deps.workbook.calls.clear).toBe(0);
  });

  test('нет файла в чате: not_found; не xlsx: not_xlsx', async () => {
    const world = await buildTemplateWorld();
    expect((await openChatTemplate.execute({}, world.deps, world.ctx)).status).toBe('not_found');
    world.setChatFile('a.xlsx', new Uint8Array([1, 2, 3]));
    const broken = await openChatTemplate.execute({}, world.deps, world.ctx);
    expect(broken.status).toBe('not_xlsx');
    world.deps.botFiles.remember('orders/2002', { botId: 1, fileId: 8, name: 'b.xlsx' });
    // Два файла больше не вопрос до результата (этап 177): берётся последний, см.
    // site-s177-warnings.test.ts.
    const two = await openChatTemplate.execute({}, world.deps, world.ctx);
    expect(two.status).not.toBe('ambiguous');
  });
});

describe('readTemplateStructure', () => {
  test('колонки, роли, короткие списки целиком, первая свободная строка', async () => {
    const world = await buildTemplateWorld();
    const prepared = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const out = await readTemplateStructure.execute(
      { workbookId: prepared.workbookId ?? '', includeExamples: true },
      world.deps,
      world.ctx,
    );
    const byLetter = new Map(out.columns.map((column) => [column.letter, column]));
    expect(byLetter.get('Y')?.allowedValues).toEqual(PRICE_LIST);
    expect(byLetter.get('AI')?.role).toBe('operator');
    expect(byLetter.get('AF')?.role).toBe('first_load');
    expect(byLetter.get('AD')?.role).toBe('manager');
    expect(byLetter.get('A')?.yellow).toBe(false);
    expect(out.firstFreeRow).toBe(12);
    expect(out.nameColumn).toBe('H');
    expect(out.aboveRows?.length).toBeGreaterThan(0);
    expect(out.sheets.length).toBe(4);
  });

  test('длинный список сокращается, поиск по подстроке находит значение', async () => {
    const world = await buildTemplateWorld();
    const many = Array.from({ length: 120 }, (_, index) => `Категория ${index + 1}`);
    const columns = COLUMNS.map((column) =>
      column.letter === 'V' ? { ...column, list: many } : column,
    );
    const id = await openWith(world, buildBook({ columns }));
    const short = await readTemplateStructure.execute({ workbookId: id }, world.deps, world.ctx);
    const column = short.columns.find((item) => item.letter === 'V');
    expect(column?.listSize).toBe(120);
    expect(column?.listShownPartly).toBe(true);
    expect(column?.allowedValues?.length).toBeLessThan(120);
    const found = await readTemplateStructure.execute(
      { workbookId: id, listColumn: 'Направления', listFilter: 'категория 77' },
      world.deps,
      world.ctx,
    );
    expect(found.listSearch).toMatchObject({ total: 120, matched: 1, values: ['Категория 77'] });
    const bad = await readTemplateStructure.execute(
      { workbookId: id, listColumn: 'нет такой' },
      world.deps,
      world.ctx,
    );
    expect(bad.listColumnProblem).toContain('нет');
  });

  test('неизвестный workbookId - понятный отказ', async () => {
    const world = await buildTemplateWorld();
    await expect(
      readTemplateStructure.execute({ workbookId: 'wb-none' }, world.deps, world.ctx),
    ).rejects.toThrow('workbookId');
  });
});

describe('readEmployeeIdentity', () => {
  test('известный сотрудник и неизвестный', async () => {
    const world = await buildTemplateWorld();
    expect(await readEmployeeIdentity.execute({}, world.deps, world.ctx)).toEqual({
      status: 'known',
      fullName: 'Иван Тестов',
    });
    const noName = await buildTemplateWorld({ identity: null });
    expect(await readEmployeeIdentity.execute({}, noName.deps, noName.ctx)).toEqual({
      status: 'unknown',
      reason: 'not_in_directory',
    });
  });
});

/** Положить книгу как присланный файл и открыть её. */
async function openWith(
  world: Awaited<ReturnType<typeof buildTemplateWorld>>,
  bytes: Uint8Array,
): Promise<string> {
  world.setChatFile('x.xlsx', bytes);
  const out = await openChatTemplate.execute({}, world.deps, world.ctx);
  return out.workbookId ?? '';
}

