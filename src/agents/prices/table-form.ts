import { sha256HexSync } from '@business-ai/core';

/**
 * Отпечаток формы таблицы (этап 111, тема 3): по нему сохранённый скрипт находит «свой» прайс.
 * В отпечаток входят число столбцов и нормализованные ячейки шапки с их позициями, а значений
 * данных нет: тот же прайс со свежими ценами даёт тот же отпечаток, другая шапка - другой.
 */

/** Сколько первых строк таблицы просматриваем в поисках шапки. */
const HEADER_SCAN_ROWS = 8;
/** Самая длинная ячейка шапки в отпечатке, символов (остальное не различает формы). */
const HEADER_CELL_MAX_CHARS = 60;
/** Ячейка из одного числа («1 250,50»): признак строки данных, а не шапки. */
const NUMBER_CELL = /^[-+]?\d[\d\s .,]*$/u;
const DIGITS = /\d+/gu;
const SPACES = /\s+/gu;
const DIGIT_MASK = '#';

function normalizeHeaderCell(cell: string): string {
  return cell
    .toLowerCase()
    .replace(SPACES, ' ')
    .trim()
    .replace(DIGITS, DIGIT_MASK)
    .slice(0, HEADER_CELL_MAX_CHARS);
}

function isDataRow(row: readonly string[]): boolean {
  return row.some((cell) => NUMBER_CELL.test(cell.trim()));
}

/**
 * Шапка одной таблицы: строки до первой строки с числом (не больше предела). Если шапки ещё
 * нет, первая строка с числами тоже берётся: это ступенчатая шапка («Наименование | 50 | 100»),
 * числа в ней идут масками `#` (значения не входят), иначе она давала бы тот же отпечаток,
 * что «Артикул | 10 | 20». Строки данных после шапки в отпечаток не попадают.
 */
function headerOf(table: readonly (readonly string[])[]): Array<Array<[number, string]>> {
  const header: Array<Array<[number, string]>> = [];
  for (const row of table.slice(0, HEADER_SCAN_ROWS)) {
    const numeric = isDataRow(row);
    if (numeric && header.length > 0) break;
    const cells: Array<[number, string]> = [];
    row.forEach((cell, index) => {
      // Ячейка-число целиком маскируется, текстовая нормализуется (цифры внутри тоже в маску).
      const text = NUMBER_CELL.test(cell.trim()) ? DIGIT_MASK : normalizeHeaderCell(cell);
      if (text !== '') cells.push([index, text]);
    });
    if (cells.length > 0) header.push(cells);
    if (numeric) break;
  }
  return header;
}

/** Ширина таблицы по шапке и первой строке данных. */
function widthOf(table: readonly (readonly string[])[]): number {
  return table.slice(0, HEADER_SCAN_ROWS + 1).reduce((max, row) => Math.max(max, row.length), 0);
}

/** SHA-256 (hex) формы таблиц файла: шапка и раскладка, без значений данных. */
export function tableFormFingerprint(tables: readonly (readonly (readonly string[])[])[]): string {
  const forms = tables
    .filter((table) => table.length > 0)
    .map((table) => ({ cols: widthOf(table), header: headerOf(table) }));
  return sha256HexSync(JSON.stringify(forms));
}
