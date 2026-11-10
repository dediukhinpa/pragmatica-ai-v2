import { describe, expect, test } from 'bun:test';
import {
  RATING_BASE,
  RATING_MAX,
  RATING_MIN,
  computeSupplierRating,
  formatSupplierRating,
} from '../../../src/kit/domain/supplier-rating';
import { type SupplierCard } from '../../../src/kit/domain/supplier-card';

/** Карточка без оценочных сведений: статус «новый» поставлен по умолчанию. */
const BARE: SupplierCard = {
  id: 's1',
  name: 'Поставщик',
  status: 'new',
  contacts: [],
  supplies: { categories: [], brands: [], regions: [] },
  terms: {},
  notes: [],
};

const rated = (patch: Partial<SupplierCard>): number | null => {
  const result = computeSupplierRating({ ...BARE, ...patch });
  return result.status === 'rated' ? result.value : null;
};

describe('computeSupplierRating', () => {
  test('нет ни одного оценочного сведения - no_data, а не ноль', () => {
    expect(computeSupplierRating(BARE)).toEqual({ status: 'no_data' });
  });

  test('заполненность без оценочных сведений рейтинга не создаёт', () => {
    const full: Partial<SupplierCard> = {
      contacts: [{ email: 'a@b.test', isPrimary: true }],
      productionCity: 'Казань',
      terms: { leadTime: '5 дней', payment: 'по факту' },
      notes: [{ text: 'x', authorId: 'u', createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    expect(computeSupplierRating({ ...BARE, ...full })).toEqual({ status: 'no_data' });
  });

  test('статус «действующий» - сведение: база плюс поправка', () => {
    expect(rated({ status: 'active' })).toBe(RATING_BASE + 1);
  });

  test('статус «не работаем» понижает, но не ниже шкалы', () => {
    expect(rated({ status: 'inactive' })).toBe(RATING_BASE - 1);
    expect(rated({ status: 'inactive', defectRatePercent: 50, weaknesses: 'x' })).toBe(RATING_MIN);
  });

  test('брак 0 - это сведение (выше базы), а не отсутствие', () => {
    expect(rated({ defectRatePercent: 0 })).toBe(RATING_BASE + 0.5);
  });

  test('границы процента брака: 1, 3, 5, 10 включительно', () => {
    expect(rated({ defectRatePercent: 1 })).toBe(3.5);
    expect(rated({ defectRatePercent: 1.01 })).toBe(3);
    expect(rated({ defectRatePercent: 3 })).toBe(3);
    expect(rated({ defectRatePercent: 3.01 })).toBe(2.5);
    expect(rated({ defectRatePercent: 5 })).toBe(2.5);
    expect(rated({ defectRatePercent: 5.01 })).toBe(2);
    expect(rated({ defectRatePercent: 10 })).toBe(2);
    expect(rated({ defectRatePercent: 10.01 })).toBe(1);
  });

  test('сильные стороны повышают, слабые понижают', () => {
    expect(rated({ strengths: 'тиражи' })).toBe(3.5);
    expect(rated({ weaknesses: 'срочное' })).toBe(2.5);
    expect(rated({ strengths: 'а', weaknesses: 'б' })).toBe(3);
  });

  test('полнота: три группы из четырёх дают прибавку, две - нет', () => {
    const base = { status: 'active' as const };
    const contact = { contacts: [{ phone: '+79990001122', isPrimary: true }] };
    expect(rated({ ...base, ...contact, address: 'г. Казань' })).toBe(4);
    expect(rated({ ...base, ...contact, address: 'г. Казань', terms: { leadTime: '3 дня' } })).toBe(
      4.5,
    );
  });

  test('верх шкалы ограничен', () => {
    const best = rated({
      status: 'active',
      defectRatePercent: 0,
      strengths: 'а',
      contacts: [{ email: 'a@b.test', isPrimary: true }],
      productionCity: 'Казань',
      terms: { leadTime: '3 дня' },
    });
    expect(best).toBe(RATING_MAX);
  });

  test('детерминирован: одна карточка - один результат', () => {
    const card = { ...BARE, status: 'active' as const, defectRatePercent: 2 };
    expect(computeSupplierRating(card)).toEqual(computeSupplierRating({ ...card }));
  });
});

describe('рейтинг и полная карточка (разд. 10.9 ТЗ)', () => {
  const INFO_ONLY: Partial<SupplierCard> = {
    claimsHandling: 'замена за свой счёт',
    competitiveAdvantages: 'свои станки',
    customers: 'крупный ритейл',
    turnoverRub: 150_000_000,
    okved: '32.99',
    employeeCount: 120,
    supplierKind: 'production_only',
    vatMode: 'with_vat',
    vatRatePercent: 20,
  };

  test('справочные сведения 10.9 сами рейтинг не создают', () => {
    expect(computeSupplierRating({ ...BARE, ...INFO_ONLY })).toEqual({ status: 'no_data' });
  });

  test('справочные сведения не меняют рейтинг, посчитанный по оценочным', () => {
    const scored: Partial<SupplierCard> = {
      status: 'active',
      defectRatePercent: 2,
      strengths: 'тиражи',
      weaknesses: 'срочное',
    };
    expect(computeSupplierRating({ ...BARE, ...scored, ...INFO_ONLY })).toEqual(
      computeSupplierRating({ ...BARE, ...scored }),
    );
  });

  test('рейтинг берёт сильные, слабые стороны и брак из полей карточки раздела 10.9', () => {
    const card = { ...BARE, strengths: 'а', weaknesses: 'б', defectRatePercent: 0 };
    expect(rated(card)).toBe(RATING_BASE + 0.5);
  });
});

describe('formatSupplierRating', () => {
  test('нет оценки для null и undefined, число - «из 5»', () => {
    expect(formatSupplierRating(null)).toBe('нет оценки');
    expect(formatSupplierRating(undefined)).toBe('нет оценки');
    expect(formatSupplierRating(4)).toBe('4 из 5');
    expect(formatSupplierRating(3.5)).toBe('3,5 из 5');
  });
});
