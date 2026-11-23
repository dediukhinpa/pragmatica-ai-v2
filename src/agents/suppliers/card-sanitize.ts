import {
  DEFAULT_SUPPLIER_STATUS,
  MAX_ADDRESS_LENGTH,
  MAX_ASSESSMENT_LENGTH,
  MAX_CITY_LENGTH,
  MAX_CONTACTS,
  MAX_CONTACT_NAME_LENGTH,
  MAX_CONTACT_POSITION_LENGTH,
  MAX_MESSENGER_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SUPPLIER_NAME_LENGTH,
  MAX_SUPPLY_ITEMS,
  MAX_SUPPLY_ITEM_LENGTH,
  MAX_TERM_LENGTH,
  normalizeSupplierCard,
  validateSupplierCard,
  type SupplierCard,
  type SupplierContact,
  type SupplierTerms,
} from '../../kit/domain/supplier-card';
import { SUPPLIER_FULL_TEXT_FIELDS } from '../../kit/domain/supplier-card-full';

/**
 * Этап 177: у сотрудника нет отказов по данным карточки, только предупреждения. Вместо
 * «карточка не показана, исправьте замечания» значения, не прошедшие проверку домена
 * (`validateSupplierCard`), очищаются или обрезаются, а в предупреждения идёт, что именно
 * не так. Репозиторий (`ports/repositories.ts`) проверяет те же правила и кидает
 * `invalid_input`, поэтому очистка делается ДО его вызова. Значения не придумываются:
 * неверное поле остаётся пустым, длинное обрезается. Нет названия - отказ остаётся
 * (ключа записи нет, п.1 брифа): `name_required` санитайзер не трогает.
 */

/** Результат: карточка, проходящая проверку (кроме названия), и предупреждения. */
export interface SanitizedCard {
  card: SupplierCard;
  warnings: string[];
}

/** Поля, которые не удаляются «вслепую» при поиске виновника замечания. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'status',
  'contacts',
  'supplies',
  'terms',
  'notes',
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
  'source',
]);

/** Замечания, которые санитайзер не исправляет (нет названия - нет ключа записи). */
const UNFIXABLE_CODES: ReadonlySet<string> = new Set(['name_required']);

/** Предел числа проходов: каждый проход снимает минимум одно замечание, иначе выход. */
const MAX_PASSES = 40;

/** Хвост предупреждения о пустом поле. */
const CLEARED_SUFFIX = ' Поле оставлено пустым: проверьте и впишите вручную.';
/** Хвост предупреждения об обрезанном поле. */
const CUT_SUFFIX = ' Значение обрезано до допустимой длины: проверьте.';

const ASSESSMENT_LIMITS: Readonly<Record<string, { limit: number; label: string }>> = {
  productionCity: { limit: MAX_CITY_LENGTH, label: 'Город производства' },
  address: { limit: MAX_ADDRESS_LENGTH, label: 'Адрес склада и производства' },
  strengths: { limit: MAX_ASSESSMENT_LENGTH, label: 'Сильные стороны' },
  weaknesses: { limit: MAX_ASSESSMENT_LENGTH, label: 'Слабые стороны' },
};

const TERM_LABELS: Readonly<Record<keyof SupplierTerms, string>> = {
  payment: 'Условия оплаты',
  delivery: 'Условия доставки',
  minBatch: 'Минимальная партия',
  leadTime: 'Сроки',
  discounts: 'Скидки',
};

const LIST_LABELS = { categories: 'Категории', brands: 'Бренды', regions: 'Регионы' } as const;

/** Накопитель предупреждений без повторов. */
class Warnings {
  readonly list: string[] = [];
  add(text: string): void {
    if (!this.list.includes(text)) this.list.push(text);
  }
}

function cutString(value: string, max: number): string | null {
  return value.length > max ? value.slice(0, max).trim() : null;
}

/** Обрезать строковые поля карточки по пределам домена. */
function cutTexts(card: SupplierCard, out: Warnings): void {
  const record = card as unknown as Record<string, unknown>;
  const limits: Array<[string, number, string]> = [
    ...Object.entries(ASSESSMENT_LIMITS).map(
      ([key, value]): [string, number, string] => [key, value.limit, value.label],
    ),
    ...Object.entries(SUPPLIER_FULL_TEXT_FIELDS).map(
      ([key, value]): [string, number, string] => [key, value.limit, value.label],
    ),
  ];
  for (const [key, max, label] of limits) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const cut = cutString(value, max);
    if (cut !== null) {
      record[key] = cut;
      out.add(`${label}: текст длиннее ${max} знаков.${CUT_SUFFIX}`);
    }
  }
  const name = cutString(card.name, MAX_SUPPLIER_NAME_LENGTH);
  if (name !== null) {
    card.name = name;
    out.add(`Название длиннее ${MAX_SUPPLIER_NAME_LENGTH} знаков.${CUT_SUFFIX}`);
  }
  for (const key of Object.keys(TERM_LABELS) as Array<keyof SupplierTerms>) {
    const value = card.terms[key];
    const cut = value === undefined ? null : cutString(value, MAX_TERM_LENGTH);
    if (cut !== null) {
      card.terms[key] = cut;
      out.add(`${TERM_LABELS[key]}: текст длиннее ${MAX_TERM_LENGTH} знаков.${CUT_SUFFIX}`);
    }
  }
  card.notes = card.notes
    .filter((note) => {
      const keep = note.text.trim() !== '';
      if (!keep) out.add('Пустая заметка не записана.');
      return keep;
    })
    .map((note) => {
      const cut = cutString(note.text, MAX_NOTE_LENGTH);
      if (cut === null) return note;
      out.add(`Заметка длиннее ${MAX_NOTE_LENGTH} знаков.${CUT_SUFFIX}`);
      return { ...note, text: cut };
    });
}

/** Списки «что поставляет»: лишние позиции отбрасываются, длинные обрезаются. */
function cutLists(card: SupplierCard, out: Warnings): void {
  for (const key of Object.keys(LIST_LABELS) as Array<keyof typeof LIST_LABELS>) {
    const items = card.supplies[key];
    let next = items.map((item) => cutString(item, MAX_SUPPLY_ITEM_LENGTH) ?? item);
    if (next.some((item, index) => item !== items[index])) {
      const label = LIST_LABELS[key];
      out.add(`${label}: позиции длиннее ${MAX_SUPPLY_ITEM_LENGTH} знаков.${CUT_SUFFIX}`);
    }
    if (next.length > MAX_SUPPLY_ITEMS) {
      out.add(`${LIST_LABELS[key]}: оставлены первые ${MAX_SUPPLY_ITEMS} позиций, остальные нет.`);
      next = next.slice(0, MAX_SUPPLY_ITEMS);
    }
    card.supplies[key] = next;
  }
}

/** Проверка контакта отдельно от карточки: какие коды замечаний он даёт. */
function contactCodes(card: SupplierCard, contact: SupplierContact): string[] {
  const probe = normalizeSupplierCard({ ...card, contacts: [{ ...contact, isPrimary: true }] });
  return validateSupplierCard(probe).map((issue) => issue.code);
}

/** Контакты: лишние отбрасываются, длинные поля режутся, неверные почта и телефон очищаются. */
function fixContacts(card: SupplierCard, out: Warnings): void {
  if (card.contacts.length > MAX_CONTACTS) {
    out.add(`Контактов больше ${MAX_CONTACTS}: оставлены первые, остальные не записаны.`);
    card.contacts = card.contacts.slice(0, MAX_CONTACTS);
  }
  const limits: Array<['fullName' | 'position' | 'messenger', number, string]> = [
    ['fullName', MAX_CONTACT_NAME_LENGTH, 'ФИО'],
    ['position', MAX_CONTACT_POSITION_LENGTH, 'должность'],
    ['messenger', MAX_MESSENGER_LENGTH, 'мессенджер'],
  ];
  card.contacts = card.contacts.map((source, index) => {
    const contact: SupplierContact = { ...source };
    const label = `Контакт ${index + 1}`;
    for (const [key, max, title] of limits) {
      const value = contact[key];
      const cut = value === undefined ? null : cutString(value, max);
      if (cut !== null) {
        contact[key] = cut;
        out.add(`${label}: ${title} длиннее ${max} знаков.${CUT_SUFFIX}`);
      }
    }
    const codes = contactCodes(card, contact);
    if (codes.includes('contact_email_invalid')) {
      delete contact.email;
      out.add(`${label}: адрес почты записан неверно.${CLEARED_SUFFIX}`);
    }
    if (codes.includes('contact_phone_invalid')) {
      delete contact.phone;
      out.add(`${label}: телефон записан неверно.${CLEARED_SUFFIX}`);
    }
    return contact;
  });
}

/** Сколько замечаний с таким кодом даёт карточка. */
function countCode(card: SupplierCard, code: string): number {
  return validateSupplierCard(normalizeSupplierCard(card)).filter((i) => i.code === code).length;
}

/**
 * Найти и убрать поле, из-за которого есть замечание: поле, без которого замечаний этого вида
 * становится меньше. Ключи кода в замечаниях нет, поэтому перебор; карточка небольшая.
 * Возвращает false, если виновник не найден.
 */
function clearOffendingField(
  card: SupplierCard,
  code: string,
  message: string,
  out: Warnings,
): boolean {
  const before = countCode(card, code);
  const record = card as unknown as Record<string, unknown>;
  for (const key of Object.keys(card)) {
    if (PROTECTED_KEYS.has(key) || record[key] === undefined) continue;
    const probe = { ...record };
    delete probe[key];
    if (countCode(probe as unknown as SupplierCard, code) < before) {
      delete record[key];
      out.add(`${message}${CLEARED_SUFFIX}`);
      return true;
    }
  }
  return false;
}

/**
 * Привести карточку к виду, который проходит проверку записи, и собрать предупреждения.
 * Что нельзя исправить без выдумывания (нет названия), остаётся замечанием для вызывающего.
 */
export function sanitizeSupplierCard(input: SupplierCard): SanitizedCard {
  const out = new Warnings();
  const card = normalizeSupplierCard(input);
  card.terms = { ...card.terms };
  card.supplies = { ...card.supplies };
  cutTexts(card, out);
  cutLists(card, out);
  fixContacts(card, out);
  let current = normalizeSupplierCard(card);
  // Коды, для которых виновное поле не нашлось: пропускаем, чтобы не мешали остальным.
  const stuck = new Set<string>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const issue = validateSupplierCard(current).find(
      (item) => !UNFIXABLE_CODES.has(item.code) && !stuck.has(item.code),
    );
    if (issue === undefined) break;
    const target = current as unknown as Record<string, unknown>;
    if (issue.code === 'status_invalid') {
      current.status = DEFAULT_SUPPLIER_STATUS;
      out.add(`${issue.message} Подставлен тип по умолчанию: проверьте.`);
    } else if (issue.code === 'vat_conflict') {
      delete target['vatRatePercent'];
      out.add(`${issue.message}${CLEARED_SUFFIX}`);
    } else if (!clearOffendingField(current, issue.code, issue.message, out)) {
      stuck.add(issue.code);
    }
    current = normalizeSupplierCard(current);
  }
  return { card: current, warnings: out.list };
}
