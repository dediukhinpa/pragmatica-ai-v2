import { describe, expect, test } from 'bun:test';
import { outputFileName } from '../../src/agents/documents/render-data';
import { buildDocument } from './support';

const SUPPLIER = 'Акционерное общество «ТБанк»';
const nameFor = (number: string): string =>
  outputFileName(buildDocument({ kind: 'contract', supplierId: 's1', seller: SUPPLIER, number }));

describe('outputFileName (S-08)', () => {
  test('имя по названию компании: без формы собственности и кавычек', () => {
    expect(nameFor('15')).toBe('ТБанк_Договор_15.docx');
    expect(nameFor('1.5')).toBe('ТБанк_Договор_1.5.docx');
  });

  test('без настоящего номера хвост - дата документа, а без даты - никакого хвоста', () => {
    const base = { kind: 'contract', supplierId: 's1', seller: SUPPLIER, number: '' } as const;
    expect(outputFileName(buildDocument({ ...base, issuedAt: '2026-11-03' }))).toBe(
      'ТБанк_Договор_2026-11-03.docx',
    );
    expect(outputFileName(buildDocument({ ...base, issuedAt: '' }))).toBe('ТБанк_Договор.docx');
    const marker = buildDocument({ ...base, number: '[ЗАПОЛНИТЬ: номер]', issuedAt: '' });
    expect(outputFileName(marker)).toBe('ТБанк_Договор.docx');
  });

  test('документ без поставщика называется по покупателю; виды читаемые', () => {
    const doc = buildDocument({ kind: 'invoice', buyer: 'ООО «Ромашка»', number: '7' });
    expect(outputFileName({ ...doc, supplierId: undefined })).toBe('Ромашка_Счёт_7.docx');
  });

  test('`..` и разделители пути из номера модели заменяются', () => {
    for (const number of ['../../etc/passwd', '..\\..\\x', 'a/../b', '....//', 'a\u0000b']) {
      const name = nameFor(number);
      expect(name).not.toContain('..');
      expect(name).not.toMatch(/[\\/\u0000]/u);
      expect(name).toEndWith('.docx');
    }
  });

  test('пробелы и спецсимволы схлопываются в подчёркивание', () => {
    expect(nameFor('№ 5 : "A"')).toEndWith('_№_5_A.docx');
  });

  test('длинное название компании обрезается', () => {
    const long = `ООО «${'Очень длинное название '.repeat(5)}»`;
    const doc = buildDocument({ kind: 'contract', supplierId: 's1', seller: long });
    const name = outputFileName(doc);
    expect(name.length).toBeLessThan(80);
  });
});
