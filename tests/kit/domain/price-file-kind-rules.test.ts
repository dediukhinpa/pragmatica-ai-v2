import { describe, expect, test } from 'bun:test';
import { classifyPriceFileName } from '../../../src/kit/domain/price-file-kind';

describe('правила «не прайс» по названию: КП, сроки исполнения, «не актуален»', () => {
  test('КП отдельным словом (границы с учётом кириллицы, «_» - разделитель)', () => {
    expect(classifyPriceFileName('a/КП_сувениры из Китая.docx')).toBe('not_price');
    expect(classifyPriceFileName('a/Сувениры КП.docx')).toBe('not_price');
    expect(classifyPriceFileName('a/сувениры-кп-2025.xlsx')).toBe('not_price');
    expect(classifyPriceFileName('a/Коммерческое предложение Вьетнам.docx')).toBe('not_price');
  });

  test('КП: цифра не мешает, разделители «-», «.», пробел, «_»', () => {
    for (const name of ['КП-12.xlsx', 'КП.docx', 'КП5 Лето.xlsx', 'Лето.КП.xlsx', 'КП2024.xlsx']) {
      expect(classifyPriceFileName(`a/${name}`)).toBe('not_price');
    }
  });

  test('«Некоммерческое предложение» не ловится, «Коммерческое» - ловится', () => {
    expect(classifyPriceFileName('a/Некоммерческое предложение.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/Коммерческое предложение.xlsx')).toBe('not_price');
  });

  test('«кп» внутри слова не срабатывает', () => {
    expect(classifyPriceFileName('a/Окпд_товары.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/Ткпм.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/кпд.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/скп.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/ЗАО Мкп 2025.xlsx')).toBe('price');
  });

  test('КП и коммерческое предложение со словом «прайс» остаются прайсом', () => {
    expect(classifyPriceFileName('a/КП_прайс сувениры.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/Прайс КП_лето.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/Прайс (коммерческое предложение).xlsx')).toBe('price');
  });

  test('сроки исполнения - не прайс, со словом «прайс» - прайс', () => {
    expect(classifyPriceFileName('a/Сроки исполнения заказов ВИСТА 22_04_25.docx')).toBe(
      'not_price',
    );
    expect(classifyPriceFileName('a/Прайс и сроки исполнения.xlsx')).toBe('price');
  });

  test('«не актуален» и формы - не прайс всегда, даже со словом «прайс»', () => {
    for (const name of [
      'Прайс_ зарядники _ФлешИмперия не актуален _01_02_24.xlsx',
      'Прайс неактуален.xlsx',
      'Прайс_неактуальный.xlsx',
      'Прайс не актуальная версия.xlsx',
      'ПРАЙС НЕ АКТУАЛЕН.xlsx',
    ]) {
      expect(classifyPriceFileName(`a/${name}`)).toBe('not_price');
    }
  });

  test('обычный прайс и слова на «не» без «актуальн» остаются прайсом', () => {
    expect(classifyPriceFileName('a/Прайс актуальный 2026.xlsx')).toBe('price');
    expect(classifyPriceFileName('a/Прайс_Неон.xlsx')).toBe('price');
    // Пометка в названии папки не считается: только базовое имя.
    expect(classifyPriceFileName('не актуален/Прайс.xlsx')).toBe('price');
  });
});
