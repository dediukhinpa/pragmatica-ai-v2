import { describe, expect, test } from 'bun:test';
import {
  significantProductTokens,
  wordStartMatches,
  wordStartShare,
} from '../../../src/kit/domain/product-search';

/** Ослабленный поиск по базе (этап 108): значимые слова и совпадение по началу слова. */

describe('significantProductTokens', () => {
  test('убирает предлоги, упаковку и числа; «ё» и окончания сворачиваются', () => {
    expect(significantProductTokens('мёд в банках')).toEqual(['мед']);
    expect(significantProductTokens('Орехи в банках, по 30 шт')).toEqual(['орех']);
    expect(significantProductTokens('набор: мёд липовый, упаковка')).toEqual(['мед', 'липовы']);
  });

  test('только упаковка и служебные слова - пусто, а не «всё подряд»', () => {
    expect(significantProductTokens('в банках')).toEqual([]);
    expect(significantProductTokens('набор 30 шт')).toEqual([]);
    expect(significantProductTokens('')).toEqual([]);
  });
});

describe('wordStartMatches', () => {
  test('короткое «мед» находит «Мёд», «Медовый», но не «Медаль», «Медный», «Комедия»', () => {
    expect(wordStartMatches('мед', 'Мёд липовый')).toBe(true);
    expect(wordStartMatches('мед', 'Медовый дом Деликатесы')).toBe(true);
    expect(wordStartMatches('мед', 'Мёд-липовый')).toBe(true);
    expect(wordStartMatches('мед', 'Медаль из стекла')).toBe(false);
    expect(wordStartMatches('мед', 'Медный провод')).toBe(false);
    expect(wordStartMatches('мед', 'Комедия')).toBe(false);
  });

  test('словоформы: «орех» - «орехи», «ореховый»; токен длиннее слова названия', () => {
    expect(wordStartMatches('орех', 'Лесной орех')).toBe(true);
    expect(wordStartMatches('орех', 'Орехи жареные')).toBe(true);
    expect(wordStartMatches('орех', 'Ореховая паста')).toBe(true);
    expect(wordStartMatches('липовы', 'Мёд липовый')).toBe(true);
    expect(wordStartMatches('орехов', 'Лесной орех')).toBe(true);
  });

  test('доля совпавших слов', () => {
    expect(wordStartShare(['мед', 'липовы'], 'Мёд цветочный')).toBe(0.5);
    expect(wordStartShare(['мед', 'липовы'], 'Мёд липовый')).toBe(1);
    expect(wordStartShare([], 'Мёд липовый')).toBe(0);
  });
});
