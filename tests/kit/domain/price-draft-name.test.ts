import { describe, expect, test } from 'bun:test';
import { draftSupplierNameFromPath } from '../../../src/kit/domain/price-draft-name';

describe('draftSupplierNameFromPath', () => {
  test('имя файла без расширения, служебных слов и дат', () => {
    expect(draftSupplierNameFromPath('Металлы/Прайс МеталлТорг 12.10.2026.xlsx')).toBe(
      'МеталлТорг',
    );
    expect(draftSupplierNameFromPath('price_list_Acme_2026-10.csv')).toBe('Acme');
  });

  test('имя ничего не говорит - берётся ближайшая папка выше', () => {
    expect(draftSupplierNameFromPath('Поставщики/Ромашка ООО/Прайс 2026.xlsx')).toBe('Ромашка ООО');
    expect(draftSupplierNameFromPath('Альфа/прайс-лист.xlsx')).toBe('Альфа');
  });

  test('ничего осмысленного нет - null', () => {
    expect(draftSupplierNameFromPath('2026/10/прайс.xlsx')).toBeNull();
    expect(draftSupplierNameFromPath('')).toBeNull();
  });

  test('обратные слэши и пустые сегменты', () => {
    expect(draftSupplierNameFromPath('Гайки\\\\Крепёж-Плюс.xls')).toBe('Крепёж Плюс');
  });
});
