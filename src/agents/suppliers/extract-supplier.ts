import { MAX_CONTACTS, normalizeInn, normalizePhone } from '../../kit/domain/supplier-card';
import type { ContactFields, SupplierCardFields } from './card-fields';

/**
 * Детерминированный извлекатель данных поставщика из пересланного письма или визитки в
 * тексте: email, телефон, ИНН (только с подписью «ИНН»), сайт, название организации, ФИО и
 * должность из подписи. Ничего не выдумывает: нет признака - нет поля. Проверка значений
 * (контрольная сумма ИНН, формат почты) остаётся за `validateSupplierCard`.
 */

/** Что найдено: числа и признаки без самих значений (можно отдавать модели). */
interface SupplierTextFound {
  emails: number;
  phones: number;
  inn: boolean;
  website: boolean;
  name: boolean;
  fullName: boolean;
  position: boolean;
}

/** Результат извлечения: предварительные поля карточки и сводка найденного. */
export interface SupplierTextExtraction {
  fields: SupplierCardFields;
  found: SupplierTextFound;
}

/**
 * Адрес почты. Квантификаторы ограничены пределами RFC 5321/1035 (локальная часть до 64,
 * метка домена до 63, до 10 меток, зона до 24 букв): без пределов на ряде букв без `@`
 * каждая стартовая позиция сканировала ряд до конца, и на кириллице (флаг `u` с `\p{…}`)
 * рост был кубическим - 2000 знаков около 24 с, предел текста 8000 знаков - минуты (R9-A2-01).
 * Ретроспектива `(?<!…)` держит начало адреса на начале ряда: без неё на локальной части
 * длиннее 64 знаков нашёлся бы её хвост - правдоподобный, но чужой адрес. Такая часть
 * недопустима по RFC, поэтому адреса нет вовсе (раньше бралась целиком и затем не проходила
 * проверку формата). Заодно ретроспектива отсекает старты внутри ряда - поиск линейный.
 */
const EMAIL_LOCAL = '[\\p{L}\\p{N}._%+-]';
const EMAIL_LABEL = '[\\p{L}\\p{N}-]{1,63}';
const EMAIL_RE = new RegExp(
  `(?<!${EMAIL_LOCAL})${EMAIL_LOCAL}{1,64}@${EMAIL_LABEL}(?:\\.${EMAIL_LABEL}){0,8}\\.\\p{L}{2,24}`,
  'gu',
);
const INN_RE = /ИНН[\s:№#-]*(\d[\d ]{8,12}\d)/iu;
/** Подписанные числовые реквизиты вырезаются до поиска телефонов, чтобы не принять за них. */
const REQUISITE_RE = /(?:ИНН|КПП|ОГРНИП|ОГРН|БИК|р\/с|к\/с)[\s:№#-]*\d[\d ]*/giu;
const INTL_PHONE_RE = /(?<![\d])(?:\+\d{1,3}|8)[\s\-.()]*\d[\d\s\-.()]{7,16}\d/g;
const CITY_PHONE_RE = /(?<![\d])\(\d{3,5}\)[\s-]*\d{2,3}[\s-]*\d{2}[\s-]*\d{2}/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"«»]+/giu;
const WWW_RE = /\bwww\.[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(?:\/[^\s<>"«»]*)?/giu;
const SITE_LABEL_RE =
  /(?:сайт|site|web)[\s:-]+((?:https?:\/\/)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}\S*)/iu;
const COMPANY_RE = /(?<![\p{L}\p{N}])(ООО|ОАО|ЗАО|ПАО|АО)\s*[«"“]([^»"”\n]{2,100})[»"”]/u;
const SOLE_TRADER_RE =
  /(?<![\p{L}\p{N}])ИП\s+([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/u;
const WORD = '[А-ЯЁ][а-яё]+';
const PATRONYMIC = `${WORD}(?:вич|вна|ична|ьич|кызы|оглы)`;
const FULL_NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${WORD}(?:-${WORD})?\\s+${WORD}\\s+${PATRONYMIC})(?![\\p{L}\\p{N}])`,
  'u',
);
const NAME_LINE_RE =
  /^([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)$/u;
const CLOSING_RE = /^(?:с уважением|с наилучшими пожеланиями|best regards|regards|sincerely)\W*$/iu;
const POSITION_RE = new RegExp(
  '(менеджер|директор|руководитель|специалист|начальник|инженер|заведующ|' +
    'представитель|отдел|коммерческ)',
  'iu',
);
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;
/** Должность не длиннее: чтобы не принять за неё абзац письма. */
const MAX_POSITION_LINE = 100;
/** Строк после подписи, где ищется ФИО и должность. */
const SIGNATURE_LOOKAHEAD = 4;
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Телефоны из текста, где адреса почты уже вырезаны (`withoutEmails`). */
function phonesOf(withoutEmails: string): string[] {
  const clean = withoutEmails.replace(REQUISITE_RE, ' ');
  const matches = [...(clean.match(INTL_PHONE_RE) ?? []), ...(clean.match(CITY_PHONE_RE) ?? [])];
  const phones = matches
    .map((match) => normalizePhone(match))
    .filter((phone) => {
      const digits = phone.replace(/\D/g, '').length;
      return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
    });
  return unique(phones);
}

/** Сайт из текста, где адреса почты уже вырезаны (`withoutEmails`). */
function websiteOf(withoutEmails: string): string | undefined {
  const labelled = SITE_LABEL_RE.exec(withoutEmails)?.[1];
  const found = labelled ?? withoutEmails.match(URL_RE)?.[0] ?? withoutEmails.match(WWW_RE)?.[0];
  return found?.replace(TRAILING_PUNCTUATION, '');
}

function companyOf(text: string): string | undefined {
  const legal = COMPANY_RE.exec(text);
  if (legal !== null) return `${legal[1]} «${legal[2]?.trim()}»`;
  const sole = SOLE_TRADER_RE.exec(text)?.[1];
  return sole === undefined ? undefined : `ИП ${sole}`;
}

/** ФИО и должность из подписи письма или визитки. */
function personOf(text: string): { fullName?: string; position?: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let fullName = FULL_NAME_RE.exec(text)?.[1];
  const known = fullName;
  let nameLine = known === undefined ? -1 : lines.findIndex((line) => line.includes(known));
  if (fullName === undefined) {
    const closing = lines.findIndex((line) => CLOSING_RE.test(line));
    const candidate = closing < 0 ? undefined : lines[closing + 1];
    const match = candidate === undefined ? null : NAME_LINE_RE.exec(candidate);
    if (match !== null) {
      fullName = match[1];
      nameLine = closing + 1;
    }
  }
  const isPositionLine = (line: string | undefined): line is string =>
    line !== undefined &&
    POSITION_RE.test(line) &&
    line.length <= MAX_POSITION_LINE &&
    !line.includes('@') &&
    !/\d{5,}/.test(line);
  // Визитка: имя без отчества («Игорь Орлов») и должность рядом, до или после имени. Имя берём
  // только строкой из двух-трёх слов с заглавной буквы, у которой сосед - строка с должностью:
  // название организации без формы («Бета Трейд») должности рядом не имеет и контактом не станет.
  let positionBefore: string | undefined;
  if (fullName === undefined) {
    const isName = (i: number): boolean => NAME_LINE_RE.test(lines[i] ?? '');
    // Порядок «имя, затем должность» самый частый: берём первое такое имя. Иначе «должность, затем
    // имя»: берём последнее, потому что выше должности обычно стоит название организации.
    const indexes = lines.map((_, i) => i).filter(isName);
    const after = indexes.find((i) => isPositionLine(lines[i + 1]));
    const before = [...indexes].reverse().find((i) => isPositionLine(lines[i - 1]));
    // Первая строка визитки - обычно организация: если за ней идёт должность, а ниже есть
    // «должность, затем имя», первая строка именем не считается.
    const afterIsFirstLine = after === 0 && before !== undefined;
    const useBefore = after === undefined || afterIsFirstLine;
    const at = useBefore ? before : after;
    if (at !== undefined) {
      fullName = NAME_LINE_RE.exec(lines[at] ?? '')?.[1];
      nameLine = at;
      positionBefore = useBefore ? lines[at - 1] : undefined;
    }
  }
  const from = nameLine < 0 ? 0 : nameLine + 1;
  const scope = nameLine < 0 ? [] : lines.slice(from, from + SIGNATURE_LOOKAHEAD);
  const position = positionBefore ?? scope.find(isPositionLine);
  return {
    ...(fullName === undefined ? {} : { fullName }),
    ...(position === undefined ? {} : { position }),
  };
}

/** Собрать контакты: первый несёт ФИО, должность, первую почту и первый телефон. */
function contactsOf(
  person: { fullName?: string; position?: string },
  emails: readonly string[],
  phones: readonly string[],
): ContactFields[] {
  const contacts: ContactFields[] = [];
  const first: ContactFields = {
    ...person,
    ...(emails[0] === undefined ? {} : { email: emails[0] }),
    ...(phones[0] === undefined ? {} : { phone: phones[0] }),
    isPrimary: true,
  };
  if (Object.keys(first).length > 1) contacts.push(first);
  for (const email of emails.slice(1)) contacts.push({ email });
  for (const phone of phones.slice(1)) contacts.push({ phone });
  return contacts.slice(0, MAX_CONTACTS);
}

/** Извлечь поля карточки из текста. Пустой текст даёт пустой результат. */
export function extractSupplierFromText(text: string): SupplierTextExtraction {
  const emails = unique((text.match(EMAIL_RE) ?? []).map((email) => email.toLowerCase()));
  // Адреса вырезаются один раз и для телефонов, и для сайта: раньше EMAIL_RE шла трижды.
  // Порядок с REQUISITE_RE поменялся (сначала почта): различие только у адреса вида
  // «ИНН123@…», где оба порядка не дают телефона.
  const withoutEmails = text.replace(EMAIL_RE, ' ');
  const phones = phonesOf(withoutEmails);
  const innRaw = INN_RE.exec(text)?.[1];
  const inn = innRaw === undefined ? '' : normalizeInn(innRaw);
  const innFound = inn.length === 10 || inn.length === 12;
  const website = websiteOf(withoutEmails);
  const name = companyOf(text);
  const person = personOf(text);
  const contacts = contactsOf(person, emails, phones);
  const fields: SupplierCardFields = {
    ...(name === undefined ? {} : { name }),
    ...(innFound ? { inn } : {}),
    ...(website === undefined ? {} : { website }),
    ...(contacts.length === 0 ? {} : { contacts }),
  };
  return {
    fields,
    found: {
      emails: emails.length,
      phones: phones.length,
      inn: innFound,
      website: website !== undefined,
      name: name !== undefined,
      fullName: person.fullName !== undefined,
      position: person.position !== undefined,
    },
  };
}

/**
 * Дополнить поля модели найденным в тексте: извлечённое из письма надёжнее пересказа, но
 * явные поля модели не затираются. Нет контактов у модели - берутся найденные; есть - в
 * первый контакт добавляется то, чего в нём нет.
 */
export function mergeExtracted(
  fields: SupplierCardFields,
  extracted: SupplierCardFields,
): SupplierCardFields {
  const merged: SupplierCardFields = { ...fields };
  if (merged.name === undefined && extracted.name !== undefined) merged.name = extracted.name;
  if (merged.inn === undefined && extracted.inn !== undefined) merged.inn = extracted.inn;
  if (merged.website === undefined && extracted.website !== undefined) {
    merged.website = extracted.website;
  }
  const found = extracted.contacts ?? [];
  const own = fields.contacts ?? [];
  const head = found[0];
  if (own.length === 0) {
    if (found.length > 0) merged.contacts = found;
  } else if (head !== undefined) {
    const [first, ...rest] = own;
    if (first !== undefined) {
      merged.contacts = [
        {
          ...head,
          ...Object.fromEntries(Object.entries(first).filter(([, value]) => value !== undefined)),
        },
        ...rest,
      ];
    }
  }
  return merged;
}
