import { describe, expect, test } from 'bun:test';
import { parseExtraRowFields } from '../../src/agents/suppliers/import-row-fields';

/** Предел времени разбора длинной строки, мс (до исправления: десятки секунд). */
const MAX_PARSE_MS = 100;
const LONG_SPACES = 4000;
const LONG_ITEM = 5000;

const entitiesOf = (value: string) =>
  parseExtraRowFields((key) => (key === 'legalEntities' ? value : undefined)).fields
    .legalEntities;

describe('юрлица в строке импорта: разбор ИНН без ReDoS', () => {
  test('длинная строка с пробелами разбирается быстро', () => {
    const hostile = `a${' '.repeat(LONG_SPACES)}b`;
    const started = performance.now();
    const result = entitiesOf(hostile);
    expect(performance.now() - started).toBeLessThan(MAX_PARSE_MS);
    expect(result).toEqual([{ name: hostile }]);
  });

  test('очень длинный пункт с ИНН в конце не разбирается и не тормозит', () => {
    const item = `${'x'.repeat(LONG_ITEM)} 7707083893`;
    const started = performance.now();
    entitiesOf(item);
    expect(performance.now() - started).toBeLessThan(MAX_PARSE_MS);
  });

  test('обычные записи: «Название ИНН», скобки, слово ИНН, 12 цифр, без ИНН', () => {
    expect(entitiesOf('ООО Ромашка 7707083893')).toEqual([
      { name: 'ООО Ромашка', inn: '7707083893' },
    ]);
    expect(entitiesOf('ООО «Ромашка» (ИНН 7707083893)')).toEqual([
      { name: 'ООО «Ромашка»', inn: '7707083893' },
    ]);
    expect(entitiesOf('ИП Иванов, ИНН: 500100732259')).toEqual([
      { name: 'ИП Иванов', inn: '500100732259' },
    ]);
    expect(entitiesOf('ООО Ромашка ИНН№7707083893')).toEqual([
      { name: 'ООО Ромашка', inn: '7707083893' },
    ]);
    expect(entitiesOf('ООО Ларинн 7707083893')).toEqual([
      { name: 'ООО Ларинн', inn: '7707083893' },
    ]);
    expect(entitiesOf('Без ИНН')).toEqual([{ name: 'Без ИНН' }]);
    // 11 или 13 цифр - не ИНН.
    expect(entitiesOf('ООО Ромашка 77070838931')).toEqual([{ name: 'ООО Ромашка 77070838931' }]);
    expect(entitiesOf('7707083893')).toEqual([{ name: '7707083893' }]);
  });
});
