import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { isoInstantSchema } from './iso-datetime';
import type { Supplier } from './models';
import {
  checkSupplierRequisites,
  isValidInn,
  prepareSupplierForWrite,
  REQUISITE_LABELS,
} from './requisites';
import { normalizeSupplierName } from './shortlist';
import {
  normalizeFullParts,
  pickFullParts,
  SUPPLIER_FULL_KEYS,
  validateFullParts,
  type SupplierFullParts,
} from './supplier-card-full';
import type { ValidationIssue } from '@business-ai/core';

/**
 * Статусы поставщика. В ТЗ (разд. 10.1) это «тип поставщика»: действующий / потенциальный / не
 * действующий. Значения в базе прежние (`new` - потенциальный, `inactive` - не действующий),
 * меняются только подписи.
 */
export const SUPPLIER_STATUSES = ['active', 'new', 'inactive'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
/** Статус новой карточки, если сотрудник его не назвал. */
export const DEFAULT_SUPPLIER_STATUS: SupplierStatus = 'new';
/** Названия статусов для сообщений людям. */
export const SUPPLIER_STATUS_LABELS: Readonly<Record<SupplierStatus, string>> = {
  active: 'действующий',
  new: 'потенциальный',
  inactive: 'не действующий',
};

/** Откуда пришла запись: чат, файл-шаблон, пересланное письмо. */
export const SUPPLIER_CARD_SOURCES = ['chat', 'file', 'email'] as const;
export type SupplierCardSource = (typeof SUPPLIER_CARD_SOURCES)[number];

/** Пределы длины и числа записей (совпадают с CHECK в миграции 018). */
export const MAX_SUPPLIER_NAME_LENGTH = 300;
export const MAX_WEBSITE_LENGTH = 200;
export const MAX_CONTACTS = 10;
export const MAX_CONTACT_NAME_LENGTH = 150;
export const MAX_CONTACT_POSITION_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PHONE_LENGTH = 32;
export const MAX_MESSENGER_LENGTH = 100;
export const MAX_SUPPLY_ITEMS = 50;
export const MAX_SUPPLY_ITEM_LENGTH = 100;
export const MAX_TERM_LENGTH = 300;
export const MAX_NOTE_LENGTH = 2000;
/** Пределы расположения и оценки (совпадают с CHECK в миграции 023). */
export const MAX_CITY_LENGTH = 100;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_ASSESSMENT_LENGTH = 1000;
/** Процент брака по заказам: от 0 до 100 включительно. */
export const MIN_DEFECT_RATE_PERCENT = 0;
export const MAX_DEFECT_RATE_PERCENT = 100;
export const MAX_ACTOR_ID_LENGTH = 200;
/** Предел длины идентификатора карточки. */
export const MAX_SUPPLIER_ID_LENGTH = 100;

/** Число цифр в телефоне: от местного номера до международного (E.164). */
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
/** Российский номер: 11 цифр с кодом страны 7 или 8, либо 10 цифр без него. */
const RU_PHONE_LENGTH = 11;
const RU_PHONE_LOCAL_LENGTH = 10;
const RU_COUNTRY_CODE = '+7';
/** Префикс идентификатора карточки; хэш добавляет вызывающий слой (`stableHash`). */
const SUPPLIER_CARD_ID_PREFIX = 'sup-';

const WEBSITE_PATTERN = /^(https?:\/\/)?[\p{L}\p{N}][\p{L}\p{N}.-]*\.[\p{L}]{2,}(:\d+)?(\/\S*)?$/u;
const NOT_DIGIT = /\D/g;
const HAS_LETTER = /\p{L}/u;
const EMAIL_CHECK = z.string().email();

/** Контакт поставщика. ФИО необязательно: у прежних записей был только адрес. */
export interface SupplierContact {
  fullName?: string | undefined;
  /** Должность. */
  position?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  messenger?: string | undefined;
  /** Основной контакт: ровно один, если контакты есть. */
  isPrimary: boolean;
}

/** Заметка к карточке: текст, автор, момент. Только добавляется, не правится. */
export interface SupplierNote {
  text: string;
  authorId: string;
  /** ISO 8601 с часовым поясом. */
  createdAt: string;
}

/** Что поставляет: списки коротких строк. */
export interface SupplierSupplies {
  categories: string[];
  brands: string[];
  regions: string[];
}

/** Условия работы: короткие тексты. */
export interface SupplierTerms {
  payment?: string | undefined;
  delivery?: string | undefined;
  minBatch?: string | undefined;
  leadTime?: string | undefined;
  discounts?: string | undefined;
}

/**
 * Карточка поставщика: прежняя запись `Supplier` (название, реквизиты) плюс сайт, статус,
 * контакты, что поставляет, условия, заметки и служебные поля. Прежние `email`/`contactName`
 * в карточке заменены контактами; обратно в `Supplier` они выводятся из основного контакта
 * (`supplierFromCard`), поэтому код, читающий `supplier.email`, продолжает работать.
 */
export interface SupplierCard
  extends Omit<Supplier, 'email' | 'contactName'>,
    SupplierFullParts {
  website?: string | undefined;
  status: SupplierStatus;
  contacts: SupplierContact[];
  supplies: SupplierSupplies;
  terms: SupplierTerms;
  notes: SupplierNote[];
  createdBy?: string | undefined;
  createdAt?: string | undefined;
  updatedBy?: string | undefined;
  updatedAt?: string | undefined;
  source?: SupplierCardSource | undefined;
  /** Город производства (разд. 10.7 ТЗ). Поля ниже необязательны: у старых карточек их нет. */
  productionCity?: string | undefined;
  /** Фактический адрес склада и производства (разд. 10.7), может быть полным. */
  address?: string | undefined;
  /** Сильные стороны: с какими заказами лучше обращаться (разд. 10.9). */
  strengths?: string | undefined;
  /** Слабые стороны: с какими заказами не стоит обращаться (разд. 10.9). */
  weaknesses?: string | undefined;
  /** Процент брака по заказам, 0-100 (разд. 10.9). 0 - сведение «брака нет», не отсутствие. */
  defectRatePercent?: number | undefined;
}

/** Необязательные поля расположения и оценки карточки (разд. 10.7 и 10.9 ТЗ). */
export interface SupplierAssessmentParts {
  productionCity?: string | undefined;
  address?: string | undefined;
  strengths?: string | undefined;
  weaknesses?: string | undefined;
  defectRatePercent?: number | undefined;
}

/** Текстовые поля расположения и оценки с предельной длиной. */
const ASSESSMENT_TEXT_LIMITS = {
  productionCity: MAX_CITY_LENGTH,
  address: MAX_ADDRESS_LENGTH,
  strengths: MAX_ASSESSMENT_LENGTH,
  weaknesses: MAX_ASSESSMENT_LENGTH,
} as const;

/** Ключи текстовых полей расположения и оценки. */
const ASSESSMENT_TEXT_KEYS = Object.keys(ASSESSMENT_TEXT_LIMITS) as Array<
  keyof typeof ASSESSMENT_TEXT_LIMITS
>;

const shortText = (max: number): z.ZodString => z.string().trim().min(1).max(max);

const noteSchema: z.ZodType<SupplierNote, z.ZodTypeDef, unknown> = z.object({
  text: shortText(MAX_NOTE_LENGTH),
  authorId: shortText(MAX_ACTOR_ID_LENGTH),
  createdAt: isoInstantSchema,
});

/** ИНН как цифры: пробелы, дефисы и буквы отбрасываются. */
export function normalizeInn(raw: string): string {
  return raw.replace(NOT_DIGIT, '');
}

/** Email для сравнения и хранения: без пробелов по краям, в нижнем регистре. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Телефон: российские номера приводятся к `+7XXXXXXXXXX`, иностранные остаются цифрами
 * (с «+», если он был). Текст с буквами («доб. 12») не меняется, только обрезается.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (HAS_LETTER.test(trimmed)) return trimmed;
  const digits = trimmed.replace(NOT_DIGIT, '');
  if (digits === '') return '';
  const isRussian =
    digits.length === RU_PHONE_LENGTH && (digits.startsWith('7') || digits.startsWith('8'));
  if (isRussian) return `${RU_COUNTRY_CODE}${digits.slice(1)}`;
  if (digits.length === RU_PHONE_LOCAL_LENGTH) return `${RU_COUNTRY_CODE}${digits}`;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function cleanList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (value === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function cleanContact(contact: SupplierContact): SupplierContact {
  const email = cleanText(contact.email);
  const phone = cleanText(contact.phone);
  const fullName = cleanText(contact.fullName);
  const position = cleanText(contact.position);
  const messenger = cleanText(contact.messenger);
  return {
    ...(fullName === undefined ? {} : { fullName }),
    ...(position === undefined ? {} : { position }),
    ...(email === undefined ? {} : { email: normalizeEmail(email) }),
    ...(phone === undefined ? {} : { phone: normalizePhone(phone) }),
    ...(messenger === undefined ? {} : { messenger }),
    isPrimary: contact.isPrimary,
  };
}

function isEmptyContact(contact: SupplierContact): boolean {
  return (
    contact.fullName === undefined &&
    contact.email === undefined &&
    contact.phone === undefined &&
    contact.messenger === undefined
  );
}

/**
 * Привести карточку к каноническому виду перед проверкой и записью: строки обрезаны, пустые
 * отброшены, ИНН - цифры, email - нижний регистр, телефон - единый вид, списки без повторов
 * (без учёта регистра), пустые контакты убраны. Основной контакт ровно один: если не помечен
 * ни один - первый, если помечено несколько - первый из помеченных. Не проверяет значения.
 */
export function normalizeSupplierCard(card: SupplierCard): SupplierCard {
  const contacts = card.contacts.map(cleanContact).filter((contact) => !isEmptyContact(contact));
  const primaryIndex = Math.max(
    0,
    contacts.findIndex((contact) => contact.isPrimary),
  );
  const inn = cleanText(card.inn);
  const normalized: SupplierCard = {
    ...card,
    name: card.name.trim(),
    status: card.status,
    contacts: contacts.map((contact, index) => ({ ...contact, isPrimary: index === primaryIndex })),
    supplies: {
      categories: cleanList(card.supplies.categories),
      brands: cleanList(card.supplies.brands),
      regions: cleanList(card.supplies.regions),
    },
    terms: {},
    notes: card.notes.map((note) => ({
      text: note.text.trim(),
      authorId: note.authorId.trim(),
      createdAt: note.createdAt,
    })),
  };
  for (const key of ['website', 'createdBy', 'updatedBy'] as const) {
    const value = cleanText(card[key]);
    if (value === undefined) delete normalized[key];
    else normalized[key] = value;
  }
  if (inn === undefined) delete normalized.inn;
  else normalized.inn = normalizeInn(inn);
  for (const key of OTHER_REQUISITES) {
    const value = cleanText(card[key]);
    if (value === undefined) delete normalized[key];
    else normalized[key] = value;
  }
  for (const key of ['payment', 'delivery', 'minBatch', 'leadTime', 'discounts'] as const) {
    const value = cleanText(card.terms[key]);
    if (value !== undefined) normalized.terms[key] = value;
  }
  for (const key of ASSESSMENT_TEXT_KEYS) {
    const value = cleanText(card[key]);
    if (value === undefined) delete normalized[key];
    else normalized[key] = value;
  }
  // Поля полной карточки (разд. 10 ТЗ): сначала убираем перенесённые spread, затем кладём
  // нормализованные.
  for (const key of SUPPLIER_FULL_KEYS) delete normalized[key];
  Object.assign(normalized, normalizeFullParts(pickFullParts(card)));
  return normalized;
}

/** Реквизиты, которые карточка только обрезает по краям (ИНН нормализуется отдельно). */
const OTHER_REQUISITES = [
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
] as const;

/** Основной контакт карточки; undefined, если контактов нет. */
export function primaryContact(contacts: readonly SupplierContact[]): SupplierContact | undefined {
  return contacts.find((contact) => contact.isPrimary) ?? contacts[0];
}

/**
 * Прежняя запись `Supplier` из карточки: `email` - адрес основного контакта (при его
 * отсутствии - первого контакта с адресом), `contactName` - ФИО основного. Реквизиты те же.
 */
export function supplierFromCard(card: SupplierCard): Supplier {
  const main = primaryContact(card.contacts);
  const email = main?.email ?? card.contacts.find((contact) => contact.email !== undefined)?.email;
  const supplier: Supplier = {
    id: card.id,
    name: card.name,
    ...(email === undefined ? {} : { email }),
    ...(main?.fullName === undefined ? {} : { contactName: main.fullName }),
  };
  for (const key of ['inn', ...OTHER_REQUISITES] as const) {
    const value = card[key];
    if (value !== undefined) supplier[key] = value;
  }
  return supplier;
}

/** Всё, что хранится рядом с прежней записью `Supplier` и составляет карточку. */
export interface SupplierCardParts extends SupplierAssessmentParts, SupplierFullParts {
  website?: string | undefined;
  status: SupplierStatus;
  /** Сохранённые контакты; пусто - контакт выводится из `email`/`contactName` записи. */
  contacts: SupplierContact[];
  supplies: SupplierSupplies;
  terms: SupplierTerms;
  notes: SupplierNote[];
  createdBy?: string | undefined;
  createdAt?: string | undefined;
  updatedBy?: string | undefined;
  updatedAt?: string | undefined;
  source?: SupplierCardSource | undefined;
}

/**
 * Собрать карточку из прежней записи и остальных частей. Если сохранённых контактов нет, а у
 * записи есть `email` или `contactName`, они становятся основным контактом (запись, пришедшая
 * из прайса или шорт-листа, видна в карточке так же, как перенесённая миграцией).
 */
export function cardFromParts(supplier: Supplier, parts: SupplierCardParts): SupplierCard {
  const { email, contactName, ...rest } = supplier;
  const legacy: SupplierContact[] =
    parts.contacts.length === 0 && (email !== undefined || contactName !== undefined)
      ? [
          {
            ...(contactName === undefined ? {} : { fullName: contactName }),
            ...(email === undefined ? {} : { email }),
            isPrimary: true,
          },
        ]
      : parts.contacts;
  return { ...rest, ...parts, contacts: legacy.map((contact) => ({ ...contact })) };
}

/** Основа идентификатора карточки: ИНН, а без него нормализованное название. */
export function supplierCardIdSeed(input: { name: string; inn?: string | undefined }): string {
  const inn = input.inn === undefined ? '' : normalizeInn(input.inn);
  return inn === '' ? `name:${normalizeSupplierName(input.name)}` : `inn:${inn}`;
}

/**
 * Идентификатор карточки из отпечатка основы (`supplierCardIdSeed`), посчитанного вызывающим
 * слоем: `sup-<stableHash(seed)>`. Хэш лежит в application, поэтому здесь только сборка.
 */
export function supplierCardIdFromHash(hash: string): string {
  return `${SUPPLIER_CARD_ID_PREFIX}${hash}`;
}

/** Почему две записи считаются возможными дублями. */
const DUPLICATE_REASONS = ['inn', 'email', 'name'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/** Ключи сравнения для поиска дублей. */
export interface DuplicateKeys {
  /** ИНН цифрами; undefined, если нет. */
  inn: string | undefined;
  /** Адреса всех контактов и прежний `email`, в нижнем регистре, без повторов. */
  emails: string[];
  /** Нормализованное название (`normalizeSupplierName`); пустая строка - сравнивать нельзя. */
  name: string;
}

/** Всё, из чего берутся ключи дублей: карточка, прежний `Supplier` или набор полей. */
export interface DuplicateCandidate {
  /** Идентификатор записи: сама себе дублем она не считается. */
  id?: string | undefined;
  name: string;
  inn?: string | undefined;
  /** Прежний единственный адрес. */
  email?: string | undefined;
  contacts?: ReadonlyArray<{ email?: string | undefined }> | undefined;
}

/** Ключи дублей: ИНН; email (любой контакт или прежний); нормализованное название. */
export function findDuplicateKeys(candidate: DuplicateCandidate): DuplicateKeys {
  const innDigits = candidate.inn === undefined ? '' : normalizeInn(candidate.inn);
  const raw = [candidate.email, ...(candidate.contacts ?? []).map((contact) => contact.email)];
  const emails = new Set<string>();
  for (const value of raw) {
    const email = value === undefined ? '' : normalizeEmail(value);
    if (email !== '') emails.add(email);
  }
  return {
    inn: innDigits === '' ? undefined : innDigits,
    emails: [...emails],
    name: normalizeSupplierName(candidate.name),
  };
}

/** Причины совпадения двух наборов ключей, в порядке силы: ИНН, email, название. */
export function duplicateReasons(a: DuplicateKeys, b: DuplicateKeys): DuplicateReason[] {
  const reasons: DuplicateReason[] = [];
  if (a.inn !== undefined && a.inn === b.inn) reasons.push('inn');
  if (a.emails.some((email) => b.emails.includes(email))) reasons.push('email');
  if (a.name !== '' && a.name === b.name) reasons.push('name');
  return reasons;
}

/** Найденный возможный дубль. */
export interface DuplicateMatch {
  supplierId: string;
  name: string;
  /** Самая сильная причина (первая из `reasons`). */
  reason: DuplicateReason;
  reasons: DuplicateReason[];
}

/** Название причины для сообщений людям. */
export const DUPLICATE_REASON_LABELS: Readonly<Record<DuplicateReason, string>> = {
  inn: 'совпадает ИНН',
  email: 'совпадает email',
  name: 'совпадает название',
};

/** Порядок найденных дублей: сильная причина, затем название, затем id. */
export function sortDuplicates(matches: readonly DuplicateMatch[]): DuplicateMatch[] {
  const strength = (match: DuplicateMatch): number => DUPLICATE_REASONS.indexOf(match.reason);
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...matches].sort(
    (a, b) =>
      strength(a) - strength(b) ||
      compare(a.name, b.name) ||
      compare(a.supplierId, b.supplierId),
  );
}

function pushIssue(issues: ValidationIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

function checkLimit(
  issues: ValidationIssue[],
  value: string | undefined,
  max: number,
  code: string,
  label: string,
): void {
  if (value !== undefined && value.length > max) {
    pushIssue(issues, code, `${label}: не длиннее ${max} знаков.`);
  }
}

function checkContact(issues: ValidationIssue[], contact: SupplierContact, number: number): void {
  const label = `Контакт ${number}`;
  checkLimit(issues, contact.fullName, MAX_CONTACT_NAME_LENGTH, 'contact_name_too_long', label);
  checkLimit(issues, contact.position, MAX_CONTACT_POSITION_LENGTH, 'contact_position_too_long',
    label);
  checkLimit(issues, contact.messenger, MAX_MESSENGER_LENGTH, 'contact_messenger_too_long', label);
  if (contact.email !== undefined) {
    const tooLong = contact.email.length > MAX_EMAIL_LENGTH;
    if (tooLong || !EMAIL_CHECK.safeParse(contact.email).success) {
      pushIssue(issues, 'contact_email_invalid', `${label}: адрес почты записан неверно.`);
    }
  }
  if (contact.phone !== undefined) {
    const digits = contact.phone.replace(NOT_DIGIT, '').length;
    const bad = digits < MIN_PHONE_DIGITS || digits > MAX_PHONE_DIGITS;
    if (bad || contact.phone.length > MAX_PHONE_LENGTH) {
      pushIssue(issues, 'contact_phone_invalid', `${label}: телефон записан неверно.`);
    }
  }
}

function checkList(
  issues: ValidationIssue[],
  values: readonly string[],
  label: string,
  code: string,
): void {
  if (values.length > MAX_SUPPLY_ITEMS) {
    pushIssue(issues, `${code}_too_many`, `${label}: не больше ${MAX_SUPPLY_ITEMS} позиций.`);
  }
  if (values.some((value) => value.length > MAX_SUPPLY_ITEM_LENGTH)) {
    pushIssue(
      issues,
      `${code}_item_too_long`,
      `${label}: каждая позиция не длиннее ${MAX_SUPPLY_ITEM_LENGTH} знаков.`,
    );
  }
}

const TERM_LABELS: Readonly<Record<keyof SupplierTerms, string>> = {
  payment: 'Условия оплаты',
  delivery: 'Условия доставки',
  minBatch: 'Минимальная партия',
  leadTime: 'Сроки',
  discounts: 'Скидки',
};

const ASSESSMENT_LABELS: Readonly<Record<keyof typeof ASSESSMENT_TEXT_LIMITS, string>> = {
  productionCity: 'Город производства',
  address: 'Адрес склада и производства',
  strengths: 'Сильные стороны',
  weaknesses: 'Слабые стороны',
};

/**
 * Замечания к карточке (пусто = можно записывать). Проверяется то, что схема не видит:
 * контрольная сумма ИНН (`isValidInn`), реквизиты, основной контакт, формат email и телефона,
 * пределы длины. Карточку нужно предварительно привести `normalizeSupplierCard`. Тексты
 * замечаний значений не содержат (ни ИНН, ни адресов, ни ФИО): их можно показывать и писать
 * в журнал.
 */
export function validateSupplierCard(card: SupplierCard): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (card.name.trim() === '') {
    pushIssue(issues, 'name_required', 'Не указано название поставщика.');
  }
  checkLimit(issues, card.name, MAX_SUPPLIER_NAME_LENGTH, 'name_too_long', 'Название');
  if (card.inn !== undefined && !isValidInn(card.inn)) {
    pushIssue(issues, 'inn_invalid', 'ИНН: неверная длина или контрольная сумма.');
  }
  const requisites = checkSupplierRequisites(supplierFromCard({ ...card, inn: undefined }));
  for (const { field, reason } of requisites.invalid) {
    pushIssue(issues, 'requisite_invalid', `Реквизит «${REQUISITE_LABELS[field]}»: ${reason}.`);
  }
  if (card.website !== undefined) {
    const bad = card.website.length > MAX_WEBSITE_LENGTH || !WEBSITE_PATTERN.test(card.website);
    if (bad) pushIssue(issues, 'website_invalid', 'Сайт записан неверно.');
  }
  if (!SUPPLIER_STATUSES.includes(card.status)) {
    const message = 'Тип поставщика: допустимы «действующий», «потенциальный», «не действующий».';
    pushIssue(issues, 'status_invalid', message);
  }
  if (card.contacts.length > MAX_CONTACTS) {
    pushIssue(issues, 'contacts_too_many', `Контактов не больше ${MAX_CONTACTS}.`);
  }
  card.contacts.forEach((contact, index) => checkContact(issues, contact, index + 1));
  if (card.contacts.length > 0) {
    const primary = card.contacts.filter((contact) => contact.isPrimary).length;
    if (primary === 0) {
      pushIssue(issues, 'contact_primary_missing', 'Не отмечен основной контакт.');
    } else if (primary > 1) {
      pushIssue(issues, 'contact_primary_multiple', 'Основной контакт должен быть один.');
    }
  }
  checkList(issues, card.supplies.categories, 'Категории', 'categories');
  checkList(issues, card.supplies.brands, 'Бренды', 'brands');
  checkList(issues, card.supplies.regions, 'Регионы', 'regions');
  for (const key of Object.keys(TERM_LABELS) as Array<keyof SupplierTerms>) {
    checkLimit(issues, card.terms[key], MAX_TERM_LENGTH, `${key}_too_long`, TERM_LABELS[key]);
  }
  for (const key of ASSESSMENT_TEXT_KEYS) {
    const label = ASSESSMENT_LABELS[key];
    checkLimit(issues, card[key], ASSESSMENT_TEXT_LIMITS[key], `${key}_too_long`, label);
  }
  const defect = card.defectRatePercent;
  const defectOk =
    defect === undefined ||
    (Number.isFinite(defect) &&
      defect >= MIN_DEFECT_RATE_PERCENT &&
      defect <= MAX_DEFECT_RATE_PERCENT);
  if (!defectOk) {
    pushIssue(issues, 'defect_rate_invalid', 'Процент брака: число от 0 до 100.');
  }
  issues.push(...validateFullParts(card));
  for (const note of card.notes) {
    if (note.text.trim() === '') pushIssue(issues, 'note_empty', 'Заметка пуста.');
    checkLimit(issues, note.text, MAX_NOTE_LENGTH, 'note_too_long', 'Заметка');
  }
  return issues;
}

/** Сколько последних заметок отдаёт чтение карточки. */
export const SUPPLIER_NOTES_READ_LIMIT = 200;

/**
 * Проверить и привести заметку к записи: текст и автор обрезаются, пустой или слишком
 * длинный текст и неверная дата отклоняются.
 * @throws DomainError `invalid_input` с причиной без текста заметки.
 */
export function parseSupplierNote(note: SupplierNote): SupplierNote {
  const parsed = noteSchema.safeParse(note);
  if (parsed.success) return parsed.data;
  const reasons = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
  const labels: Record<string, string> = {
    text: `текст (1-${MAX_NOTE_LENGTH} знаков)`,
    authorId: 'автор',
    createdAt: 'дата',
  };
  const names = reasons.map((reason) => labels[reason] ?? reason).join(', ');
  throw new DomainError('invalid_input', `Заметка не добавлена, проверьте: ${names}.`);
}

/** Карточка, готовая к записи, и её прежняя запись `Supplier` (столбцы `suppliers`). */
export interface PreparedSupplierCard {
  card: SupplierCard;
  supplier: Supplier;
}

/**
 * Подготовить карточку к записи общим для всех хранилищ путём: нормализация, проверка
 * (`validateSupplierCard`), реквизиты по правилам `prepareSupplierForWrite`.
 * @throws DomainError `invalid_input` со списком замечаний (без значений полей).
 */
export function prepareCardForWrite(input: SupplierCard): PreparedSupplierCard {
  const card = normalizeSupplierCard(input);
  const issues = validateSupplierCard(card);
  if (issues.length > 0) {
    const reasons = issues.map((issue) => issue.message).join(' ');
    throw new DomainError('invalid_input', `Карточка поставщика не записана. ${reasons}`);
  }
  return { card, supplier: prepareSupplierForWrite(supplierFromCard(card)) };
}
