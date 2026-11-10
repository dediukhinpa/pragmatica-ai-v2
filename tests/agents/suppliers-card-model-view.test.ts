import { describe, expect, test } from 'bun:test';
import {
  MODEL_CARD_DETAILS_MAX_CHARS,
  MODEL_EXCLUDED_CARD_KEYS,
  describeCardForModel,
  modelVisibleEntries,
} from '../../src/agents/suppliers/card-view';
import { PseudonymizingModelGateway } from '@business-ai/core';
import { findSupplierCard } from '../../src/agents/suppliers/supplier-tools';
import { REQUISITE_FIELDS } from '../../src/kit/domain/requisites';
import {
  SUPPLIER_FULL_KEYS,
  type SupplierFullParts,
} from '../../src/kit/domain/supplier-card-full';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import type { ModelRequest } from '@business-ai/core';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { DictionaryPseudonymizer } from '@business-ai/testing';
import { StreamScriptGateway, textSteps } from '@business-ai/testing';
import { THREAD_A, USER_A, buildSupplierWorld, turnContext } from './suppliers-support';

/** Значения, которые не должны дойти до модели в открытом виде. */
const LOGO_REF = 'kb://suppliers/logo-secret.png';
const MATERIAL_REF = 'kb://suppliers/deck-secret.pdf';
const ACCOUNT = FULL_SUPPLIER.settlementAccount ?? '';
const CONTACT_NAME = 'Сидоров Пётр Андреевич';
const DIRECTOR_NAME = 'Кузнецова Анна Викторовна';
const CONTACT_PHONE = '+79021234567';
const CONTACT_EMAIL = 'petr.sidorov@supplier.example.ru';
const ENTITY_INN = '7707083893';
/** Конец длинного значения: по нему видно, что строка не обрезана посередине. */
const HUGE_END = ' КОНЕЦ';

/** Полная карточка: ВСЕ необязательные поля разд. 10 заполнены (тип требует каждое). */
const FULL_PARTS: Required<SupplierFullParts> = {
  logoRef: LOGO_REF,
  supplierKind: 'production_and_branding',
  foundedYear: 2005,
  agencyDiscountPercent: 5,
  minOrderAmount: 'от 30 000 руб.',
  samplesAvailable: true,
  samplesQuantity: 2,
  samplesTerms: 'бесплатно при заказе от 100 шт',
  paymentNotes: 'предоплата 50%',
  vatMode: 'with_vat',
  vatRatePercent: 22,
  freeDelivery: 'от 100 000 руб.',
  documentFlow: 'edo',
  contractNotes: 'рамочный договор',
  legalEntities: [{ name: 'ООО Альфа', inn: ENTITY_INN }],
  packaging: 'gift',
  packagingPricing: 'separate_price',
  technologies: ['литьё', 'штамповка'],
  personalizationTypes: ['тампопечать', 'гравировка'],
  materials: [
    { kind: 'presentation', ref: MATERIAL_REF, title: 'Презентация' },
    { kind: 'portfolio', ref: 'kb://suppliers/portfolio-secret.pdf' },
  ],
  technicalRequirements: 'макеты в векторе',
  pragmatikaPortfolio: 'делали кружки для клиента',
  transportInfo: 'въезд с 9 до 18, пропуск',
  marketingSupport: 'каталоги по запросу',
  trainingFormats: ['online', 'offline'],
  exclusivity: 'есть по региону',
  hasOwnDesigners: true,
  designServices: 'макет за 2 дня',
  hasQualityControl: true,
  additionalServices: 'фасовка',
  claimsHandling: 'ответ за 3 дня',
  competitiveAdvantages: 'свой цех',
  customers: 'крупные банки',
  turnoverRub: 150_000_000,
  turnoverByYear: [
    { year: 2025, rub: 160_000_000 },
    { year: 2024, rub: 150_000_000 },
  ],
  okved: '32.99',
  employeeCount: 120,
};

const FULL_CARD: SupplierCard = {
  id: 'sup-full',
  name: 'Альфа',
  inn: ENTITY_INN,
  status: 'active',
  contacts: [
    {
      fullName: CONTACT_NAME,
      email: CONTACT_EMAIL,
      phone: CONTACT_PHONE,
      isPrimary: true,
    },
  ],
  supplies: { categories: ['кружки'], brands: [], regions: [] },
  terms: { payment: 'безнал', leadTime: '10 дней' },
  notes: [],
  kpp: FULL_SUPPLIER.kpp,
  ogrn: FULL_SUPPLIER.ogrn,
  legalAddress: FULL_SUPPLIER.legalAddress,
  bankName: FULL_SUPPLIER.bankName,
  bik: FULL_SUPPLIER.bik,
  settlementAccount: ACCOUNT,
  correspondentAccount: FULL_SUPPLIER.correspondentAccount,
  directorName: DIRECTOR_NAME,
  productionCity: 'Тверь',
  address: 'г. Тверь, ул. Заводская, 5',
  strengths: 'быстро',
  weaknesses: 'дорого',
  defectRatePercent: 1.5,
  ...FULL_PARTS,
};

/** Ключи карточки, по которым модель видит значения (все решения «показать»). */
function visibleKeys(card: SupplierCard): Set<string> {
  return new Set(modelVisibleEntries(card).flatMap((item) => item.keys.map(String)));
}

describe('что видит модель: полнота полей карточки (разд. 10)', () => {
  test('фикстура охватывает ровно список полей полной карточки', () => {
    expect(Object.keys(FULL_PARTS).sort()).toEqual([...SUPPLIER_FULL_KEYS].sort());
  });

  test('у каждого поля решение: показывается либо явно исключено', () => {
    const shown = visibleKeys(FULL_CARD);
    const excluded: ReadonlySet<string> = new Set(MODEL_EXCLUDED_CARD_KEYS);
    const decidable = [
      ...SUPPLIER_FULL_KEYS,
      ...REQUISITE_FIELDS.filter((key) => key !== 'inn'),
      'productionCity',
      'address',
      'strengths',
      'weaknesses',
      'defectRatePercent',
    ];
    const undecided = decidable.filter((key) => !shown.has(key) && !excluded.has(key));
    expect(undecided).toEqual([]);
    // Исключённое не показывается ни в каком виде.
    for (const key of excluded) expect(shown.has(key)).toBe(false);
  });

  test('исключены логотип, файлы и реквизиты юрлица (кроме ИНН)', () => {
    const expected: string[] = [
      'logoRef',
      'materials',
      'kpp',
      'ogrn',
      'legalAddress',
      'bankName',
      'bik',
      'settlementAccount',
      'correspondentAccount',
      'directorName',
    ];
    const actual: string[] = [...MODEL_EXCLUDED_CARD_KEYS];
    expect(actual.sort()).toEqual(expected.sort());
  });

  test('реквизиты, подписант и юридический адрес в выдаче отсутствуют', () => {
    const details = describeCardForModel(FULL_CARD);
    expect(details).not.toContain('Реквизит:');
    for (const secret of [
      DIRECTOR_NAME,
      ACCOUNT,
      FULL_SUPPLIER.legalAddress,
      FULL_SUPPLIER.bankName,
      FULL_SUPPLIER.bik,
      FULL_SUPPLIER.kpp,
      FULL_SUPPLIER.ogrn,
      FULL_SUPPLIER.correspondentAccount,
    ]) {
      expect(secret).toBeDefined();
      expect(details).not.toContain(secret ?? '');
    }
    // Название юрлица и маскированный ИНН (разд. 10.5) остаются.
    expect(details).toContain('Юридические лица: ООО Альфа (ИНН ***3893)');
    // Адрес склада и производства - не юридический адрес, он виден.
    expect(details).toContain('Адрес склада и производства: ');
  });

  const shownEntries = modelVisibleEntries(FULL_CARD);
  for (const item of shownEntries) {
    test(`поле «${item.label}» присутствует в выдаче`, () => {
      expect(item.value).toBeDefined();
      expect(describeCardForModel(FULL_CARD)).toContain(`${item.label}: `);
    });
  }

  test('логотип и файлы в выдаче отсутствуют', () => {
    const details = describeCardForModel(FULL_CARD);
    expect(details).not.toContain(LOGO_REF);
    expect(details).not.toContain('Логотип');
    expect(details).not.toContain('secret');
    expect(details).not.toContain('Презентац');
    expect(details).not.toContain('Портфолио (');
  });

  test('числа и НДС записаны понятно', () => {
    const details = describeCardForModel(FULL_CARD);
    expect(details).toContain('НДС: с НДС 22%');
    expect(details).toContain('Оборот: 150 000 000 руб.');
    expect(details).toContain('Оборот по годам: 2025 - 160 000 000 руб.; 2024 - 150 000 000 руб.');
    expect(details).toContain('Скидка для агентства: 5%');
    expect(details).toContain('Процент брака: 1.5%');
    const noVat = describeCardForModel({
      ...FULL_CARD,
      vatMode: 'no_vat',
      vatRatePercent: undefined,
    });
    expect(noVat).toContain('НДС: без НДС (УСН)');
  });

  test('пустые поля не печатаются, карточка без сведений даёт пустой вид', () => {
    const bare: SupplierCard = {
      id: 'b',
      name: 'Пустая',
      status: 'new',
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    };
    expect(describeCardForModel(bare)).toBe('');
    const partial = describeCardForModel({ ...bare, vatMode: 'no_vat' });
    expect(partial).toBe('10.3 Условия работы:\n  НДС: без НДС (УСН)');
  });

  test('длина ограничена константой', () => {
    const huge = `${'х'.repeat(1000)}${HUGE_END}`;
    const card: SupplierCard = {
      ...FULL_CARD,
      paymentNotes: huge,
      contractNotes: huge,
      marketingSupport: huge,
      exclusivity: huge,
      designServices: huge,
      additionalServices: huge,
      claimsHandling: huge,
      competitiveAdvantages: huge,
      customers: huge,
      technicalRequirements: huge.repeat(2),
      pragmatikaPortfolio: huge.repeat(2),
    };
    const details = describeCardForModel(card);
    expect(details.length).toBeLessThan(MODEL_CARD_DETAILS_MAX_CHARS + 100);
    expect(details).toContain('остальное не показано');
    // Обрезка по границе строки: каждая длинная строка выдачи заканчивается целиком.
    for (const line of details.split('\n')) {
      if (line.includes('ххх')) expect(line.endsWith(HUGE_END)).toBe(true);
    }
  });
});

describe('что видит модель: контакты и серии цифр', () => {
  async function foundCard() {
    const world = buildSupplierWorld();
    await world.suppliers.saveCard(FULL_CARD);
    const out = await findSupplierCard.execute(
      { id: FULL_CARD.id },
      world.host,
      turnContext(USER_A, THREAD_A),
    );
    return out.cards[0];
  }

  test('инструмент отдаёт подробности без логотипа и файлов, контакты маскированы', async () => {
    const card = await foundCard();
    const wire = JSON.stringify(card);
    expect(card?.details).toContain('Юридические лица: ООО Альфа (ИНН ***3893)');
    for (const secret of [LOGO_REF, MATERIAL_REF, CONTACT_PHONE, CONTACT_EMAIL, ACCOUNT]) {
      expect(wire).not.toContain(secret);
    }
    // Серий из 10+ цифр нет ни в подробностях, ни в остальной выдаче.
    expect(wire.match(/\d{10,}/g)).toBeNull();
    expect(card?.contacts[0]?.phone).toBe('***4567');
    expect(card?.contacts[0]?.email).toBe('p***@supplier.example.ru');
  });

  test('шлюз псевдонимизации: ФИО из подробностей и контактов до модели не доходят', async () => {
    const card = await foundCard();
    const inner = new StreamScriptGateway(textSteps('ок'));
    const gateway = new PseudonymizingModelGateway(
      inner,
      new DictionaryPseudonymizer([
        { kind: 'PERSON', values: [CONTACT_NAME, DIRECTOR_NAME] },
        { kind: 'EMAIL', values: [CONTACT_EMAIL] },
        { kind: 'PHONE', values: [CONTACT_PHONE] },
      ]),
    );
    const request: ModelRequest = {
      model: 'm',
      threadId: 't-card',
      messages: [
        { role: 'user', content: 'Покажи карточку Альфа' },
        { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ count: 1, cards: [card] }) },
      ],
    };
    await gateway.complete(request);
    const sent = JSON.stringify(inner.requests);
    for (const secret of [CONTACT_NAME, DIRECTOR_NAME, CONTACT_PHONE, CONTACT_EMAIL]) {
      expect(sent).not.toContain(secret);
    }
    expect(sent).toContain('[PERSON_');
    expect(sent).toContain('Тампопечать'.toLowerCase());
  });
});
