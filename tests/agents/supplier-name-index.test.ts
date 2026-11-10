import { describe, expect, test } from 'bun:test';
import { buildSupplierNameIndex, nameTokens } from '../../src/agents/shared/supplier-name-index';
import type { Supplier } from '../../src/kit/domain/models';

function supplier(id: string, name: string): Supplier {
  return { id, name };
}

function namesFound(names: string[], text: string): string[] {
  const index = buildSupplierNameIndex(names.map((name, at) => supplier(`s${at}`, name)));
  return index.find(text).map((item) => item.name);
}

describe('сопоставление названия поставщика с текстом', () => {
  test('ядро названия: регистр, ё, кавычки, организационная форма', () => {
    expect(nameTokens('ООО «Ёлочка» (опт)')).toEqual(['елочка', 'опт']);
  });

  test('орг. форма и кавычки не мешают: ООО «Ромашка» = Ромашка', () => {
    expect(namesFound(['ООО «Ромашка»'], 'С уважением, Ромашка')).toEqual(['ООО «Ромашка»']);
    expect(namesFound(['Ромашка'], 'ИП "Ромашка" сообщает')).toEqual(['Ромашка']);
  });

  test('дефис, тире и пробел одинаковы', () => {
    expect(namesFound(['Сувенир-Маркет'], 'Компания Сувенир Маркет')).toHaveLength(1);
    expect(namesFound(['Сувенир Маркет'], 'Сувенир—Маркет, Москва')).toHaveLength(1);
  });

  test('склонение у названия из одного слова', () => {
    for (const text of ['у Ромашки', 'Ромашке', 'с Ромашкой', 'Ромашками']) {
      expect(namesFound(['Ромашка'], text)).toHaveLength(1);
    }
    expect(namesFound(['Ромашка'], 'ромашковый чай')).toEqual([]);
  });

  test('порядок слов не важен, но слова рядом', () => {
    expect(namesFound(['Альфа Снабжение'], 'Снабжение Альфа')).toHaveLength(1);
    const far = 'Альфа ' + 'слово '.repeat(10) + 'Снабжение';
    expect(namesFound(['Альфа Снабжение'], far)).toEqual([]);
  });

  test('границы слов: часть слова не считается', () => {
    expect(namesFound(['Альфа'], 'Альфред')).toEqual([]);
    expect(namesFound(['Норд'], 'Нордик')).toEqual([]);
  });

  test('короткие и общие названия не ищутся', () => {
    expect(buildSupplierNameIndex([supplier('1', 'АБВ'), supplier('2', 'ООО Торг')]).size).toBe(0);
    expect(namesFound(['Опт', 'Снаб', 'Торг Опт'], 'Опт Снаб Торг опт')).toEqual([]);
  });
});
