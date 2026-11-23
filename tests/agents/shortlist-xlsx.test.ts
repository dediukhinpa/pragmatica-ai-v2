import { describe, expect, test } from 'bun:test';
import {
  SHORTLIST_COLUMNS,
  buildShortlistSheets,
  sendShortlistXlsx,
  shortlistFileName,
} from '../../src/agents/order-calc/shortlist-xlsx';
import { DomainError } from '@business-ai/core';
import { type ShortlistProposal } from '../../src/kit/domain/shortlist';
import type { ChatFile, ExportedFile, TableExporter, TableSheet } from '@business-ai/core';

type Entry = ShortlistProposal['entries'][number];

function entry(n: number, extra: Partial<Entry> = {}): Entry {
  return {
    supplierId: `s${n}`,
    name: `Поставщик ${n}`,
    sources: ['knowledge'],
    score: 1,
    references: [],
    ...extra,
  };
}

function proposal(entries: Entry[]): ShortlistProposal {
  return {
    requestId: 'REQ-7',
    version: 'v1',
    createdAt: '2026-10-28T09:00:00.000Z',
    managerThreadId: 'mgr',
    entries,
    truncated: 2,
    compared: 20,
    sources: [],
  };
}

const FULL = entry(1, {
  city: 'Казань',
  address: 'ул. Складская, 5',
  contacts: 'Иванов, +70000000001',
  prices: [
    { amount: 60000, currency: 'RUB', unit: 'т', item: 'Арматура' },
    { amount: 62000, currency: 'RUB', unit: 'т', item: 'Арматура' },
    { amount: 5, currency: 'RUB', item: 'Шайба', approximate: true },
    { amount: 9, currency: 'RUB', item: 'Болт', tiers: [
      { minQuantity: 100, price: 8 },
      { minQuantity: 500, price: 7 },
    ] },
  ],
  leadTime: '3-5 дней',
  rating: 4.5,
  ratingSource: 'model',
  ratingRationale: 'давно работаем',
  references: ['doc-1', 'https://one.test/price'],
});
const WEB = entry(2, {
  sources: ['web'],
  webPrice: { amount: 61800, currency: 'RUB', unit: 'т' },
});
const DRAFT = entry(3, { noContacts: true });
const EMPTY = entry(4);

function column(sheet: TableSheet, name: string): readonly unknown[] {
  const index = (sheet.columns as readonly string[]).indexOf(name);
  return sheet.rows.map((row) => row[index]);
}

describe('buildShortlistSheets', () => {
  const sheets = buildShortlistSheets(proposal([FULL, WEB, DRAFT, EMPTY]));
  const [main, info] = sheets as [TableSheet, TableSheet];

  test('столбцы по ТЗ, строка на поставщика, ширина строк равна числу столбцов', () => {
    expect(main.columns).toEqual([...SHORTLIST_COLUMNS]);
    // Порядок колонок задан владельцем.
    expect([...SHORTLIST_COLUMNS]).toEqual([
      '№', 'Поставщик', 'Источник', 'Стоимость', 'Средняя/мин', 'Срок', 'Рейтинг',
      'Обоснование рейтинга', 'Город/адрес', 'Контакты', 'Сайт', 'Пометки',
    ]);
    expect(main.rows).toHaveLength(4);
    for (const row of main.rows) expect(row).toHaveLength(main.columns.length);
    expect(column(main, '№')).toEqual([1, 2, 3, 4]);
  });

  test('полная строка: все цены, среднее и мин, рейтинг, сайт', () => {
    const [row] = main.rows;
    const at = (name: string): unknown => row?.[(main.columns as readonly string[]).indexOf(name)];
    expect(at('Город/адрес')).toBe('Казань (ул. Складская, 5)');
    expect(String(at('Стоимость')).split('\n')).toHaveLength(4);
    expect(String(at('Стоимость'))).toContain('приблизительно');
    expect(String(at('Стоимость'))).toContain('Болт');
    expect(String(at('Средняя/мин'))).toContain('Арматура: ср.');
    expect(String(at('Средняя/мин'))).toContain('мин');
    // Приблизительная цена в среднее не входит.
    expect(String(at('Средняя/мин'))).not.toContain('Шайба');
    expect(at('Обоснование рейтинга')).toBe('оценка модели: давно работаем');
    expect(at('Сайт')).toBe('https://one.test/price');
  });

  test('веб-цена с пометкой «ИЗ ИНТЕРНЕТА»; черновик и «нет контактов» не помечаются', () => {
    expect(String(column(main, 'Стоимость')[1])).toContain('(ИЗ ИНТЕРНЕТА)');
    expect(String(column(main, 'Средняя/мин')[1])).toContain('мин');
    expect(column(main, 'Пометки')[2]).toBe('');
    expect(JSON.stringify(sheets)).not.toContain('нет контактов');
    expect(JSON.stringify(sheets)).not.toContain('не проверено, создана автоматически');
    expect(column(main, 'Пометки')[0]).toBe('');
  });

  test('колонки ТЗ без сведений - «нет данных», остальное пусто', () => {
    const empty = main.rows[3] ?? [];
    const at = (name: string): unknown => empty[(main.columns as readonly string[]).indexOf(name)];
    for (const name of ['Стоимость', 'Срок', 'Рейтинг', 'Город/адрес', 'Контакты']) {
      expect(at(name)).toBe('нет данных');
    }
    for (const name of ['Средняя/мин', 'Обоснование рейтинга', 'Сайт', 'Пометки']) {
      expect(at(name)).toBe('');
    }
    expect(JSON.stringify(sheets)).not.toContain('не указано');
  });

  test('лист заявки: номер, дата, сколько сравнено', () => {
    const dump = Object.fromEntries(info.rows.map((row) => [row[0], row[1]]));
    expect(dump['Заявка']).toBe('заявка');
    expect(dump['Дата']).toBe('28.10.2026');
    expect(dump['Сравнено кандидатов']).toBe(20);
    expect(dump['Средняя по базе']).toBe('Средняя цена по нашей базе: не рассчитывалась');
    expect(String(dump['Средняя по базе'])).not.toContain('[B]');
  });
});

describe('shortlistFileName', () => {
  test('имя по ТЗ и безопасные знаки', () => {
    expect(shortlistFileName('мёд с орехами')).toBe('Шорт-лист_мёд_с_орехами.xlsx');
    expect(shortlistFileName('a/b c')).toBe('Шорт-лист_a_b_c.xlsx');
  });
});

describe('sendShortlistXlsx', () => {
  function harness(exporter: TableExporter | undefined, enabled?: boolean) {
    const files: Array<{ threadId: string; file: ChatFile; key: string }> = [];
    const events: Array<[string, unknown]> = [];
    const deps = {
      chat: {
        sendFile: async (threadId: string, file: ChatFile, key: string) => {
          files.push({ threadId, file, key });
        },
      },
      log: (event: string, fields?: unknown) => events.push([event, fields]),
      ...(exporter === undefined ? {} : { tableExporter: exporter }),
      ...(enabled === undefined ? {} : { shortlistXlsxEnabled: enabled }),
    } as unknown as Parameters<typeof sendShortlistXlsx>[0];
    return { deps, files, events };
  }
  const okExporter = (calls: string[]): TableExporter => ({
    export: async (_sheets, format, fileName): Promise<ExportedFile> => {
      calls.push(`${format}:${fileName}`);
      return { fileName, mimeType: 'application/xlsx', bytes: new Uint8Array([1]) };
    },
  });
  const one = proposal([FULL]);

  test('отправляет файл в тред менеджера с ключом', async () => {
    const calls: string[] = [];
    const h = harness(okExporter(calls));
    expect(await sendShortlistXlsx(h.deps, 'mgr', one, 'k')).toBe('sent');
    expect(calls).toEqual(['xlsx:Шорт-лист_заявка.xlsx']);
    expect(h.files[0]?.threadId).toBe('mgr');
    expect(h.files[0]?.file.name).toBe('Шорт-лист_заявка.xlsx');
    expect(h.files[0]?.key).toBe('k:xlsx');
  });

  test('флаг выключен: ничего не делает', async () => {
    const calls: string[] = [];
    const h = harness(okExporter(calls), false);
    expect(await sendShortlistXlsx(h.deps, 'mgr', one, 'k')).toBe('disabled');
    expect(calls).toEqual([]);
    expect(h.files).toEqual([]);
  });

  test('нет порта выгрузки: без файла, событие в журнал, не падает', async () => {
    const h = harness(undefined);
    expect(await sendShortlistXlsx(h.deps, 'mgr', one, 'k')).toBe('unavailable');
    expect(h.files).toEqual([]);
    expect(h.events[0]?.[0]).toBe('shortlist_xlsx_unavailable');
  });

  test('выгрузка упала: без файла, событие с кодом, не падает', async () => {
    const h = harness({
      export: async () => {
        throw new DomainError('external_failure', 'documents down');
      },
    });
    expect(await sendShortlistXlsx(h.deps, 'mgr', one, 'k')).toBe('failed');
    expect(h.files).toEqual([]);
    expect(h.events[0]).toEqual([
      'shortlist_xlsx_failed',
      { requestId: 'REQ-7', code: 'external_failure' },
    ]);
  });

  test('пустой шорт-лист: файл не нужен', async () => {
    const h = harness(okExporter([]));
    expect(await sendShortlistXlsx(h.deps, 'mgr', proposal([]), 'k')).toBe('empty');
    expect(h.files).toEqual([]);
  });
});
