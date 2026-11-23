import { describe, expect, test } from 'bun:test';
import {
  HttpDocxLayoutClient,
  supportsDocxLayout,
  type DocxLayoutClient,
} from '../../src/docx-pages-client';

type FetchCall = { url: string; init: RequestInit };

const BASE_URL = 'http://documents.test:8000/';
const FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** Корректный ответ сервиса: две страницы. */
const VALID_BODY = {
  page_count: 2,
  pages: [
    { number: 1, text: 'Договор №1. Первая страница' },
    { number: 2, text: 'Вторая страница' },
  ],
  truncated: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Клиент с фейковым fetch: запоминает вызовы и причины отказа. */
function clientWith(
  respond: (call: FetchCall) => Promise<Response>,
  timeoutMs?: number,
): { client: DocxLayoutClient; calls: FetchCall[]; failures: string[] } {
  const calls: FetchCall[] = [];
  const failures: string[] = [];
  const client = new HttpDocxLayoutClient({
    baseUrl: BASE_URL,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fetchFn: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
    onFailure: (reason) => failures.push(reason),
  });
  return { client, calls, failures };
}

describe('клиент раскладки docx по страницам', () => {
  test('успех: страницы разобраны, запрос идёт на /docx/pages', async () => {
    const { client, calls, failures } = clientWith(async () => jsonResponse(VALID_BODY));
    const layout = await client.pages({ name: 'Договор №1.docx', bytes: FILE_BYTES });
    expect(layout).toEqual({
      pageCount: 2,
      pages: [
        { number: 1, text: 'Договор №1. Первая страница' },
        { number: 2, text: 'Вторая страница' },
      ],
      truncated: false,
    });
    expect(failures).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://documents.test:8000/docx/pages');
    expect(calls[0]?.init.method).toBe('POST');
  });

  test('multipart содержит файл и его имя', async () => {
    const { client, calls } = clientWith(async () => jsonResponse(VALID_BODY));
    await client.pages({ name: 'Договор №1.docx', bytes: FILE_BYTES });
    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('Договор №1.docx');
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(FILE_BYTES);
    // Платформенный разбор тела требует поле params у каждой ручки (проверено на живом образе)
    expect(JSON.parse(String((body as FormData).get('params')))).toEqual({
      file_name: 'Договор №1.docx',
    });
  });

  test('404 от старого сервиса даёт null и причину', async () => {
    const { client, failures } = clientWith(async () => jsonResponse({ detail: 'нет' }, 404));
    expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('404');
  });

  test('любой не-200 даёт null', async () => {
    const { client, failures } = clientWith(async () => jsonResponse(VALID_BODY, 503));
    expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
    expect(failures[0]).toContain('503');
  });

  test('невалидный JSON даёт null', async () => {
    const { client, failures } = clientWith(async () => new Response('не json', { status: 200 }));
    expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
    expect(failures).toHaveLength(1);
  });

  test('ответ не по схеме даёт null', async () => {
    const wrong = [
      { page_count: 1, pages: [{ number: 0, text: 'x' }], truncated: false },
      { page_count: 1, pages: [{ number: 1 }], truncated: false },
      { page_count: 1.5, pages: [], truncated: false },
      { page_count: 1, pages: [] },
      'строка',
    ];
    for (const body of wrong) {
      const { client, failures } = clientWith(async () => jsonResponse(body));
      expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
      expect(failures).toHaveLength(1);
    }
  });

  test('сетевое исключение не пробрасывается', async () => {
    const { client, failures } = clientWith(async () => {
      throw new Error('соединение сброшено');
    });
    expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
    expect(failures).toHaveLength(1);
  });

  test('таймаут прерывает запрос и даёт null', async () => {
    const { client, failures } = clientWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      20,
    );
    expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
    expect(failures).toEqual(['timeout']);
  });

  test('неподдерживаемое расширение: запроса нет', async () => {
    const { client, calls, failures } = clientWith(async () => jsonResponse(VALID_BODY));
    expect(await client.pages({ name: 'Таблица.xlsx', bytes: FILE_BYTES })).toBeNull();
    expect(await client.pages({ name: 'без-расширения', bytes: FILE_BYTES })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(failures).toEqual([]);
  });

  test('сбой в колбэке причины не ломает возврат null', async () => {
    const client = new HttpDocxLayoutClient({
      baseUrl: BASE_URL,
      fetchFn: async () => jsonResponse({}, 500),
      onFailure: () => {
        throw new Error('колбэк упал');
      },
    });
    expect(await client.pages({ name: 'a.docx', bytes: FILE_BYTES })).toBeNull();
  });

  test('причина отказа не содержит содержимого файла и имени', async () => {
    const { client, failures } = clientWith(async () => jsonResponse({}, 500));
    await client.pages({ name: 'Секретный договор.docx', bytes: FILE_BYTES });
    expect(failures.join(' ')).not.toContain('Секретный');
  });
});

describe('поддержка раскладки по расширению', () => {
  test('docx, doc и rtf любого регистра поддержаны', () => {
    expect(supportsDocxLayout('a.docx')).toBe(true);
    expect(supportsDocxLayout('A.DOC')).toBe(true);
    expect(supportsDocxLayout('Договор №1.Rtf')).toBe(true);
  });

  test('остальные форматы не поддержаны', () => {
    expect(supportsDocxLayout('a.xlsx')).toBe(false);
    expect(supportsDocxLayout('a.pdf')).toBe(false);
    expect(supportsDocxLayout('docx')).toBe(false);
    expect(supportsDocxLayout('a.docx.txt')).toBe(false);
  });
});
