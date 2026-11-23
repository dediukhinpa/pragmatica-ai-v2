import { describe, expect, test } from 'bun:test';
import {
  createPriceFileSupplierMatcher,
  matchSupplierByPath,
  normalizeNameForPath,
} from '../../../src/kit/domain/price-file-supplier';

const SUPPLIERS = [
  { id: 's1', name: 'ООО «МеталлТорг»' },
  { id: 's2', name: 'Болтик' },
  { id: 's3', name: 'ИП Ёлкин' },
  { id: 'short', name: 'ООО Ап' },
];

describe('normalizeNameForPath', () => {
  test('нижний регистр, ё, кавычки, юрформы и пунктуация', () => {
    expect(normalizeNameForPath('ООО «МеталлТорг»')).toBe('металлторг');
    expect(normalizeNameForPath('ИП Ёлкин А.В.')).toBe('елкин а в');
    expect(normalizeNameForPath('ТД "Крепёж-Сервис", ЗАО')).toBe('крепеж сервис');
  });
});

describe('matchSupplierByPath', () => {
  test('по имени папки', () => {
    expect(matchSupplierByPath('Металл/МеталлТорг/прайс.xlsx', [], SUPPLIERS)).toEqual({
      kind: 'matched',
      supplierId: 's1',
      by: 'name',
    });
  });

  test('по имени файла без расширения, ё = е, регистр и разделители', () => {
    expect(matchSupplierByPath('Крепёж/ёлкин_прайс-2025.XLSX', [], SUPPLIERS)).toEqual({
      kind: 'matched',
      supplierId: 's3',
      by: 'name',
    });
    expect(matchSupplierByPath('БОЛТИК.csv', [], SUPPLIERS)).toMatchObject({ supplierId: 's2' });
  });

  test('история импортов важнее имени', () => {
    const history = [{ supplierId: 's2', fileName: 'Металл/МеталлТорг/прайс.xlsx' }];
    expect(matchSupplierByPath('Металл/МеталлТорг/прайс.xlsx', history, SUPPLIERS)).toEqual({
      kind: 'matched',
      supplierId: 's2',
      by: 'history',
    });
  });

  test('разные поставщики в истории одного пути - ambiguous', () => {
    const history = [
      { supplierId: 's2', fileName: 'a.xlsx' },
      { supplierId: 's1', fileName: 'a.xlsx' },
      { supplierId: 's1', fileName: 'a.xlsx' },
    ];
    expect(matchSupplierByPath('a.xlsx', history, SUPPLIERS)).toEqual({
      kind: 'ambiguous',
      supplierIds: ['s1', 's2'],
    });
  });

  test('два поставщика в пути - ambiguous', () => {
    expect(matchSupplierByPath('Болтик/МеталлТорг.xlsx', [], SUPPLIERS)).toEqual({
      kind: 'ambiguous',
      supplierIds: ['s1', 's2'],
    });
  });

  test('имя целиком в имени другого: выбирается более длинное', () => {
    const suppliers = [
      { id: 'a', name: 'Альфа' },
      { id: 'b', name: 'Альфа Металл' },
    ];
    expect(matchSupplierByPath('Альфа Металл/прайс.xlsx', [], suppliers)).toMatchObject({
      kind: 'matched',
      supplierId: 'b',
    });
    expect(matchSupplierByPath('Альфа/прайс.xlsx', [], suppliers)).toMatchObject({
      supplierId: 'a',
    });
  });

  test('совпадение только целыми словами, короткие имена не участвуют', () => {
    const suppliers = [{ id: 'm', name: 'Металл' }, ...SUPPLIERS];
    expect(matchSupplierByPath('МеталлТорг/прайс.xlsx', [], suppliers)).toMatchObject({
      supplierId: 's1',
    });
    expect(matchSupplierByPath('Ап/прайс.xlsx', [], SUPPLIERS)).toEqual({ kind: 'none' });
  });

  test('нет совпадений - none', () => {
    expect(matchSupplierByPath('Разное/старый.xlsx', [], SUPPLIERS)).toEqual({ kind: 'none' });
    expect(matchSupplierByPath('x.xlsx', [], [])).toEqual({ kind: 'none' });
  });
});

describe('createPriceFileSupplierMatcher (R6-06-01)', () => {
  const suppliers = [
    { id: 'a', name: 'Альфа' },
    { id: 'am', name: 'ООО «Альфа Металл»' },
    { id: 'tw1', name: 'Двойник Опт' },
    { id: 'tw2', name: 'Двойник Опт' },
    ...SUPPLIERS,
  ];
  const history = [
    { supplierId: 's2', fileName: 'Разное/f1.xlsx' },
    { supplierId: 's1', fileName: 'Спор/f2.xlsx' },
    { supplierId: 's3', fileName: 'Спор/f2.xlsx' },
  ];
  const paths = [
    'Склад/Альфа/прайс.xlsx',
    'Склад/Альфа Металл/прайс.xlsx',
    'Альфастрой/прайс.xlsx',
    'Двойник Опт/x.csv',
    'Металл/МеталлТорг/прайс.xlsx',
    'Разное/f1.xlsx',
    'Спор/f2.xlsx',
    'Ап/прайс.xlsx',
    'Нет/совпадений.xlsx',
  ];

  test('один сопоставитель на много путей даёт то же, что отдельный вызов на путь', () => {
    const match = createPriceFileSupplierMatcher(history, suppliers);
    for (const path of paths) {
      expect(match(path)).toEqual(matchSupplierByPath(path, history, suppliers));
    }
    expect(match('Склад/Альфа/прайс.xlsx')).toEqual({
      kind: 'matched',
      supplierId: 'a',
      by: 'name',
    });
    // Длинное имя перекрывает короткое, одинаковые имена неоднозначны, история главнее имён.
    expect(match('Склад/Альфа Металл/прайс.xlsx')).toMatchObject({ supplierId: 'am' });
    expect(match('Двойник Опт/x.csv')).toEqual({ kind: 'ambiguous', supplierIds: ['tw1', 'tw2'] });
    expect(match('Спор/f2.xlsx')).toEqual({ kind: 'ambiguous', supplierIds: ['s1', 's3'] });
    expect(match('Разное/f1.xlsx')).toEqual({ kind: 'matched', supplierId: 's2', by: 'history' });
    expect(match('Альфастрой/прайс.xlsx')).toEqual({ kind: 'none' });
  });
});
