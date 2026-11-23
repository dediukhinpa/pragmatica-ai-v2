import { describe, expect, test } from 'bun:test';
import { applyScanEdits } from '../../src/scan-price-edits';
import {
  lineSum,
  nameMatches,
  parseNumberCell,
  parseNumberToken,
  readScanText,
  sumMoney,
} from '../../src/scan-price-lines';
import { DOUBTFUL_PRICE_LIST, MUG_INVOICE } from './scan-fixtures';

/** Разбор распознанного текста скана и арифметика кода (этап 9v). */

describe('числа скана', () => {
  test.each([
    ['250,00', 250],
    ['2500.5', 2500.5],
    ['10', 10],
  ])('«%s» -> %d', (token, value) => {
    expect(parseNumberToken(token)).toBe(value);
  });

  test('«1.200» неоднозначно и не угадывается, как и не число', () => {
    expect(parseNumberToken('1.200')).toBeNull();
    expect(parseNumberToken('???')).toBeNull();
  });

  test('ячейка с пробелами разрядов и валютой', () => {
    expect(parseNumberCell('2 500,00 руб.')).toBe(2500);
    expect(parseNumberCell('нечитаемо')).toBeNull();
  });

  test('копейки считаются целыми: 3 x 0,1 = 0,3 и сумма сумм без хвоста', () => {
    expect(lineSum(0.1, 3)).toBe(0.3);
    expect(lineSum(80.5, 5)).toBe(402.5);
    expect(sumMoney([0.1, 0.2, 0.3])).toBe(0.6);
  });
});

describe('позиции из текста скана-счёта', () => {
  test('3 позиции, шапка и реквизиты пропущены, итого из скана прочитано', () => {
    const reading = readScanText(MUG_INVOICE);
    expect(reading.lines.map((line) => line.name)).toEqual([
      'Кружка керамическая',
      'Блюдце фарфоровое',
      'Ложка чайная',
    ]);
    expect(reading.lines[0]).toMatchObject({ qty: 10, price: 250, sum: 2500, unit: 'шт' });
    expect(reading.lines[2]).toMatchObject({ qty: 5, price: 80.5, sum: 402.5 });
    expect(reading.lines.every((line) => line.doubts.length === 0)).toBe(true);
    expect(reading.statedTotal).toBe(5302.5);
  });

  test('разряды тысяч определяет арифметика: «250,00 2 500,00» - цена и сумма', () => {
    const [line] = readScanText('1 Кружка 10 шт 250,00 2 500,00').lines;
    expect(line).toMatchObject({ qty: 10, price: 250, sum: 2500 });
  });

  test('строка без единицы измерения: количество, цена, сумма по сошедшейся арифметике', () => {
    const [line] = readScanText('Кружка керамическая 3 100,00 300,00').lines;
    expect(line).toMatchObject({ qty: 3, price: 100, sum: 300, doubts: [] });
  });

  test('нечитаемая цена и несошедшаяся сумма - сомнения, а не угаданные числа', () => {
    const { lines } = readScanText(DOUBTFUL_PRICE_LIST);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatchObject({ price: null, doubts: ['price_unreadable'] });
    expect(lines[2]?.doubts).toEqual(['sum_mismatch']);
    expect(lines[0]?.doubts).toEqual([]);
    expect(lines[3]?.doubts).toEqual([]);
  });

  test('markdown-таблица с шапкой читается по столбцам', () => {
    const table = [
      '| Наименование | Кол-во | Цена | Сумма |',
      '|---|---|---|---|',
      '| Кружка керамическая | 10 | 250 | 2 500 |',
      '| Блюдце фарфоровое | 20 | 120 | 2 000 |',
    ].join('\n');
    const { lines } = readScanText(table);
    expect(lines[0]).toMatchObject({ qty: 10, price: 250, sum: 2500, doubts: [] });
    expect(lines[1]?.doubts).toEqual(['sum_mismatch']);
  });

  test('текст без позиций даёт пустой список', () => {
    expect(readScanText('Текст с фото: Подпись и печать').lines).toEqual([]);
  });
});

describe('поиск позиции по словам сотрудника', () => {
  test('«кружек» находит «Кружка керамическая», но не блюдце', () => {
    expect(nameMatches('Кружка керамическая', 'кружек')).toBe(true);
    expect(nameMatches('Блюдце фарфоровое', 'кружек')).toBe(false);
  });

  test('все слова запроса должны найтись', () => {
    expect(nameMatches('Кружка стеклянная', 'кружки керамические')).toBe(false);
    expect(nameMatches('Кружка керамическая', 'кружки керамические')).toBe(true);
  });
});

describe('правка цен и пересчёт', () => {
  const { lines } = readScanText(MUG_INVOICE);

  test('кружки на 239: сумма позиции и итого пересчитаны кодом', () => {
    const out = applyScanEdits(lines, [{ match: 'кружек', newPrice: 239 }]);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.rows[0]).toMatchObject({ oldPrice: 250, newPrice: 239, newSum: 2390 });
    expect(out.rows[1]).toMatchObject({ newPrice: 120, newSum: 2400, changed: false });
    expect(out.oldTotal).toBe(5302.5);
    expect(out.newTotal).toBe(5192.5);
    expect(out.doubtful).toEqual([]);
  });

  test('нет такой позиции: no_match со списком позиций', () => {
    const out = applyScanEdits(lines, [{ match: 'тарелка', newPrice: 1 }]);
    expect(out).toMatchObject({ status: 'no_match', names: expect.any(Array) });
  });

  test('несколько подходящих без applyToAll - вопрос, с applyToAll - все', () => {
    const many = readScanText(
      ['1 Кружка керамическая 1 шт 10,00 10,00', '2 Кружка стеклянная 1 шт 20,00 20,00'].join('\n'),
    ).lines;
    expect(applyScanEdits(many, [{ match: 'кружка', newPrice: 5 }]).status).toBe('ambiguous');
    const all = applyScanEdits(many, [{ match: 'кружка', newPrice: 5, applyToAll: true }]);
    expect(all).toMatchObject({ status: 'ok', newTotal: 10 });
  });

  test('сомнительную позицию код не правит и возвращает в doubtful; итог по прочитанному', () => {
    const doubtLines = readScanText(DOUBTFUL_PRICE_LIST).lines;
    const out = applyScanEdits(doubtLines, [{ match: 'кружка', newPrice: 239 }]);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.doubtful.map((item) => item.name)).toEqual([
      'Блюдце фарфоровое',
      'Ложка чайная',
    ]);
    // Сумма сомнительной позиции остаётся как в скане, не пересчитывается
    expect(out.rows[2]).toMatchObject({ newSum: 999, changed: false });
    expect(out.rows[1]).toMatchObject({ newPrice: null });
  });

  test('сомнительную позицию с ценой от сотрудника код пересчитывает: цену задал человек', () => {
    const doubtLines = readScanText(DOUBTFUL_PRICE_LIST).lines;
    const out = applyScanEdits(doubtLines, [{ match: 'блюдц', newPrice: 100 }]);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.rows[1]).toMatchObject({ newPrice: 100, newSum: 2000, doubts: [] });
  });
});
