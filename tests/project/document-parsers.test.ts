import { describe, expect, test } from 'bun:test';
import { HttpDocumentParser, VisionTableDocumentParser } from '@business-ai/adapters';
import type {
  DocumentParser,
  ImageAttachment,
  ImageReader,
  ImageReadItem,
  ParsedDocument,
} from '@business-ai/core';
import {
  ScanTextDocumentParser,
  buildDocumentParsers,
} from '../../src/assembly/document-parsers';

/**
 * Разборщик документов со сканами «целиком»: скан PDF отдаётся страницами, остальное идёт как
 * у прайсов. Сервис разбора подменён через `fetchFn`, зрение - заглушкой; данные синтетические.
 */

const SCAN = 'scan.pdf';
const PLAIN = 'plain.docx';
const WITH_PICTURE = 'picture.docx';
const PHOTO = 'photo.jpg';
const PLAIN_TEXT = 'Договор поставки № 7';
const TABLE_MARKDOWN = '| Товар | Цена |\n|---|---|\n| Блокнот | 40 |';
const PLACEHOLDER = '[[IMAGE:1]]';
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, images: 0 };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Полезная нагрузка ответа `/parse`. */
function payload(markdown: string, needsOcr: boolean, images: unknown[] = []): unknown {
  return {
    format: 'pdf',
    markdown,
    sections: [],
    needs_ocr: needsOcr,
    has_hidden_content: false,
    warnings: [],
    ...(images.length === 0 ? {} : { images }),
  };
}

function pictureOf(name: string): unknown {
  return {
    index: 1,
    placeholder: PLACEHOLDER,
    mime: 'image/png',
    bytes_b64: Buffer.from(name).toString('base64'),
    location: 'страница 1',
    rendered: name === SCAN,
  };
}

interface Rig {
  base: HttpDocumentParser;
  /** Имена файлов, запрошенные у сервиса разбора, по порядку. */
  requests: string[];
  /** Картинки, переданные зрению. */
  seen: string[];
  /** Заглушка зрения. */
  reader: ImageReader;
}

function buildRig(): Rig {
  const requests: string[] = [];
  const seen: string[] = [];
  const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
    const form = init.body as FormData;
    const name = (form.get('file') as File).name;
    requests.push(name);
    const extract = form.get('extract_images') === 'true';
    if (name === SCAN) return Response.json(payload('', true, extract ? [pictureOf(name)] : []));
    if (name === WITH_PICTURE) {
      const markdown = `${PLAIN_TEXT}\n${PLACEHOLDER}`;
      return Response.json(payload(markdown, false, extract ? [pictureOf(name)] : []));
    }
    return Response.json(payload(PLAIN_TEXT, false));
  };
  const reader: ImageReader = {
    async describe(images: readonly ImageAttachment[]) {
      seen.push(...images.map((image) => image.name));
      const items = images.map(
        (image): ImageReadItem => ({
          name: image.name,
          source: image.source,
          status: 'ok',
          text: TABLE_MARKDOWN,
        }),
      );
      return { items, usage: { inputTokens: 0, outputTokens: 0, images: images.length } };
    },
  };
  const base = new HttpDocumentParser({ baseUrl: 'http://documents.test', fetchFn });
  return { base, requests, seen, reader };
}

function textParserOf(stand: Rig): { text: DocumentParser; table: DocumentParser } {
  return buildDocumentParsers(stand.base, stand.reader);
}

describe('разборщик документов со сканами', () => {
  test('для боевого разборщика: текстовый и табличный - разные, табличный прежний', () => {
    const stand = buildRig();
    const parsers = textParserOf(stand);
    expect(parsers.text).toBeInstanceOf(ScanTextDocumentParser);
    expect(parsers.table).toBeInstanceOf(VisionTableDocumentParser);
  });

  test('чужой разборщик (заглушка) остаётся один на всех', () => {
    const stub: DocumentParser = {
      async parse(): Promise<ParsedDocument> {
        throw new Error('не вызывается');
      },
    };
    const reader: ImageReader = { describe: async () => ({ items: [], usage: EMPTY_USAGE }) };
    const parsers = buildDocumentParsers(stub, reader);
    expect(parsers.text).toBe(stub);
    expect(parsers.table).toBe(stub);
  });

  test('скан PDF: needsOcr без таблиц, страницы одним запросом с разбором', async () => {
    const stand = buildRig();
    const { text } = textParserOf(stand);
    const bytes = encode(SCAN);
    const parsed = await text.parse(SCAN, bytes);
    expect(parsed.needsOcr).toBe(true);
    expect(parsed.tables).toEqual([]);
    const pages = await (text as ScanTextDocumentParser).parseWithImages(SCAN, bytes);
    expect(pages.images.map((image) => image.index)).toEqual([1]);
    expect(stand.requests).toEqual([SCAN]);
    // Зрение разборщик не вызывал: страницы читает чтение вложений.
    expect(stand.seen).toEqual([]);
  });

  test('страницы отдаются один раз: повторный запрос идёт в сервис', async () => {
    const stand = buildRig();
    const { text } = textParserOf(stand);
    const bytes = encode(SCAN);
    await text.parse(SCAN, bytes);
    await (text as ScanTextDocumentParser).parseWithImages(SCAN, bytes);
    await (text as ScanTextDocumentParser).parseWithImages(SCAN, bytes);
    expect(stand.requests).toEqual([SCAN, SCAN]);
  });

  test('другие байты: кэш страниц не подставляется чужому файлу', async () => {
    const stand = buildRig();
    const { text } = textParserOf(stand);
    await text.parse(SCAN, encode(SCAN));
    await (text as ScanTextDocumentParser).parseWithImages(SCAN, encode(SCAN));
    expect(stand.requests).toEqual([SCAN, SCAN]);
  });

  test('обычный документ без картинок: один запрос, зрение не трогается', async () => {
    const stand = buildRig();
    const { text } = textParserOf(stand);
    const parsed = await text.parse(PLAIN, encode(PLAIN));
    expect(parsed.text).toBe(PLAIN_TEXT);
    expect(parsed.needsOcr).toBe(false);
    expect(stand.requests).toEqual([PLAIN]);
    expect(stand.seen).toEqual([]);
  });

  test('документ с картинкой внутри читается табличным разборщиком, как раньше', async () => {
    const stand = buildRig();
    const { text, table } = textParserOf(stand);
    const viaText = await text.parse(WITH_PICTURE, encode(WITH_PICTURE));
    const viaTable = await table.parse(WITH_PICTURE, encode(WITH_PICTURE));
    expect(viaText).toEqual(viaTable);
    expect(viaText.tables.length).toBe(1);
  });

  test('файл-картинка идёт табличным разборщиком без запроса к сервису разбора', async () => {
    const stand = buildRig();
    const { text } = textParserOf(stand);
    const parsed = await text.parse(PHOTO, encode(PHOTO));
    expect(parsed.tables.length).toBe(1);
    expect(stand.requests).toEqual([]);
    expect(stand.seen).toEqual([PHOTO]);
  });

  test('сканом для прайсов остаётся табличный разборщик: таблица со страницы', async () => {
    const stand = buildRig();
    const { table } = textParserOf(stand);
    const parsed = await table.parse(SCAN, encode(SCAN));
    expect(parsed.needsOcr).toBe(false);
    expect(parsed.tables.length).toBe(1);
  });

  test('признаки: сканы сам не читает, архивы - как табличный', () => {
    const stand = buildRig();
    const { text, table } = textParserOf(stand);
    expect(text.readsImages).toBe(false);
    expect(text.readsArchives).toBe(table.readsArchives === true);
  });
});
