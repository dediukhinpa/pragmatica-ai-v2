import { describe, expect, test } from 'bun:test';
import {
  appendEmployeeText,
  canonicalFieldValue,
  normalizeEmployeeText,
  valueInEmployeeText,
} from '../../../src/kit/domain/employee-text';

const INN = '7707083893';

describe('сверка значений с текстом сообщений сотрудника', () => {
  test('нормализация: регистр, ё, пробелы', () => {
    expect(normalizeEmployeeText('  ООО  «Лёд»\n\tПлюс ')).toBe('ооо «лед» плюс');
  });

  test('цифровой реквизит: пробелы и дефисы внутри числа не мешают', () => {
    const text = normalizeEmployeeText('ИНН 7707 083893, КПП 77-36-01-001');
    expect(valueInEmployeeText('inn', INN, text)).toBe(true);
    expect(valueInEmployeeText('kpp', '773601001', text)).toBe(true);
    expect(valueInEmployeeText('inn', '77 07 08 38 93', normalizeEmployeeText(`инн ${INN}`))).toBe(
      true,
    );
  });

  test('правая граница при соединённых группах: хвост из цифр не засчитывается', () => {
    const inn = '7736050003';
    for (const tail of ['-12345', ' 12', '.50', ',50']) {
      expect(valueInEmployeeText('inn', inn, normalizeEmployeeText(`инн ${inn}${tail}`))).toBe(
        false,
      );
    }
    expect(valueInEmployeeText('inn', inn, normalizeEmployeeText(`инн ${inn}, КПП`))).toBe(true);
    expect(valueInEmployeeText('inn', inn, normalizeEmployeeText(`инн ${inn}.`))).toBe(true);
  });

  test('границы числа: ИНН не находится внутри более длинного числа', () => {
    const account = normalizeEmployeeText(`р/с 99${INN}99999999`);
    expect(valueInEmployeeText('inn', INN, account)).toBe(false);
    const prefix = normalizeEmployeeText(`номер ${INN}12`);
    expect(valueInEmployeeText('inn', INN, prefix)).toBe(false);
    expect(valueInEmployeeText('inn', INN, normalizeEmployeeText(`номер 12${INN}`))).toBe(false);
  });

  test('два соседних числа через пробел не склеиваются в чужое значение', () => {
    const text = normalizeEmployeeText('ИНН 7707083893 КПП 773601001');
    expect(valueInEmployeeText('inn', INN, text)).toBe(true);
    expect(valueInEmployeeText('kpp', '773601001', text)).toBe(true);
    expect(valueInEmployeeText('inn', '0838937736', text)).toBe(false);
  });

  test('текстовое значение: регистр и знаки препинания не важны, слова целиком', () => {
    const text = normalizeEmployeeText('Подписант — Сидоров Сергей Петрович, г. Тула');
    expect(valueInEmployeeText('directorName', 'сидоров сергей  ПЕТРОВИЧ', text)).toBe(true);
    expect(valueInEmployeeText('directorName', 'Сидоров Сергей Пет', text)).toBe(false);
    expect(valueInEmployeeText('legalAddress', 'г Тула', text)).toBe(true);
  });

  test('пустой текст и короткое значение не засчитываются', () => {
    expect(valueInEmployeeText('inn', INN, '')).toBe(false);
    expect(valueInEmployeeText('bankName', 'БКС', 'банк бкс')).toBe(false);
  });

  test('канонический вид и накопление с хвостом', () => {
    expect(canonicalFieldValue('inn', '7707 083-893')).toBe(INN);
    expect(appendEmployeeText('', 'Привет', 100)).toBe('привет');
    expect(appendEmployeeText('привет', 'Привет', 100)).toBe('привет');
    expect(appendEmployeeText('abcdef', 'ghi', 5)).toBe('ef\nghi'.slice(-5));
  });
});
