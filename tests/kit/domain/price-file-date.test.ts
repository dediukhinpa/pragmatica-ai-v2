import { describe, expect, test } from 'bun:test';
import {
  PRICE_FILE_STALE_MONTHS,
  isPriceDateStale,
  isPriceTimestampStale,
  parsePriceFileDate,
  type PriceFileDate,
} from '../../../src/kit/domain/price-file-date';

const TZ = 'Europe/Moscow';

function d(year: number, month: number, day: number | null): PriceFileDate {
  return { year, month, day };
}

/** Полдень по Москве указанной даты: далеко от границ суток. */
function noon(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00+03:00`);
}

describe('parsePriceFileDate: варианты записи', () => {
  const full: Array<[string, PriceFileDate]> = [
    ['01.10.2026.xlsx', d(2026, 10, 1)],
    ['1.10.2026.xlsx', d(2026, 10, 1)],
    ['01-10-2026.xlsx', d(2026, 10, 1)],
    ['01_10_2026.xlsx', d(2026, 10, 1)],
    ['2026-10-01.xlsx', d(2026, 10, 1)],
    ['2026_10_01.xls', d(2026, 10, 1)],
    ['20261001.csv', d(2026, 10, 1)],
    ['01.10.26.xlsx', d(2026, 10, 1)],
    ['прайс_01102026.xlsx', d(2026, 10, 1)],
    ['от 1 окт 2026.xlsx', d(2026, 10, 1)],
    ['от 1 октября 2026.xlsx', d(2026, 10, 1)],
    ['Прайс 1 октября 2026 г..xlsx', d(2026, 10, 1)],
    ['Прайс 1 октября 2026 г.xlsx', d(2026, 10, 1)],
    ['Price 5 Oct 2026.xlsx', d(2026, 10, 5)],
    ['Прайс 15 марта 2026.xlsx', d(2026, 3, 15)],
  ];
  for (const [name, expected] of full) {
    test(name, () => expect(parsePriceFileDate(name)).toEqual(expected));
  }

  const monthOnly: Array<[string, PriceFileDate]> = [
    ['октябрь 2026.xlsx', d(2026, 10, null)],
    ['Октябрь_2026.xlsx', d(2026, 10, null)],
    ['окт 2026.xlsx', d(2026, 10, null)],
    ['окт.2026.xlsx', d(2026, 10, null)],
    ['10.2026.xlsx', d(2026, 10, null)],
    ['10-2026.xlsx', d(2026, 10, null)],
    ['2026-10.xlsx', d(2026, 10, null)],
    ['Oct 2026.xlsx', d(2026, 10, null)],
    ['October 2026.xlsx', d(2026, 10, null)],
    ['Прайс Сентябрь 2026', d(2026, 9, null)],
    ['май 2026.xlsx', d(2026, 5, null)],
  ];
  for (const [name, expected] of monthOnly) {
    test(`месяц: ${name}`, () => expect(parsePriceFileDate(name)).toEqual(expected));
  }

  test('двухзначный год: 26 -> 2026, окно 2000-2099', () => {
    expect(parsePriceFileDate('31.12.99.xlsx')).toEqual(d(2099, 12, 31));
    expect(parsePriceFileDate('01.01.00.xlsx')).toEqual(d(2000, 1, 1));
  });
});

describe('parsePriceFileDate: путь и расширение', () => {
  test('каталоги в расчёт не идут', () => {
    expect(parsePriceFileDate('/data/2020-01-01/прайс.xlsx')).toBeNull();
    expect(parsePriceFileDate('C:\\Прайсы\\01.10.2026\\ООО Ромашка 05.11.2026.xlsx')).toEqual(
      d(2026, 11, 5),
    );
  });

  test('расширение из цифр не отрезается: 10.2026 - месяц', () => {
    expect(parsePriceFileDate('10.2026')).toEqual(d(2026, 10, null));
  });
});

describe('parsePriceFileDate: мусор', () => {
  const junk = [
    'прайс.xlsx',
    'price_v2.10.xlsx',
    'артикул 1234567.xlsx',
    '1234567.xlsx',
    'тел 8-900-123-45-67.xlsx',
    '89001234567.xlsx',
    'v2.10.26.xlsx',
    'версия 1.2.10.xlsx',
    'price_v2.10.2026.xlsx',
    'price_V2.10.2026.xlsx',
    'price_v10.2026.xlsx',
    '32.10.2026.xlsx',
    '31.02.2026.xlsx',
    '01.13.2026.xlsx',
    '01.10.1999.xlsx',
    '01.10.2126.xlsx',
    '12345678.xlsx',
    'маркетинг 2026.xlsx',
    '2026.xlsx',
    '45.10.2026.xlsx',
    '',
  ];
  for (const name of junk) {
    test(`null: "${name}"`, () => expect(parsePriceFileDate(name)).toBeNull());
  }
});

describe('parsePriceFileDate: версия с буквой v не дата', () => {
  test('v перед датой гасит дату, настоящая дата рядом остаётся', () => {
    expect(parsePriceFileDate('price_v2.10.2026_от_01.11.2026.xlsx')).toEqual(d(2026, 11, 1));
  });

  test('не v перед датой: дата читается', () => {
    expect(parsePriceFileDate('price_2.10.2026.xlsx')).toEqual(d(2026, 10, 2));
    expect(parsePriceFileDate('price v 2.10.2026.xlsx')).toEqual(d(2026, 10, 2));
    expect(parsePriceFileDate('rev10.2026.xlsx')).toBeNull();
  });
});

describe('parsePriceFileDate: несколько дат - самая поздняя', () => {
  test('период', () => {
    expect(parsePriceFileDate('прайс 01.09.2026-30.09.2026.xlsx')).toEqual(d(2026, 9, 30));
  });

  test('с ... по ...', () => {
    expect(parsePriceFileDate('с 01.09 по 01.10.2026.xlsx')).toEqual(d(2026, 10, 1));
  });

  test('порядок в имени не важен', () => {
    expect(parsePriceFileDate('15.10.2026 вместо 01.09.2026.xlsx')).toEqual(d(2026, 10, 15));
  });

  test('день внутри месяца не читается повторно как «только месяц»', () => {
    expect(parsePriceFileDate('15.10.2026.xlsx')).toEqual(d(2026, 10, 15));
  });

  test('месяц без дня сравнивается по последнему дню месяца', () => {
    expect(parsePriceFileDate('15.10.2026 и ноябрь 2026.xlsx')).toEqual(d(2026, 11, null));
    expect(parsePriceFileDate('15.10.2026 и октябрь 2026.xlsx')).toEqual(d(2026, 10, null));
  });
});

describe('isPriceDateStale', () => {
  test('константа срока - 3 месяца', () => {
    expect(PRICE_FILE_STALE_MONTHS).toBe(3);
  });

  test('ровно 3 месяца - ещё не устарел, на день больше - устарел', () => {
    expect(isPriceDateStale(d(2026, 7, 21), noon('2026-10-21'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2026, 7, 21), noon('2026-10-22'), TZ)).toBe(true);
    expect(isPriceDateStale(d(2026, 7, 21), noon('2026-10-20'), TZ)).toBe(false);
  });

  test('конец месяца: 31 мая + 3 мес. = 31 авг.', () => {
    expect(isPriceDateStale(d(2026, 5, 31), noon('2026-08-31'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2026, 5, 31), noon('2026-09-01'), TZ)).toBe(true);
  });

  test('30 ноября + 3 мес. = 28 февраля (не високосный)', () => {
    expect(isPriceDateStale(d(2026, 11, 30), noon('2027-02-28'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2026, 11, 30), noon('2027-03-01'), TZ)).toBe(true);
  });

  test('30 ноября + 3 мес. = 29 февраля (високосный)', () => {
    expect(isPriceDateStale(d(2027, 11, 30), noon('2028-02-29'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2027, 11, 30), noon('2028-03-01'), TZ)).toBe(true);
  });

  test('29 февраля високосного года + 3 мес. = 29 мая', () => {
    expect(isPriceDateStale(d(2028, 2, 29), noon('2028-05-29'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2028, 2, 29), noon('2028-05-30'), TZ)).toBe(true);
  });

  test('переход через год', () => {
    expect(isPriceDateStale(d(2026, 10, 15), noon('2027-01-15'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2026, 10, 15), noon('2027-01-16'), TZ)).toBe(true);
  });

  test('дата в будущем - не устарел', () => {
    expect(isPriceDateStale(d(2027, 5, 1), noon('2026-10-21'), TZ)).toBe(false);
  });

  test('только месяц: срок считается от последнего дня месяца', () => {
    // Июль 2026 -> последний день 31 июля -> срок до 31 октября.
    expect(isPriceDateStale(d(2026, 7, null), noon('2026-10-31'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2026, 7, null), noon('2026-11-01'), TZ)).toBe(true);
    // Февраль 2027 -> 28 февраля -> срок до 28 мая.
    expect(isPriceDateStale(d(2027, 2, null), noon('2027-05-28'), TZ)).toBe(false);
    expect(isPriceDateStale(d(2027, 2, null), noon('2027-05-29'), TZ)).toBe(true);
  });

  test('сегодняшняя дата берётся в поясе бизнеса, а не в UTC', () => {
    // 21:30 UTC 21 октября = 00:30 22 октября по Москве.
    const lateUtc = new Date('2026-10-21T21:30:00Z');
    expect(isPriceDateStale(d(2026, 7, 21), lateUtc, TZ)).toBe(true);
    expect(isPriceDateStale(d(2026, 7, 21), lateUtc, 'UTC')).toBe(false);
  });

  test('пояс по умолчанию - пояс бизнеса', () => {
    expect(isPriceDateStale(d(2026, 7, 21), new Date('2026-10-21T21:30:00Z'))).toBe(true);
  });
});

describe('isPriceTimestampStale: прайс в базе по тем же календарным месяцам', () => {
  test('ровно 3 месяца от даты загрузки - не устарел, на день больше - устарел', () => {
    const uploaded = '2026-07-21T09:00:00.000Z';
    expect(isPriceTimestampStale(uploaded, noon('2026-10-21'), TZ)).toBe(false);
    expect(isPriceTimestampStale(uploaded, noon('2026-10-22'), TZ)).toBe(true);
  });

  test('дата берётся в поясе бизнеса: поздний вечер UTC - уже следующий день в Москве', () => {
    expect(isPriceTimestampStale('2026-07-20T22:00:00.000Z', noon('2026-10-21'), TZ)).toBe(false);
    expect(isPriceTimestampStale('2026-07-20T22:00:00.000Z', noon('2026-10-22'), TZ)).toBe(true);
  });

  test('конец месяца усекается так же, как у файлов', () => {
    expect(isPriceTimestampStale('2026-11-30T09:00:00.000Z', noon('2027-02-28'), TZ)).toBe(false);
    expect(isPriceTimestampStale('2026-11-30T09:00:00.000Z', noon('2027-03-01'), TZ)).toBe(true);
  });

  test('момент не разбирается - считается устаревшим', () => {
    expect(isPriceTimestampStale('не дата', noon('2026-10-22'), TZ)).toBe(true);
  });
});

describe('parsePriceFileDate: новые форматы', () => {
  /** «Сейчас» для записей без года: 22 октября 2026, полдень по Москве. */
  const NOW = noon('2026-10-22');

  const formats: Array<[string, PriceFileDate]> = [
    ['Прайс_Шевроны_13.10.xlsx', d(2026, 10, 13)],
    ['Прайс_28.10.pdf', d(2025, 10, 28)],
    ['Прайс_01_07.xlsx', d(2026, 7, 1)],
    ['Прайс_22.10.xlsx', d(2026, 10, 22)],
    ['Прайс_23.10.xlsx', d(2025, 10, 23)],
    ['Прайс_01-25.xlsx', d(2025, 1, null)],
    ['Прайс_03.26.xlsx', d(2026, 3, null)],
    ['прайс 2026 июнь РРЦ.pdf', d(2026, 6, null)],
    ['прайс 2026_окт.pdf', d(2026, 10, null)],
    ['Прайс_Общий _ 06.08.20225.xlsx', d(2025, 8, 6)],
    ['Прайс_с 06.08.2026.xlsx', d(2026, 8, 6)],
    ['Прайс_10.03.2026г..xlsx', d(2026, 3, 10)],
    ['Прайс_09.09.2026г. .xlsx', d(2026, 9, 9)],
    ['Прайс_11092025.xlsx', d(2025, 9, 11)],
    ['Прайс 17_09_26.xls', d(2026, 9, 17)],
  ];
  for (const [name, expected] of formats) {
    test(name, () => expect(parsePriceFileDate(name, NOW, TZ, NOW)).toEqual(expected));
  }

  test('29 февраля: ближайший прошедший високосный год', () => {
    expect(parsePriceFileDate('Прайс_29.02.xlsx', NOW, TZ, NOW)).toEqual(d(2024, 2, 29));
  });

  test('«сегодня» считается в поясе бизнеса, а не в UTC', () => {
    // 21:30 UTC 22 октября = 00:30 23 октября по Москве: 23.10 уже сегодня.
    const lateUtc = new Date('2026-10-22T21:30:00Z');
    expect(parsePriceFileDate('Прайс_23.10.xlsx', lateUtc, TZ, lateUtc)).toEqual(d(2026, 10, 23));
    expect(parsePriceFileDate('Прайс_23.10.xlsx', lateUtc, 'UTC', lateUtc)).toEqual(d(2025, 10, 23));
  });

  test('полная дата важнее записи без года', () => {
    expect(parsePriceFileDate('Прайс_28.10_от_01.09.2026.xlsx', NOW, TZ, NOW)).toEqual(d(2026, 9, 1));
  });

  const notDates = [
    'Прайс на упаковку BARTOSH (9).xlsx',
    'price_v2.10.xlsx',
    'v2.10.xlsx',
    'версия 1.2.10.xlsx',
    'Прайс 2.10.xlsx',
    'Прайс_12.50.xlsx',
    'Прайс_32.10.xlsx',
    'Прайс_31.11.xlsx',
    'Прайс_10.5.xlsx',
    'Прайс_1.2.3.4.xlsx',
    'Прайс_размер 10х10.xlsx',
    'Прайс_13.10.5.xlsx',
    'Прайс_01-15.xlsx',
    'Прайс_01-30.xlsx',
    'Прайс_актуально до 30.07.26.xlsx',
    'Прайс действителен по 01.10.2026.xlsx',
    'Прайс актуален до 30 июля 2026.xlsx',
  ];
  for (const name of notDates) {
    test(`с now даты нет: "${name}"`, () => expect(parsePriceFileDate(name, NOW, TZ, NOW)).toBeNull());
  }

  test('без now записи без года не разбираются (прежнее поведение)', () => {
    expect(parsePriceFileDate('Прайс_28.10.xlsx')).toBeNull();
    expect(parsePriceFileDate('Прайс_01-25.xlsx')).toBeNull();
  });

  test('без опорной даты дд.мм не разбирается даже при заданном now, а мм-гг - да', () => {
    expect(parsePriceFileDate('Прайс_28.10.xlsx', NOW, TZ)).toBeNull();
    expect(parsePriceFileDate('Прайс_01-25.xlsx', NOW, TZ)).toEqual(d(2025, 1, null));
  });

  describe('дд.мм относительно опорной даты файла, а не сегодняшнего дня', () => {
    test('31.12 при опорной дате 2024-01-10 - 2023-12-31', () => {
      const anchor = noon('2024-01-10');
      expect(parsePriceFileDate('Прайс 31.12.xlsx', NOW, TZ, anchor)).toEqual(d(2023, 12, 31));
    });

    test('та же запись при опорной дате в конце декабря - этот же год', () => {
      expect(parsePriceFileDate('Прайс 31.12.xlsx', NOW, TZ, noon('2023-12-31'))).toEqual(
        d(2023, 12, 31),
      );
    });

    test('дата в день опорной даты включается, на день позже - прошлый год', () => {
      expect(parsePriceFileDate('Прайс_10.03.xlsx', NOW, TZ, noon('2022-03-10'))).toEqual(
        d(2022, 3, 10),
      );
      expect(parsePriceFileDate('Прайс_11.03.xlsx', NOW, TZ, noon('2022-03-10'))).toEqual(
        d(2021, 3, 11),
      );
    });

    test('29 февраля от опорной даты 2025-03-01 - 2024-02-29, от 2024-02-28 - 2020-02-29', () => {
      expect(parsePriceFileDate('Прайс_29.02.xlsx', NOW, TZ, noon('2025-03-01'))).toEqual(
        d(2024, 2, 29),
      );
      expect(parsePriceFileDate('Прайс_29.02.xlsx', NOW, TZ, noon('2024-02-28'))).toEqual(
        d(2020, 2, 29),
      );
    });

    test('опорная дата считается в поясе бизнеса', () => {
      // 21:30 UTC 31 декабря 2023 = 00:30 1 января 2024 по Москве.
      const anchor = new Date('2023-12-31T21:30:00Z');
      expect(parsePriceFileDate('Прайс_01.01.xlsx', NOW, TZ, anchor)).toEqual(d(2024, 1, 1));
      expect(parsePriceFileDate('Прайс_01.01.xlsx', NOW, 'UTC', anchor)).toEqual(d(2023, 1, 1));
    });
  });

  test('лишняя цифра в годе без повтора не угадывается', () => {
    expect(parsePriceFileDate('Прайс_06.08.20256.xlsx', NOW, TZ, NOW)).toBeNull();
  });

  test('срок действия не прячет настоящую дату рядом', () => {
    expect(parsePriceFileDate('Прайс_01.09.2026_актуально до 30.12.26.xlsx')).toEqual(
      d(2026, 9, 1),
    );
  });
});
