import type { Supplier } from '../../../src/kit/domain/models';
import type {
  SupplierCard,
  SupplierSupplies,
  SupplierTerms,
} from '../../../src/kit/domain/supplier-card';

/** Реальные публичные реквизиты банка (БИК и корсчёт) и юрлица: контрольные суммы сходятся. */
export const BIK = '044525225';
export const CORR = '30101810400000000225';
export const ACCOUNT = '40702810200000000001';
export const FULL_SUPPLIER: Supplier = {
  id: 's1',
  name: 'МеталлТорг',
  inn: '7707083893',
  kpp: '773601001',
  ogrn: '1027700132195',
  legalAddress: 'г. Москва, ул. Вавилова, 19',
  bankName: 'ПАО Сбербанк',
  bik: BIK,
  settlementAccount: ACCOUNT,
  correspondentAccount: CORR,
  directorName: 'Иванов И. И.',
};

/** Момент создания и правки карточки в тестах (фиксированный, чтобы сравнение было точным). */
export const CARD_CREATED_AT = '2026-03-01T10:00:00.000Z';
export const CARD_UPDATED_AT = '2026-03-02T12:30:00.000Z';

const FULL_SUPPLIES: SupplierSupplies = {
  categories: ['Арматура', 'Метизы'],
  brands: ['Северсталь', 'ММК'],
  regions: ['Москва', 'Московская область'],
};
const FULL_TERMS: SupplierTerms = {
  payment: 'предоплата 30%, остальное по факту',
  delivery: 'своим транспортом',
  minBatch: 'от 5 тонн',
  leadTime: '3-5 дней',
  discounts: 'от 20 тонн - 2%',
};

/** Полная карточка: контакты, что поставляет, условия, заметка, служебные поля. */
export const FULL_CARD: SupplierCard = {
  ...FULL_SUPPLIER,
  website: 'https://metalltorg.example.ru',
  status: 'active',
  contacts: [
    {
      fullName: 'Петров Пётр',
      position: 'менеджер по продажам',
      email: 'petrov@metalltorg.example.ru',
      phone: '+79990001122',
      messenger: '@petrov_mt',
      isPrimary: true,
    },
    { fullName: 'Сидорова Анна', email: 'sidorova@metalltorg.example.ru', isPrimary: false },
  ],
  supplies: FULL_SUPPLIES,
  terms: FULL_TERMS,
  notes: [{ text: 'Просили звонить до 15:00', authorId: 'u-ivanov', createdAt: CARD_CREATED_AT }],
  createdBy: 'u-ivanov',
  createdAt: CARD_CREATED_AT,
  updatedBy: 'u-ivanov',
  updatedAt: CARD_UPDATED_AT,
  source: 'chat',
};

/** Все поля раздела 10 ТЗ (миграции 024 и 025) для проверки записи и чтения целиком. */
export const FULL_SECTION_10: Partial<SupplierCard> = {
  logoRef: 'Поставщики/МеталлТорг/logo.png',
  supplierKind: 'production_and_branding',
  foundedYear: 2005,
  agencyDiscountPercent: 10,
  minOrderAmount: 'от 50 000 руб.',
  samplesAvailable: true,
  samplesQuantity: 2,
  samplesTerms: 'при заказе тиража',
  paymentNotes: 'оплата по счёту',
  vatMode: 'with_vat',
  vatRatePercent: 20,
  freeDelivery: 'от 30 000 руб. по Москве',
  documentFlow: 'edo',
  contractNotes: 'договор поставки, NDA',
  legalEntities: [
    { name: 'ООО «МеталлТорг»', inn: '7707083893' },
    { name: 'ИП Петров', inn: '500100732259' },
    { name: 'Без ИНН' },
  ],
  packaging: 'gift',
  packagingPricing: 'separate_price',
  technologies: ['литьё', 'штамповка'],
  personalizationTypes: ['гравировка'],
  materials: [
    { kind: 'presentation', ref: 'Поставщики/МеталлТорг/presentation.pdf', title: 'О компании' },
    { kind: 'portfolio', ref: 'Поставщики/МеталлТорг/portfolio.pdf' },
  ],
  technicalRequirements: 'макет в векторе',
  pragmatikaPortfolio: 'заказы 2024-2025',
  transportInfo: 'въезд со двора',
  marketingSupport: 'каталоги',
  trainingFormats: ['online', 'offline'],
  exclusivity: 'по направлению «ручки»',
  hasOwnDesigners: false,
  designServices: 'макет за 500 руб.',
  hasQualityControl: true,
  additionalServices: 'растиражовка',
  claimsHandling: 'замена за свой счёт',
  competitiveAdvantages: 'свои станки',
  customers: 'крупный ритейл',
  turnoverRub: 150_000_000,
  turnoverByYear: [
    { year: 2025, rub: 160_000_000 },
    { year: 2024, rub: 150_000_000 },
  ],
  okved: '32.99',
  employeeCount: 120,
};
