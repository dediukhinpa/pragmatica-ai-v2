import { describe, expect, test } from 'bun:test';
import {
  applyFieldsToCard,
  cardFromFields,
  supplierCardFieldsSchema,
} from '../../src/agents/suppliers/card-fields';
import { describeSupplierCard } from '../../src/agents/suppliers/card-view';
import { FULL_CARD } from '../kit/support/supplier-fixtures';

const CONTEXT = { userId: 'u1', nowIso: '2026-10-21T10:00:00.000Z', source: 'chat' as const };

describe('поля расположения и оценки в карточке (разд. 10.7 и 10.9 ТЗ)', () => {
  test('новая карточка из полей получает город, адрес, оценку и брак (в т.ч. 0)', () => {
    const fields = supplierCardFieldsSchema.parse({
      name: 'Типография',
      productionCity: 'Казань',
      address: 'ул. Складская, 5',
      strengths: 'крупные тиражи',
      weaknesses: 'срочные заказы',
      defectRatePercent: 0,
    });
    const card = cardFromFields(fields, CONTEXT, 'sup-1');
    expect(card).toMatchObject({
      productionCity: 'Казань',
      address: 'ул. Складская, 5',
      strengths: 'крупные тиражи',
      weaknesses: 'срочные заказы',
      defectRatePercent: 0,
    });
  });

  test('правка накладывает только переданное, остальное сохраняется', () => {
    const rated = applyFieldsToCard(FULL_CARD, { productionCity: 'Казань' }, CONTEXT);
    const next = applyFieldsToCard(rated, { defectRatePercent: 2.5 }, CONTEXT);
    expect(next.productionCity).toBe('Казань');
    expect(next.defectRatePercent).toBe(2.5);
    expect(next.contacts).toEqual(FULL_CARD.contacts);
  });

  test('clear убирает поле оценки', () => {
    const rated = applyFieldsToCard(FULL_CARD, { defectRatePercent: 1, strengths: 'а' }, CONTEXT);
    const cleared = applyFieldsToCard(rated, { clear: ['defectRatePercent'] }, CONTEXT);
    expect('defectRatePercent' in cleared).toBe(false);
    expect(cleared.strengths).toBe('а');
  });

  test('схема входа: брак вне 0..100 принимается (код очистит с warning), пустые - нет', () => {
    // Этап 177: диапазон проверяет санитайзер карточки, а не схема (ZodError = отказ).
    expect(supplierCardFieldsSchema.safeParse({ defectRatePercent: 101 }).success).toBe(true);
    expect(supplierCardFieldsSchema.safeParse({ defectRatePercent: -1 }).success).toBe(true);
    expect(supplierCardFieldsSchema.safeParse({ productionCity: '  ' }).success).toBe(false);
  });

  test('показ карточки выводит новые поля, у старой карточки их строк нет', () => {
    const old = describeSupplierCard(FULL_CARD, 'Карточка');
    expect(old).not.toContain('Город производства');
    expect(old).not.toContain('Процент брака');
    const shown = describeSupplierCard(
      { ...FULL_CARD, productionCity: 'Казань', defectRatePercent: 0 },
      'Карточка',
    );
    expect(shown).toContain('Город производства: Казань');
    expect(shown).toContain('Процент брака: 0%');
  });
});
