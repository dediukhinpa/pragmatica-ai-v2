import type { ContactFields, SupplierCardFields } from './card-fields';

/**
 * Проверка происхождения реквизитов: каждое значение, которое модель передала в карточку,
 * должно дословно (после нормализации) встречаться в тексте вложения или в сообщении
 * сотрудника. Зачем в коде, а не в промпте: модель при чтении файла уже подставляла в ИНН
 * значение, которого в файле нет, и останавливала это только контрольная сумма. Выдуманный
 * реквизит с верной суммой прошёл бы в базу.
 */

/** Код отказа: значения нет ни во вложении, ни в сообщении сотрудника. */
export const VALUE_NOT_IN_SOURCE = 'value_not_in_source';

/** Отклонённое значение: путь к полю (без самого значения) и код. */
export interface RejectedValue {
  field: string;
  code: typeof VALUE_NOT_IN_SOURCE;
}

export interface ProvenanceResult {
  /** Поля без отклонённых значений. */
  fields: SupplierCardFields;
  rejected: RejectedValue[];
}

/** Сколько подряд идущих групп цифр склеиваем при поиске номера («7707 083 893»). */
const MAX_DIGIT_GROUPS = 8;
/** Телефон сравнивается по последним цифрам: «+7», «8» и скобки не важны. */
const PHONE_TAIL_DIGITS = 10;

/** Простые текстовые поля, которые проверяются целиком. */
const TEXT_KEYS = [
  'name',
  'legalAddress',
  'bankName',
  'directorName',
  'address',
  'website',
] as const;
/** Числовые реквизиты: сравниваются по цифрам, форматирование не важно. */
const CODE_KEYS = [
  'inn',
  'kpp',
  'ogrn',
  'bik',
  'settlementAccount',
  'correspondentAccount',
] as const;

/** Буквы и цифры в нижнем регистре: пробелы, неразрывные пробелы, кавычки, дефисы уходят. */
function compact(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function digitsOf(text: string): string {
  return text.replace(/\D+/g, '');
}

/**
 * Группы цифр источника. Склеиваются только группы, разделённые пробелом или дефисом
 * («7707 083 893», «(495) 123»): через слово или перенос строки соседние числа (ИНН и
 * КПП) не сливаются.
 */
function digitGroups(sources: readonly string[]): string[][] {
  return sources.flatMap((text) =>
    (text.normalize('NFKC').match(/\d+(?:[ ()-]+\d+)*/g) ?? []).map((run) => run.split(/\D+/)),
  );
}

function hasDigitRun(groups: readonly string[][], wanted: string, tailOnly: boolean): boolean {
  if (wanted === '') return false;
  for (const list of groups) {
    for (let start = 0; start < list.length; start += 1) {
      let joined = '';
      for (let end = start; end < Math.min(list.length, start + MAX_DIGIT_GROUPS); end += 1) {
        joined += list[end] ?? '';
        if (joined === wanted || (tailOnly && joined.endsWith(wanted))) return true;
        if (joined.length > wanted.length + (tailOnly ? PHONE_TAIL_DIGITS : 0)) break;
      }
    }
  }
  return false;
}

/** Проверка одного значения по набору источников. */
export class SourceMatcher {
  private readonly compacted: string[];
  private readonly groups: string[][];

  constructor(sources: readonly string[]) {
    this.compacted = sources.map(compact);
    this.groups = digitGroups(sources);
  }

  /** Источников нет вовсе - проверять не по чему. */
  get isEmpty(): boolean {
    return this.compacted.every((text) => text === '');
  }

  text(value: string): boolean {
    const wanted = compact(value);
    return wanted !== '' && this.compacted.some((text) => text.includes(wanted));
  }

  code(value: string): boolean {
    return hasDigitRun(this.groups, digitsOf(value), false);
  }

  phone(value: string): boolean {
    const digits = digitsOf(value);
    if (digits.length < PHONE_TAIL_DIGITS) return hasDigitRun(this.groups, digits, false);
    return hasDigitRun(this.groups, digits.slice(-PHONE_TAIL_DIGITS), true);
  }
}

function checkContact(
  contact: ContactFields,
  index: number,
  matcher: SourceMatcher,
  rejected: RejectedValue[],
): ContactFields | null {
  const kept: ContactFields = { ...contact };
  const reject = (key: keyof ContactFields): void => {
    delete kept[key];
    rejected.push({ field: `contacts[${index}].${key}`, code: VALUE_NOT_IN_SOURCE });
  };
  if (contact.fullName !== undefined && !matcher.text(contact.fullName)) reject('fullName');
  if (contact.position !== undefined && !matcher.text(contact.position)) reject('position');
  if (contact.email !== undefined && !matcher.text(contact.email)) reject('email');
  if (contact.phone !== undefined && !matcher.phone(contact.phone)) reject('phone');
  if (contact.messenger !== undefined && !matcher.text(contact.messenger)) reject('messenger');
  const hasData = ['fullName', 'position', 'email', 'phone', 'messenger'].some(
    (key) => kept[key as keyof ContactFields] !== undefined,
  );
  return hasData ? kept : null;
}

/**
 * Оставить в полях только значения, найденные в источниках. Остальные поля не трогаются и
 * не блокируются; список отклонённых уходит модели, чтобы она исправила значение по файлу
 * или оставила поле пустым.
 */
export function enforceSourceProvenance(
  fields: SupplierCardFields,
  sources: readonly string[],
): ProvenanceResult {
  const matcher = new SourceMatcher(sources);
  const rejected: RejectedValue[] = [];
  const kept: SupplierCardFields = { ...fields };
  const drop = (key: (typeof TEXT_KEYS)[number] | (typeof CODE_KEYS)[number]): void => {
    delete kept[key];
    rejected.push({ field: key, code: VALUE_NOT_IN_SOURCE });
  };
  for (const key of TEXT_KEYS) {
    const value = fields[key];
    if (value !== undefined && !matcher.text(value)) drop(key);
  }
  for (const key of CODE_KEYS) {
    const value = fields[key];
    if (value !== undefined && !matcher.code(value)) drop(key);
  }
  if (fields.contacts !== undefined) {
    const contacts: ContactFields[] = [];
    fields.contacts.forEach((contact, index) => {
      const checked = checkContact(contact, index, matcher, rejected);
      if (checked !== null) contacts.push(checked);
    });
    if (contacts.length > 0) kept.contacts = contacts;
    else delete kept.contacts;
  }
  return { fields: kept, rejected };
}

/**
 * Предупреждение для итогового списка (этап 177): значения не из источника по-прежнему не
 * подставляются (запрет выдумывать, п.5), но это не отказ, а пометка для сотрудника.
 */
export function rejectedNotice(rejected: readonly RejectedValue[]): string {
  if (rejected.length === 0) return '';
  const names = rejected.map((item) => item.field).join(', ');
  return (
    `Значения не найдены во вложении или сообщении (${VALUE_NOT_IN_SOURCE}), поля оставлены ` +
    `пустыми: ${names}. Проверьте по тексту файла и впишите вручную при необходимости.`
  );
}
