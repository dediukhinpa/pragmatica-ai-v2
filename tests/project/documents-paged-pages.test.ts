import { beforeEach, describe, expect, test } from 'bun:test';
import {
  PAGE_UNKNOWN_NOTE,
  pagedReadCache,
  readChatAttachmentsPaged,
  type PagedReaderHost,
} from '../../src/documents-paged-reader';
import type { DocxLayout, DocxLayoutClient } from '../../src/docx-pages-client';
import { buildPagedRig } from './support-paged-reader';

/**
 * Номера страниц docx в чтении файла агентом «Подготовка документов» (этап 9p): маркер `[стр. N]`
 * по фактической раскладке; не определилось - пометка «страница не определена», без выдумывания.
 */

const PAGE_1 = 'ДОГОВОР ПОСТАВКИ № 7 (синтетический). Предмет договора.';
const PAGE_2 = 'Права и обязанности сторон. Поставщик передаёт товар.';
const PAGE_3 = 'Ответственность сторон. Подписи сторон.';
/** Текст файла: абзацы подряд, как после разбора. */
const TEXT = [PAGE_1, PAGE_2, PAGE_3].join('\n\n');

beforeEach(() => {
  pagedReadCache.clear();
});

function layout(pages: string[]): DocxLayoutClient {
  const value: DocxLayout = {
    pageCount: pages.length,
    truncated: false,
    pages: pages.map((text, index) => ({ number: index + 1, text })),
  };
  return { pages: async () => value };
}

async function read(
  name: string,
  docxLayout: DocxLayoutClient | undefined,
): Promise<Awaited<ReturnType<typeof readChatAttachmentsPaged.execute>>> {
  const rig = buildPagedRig({ files: [{ name, text: TEXT }] });
  const deps: PagedReaderHost = { ...rig.deps, docxLayout };
  return readChatAttachmentsPaged.execute({}, deps, rig.context());
}

describe('страницы docx в чтении файла', () => {
  test('раскладка есть: перед абзацем стоит маркер страницы', async () => {
    const result = await read('Договор.docx', layout([PAGE_1, PAGE_2, PAGE_3]));
    const text = result.part?.text ?? '';
    expect(text).toContain(`[стр. 1]`);
    expect(text.indexOf('[стр. 2]')).toBeLessThan(text.indexOf('Права и обязанности'));
    expect(text.indexOf('[стр. 3]')).toBeLessThan(text.indexOf('Ответственность сторон'));
    expect(text.indexOf('[стр. 2]')).toBeGreaterThan(text.indexOf('Предмет договора'));
    // содержимое договора не потеряно
    for (const page of [PAGE_1, PAGE_2, PAGE_3]) expect(text).toContain(page);
  });

  test('раскладки нет: текст прежний, пометка «страница не определена»', async () => {
    const result = await read('Договор.docx', undefined);
    expect(result.part?.text).not.toContain('[стр.');
    expect(result.part?.text).toContain('Предмет договора');
    expect((result.attachmentNotes ?? []).join('\n')).toContain(PAGE_UNKNOWN_NOTE);
    expect((result.attachmentNotes ?? []).join('\n')).toContain('Договор.docx');
  });

  test('сервис вернул не страницы этого текста: номера не выдумываются', async () => {
    const result = await read('Договор.docx', layout(['совсем другой текст', 'ещё другой']));
    expect(result.part?.text).not.toContain('[стр.');
    expect((result.attachmentNotes ?? []).join('\n')).toContain(PAGE_UNKNOWN_NOTE);
  });

  test('сервис недоступен (null): страница не определена, чтение работает', async () => {
    const down: DocxLayoutClient = { pages: async () => null };
    const result = await read('Договор.docx', down);
    expect(result.part?.text).toContain('Предмет договора');
    expect((result.attachmentNotes ?? []).join('\n')).toContain(PAGE_UNKNOWN_NOTE);
  });

  test('не docx (txt): раскладка не запрашивается, пометки нет', async () => {
    let asked = 0;
    const spy: DocxLayoutClient = {
      pages: async () => {
        asked += 1;
        return null;
      },
    };
    const result = await read('Заметка.txt', spy);
    expect(asked).toBe(0);
    expect((result.attachmentNotes ?? []).join('\n')).not.toContain(PAGE_UNKNOWN_NOTE);
    expect(result.part?.text).not.toContain('[стр.');
  });
});
