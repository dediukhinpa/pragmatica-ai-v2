import { describe, expect, test } from 'bun:test';
import { describeConflict, findItemConflicts, itemKeyOf } from '../../../src/kit/domain/item-data';

describe('findItemConflicts', () => {
  const key = itemKeyOf('ART-1', 'Болт');

  test('разные значения одного поля в двух источниках — расхождение, не среднее', () => {
    const conflicts = findItemConflicts([
      { itemKey: key, field: 'price', value: 50, source: 'прайс s1' },
      { itemKey: key, field: 'price', value: 55, source: 'письмо m1' },
      { itemKey: key, field: 'currency', value: 'RUB', source: 'прайс s1' },
      { itemKey: key, field: 'currency', value: 'rub', source: 'письмо m1' },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.values).toEqual([
      { value: 50, sources: ['прайс s1'] },
      { value: 55, sources: ['письмо m1'] },
    ]);
    expect(describeConflict(conflicts[0]!)).toBe('price: 50 (прайс s1) / 55 (письмо m1)');
  });

  test('одинаковые значения (с точностью до регистра и пробелов) расхождением не считаются', () => {
    expect(
      findItemConflicts([
        { itemKey: key, field: 'name', value: 'Болт  М8', source: 'a' },
        { itemKey: key, field: 'name', value: 'болт м8', source: 'b' },
      ]),
    ).toEqual([]);
  });

  test('ключ позиции: артикул важнее названия', () => {
    expect(itemKeyOf('  ART-1 ', 'x')).toBe(itemKeyOf('art-1', 'y'));
    expect(itemKeyOf(undefined, 'Болт  М8')).toBe('name:болт м8');
  });
});
