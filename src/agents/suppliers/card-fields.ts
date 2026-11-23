import { z } from 'zod';
import {
  DEFAULT_SUPPLIER_STATUS,
  SUPPLIER_STATUSES,
  normalizeEmail,
  normalizeSupplierCard,
  supplierCardIdFromHash,
  supplierCardIdSeed,
  type SupplierAssessmentParts,
  type SupplierCard,
  type SupplierCardSource,
  type SupplierContact,
  type SupplierTerms,
} from '../../kit/domain/supplier-card';
import {
  SUPPLIER_FULL_KEYS,
  pickFullParts,
  supplierFullFieldsShape,
} from '../../kit/domain/supplier-card-full';
import { stableHash } from '@business-ai/core';
import { maskEmail } from './card-view';

/**
 * Поля карточки «как пришли»: все необязательные. Это и вход инструментов модели, и то, что
 * лежит в запросе подтверждения. Для новой карточки из полей строится карточка
 * (`cardFromFields`), для существующей поля накладываются поверх (`applyFieldsToCard`):
 * меняется только переданное, остальное сохраняется.
 */

/** Предел длины ИНН на входе: цифры с пробелами и дефисами (сама проверка - в домене). */
export const MAX_INN_INPUT_LENGTH = 32;

/** Реквизиты юрлица, кроме ИНН (разд. 10.1 ТЗ): их можно задать и поправить в карточке. */
const EXTRA_REQUISITE_KEYS = [
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
] as const;

type RequisiteKey = (typeof EXTRA_REQUISITE_KEYS)[number];

// Этап 177: длины и число элементов не режутся схемой (ZodError = отказ сотруднику): лишнее
// обрезается кодом (`card-sanitize.ts`) с предупреждением.
const shortText = (): z.ZodString => z.string().trim().min(1);
const supplyList = z.array(shortText());

/** Контакт на входе: хотя бы одно из полей; `isPrimary` - сделать основным. */
const contactFieldsSchema = z.object({
  fullName: shortText().optional(),
  position: shortText().optional(),
  email: shortText().optional(),
  phone: shortText().optional(),
  messenger: shortText().optional(),
  isPrimary: z.boolean().optional(),
});
export type ContactFields = z.infer<typeof contactFieldsSchema>;

/**
 * Какой контакт убрать при правке: по адресу почты (как записан или в маске из поиска) или ФИО.
 * Нужен хотя бы один признак; при двух совпадение по адресу.
 */
const removeContactSchema = z
  .object({
    email: shortText().optional(),
    fullName: shortText().optional(),
  })
  .refine((value) => value.email !== undefined || value.fullName !== undefined, {
    message: 'Укажите почту или ФИО контакта, который нужно убрать.',
  });
type RemoveContactFields = z.infer<typeof removeContactSchema>;

/** Поля карточки, которые правка может очистить (значение неверно, а нового нет). */
const CLEARABLE_CARD_FIELDS = [
  'inn',
  'website',
  'productionCity',
  'address',
  'strengths',
  'weaknesses',
  'defectRatePercent',
  ...EXTRA_REQUISITE_KEYS,
  // Поля полной карточки (разд. 10 ТЗ): тоже можно очистить.
  ...SUPPLIER_FULL_KEYS,
] as const;

/** Условия на входе. */
const termFieldsSchema = z.object({
  payment: shortText().optional(),
  delivery: shortText().optional(),
  minBatch: shortText().optional(),
  leadTime: shortText().optional(),
  discounts: shortText().optional(),
});

/** Поля карточки на входе (см. описание модуля выше). */
export const supplierCardFieldsSchema = z.object({
  name: shortText().optional(),
  inn: shortText().optional(),
  website: shortText().optional(),
  kpp: shortText().optional(),
  ogrn: shortText().optional(),
  legalAddress: shortText().optional(),
  bankName: shortText().optional(),
  bik: shortText().optional(),
  settlementAccount: shortText().optional(),
  correspondentAccount: shortText().optional(),
  directorName: shortText().optional(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
  /** Контакты: новые добавляются, совпавшие по адресу (или ФИО) дополняются. */
  contacts: z.array(contactFieldsSchema).optional(),
  categories: supplyList.optional(),
  brands: supplyList.optional(),
  regions: supplyList.optional(),
  terms: termFieldsSchema.optional(),
  /** Город производства (разд. 10.7 ТЗ). */
  productionCity: shortText().optional(),
  /** Фактический адрес склада и производства (разд. 10.7). */
  address: shortText().optional(),
  /** Сильные стороны: с какими заказами лучше обращаться (разд. 10.9). */
  strengths: shortText().optional(),
  /** Слабые стороны: с какими заказами не стоит обращаться (разд. 10.9). */
  weaknesses: shortText().optional(),
  /** Процент брака по заказам, 0-100 (разд. 10.9). */
  defectRatePercent: z.number().optional(),
  /**
   * Поля полной карточки (разд. 10.1-10.9 ТЗ): вид поставщика, скидки, образцы, НДС,
   * документооборот, юрлица, упаковка, технологии, ссылки на материалы, сервис, оценка.
   * Значение (и список целиком) заменяет прежнее.
   */
  ...supplierFullFieldsShape,
  /** Заметка к карточке: добавляется, автор - сотрудник, нажавший кнопку. */
  note: shortText().optional(),
  /**
   * Убрать контакты (только при правке существующей карточки). Выполняется до добавления
   * `contacts`: пара «убрать + добавить» заменяет контакт, в том числе с неверными прежними
   * данными.
   */
  removeContacts: z.array(removeContactSchema).optional(),
  /** Очистить поле карточки (только при правке): нужно, когда прежнее значение неверно. */
  clear: z.array(z.enum(CLEARABLE_CARD_FIELDS)).max(CLEARABLE_CARD_FIELDS.length).optional(),
  /** Убрать из списков «что поставляет» (только при правке существующей карточки). */
  removeCategories: supplyList.optional(),
  removeBrands: supplyList.optional(),
  removeRegions: supplyList.optional(),
});
export type SupplierCardFields = z.infer<typeof supplierCardFieldsSchema>;

/** Источник записи на входе инструментов: файл идёт только через загрузку пачки. */
export const toolSourceSchema = z.enum(['chat', 'email']);

/** Контекст построения карточки: кто и когда, откуда. */
export interface CardBuildContext {
  userId: string;
  nowIso: string;
  source: SupplierCardSource;
}

function toContact(fields: ContactFields): SupplierContact {
  return {
    ...(fields.fullName === undefined ? {} : { fullName: fields.fullName }),
    ...(fields.position === undefined ? {} : { position: fields.position }),
    ...(fields.email === undefined ? {} : { email: normalizeEmail(fields.email) }),
    ...(fields.phone === undefined ? {} : { phone: fields.phone }),
    ...(fields.messenger === undefined ? {} : { messenger: fields.messenger }),
    isPrimary: fields.isPrimary === true,
  };
}

function definedTerms(terms: z.infer<typeof termFieldsSchema> | undefined): SupplierTerms {
  const result: SupplierTerms = {};
  for (const key of ['payment', 'delivery', 'minBatch', 'leadTime', 'discounts'] as const) {
    const value = terms?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Заданные поля расположения и оценки (разд. 10.7 и 10.9). */
function assessmentOf(fields: SupplierCardFields): SupplierAssessmentParts {
  return {
    ...(fields.productionCity === undefined ? {} : { productionCity: fields.productionCity }),
    ...(fields.address === undefined ? {} : { address: fields.address }),
    ...(fields.strengths === undefined ? {} : { strengths: fields.strengths }),
    ...(fields.weaknesses === undefined ? {} : { weaknesses: fields.weaknesses }),
    ...(fields.defectRatePercent === undefined
      ? {}
      : { defectRatePercent: fields.defectRatePercent }),
  };
}

/** Заданные реквизиты юрлица, кроме ИНН. */
function requisitesOf(fields: SupplierCardFields): Partial<Record<RequisiteKey, string>> {
  const result: Partial<Record<RequisiteKey, string>> = {};
  for (const key of EXTRA_REQUISITE_KEYS) {
    const value = fields[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Идентификатор новой карточки: из ИНН, а без него из названия (одна компания - один id). */
export function newCardId(fields: Pick<SupplierCardFields, 'name' | 'inn'>, salt = ''): string {
  const seed = supplierCardIdSeed({ name: fields.name ?? '', inn: fields.inn });
  return supplierCardIdFromHash(stableHash(salt === '' ? seed : [seed, salt]));
}

/** Новая карточка из полей. Пустое название даёт пустую строку: поймает проверка карточки. */
export function cardFromFields(
  fields: SupplierCardFields,
  context: CardBuildContext,
  id: string,
): SupplierCard {
  return {
    id,
    name: fields.name ?? '',
    ...(fields.inn === undefined ? {} : { inn: fields.inn }),
    ...(fields.website === undefined ? {} : { website: fields.website }),
    ...requisitesOf(fields),
    status: fields.status ?? DEFAULT_SUPPLIER_STATUS,
    contacts: (fields.contacts ?? []).map(toContact),
    supplies: {
      categories: [...(fields.categories ?? [])],
      brands: [...(fields.brands ?? [])],
      regions: [...(fields.regions ?? [])],
    },
    terms: definedTerms(fields.terms),
    ...assessmentOf(fields),
    ...pickFullParts(fields),
    notes:
      fields.note === undefined
        ? []
        : [{ text: fields.note, authorId: context.userId, createdAt: context.nowIso }],
    createdBy: context.userId,
    createdAt: context.nowIso,
    updatedBy: context.userId,
    updatedAt: context.nowIso,
    source: context.source,
  };
}

function sameContact(a: SupplierContact, b: SupplierContact): boolean {
  if (a.email !== undefined && b.email !== undefined) return a.email === b.email;
  const nameA = a.fullName?.trim().toLowerCase();
  const nameB = b.fullName?.trim().toLowerCase();
  return nameA !== undefined && nameA === nameB;
}

/** Контакты без тех, что совпали с `remove` (по адресу, иначе по ФИО). */
function removeContacts(
  current: readonly SupplierContact[],
  remove: readonly RemoveContactFields[],
): SupplierContact[] {
  const matches = (contact: SupplierContact, target: RemoveContactFields): boolean => {
    if (target.email !== undefined) {
      if (contact.email === undefined) return false;
      const wanted = normalizeEmail(target.email);
      // Модель видит адрес только в маске (`i***@host`): по ней контакт тоже находится.
      return normalizeEmail(contact.email) === wanted || maskEmail(contact.email) === target.email;
    }
    const name = target.fullName?.trim().toLowerCase();
    return name !== undefined && contact.fullName?.trim().toLowerCase() === name;
  };
  return current.filter((contact) => !remove.some((target) => matches(contact, target)));
}

function upsertContacts(
  current: readonly SupplierContact[],
  incoming: readonly ContactFields[],
): SupplierContact[] {
  const result = current.map((contact) => ({ ...contact }));
  for (const fields of incoming) {
    const contact = toContact(fields);
    const index = result.findIndex((item) => sameContact(item, contact));
    const found = index < 0 ? undefined : result[index];
    if (found === undefined) {
      result.push(contact);
    } else {
      result[index] = { ...found, ...contact, isPrimary: found.isPrimary || contact.isPrimary };
    }
    // Контакт, объявленный основным, снимает отметку с остальных.
    if (contact.isPrimary) {
      const keep = index < 0 ? result.length - 1 : index;
      result.forEach((item, position) => {
        item.isPrimary = position === keep;
      });
    }
  }
  return result;
}

function unionList(
  current: readonly string[],
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
): string[] {
  const removed = new Set((remove ?? []).map((item) => item.trim().toLowerCase()));
  const kept = current.filter((item) => !removed.has(item.trim().toLowerCase()));
  return [...kept, ...(add ?? [])];
}

/** Шаг, на который версия правки опережает прежнюю, если часы не ушли вперёд. */
const VERSION_STEP_MS = 1;

/**
 * Время правки как версия карточки: строго позже прежнего `updatedAt`. Две правки в одну
 * миллисекунду (или часы, ушедшие назад) иначе дали бы одинаковую версию, и проверка версии
 * не отличила бы их.
 */
function versionTime(nowIso: string, previous: string | undefined): string {
  const before = previous === undefined ? Number.NaN : Date.parse(previous);
  const now = Date.parse(nowIso);
  if (Number.isNaN(before) || Number.isNaN(now) || now > before) return nowIso;
  return new Date(before + VERSION_STEP_MS).toISOString();
}

/**
 * Наложить поля на существующую карточку: переданные заменяют прежние значения, контакты
 * дополняются, списки объединяются (с удалением по `remove*`), заметка добавляется.
 * Остальное не меняется. `updatedBy`/`updatedAt` ставит вызывающий через контекст.
 */
export function applyFieldsToCard(
  existing: SupplierCard,
  fields: SupplierCardFields,
  context: CardBuildContext,
): SupplierCard {
  const kept =
    fields.removeContacts === undefined
      ? existing.contacts
      : removeContacts(existing.contacts, fields.removeContacts);
  const card: SupplierCard = {
    ...existing,
    contacts: fields.contacts === undefined ? kept : upsertContacts(kept, fields.contacts),
    supplies: {
      categories: unionList(
        existing.supplies.categories,
        fields.categories,
        fields.removeCategories,
      ),
      brands: unionList(existing.supplies.brands, fields.brands, fields.removeBrands),
      regions: unionList(existing.supplies.regions, fields.regions, fields.removeRegions),
    },
    terms: { ...existing.terms, ...definedTerms(fields.terms) },
    ...assessmentOf(fields),
    ...pickFullParts(fields),
    ...requisitesOf(fields),
    notes:
      fields.note === undefined
        ? existing.notes
        : [
            ...existing.notes,
            { text: fields.note, authorId: context.userId, createdAt: context.nowIso },
          ],
    updatedBy: context.userId,
    updatedAt: versionTime(context.nowIso, existing.updatedAt),
  };
  if (fields.name !== undefined) card.name = fields.name;
  if (fields.inn !== undefined) card.inn = fields.inn;
  if (fields.website !== undefined) card.website = fields.website;
  if (fields.status !== undefined) card.status = fields.status;
  // «Без НДС» отменяет прежнюю ставку (ставка бывает только у плательщика).
  if (fields.vatMode === 'no_vat' && fields.vatRatePercent === undefined) {
    delete card.vatRatePercent;
  }
  // Очистка выполняется последней: поле, заданное и очищенное разом, остаётся пустым.
  for (const field of fields.clear ?? []) delete card[field];
  return card;
}

/** Есть ли в полях хоть что-то, кроме названия: нужно, чтобы отличить пустую правку. */
export function hasAnyField(fields: SupplierCardFields): boolean {
  return Object.values(fields).some((value) => value !== undefined);
}

/**
 * Обновление подменило бы ИНН найденного поставщика: у существующей карточки он задан, а в
 * накладываемых полях другой. Такое «обновление» превратило бы одного поставщика в другого
 * (R7-08), поэтому кнопку «Обновить существующую» в этом случае не предлагают и не принимают.
 */
export function innWouldChange(existing: SupplierCard, fields: SupplierCardFields): boolean {
  if (existing.inn === undefined || fields.inn === undefined) return false;
  // Сравнение после той же нормализации, что и при записи (пробелы и пр.).
  const next = normalizeSupplierCard({ ...existing, inn: fields.inn }).inn;
  return next !== undefined && next !== existing.inn;
}
