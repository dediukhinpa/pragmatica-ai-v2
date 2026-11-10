import { describe, expect, test } from 'bun:test';
import { parsePrice, parsePriceCell, parseTableRows } from '../../src/agents/prices/table-rows';
import { formatPriceWithQualifier } from '../../src/kit/domain/market-price';
import { MemoryPriceRepository } from '../../src/kit/adapters/memory/repositories.owned';

const PARAMS = { supplierId: 's1', headerRows: 1, defaultCurrency: 'RUB', date: '2026-10-01' };
const HEAD = ['Наименование', 'Цена'];

describe('parsePriceCell: «от»', () => {
  test.each([
    ['от 500', 500, undefined],
    ['От 500', 500, undefined],
    ['от 500 руб', 500, 'RUB'],
    ['от 1 000,50 ₽', 1000.5, 'RUB'],
    ['от $12', 12, 'USD'],
  ])('%s', (raw, value, currency) => {
    expect(parsePriceCell(raw)).toEqual({ kind: 'ok', value, currency, qualifier: 'from' });
  });

  test('«от 500» не превращается в точную цену через parsePrice', () => {
    expect(parsePrice('от 500')).toBeNull();
    expect(parsePrice('500-700')).toBeNull();
    expect(parsePrice('от 100 шт 45 руб')).toBeNull();
    expect(parsePrice('500')).toBe(500);
  });
});

describe('parsePriceCell: диапазон', () => {
  test.each([
    ['500-700', 500, 700, undefined],
    ['500 - 700 руб.', 500, 700, 'RUB'],
    ['500–700', 500, 700, undefined],
    ['500—700', 500, 700, undefined],
    ['1 000 - 1 500 руб', 1000, 1500, 'RUB'],
    ['10,5-12,5', 10.5, 12.5, undefined],
    ['500-700 руб/шт', 500, 700, 'RUB'],
  ])('%s', (raw, value, max, currency) => {
    expect(parsePriceCell(raw)).toEqual({
      kind: 'ok',
      value,
      currency,
      qualifier: 'range',
      max,
    });
  });

  test.each([
    '01-02', // дата, начальный ноль
    '12-01', // верхняя граница меньше нижней
    '01.02-05.02', // даты день.месяц
    '15.02-20.02', // даты день.месяц без нулей
    '10-15 см', // размер
    '10-15 мм',
    '100-200 шт', // количество
    '01-05', // начальные нули
    '700-500', // M < N
    '500-500', // M = N
    'от 500-700', // «от» и диапазон вместе
    '500-700-900',
    '-500',
  ])('не диапазон цены: %s', (raw) => {
    expect(parsePriceCell(raw).kind).not.toBe('ok');
  });
});

describe('parsePriceCell: тираж и цена в одной ячейке', () => {
  test.each([
    ['от 100 шт 45 руб', 100, 45, 'RUB'],
    ['от 100 шт. - 45 р.', 100, 45, 'RUB'],
    ['от 1 000 штук 7,5 ₽', 1000, 7.5, 'RUB'],
    ['100 шт 45 руб/шт', 100, 45, 'RUB'],
  ])('%s', (raw, minQuantity, value, currency) => {
    expect(parsePriceCell(raw)).toEqual({ kind: 'ok', value, currency, minQuantity });
  });

  test('«от 500 шт» без цены - не цена', () => {
    expect(parsePriceCell('от 500 шт').kind).toBe('invalid');
    expect(parsePriceCell('от 500 шт.').kind).toBe('invalid');
  });

  test('неизвестная форма «9 - 9a9a9» не угадывается', () => {
    expect(parsePriceCell('100 - 50шт45р.').kind).toBe('invalid');
    expect(parsePriceCell('100 шт45р.').kind).toBe('invalid');
    expect(parsePriceCell('от 100 шт от 45 руб').kind).toBe('invalid');
  });
});

describe('parseTableRows: цена словами', () => {
  test('признак и верхняя граница попадают в позицию', () => {
    const out = parseTableRows(
      [HEAD, ['Ручка', 'от 500 руб'], ['Папка', '500 - 700'], ['Блок', '300']],
      { ...PARAMS, columns: { name: 0, price: 1 } },
    );
    expect(out.rejected).toEqual([]);
    expect(out.items[0]).toMatchObject({ price: 500, priceQualifier: 'from' });
    expect(out.items[0]?.priceMax).toBeUndefined();
    expect(out.items[1]).toMatchObject({ price: 500, priceQualifier: 'range', priceMax: 700 });
    expect(out.items[2]?.priceQualifier).toBeUndefined();
  });

  test('одна строка «500» и «от 500» - не дубли', () => {
    const out = parseTableRows([HEAD, ['Ручка', '500'], ['Ручка', 'от 500']], {
      ...PARAMS,
      columns: { name: 0, price: 1 },
    });
    expect(out.items).toHaveLength(2);
  });

  test('тираж из ячейки хранится массивом из одного элемента', () => {
    const out = parseTableRows([HEAD, ['Ручка', 'от 100 шт 45 руб']], {
      ...PARAMS,
      columns: { name: 0, price: 1 },
    });
    expect(out.items[0]).toMatchObject({
      price: 45,
      priceTiers: [{ minQuantity: 100, price: 45 }],
    });
    expect(out.items[0]?.priceQualifier).toBeUndefined();
  });

  test('«от 500 шт», даты и размеры уходят в rejected', () => {
    const out = parseTableRows(
      [HEAD, ['А', 'от 500 шт'], ['Б', '01-02'], ['В', '10-15 см'], ['Г', '100 - 50шт45р.']],
      { ...PARAMS, columns: { name: 0, price: 1 } },
    );
    expect(out.items).toEqual([]);
    expect(out.rejected.map((row) => row.row)).toEqual([1, 2, 3, 4]);
  });

  test('режим priceTiers: «от N шт P руб» - rejected, «от 500» хранится в тираже', () => {
    const columns = {
      name: 0,
      priceTiers: [
        { column: 1, minQuantity: 50 },
        { column: 2, minQuantity: 100 },
      ],
    };
    const out = parseTableRows(
      [
        ['Н', 'от 50 шт', 'от 100 шт'],
        ['А', 'от 50 шт 12 руб', '10'],
        ['Б', '12', 'от 10'],
        ['В', 'от 12', '10'],
        ['Г', '12', '10'],
      ],
      { ...PARAMS, columns },
    );
    // «От» в ячейке тиража допустимо (признак хранится в тираже); «от N шт» в ячейке - нет.
    expect(out.rejected.map((row) => row.row)).toEqual([1]);
    expect(out.items).toHaveLength(3);
    expect(out.items[0]?.priceTiers?.[1]).toEqual({
      minQuantity: 100,
      price: 10,
      qualifier: 'from',
    });
  });
});

describe('путь parse -> репозиторий -> показ', () => {
  test('признак доезжает до результата поиска и форматтера', async () => {
    const parsed = parseTableRows(
      [HEAD, ['Ручка шариковая', 'от 500'], ['Ручка гелевая', '500–700'], ['Ручка масляная', '9']],
      { ...PARAMS, columns: { name: 0, price: 1 } },
    );
    const repo = new MemoryPriceRepository();
    await repo.saveImport('s1', parsed.items, 'key-1' as never);
    const found = await repo.searchProducts('ручка', 10);
    const shown = found.map((item) =>
      formatPriceWithQualifier({
        amount: item.price,
        currency: item.currency,
        qualifier: item.priceQualifier,
        max: item.priceMax,
      }),
    );
    expect(shown.sort()).toEqual(['500–700 RUB', '9 RUB', 'от 500 RUB'].sort());
  });
});

describe('диапазон-годы не цена', () => {
  test('«2024-2025» не становится диапазоном цены', () => {
    expect(parsePriceCell('2024-2025').kind).toBe('invalid');
  });
});
