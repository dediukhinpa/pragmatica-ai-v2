import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRICE_STALE_EXCLUDE_PATTERN,
  createPriceStaleScope,
  normalizePriceStalePrefix,
  validatePriceStalePattern,
} from '../../../src/kit/domain/price-stale-scope';
import {
  hasPriceWordInFileName,
  looksLikePriceTableText,
} from '../../../src/kit/domain/price-table-signal';

describe('область проверки прайсов', () => {
  test('без префиксов и исключений входит всё', () => {
    const scope = createPriceStaleScope({ prefixes: [] });
    expect(scope('zakupki/Архив/a.xlsx')).toBe(true);
  });

  test('префикс с границей по сегменту; слэши и регистр букв пути не мешают', () => {
    const scope = createPriceStaleScope({ prefixes: ['produkciya', '/sait\\'] });
    expect(scope('produkciya/1_Готовая/a.xlsx')).toBe(true);
    expect(scope('sait/a.xlsx')).toBe(true);
    expect(scope('produkciya2/a.xlsx')).toBe(false);
    expect(scope('zakupki/a.xlsx')).toBe(false);
  });

  test('исключение по сегментам без учёта регистра, в том числе по имени файла', () => {
    const scope = createPriceStaleScope({
      prefixes: [],
      excludePattern: DEFAULT_PRICE_STALE_EXCLUDE_PATTERN,
    });
    expect(scope('produkciya/АРХИВ/a.xlsx')).toBe(false);
    expect(scope('produkciya/Не брать 2020/a.xlsx')).toBe(false);
    expect(scope('produkciya/a/не брать.xlsx')).toBe(false);
    expect(scope('produkciya/a/прайс.xlsx')).toBe(true);
  });

  test('префикс и исключение вместе', () => {
    const scope = createPriceStaleScope({ prefixes: ['produkciya/'], excludePattern: 'архив' });
    expect(scope('produkciya/Архив/a.xlsx')).toBe(false);
    expect(scope('zakupki/a.xlsx')).toBe(false);
    expect(scope('produkciya/a.xlsx')).toBe(true);
  });

  test('файл-блокировка Office исключается всегда, по базовому имени', () => {
    const off = createPriceStaleScope({ prefixes: [] });
    expect(off('a/~$Прайс 01.01.2024.xlsx')).toBe(false);
    expect(off('~$x.xlsx')).toBe(false);
    expect(off('a\\~$x.xlsx')).toBe(false);
    const on = createPriceStaleScope({ prefixes: ['a/'], excludePattern: 'архив' });
    expect(on('a/~$Прайс.xlsx')).toBe(false);
    // Папка с «~$» в названии - не блокировка.
    expect(off('~$папка/Прайс.xlsx')).toBe(true);
    expect(off('a/Прайс~$.xlsx')).toBe(true);
  });

  test('нормализация префикса и проверка выражения', () => {
    expect(normalizePriceStalePrefix(' a\\b ')).toBe('a/b/');
    expect(normalizePriceStalePrefix(' / ')).toBe('');
    expect(validatePriceStalePattern('архив|не брать')).toBeNull();
    expect(validatePriceStalePattern('(')).not.toBeNull();
  });
});

describe('слово «прайс» в имени', () => {
  test('только базовое имя, не каталоги', () => {
    expect(hasPriceWordInFileName('a/Прайс-лист 2026.xlsx')).toBe(true);
    expect(hasPriceWordInFileName('a/price_list.xlsx')).toBe(true);
    expect(hasPriceWordInFileName('Прайсы/расчёт.xlsx')).toBe(false);
    expect(hasPriceWordInFileName('a/неприцайс.xlsx')).toBe(false);
  });
});

describe('признак «таблица цен» по тексту', () => {
  const rows = (n: number): string =>
    Array.from({ length: n }, (_, i) => `| Товар ${i} | ${1000 + i},50 |`).join('\n');

  test('слово о ценах и 5 строк таблицы - таблица цен', () => {
    expect(looksLikePriceTableText(`Цена за штуку\n${rows(5)}`)).toBe(true);
  });

  test('4 строки - ещё не таблица', () => {
    expect(looksLikePriceTableText(`Цена за штуку\n${rows(4)}`)).toBe(false);
  });

  test('строки есть, слова о ценах нет', () => {
    expect(looksLikePriceTableText(`Кабинеты\n${rows(8)}`)).toBe(false);
  });

  test('ячейки с валютой и пробелами в числе', () => {
    const text = `Прайс\n${Array.from({ length: 5 }, () => '| Болт | 1 200 руб. |').join('\n')}`;
    expect(looksLikePriceTableText(text)).toBe(true);
  });

  test('смотрятся только первые 4000 символов', () => {
    const text = `Цена\n${'x'.repeat(4000)}\n${rows(6)}`;
    expect(looksLikePriceTableText(text)).toBe(false);
  });

  test('«опт» только как отдельное слово: «оптовый» не считается', () => {
    expect(looksLikePriceTableText(`оптовый\n${rows(6)}`)).toBe(false);
    expect(looksLikePriceTableText(`опт\n${rows(6)}`)).toBe(true);
  });
});
