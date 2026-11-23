import { DomainError } from '@business-ai/core';
import type { Supplier } from './models';
import { warningIssue } from '@business-ai/core';
import type { ValidationIssue } from '@business-ai/core';

/** Длины и веса контрольных сумм (приказы ФНС и ЦБ РФ). */
const INN_LEGAL_LENGTH = 10;
const INN_PERSON_LENGTH = 12;
const INN_LEGAL_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_PERSON_WEIGHTS_FIRST = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_PERSON_WEIGHTS_SECOND = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_MODULUS = 11;
const DECIMAL = 10;
const KPP_PATTERN = /^\d{4}[0-9A-Z]{2}\d{3}$/;
const BIK_PATTERN = /^\d{9}$/;
const BIK_PREFIX = '04';
const ACCOUNT_LENGTH = 20;
const ACCOUNT_WEIGHTS = [7, 1, 3];
const BIK_TAIL_LENGTH = 3;
/** Позиции 5-й и 6-й цифр БИК (с нуля) для проверки корреспондентского счёта. */
const BIK_CORR_FROM = 4;
const BIK_CORR_TO = 6;
const OGRN_LEGAL_LENGTH = 13;
const OGRN_PERSON_LENGTH = 15;
const OGRN_LEGAL_MODULUS = 11n;
const OGRN_PERSON_MODULUS = 13n;

const isDigits = (value: string): boolean => /^\d+$/.test(value);

function weightedSum(digits: string, weights: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    sum += Number(digits[index]) * (weights[index] ?? 0);
  }
  return sum;
}

/** ИНН: 10 цифр (юрлицо) или 12 (ИП) с верной контрольной суммой. */
export function isValidInn(inn: string): boolean {
  if (!isDigits(inn)) return false;
  if (inn.length === INN_LEGAL_LENGTH) {
    return (
      (weightedSum(inn, INN_LEGAL_WEIGHTS) % INN_MODULUS) % DECIMAL ===
      Number(inn[INN_LEGAL_LENGTH - 1])
    );
  }
  if (inn.length === INN_PERSON_LENGTH) {
    const first = (weightedSum(inn, INN_PERSON_WEIGHTS_FIRST) % INN_MODULUS) % DECIMAL;
    const second = (weightedSum(inn, INN_PERSON_WEIGHTS_SECOND) % INN_MODULUS) % DECIMAL;
    return (
      first === Number(inn[INN_PERSON_LENGTH - 2]) && second === Number(inn[INN_PERSON_LENGTH - 1])
    );
  }
  return false;
}

/** КПП: 9 знаков (4 цифры, 2 цифры или заглавные буквы, 3 цифры). */
export function isValidKpp(kpp: string): boolean {
  return KPP_PATTERN.test(kpp);
}

/** БИК: 9 цифр, начинается с «04». */
export function isValidBik(bik: string): boolean {
  return BIK_PATTERN.test(bik) && bik.startsWith(BIK_PREFIX);
}

/** Контрольная сумма счёта по условному номеру (3 цифры + 20 цифр счёта). */
function accountChecksumOk(prefix: string, account: string): boolean {
  if (account.length !== ACCOUNT_LENGTH || !isDigits(account)) return false;
  const digits = `${prefix}${account}`;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const weight = ACCOUNT_WEIGHTS[index % ACCOUNT_WEIGHTS.length] ?? 0;
    sum += (Number(digits[index]) * weight) % DECIMAL;
  }
  return sum % DECIMAL === 0;
}

/** Расчётный счёт: 20 цифр, контрольная сумма с последними тремя цифрами БИК. */
export function isValidSettlementAccount(account: string, bik: string): boolean {
  return isValidBik(bik) && accountChecksumOk(bik.slice(-BIK_TAIL_LENGTH), account);
}

/** Корреспондентский счёт: контрольная сумма с «0» и 5-6-й цифрами БИК. */
export function isValidCorrespondentAccount(account: string, bik: string): boolean {
  return isValidBik(bik) && accountChecksumOk(`0${bik.slice(BIK_CORR_FROM, BIK_CORR_TO)}`, account);
}

/** ОГРН: 13 цифр (юрлицо) или 15 (ИП) с верной контрольной цифрой. */
export function isValidOgrn(ogrn: string): boolean {
  if (!isDigits(ogrn)) return false;
  if (ogrn.length !== OGRN_LEGAL_LENGTH && ogrn.length !== OGRN_PERSON_LENGTH) return false;
  const modulus = ogrn.length === OGRN_LEGAL_LENGTH ? OGRN_LEGAL_MODULUS : OGRN_PERSON_MODULUS;
  const body = BigInt(ogrn.slice(0, -1));
  return Number((body % modulus) % BigInt(DECIMAL)) === Number(ogrn[ogrn.length - 1]);
}

/** Реквизиты поставщика, которые проверяются и подставляются в документы. */
export const REQUISITE_FIELDS = [
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
] as const;
export type RequisiteField = (typeof REQUISITE_FIELDS)[number];

/** Названия реквизитов для сообщений людям. */
export const REQUISITE_LABELS: Readonly<Record<RequisiteField, string>> = {
  inn: 'ИНН',
  kpp: 'КПП',
  ogrn: 'ОГРН',
  legalAddress: 'юридический адрес',
  bankName: 'банк',
  bik: 'БИК',
  settlementAccount: 'расчётный счёт',
  correspondentAccount: 'корреспондентский счёт',
  directorName: 'подписант',
};

/** Без этих реквизитов договор не готовят (КПП — только у юрлица, см. `requiredFor`). */
const REQUIRED_ALWAYS: readonly RequisiteField[] = [
  'inn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
];

/** Обязательные реквизиты: у ИП (ИНН из 12 цифр) КПП нет. */
function requiredFor(supplier: Supplier): RequisiteField[] {
  const isPerson = supplier.inn?.length === INN_PERSON_LENGTH;
  return isPerson ? [...REQUIRED_ALWAYS] : [...REQUIRED_ALWAYS, 'kpp'];
}

/** Итог проверки реквизитов: чего нет и что не прошло контрольные суммы. */
export interface RequisitesCheck {
  missing: RequisiteField[];
  invalid: Array<{ field: RequisiteField; reason: string }>;
}

/** Поля, по которым считаются контрольные суммы (карточка поставщика или реквизиты документа). */
type ChecksumFields = Pick<
  Supplier,
  'inn' | 'kpp' | 'ogrn' | 'bik' | 'settlementAccount' | 'correspondentAccount'
>;

function checksFor(supplier: ChecksumFields): Array<[RequisiteField, boolean | null, string]> {
  const { inn, kpp, ogrn, bik, settlementAccount, correspondentAccount } = supplier;
  const bikOk = bik !== undefined && isValidBik(bik);
  return [
    ['inn', inn === undefined ? null : isValidInn(inn), 'неверная длина или контрольная сумма'],
    ['kpp', kpp === undefined ? null : isValidKpp(kpp), 'ожидается 9 знаков'],
    ['ogrn', ogrn === undefined ? null : isValidOgrn(ogrn), 'неверная контрольная цифра'],
    ['bik', bik === undefined ? null : bikOk, 'ожидается 9 цифр, начало «04»'],
    [
      'settlementAccount',
      settlementAccount === undefined || bik === undefined
        ? null
        : isValidSettlementAccount(settlementAccount, bik),
      'не проходит контрольную сумму с БИК',
    ],
    [
      'correspondentAccount',
      correspondentAccount === undefined || bik === undefined
        ? null
        : isValidCorrespondentAccount(correspondentAccount, bik),
      'не проходит контрольную сумму с БИК',
    ],
  ];
}

/** Проверить реквизиты поставщика: недостающие обязательные и неверные по контрольным суммам. */
export function checkSupplierRequisites(supplier: Supplier): RequisitesCheck {
  const missing = requiredFor(supplier).filter((field) => {
    const value = supplier[field];
    return value === undefined || value.trim() === '';
  });
  const invalid = checksFor(supplier)
    .filter(([, ok]) => ok === false)
    .map(([field, , reason]) => ({ field, reason }));
  return { missing, invalid };
}

/**
 * Замечания по реквизитам поставщика (пусто = реквизиты полны и корректны). Поля из `skip`
 * (значение допущено по сообщениям сотрудника) замечаниями карточки не блокируются.
 */
export function validateSupplierRequisites(
  supplier: Supplier,
  skip: ReadonlySet<string> = new Set(),
): ValidationIssue[] {
  const check = checkSupplierRequisites(supplier);
  const missing = check.missing.filter((field) => !skip.has(field));
  const invalid = check.invalid.filter(({ field }) => !skip.has(field));
  return [
    // Нет реквизита в карточке - напоминание сотруднику, а не отказ: в договоре будет маркер.
    ...missing.map((field) =>
      warningIssue('requisite_missing', `У поставщика не заполнено: ${REQUISITE_LABELS[field]}.`),
    ),
    // Контрольная сумма названного реквизита - предупреждение: значение идёт в документ как
    // есть, сотрудник сверяет его с первичными документами.
    ...invalid.map(({ field, reason }) =>
      warningIssue(
        'requisite_invalid',
        `У поставщика ${REQUISITE_LABELS[field]}: ${reason}. Проверьте реквизит.`,
      ),
    ),
  ];
}

/**
 * Реквизиты документа, не прошедшие контрольные суммы (ИНН, КПП, ОГРН, БИК, счета): проверяются
 * только заполненные поля. Без значений: имя поля и причина.
 */
export function invalidRequisiteChecks(
  requisites: Readonly<Record<string, string>> | undefined,
): Array<{ field: RequisiteField; reason: string }> {
  const pick = (field: RequisiteField): string | undefined => {
    const value = requisites?.[field]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const fields: ChecksumFields = {
    inn: pick('inn'),
    kpp: pick('kpp'),
    ogrn: pick('ogrn'),
    bik: pick('bik'),
    settlementAccount: pick('settlementAccount'),
    correspondentAccount: pick('correspondentAccount'),
  };
  return checksFor(fields)
    .filter(([, ok]) => ok === false)
    .map(([field, , reason]) => ({ field, reason }));
}

/**
 * Контрольные суммы реквизитов, указанных в документе (ИНН, КПП, ОГРН, БИК, счета): проверяются
 * только заполненные поля, отсутствующие полем не считаются. Сверка с базой - отдельно.
 */
export function validateRequisitesChecksums(
  requisites: Readonly<Record<string, string>> | undefined,
): ValidationIssue[] {
  return invalidRequisiteChecks(requisites).map(({ field, reason }) =>
    warningIssue(
      'requisite_invalid',
      `В документе ${REQUISITE_LABELS[field]}: ${reason}. Реквизит внесён как назван, проверьте.`,
    ),
  );
}

/** Заполненные реквизиты поставщика как плоская запись (для документа и сверки). */
export function supplierRequisitesRecord(supplier: Supplier): Record<string, string> {
  const record: Record<string, string> = {};
  for (const field of REQUISITE_FIELDS) {
    const value = supplier[field];
    if (value !== undefined && value.trim() !== '') record[field] = value.trim();
  }
  return record;
}

/** Предел длины текстовых реквизитов (адрес, банк, подписант); совпадает с CHECK в БД. */
const REQUISITE_TEXT_MAX_LENGTH = 500;
const TEXT_REQUISITES: readonly RequisiteField[] = ['legalAddress', 'bankName', 'directorName'];
const ACCOUNT_PATTERN = /^\d{20}$/;
const ACCOUNT_FIELDS: readonly RequisiteField[] = ['settlementAccount', 'correspondentAccount'];

/**
 * Подготовить поставщика к записи в хранилище: реквизиты обрезаются по краям, пустые
 * отбрасываются, остальные проверяются (контрольные суммы, формат счетов, длина текстов).
 * Невалидные реквизиты — DomainError('invalid_input'), в хранилище они не попадают.
 * Полноту (чего не хватает) не проверяет: она нужна документу, а не записи.
 */
export function prepareSupplierForWrite(supplier: Supplier): Supplier {
  const prepared: Supplier = { ...supplier };
  for (const field of REQUISITE_FIELDS) {
    const value = supplier[field]?.trim();
    if (value === undefined || value === '') delete prepared[field];
    else prepared[field] = value;
  }
  const problems = checkSupplierRequisites(prepared).invalid.map(
    ({ field, reason }) => `${REQUISITE_LABELS[field]}: ${reason}`,
  );
  for (const field of ACCOUNT_FIELDS) {
    const value = prepared[field];
    if (value !== undefined && !ACCOUNT_PATTERN.test(value)) {
      problems.push(`${REQUISITE_LABELS[field]}: ожидается 20 цифр`);
    }
  }
  for (const field of TEXT_REQUISITES) {
    if ((prepared[field]?.length ?? 0) > REQUISITE_TEXT_MAX_LENGTH) {
      problems.push(`${REQUISITE_LABELS[field]}: длиннее ${REQUISITE_TEXT_MAX_LENGTH} знаков`);
    }
  }
  if (problems.length > 0) {
    throw new DomainError(
      'invalid_input',
      `Реквизиты поставщика ${supplier.id} не записаны: ${[...new Set(problems)].join('; ')}.`,
    );
  }
  return prepared;
}
