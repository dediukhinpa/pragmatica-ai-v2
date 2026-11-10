import { describe, expect, test } from 'bun:test';
import {
  productQueryWithoutPackaging,
  rankedSearchTokens,
  splitProductParts,
} from '../../../src/kit/domain/product-search';

describe('productQueryWithoutPackaging: уточнение о таре отделяется от товара', () => {
  test('«мёд в стеклянных банках» -> мёд', () => {
    expect(productQueryWithoutPackaging('Мёд в стеклянных банках')).toBe('мед');
  });

  test('мера после тары уходит вместе с ней', () => {
    expect(productQueryWithoutPackaging('орехи в пакете 1 кг')).toBe('орехи');
    expect(productQueryWithoutPackaging('мёд в банке 0,5 л')).toBe('мед');
  });

  test('слова товара после тары сохраняются', () => {
    expect(productQueryWithoutPackaging('Мёд в банках цветочный')).toBe('мед цветочный');
  });

  test('тубус, коробка, упаковка, пачка', () => {
    expect(productQueryWithoutPackaging('чертежи в тубусе')).toBe('чертежи');
    expect(productQueryWithoutPackaging('печенье в коробке')).toBe('печенье');
    expect(productQueryWithoutPackaging('кофе в подарочной упаковке')).toBe('кофе');
    expect(productQueryWithoutPackaging('чай в пачках')).toBe('чай');
  });

  test('вся позиция - сама тара: ищется как есть', () => {
    expect(productQueryWithoutPackaging('банка стеклянная 0,5 л')).toBe('банка стеклянная 0,5 л');
    expect(productQueryWithoutPackaging('Коробка для кружек')).toBe('Коробка для кружек');
    expect(productQueryWithoutPackaging('упаковка')).toBe('упаковка');
  });

  test('материал без тары - это товар, а не уточнение', () => {
    expect(productQueryWithoutPackaging('Кружка стеклянная')).toBe('Кружка стеклянная');
    expect(productQueryWithoutPackaging('ручка пластиковая')).toBe('ручка пластиковая');
  });

  test('набор и комплект - товар, не тара', () => {
    expect(productQueryWithoutPackaging('набор ручек')).toBe('набор ручек');
  });
});

describe('splitProductParts: несколько товаров в позиции', () => {
  test('«мёд и орехи» делится, запятая - как «и»', () => {
    expect(splitProductParts('мед и орехи')).toEqual(['мед', 'орехи']);
    expect(splitProductParts('Мёд, орехи')).toEqual(['мед', 'орехи']);
  });

  test('запятая в числе не делит; одна часть - как есть', () => {
    expect(splitProductParts('банка 0,5 л')).toEqual(['банка 0,5 л']);
    expect(splitProductParts('Мёд цветочный')).toEqual(['Мёд цветочный']);
  });

  test('часть без слова товара не делит позицию', () => {
    expect(splitProductParts('мёд и 5')).toEqual(['мёд и 5']);
  });
});

describe('rankedSearchTokens', () => {
  test('служебные слова и одиночные буквы убираются, длинные слова без окончания', () => {
    expect(rankedSearchTokens('мед и орехи для чая')).toEqual(['мед', 'орех', 'чая']);
  });

  test('короткий артикул остаётся', () => {
    expect(rankedSearchTokens('болт м8')).toEqual(['болт', 'м8']);
  });

  test('только служебные слова - как есть, не пусто', () => {
    expect(rankedSearchTokens('для')).toEqual(['для']);
  });
});
