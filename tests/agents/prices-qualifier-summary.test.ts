import { describe, expect, test } from 'bun:test';
import { buildInitialImportSummary } from '../../src/agents/prices/initial-import-summary';

const outcome = (file: string, extra: Record<string, number>) => ({
  run: 'r1',
  file,
  status: 'written' as const,
  rows: 10,
  at: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('сводка первичного импорта: цена словами', () => {
  test('считает «от», диапазоны и тиражи из ячейки по всем файлам', () => {
    const text = buildInitialImportSummary(
      [
        outcome('a.xlsx', { fromRows: 2, rangeRows: 1 }),
        outcome('b.xlsx', { fromRows: 1, cellTierRows: 4 }),
      ],
      false,
    );
    expect(text).toContain(
      'Из записанных позиций с ценой словами: цена «от»: 3, диапазон цен: 1, ' +
        'тираж из ячейки цены: 4.',
    );
  });

  test('без таких позиций строки нет', () => {
    const text = buildInitialImportSummary([outcome('a.xlsx', {})], false);
    expect(text).not.toContain('ценой словами');
  });
});
