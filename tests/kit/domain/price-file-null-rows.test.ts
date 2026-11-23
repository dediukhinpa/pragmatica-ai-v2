import { describe, expect, test } from 'bun:test';
import {
  matchedNullRowKeys,
  planSourceReplacement,
} from '../../../src/kit/domain/price-file-stream';

/** Этап 117: строки без файла и история импортов поставщика. */
describe('planSourceReplacement: строки без файла и история', () => {
  const MEDALS = 'Ф/Медали_01.09.2026.xlsx';
  const MEDALS_NEW = 'Ф/Медали_01.10.2026.xlsx';
  const BADGES = 'Ф/Значки.xlsx';

  test('истории нет и совпадения нет - строки без файла не трогаются (этап 123)', () => {
    expect(planSourceReplacement([null], MEDALS).replaceNull).toBe(false);
    expect(planSourceReplacement([null], MEDALS, []).replaceNull).toBe(false);
  });

  test('в истории только сам входящий файл - не доказательство', () => {
    expect(planSourceReplacement([null], MEDALS, [MEDALS]).replaceNull).toBe(false);
  });

  test('история указывает на другой поток - строки без файла не трогаются', () => {
    expect(planSourceReplacement([null], MEDALS, [BADGES]).replaceNull).toBe(false);
    expect(planSourceReplacement([null], MEDALS, [BADGES, MEDALS]).replaceNull).toBe(false);
  });

  test('история указывает на тот же поток (другая версия) - заменяются', () => {
    expect(planSourceReplacement([null], MEDALS_NEW, [MEDALS]).replaceNull).toBe(true);
    expect(planSourceReplacement([null], MEDALS_NEW, [BADGES, MEDALS]).replaceNull).toBe(true);
  });

  test('sha256 файла найден в import_key - заменяются все, даже без истории', () => {
    expect(planSourceReplacement([null], MEDALS, [], true).replaceNull).toBe(true);
    expect(planSourceReplacement([null], MEDALS, [BADGES], true).replaceNull).toBe(true);
  });

  test('есть строки с файлом - строки без файла не заменяются при любой истории', () => {
    expect(planSourceReplacement([null, BADGES], MEDALS, [MEDALS]).replaceNull).toBe(false);
  });
});

describe('matchedNullRowKeys: построчная пара старой и новой позиции', () => {
  const row = (productName: string, sku?: string) => ({ productName, ...(sku ? { sku } : {}) });

  test('пара по названию без учёта регистра', () => {
    const keys = matchedNullRowKeys([row('Мешок А'), row('Мешок Б')], [row('мешок а'), row('Новинка')]);
    expect([...keys]).toHaveLength(1);
  });

  test('пара по артикулу при разных названиях', () => {
    expect(matchedNullRowKeys([row('Старое имя', 'A-1')], [row('Новое имя', 'a-1')]).size).toBe(1);
  });

  test('другая линия: пар нет', () => {
    expect(matchedNullRowKeys([row('Сумка 1'), row('Сумка 2')], [row('Мешок 1')]).size).toBe(0);
  });

  test('пустые наборы пар не дают', () => {
    expect(matchedNullRowKeys([], [row('Мешок')]).size).toBe(0);
    expect(matchedNullRowKeys([row('Мешок')], []).size).toBe(0);
  });
});
