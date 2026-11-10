import { describe, expect, test } from 'bun:test';
import {
  classifyPriceFileName,
  looksLikePriceListName,
  type PriceFileKind,
} from '../../../src/kit/domain/price-file-kind';
import { verifyFallbackPriceFileDate } from '../../../src/kit/domain/price-file-date-check';
import { type PriceFileDate } from '../../../src/kit/domain/price-file-date';

const TZ = 'Europe/Moscow';
const NOW = new Date('2026-10-22T12:00:00+03:00');

function d(year: number, month: number, day: number | null): PriceFileDate {
  return { year, month, day };
}

describe('classifyPriceFileName: это прайс или нет', () => {
  const table: Array<[string, PriceFileKind]> = [
    ['Каталог Дом варенья.pdf', 'not_price'],
    ['Каталог_Дом Варенья_ 2026.pdf', 'not_price'],
    ['папка/каталог товаров.xlsx', 'not_price'],
    ['Презентация компании.pdf', 'not_price'],
    ['Прил_18 к РОЗ_Правила хранения прайсов.docx', 'not_price'],
    ['Приложение 3 к договору.docx', 'not_price'],
    ['Правила хранения прайсов.docx', 'not_price'],
    ['Примеры брендирования.pdf', 'not_price'],
    // Слово «прайс» делает каталог и презентацию прайсом.
    ['Прайс-каталог_Пряники_08.09.2026_.pdf', 'price'],
    ['ПРЕЗЕНТАЦИЯ-ПРАЙС_BUDDEMEYER_28.10.pdf', 'price'],
    ['Прайс_Аромадиффузоры_НЕ БРАТЬ.xlsx', 'price'],
    ['Прайс_игрушки_общий.pdf', 'price'],
    ['Прайс на упаковку BARTOSH (9).xlsx', 'price'],
    ['что-то без слов.xlsx', 'price'],
    ['', 'price'],
  ];
  for (const [name, kind] of table) {
    test(`${name || '(пусто)'} -> ${kind}`, () => expect(classifyPriceFileName(name)).toBe(kind));
  }

  test('похоже на прайс: нужно слово «прайс»/«price» и не «не прайс»', () => {
    expect(looksLikePriceListName('Прайс_лошади.pdf')).toBe(true);
    expect(looksLikePriceListName('Price list.xlsx')).toBe(true);
    expect(looksLikePriceListName('ООО Ромашка.xlsx')).toBe(false);
    expect(looksLikePriceListName('Прил_18 Правила хранения прайсов.docx')).toBe(false);
  });
});

describe('verifyFallbackPriceFileDate: строгая проверка ответа модели', () => {
  const verify = (name: string, date: PriceFileDate, anchor: Date = NOW): PriceFileDate | null =>
    verifyFallbackPriceFileDate(name, date, NOW, TZ, anchor);

  test('дата, записанная в названии, принимается (цифры, слово месяца, слитная, 2 цифры)', () => {
    expect(verify('Прайс_13.10.xlsx', d(2026, 10, 13))).toEqual(d(2026, 10, 13));
    expect(verify('Прайс 17_09_26.xls', d(2026, 9, 17))).toEqual(d(2026, 9, 17));
    expect(verify('Прайс_11092025.xlsx', d(2025, 9, 11))).toEqual(d(2025, 9, 11));
    expect(verify('прайс 2026 июнь.pdf', d(2026, 6, null))).toEqual(d(2026, 6, null));
    expect(verify('Прайс_06.08.20225.xlsx', d(2025, 8, 6))).toEqual(d(2025, 8, 6));
    expect(verify('Прайс 1 октября.xlsx', d(2026, 10, 1))).toEqual(d(2026, 10, 1));
  });

  test('день и месяц не берутся подстрокой длинной группы цифр (ИНН, артикул, телефон)', () => {
    expect(verify('Прайс_ИНН_7701234567.xlsx', d(2026, 1, 12))).toBeNull();
    expect(verify('Прайс_арт_9120145678.xlsx', d(2026, 1, 12))).toBeNull();
    expect(verify('Прайс_тел_89012123456.xlsx', d(2026, 1, 12))).toBeNull();
    // Настоящие раскладки целиком по-прежнему проходят.
    expect(verify('Прайс_20260912.xlsx', d(2026, 9, 12))).toEqual(d(2026, 9, 12));
    expect(verify('Прайс_092025.xlsx', d(2025, 9, null))).toEqual(d(2025, 9, null));
  });

  test('несуществующая дата отбрасывается', () => {
    expect(verify('Прайс_31.02.2026.xlsx', d(2026, 2, 31))).toBeNull();
    expect(verify('Прайс_13.13.2026.xlsx', d(2026, 13, 13))).toBeNull();
    expect(verify('Прайс_00.10.2026.xlsx', d(2026, 10, 0))).toBeNull();
  });

  test('год вне окна отбрасывается', () => {
    expect(verify('Прайс_01.10.1999.xlsx', d(1999, 10, 1))).toBeNull();
    expect(verify('Прайс_01.10.2010.xlsx', d(2010, 10, 1))).toBeNull();
    expect(verify('Прайс_01.10.2126.xlsx', d(2126, 10, 1))).toBeNull();
  });

  test('дата в будущем отбрасывается; месяц без дня - не позже текущего', () => {
    expect(verify('Прайс_23.10.2026.xlsx', d(2026, 10, 23))).toBeNull();
    expect(verify('Прайс_22.10.2026.xlsx', d(2026, 10, 22))).toEqual(d(2026, 10, 22));
    expect(verify('Прайс_ноябрь 2026.xlsx', d(2026, 11, null))).toBeNull();
    expect(verify('Прайс_октябрь 2026.xlsx', d(2026, 10, null))).toEqual(d(2026, 10, null));
  });

  test('выдуманная дата, которой нет в названии, отбрасывается', () => {
    expect(verify('Прайс_13.10.xlsx', d(2026, 10, 14))).toBeNull();
    expect(verify('Прайс_13.10.xlsx', d(2026, 9, 13))).toBeNull();
    expect(verify('Прайс_13.10.xlsx', d(2025, 10, 13))).toBeNull();
    expect(verify('Прайс_лошади.pdf', d(2026, 5, 5))).toBeNull();
    expect(verify('Прайс_лошади.pdf', d(2026, 5, null))).toBeNull();
  });

  test('число из пути (каталога) не считается записью в названии', () => {
    expect(verify('2026-05-05/Прайс_лошади.pdf', d(2026, 5, 5))).toBeNull();
  });

  test('«сегодня» - в поясе бизнеса', () => {
    const lateUtc = new Date('2026-10-22T21:30:00Z');
    const name = 'Прайс_23.10.2026.xlsx';
    expect(verifyFallbackPriceFileDate(name, d(2026, 10, 23), lateUtc, TZ)).toEqual(
      d(2026, 10, 23),
    );
    expect(verifyFallbackPriceFileDate(name, d(2026, 10, 23), lateUtc, 'UTC')).toBeNull();
  });

  test('год без записи в названии выводится от опорной даты файла, а не от сегодня', () => {
    const anchor = new Date('2024-01-10T12:00:00+03:00');
    expect(verify('Прайс_31.12.xlsx', d(2023, 12, 31), anchor)).toEqual(d(2023, 12, 31));
    // Год «сегодняшнего» правила (2025) при опорной дате 2024-01-10 не принимается.
    expect(verify('Прайс_31.12.xlsx', d(2025, 12, 31), anchor)).toBeNull();
  });

  test('без опорной даты год, которого нет в названии, не принимается', () => {
    expect(verifyFallbackPriceFileDate('Прайс_13.10.xlsx', d(2026, 10, 13), NOW, TZ)).toBeNull();
    // Год записан в названии - опорная дата не нужна.
    expect(verifyFallbackPriceFileDate('Прайс_13.10.2026.xlsx', d(2026, 10, 13), NOW, TZ)).toEqual(
      d(2026, 10, 13),
    );
  });
});
