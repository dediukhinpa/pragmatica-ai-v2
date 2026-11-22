import { describe, expect, test } from 'bun:test';
import {
  SupplierIdentitySet,
  domainKeyOf,
  identityKeysOf,
  validInnOf,
} from '../../src/supplier-identity';

/** Синтетический ИНН юрлица с верной контрольной суммой (7707083893). */
const INN_OK = '7707083893';
/** Тот же ИНН с испорченной последней цифрой. */
const INN_BAD = '7707083894';

describe('идентичность поставщика', () => {
  test('ИНН становится ключом только с верной контрольной суммой', () => {
    expect(validInnOf(`ИНН ${INN_OK}`)).toBe(INN_OK);
    expect(validInnOf(INN_BAD)).toBeUndefined();
    expect(identityKeysOf({ inn: INN_BAD })).toEqual([]);
    expect(identityKeysOf({ inn: INN_OK })).toEqual([`inn:${INN_OK}`]);
  });

  test('домен сводится к регистрируемому и не зависит от www и пути', () => {
    expect(domainKeyOf('https://www.Toys-Shop.ru/catalog?x=1')).toBe('toys-shop.ru');
    expect(domainKeyOf('shop.toys-shop.ru')).toBe('toys-shop.ru');
    expect(domainKeyOf('')).toBeUndefined();
    expect(domainKeyOf(undefined)).toBeUndefined();
  });

  test('название нормализуется без формы собственности и кавычек', () => {
    const a = identityKeysOf({ name: 'ООО «Ёлочка-Опт»' });
    const b = identityKeysOf({ name: 'елочка-опт' });
    expect(a).toEqual(b);
    expect(identityKeysOf({ name: 'ИП' })).toEqual([]);
  });

  test('совпадение любого ключа - один поставщик, ключи объединяются', () => {
    const set = new SupplierIdentitySet();
    expect(set.add({ name: 'Ёлочка-Опт', url: 'https://elka-opt.ru' })).toBe(false);
    // Другое название, но тот же домен: известен.
    expect(set.has({ name: 'Совсем другое имя', url: 'http://www.elka-opt.ru/' })).toBe(
      true,
    );
    // Узнали по домену и принесли ИНН: теперь известен и по одному ИНН.
    expect(set.add({ name: 'Другое', url: 'elka-opt.ru', inn: INN_OK })).toBe(true);
    expect(set.has({ name: 'Третье', inn: INN_OK })).toBe(true);
    expect(set.has({ name: 'Не связанный поставщик', url: 'https://other-shop.ru' })).toBe(
      false,
    );
  });

  test('состояние переживает сохранение: toKeys/fromKeys', () => {
    const set = new SupplierIdentitySet();
    set.add({ name: 'Альфа-Пак', url: 'https://alfa-pak.ru', inn: INN_OK });
    const restored = SupplierIdentitySet.fromKeys(set.toKeys());
    expect(restored.has({ url: 'https://alfa-pak.ru/about' })).toBe(true);
    expect(restored.size).toBe(set.size);
  });
});
