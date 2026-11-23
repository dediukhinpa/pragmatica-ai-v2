import { describe, expect, test } from 'bun:test';

import {
  leadTimeOrUndefined,
  looksLikeLeadTime,
  priceDateNotInFuture,
} from '../../../src/kit/domain/lead-time';

const NOW = new Date('2026-11-03T10:00:00Z');

describe('looksLikeLeadTime', () => {
  test('заметка о прошлой допечатке - не срок', () => {
    const text = 'Допечатка тиража ожидалась в конце сентября 2025';
    expect(looksLikeLeadTime(text, NOW)).toBe(false);
    expect(leadTimeOrUndefined(text, NOW)).toBeUndefined();
  });

  test('диапазон рабочих дней остаётся', () => {
    expect(leadTimeOrUndefined('15–17 рабочих дней', NOW)).toBe('15–17 рабочих дней');
  });

  test('длительности и наличие', () => {
    for (const text of ['3-5 дней', '2 недели', 'до 1,5 месяцев', '24 часа', 'в наличии']) {
      expect(looksLikeLeadTime(text, NOW)).toBe(true);
    }
    expect(looksLikeLeadTime('Под заказ, 10 дней', NOW)).toBe(true);
    expect(looksLikeLeadTime('под заказ', NOW)).toBe(true);
  });

  test('длительность с прошедшей датой остаётся сроком', () => {
    expect(looksLikeLeadTime('5 дней, прайс от 12.10.2025', NOW)).toBe(true);
  });

  test('дата поставки: будущая - срок, прошлая - нет', () => {
    expect(looksLikeLeadTime('поставка до 20.12.2026', NOW)).toBe(true);
    expect(looksLikeLeadTime('поставка в декабре 2026', NOW)).toBe(true);
    expect(looksLikeLeadTime('поставка 20.12.2025', NOW)).toBe(false);
  });

  test('текст без числа и даты - не срок', () => {
    expect(looksLikeLeadTime('Ожидается допечатка', NOW)).toBe(false);
    expect(looksLikeLeadTime('в конце сентября', NOW)).toBe(false);
  });
});

describe('priceDateNotInFuture', () => {
  test('прошлая дата остаётся, будущая отбрасывается', () => {
    expect(priceDateNotInFuture('2026-10-12', NOW)).toBe('2026-10-12');
    expect(priceDateNotInFuture('2026-12-01', NOW)).toBeUndefined();
    expect(priceDateNotInFuture('мусор', NOW)).toBeUndefined();
    expect(priceDateNotInFuture(undefined, NOW)).toBeUndefined();
  });
});
