import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryFileAuthorship,
  type MemoryChatChannel,
  type MemoryFileSource,
} from '@business-ai/adapters';
import {
  MemoryPriceFileDateFallback,
} from '../../src/kit/adapters/memory/price-file-date-fallback';
import { PRICE_FILE_AUTHORSHIP_MAX_FILES } from '../../src/agents/prices/stale-price-recipients';
import { runStalePriceFilesCheck } from '../../src/agents/prices/stale-price-files';
import { type PricesDeps } from '../../src/agents/prices/deps';
import { buildFullPricesDeps, encode, type FullPricesDeps } from './prices-support';

const TZ = 'Europe/Moscow';
/** Понедельник 2026-10-12, 09:00 по Москве. */
const MONDAY_0900 = new Date('2026-10-12T06:00:00Z');
const BODY = encode('x');
/** Половина общего лимита чтений свойств уходит на вывод года, половина - адресатам. */
const YEAR_READ_LIMIT = PRICE_FILE_AUTHORSHIP_MAX_FILES / 2;
const NO_AUTHORS = { creator: null, lastModifiedBy: null, createdAt: null, modifiedAt: null };
const ms = (iso: string): number => new Date(iso).getTime();

let deps: FullPricesDeps;
let files: MemoryFileSource;
let chat: MemoryChatChannel;
let authorship: MemoryFileAuthorship;
let logs: Array<{ event: string; fields: Record<string, unknown> }>;

function check(): ReturnType<typeof runStalePriceFilesCheck> {
  const wired = {
    ...deps,
    authorship,
    log: (event: string, fields: Record<string, unknown>) => logs.push({ event, fields }),
  };
  return runStalePriceFilesCheck(wired as unknown as PricesDeps, { timezone: TZ });
}

function put(path: string, mtimeMs: number): void {
  files.put(path, BODY, mtimeMs);
}

const text = (): string => chat.outbox[0]?.message?.text ?? '';

beforeEach(async () => {
  deps = { ...(await buildFullPricesDeps()), clock: new FixedClock(MONDAY_0900) };
  files = deps.files as MemoryFileSource;
  chat = deps.chat;
  authorship = new MemoryFileAuthorship();
  logs = [];
});

describe('год для даты без года: источники по приоритету', () => {
  test('mtime: 31.12 у файла, сохранённого 10.01.2024, - 31.12.2023 с пометкой', async () => {
    put('Склад/Прайс Мельхиор 31.12.csv', ms('2024-01-10T09:00:00Z'));
    expect(await check()).toMatchObject({ status: 'sent', notified: 1, undated: 0 });
    expect(text()).toContain(
      '• Склад/Прайс Мельхиор 31.12.csv — 31.12.2023 (год по дате изменения файла)',
    );
    expect(text()).toContain('года нет: он выведен');
  });

  test('свойства документа важнее mtime', async () => {
    const path = 'Склад/Прайс Мельхиор 31.12.xlsx';
    put(path, ms('2026-10-10T09:00:00Z'));
    authorship.set(path, { ...NO_AUTHORS, modifiedAt: '2024-01-10T09:00:00Z' });
    await check();
    expect(text()).toContain('31.12.2023 (год по дате сохранения в свойствах файла)');
  });

  test('нет даты сохранения - берётся дата создания', async () => {
    const path = 'Склад/Прайс 31.12.xlsx';
    put(path, ms('2026-10-10T09:00:00Z'));
    authorship.set(path, { ...NO_AUTHORS, createdAt: '2022-02-01T09:00:00Z' });
    await check();
    expect(text()).toContain('31.12.2021 (год по дате сохранения в свойствах файла)');
  });

  test('год в пути важнее свойств и mtime; свойства при этом не читаются', async () => {
    const path = 'Склад/Прайсы 2023/Прайс 31.12.xlsx';
    put(path, ms('2026-10-10T09:00:00Z'));
    authorship.set(path, { ...NO_AUTHORS, modifiedAt: '2025-06-01T09:00:00Z' });
    await check();
    expect(text()).toContain('31.12.2023 (год по папке файла)');
    expect(authorship.calls).toBe(0);
  });

  test('сбой чтения свойств (сервис недоступен, битый файл) - следующий источник, mtime', async () => {
    put('Склад/Прайс A 31.12.xlsx', ms('2024-01-10T09:00:00Z'));
    put('Склад/Прайс B 31.12.docx', ms('2023-01-10T09:00:00Z'));
    authorship.setCorrupt('Прайс A 31.12.xlsx');
    authorship.failing = true;
    await check();
    expect(text()).toContain('Прайс A 31.12.xlsx — 31.12.2023 (год по дате изменения файла)');
    expect(text()).toContain('Прайс B 31.12.docx — 31.12.2022 (год по дате изменения файла)');
  });

  test('формат без свойств (csv, pdf) в сервис не отправляется', async () => {
    put('Склад/Прайс 31.12.pdf', ms('2024-01-10T09:00:00Z'));
    put('Склад/Прайс 31.12.csv', ms('2024-01-10T09:00:00Z'));
    await check();
    expect(authorship.calls).toBe(0);
  });
});

describe('год для даты без года: нет опоры и граничные случаи', () => {
  test('нет ни пути, ни свойств, ни mtime - файл в «без даты», а не «сегодня»', async () => {
    put('Склад/Прайс 11.10.xlsx', 0);
    expect(await check()).toMatchObject({ status: 'sent', notified: 1, undated: 1 });
    expect(text()).toContain('Дата в названии не найдена');
    expect(text()).not.toContain('11.10.2026');
  });

  test('mtime из будущего обрезается текущим моментом', async () => {
    // Часы файла впереди (2030): якорь - сейчас (2026-10-12), 11.10 - 2026-10-11, не устарел.
    put('Склад/Прайс 11.10.xlsx', ms('2030-01-01T00:00:00Z'));
    expect(await check()).toMatchObject({ status: 'nothing' });
    expect(chat.outbox).toHaveLength(0);
  });

  test('29 февраля при mtime 2025-03-01 - 29.02.2024', async () => {
    put('Склад/Прайс 29.02.csv', ms('2025-03-01T09:00:00Z'));
    await check();
    expect(text()).toContain('29.02.2024 (год по дате изменения файла)');
  });

  test('полная дата в названии: свойства не читаются, пометки нет', async () => {
    const path = 'Склад/Прайс 01.01.2024.xlsx';
    put(path, ms('2026-10-10T09:00:00Z'));
    await check();
    expect(authorship.calls).toBe(0);
    expect(text()).toContain('— 01.01.2024');
    expect(text()).not.toContain('(год по');
  });

  test('чтений свойств для года не больше половины лимита, остальные файлы - по mtime', async () => {
    const total = PRICE_FILE_AUTHORSHIP_MAX_FILES + 5;
    for (let i = 0; i < total; i += 1) {
      put(`Склад/Прайс ${String(i).padStart(3, '0')} 31.12.xlsx`, ms('2024-01-10T09:00:00Z'));
    }
    await check();
    expect(authorship.calls).toBe(YEAR_READ_LIMIT);
    const anchorLog = logs.find((line) => line.event === 'price_file_year_anchor');
    expect(anchorLog?.fields).toMatchObject({
      asked: total,
      unresolved: 0,
      propertyReads: YEAR_READ_LIMIT,
    });
  });

  test('в журнале только счётчики: путей и имён нет', async () => {
    put('Склад/Секретный поставщик 31.12.xlsx', ms('2024-01-10T09:00:00Z'));
    await check();
    expect(JSON.stringify(logs)).not.toContain('Секретный');
  });

  test('дата со словом месяца без года: модель получает год от опорной даты файла', async () => {
    put('Склад/Прайс_лошади 1 октября.csv', ms('2023-10-20T09:00:00Z'));
    const fallback = new MemoryPriceFileDateFallback(() => ({ year: 2023, month: 10, day: 1 }));
    const wired = { ...deps, authorship, priceDateFallback: fallback };
    await runStalePriceFilesCheck(wired as unknown as PricesDeps, { timezone: TZ });
    expect(text()).toContain('01.10.2023 (год по дате изменения файла)');
  });

  test('дата изменения до 2000 года не мешает: берётся дата создания', async () => {
    const path = 'Склад/Прайс 31.12.xlsx';
    put(path, ms('2026-10-10T09:00:00Z'));
    authorship.set(path, {
      ...NO_AUTHORS,
      modifiedAt: '1999-01-01T00:00:00Z',
      createdAt: '2022-02-01T09:00:00Z',
    });
    await check();
    expect(text()).toContain('31.12.2021 (год по дате сохранения в свойствах файла)');
  });

  test('чтения для года не съедают весь лимит адресатов', async () => {
    for (let i = 0; i < PRICE_FILE_AUTHORSHIP_MAX_FILES; i += 1) {
      put(`Склад/Прайс ${String(i).padStart(3, '0')} 11.10.xlsx`, ms('2026-10-10T09:00:00Z'));
    }
    await check();
    expect(authorship.calls).toBe(YEAR_READ_LIMIT);
  });
});
