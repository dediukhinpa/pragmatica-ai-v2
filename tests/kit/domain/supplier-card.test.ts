import { describe, expect, test } from 'bun:test';
import {
  cardFromParts,
  duplicateReasons,
  findDuplicateKeys,
  DUPLICATE_REASON_LABELS,
  MAX_ACTOR_ID_LENGTH,
  MAX_CONTACTS,
  MAX_CONTACT_POSITION_LENGTH,
  MAX_MESSENGER_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_SUPPLIER_ID_LENGTH,
  MAX_SUPPLIER_NAME_LENGTH,
  MAX_SUPPLY_ITEM_LENGTH,
  MAX_SUPPLY_ITEMS,
  MAX_WEBSITE_LENGTH,
  normalizeEmail,
  normalizeInn,
  normalizePhone,
  normalizeSupplierCard,
  parseSupplierNote,
  prepareCardForWrite,
  primaryContact,
  sortDuplicates,
  supplierCardIdFromHash,
  supplierCardIdSeed,
  SUPPLIER_STATUS_LABELS,
  SUPPLIER_STATUSES,
  supplierFromCard,
  validateSupplierCard,
  type SupplierCard,
  type SupplierCardSource,
} from '../../../src/kit/domain/supplier-card';
import { FULL_CARD } from '../support/supplier-fixtures';

const codes = (card: SupplierCard): string[] =>
  validateSupplierCard(normalizeSupplierCard(card)).map((issue) => issue.code);

describe('нормализация значений', () => {
  test('ИНН - только цифры', () => {
    expect(normalizeInn(' 7707-083 893 ')).toBe('7707083893');
    expect(normalizeInn('ИНН')).toBe('');
  });

  test('email: обрезка и нижний регистр', () => {
    expect(normalizeEmail('  Sales@Example.RU ')).toBe('sales@example.ru');
  });

  test('телефон: российские номера единым видом, иностранные и текст сохраняются', () => {
    expect(normalizePhone('8 (999) 123-45-67')).toBe('+79991234567');
    expect(normalizePhone('+7 999 123 45 67')).toBe('+79991234567');
    expect(normalizePhone('7-999-123-45-67')).toBe('+79991234567');
    expect(normalizePhone('999 123 45 67')).toBe('+79991234567');
    expect(normalizePhone('+49 30 1234567')).toBe('+49301234567');
    expect(normalizePhone('доб. 12 к 495')).toBe('доб. 12 к 495');
    expect(normalizePhone(' - ')).toBe('');
  });
});

describe('normalizeSupplierCard', () => {
  test('основной контакт: нет отмеченных - первый; несколько - первый из отмеченных', () => {
    const none = normalizeSupplierCard({
      ...FULL_CARD,
      contacts: [
        { fullName: 'А', isPrimary: false },
        { fullName: 'Б', isPrimary: false },
      ],
    });
    expect(none.contacts.map((c) => c.isPrimary)).toEqual([true, false]);
    const several = normalizeSupplierCard({
      ...FULL_CARD,
      contacts: [
        { fullName: 'А', isPrimary: false },
        { fullName: 'Б', isPrimary: true },
        { fullName: 'В', isPrimary: true },
      ],
    });
    expect(several.contacts.map((c) => c.isPrimary)).toEqual([false, true, false]);
  });

  test('пустые контакты и значения убираются, списки без повторов', () => {
    const card = normalizeSupplierCard({
      ...FULL_CARD,
      website: '  ',
      contacts: [
        { fullName: ' ', email: '', isPrimary: true },
        { fullName: 'А', isPrimary: false },
      ],
      supplies: { categories: ['Арматура', ' арматура ', ' '], brands: [], regions: ['Тула'] },
      terms: { payment: '  ', delivery: ' самовывоз ' },
    });
    expect(card.website).toBeUndefined();
    expect(card.contacts).toEqual([{ fullName: 'А', isPrimary: true }]);
    expect(card.supplies.categories).toEqual(['Арматура']);
    expect(card.terms).toEqual({ delivery: 'самовывоз' });
  });

  test('не меняет исходный объект', () => {
    const copy = structuredClone(FULL_CARD);
    normalizeSupplierCard(FULL_CARD);
    expect(FULL_CARD).toEqual(copy);
  });
});

describe('validateSupplierCard', () => {
  test('полная карточка без замечаний', () => {
    expect(validateSupplierCard(normalizeSupplierCard(FULL_CARD))).toEqual([]);
  });

  test('ИНН проверяется контрольной суммой, текст замечания без значения', () => {
    const issues = validateSupplierCard({ ...FULL_CARD, inn: '7707083894' });
    expect(issues.map((i) => i.code)).toEqual(['inn_invalid']);
    expect(issues[0]?.message).not.toContain('7707083894');
    expect(codes({ ...FULL_CARD, inn: '12345' })).toEqual(['inn_invalid']);
  });

  test('название, статус, сайт, контакты', () => {
    expect(codes({ ...FULL_CARD, name: ' ' })).toEqual(['name_required']);
    expect(codes({ ...FULL_CARD, website: 'не сайт' })).toEqual(['website_invalid']);
    expect(codes({ ...FULL_CARD, website: 'metalltorg.ru/catalog' })).toEqual([]);
    expect(codes({ ...FULL_CARD, contacts: [{ fullName: 'А', email: 'нет', isPrimary: true }] }))
      .toEqual(['contact_email_invalid']);
    expect(codes({ ...FULL_CARD, contacts: [{ fullName: 'А', phone: '123', isPrimary: true }] }))
      .toEqual(['contact_phone_invalid']);
  });

  test('основной контакт: без отметки и с двумя - замечание (без нормализации)', () => {
    const contacts = [
      { fullName: 'А', isPrimary: false },
      { fullName: 'Б', isPrimary: false },
    ];
    expect(validateSupplierCard({ ...FULL_CARD, contacts }).map((i) => i.code)).toEqual([
      'contact_primary_missing',
    ]);
    const both = contacts.map((c) => ({ ...c, isPrimary: true }));
    expect(validateSupplierCard({ ...FULL_CARD, contacts: both }).map((i) => i.code)).toEqual([
      'contact_primary_multiple',
    ]);
  });

  test('пределы: контакты, списки, условия, заметки', () => {
    const many = Array.from({ length: MAX_CONTACTS + 1 }, (_, i) => ({
      fullName: `К${i}`,
      isPrimary: i === 0,
    }));
    expect(codes({ ...FULL_CARD, contacts: many })).toEqual(['contacts_too_many']);
    expect(
      codes({ ...FULL_CARD, supplies: { ...FULL_CARD.supplies, regions: ['я'.repeat(101)] } }),
    ).toEqual(['regions_item_too_long']);
    expect(codes({ ...FULL_CARD, terms: { discounts: 'я'.repeat(301) } })).toEqual([
      'discounts_too_long',
    ]);
    const note = {
      text: 'я'.repeat(MAX_NOTE_LENGTH + 1),
      authorId: 'u',
      createdAt: FULL_CARD.createdAt ?? '',
    };
    expect(codes({ ...FULL_CARD, notes: [note] })).toEqual(['note_too_long']);
  });

  test('реквизиты: неверный КПП назван замечанием', () => {
    expect(codes({ ...FULL_CARD, kpp: '12345' })).toEqual(['requisite_invalid']);
  });
});

describe('связь с прежним Supplier', () => {
  test('supplierFromCard: email и contactName - основной контакт', () => {
    const supplier = supplierFromCard(FULL_CARD);
    expect(supplier.email).toBe('petrov@metalltorg.example.ru');
    expect(supplier.contactName).toBe('Петров Пётр');
    expect(supplier.inn).toBe(FULL_CARD.inn);
    expect('contacts' in supplier).toBe(false);
  });

  test('primaryContact: помеченный, иначе первый', () => {
    expect(primaryContact(FULL_CARD.contacts)?.fullName).toBe('Петров Пётр');
    expect(primaryContact([{ fullName: 'А', isPrimary: false }])?.fullName).toBe('А');
    expect(primaryContact([])).toBeUndefined();
  });

  test('cardFromParts: email и contactName прежней записи становятся основным контактом', () => {
    const empty = {
      status: 'new' as const,
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    };
    const card = cardFromParts(
      { id: 's', name: 'А', email: 'a@b.ru', contactName: 'Иван' },
      empty,
    );
    expect(card.contacts).toEqual([{ fullName: 'Иван', email: 'a@b.ru', isPrimary: true }]);
    expect(card.status).toBe('new');
    expect(cardFromParts({ id: 's', name: 'А' }, empty).contacts).toEqual([]);
  });

  test('cardFromParts: сохранённые контакты важнее прежних полей', () => {
    const card = cardFromParts(
      { id: 's', name: 'А', email: 'old@b.ru' },
      {
        status: 'active',
        contacts: [{ fullName: 'Новый', isPrimary: true }],
        supplies: { categories: [], brands: [], regions: [] },
        terms: {},
        notes: [],
      },
    );
    expect(card.contacts).toEqual([{ fullName: 'Новый', isPrimary: true }]);
    expect('email' in card).toBe(false);
  });

  test('идентификатор: основа - ИНН, без него нормализованное название', () => {
    expect(supplierCardIdSeed({ name: 'ООО «Ромашка»', inn: '7707-083-893' })).toBe(
      'inn:7707083893',
    );
    expect(supplierCardIdSeed({ name: 'ООО «Ромашка»' })).toBe('name:ромашка');
    expect(supplierCardIdSeed({ name: 'ромашка ооо', inn: ' ' })).toBe('name:ромашка');
  });
});

describe('подписи', () => {
  test('у каждого статуса и причины дубля есть подпись', () => {
    for (const status of SUPPLIER_STATUSES) {
      expect(SUPPLIER_STATUS_LABELS[status]).not.toBe('');
    }
    expect(Object.keys(DUPLICATE_REASON_LABELS).sort()).toEqual(['email', 'inn', 'name']);
  });

  test('идентификатор карточки: sup-<хэш>', () => {
    expect(supplierCardIdFromHash('a1b2')).toBe('sup-a1b2');
  });
});

describe('ключи дублей', () => {
  test('ИНН цифрами, email всех контактов и прежний, нормализованное название', () => {
    const keys = findDuplicateKeys({
      name: 'ООО «Металл-Торг»',
      inn: '7707 083 893',
      email: 'A@B.ru',
      contacts: [{ email: ' a@b.RU' }, { email: 'c@d.ru' }, {}],
    });
    expect(keys).toEqual({
      inn: '7707083893',
      emails: ['a@b.ru', 'c@d.ru'],
      name: 'металл торг',
    });
  });

  test('duplicateReasons: причины в порядке силы; пустые ключи не совпадают', () => {
    const a = findDuplicateKeys({ name: 'Ромашка ООО', inn: '7707083893', email: 'x@y.ru' });
    const b = findDuplicateKeys({ name: 'ооо ромашка', inn: '7707083893', email: 'X@y.ru' });
    expect(duplicateReasons(a, b)).toEqual(['inn', 'email', 'name']);
    const empty = findDuplicateKeys({ name: 'ООО' });
    expect(duplicateReasons(empty, empty)).toEqual(['name']);
    const blank = findDuplicateKeys({ name: '' });
    expect(duplicateReasons(blank, blank)).toEqual([]);
  });

  test('sortDuplicates: сила причины, название, id', () => {
    const sorted = sortDuplicates([
      { supplierId: '3', name: 'Я', reason: 'name', reasons: ['name'] },
      { supplierId: '2', name: 'Б', reason: 'email', reasons: ['email'] },
      { supplierId: '1', name: 'В', reason: 'inn', reasons: ['inn'] },
      { supplierId: '0', name: 'А', reason: 'email', reasons: ['email'] },
    ]);
    expect(sorted.map((d) => d.supplierId)).toEqual(['1', '0', '2', '3']);
  });
});

describe('prepareCardForWrite и заметки', () => {
  test('нормализует и возвращает прежнюю запись для столбцов', () => {
    const { card, supplier } = prepareCardForWrite({
      ...FULL_CARD,
      inn: '7707 083 893',
      contacts: [{ fullName: ' Петров ', email: 'P@X.ru', isPrimary: false }],
    });
    expect(card.inn).toBe('7707083893');
    expect(supplier).toMatchObject({ email: 'p@x.ru', contactName: 'Петров', inn: '7707083893' });
  });

  test('ошибки: invalid_input без значений полей', () => {
    expect(() => prepareCardForWrite({ ...FULL_CARD, inn: '7707083894' })).toThrow(
      /ИНН: неверная длина/,
    );
    try {
      prepareCardForWrite({ ...FULL_CARD, inn: '7707083894' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('7707083894');
    }
  });

  test('parseSupplierNote: текст обрезается, пустой и длинный отклоняются', () => {
    const at = '2026-03-05T09:00:00.000Z';
    expect(parseSupplierNote({ text: ' да ', authorId: 'u', createdAt: at }).text).toBe('да');
    expect(() => parseSupplierNote({ text: ' ', authorId: 'u', createdAt: at })).toThrow();
    expect(() => parseSupplierNote({ text: 'х', authorId: '', createdAt: at })).toThrow();
    const badDate = { text: 'х', authorId: 'u', createdAt: '01.02.2026' };
    expect(() => parseSupplierNote(badDate)).toThrow();
  });
});

describe('расположение и оценка (разд. 10.7 и 10.9 ТЗ)', () => {
  test('старая карточка без новых полей остаётся валидной и не получает их', () => {
    const normalized = normalizeSupplierCard(FULL_CARD);
    for (const key of ['productionCity', 'address', 'strengths', 'weaknesses']) {
      expect(key in normalized).toBe(false);
    }
    expect('defectRatePercent' in normalized).toBe(false);
  });

  test('текстовые поля обрезаются по краям, пустые убираются', () => {
    const normalized = normalizeSupplierCard({
      ...FULL_CARD,
      productionCity: '  Казань ',
      address: '   ',
      strengths: ' тиражи ',
    });
    expect(normalized.productionCity).toBe('Казань');
    expect('address' in normalized).toBe(false);
    expect(normalized.strengths).toBe('тиражи');
  });

  test('процент брака: 0 и 100 допустимы, вне диапазона и NaN - замечание без значения', () => {
    expect(codes({ ...FULL_CARD, defectRatePercent: 0 })).toEqual([]);
    expect(codes({ ...FULL_CARD, defectRatePercent: 100 })).toEqual([]);
    expect(codes({ ...FULL_CARD, defectRatePercent: -0.1 })).toEqual(['defect_rate_invalid']);
    expect(codes({ ...FULL_CARD, defectRatePercent: 101 })).toEqual(['defect_rate_invalid']);
    expect(codes({ ...FULL_CARD, defectRatePercent: Number.NaN })).toEqual([
      'defect_rate_invalid',
    ]);
  });

  test('слишком длинные тексты отклоняются', () => {
    expect(codes({ ...FULL_CARD, productionCity: 'я'.repeat(101) })).toEqual([
      'productionCity_too_long',
    ]);
    expect(codes({ ...FULL_CARD, strengths: 'я'.repeat(1001) })).toEqual(['strengths_too_long']);
  });
});
