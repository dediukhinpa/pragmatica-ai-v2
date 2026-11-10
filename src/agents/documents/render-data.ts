import { REQUISITE_FIELDS } from '../../kit/domain/requisites';
import { fromMinorUnits, lineCents, sumLineCents, toMinorUnits } from '../../kit/domain/money';
import { integerInWords, kopecksDigits, rublesInWords } from '../../kit/domain/amount-in-words';
import { vatIncludedInTotal, vatRateOn } from '../../kit/domain/vat';
import { workingDaysUntil } from '../../kit/domain/work-calendar.owned';
import { type DealDocument, type DocumentKind } from '../../kit/domain/models';
import type { RenderData, RenderValue } from '@business-ai/core';
import { OUTPUT_EXTENSION } from './deps';
import {
  DELIVERY_VARIANTS,
  LINES_LIST_NAME,
  NOT_APPLICABLE_VALUE,
  PAYMENT_PREPAY_PERCENT,
  PAYMENT_VARIANTS,
  isEmployeeFieldKey,
  parsePenaltyAmount,
  parsePercent,
} from './template-fields';

/**
 * Устаревший псевдоним номера заявки в шаблонах: от времён, когда была сделка. Заполняется
 * номером заявки документа, а без неё пустой строкой: незаполненным полем он не считается.
 */
export const DEAL_REF_FIELD = 'dealRef';

/** Месяцы в родительном падеже: «21» октября 2026 года. */
const MONTHS_GENITIVE: readonly string[] = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
/** Дата ISO (`2026-10-21`, время после даты не важно) и русская запись `21.10.2026`. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
const RU_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
/** Копеек в рубле. */
const KOPECKS_PER_RUBLE = 100;
/** Рублей в тысяче: штраф NDA в шаблоне назван числом тысяч. */
const RUBLES_PER_THOUSAND = 1000;
/** Предел процента: окончательный платёж = 100 минус предоплата. */
const PERCENT_TOTAL = 100;
/** ИНН индивидуального предпринимателя: 12 цифр, КПП у такого поставщика нет. */
const PERSON_INN_LENGTH = 12;
/** Всё, кроме цифр: пробелы и дефисы в записи ИНН не должны скрывать его длину. */
const NON_DIGITS = /\D/g;
/** Реквизиты поставщика, которые документ вправе нести в метки `seller_<поле>`. */
const KNOWN_REQUISITES: ReadonlySet<string> = new Set(REQUISITE_FIELDS);

/**
 * Читаемая дата для договора: `«21» октября 2026 года`. Не дата или несуществующая дата
 * возвращается как есть: сотрудник уже мог написать её словами.
 */
export function formatContractDate(raw: string): string {
  const date = parseDocumentDate(raw);
  const monthName = date === undefined ? undefined : MONTHS_GENITIVE[date.month - 1];
  return date !== undefined && monthName !== undefined
    ? `«${date.day}» ${monthName} ${date.year} года`
    : raw;
}

/** Календарная дата документа. */
export interface DocumentDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Дата документа из `2026-10-21` (время после даты не важно) или `21.10.2026`. Не дата и
 * несуществующая дата (31.02) - `undefined`.
 */
export function parseDocumentDate(raw: string): DocumentDate | undefined {
  const text = raw.trim();
  const iso = ISO_DATE.exec(text);
  const ru = RU_DATE.exec(text);
  const [year, month, day] =
    iso !== null
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : ru !== null
        ? [Number(ru[3]), Number(ru[2]), Number(ru[1])]
        : [0, 0, 0];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const exists =
    year > 0 &&
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return exists ? { year, month, day } : undefined;
}

/** Срок, названный датой: «до 05.11.2026», «05.11.2026 г.», «до 2026-11-05». */
const TERM_DATE = /^(?:до\s+)?(\S+?)(?:\s*г(?:ода|\.)?)?$/i;

/** Дата из срока, названного датой; undefined - это не дата. */
export function termDate(value: string): DocumentDate | undefined {
  const match = TERM_DATE.exec(value.trim());
  return match?.[1] === undefined ? undefined : parseDocumentDate(match[1]);
}

/**
 * Срок датой -> число рабочих дней от даты договора (не включая её) по производственному
 * календарю: модель путала календарные дни с рабочими и не знала праздников. Не дата - как
 * есть. Дата, которую перевести нельзя (не позже договора, год вне календаря), тоже остаётся
 * как есть: проверка полноты спросит сотрудника число дней. Какие сроки считаются от даты
 * договора, решает шаблон (`TERMS_FROM_CONTRACT_DATE`).
 */
export function termInWorkingDays(value: string, issuedAt: string): string {
  const until = termDate(value);
  const start = parseDocumentDate(issuedAt);
  if (until === undefined || start === undefined) return value;
  const days = workingDaysUntil(isoDay(start), isoDay(until));
  return days === undefined ? value : String(days);
}

/** Дата документа в виде ISO `ГГГГ-ММ-ДД` для таблицы ставок НДС. */
export function isoDay(date: DocumentDate): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Окончательный платёж: 100 минус предоплата; без числового процента - «—». */
function finalPaymentPercent(prepayment: string): string {
  const number = parsePercent(prepayment);
  if (number === undefined) return NOT_APPLICABLE_VALUE;
  return String(Math.round((PERCENT_TOTAL - number) * KOPECKS_PER_RUBLE) / KOPECKS_PER_RUBLE);
}

/** Значения, которые код задаёт договору сверх документа. */
export interface RenderOptions {
  /**
   * Номер договора, выданный системой (`ContractNumbering`): ложится в `number` и
   * `contract_number`, сотрудник и модель его не перекрывают.
   */
  contractNumber?: string | undefined;
  /** Текущий год для метки `current_year`; без него берётся год даты документа. */
  currentYear?: number | undefined;
  /**
   * Контакт менеджера сделки (`buyer_contact_name/phone/email`): персональные данные, только
   * найденные поля. Перекрывают значения модели и сотрудника; недостающие спрашивают у
   * сотрудника.
   */
  buyerContact?: Readonly<Record<string, string>> | undefined;
}

/** Значение входит в список допустимых. */
function isIn(allowed: readonly string[], value: string): boolean {
  return allowed.includes(value);
}

/** Оплата и доставка по выбранным вариантам: проценты и адрес зависят от варианта. */
function variantFields(employee: Record<string, string>): Record<string, RenderValue> {
  const result: Record<string, RenderValue> = {};
  const payment = employee['payment_variant']?.toLowerCase();
  if (payment === 'advance') {
    const prepayment = employee['prepayment_percent'];
    if (prepayment !== undefined) {
      result['prepayment_percent'] = prepayment;
      result['final_payment_percent'] = finalPaymentPercent(prepayment);
    }
  } else if (payment === 'prepay' || payment === 'postpay') {
    // Полная предоплата и постоплата: проценты задаёт код, ответ сотрудника их не меняет.
    const prepaid = payment === 'prepay' ? PAYMENT_PREPAY_PERCENT : 0;
    result['prepayment_percent'] = String(prepaid);
    result['final_payment_percent'] = String(PERCENT_TOTAL - prepaid);
  }
  if (payment !== undefined && isIn(PAYMENT_VARIANTS, payment)) {
    result['payment_variant'] = payment;
  }
  const delivery = employee['delivery_variant']?.toLowerCase();
  if (delivery !== undefined && isIn(DELIVERY_VARIANTS, delivery)) {
    result['delivery_variant'] = delivery;
  }
  if (delivery === 'delivery' && employee['delivery_address'] !== undefined) {
    result['delivery_address'] = employee['delivery_address'];
  } else if (delivery === 'pickup') {
    result['delivery_address'] = NOT_APPLICABLE_VALUE;
  }
  return result;
}

/** Штраф NDA: сумма от сотрудника, пропись и число тысяч для шаблона считает код. */
function penaltyFields(employee: Record<string, string>): Record<string, RenderValue> {
  const raw = employee['nda_penalty_amount'];
  const amount = raw === undefined ? undefined : parsePenaltyAmount(raw);
  if (amount === undefined) return {};
  const words = rublesInWords(amount);
  // «Тысяч» в тексте шаблона зашито: число тысяч прописью есть только у кратной тысяче суммы.
  const thousands =
    amount % RUBLES_PER_THOUSAND === 0
      ? integerInWords(amount / RUBLES_PER_THOUSAND, 'f')
      : undefined;
  return {
    nda_penalty_amount: amount,
    ...(words === undefined ? {} : { nda_penalty_words: words }),
    ...(thousands === undefined ? {} : { nda_penalty_thousands_words: thousands }),
  };
}

/**
 * Метки договоров и NDA, которые код вычисляет или переносит из документа: читаемые даты,
 * номер договора, сумма цифрами и прописью, ставка и сумма НДС по дате, оплата и доставка по
 * вариантам, срок поставки, КПП ИП, текущий год. Метки сотрудника (`templateFields`)
 * принимаются только из списка допустимых; метки кода сотрудник перекрыть не может.
 */
function contractFields(doc: DealDocument, options: RenderOptions): Record<string, RenderValue> {
  const employee: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc.templateFields ?? {})) {
    if (isEmployeeFieldKey(key) && value.trim() !== '') employee[key] = value.trim();
  }
  for (const key of ['spec_date', 'contract_date']) {
    const value = employee[key];
    if (value !== undefined) employee[key] = formatContractDate(value);
  }
  // Проценты оплаты и адрес доставки определяет вариант (variantFields), слово сотрудника
  // не перекрывает расчёт; окончательный платёж только расчётный.
  const { prepayment_percent: _p, final_payment_percent: _f, delivery_address: _a, ...rest } =
    employee;
  const innDigits = (doc.requisites?.['inn'] ?? '').replace(NON_DIGITS, '');
  const date = parseDocumentDate(doc.issuedAt);
  const vatRate = date === undefined ? undefined : vatRateOn(isoDay(date));
  // Итог договора считает код по строкам: слово модели в `total` на сборку не влияет.
  const kopecksTotal = doc.lines.length > 0 ? sumLineCents(doc.lines) : toMinorUnits(doc.total);
  const total = fromMinorUnits(kopecksTotal);
  const rubles = Math.trunc(kopecksTotal / KOPECKS_PER_RUBLE);
  const computed: Record<string, RenderValue> = {
    ...(doc.kind === 'contract'
      ? {
          // Дата договора в шаблонах стоит вместо всей фразы «__» ____ 2026 года.
          issuedAt: formatContractDate(doc.issuedAt),
          total,
          total_rubles: rubles,
          total_kopecks: kopecksDigits(kopecksTotal % KOPECKS_PER_RUBLE),
          total_rubles_words: integerInWords(rubles) ?? '',
          // Ячейки строк «ИТОГО» и «в том числе НДС» таблицы спецификации: число в том же виде,
          // что `items.sum`. Без ставки НДС по дате прочерк, а не 0: нулевой НДС был бы
          // ложным утверждением о сумме.
          total_sum: total,
          vat_sum:
            vatRate === undefined ? NOT_APPLICABLE_VALUE : vatIncludedInTotal(total, vatRate),
          ...(vatRate === undefined
            ? {}
            : { vat_rate: vatRate, vat_amount: vatIncludedInTotal(total, vatRate) }),
        }
      : {}),
    ...(options.contractNumber === undefined
      ? {}
      : { number: options.contractNumber, contract_number: options.contractNumber }),
    // У ИП (ИНН из 12 цифр) КПП нет: ключ остаётся пустым, шаблон скрывает строку условием.
    ...(innDigits.length === PERSON_INN_LENGTH && (doc.requisites?.['kpp'] ?? '') === ''
      ? { seller_kpp: '' }
      : {}),
    ...(doc.deliveryDays === undefined && employee['delivery_days'] === undefined
      ? {}
      : { delivery_days: doc.deliveryDays ?? employee['delivery_days'] ?? '' }),
    ...variantFields(employee),
    ...penaltyFields(employee),
    current_year: options.currentYear ?? date?.year ?? '',
    // Контакт менеджера идёт последним: значение кода главнее ответа сотрудника.
    ...(doc.kind === 'contract' ? options.buyerContact : undefined),
  };
  // Метки кода идут последними: допустимые метки сотрудника их не пересекают.
  const { nda_penalty_amount: _n, delivery_days: _d, ...employeeRest } = rest;
  return { ...employeeRest, ...computed };
}

/**
 * Данные для шаблона из доменного документа.
 *
 * Скаляры: `{{number}}`, `{{kind}}`, `{{buyer}}`, `{{seller}}`, `{{currency}}`,
 * `{{issuedAt}}`, `{{dueDate}}` (только если задан), `{{total}}`.
 * Документ с поставщиком (только заданное): `{{paymentTerms}}`, `{{deliveryDays}}`,
 * `{{requestId}}`, `{{vatRate}}`, `{{vatAmount}}` и реквизиты поставщика `{{seller_inn}}`,
 * `{{seller_kpp}}`, `{{seller_bik}}`, `{{seller_legalAddress}}` и т. д. (по именам полей Supplier).
 * Договор (kind=contract): `{{issuedAt}}` читаемой датой «21» октября 2026 года; итог по
 * строкам: `{{total_rubles}}`, `{{total_kopecks}}`, `{{total_rubles_words}}` (прописью, код);
 * `{{vat_rate}}` (число процентов по дате документа) и `{{vat_amount}}`; `{{total_sum}}` и
 * `{{vat_sum}}` - итог и НДС для пустых ячеек таблицы спецификации (без ставки НДС - «—»);
 * `{{contract_number}}`
 * и `{{number}}` - номер системы (`options.contractNumber`); `{{current_year}}`;
 * `{{delivery_days}}`; оплата и доставка по вариантам (`payment_variant`, `delivery_variant`):
 * проценты и адрес зависят от варианта; штраф NDA: `{{nda_penalty_amount}}`,
 * `{{nda_penalty_words}}`, `{{nda_penalty_thousands_words}}`; `{{seller_kpp}}` пустой у ИП;
 * метки из `templateFields` (только допустимые, см. `template-fields.ts`). Реквизиты
 * `requisites` попадают в `seller_<поле>` только по полям поставщика (`REQUISITE_FIELDS`).
 * Устаревшее `{{dealRef}}` - номер заявки (`requestId`) или пустая строка; всегда задано.
 * Строки таблицы `{{items.name}}`, `{{items.characteristics}}`, `{{items.quantity}}`,
 * `{{items.unitPrice}}`, `{{items.sum}}` (считает код), `{{items.term}}`; `{{items._n}}` -
 * номер строки (его добавляет сервис).
 */
export function buildRenderData(doc: DealDocument, options: RenderOptions = {}): RenderData {
  return {
    fields: {
      number: doc.number,
      kind: doc.kind,
      buyer: doc.buyer,
      seller: doc.seller,
      currency: doc.currency,
      issuedAt: doc.issuedAt,
      ...(doc.dueDate === undefined ? {} : { dueDate: doc.dueDate }),
      total: doc.total,
      ...(doc.paymentTerms === undefined ? {} : { paymentTerms: doc.paymentTerms }),
      ...(doc.deliveryDays === undefined ? {} : { deliveryDays: doc.deliveryDays }),
      ...(doc.requestId === undefined ? {} : { requestId: doc.requestId }),
      [DEAL_REF_FIELD]: doc.requestId ?? '',
      ...(doc.vatRate === undefined ? {} : { vatRate: doc.vatRate }),
      ...(doc.vatAmount === undefined ? {} : { vatAmount: doc.vatAmount }),
      ...Object.fromEntries(
        Object.entries(doc.requisites ?? {})
          .filter(([field]) => KNOWN_REQUISITES.has(field))
          .map(([field, value]) => [`seller_${field}`, value]),
      ),
      // Идёт последним: читаемая дата договора заменяет ISO-значение issuedAt.
      ...contractFields(doc, options),
    },
    lists: {
      [LINES_LIST_NAME]: doc.lines.map((line) => ({
        name: line.name,
        characteristics: line.characteristics ?? '',
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        // Сумма строки округлена до копеек: без хвоста двоичной дроби в документе (R3-ALG-21).
        sum: fromMinorUnits(lineCents(line.quantity, line.unitPrice)),
        term: line.term ?? '',
      })),
    },
  };
}

/** Недопустимые в имени файла символы: разделители пути, спецсимволы, пробелы, управляющие. */
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|\s\u0000-\u001f]+/gu;
/** Две и более точки подряд (в том числе `..`): выход из каталога по пути. */
const DOT_RUNS = /\.{2,}/g;

/** Название вида документа в имени файла (читаемое, без служебных слов вроде `contract`). */
const KIND_FILE_LABELS: Record<DocumentKind, string> = {
  contract: 'Договор',
  commercial_offer: 'Коммерческое_предложение',
  invoice: 'Счёт',
  closing: 'Закрывающие_документы',
};
/** Организационно-правовая форма в начале названия: в имени файла только суть. */
const LEGAL_FORM_PREFIX = new RegExp(
  '^(?:публичное акционерное общество|акционерное общество|' +
    'общество с ограниченной ответственностью|индивидуальный предприниматель|' +
    'пао|зао|ооо|ао|ип)\\s+',
  'iu',
);
/** Кавычки вокруг названия контрагента. */
const QUOTE_CHARS = /[«»"“”„]/gu;
/** Предел длины названия контрагента в имени файла. */
const MAX_PARTY_NAME_LENGTH = 40;
/** Дата в начале ISO-строки: хвост имени, если у документа нет настоящего номера. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/u;
/** Повторы подчёркивания после замены спецсимволов. */
const UNDERSCORE_RUNS = /_{2,}/g;
const EDGE_UNDERSCORES = /^_+|_+$/g;

/** Короткое название контрагента: без формы собственности и кавычек, не длиннее предела. */
function shortPartyName(name: string): string {
  return name
    .replace(QUOTE_CHARS, '')
    .trim()
    .replace(LEGAL_FORM_PREFIX, '')
    .trim()
    .slice(0, MAX_PARTY_NAME_LENGTH);
}

/**
 * Имя итогового файла: «ТБанк_Договор_12.docx» (по названию компании). Контрагент -
 * поставщик (если документ с поставщиком) или покупатель. Хвост - номер, а без настоящего
 * номера (пусто или маркер «заполнить») - дата документа, если она есть. Номер и названия
 * задаёт модель, поэтому разделители пути, управляющие символы и `..` заменяются (S-08); имя
 * идёт в чат, но не должно быть путём, даже если его когда-нибудь используют как путь.
 */
export function outputFileName(doc: DealDocument): string {
  const party = shortPartyName(doc.supplierId === undefined ? doc.buyer : doc.seller);
  const hasNumber = /\d/u.test(doc.number);
  const tail = hasNumber ? doc.number : ISO_DATE_PREFIX.exec(doc.issuedAt)?.[0] ?? '';
  return [party, KIND_FILE_LABELS[doc.kind], tail]
    .filter((part) => part.length > 0)
    .join('_')
    .replace(UNSAFE_FILE_NAME_CHARS, '_')
    .replace(DOT_RUNS, '_')
    .replace(UNDERSCORE_RUNS, '_')
    .replace(EDGE_UNDERSCORES, '')
    .concat(OUTPUT_EXTENSION);
}
