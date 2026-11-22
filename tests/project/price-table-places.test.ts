import { beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import type { PriceSource } from '../../src/agents/prices/price-sources';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import type { DocxLayout, DocxLayoutClient } from '../../src/docx-pages-client';
import { PRICE_EDIT_FIRST_PROMPT } from '../../src/price-edit-prompt';
import {
  NO_LABEL,
  PAGES_UNKNOWN_NOTE,
  headingNames,
  labelTables,
  resetLayoutCache,
  tablePagesNote,
  textWithPages,
} from '../../src/price-table-places';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Место таблицы для агента прайсов (этап 9p): слайд, страница, лист, страница docx по раскладке;
 * не определилось - метки нет, номер не выдумывается.
 */

const TABLE = [
  ['Позиция', 'Цена'],
  ['Болт', '10'],
];

function parsed(overrides: Partial<ParsedDocument>): ParsedDocument {
  return {
    text: '',
    tables: [],
    needsOcr: false,
    hasHiddenContent: false,
    hiddenSheets: [],
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

function source(name: string): PriceSource {
  return {
    path: `chat/${name}`,
    name,
    hash: `hash-${name}`,
    kind: 'intake',
    read: async () => new Uint8Array([1, 2, 3]),
    meta: { source: 'intake', notes: [] },
  };
}

const PPTX_TEXT = [
  '## Слайд 1: Титул',
  '',
  '## Слайд 4: Метизы',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Болт | 10 |',
  '',
  '## Слайд 7 [hidden]',
  '',
  '| Позиция | Цена |',
  '| --- | --- |',
  '| Гайка | 5 |',
].join('\n');

let deps: FullPricesDeps;
let ctx: ToolContext;
beforeEach(async () => {
  resetLayoutCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-places', EMPLOYEE_THREAD);
});

/** Раскладка docx: таблица со словами «Болт» на странице 3. */
function layoutClient(calls: string[] = []): DocxLayoutClient {
  const layout: DocxLayout = {
    pageCount: 3,
    truncated: false,
    pages: [
      { number: 1, text: 'Договор поставки. Предмет договора.' },
      { number: 2, text: 'Права и обязанности сторон.' },
      { number: 3, text: 'Приложение 1. Позиция Цена Болт 10 Гайка 5' },
    ],
  };
  return {
    pages: async (file) => {
      calls.push(file.name);
      return layout;
    },
  };
}

describe('метки таблиц', () => {
  test('pptx: слайды из заголовков разбора, скрытые тоже', async () => {
    const labels = await labelTables(
      deps,
      source('deck.pptx'),
      parsed({ text: PPTX_TEXT, tables: [TABLE, TABLE] }),
    );
    expect(labels.map((label) => label.text)).toEqual(['Слайд 4', 'Слайд 7']);
    expect(labels[0]).toMatchObject({ kind: 'slide', number: 4 });
  });

  test('число таблиц не сошлось с заголовками - меток нет, а не сдвиг', async () => {
    const labels = await labelTables(
      deps,
      source('deck.pptx'),
      parsed({ text: PPTX_TEXT, tables: [TABLE] }),
    );
    expect(labels).toEqual([NO_LABEL]);
  });

  test('pdf: страница из заголовков', async () => {
    const text = '## Страница 1\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## Страница 2\n\ntext';
    const labels = await labelTables(
      deps,
      source('price.pdf'),
      parsed({ text, tables: [TABLE] }),
    );
    expect(labels[0]).toMatchObject({ kind: 'page', number: 1, text: 'Страница 1' });
  });

  test('xlsx: название листа', async () => {
    const labels = await labelTables(
      deps,
      source('book.xlsx'),
      parsed({ tables: [TABLE, TABLE], tableNames: ['Прайс', ''] }),
    );
    expect(labels[0]).toMatchObject({ kind: 'sheet', name: 'Прайс', text: 'Лист «Прайс»' });
    expect(labels[1]).toEqual(NO_LABEL);
  });

  test('docx без сервиса раскладки: страница не определена', async () => {
    const doc = parsed({ tables: [TABLE], text: 'Приложение 1\n\nтаблица' });
    const labels = await labelTables(deps, source('Договор.docx'), doc);
    expect(labels).toEqual([NO_LABEL]);
    expect(tablePagesNote(source('Договор.docx'), labels)).toBe(PAGES_UNKNOWN_NOTE);
    // не docx пометку «страница не определена» не получает
    expect(tablePagesNote(source('deck.pptx'), [NO_LABEL])).toBeUndefined();
  });

  test('docx с раскладкой: страница таблицы по её тексту', async () => {
    const calls: string[] = [];
    const withLayout = { ...deps, docxLayout: layoutClient(calls) };
    const doc = parsed({ tables: [TABLE], text: 'Приложение 1\n\ntable' });
    const labels = await labelTables(withLayout, source('Договор.docx'), doc);
    expect(labels[0]).toMatchObject({ kind: 'page', number: 3, text: 'Страница 3' });
    // повторный вызов по тому же файлу раскладку не запрашивает снова
    await labelTables(withLayout, source('Договор.docx'), doc);
    expect(calls).toHaveLength(1);
  });

  test('сбой сервиса раскладки не ломает чтение: страница не определена', async () => {
    const broken: DocxLayoutClient = { pages: async () => Promise.reject(new Error('boom')) };
    const labels = await labelTables(
      { ...deps, docxLayout: broken },
      source('Договор.docx'),
      parsed({ tables: [TABLE] }),
    );
    expect(labels).toEqual([NO_LABEL]);
  });

  test('названия для заголовков: лист, иначе место', () => {
    const doc = parsed({ tables: [TABLE, TABLE], tableNames: ['Прайс', ''] });
    const names = headingNames(doc, [NO_LABEL, { kind: 'slide', number: 2, text: 'Слайд 2' }]);
    expect(names).toEqual(['Прайс', 'Слайд 2']);
  });
});

describe('текст docx с маркерами страниц', () => {
  test('не docx - текст без изменений и без пометки', async () => {
    expect(await textWithPages(deps, source('deck.pptx'), 'текст')).toEqual({
      text: 'текст',
      pagesKnown: false,
    });
  });

  test('docx без раскладки - пометка «страница не определена»', async () => {
    const result = await textWithPages(deps, source('Договор.docx'), 'текст');
    expect(result.pagesKnown).toBe(false);
    expect(result.note).toBe(PAGES_UNKNOWN_NOTE);
    expect(result.text).toBe('текст');
  });
});

describe('readPriceFile показывает место', () => {
  async function read(name: string, document: ParsedDocument): Promise<
    Awaited<ReturnType<typeof readPriceFile.execute>>
  > {
    const parser: DocumentParser = { parse: async () => document };
    const stored = await deps.intake.put(
      EMPLOYEE_THREAD,
      name,
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    );
    return readPriceFile.execute({ path: stored.path }, { ...deps, parser }, ctx);
  }

  test('pptx: в заголовке таблицы стоит слайд, места в tablePlaces', async () => {
    const out = await read('deck.pptx', parsed({ text: PPTX_TEXT, tables: [TABLE, TABLE] }));
    expect(out.tablePlaces).toEqual(['Слайд 4', 'Слайд 7']);
    expect(out.markdown).toContain('«Слайд 4»');
    expect(out.markdown).toContain('«Слайд 7»');
  });

  test('xlsx: в заголовке лист, как раньше', async () => {
    const out = await read('book.xlsx', parsed({ tables: [TABLE], tableNames: ['Прайс'] }));
    expect(out.markdown).toContain('«Прайс»');
    expect(out.tablePlaces).toEqual(['Лист «Прайс»']);
  });

  test('docx без раскладки: pagesNote «страница не определена»', async () => {
    const out = await read('Договор.docx', parsed({ tables: [TABLE] }));
    expect(out.pagesNote).toBe(PAGES_UNKNOWN_NOTE);
  });
});

describe('декларация агента прайсов за флагом', () => {
  const base = { model: 'm' };

  test('без флага инструментов и абзаца нет: прежний агент', () => {
    const off = createPricesAgent(base);
    expect(off.prompt).not.toContain(PRICE_EDIT_FIRST_PROMPT.trim().slice(0, 40));
    expect(off.tools.map((tool) => tool.name)).not.toContain('editPriceInFile');
  });

  test('с флагом: правка сразу, ожидание и закрытие, абзац промпта', () => {
    const on = createPricesAgent({ ...base, priceEditFirst: true });
    const names = on.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['editPriceInFile', 'getPendingPriceEdit', 'closePendingPriceEdit']),
    );
    expect(on.prompt).toContain(PRICE_EDIT_FIRST_PROMPT.trim().slice(0, 40));
    // старый путь правки остаётся
    expect(names).toContain('editPricesInSourceFile');
  });

  test('промпт: правка без вопроса о поставщике, база только после «да»', () => {
    expect(PRICE_EDIT_FIRST_PROMPT).toContain('не спрашивай поставщика до правки');
    expect(PRICE_EDIT_FIRST_PROMPT).toContain('пока сотрудник явно не сказал «да»');
    expect(PRICE_EDIT_FIRST_PROMPT).toContain('status=ambiguous');
  });
});
