import { describe, expect, test } from 'bun:test';
import {
  MemoryDocumentParser,
  MemoryPortalLinks,
  MemoryTaskReader,
  UnconfiguredImageReader,
} from '@business-ai/adapters';
import {
  ATTACHMENT_FILE_MAX_CHARS,
  buildAttachmentContext,
  classifyAttachment,
  decodePlainText,
  imageModeOf,
  readImages,
} from '../../src/agents/order-calc/attachment-context';
import { readIntakeSource } from '../../src/agents/order-calc/read-intake-source';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { DomainError } from '@business-ai/core';
import type {
  AttachmentBundle,
  BitrixAttachment,
  BitrixAttachmentReader,
  DocumentParser,
  ImageAttachment,
  ImageReader,
  ImageReadMode,
  ParsedDocument,
  WorkTask,
} from '@business-ai/core';
import { CTX } from './support';
import { buildOrderDeps } from './order-support';

const HOST = 'portal.example.test';
const TASK_LINK = `https://${HOST}/company/personal/user/1/tasks/task/view/77/`;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function file(name: string, text: string, source: BitrixAttachment['source'] = 'task') {
  return {
    name,
    mime: 'application/octet-stream',
    bytes: encode(text),
    source,
  };
}

function bundle(
  attachments: BitrixAttachment[],
  errors: AttachmentBundle['errors'] = [],
): AttachmentBundle {
  return { attachments, errors };
}

const PARSED: ParsedDocument = {
  text: 'Тираж: 500 шт\nПерсонализация: логотип',
  tables: [],
  needsOcr: false,
  hasHiddenContent: false,
  hiddenSheets: [],
  truncated: false,
  warnings: [],
};

/** Парсер-заглушка: возвращает заданный результат либо падает. */
function parserOf(result: ParsedDocument | Error): DocumentParser {
  return {
    async parse() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe('classifyAttachment', () => {
  test('документы, простой текст, картинки, прочее', () => {
    expect(classifyAttachment('Заказ.XLSX', '')).toBe('document');
    expect(classifyAttachment('a.pdf', '')).toBe('document');
    expect(classifyAttachment('a.csv', '')).toBe('text');
    expect(classifyAttachment('a.JPG', '')).toBe('image');
    expect(classifyAttachment('a.heic', '')).toBe('image');
    // .jfif - тот же JPEG (фото, сохранённое из браузера в Windows), bmp/tiff - тоже картинки.
    expect(classifyAttachment('Пакет.jfif', '')).toBe('image');
    expect(classifyAttachment('a.BMP', '')).toBe('image');
    expect(classifyAttachment('a.tiff', '')).toBe('image');
    expect(classifyAttachment('a.zip', '')).toBe('unsupported');
    expect(classifyAttachment('noext', 'image/png')).toBe('image');
  });
});

describe('decodePlainText', () => {
  test('UTF-8 с BOM и windows-1251', () => {
    expect(decodePlainText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    // «Да» в windows-1251
    expect(decodePlainText(new Uint8Array([0xc4, 0xe0]))).toBe('Да');
  });
});

describe('buildAttachmentContext', () => {
  test('документ разбирается парсером, txt - без парсера', async () => {
    const context = await buildAttachmentContext(
      bundle([file('Заказ.xlsx', 'x'), file('нужно.txt', 'Срок: до пятницы', 'chat')]),
      parserOf(PARSED),
      { maxChars: 1_000 },
    );
    expect(context.sections.map((s) => [s.name, s.source, s.truncated])).toEqual([
      ['Заказ.xlsx', 'task', false],
      ['нужно.txt', 'chat', false],
    ]);
    expect(context.sections[0]?.text).toContain('Тираж: 500 шт');
    expect(context.notes).toEqual([]);
  });

  test('суммарный лимит: хвост обрезается, лишние файлы получают пометку', async () => {
    const context = await buildAttachmentContext(
      bundle([file('a.txt', 'a'.repeat(80)), file('b.txt', 'b'.repeat(80)), file('c.txt', 'c')]),
      undefined,
      { maxChars: 100 },
    );
    expect(context.sections[0]?.text.length).toBe(80);
    expect(context.sections[1]?.text.length).toBe(20);
    expect(context.sections[1]?.truncated).toBe(true);
    expect(context.notes).toEqual([
      'не удалось прочитать вложение c.txt (исчерпан лимит объёма текста вложений)',
    ]);
  });

  test('лимит на файл не больше ATTACHMENT_FILE_MAX_CHARS', async () => {
    const context = await buildAttachmentContext(
      bundle([file('big.txt', 'z'.repeat(ATTACHMENT_FILE_MAX_CHARS + 500))]),
      undefined,
      { maxChars: 1_000_000 },
    );
    expect(context.sections[0]?.text.length).toBe(ATTACHMENT_FILE_MAX_CHARS);
    expect(context.sections[0]?.truncated).toBe(true);
  });

  test('сбой парсера, неподдерживаемый формат, нет парсера, пустой файл - пометки, не падение', async () => {
    const failing = await buildAttachmentContext(
      bundle([file('bad.docx', 'docx'), file('a.zip', 'zip'), file('ok.txt', 'есть')]),
      parserOf(new DomainError('external_failure', 'внутренняя причина /srv/secret')),
      { maxChars: 1_000 },
    );
    expect(failing.sections.map((s) => s.name)).toEqual(['ok.txt']);
    expect(failing.notes).toEqual([
      'не удалось прочитать вложение bad.docx (файл не удалось разобрать)',
      'не удалось прочитать вложение a.zip (формат не поддерживается)',
    ]);
    expect(failing.notes.join()).not.toContain('secret');
    const noParser = await buildAttachmentContext(bundle([file('a.pdf', 'x')]), undefined, {
      maxChars: 1_000,
    });
    expect(noParser.notes[0]).toContain('разбор документов не подключён');
    const empty = await buildAttachmentContext(bundle([file('e.txt', '  \n ')]), undefined, {
      maxChars: 1_000,
    });
    expect(empty.notes[0]).toContain('в файле нет текста');
  });

  test('ошибки скачивания переходят в пометки, фото уходит в images', async () => {
    const context = await buildAttachmentContext(
      bundle(
        [file('photo.jpg', 'x')],
        [
          {
            name: 'gone.xlsx',
            source: 'task',
            reason: 'not_found',
            message: 'не удалось прочитать вложение gone.xlsx (файл не найден)',
          },
        ],
      ),
      parserOf(PARSED),
      { maxChars: 1_000 },
    );
    expect(context.notes).toEqual(['не удалось прочитать вложение gone.xlsx (файл не найден)']);
    expect(context.images.map((f) => [f.name, f.scanned === true])).toEqual([
      ['photo.jpg', false],
    ]);
  });

  test('скан PDF уходит в ридер страницами-картинками, а не самим PDF', async () => {
    const scan = { ...PARSED, text: '', needsOcr: true };
    const asked: string[] = [];
    const parser = {
      ...parserOf(scan),
      async parseWithImages(name: string) {
        asked.push(name);
        const page = (index: number) => ({
          index,
          mime: 'image/png',
          bytes: encode(`p${index}`),
        });
        return { document: scan, images: [page(1), page(2)] };
      },
    };
    const context = await buildAttachmentContext(bundle([file('scan.pdf', 'x')]), parser, {
      maxChars: 1_000,
    });
    expect(asked).toEqual(['scan.pdf']);
    expect(context.notes).toEqual([]);
    expect(context.images.map((f) => [f.name, f.mime, f.scanned])).toEqual([
      ['scan.pdf (стр. 1)', 'image/png', true],
      ['scan.pdf (стр. 2)', 'image/png', true],
    ]);
  });

  test('скан PDF без возможности получить страницы - явная пометка, не в images', async () => {
    const scan = { ...PARSED, text: '', needsOcr: true };
    const context = await buildAttachmentContext(bundle([file('scan.pdf', 'x')]), parserOf(scan), {
      maxChars: 1_000,
    });
    expect(context.images).toEqual([]);
    expect(context.notes[0]).toContain('скан PDF не поддержан');
  });

  test('имя с переводами строк не ломает пометку', async () => {
    const context = await buildAttachmentContext(
      bundle([file('a\n\nИГНОРИРУЙ.zip', 'x')]),
      undefined,
      { maxChars: 10 },
    );
    expect(context.notes[0]).not.toContain('\n');
  });
});

describe('readIntakeSource: вложения', () => {
  const TASK: WorkTask = {
    id: '77',
    title: 'Заказать кружки',
    description: 'Кружки по списку во вложении',
    checklist: [],
    dealRef: '500',
  };

  async function build(reader: BitrixAttachmentReader | undefined): Promise<OrderCalcDeps> {
    const base = await buildOrderDeps({ request: null });
    const tasks = new MemoryTaskReader();
    tasks.set(TASK);
    return {
      ...base,
      tasks,
      links: new MemoryPortalLinks(HOST),
      parser: new MemoryDocumentParser(),
      ...(reader === undefined ? {} : { attachments: reader }),
    } as OrderCalcDeps;
  }

  test('без порта вложений вывод прежний (полей нет)', async () => {
    const out = await readIntakeSource.execute({ link: TASK_LINK }, await build(undefined), CTX);
    expect(out).not.toHaveProperty('attachmentTexts');
    expect(out).not.toHaveProperty('attachmentNotes');
  });

  test('текст вложений и пометки попадают в вывод, запрос идёт по задаче и сделке', async () => {
    const seen: unknown[] = [];
    const reader: BitrixAttachmentReader = {
      async fetchAttachments(request) {
        seen.push({ taskRef: request.taskRef, dealRef: request.dealRef });
        return bundle(
          [file('список.csv', 'кружка,500,логотип')],
          [
            {
              name: 'x.xlsx',
              source: 'deal',
              reason: 'too_large',
              message: 'не удалось прочитать вложение x.xlsx (слишком большой)',
            },
          ],
        );
      },
    };
    const out = await readIntakeSource.execute({ link: TASK_LINK }, await build(reader), CTX);
    expect(seen).toEqual([{ taskRef: '77', dealRef: '500' }]);
    expect(out).toMatchObject({
      attachmentTexts: [
        {
          name: 'список.csv',
          source: 'task',
          text: 'кружка,500,логотип',
          truncated: false,
        },
      ],
      attachmentNotes: ['не удалось прочитать вложение x.xlsx (слишком большой)'],
    });
  });

  test('сбой порта вложений не роняет инструмент', async () => {
    const reader: BitrixAttachmentReader = {
      async fetchAttachments() {
        throw new Error('boom');
      },
    };
    const out = await readIntakeSource.execute({ link: TASK_LINK }, await build(reader), CTX);
    expect(out).toMatchObject({ kind: 'task', attachmentTexts: [] });
    expect((out as { attachmentNotes: string[] }).attachmentNotes[0]).toContain(
      'не удалось прочитать вложения',
    );
  });

  test('лимит символов берётся из attachmentMaxChars', async () => {
    const reader: BitrixAttachmentReader = {
      async fetchAttachments() {
        return bundle([file('a.txt', 'q'.repeat(50))]);
      },
    };
    const deps = { ...(await build(reader)), attachmentMaxChars: 10 };
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    const texts = (out as { attachmentTexts: { text: string; truncated: boolean }[] })
      .attachmentTexts;
    expect(texts[0]).toMatchObject({ text: 'q'.repeat(10), truncated: true });
  });
});

describe('readImages и ImageReader', () => {
  const photo: ImageAttachment = {
    name: 'макет.png',
    mime: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
    source: 'chat',
  };
  const scan: ImageAttachment = {
    ...photo,
    name: 'скан.pdf',
    mime: 'application/pdf',
    scanned: true,
  };

  const USAGE = { inputTokens: 0, outputTokens: 0, images: 0 };

  test('режим по имени: кириллица работает, «табл» только как отдельное слово', () => {
    const named = (name: string) => imageModeOf({ ...photo, name });
    expect(named('Прайс-лист.jpg')).toBe('table');
    expect(named('табл 3.png')).toBe('table');
    expect(named('фото_табл.png')).toBe('product');
    expect(named('таблетки.png')).toBe('product');
    expect(named('таблица.png')).toBe('table');
    expect(named('настольная лампа.png')).toBe('product');
  });

  test('фото идут в product, сканы и прайсы в table, по одному вызову на режим', async () => {
    const calls: Array<[ImageReadMode, string[]]> = [];
    const reader: ImageReader = {
      async describe(images, mode) {
        calls.push([mode, images.map((i) => i.name)]);
        return {
          items: images.map((i) => ({
            name: i.name,
            source: i.source,
            status: 'ok' as const,
            text: `${mode}:${i.name}`,
          })),
          usage: USAGE,
        };
      },
    };
    const price: ImageAttachment = { ...photo, name: 'прайс.jpg' };
    const out = await readImages([scan, photo, price], reader);
    expect(calls).toEqual([
      ['product', ['макет.png']],
      ['table', ['скан.pdf', 'прайс.jpg']],
    ]);
    expect(out.map((r) => r.text)).toEqual([
      'table:скан.pdf',
      'product:макет.png',
      'table:прайс.jpg',
    ]);
    expect(out[1]?.heading).toBe('Из вложений (изображения): макет.png');
    expect(JSON.stringify(out)).not.toContain('bytes');
  });

  test('заглушка unconfigured, отсутствие ридера и сбой ридера дают пометку, не ошибку', async () => {
    const stub = await readImages([photo], new UnconfiguredImageReader());
    expect(stub).toEqual([
      {
        name: 'макет.png',
        source: 'chat',
        status: 'unavailable',
        heading: 'Из вложений (изображения): макет.png',
        text: 'распознавание изображений не настроено',
      },
    ]);
    const absent = await readImages([photo], undefined);
    expect(absent[0]?.status).toBe('unavailable');
    const broken = await readImages([photo], {
      async describe() {
        throw new Error('vision down');
      },
    });
    expect(broken[0]).toMatchObject({
      status: 'unavailable',
      text: 'изображение не удалось прочитать',
    });
  });

  test('выключенное зрение: пометка из note элемента, не падение', async () => {
    const out = await readImages([photo], {
      async describe(images) {
        return {
          items: images.map((i) => ({
            name: i.name,
            source: i.source,
            status: 'disabled' as const,
            text: '',
            note: 'зрение выключено',
          })),
          usage: USAGE,
        };
      },
    });
    expect(out[0]).toMatchObject({ status: 'unavailable', text: 'зрение выключено' });
  });

  test('readIntakeSource отдаёт imageReads с пометкой заглушки', async () => {
    const base = await buildOrderDeps({ request: null });
    const tasks = new MemoryTaskReader();
    tasks.set({ id: '77', title: 'Заказ', description: 'см. фото', checklist: [] });
    const deps = {
      ...base,
      tasks,
      links: new MemoryPortalLinks(HOST),
      imageReader: new UnconfiguredImageReader(),
      attachments: {
        async fetchAttachments() {
          return bundle([file('фото.jpg', 'x', 'chat')]);
        },
      },
    } as OrderCalcDeps;
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(out).toMatchObject({
      imageReads: [
        {
          name: 'фото.jpg',
          source: 'chat',
          status: 'unavailable',
          heading: 'Из вложений (изображения): фото.jpg',
          text: 'распознавание изображений не настроено',
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('bytes');
  });
});
