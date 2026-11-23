import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import { loadFollowup } from '../../src/price-edit-followup';
import { editPriceInFile } from '../../src/price-edit-direct';
import {
  configureTurnFileBuffer,
  createTurnFileStore,
  flushTurnFiles,
  resetTurnFileBufferForTests,
  runInTurnFileStore,
  turnFileChat,
} from '../../src/turn-file-buffer';
import { MemoryPriceFileEditor } from '../../src/kit/adapters/memory/price-file-editor';
import type { EditPricesRequest, EditedPriceFile } from '../../src/kit/ports/price-file-editor';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Два вызова правки одного файла за один ход (случай «два файла с одним именем, первый без
 * слайда 19»): сотруднику должен уйти итоговый файл со всеми правками хода, а повторная
 * отправка - с новым именем и пометкой «обновлённая версия».
 */

const PPTX_NAME = 'Прайс_спецпредложение.pptx';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Номер следующего хода сотрудника в том же треде. */
const NEXT_TURN = 2;
/** Сколько правок в полном наборе (слайды 2, 11 и 19). */
const FULL_EDITS = 3;
/** Пометка новой версии в имени файла. */
const UPDATED_MARK = 'обновлённая_версия';

const SLIDE_2 = [
  ['Позиция', 'Цена'],
  ['Болт М8', '680'],
];
const SLIDE_11 = [
  ['Позиция', 'Цена'],
  ['Саморез', '640'],
];
const SLIDE_19 = [
  ['Позиция', 'Цена'],
  ['Анкер', '90'],
];
const TABLES = [SLIDE_2, SLIDE_11, SLIDE_19];
const TEXT = [
  '## Слайд 2: Крепёж',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Болт М8 | 680 |',
  '',
  '## Слайд 11: Метизы',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Саморез | 640 |',
  '',
  '## Слайд 19: Анкеры',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Анкер | 90 |',
].join('\n');

const EDIT_2 = { oldPrice: 680, newPrice: 700, slide: 2 };
const EDIT_11 = { oldPrice: 640, newPrice: 650, slide: 11 };
const EDIT_19 = { oldPrice: 90, newPrice: 95, slide: 19 };

function parsedDeck(): ParsedDocument {
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

/** Имена файлов, отправленных в чат, по порядку. */
function sentNames(): string[] {
  return deps.chat.outbox.flatMap((item) => (item.file === undefined ? [] : [item.file.name]));
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-turn', EMPLOYEE_THREAD);
  editor = new RecordingEditor();
  const parser: DocumentParser = { parse: async () => parsedDeck() };
  deps = { ...deps, parser, priceFileEditor: editor };
  const stored = await deps.intake.put(
    EMPLOYEE_THREAD,
    PPTX_NAME,
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  );
  path = stored.path;
});

describe('две правки одного файла за один ход', () => {
  test('первый файл без слайда 19, второй полный: имена разные, второй помечен', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, deps, ctx);
    const second = await editPriceInFile.execute(
      { path, edits: [EDIT_2, EDIT_11, EDIT_19] },
      deps,
      ctx,
    );
    const [first, last] = sentNames();
    expect(sentNames()).toHaveLength(2);
    expect(last).not.toBe(first);
    expect(first).toBe('Прайс_спецпредложение_новые_цены_01.01.2026.pptx');
    expect(last).toContain(UPDATED_MARK);
    expect(last?.endsWith('.pptx')).toBe(true);
    expect(second.fileName).toBe(last);
    expect(second.message).toContain('ОБНОВЛЁННАЯ ВЕРСИЯ');
    expect(second.changes).toHaveLength(FULL_EDITS);
  });

  test('второй вызов с недостающей правкой: файл собран со всеми правками хода', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, deps, ctx);
    const second = await editPriceInFile.execute({ path, edits: [EDIT_19] }, deps, ctx);
    expect(editor.requests[1]?.edits).toHaveLength(FULL_EDITS);
    expect(second.changes.map((change) => change.place)).toEqual([
      'Слайд 2',
      'Слайд 11',
      'Слайд 19',
    ]);
    // ожидание ответа про базу описывает итоговый файл целиком
    const followup = await loadFollowup(deps.state, EMPLOYEE_THREAD, deps.clock.now());
    expect(followup?.changes).toHaveLength(FULL_EDITS);
    expect(followup?.resultName).toBe(second.fileName ?? '');
  });

  test('та же ячейка правится второй раз: действует последняя цена', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    await editPriceInFile.execute(
      { path, edits: [{ oldPrice: 680, newPrice: 710, slide: 2 }] },
      deps,
      ctx,
    );
    expect(editor.requests[1]?.edits).toEqual([
      { table: 0, row: 1, col: 1, value: 710, expected: 680 },
    ]);
  });

  test('третья отправка получает собственный номер версии', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    await editPriceInFile.execute({ path, edits: [EDIT_11] }, deps, ctx);
    await editPriceInFile.execute({ path, edits: [EDIT_19] }, deps, ctx);
    const names = sentNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names[2]).toContain(`${UPDATED_MARK}_2`);
  });

  test('параллельные вызовы одного хода идут по очереди: итоговый файл полный', async () => {
    await Promise.all([
      editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, deps, ctx),
      editPriceInFile.execute({ path, edits: [EDIT_19] }, deps, ctx),
    ]);
    const names = sentNames();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(editor.requests[1]?.edits).toHaveLength(FULL_EDITS);
  });
});

describe('одна правка и другие случаи остаются прежними', () => {
  test('одна правка за ход: прежнее имя, сообщение без пометки версии', async () => {
    const out = await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    expect(sentNames()).toEqual(['Прайс_спецпредложение_новые_цены_01.01.2026.pptx']);
    expect(out.message).not.toContain('ОБНОВЛЁННАЯ');
    expect(editor.requests[0]?.edits).toHaveLength(1);
  });

  test('повтор того же вызова (после сбоя): имя прежнее, не «обновлённая версия»', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    const again = await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    expect(again.fileName).toBe('Прайс_спецпредложение_новые_цены_01.01.2026.pptx');
    expect(again.message).not.toContain('ОБНОВЛЁННАЯ');
  });

  test('следующий ход: имя прежнее, правки прошлого хода не переносятся', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, deps, ctx);
    const next = await editPriceInFile.execute(
      { path, edits: [EDIT_19] },
      deps,
      { ...ctx, turnNumber: NEXT_TURN },
    );
    expect(editor.requests[1]?.edits).toHaveLength(1);
    expect(next.fileName).not.toContain(UPDATED_MARK);
  });

  test('другой файл в том же ходе: правки и пометка не переносятся', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, deps, ctx);
    const other = await deps.intake.put(
      EMPLOYEE_THREAD,
      'Другой_прайс.pptx',
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 0, 0, 0]),
    );
    const out = await editPriceInFile.execute({ path: other.path, edits: [EDIT_19] }, deps, ctx);
    expect(editor.requests[1]?.edits).toHaveLength(1);
    expect(out.fileName).not.toContain(UPDATED_MARK);
  });
});

describe('отправка одним файлом в конце хода (этап 9u)', () => {
  /** Прежние имена не нужны: файл один, имя без пометки версии. */
  const BASE_NAME = 'Прайс_спецпредложение_новые_цены_01.01.2026.pptx';
  /** Слова, которых нет в ответе инструмента: файл ещё не отправлен, «заново» не было. */
  const FORBIDDEN_WORDS = ['заново', 'ОБНОВЛЁННАЯ', 'копию', 'отправлен без подписи'];

  beforeEach(() => {
    configureTurnFileBuffer({ enabled: true });
  });

  afterEach(() => {
    resetTurnFileBufferForTests();
  });

  test('две правки хода: одно имя без пометки, второй вызов несёт все правки', async () => {
    const first = await editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, deps, ctx);
    const second = await editPriceInFile.execute({ path, edits: [EDIT_19] }, deps, ctx);
    expect(sentNames()).toEqual([BASE_NAME, BASE_NAME]);
    expect(first.fileName).toBe(BASE_NAME);
    expect(second.fileName).toBe(BASE_NAME);
    expect(second.changes).toHaveLength(FULL_EDITS);
    expect(editor.requests[1]?.edits).toHaveLength(FULL_EDITS);
    expect(second.status).toBe('sent');
    expect(second.delivered).toBe(true);
  });

  test('ответ инструмента: файл уйдёт одним в конце хода, без «заново» и имён файлов', async () => {
    const out = await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    const again = await editPriceInFile.execute({ path, edits: [EDIT_11] }, deps, ctx);
    for (const message of [out.message, again.message]) {
      expect(message).toContain('ОДНИМ файлом в конце хода');
      for (const word of FORBIDDEN_WORDS) expect(message).not.toContain(word);
      expect(message).not.toContain('.pptx');
    }
  });

  test('через настоящую обёртку канала: за ход уходит один файл со всеми правками', async () => {
    const memoryChat = deps.chat;
    const buffered = { ...deps, chat: turnFileChat(memoryChat) };
    const store = createTurnFileStore();
    await runInTurnFileStore(store, async () => {
      await editPriceInFile.execute({ path, edits: [EDIT_2, EDIT_11] }, buffered, ctx);
      await editPriceInFile.execute({ path, edits: [EDIT_19] }, buffered, ctx);
      expect(memoryChat.outbox.filter((item) => item.file !== undefined)).toHaveLength(0);
    });
    await flushTurnFiles(store, 'ok');
    const files = memoryChat.outbox.flatMap((item) => (item.file === undefined ? [] : [item.file]));
    expect(files.map((file) => file.name)).toEqual([BASE_NAME]);
  });

  test('повтор того же вызова: то же имя, правки хода не дублируются', async () => {
    await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    const again = await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    expect(again.fileName).toBe(BASE_NAME);
    expect(editor.requests[1]?.edits).toHaveLength(1);
  });
});

describe('при выключенной отправке одним файлом имена прежние', () => {
  test('вторая отправка хода по-прежнему с пометкой версии', async () => {
    resetTurnFileBufferForTests();
    await editPriceInFile.execute({ path, edits: [EDIT_2] }, deps, ctx);
    const second = await editPriceInFile.execute({ path, edits: [EDIT_11] }, deps, ctx);
    expect(second.fileName).toContain(UPDATED_MARK);
    expect(second.message).toContain('ОБНОВЛЁННАЯ ВЕРСИЯ');
  });
});
