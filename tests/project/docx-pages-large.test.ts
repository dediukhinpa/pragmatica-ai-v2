import { beforeEach, describe, expect, test } from 'bun:test';
import type { DiskFile, DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import {
  DOCX_PAGES_SKIPPED_EVENT,
  DOCX_PAGES_UNAVAILABLE_EVENT,
  HttpDocxLayoutClient,
  docxPagesEventOf,
  type DocxLayoutClient,
} from '../../src/docx-pages-client';
import { readPricePage } from '../../src/agents/prices/read-price-file';
import type { PriceSource } from '../../src/agents/prices/price-sources';
import { resetLayoutCache } from '../../src/price-table-places';
import {
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Большой docx (этап 9t): номера страниц - подсказка, а не условие чтения. Сервис документов
 * отвечает 413 на `/docx/pages` для файла крупнее предела конвертации; ход агента при этом идёт
 * без ошибок, без повторной отправки того же большого файла и без тревожных записей в журнале.
 */

const BASE_URL = 'http://documents.test:8000';
const SMALL_LIMIT = 16;
const BIG_BYTES = new Uint8Array(SMALL_LIMIT + 1);
const SECRET_NAME = 'стекло прайс СЕКРЕТ опт 2.docx';
const HTTP_TOO_LARGE = 413;

const TABLE = [
  ['Название', 'Цена'],
  ['Стекло 1', '140р'],
  ['Стекло 2', '190 р.'],
  ['Стекло 3', '800 рублей'],
];

/** Клиент с фейковым fetch: считает запросы и собирает причины отказа. */
function clientWith(
  respond: () => Promise<Response>,
  maxBytes = SMALL_LIMIT,
): { client: HttpDocxLayoutClient; fetches: number[]; failures: string[] } {
  const fetches: number[] = [];
  const failures: string[] = [];
  const client = new HttpDocxLayoutClient({
    baseUrl: BASE_URL,
    maxBytes,
    fetchFn: () => {
      fetches.push(1);
      return respond();
    },
    onFailure: (reason) => failures.push(reason),
  });
  return { client, fetches, failures };
}

describe('клиент раскладки: большой файл', () => {
  test('файл крупнее предела не отправляется: запроса нет, причина too_large', async () => {
    const { client, fetches, failures } = clientWith(async () => new Response('{}'));
    expect(await client.pages({ name: SECRET_NAME, bytes: BIG_BYTES })).toBeNull();
    expect(fetches).toHaveLength(0);
    expect(failures).toEqual(['too_large']);
  });

  test('файл ровно в пределе отправляется', async () => {
    const { client, fetches } = clientWith(async () => new Response('{}', { status: 500 }));
    await client.pages({ name: SECRET_NAME, bytes: new Uint8Array(SMALL_LIMIT) });
    expect(fetches).toHaveLength(1);
  });

  test('413 по размеру без пометки «временно»: причина too_large, ход не ломается', async () => {
    const { client, failures } = clientWith(
      async () => new Response('{"detail":"документ превышает"}', { status: HTTP_TOO_LARGE }),
      SMALL_LIMIT * 1000,
    );
    expect(await client.pages({ name: SECRET_NAME, bytes: BIG_BYTES })).toBeNull();
    expect(failures).toEqual(['too_large']);
  });

  test('413 с пометкой «временно» (нагрузка, время) остаётся сбоем сервиса', async () => {
    const { client, failures } = clientWith(
      async () =>
        new Response('{}', { status: HTTP_TOO_LARGE, headers: { 'X-Reject-Kind': 'transient' } }),
      SMALL_LIMIT * 1000,
    );
    expect(await client.pages({ name: SECRET_NAME, bytes: BIG_BYTES })).toBeNull();
    expect(failures).toEqual(['status 413']);
  });

  test('штатный отказ по размеру пишется как info-событие, сбои - как предупреждение', () => {
    expect(docxPagesEventOf('too_large')).toBe(DOCX_PAGES_SKIPPED_EVENT);
    expect(docxPagesEventOf('status 503')).toBe(DOCX_PAGES_UNAVAILABLE_EVENT);
    expect(docxPagesEventOf('timeout')).toBe(DOCX_PAGES_UNAVAILABLE_EVENT);
  });
});

/** Разбор: таблица цен текстом, как у большого docx с картинками. */
const PARSER: DocumentParser = {
  async parse(): Promise<ParsedDocument> {
    return {
      text: TABLE.map((row) => row.join(' | ')).join('\n'),
      tables: [TABLE],
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  },
};

/** Источник «файл на диске» заданного размера: читать его целиком не нужно. */
function bigDiskSource(size: number, reads: number[]): PriceSource {
  return {
    path: `chat/${SECRET_NAME}`,
    name: SECRET_NAME,
    hash: 'hash-big-docx',
    kind: 'intake',
    read: async () => {
      reads.push(1);
      return new Uint8Array(1);
    },
    disk: async () => ({ size }) as unknown as DiskFile,
    meta: { source: 'intake', notes: [] },
  };
}

let deps: FullPricesDeps;
let ctx: ToolContext;
beforeEach(async () => {
  resetLayoutCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-big', 'thread-big');
});

describe('readPriceFile на большом docx', () => {
  test('файл крупнее предела: страницы не запрашиваются, файл не читается ради них', async () => {
    const pages: string[] = [];
    const reads: number[] = [];
    const layout: DocxLayoutClient = {
      maxBytes: SMALL_LIMIT,
      pages: async (file) => {
        pages.push(file.name);
        return null;
      },
    };
    const page = await readPricePage(
      { ...deps, parser: PARSER, docxLayout: layout },
      bigDiskSource(SMALL_LIMIT * 100, reads),
      undefined,
    );
    expect(page.tableCount).toBe(1);
    expect(page.markdown).toContain('140р');
    // Страница не определена: метки нет, номер не выдумывается
    expect(page.tablePlaces?.every((place) => place === null) ?? true).toBe(true);
    expect(pages).toEqual([]);
    // Единственное чтение - сам разбор таблиц; ради страниц файл второй раз не читается
    expect(reads).toHaveLength(1);
    expect(ctx.threadId).toBe('thread-big');
  });

  test('отказ сервиса (null) не ломает чтение, повтор не кэширует отказ', async () => {
    const pages: string[] = [];
    const layout: DocxLayoutClient = {
      pages: async (file) => {
        pages.push(file.name);
        return null;
      },
    };
    const source = bigDiskSource(1, []);
    const withLayout = { ...deps, parser: PARSER, docxLayout: layout };
    const first = await readPricePage(withLayout, source, undefined);
    const second = await readPricePage(withLayout, source, undefined);
    expect(first.markdown).toBe(second.markdown);
    expect(first.tableCount).toBe(1);
    expect(pages).toHaveLength(2);
  });
});
