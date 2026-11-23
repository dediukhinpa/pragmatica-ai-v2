import { describe, expect, test } from 'bun:test';
import { hasYearlessDayMonth } from '../../../src/kit/domain/price-file-date';
import {
  resolveYearAnchor,
  yearAnchorDateKey,
  yearFromPath,
} from '../../../src/kit/domain/price-file-year-anchor';

const TZ = 'Europe/Moscow';
const NOW = new Date('2026-10-22T12:00:00+03:00');
const MS = (iso: string): number => new Date(iso).getTime();

describe('yearFromPath: год в каталогах пути', () => {
  const table: Array<[string, number | null]> = [
    ['Металл/2024/Прайс 31.12.xlsx', 2024],
    ['Прайсы 2023/Металл/Прайс.xlsx', 2023],
    ['Архив 2022/2024/Прайс.xlsx', 2024],
    ['2023-2024/Прайс.xlsx', 2024],
    ['C:\\Прайсы\\2021\\Прайс.xlsx', 2021],
    // Имя файла не смотрится.
    ['Металл/Прайс 2024.xlsx', null],
    ['Прайс.xlsx', null],
    // Год должен быть отдельным числом.
    ['Артикул 120245/Прайс.xlsx', null],
    ['v2024x/Прайс.xlsx', 2024],
    ['1999/Прайс.xlsx', null],
    ['2100/Прайс.xlsx', null],
  ];
  for (const [path, year] of table) {
    test(`${path} -> ${String(year)}`, () => expect(yearFromPath(path)).toBe(year));
  }
});

describe('resolveYearAnchor: приоритет источников', () => {
  test('путь важнее свойств и mtime; опора - конец года', () => {
    const anchor = resolveYearAnchor(
      {
        path: 'Металл/2023/Прайс 31.12.xlsx',
        savedAtIso: '2024-05-01T10:00:00Z',
        mtimeMs: MS('2025-01-01T00:00:00Z'),
      },
      NOW,
      TZ,
    );
    expect(anchor?.source).toBe('path');
    expect(anchor && yearAnchorDateKey(anchor, TZ)).toBe('2023-12-31');
  });

  test('конец года по поясу бизнеса: 31 декабря, а не 1 января', () => {
    const anchor = resolveYearAnchor({ path: '2023/Прайс.xlsx' }, NOW, TZ);
    expect(anchor && yearAnchorDateKey(anchor, TZ)).toBe('2023-12-31');
  });

  test('нет года в пути - дата сохранения из свойств', () => {
    const anchor = resolveYearAnchor(
      {
        path: 'Прайс.xlsx',
        savedAtIso: '2024-01-10T09:00:00Z',
        mtimeMs: MS('2025-01-01T00:00:00Z'),
      },
      NOW,
      TZ,
    );
    expect(anchor?.source).toBe('properties');
    expect(anchor?.at.toISOString()).toBe('2024-01-10T09:00:00.000Z');
  });

  test('свойств нет или дата не разбирается - mtime', () => {
    for (const savedAtIso of [null, undefined, 'не дата', '']) {
      const anchor = resolveYearAnchor(
        { path: 'Прайс.xlsx', savedAtIso, mtimeMs: MS('2024-01-10T09:00:00Z') },
        NOW,
        TZ,
      );
      expect(anchor?.source).toBe('mtime');
    }
  });

  test('дата свойств до 2000 года (нулевая дата офисных программ) пропускается', () => {
    const anchor = resolveYearAnchor(
      {
        path: 'Прайс.xlsx',
        savedAtIso: '1970-01-01T00:00:00Z',
        mtimeMs: MS('2024-01-10T09:00:00Z'),
      },
      NOW,
      TZ,
    );
    expect(anchor?.source).toBe('mtime');
  });

  test('ни пути, ни свойств, ни mtime - опорной даты нет', () => {
    expect(resolveYearAnchor({ path: 'Прайс.xlsx' }, NOW, TZ)).toBeNull();
    expect(resolveYearAnchor({ path: 'Прайс.xlsx', mtimeMs: Number.NaN }, NOW, TZ)).toBeNull();
    expect(resolveYearAnchor({ path: 'Прайс.xlsx', mtimeMs: 0 }, NOW, TZ)).toBeNull();
  });
});

describe('resolveYearAnchor: якорь в будущем обрезается текущим моментом', () => {
  test('mtime и свойства из будущего', () => {
    const mtime = resolveYearAnchor(
      { path: 'Прайс.xlsx', mtimeMs: MS('2030-01-01T00:00:00Z') },
      NOW,
      TZ,
    );
    expect(mtime?.at.getTime()).toBe(NOW.getTime());
    const saved = resolveYearAnchor(
      { path: 'Прайс.xlsx', savedAtIso: '2031-06-01T00:00:00Z' },
      NOW,
      TZ,
    );
    expect(saved?.at.getTime()).toBe(NOW.getTime());
  });

  test('год папки, который ещё не закончился (текущий или будущий)', () => {
    for (const path of ['2026/Прайс.xlsx', '2028/Прайс.xlsx']) {
      const anchor = resolveYearAnchor({ path }, NOW, TZ);
      expect(anchor?.source).toBe('path');
      expect(anchor?.at.getTime()).toBe(NOW.getTime());
    }
  });
});

describe('hasYearlessDayMonth: нужна ли опорная дата', () => {
  const table: Array<[string, boolean]> = [
    ['Прайс 31.12.xlsx', true],
    ['Прайс_01_07.xlsx', true],
    ['Прайс_29.02.xlsx', true],
    ['Прайс_28.10_от_01.09.2026.xlsx', false],
    ['Прайс_15.10.2026.xlsx', false],
    // мм-гг: год записан, опорная дата не нужна.
    ['Прайс_01-25.xlsx', false],
    ['Прайс_03.26.xlsx', false],
    ['Прайс_31.11.xlsx', false],
    ['Прайс_32.10.xlsx', false],
    ['price_v2.10.xlsx', false],
    ['Прайс.xlsx', false],
  ];
  for (const [name, expected] of table) {
    test(`${name} -> ${String(expected)}`, () => expect(hasYearlessDayMonth(name)).toBe(expected));
  }
});
