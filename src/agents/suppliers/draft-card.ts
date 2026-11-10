import { DomainError } from '@business-ai/core';
import {
  MAX_CITY_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SUPPLIER_NAME_LENGTH,
  normalizeSupplierCard,
  validateSupplierCard,
  type SupplierCard,
} from '../../kit/domain/supplier-card';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';
import { cardFromFields, newCardId, type SupplierCardFields } from './card-fields';

/**
 * Автоматически созданная карточка поставщика. Её создаёт агент прайсов (и другие сценарии), когда
 * поставщика в базе нет: файл не пропускается, цены пишутся со ссылкой на карточку. Решение
 * владельца 09.11.2026: черновиков нет, карточка сразу боевая (без признака и без шага
 * подтверждения); откуда взяты данные, видно из заметки и источника.
 */

/** Что известно о поставщике из шапки прайса (всё, кроме названия, необязательно). */
export interface AutoSupplierInput {
  name: string;
  inn?: string | undefined;
  phone?: string | undefined;
  /** Почта организации из шапки: по ней письмо уходит без поиска в интернете (этап 125). */
  email?: string | undefined;
  website?: string | undefined;
  city?: string | undefined;
}

/** Кто и когда создаёт карточку; `origin` - откуда данные (например, имя файла прайса). */
export interface AutoSupplierContext {
  userId: string;
  nowIso: string;
  origin?: string | undefined;
  /**
   * Откуда взяты данные, словами для заметки. По умолчанию - шапка прайса; карточка по сайту
   * (этап 163) обязана сказать, что значения из интернета и их нужно подтвердить.
   */
  basis?: string | undefined;
}

/** Результат: карточка и признак «создана сейчас» (иначе вернулась уже существующая). */
export interface AutoSupplierResult {
  card: SupplierCard;
  created: boolean;
}

/** Репозиторий, достаточный для создания карточки. */
export type AutoSupplierRepository = Pick<
  SupplierRepository,
  'saveCard' | 'getCard' | 'findDuplicates'
>;

/** Предел значений из шапки прайса и пометки об источнике (остальное обрезается). */
const MAX_ORIGIN_LENGTH = 200;
const MAX_HEADER_VALUE_LENGTH = 200;
const DEFAULT_DRAFT_BASIS = 'агентом прайсов по шапке прайса';

/** Какое поле убрать из карточки, если проверка карточки отклонила его значение. */
const DROPPABLE_ISSUES: Readonly<Record<string, 'inn' | 'phone' | 'email' | 'website'>> = {
  inn_invalid: 'inn',
  contact_phone_invalid: 'phone',
  contact_email_invalid: 'email',
  website_invalid: 'website',
};

function clean(value: string | undefined, max: number): string | undefined {
  const text = value?.trim().slice(0, max).trim();
  return text === undefined || text === '' ? undefined : text;
}

/** Текст заметки об автоматически созданной карточке: основание и источник данных. */
function draftNote(origin: string | undefined, basis: string | undefined): string {
  const source = clean(origin, MAX_ORIGIN_LENGTH);
  const text = `Создано автоматически: ${clean(basis, MAX_ORIGIN_LENGTH) ?? DEFAULT_DRAFT_BASIS}.`;
  return (source === undefined ? text : `${text} Источник: ${source}.`).slice(0, MAX_NOTE_LENGTH);
}

/**
 * Убрать из единственного контакта шапки неверное поле: верные телефон или почта остаются
 * (раньше при неверном телефоне терялся весь контакт, теперь рядом стоит ещё и почта).
 */
function dropContactField(fields: SupplierCardFields, field: 'phone' | 'email'): void {
  const [contact] = fields.contacts ?? [];
  if (contact === undefined) return;
  const rest = { ...contact };
  delete rest[field];
  if (rest.phone === undefined && rest.email === undefined) delete fields.contacts;
  else fields.contacts = [rest];
}

/**
 * Поля карточки без тех значений, которые проверка карточки отклоняет (неверный ИНН, телефон
 * или сайт из шапки прайса): шапка бывает неряшливой, а файл из-за этого терять нельзя. Что
 * отброшено, видно по результату: этих полей в карточке нет, сотрудник дополнит их кнопками.
 */
function sanitizedFields(
  fields: SupplierCardFields,
  context: AutoSupplierContext,
): SupplierCardFields {
  const next: SupplierCardFields = { ...fields };
  const probe = cardFromFields(next, { ...context, source: 'file' }, 'probe');
  const issues = validateSupplierCard(normalizeSupplierCard(probe));
  for (const issue of issues) {
    const drop = DROPPABLE_ISSUES[issue.code];
    if (drop === 'inn') delete next.inn;
    else if (drop === 'website') delete next.website;
    else if (drop === 'phone' || drop === 'email') dropContactField(next, drop);
  }
  return next;
}

/**
 * Создать карточку сразу боевой (источник `file`, без признака черновика).
 * Идентификатор детерминирован (ИНН либо нормализованное название), поэтому повторный вызов
 * для того же поставщика безвреден. Если поставщик уже есть в базе (совпал ИНН или название
 * с любой карточкой, в том числе с другим идентификатором), новая карточка не создаётся:
 * возвращается существующая, `created: false`.
 * @throws DomainError `invalid_input` - пустое название; прочие ошибки записи - как у `saveCard`.
 */
export async function createAutoSupplierCard(
  suppliers: AutoSupplierRepository,
  input: AutoSupplierInput,
  context: AutoSupplierContext,
): Promise<AutoSupplierResult> {
  const name = clean(input.name, MAX_SUPPLIER_NAME_LENGTH);
  if (name === undefined) {
    throw new DomainError('invalid_input', 'Карточка поставщика: не указано название.');
  }
  const inn = clean(input.inn, MAX_HEADER_VALUE_LENGTH);
  const phone = clean(input.phone, MAX_HEADER_VALUE_LENGTH);
  const email = clean(input.email, MAX_HEADER_VALUE_LENGTH);
  const website = clean(input.website, MAX_HEADER_VALUE_LENGTH);
  const city = clean(input.city, MAX_CITY_LENGTH);
  const wanted: SupplierCardFields = {
    name,
    ...(inn === undefined ? {} : { inn }),
    ...(website === undefined ? {} : { website }),
    ...(city === undefined ? {} : { productionCity: city }),
    ...(phone === undefined && email === undefined
      ? {}
      : {
          contacts: [
            {
              ...(phone === undefined ? {} : { phone }),
              ...(email === undefined ? {} : { email }),
              isPrimary: true,
            },
          ],
        }),
    note: draftNote(context.origin, context.basis),
  };
  const fields = sanitizedFields(wanted, context);
  const known = await suppliers.findDuplicates({ name, inn: fields.inn });
  const match = known.find((item) => item.reason === 'inn' || item.reason === 'name');
  if (match !== undefined) {
    const existing = await suppliers.getCard(match.supplierId);
    if (existing !== null) return { card: existing, created: false };
  }
  const id = newCardId(fields);
  const card: SupplierCard = cardFromFields(fields, { ...context, source: 'file' }, id);
  try {
    return { card: await suppliers.saveCard(card, { createOnly: true }), created: true };
  } catch (error) {
    // Параллельный вызов успел создать ту же карточку: отдаём её.
    if (error instanceof DomainError && error.code === 'conflict') {
      const existing = await suppliers.getCard(id);
      if (existing !== null) return { card: existing, created: false };
    }
    throw error;
  }
}
