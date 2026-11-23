import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeTempDirs, tempDir } from '@business-ai/testing';
import { HttpPriceSpotReader, supportsPriceSpots } from '../../src/price-spots-client';

/**
 * Клиент карты чисел вне таблиц pptx (этап 9q): `POST /parse` с `locations=true`, разбор ответа
 * по схеме, любой сбой - `null` без исключения. Данные синтетические.
 */

afterAll(removeTempDirs);

const BYTES = new TextEncoder().encode('синтетическая презентация');

const SPOT = {
  slide: 2,
  shape: '7/12',
  paragraph: 0,
  start: 8,
  text: '680 ₽',
  context: 'Акция: 680 ₽ за штуку',
};
/** Место в разобранном виде: клиент добавляет вид места (`kind`). */
const PARSED_SPOT = { kind: 'pptx' as const, ...SPOT };
const LOCATIONS = {
  tables: [{ slide: 1, shape: '4', table: 0, rows: 3, cols: 2 }],
  spots: [SPOT],
  unreachable: [{ slide: 3, shape: '9', kind: 'picture' }],
  truncated: false,
};

/** Что увидел «сервис»: адрес, метод и поля формы. */
interface Seen {
  url: string;
  method: string;
  fields: Record<string, string>;
  fileName: string;
}

function readerWith(
  reply: () => Response | Promise<Response>,
  seen: Partial<Seen> = {},
  failures: string[] = [],
): HttpPriceSpotReader {
  return new HttpPriceSpotReader({
    baseUrl: 'http://docs.test/',
    onFailure: (reason) => failures.push(reason),
    fetchFn: async (url, init) => {
      seen.url = String(url);
      seen.method = String(init.method);
      // Тело уходит формой в памяти либо потоком (файл на диске): читаем как сервис
      const headers = new Headers(init.headers as Record<string, string> | undefined);
      const form = await new Response(init.body, { headers })
        .formData()
        .catch(() => undefined);
      if (form !== undefined) {
        seen.fields = {};
        for (const [name, value] of form.entries() as Iterable<[string, unknown]>) {
          if (typeof value === 'string') seen.fields[name] = value;
          else seen.fileName = (value as File).name;
        }
      }
      return reply();
    },
  });
}

describe('запрос карты мест', () => {
  test('POST /parse с file и locations=true, ответ разбирается по схеме', async () => {
    const seen: Partial<Seen> = {};
    const reader = readerWith(() => Response.json({ markdown: '# x', locations: LOCATIONS }), seen);
    const map = await reader.read({ name: 'каталог/Прайс.pptx', bytes: BYTES });
    expect(seen.url).toBe('http://docs.test/parse');
    expect(seen.method).toBe('POST');
    expect(seen.fields).toEqual({ locations: 'true' });
    expect(seen.fileName).toBe('Прайс.pptx');
    expect(map).toEqual({
      spots: [PARSED_SPOT],
      unreachable: [{ slide: 3, shape: '9', kind: 'picture' }],
      truncated: false,
    });
  });

  test('файл на диске уходит потоком с тем же полем locations=true', async () => {
    const path = join(tempDir(), 'deck.pptx');
    writeFileSync(path, BYTES);
    const seen: Partial<Seen> = {};
    const reader = readerWith(() => Response.json({ locations: LOCATIONS }), seen);
    const map = await reader.read({ name: 'deck.pptx', disk: { path, size: BYTES.byteLength } });
    expect(seen.fields).toEqual({ locations: 'true' });
    expect(seen.fileName).toBe('deck.pptx');
    expect(map?.spots).toHaveLength(1);
  });

  test('без списка фигур и признака обрезки: значения по умолчанию', async () => {
    const reader = readerWith(() => Response.json({ locations: { spots: [SPOT] } }));
    const map = await reader.read({ name: 'a.pptx', bytes: BYTES });
    expect(map).toEqual({ spots: [PARSED_SPOT], unreachable: [], truncated: false });
  });

  test('не презентация: запроса нет, карты нет', async () => {
    let called = false;
    const reader = readerWith(() => {
      called = true;
      return Response.json({});
    });
    expect(await reader.read({ name: 'a.xlsx', bytes: BYTES })).toBeNull();
    expect(called).toBe(false);
    expect(supportsPriceSpots('A.PPTX')).toBe(true);
    expect(supportsPriceSpots('a.ppt')).toBe(true);
    // С этапа 9r карту мест отдаёт и pdf; прочие форматы - нет
    expect(supportsPriceSpots('a.pdf')).toBe(true);
    expect(supportsPriceSpots('a.docx')).toBe(false);
  });
});

describe('сбои дают null без исключения', () => {
  test('сервис без поля locations (правка pptx выключена): null, это не сбой', async () => {
    const failures: string[] = [];
    const reader = readerWith(() => Response.json({ markdown: '# x' }), {}, failures);
    expect(await reader.read({ name: 'a.pptx', bytes: BYTES })).toBeNull();
    expect(failures).toEqual([]);
  });

  test('статус 500: null и причина в журнале без имени файла', async () => {
    const failures: string[] = [];
    const reader = readerWith(() => new Response('boom', { status: 500 }), {}, failures);
    expect(await reader.read({ name: 'секрет.pptx', bytes: BYTES })).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures.join(' ')).not.toContain('секрет');
  });

  test('ответ не по схеме: null', async () => {
    const failures: string[] = [];
    const reader = readerWith(
      () => Response.json({ locations: { spots: [{ slide: 0, shape: '', text: 1 }] } }),
      {},
      failures,
    );
    expect(await reader.read({ name: 'a.pptx', bytes: BYTES })).toBeNull();
    expect(failures).toEqual(['invalid response']);
  });

  test('сетевая ошибка: null', async () => {
    const failures: string[] = [];
    const reader = new HttpPriceSpotReader({
      baseUrl: 'http://docs.test',
      onFailure: (reason) => failures.push(reason),
      fetchFn: async () => {
        throw new TypeError('connection refused');
      },
    });
    expect(await reader.read({ name: 'a.pptx', bytes: BYTES })).toBeNull();
    expect(failures).toHaveLength(1);
  });

  test('сбой самого журнала не выходит наружу', async () => {
    const reader = new HttpPriceSpotReader({
      baseUrl: 'http://docs.test',
      onFailure: () => {
        throw new Error('журнал недоступен');
      },
      fetchFn: async () => new Response('x', { status: 500 }),
    });
    expect(await reader.read({ name: 'a.pptx', bytes: BYTES })).toBeNull();
  });
});
