import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import {
  isValidBik,
  isValidCorrespondentAccount,
  isValidInn,
  isValidKpp,
  isValidOgrn,
  isValidSettlementAccount,
} from './requisites';

/**
 * Наши юрлица (этап 230): «Прагматика» и «Мастер Гифтс». Их реквизиты - данные в БД, а не
 * переменные окружения: сотрудник может изменить их через агента, договоры и фильтр «наших
 * реквизитов» читают одну и ту же запись.
 */

/** Стабильные коды наших юрлиц: ключ записи в БД, не зависит от названия и шаблона. */
export const OWN_ENTITY_CODES = ['pragmatika', 'master_gifts'] as const;
export type OwnEntityCode = (typeof OWN_ENTITY_CODES)[number];

export const ownEntityCodeSchema = z.enum(OWN_ENTITY_CODES);

/** Юрлицо в инструментах агента договоров («pr»/«mg») -> код записи. */
export const OWN_ENTITY_CODE_BY_ALIAS = {
  pr: 'pragmatika',
  mg: 'master_gifts',
} as const satisfies Readonly<Record<string, OwnEntityCode>>;

/** Название юрлица для сообщений сотруднику. */
export const OWN_ENTITY_TITLES: Readonly<Record<OwnEntityCode, string>> = {
  pragmatika: 'Прагматика',
  master_gifts: 'Мастер Гифтс',
};

/** Предел длины текстового поля: тот же, что у CHECK в миграции. */
export const OWN_ENTITY_MAX_TEXT_CHARS = 500;
/** Минимум цифр телефона, чтобы это был номер, а не обрывок. */
const MIN_PHONE_DIGITS = 7;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Обязательные поля реквизитов (без них договор с нашей стороной не собрать). */
export const OWN_ENTITY_REQUIRED_FIELDS = [
  'fullName',
  'shortName',
  'inn',
  'kpp',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'signatoryPosition',
  'signatoryName',
  'signatoryBasis',
] as const;

/** Необязательные поля: их может не быть, а значение можно убрать (`null` в правке). */
export const OWN_ENTITY_OPTIONAL_FIELDS = [
  'ogrn',
  'postalAddress',
  'actualAddress',
  'phone',
  'email',
] as const;

export const OWN_ENTITY_FIELDS = [
  ...OWN_ENTITY_REQUIRED_FIELDS,
  ...OWN_ENTITY_OPTIONAL_FIELDS,
] as const;
export type OwnEntityField = (typeof OWN_ENTITY_FIELDS)[number];

/** Названия полей для сообщений: значения в сообщения об ошибках не попадают. */
export const OWN_ENTITY_FIELD_LABELS: Readonly<Record<OwnEntityField, string>> = {
  fullName: 'полное наименование',
  shortName: 'краткое наименование',
  inn: 'ИНН',
  kpp: 'КПП',
  ogrn: 'ОГРН',
  legalAddress: 'юридический адрес',
  postalAddress: 'почтовый адрес',
  actualAddress: 'фактический адрес',
  bankName: 'банк',
  bik: 'БИК',
  settlementAccount: 'расчётный счёт',
  correspondentAccount: 'корреспондентский счёт',
  signatoryPosition: 'должность подписанта',
  signatoryName: 'ФИО подписанта',
  signatoryBasis: 'основание полномочий',
  phone: 'телефон',
  email: 'e-mail',
};

const text = z.string().trim().min(1).max(OWN_ENTITY_MAX_TEXT_CHARS);
const digitsOnly = (value: string): string => value.replace(/\D+/gu, '');

/** Поля реквизитов одного юрлица без служебных (кто и когда менял). */
const dataShape = {
  fullName: text,
  shortName: text,
  inn: text,
  kpp: text,
  ogrn: text.optional(),
  legalAddress: text,
  postalAddress: text.optional(),
  actualAddress: text.optional(),
  bankName: text,
  bik: text,
  settlementAccount: text,
  correspondentAccount: text,
  signatoryPosition: text,
  signatoryName: text,
  signatoryBasis: text,
  phone: text.optional(),
  email: text.optional(),
};

/** Сообщение без значения поля: ошибки схемы попадают в журнал и в ответ сотруднику. */
function addIssue(ctx: z.RefinementCtx, field: OwnEntityField, problem: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field],
    message: `${OWN_ENTITY_FIELD_LABELS[field]}: ${problem}`,
  });
}

/**
 * Форматы и контрольные суммы - теми же функциями, что проверяют реквизиты поставщиков. Счета
 * проверяются вместе с БИК: при смене БИК старые счета тоже должны сойтись.
 */
function checkRequisites(data: OwnLegalEntityData, ctx: z.RefinementCtx): void {
  if (!isValidInn(data.inn)) addIssue(ctx, 'inn', 'неверный формат или контрольная сумма');
  if (!isValidKpp(data.kpp)) addIssue(ctx, 'kpp', 'неверный формат');
  if (data.ogrn !== undefined && !isValidOgrn(data.ogrn)) {
    addIssue(ctx, 'ogrn', 'неверный формат или контрольная цифра');
  }
  if (!isValidBik(data.bik)) addIssue(ctx, 'bik', 'неверный формат');
  if (!isValidSettlementAccount(data.settlementAccount, data.bik)) {
    addIssue(ctx, 'settlementAccount', 'неверный формат или контрольная сумма с БИК');
  }
  if (!isValidCorrespondentAccount(data.correspondentAccount, data.bik)) {
    addIssue(ctx, 'correspondentAccount', 'неверный формат или контрольная сумма с БИК');
  }
  if (data.phone !== undefined && digitsOnly(data.phone).length < MIN_PHONE_DIGITS) {
    addIssue(ctx, 'phone', 'слишком мало цифр');
  }
  if (data.email !== undefined && !EMAIL_PATTERN.test(data.email)) {
    addIssue(ctx, 'email', 'неверный формат');
  }
}

/** Реквизиты юрлица: формат и контрольные суммы проверены. */
export const ownLegalEntityDataSchema = z.object(dataShape).strict().superRefine(checkRequisites);
export type OwnLegalEntityData = z.infer<z.ZodObject<typeof dataShape, 'strict'>>;

/** Запись о нашем юрлице: реквизиты плюс кто и когда менял. */
export interface OwnLegalEntity extends OwnLegalEntityData {
  code: OwnEntityCode;
  /** Момент последней записи (ISO). */
  updatedAt: string;
  /** Кто записал: id сотрудника или метка скрипта заполнения. */
  updatedBy: string;
}

/**
 * Правка записи: любое подмножество полей. Обязательное поле меняется на значение,
 * необязательное - ещё и убирается (`null`). Пустая правка не принимается.
 */
export const ownLegalEntityPatchSchema = z
  .object({
    fullName: text.optional(),
    shortName: text.optional(),
    inn: text.optional(),
    kpp: text.optional(),
    ogrn: text.nullable().optional(),
    legalAddress: text.optional(),
    postalAddress: text.nullable().optional(),
    actualAddress: text.nullable().optional(),
    bankName: text.optional(),
    bik: text.optional(),
    settlementAccount: text.optional(),
    correspondentAccount: text.optional(),
    signatoryPosition: text.optional(),
    signatoryName: text.optional(),
    signatoryBasis: text.optional(),
    phone: text.nullable().optional(),
    email: text.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'нет полей для изменения' });
export type OwnLegalEntityPatch = z.infer<typeof ownLegalEntityPatchSchema>;

/** Имена полей, по которым схема нашла ошибки (без значений). */
export function ownEntityIssueFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(
    (name) => name !== '',
  );
}

/** Ошибки схемы одной строкой: поле и причина, значений нет. */
function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path[0];
      const label =
        typeof field === 'string' && field in OWN_ENTITY_FIELD_LABELS
          ? OWN_ENTITY_FIELD_LABELS[field as OwnEntityField]
          : 'данные';
      return issue.message.startsWith(label) ? issue.message : `${label}: ${issue.message}`;
    })
    .join('; ');
}

/** Проверить реквизиты целиком; невалидные - `invalid_input` с перечнем полей, без значений. */
export function parseOwnLegalEntityData(input: unknown): OwnLegalEntityData {
  const parsed = ownLegalEntityDataSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError(
      'invalid_input',
      `Реквизиты не приняты: ${issueSummary(parsed.error)}.`,
    );
  }
  return parsed.data;
}

/** Только поля реквизитов: служебные (`code`, `updatedAt`, `updatedBy`) отбрасываются. */
export function ownEntityData(entity: OwnLegalEntityData): OwnLegalEntityData {
  return z.object(dataShape).parse(entity);
}

/**
 * Применить правку к текущим реквизитам и проверить результат целиком (контрольные суммы
 * счетов зависят от БИК). `null` убирает необязательное поле; убрать обязательное нельзя.
 */
export function applyOwnEntityPatch(
  current: OwnLegalEntityData | undefined,
  patch: OwnLegalEntityPatch,
): OwnLegalEntityData {
  const merged: Record<string, string | undefined> =
    current === undefined ? {} : { ...ownEntityData(current) };
  for (const field of OWN_ENTITY_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  return parseOwnLegalEntityData(merged);
}

/** Какие поля различаются у двух вариантов реквизитов (названия, без значений). */
export function changedOwnEntityFields(
  before: OwnLegalEntityData | undefined,
  after: OwnLegalEntityData,
): OwnEntityField[] {
  return OWN_ENTITY_FIELDS.filter((field) => before?.[field] !== after[field]);
}

/** «Фамилия Имя Отчество» -> «Фамилия И.О.»; одно слово остаётся как есть. */
export function shortPersonName(fullName: string): string {
  const [surname, ...rest] = fullName.trim().split(/\s+/u);
  if (surname === undefined) return '';
  const initials = rest.map((part) => `${part.slice(0, 1).toUpperCase()}.`).join('');
  return initials === '' ? surname : `${surname} ${initials}`;
}

/**
 * Строки реквизитов в том виде, как они печатаются в блоке «Заказчик» наших шаблонов:
 * эти метки («ИНН ... КПП ...», «Р/счет», «К/счет», «БИК», «Юридический адрес:») понимает
 * сервис дополнения договора. Строки подписи (должность и ФИО подписанта, «М.П.») сюда не входят:
 * сервис и в шаблоне обрывает блок на строке подписи, и в дополняемый договор она не вписывается.
 */
export function ownEntityRequisiteLines(entity: OwnLegalEntityData): string[] {
  return [
    entity.ogrn === undefined
      ? `ИНН ${entity.inn} КПП ${entity.kpp}`
      : `ИНН ${entity.inn} КПП ${entity.kpp} ОГРН ${entity.ogrn}`,
    `Р/счет ${entity.settlementAccount}`,
    `в ${entity.bankName}`,
    `К/счет ${entity.correspondentAccount}`,
    `БИК ${entity.bik}`,
    `Юридический адрес: ${entity.legalAddress}`,
    ...(entity.actualAddress === undefined ? [] : [`Фактический адрес: ${entity.actualAddress}`]),
    ...(entity.postalAddress === undefined ? [] : [`Почтовый адрес: ${entity.postalAddress}`]),
    ...(entity.phone === undefined ? [] : [`тел. ${entity.phone}`]),
    ...(entity.email === undefined ? [] : [`e-mail: ${entity.email}`]),
  ];
}

/**
 * Значения нашей компании для фильтра при обогащении карточек (этап 219): те же строки, что
 * задавались в `OWN_COMPANY_REQUISITES` (ИНН, КПП, ОГРН, адреса, телефон, почта, счета), плюс
 * наименования и подписант. Фильтр сам разбирает строки на цифры и текст.
 */
export function ownEntityFilterValues(entity: OwnLegalEntityData): string[] {
  const values = [
    entity.fullName,
    entity.shortName,
    entity.inn,
    entity.kpp,
    entity.ogrn,
    entity.legalAddress,
    entity.postalAddress,
    entity.actualAddress,
    entity.phone,
    entity.email,
    entity.signatoryName,
  ];
  return values.filter((value): value is string => value !== undefined);
}

/** Ключ для нестрогого сравнения текста: буквы и цифры в нижнем регистре, без знаков и пробелов. */
function looseKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}@]+/gu, '');
}

/** Идентификатор стоит в тексте отдельным словом: «123» не найдётся внутри «1234». */
function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
}

/** С такой длины число в тексте считается идентификатором (КПП/БИК - 9, ИНН - 10, счёт - 20). */
const MIN_IDENTIFIER_DIGITS = 9;
/** Метка расхождения «в блоке шаблона есть число-идентификатор, которого нет в записи». */
export const OWN_ENTITY_EXTRA_NUMBER = 'extraNumber';
export type OwnEntityMismatch = OwnEntityField | typeof OWN_ENTITY_EXTRA_NUMBER;

/**
 * Сверка печатного блока «Заказчик» шаблона с записью БД (этап 230). Шаблоны печатают наши
 * реквизиты текстом, и подставить запись в них нельзя, не меняя шаблоны на шаре. Поэтому код
 * проверяет, что напечатанное совпадает с записью: идентификаторы (ИНН, КПП, ОГРН, БИК, счета)
 * - словами, наименование, адреса, банк, телефон и почта - нестрого (без регистра и знаков).
 * Блок, который читает сервис, обрывается на строке подписи, поэтому должность и ФИО подписанта
 * (и преамбула договора) этой сверкой не охвачены. Лишнее число-идентификатор в блоке (например, прежний БИК) - тоже расхождение.
 * Возвращает названия полей без значений; пусто - всё совпало.
 */
export function ownEntityPrintedMismatches(
  entity: OwnLegalEntityData,
  printed: { name: string; lines: readonly string[] },
): OwnEntityMismatch[] {
  const text = printed.lines.join('\n').normalize('NFKC');
  const loose = looseKey(text);
  const mismatches: OwnEntityMismatch[] = [];
  const identifiers: Array<[OwnEntityField, string | undefined]> = [
    ['inn', entity.inn],
    ['kpp', entity.kpp],
    ['ogrn', entity.ogrn],
    ['bik', entity.bik],
    ['settlementAccount', entity.settlementAccount],
    ['correspondentAccount', entity.correspondentAccount],
  ];
  for (const [field, value] of identifiers) {
    if (value !== undefined && !containsToken(text, value)) mismatches.push(field);
  }
  if (looseKey(printed.name) !== looseKey(entity.shortName)) mismatches.push('shortName');
  const known = new Set(identifiers.map(([, value]) => value));
  const runs = text.match(/\d+/gu) ?? [];
  if (runs.some((run) => run.length >= MIN_IDENTIFIER_DIGITS && !known.has(run))) {
    mismatches.push(OWN_ENTITY_EXTRA_NUMBER);
  }
  const contained: Array<[OwnEntityField, string | undefined]> = [
    ['legalAddress', entity.legalAddress],
    ['postalAddress', entity.postalAddress],
    ['actualAddress', entity.actualAddress],
    ['bankName', entity.bankName],
    ['email', entity.email],
  ];
  for (const [field, value] of contained) {
    if (value !== undefined && !loose.includes(looseKey(value))) mismatches.push(field);
  }
  if (entity.phone !== undefined) {
    const digits = (value: string): string => value.replace(/\D+/gu, '');
    if (!digits(text).includes(digits(entity.phone))) mismatches.push('phone');
  }
  return mismatches;
}
