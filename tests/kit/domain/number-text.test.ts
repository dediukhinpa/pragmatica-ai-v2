import { describe, expect, test } from 'bun:test';
import { parseNumberText } from '../../../src/kit/domain/number-text';

describe('parseNumberText', () => {
  test('однозначные форматы', () => {
    expect(parseNumberText('15')).toEqual({ kind: 'ok', value: 15 });
    expect(parseNumberText('15.5')).toEqual({ kind: 'ok', value: 15.5 });
    expect(parseNumberText('15,5')).toEqual({ kind: 'ok', value: 15.5 });
    expect(parseNumberText('0,125')).toEqual({ kind: 'ok', value: 0.125 });
    expect(parseNumberText('0.125')).toEqual({ kind: 'ok', value: 0.125 });
    expect(parseNumberText('1 234,50')).toEqual({ kind: 'ok', value: 1234.5 });
    expect(parseNumberText('1 234,50')).toEqual({ kind: 'ok', value: 1234.5 });
    expect(parseNumberText('-7,5')).toEqual({ kind: 'ok', value: -7.5 });
    expect(parseNumberText('1,2345')).toEqual({ kind: 'ok', value: 1.2345 });
  });

  test('оба разделителя: последний - десятичный, первый - группы по три', () => {
    expect(parseNumberText('1.234,50')).toEqual({ kind: 'ok', value: 1234.5 });
    expect(parseNumberText('1,234.50')).toEqual({ kind: 'ok', value: 1234.5 });
    expect(parseNumberText('1.234.567,89')).toEqual({ kind: 'ok', value: 1234567.89 });
    expect(parseNumberText('1.23,50')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('1,234,56.7')).toEqual({ kind: 'invalid' });
  });

  test('повтор одного разделителя - только группы по три', () => {
    expect(parseNumberText('1.234.567')).toEqual({ kind: 'ok', value: 1234567 });
    expect(parseNumberText('1,234,567')).toEqual({ kind: 'ok', value: 1234567 });
    expect(parseNumberText('1.23.45')).toEqual({ kind: 'invalid' });
  });

  test('одна точка или запятая и ровно три цифры после - неоднозначно', () => {
    expect(parseNumberText('1,234')).toEqual({ kind: 'ambiguous' });
    expect(parseNumberText('1.234')).toEqual({ kind: 'ambiguous' });
    expect(parseNumberText('123,456')).toEqual({ kind: 'ambiguous' });
    expect(parseNumberText('1234,567')).toEqual({ kind: 'ok', value: 1234.567 });
    expect(parseNumberText('0,125')).toEqual({ kind: 'ok', value: 0.125 });
  });

  test('не число', () => {
    for (const text of ['', 'abc', '1e5', '1,', ',5', '1..2', '12abc', '--1', '1 2 3,4x']) {
      expect(parseNumberText(text)).toEqual({ kind: 'invalid' });
    }
  });

  test('R4-ALG-8: пробел допустим только как разделитель групп по три цифры', () => {
    expect(parseNumberText('10 20')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('100 120')).toEqual({ kind: 'ok', value: 100120 });
    expect(parseNumberText('12 3456')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('1\t234')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('12 500')).toEqual({ kind: 'ok', value: 12500 });
    expect(parseNumberText('1 234 567,89')).toEqual({ kind: 'ok', value: 1234567.89 });
    expect(parseNumberText('1\u00a0234,50')).toEqual({ kind: 'ok', value: 1234.5 });
    expect(parseNumberText('1\u2009234')).toEqual({ kind: 'ok', value: 1234 });
    expect(parseNumberText('1\u202f234 567')).toEqual({ kind: 'ok', value: 1234567 });
    expect(parseNumberText('1 23')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('1 2345')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('1 234,5 6')).toEqual({ kind: 'invalid' });
    expect(parseNumberText('12 500 ')).toEqual({ kind: 'ok', value: 12500 });
  });
});
