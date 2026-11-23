import { beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentParser, ParsedDocument, ToolContext } from '@business-ai/core';
import { createPriceFileCopy } from '../../src/assembly/price-file-copy';
import { scalePriceText } from '../../src/assembly/price-text-scale';
import { parsePriceCell } from '../../src/agents/prices/table-rows';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * Копия прайса в xlsx, собранная кодом (этап 9t): большой docx с таблицей из ~200 строк, цены
 * текстом «140р», «190 р.», «800 рублей». Раньше копию собирала модель через createFile и не
 * справлялась с размером таблицы: ход заканчивался без текста.
 */

const FACTOR = 2.074;
const ROWS = 212;
const PRICE_TEXTS = ['140р', '190 р.', '800 рублей'] as const;
const AFTER_TEXTS = ['290р', '394 р.', '1659 рублей'] as const;

const BARE = { allowBare: false } as const;

describe('цена текстом: разбор проекта узнаёт форматы', () => {
  test.each([
    ['140р', 140],
    ['190 р', 190],
    ['190 р.', 190],
    ['800 рублей', 800],
    ['800 руб.', 800],
    ['140 Р', 140],
    ['1 200,50 руб.', 1200.5],
    ['140 ₽', 140],
  ])('«%s» - цена %d', (text, value) => {
    expect(parsePriceCell(text)).toMatchObject({ kind: 'ok', value, currency: 'RUB' });
  });
});

describe('масштабирование цены в тексте ячейки', () => {
  test.each([
    ['140р', '290р'],
    ['190 р.', '394 р.'],
    ['800 рублей', '1659 рублей'],
    ['190 р', '394 р'],
    ['800 руб.', '1659 руб.'],
    ['1 200 руб.', '2 489 руб.'],
    ['140 ₽', '290 ₽'],
  ])('«%s» x 2,074 -> «%s», остальной текст сохранён', (raw, expected) => {
    const outcome = scalePriceText(raw, { factor: FACTOR, ...BARE });
    expect(outcome).toMatchObject({ kind: 'scaled', cell: expected });
  });

  test('знаки после запятой как в исходной ячейке; decimals задаёт своё число', () => {
    expect(scalePriceText('1 200,50 руб.', { factor: 2, ...BARE })).toMatchObject({
      cell: '2 401,00 руб.',
    });
    expect(scalePriceText('140р', { factor: FACTOR, decimals: 2, ...BARE })).toMatchObject({
      cell: '290,36р',
    });
  });

  test('«от», диапазон и тираж не меняются, а перечисляются как пропущенные', () => {
    for (const raw of ['от 140р', '100-200р', 'от 100 шт 45 руб']) {
      expect(scalePriceText(raw, { factor: FACTOR, ...BARE }).kind).toBe('skipped');
    }
  });

  test('не цена: название, пустая ячейка, голое число без названного столбца', () => {
    for (const raw of ['Стекло 5 мм', '', '   ', '140']) {
      expect(scalePriceText(raw, { factor: FACTOR, ...BARE }).kind).toBe('ignored');
    }
  });

  test('голое число в названном столбце: число Excel, а не текст', () => {
    expect(scalePriceText('140', { factor: FACTOR, allowBare: true })).toMatchObject({
      kind: 'scaled',
      cell: 290,
    });
  });

  test('неоднозначное «1.200р» не угадывается', () => {
    expect(scalePriceText('1.200р', { factor: FACTOR, allowBare: true }).kind).toBe('skipped');
  });
});

/** Таблица прайса: шапка и 212 строк с ценой текстом (как в большом docx с картинками). */
function bigTable(): string[][] {
  const rows = Array.from({ length: ROWS }, (_, index): string[] => [
    '',
    `Стекло ${index}`,
    PRICE_TEXTS[index % PRICE_TEXTS.length] ?? '',
  ]);
  return [['Фото', 'Название', 'Цена'], ...rows];
}

function parserOf(tables: string[][][], names?: string[]): DocumentParser {
  return {
    async parse(): Promise<ParsedDocument> {
      return {
        text: '',
        tables,
        ...(names === undefined ? {} : { tableNames: names }),
        needsOcr: false,
        hasHiddenContent: false,
        hiddenSheets: [],
        truncated: false,
        warnings: [],
      };
    },
  };
}

let deps: FullPricesDeps;
let ctx: ToolContext;
let sentFiles: Array<{ thread: string; name: string; text: string }>;

/** Начало zip-архива: приём файлов сверяет содержимое с расширением. */
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

async function putDocx(): Promise<string> {
  const stored = await deps.intake.put(EMPLOYEE_THREAD, 'стекло прайс опт 2.docx', ZIP_HEAD);
  return stored.path;
}

beforeEach(() => {
  sentFiles = [];
});
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-copy', EMPLOYEE_THREAD);
  const realSend = deps.chat.sendFile.bind(deps.chat);
  deps.chat.sendFile = async (thread, file, key) => {
    sentFiles.push({
      thread,
      name: file.name,
      text: new TextDecoder().decode(file.content),
    });
    await realSend(thread, file, key);
  };
});

describe('createPriceFileCopy: большой docx, xlsx-копия собирается кодом', () => {
  test('212 строк с ценами текстом: копия отправлена целиком, цены x 2,074', async () => {
    const path = await putDocx();
    const out = await createPriceFileCopy.execute(
      { path, multiplier: FACTOR },
      { ...deps, parser: parserOf([bigTable()]) },
      ctx,
    );
    expect(out).toMatchObject({
      status: 'sent',
      delivered: true,
      sheets: 1,
      rows: ROWS,
      changed: ROWS,
      skippedCount: 0,
      changedColumns: ['Цена'],
    });
    expect(out.fileName).toBe('стекло прайс опт 2 (копия).xlsx');
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles[0]?.thread).toBe(EMPLOYEE_THREAD);
    const lines = (sentFiles[0]?.text ?? '').split('\n');
    // «# лист», шапка и все 212 строк: ничего не потеряно и не обрезано
    expect(lines).toHaveLength(ROWS + 2);
    expect(lines[2]).toBe(`;Стекло 0;${AFTER_TEXTS[0]}`);
    expect(lines[3]).toBe(`;Стекло 1;${AFTER_TEXTS[1]}`);
    expect(lines[4]).toBe(`;Стекло 2;${AFTER_TEXTS[2]}`);
    expect(sentFiles[0]?.text).not.toContain('140р');
  });

  test('то же через проценты: +107,4% - это x 2,074', async () => {
    const path = await putDocx();
    const out = await createPriceFileCopy.execute(
      { path, percent: 107.4 },
      { ...deps, parser: parserOf([bigTable()]) },
      ctx,
    );
    expect(out.changed).toBe(ROWS);
    expect(sentFiles[0]?.text).toContain(AFTER_TEXTS[0]);
  });

  test('без наценки: копия как есть, цены не меняются', async () => {
    const path = await putDocx();
    const out = await createPriceFileCopy.execute(
      { path },
      { ...deps, parser: parserOf([bigTable()]) },
      ctx,
    );
    expect(out).toMatchObject({ status: 'sent', changed: 0 });
    expect(sentFiles[0]?.text).toContain('140р');
  });

  test('«от» и диапазоны остаются как были и перечисляются', async () => {
    const path = await putDocx();
    const table = [
      ['Название', 'Цена'],
      ['A', '140р'],
      ['B', 'от 100р'],
      ['C', '100-200р'],
    ];
    const out = await createPriceFileCopy.execute(
      { path, multiplier: 2 },
      { ...deps, parser: parserOf([table]) },
      ctx,
    );
    expect(out.changed).toBe(1);
    expect(out.skippedCount).toBe(2);
    expect(out.skipped[0]?.place).toContain('строка 3');
    expect(sentFiles[0]?.text).toContain('от 100р');
  });

  test('названные столбцы: голые числа правятся, неизвестное название - вопрос', async () => {
    const path = await putDocx();
    const table = [
      ['Товар', 'Цена опт', 'Артикул'],
      ['A', '100', '12345'],
    ];
    const ok = await createPriceFileCopy.execute(
      { path, multiplier: 2, priceColumns: ['цена  ОПТ'] },
      { ...deps, parser: parserOf([table]) },
      ctx,
    );
    expect(ok.changed).toBe(1);
    expect(sentFiles[0]?.text).toContain('A;200;12345');
    const unknown = await createPriceFileCopy.execute(
      { path, multiplier: 3, priceColumns: ['Розница'] },
      { ...deps, parser: parserOf([table]) },
      ctx,
    );
    expect(unknown.status).toBe('unknown_column');
    expect(unknown.message).toContain('Цена опт');
    expect(sentFiles).toHaveLength(1);
  });

  test('нечего менять: файл не отправляется, причина понятна', async () => {
    const path = await putDocx();
    const table = [
      ['Товар', 'Размер'],
      ['A', '10x20'],
    ];
    const out = await createPriceFileCopy.execute(
      { path, multiplier: 2 },
      { ...deps, parser: parserOf([table]) },
      ctx,
    );
    expect(out.status).toBe('nothing_to_copy');
    expect(out.delivered).toBe(false);
    expect(sentFiles).toHaveLength(0);
  });

  test('слишком большая таблица: понятный отказ вместо сбоя', async () => {
    const path = await putDocx();
    const wide = [['Название', 'Цена'], ...Array.from({ length: 100_001 }, () => ['A', '1р'])];
    const out = await createPriceFileCopy.execute(
      { path, multiplier: 2 },
      { ...deps, parser: parserOf([wide]) },
      ctx,
    );
    expect(out.status).toBe('too_large');
    expect(out.message).toContain('Файл не отправлен');
    expect(sentFiles).toHaveLength(0);
  });

  test('несколько таблиц - несколько листов, имена листов уникальны', async () => {
    const path = await putDocx();
    const table = [['Название', 'Цена'], ['A', '10р']];
    const out = await createPriceFileCopy.execute(
      { path, multiplier: 2 },
      { ...deps, parser: parserOf([table, table], ['Стекло:1', 'Стекло:1']) },
      ctx,
    );
    expect(out.sheets).toBe(2);
    expect(sentFiles[0]?.text).toContain('# Стекло 1');
    expect(sentFiles[0]?.text).toContain('# Стекло 1 2');
  });

  test('multiplier и percent вместе - ошибка ввода', async () => {
    const path = await putDocx();
    await expect(
      createPriceFileCopy.execute(
        { path, multiplier: 2, percent: 10 },
        { ...deps, parser: parserOf([bigTable()]) },
        ctx,
      ),
    ).rejects.toThrow('либо multiplier, либо percent');
  });

  test('сбой доставки: ошибка с понятной причиной, «отправил» не говорится', async () => {
    const path = await putDocx();
    deps.chat.sendFile = async () => {
      throw new Error('канал недоступен');
    };
    await expect(
      createPriceFileCopy.execute(
        { path, multiplier: 2 },
        { ...deps, parser: parserOf([bigTable()]) },
        ctx,
      ),
    ).rejects.toThrow('Файл не доставлен');
  });
});
