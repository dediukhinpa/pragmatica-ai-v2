import { describe, expect, test } from 'bun:test';
import { parsePriceCell } from '../../src/agents/prices/table-rows';
import { tablesToMarkdown } from '@business-ai/core';

/**
 * R8-D2-01: ячейка цены с длинным рядом пробелов не должна давать квадратичный откат
 * регулярных выражений (процесс ядра однопоточный).
 */

/** Предел времени разбора одной ячейки, мс. */
const TIME_LIMIT_MS = 50;
/** Максимум знаков в ячейке Excel. */
const EXCEL_CELL_MAX = 32_767;
const NBSP = ' ';

/** Время выполнения функции, мс. */
function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('R8-D2-01: parsePriceCell на длинной ячейке', () => {
  test('1234.50 + пробелы + «шт» (32 767 знаков) разбирается быстро', () => {
    const cell = `1234.50${' '.repeat(EXCEL_CELL_MAX - 10)}шт`;
    let result: unknown;
    const time = elapsedMs(() => {
      result = parsePriceCell(cell);
    });
    expect(result).toEqual({ kind: 'invalid' });
    expect(time).toBeLessThan(TIME_LIMIT_MS);
  });

  test('то же с неразрывными пробелами', () => {
    const cell = `1234.50${NBSP.repeat(EXCEL_CELL_MAX - 10)}шт`;
    let result: unknown;
    const time = elapsedMs(() => {
      result = parsePriceCell(cell);
    });
    expect(result).toEqual({ kind: 'invalid' });
    expect(time).toBeLessThan(TIME_LIMIT_MS);
  });

  test('3000 пробелов между числом и хвостом (замер из находки)', () => {
    const time = elapsedMs(() => parsePriceCell(`1234.50${' '.repeat(3000)}шт`));
    expect(time).toBeLessThan(TIME_LIMIT_MS);
  });

  const CASES: ReadonlyArray<readonly [string, unknown]> = [
    ['1234.50', { kind: 'ok', value: 1234.5, currency: undefined }],
    ['1 234,50', { kind: 'ok', value: 1234.5, currency: undefined }],
    ['100 руб.', { kind: 'ok', value: 100, currency: 'RUB' }],
    ['100     руб.', { kind: 'ok', value: 100, currency: 'RUB' }],
    [`100${NBSP}${NBSP}руб`, { kind: 'ok', value: 100, currency: 'RUB' }],
    ['1200 ¥', { kind: 'ok', value: 1200, currency: 'CNY' }],
    ['$100', { kind: 'ok', value: 100, currency: 'USD' }],
    ['USD 5', { kind: 'ok', value: 5, currency: 'USD' }],
    ['5 usd', { kind: 'ok', value: 5, currency: 'USD' }],
    ['0', { kind: 'zero' }],
    ['1,234', { kind: 'ambiguous' }],
    ['abc', { kind: 'invalid' }],
    ['12 шт', { kind: 'invalid' }],
    ['', { kind: 'invalid' }],
  ];
  test.each(CASES)('обычная цена %j разбирается как прежде', (raw, expected) => {
    expect(parsePriceCell(raw)).toEqual(expected as never);
  });
});

describe('R8-D2-01: tablesToMarkdown на длинном ряде пробелов', () => {
  test('ячейка из 32 767 пробелов нормализуется быстро', () => {
    const value = `a${' '.repeat(EXCEL_CELL_MAX)}b`;
    let out = '';
    const time = elapsedMs(() => {
      out = tablesToMarkdown([[[value]]]);
    });
    expect(out).toContain(`| 0 | a${' '.repeat(EXCEL_CELL_MAX)}b |`);
    expect(time).toBeLessThan(TIME_LIMIT_MS);
  });

  test('вывод прежний: перевод строки со смежными пробелами - один пробел, | экранируется', () => {
    const out = tablesToMarkdown([[['  a \n\t b|c  ', 'x\r\n  y', 'p \n \n q']]]);
    expect(out).toContain('| 0 | a b\\|c | x y | p q |');
  });
});
