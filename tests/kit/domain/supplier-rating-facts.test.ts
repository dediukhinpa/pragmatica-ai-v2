import { describe, expect, test } from 'bun:test';
import {
  RATING_FACT_TEXT_MAX_LENGTH,
  SUPPLIER_RATING_FACTS_VERSION,
  buildSupplierRatingFacts,
  canonicalFactsJson,
} from '../../../src/kit/domain/supplier-rating-facts';
import {
  SUPPLIER_RATING_RATIONALE_MAX_LENGTH,
  normalizeRationale,
  parseSupplierRatingVerdict,
} from '../../../src/kit/domain/supplier-rating-verdict';
import {
  computeSupplierRating,
  computeSupplierRatingFromFacts,
} from '../../../src/kit/domain/supplier-rating';
import { type SupplierCard } from '../../../src/kit/domain/supplier-card';

const BARE: SupplierCard = {
  id: 's1',
  name: 'Поставщик',
  status: 'new',
  contacts: [],
  supplies: { categories: [], brands: [], regions: [] },
  terms: {},
  notes: [],
};

const PERSONAL: Partial<SupplierCard> = {
  inn: '7707083893',
  contacts: [
    {
      fullName: 'Петров Пётр Петрович',
      position: 'директор',
      email: 'sales@metall.test',
      phone: '+79990001122',
      messenger: '@petrov',
      isPrimary: true,
    },
  ],
  website: 'https://metall.test',
  address: 'ул. Складская, 5',
  productionCity: 'Казань',
  logoRef: 'kb/logo.png',
  legalEntities: [{ name: 'ООО Металл', inn: '7707083893' }],
  notes: [{ text: 'звонил Иванову', authorId: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }],
  terms: { leadTime: '3-5 дней', payment: 'предоплата' },
};

describe('buildSupplierRatingFacts', () => {
  test('ФИО, контакты, реквизиты, адрес, заметки и ссылки в факты не попадают', () => {
    const card: SupplierCard = {
      ...BARE,
      ...PERSONAL,
      status: 'active',
      strengths: 'Быстро',
      defectRatePercent: 2,
    };
    const json = canonicalFactsJson(buildSupplierRatingFacts(card));
    for (const secret of [
      'Петров',
      'директор',
      'sales@',
      '79990001122',
      '@petrov',
      '7707083893',
      'Складская',
      'Казань',
      'metall.test',
      'logo.png',
      'ООО Металл',
      'Иванову',
      'предоплата',
      'дней',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(JSON.parse(json)).toMatchObject({
      status: 'active',
      strengths: 'Быстро',
      defectRatePercent: 2,
      completeness: 4,
      version: SUPPLIER_RATING_FACTS_VERSION,
    });
  });

  test('отсутствующее остаётся отсутствующим, ноль брака - это значение', () => {
    const empty = JSON.parse(canonicalFactsJson(buildSupplierRatingFacts(BARE)));
    expect(Object.keys(empty).sort()).toEqual(['completeness', 'status', 'version']);
    const zero = JSON.parse(
      canonicalFactsJson(buildSupplierRatingFacts({ ...BARE, defectRatePercent: 0 })),
    );
    expect(zero.defectRatePercent).toBe(0);
  });

  test('оборот - миллионы с одним знаком: серий из 10 цифр нет', () => {
    const facts = buildSupplierRatingFacts({ ...BARE, turnoverRub: 1_234_567_890_123 });
    expect(facts.turnoverMlnRub).toBe(1234567.9);
    expect(canonicalFactsJson(facts)).not.toMatch(/\d{10}/);
    expect(buildSupplierRatingFacts({ ...BARE, turnoverRub: 150_000_000 }).turnoverMlnRub).toBe(
      150,
    );
  });

  test('тексты нормализуются: пробелы схлопываются, длина ограничена', () => {
    const facts = buildSupplierRatingFacts({
      ...BARE,
      strengths: '  Быстро \n\n и   качественно  ',
      weaknesses: 'x'.repeat(RATING_FACT_TEXT_MAX_LENGTH + 50),
      customers: '   ',
    });
    expect(facts.strengths).toBe('Быстро и качественно');
    expect(facts.weaknesses?.length).toBe(RATING_FACT_TEXT_MAX_LENGTH);
    expect(facts.customers).toBeUndefined();
  });

  test('флаги и числа второстепенных сведений', () => {
    const facts = buildSupplierRatingFacts({
      ...BARE,
      hasQualityControl: true,
      documentFlow: 'edo',
      contractNotes: 'Рамочный договор',
      employeeCount: 40,
      samplesAvailable: false,
    });
    expect(facts).toMatchObject({
      hasQualityControl: true,
      documentFlow: 'edo',
      hasContractNotes: true,
      employeeCount: 40,
      samplesAvailable: false,
    });
    expect(canonicalFactsJson(facts)).not.toContain('Рамочный');
  });
});

describe('canonicalFactsJson', () => {
  test('не зависит от порядка ключей; без пробелов, ключи по алфавиту', () => {
    const a = buildSupplierRatingFacts({ ...BARE, status: 'active', strengths: 'Быстро' });
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(canonicalFactsJson(reordered)).toBe(canonicalFactsJson(a));
    expect(canonicalFactsJson(a)).not.toMatch(/\s(?=")|:\s|,\s/);
    const keys = Object.keys(JSON.parse(canonicalFactsJson(a)));
    expect(keys).toEqual([...keys].sort());
  });

  test('undefined и отсутствующий ключ дают одну запись', () => {
    const a = buildSupplierRatingFacts(BARE);
    expect(canonicalFactsJson({ ...a, strengths: undefined })).toBe(canonicalFactsJson(a));
  });
});

describe('computeSupplierRatingFromFacts', () => {
  test('совпадает с computeSupplierRating на разных карточках', () => {
    const cards: SupplierCard[] = [
      BARE,
      { ...BARE, status: 'active' },
      { ...BARE, status: 'inactive', defectRatePercent: 12, weaknesses: 'срывы сроков' },
      { ...BARE, ...PERSONAL, status: 'active', strengths: 'быстро', defectRatePercent: 0.5 },
      { ...BARE, ...PERSONAL, defectRatePercent: 4 },
    ];
    for (const card of cards) {
      expect(computeSupplierRatingFromFacts(buildSupplierRatingFacts(card))).toEqual(
        computeSupplierRating(card),
      );
    }
  });
});

describe('проверка ответа модели', () => {
  test('нормализация: одна строка, предел длины', () => {
    expect(normalizeRationale('  Надёжный \n поставщик ')).toBe('Надёжный поставщик');
    expect(normalizeRationale('я'.repeat(SUPPLIER_RATING_RATIONALE_MAX_LENGTH))).not.toBeNull();
    expect(normalizeRationale('я'.repeat(SUPPLIER_RATING_RATIONALE_MAX_LENGTH + 1))).toBeNull();
    expect(normalizeRationale('')).toBeNull();
  });

  test('email, телефоны, ссылки и серии цифр отвергаются; короткие числа допустимы', () => {
    for (const bad of [
      'пишите a@b.test',
      '+7 999 000-11-22',
      '8 (495) 123-45-67',
      'ИНН 7707083893',
      'сайт www.metall.test',
      'см. http://x.test',
    ]) {
      expect(normalizeRationale(bad)).toBeNull();
    }
    expect(normalizeRationale('Брак 2,5%, работаем с 2015 года')).not.toBeNull();
  });

  test('оценка: целое 1..5, строго два поля', () => {
    const ok = { score: 4, rationale: 'Надёжный поставщик' };
    expect(parseSupplierRatingVerdict(ok)).toEqual(ok);
    for (const score of [0, 6, 3.5, '4', null, undefined, Number.NaN, -1]) {
      expect(parseSupplierRatingVerdict({ ...ok, score })).toBeNull();
    }
    expect(parseSupplierRatingVerdict({ ...ok, extra: 1 })).toBeNull();
    expect(parseSupplierRatingVerdict({ score: 4 })).toBeNull();
    expect(parseSupplierRatingVerdict(null)).toBeNull();
    expect(parseSupplierRatingVerdict('4')).toBeNull();
  });
});
