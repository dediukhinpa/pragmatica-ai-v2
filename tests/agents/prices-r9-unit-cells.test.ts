import { describe, expect, test } from 'bun:test';
import { parsePriceCell, parseTableRows } from '../../src/agents/prices/table-rows';
import { parseNumberText } from '../../src/kit/domain/number-text';

/**
 * R9-A1-09: цена с единицей в ячейке («100 руб./шт») и цифровой пробел U+2007 как разделитель
 * групп разбираются; цена за несколько единиц («/1000 шт», «/тыс. шт») - по-прежнему нет.
 */

describe('R9-A1-09: единица после цены', () => {
  test.each([
    ['100 руб./шт', 100, 'RUB'],
    ['1 200 ₽/м', 1200, 'RUB'],
    ['1200 р/кг', 1200, 'RUB'],
    ['100 руб. / уп.', 100, 'RUB'],
    ['100 руб./пог. м', 100, 'RUB'],
    ['12,5 €/m³', 12.5, 'EUR'],
    ['25 $/kg', 25, 'USD'],
  ])('«%s» -> %d %s', (cell, value, currency) => {
    expect(parsePriceCell(cell)).toEqual({ kind: 'ok', value, currency });
  });

  test('без валюты: «50/м2», «100/пара»', () => {
    expect(parsePriceCell('50/м2')).toEqual({ kind: 'ok', value: 50, currency: undefined });
    expect(parsePriceCell('100/пара')).toEqual({ kind: 'ok', value: 100, currency: undefined });
  });

  test('цена за несколько единиц и не цена - не разбираются', () => {
    for (const cell of [
      '100 руб/1000 шт',
      '100 руб./тыс. шт',
      '100 руб./тыс.шт',
      '5 $/k',
      '1/2',
      '/шт',
      'abc/шт',
      'по запросу/шт',
    ]) {
      expect(parsePriceCell(cell).kind).toBe('invalid');
    }
  });

  test('строка с единицей - позиция, импорт не блокируется', () => {
    const rows = parseTableRows(
      [
        ['Наименование', 'Цена'],
        ['Труба', '1 200 ₽/м'],
        ['Болт', '100 руб./шт'],
      ],
      {
        supplierId: 's',
        headerRows: 1,
        columns: { name: 0, price: 1 },
        defaultCurrency: 'RUB',
        date: '2026-10-01T00:00:00.000Z',
      },
    );
    expect(rows.rejected).toEqual([]);
    expect(rows.items.map((item) => item.price)).toEqual([1200, 100]);
  });
});

describe('R9-A1-09: цифровой пробел U+2007', () => {
  test('разделитель групп разрядов', () => {
    expect(parseNumberText('1 234')).toEqual({ kind: 'ok', value: 1234 });
    expect(parsePriceCell('1 234 567,50 руб.')).toEqual({
      kind: 'ok',
      value: 1234567.5,
      currency: 'RUB',
    });
    // Правило групп по три то же: «12 3» - не число.
    expect(parseNumberText('12 3').kind).toBe('invalid');
  });
});
