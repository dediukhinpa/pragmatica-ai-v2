import { REQUISITE_FIELDS } from '../../kit/domain/requisites';
import { parseNumberText } from '../../kit/domain/number-text';
import { warningIssue, type ValidationIssue } from '@business-ai/core';
import { type DealDocument } from '../../kit/domain/models';
import type { RenderData, RenderValue } from '@business-ai/core';
import { contractTemplateByPath, type ContractTemplate } from './template-registry';

/** Минимум и максимум процента (предоплата, окончательный платёж). */
const PERCENT_MIN = 0;
const PERCENT_MAX = 100;
/** Процент строго: 1-3 цифры, необязательная дробная часть (точка или запятая), знак %. */
const PERCENT_PATTERN = /^\d{1,3}([.,]\d+)?%?$/;
/** Сотых долей в проценте: сравнение «предоплата + окончательный = 100» без хвоста дроби. */
const PERCENT_PRECISION = 100;
/** Значение «не применимо»: сотрудник отвечает им, если вариант условия в договоре не выбран. */
export const NOT_APPLICABLE_VALUE = '—';
/** Имя списка строк документа в шаблоне: строка таблицы с `{{items.name}}`. */
export const LINES_LIST_NAME = 'items';
/** Варианты оплаты: аванс и окончательный платёж, полная предоплата, постоплата. */
export const PAYMENT_VARIANTS = ['advance', 'prepay', 'postpay'] as const;
/** Варианты передачи товара: самовывоз или доставка по адресу. */
export const DELIVERY_VARIANTS = ['pickup', 'delivery'] as const;
/** Предоплата при варианте prepay, %. */
export const PAYMENT_PREPAY_PERCENT = 100;
/** ИНН индивидуального предпринимателя: 12 цифр, КПП у него нет. */
const PERSON_INN_LENGTH = 12;

/**
 * Метки, значения которых называет только сотрудник (поле `templateFields` документа), и
 * вопрос сотруднику по каждой. Остальные метки код берёт из документа, карточки поставщика и
 * КП либо вычисляет сам, поэтому через `templateFields` они не принимаются.
 */
const EMPLOYEE_FIELD_QUESTIONS: Readonly<Record<string, string>> = {
  seller_representative:
    'Кто подписывает договор от поставщика: должность и ФИО в родительном падеже ' +
    '(например, «генерального директора Иванова Ивана Ивановича»)?',
  seller_authority_basis:
    'На каком основании действует подписант поставщика (например, «Устава» или ' +
    '«доверенности № 5 от 01.02.2026»)?',
  seller_position:
    'Какая должность у подписанта поставщика (например, «генеральный директор»)? ' +
    'В данных поставщика её нет.',
  payment_variant:
    'Как оплачивается договор: с авансом и окончательным платежом (advance), полной ' +
    'предоплатой (prepay) или после поставки (postpay)?',
  delivery_variant:
    'Как передаётся товар: самовывозом (pickup) или доставкой по адресу (delivery)?',
  delivery_days: 'Какой срок поставки, в рабочих днях (в КП он не указан)?',
  // Для четырёх договоров № 1 и дату договора подставляет код (contract-defaults.ts);
  // вопросы остаются на случай, когда дата договора не распознана.
  spec_number: 'Какой номер у спецификации?',
  spec_date: 'Какая дата у спецификации?',
  tz_number: 'Какой номер у технического задания?',
  contract_number: 'Какой номер у основного договора, к которому относится соглашение?',
  contract_date: 'Какая дата у основного договора, к которому относится соглашение?',
  prepayment_percent:
    'Какой процент предоплаты (авансового платежа)? Если оплата без аванса, ответьте «—».',
  final_payment_percent:
    'Окончательный платёж считается как 100 минус предоплата; если называете его, ' +
    'предоплата и окончательный платёж вместе должны давать 100%.',
  production_days: 'Какой срок изготовления, в рабочих днях?',
  delivery_address: 'Какой адрес доставки?',
  warranty_period: 'Какой гарантийный срок в спецификации (например, «12 месяцев»)?',
  // Гарантия одна на договор и спецификацию: спрашиваем её один раз, второе поле выводит код.
  warranty_months:
    'Какой гарантийный срок на продукцию, в месяцах (в договоре не менее 6; например, 12)?',
  buyer_contact_name: 'Кто контактное лицо от нашей стороны (ФИО)?',
  buyer_contact_phone: 'Какой телефон контактного лица от нашей стороны?',
  buyer_contact_email: 'Какой e-mail контактного лица от нашей стороны?',
  seller_contactName: 'Кто контактное лицо «От Исполнителя» (ФИО)? Уточните у менеджера.',
  seller_phone: 'Какой телефон контактного лица «От Исполнителя»? Уточните у менеджера.',
  seller_email: 'Какой e-mail контактного лица «От Исполнителя»? Уточните у менеджера.',
  nda_penalty_amount:
    'Какой размер штрафа в соглашении о неразглашении, цифрами в рублях ' +
    '(целая сумма, кратная тысяче; пропись сформирует система)?',
};

/**
 * Вопросы по меткам, которые код берёт из документа, карточки и КП: показываются, когда
 * значения нет (например, у КП не указан срок поставки).
 */
const DERIVED_FIELD_QUESTIONS: Readonly<Record<string, string>> = {
  issuedAt: 'Какая дата договора?',
  number:
    'Какой номер договора? Его нет в системе: посмотрите номер в реестре договоров и назовите.',
  seller: 'Как называется поставщик (с формой собственности, например «ООО «Ромашка»»)?',
  seller_inn: 'Какой ИНН поставщика?',
  seller_kpp: 'Какой КПП поставщика?',
  seller_settlementAccount: 'Какой расчётный счёт поставщика?',
  seller_bankName: 'В каком банке открыт счёт поставщика?',
  seller_correspondentAccount: 'Какой корреспондентский счёт банка поставщика?',
  seller_bik: 'Какой БИК банка поставщика?',
  seller_legalAddress: 'Какой юридический адрес поставщика?',
  seller_directorName: 'Кто руководитель поставщика (ФИО)?',
  total_rubles: 'Какова общая сумма договора?',
  total_rubles_words: 'Какова общая сумма договора?',
  vat_rate:
    'Не удалось определить ставку НДС по дате договора: укажите дату в формате ДД.ММ.ГГГГ.',
  nda_penalty_words:
    'Какую сумму штрафа указать в соглашении (в рублях)?',
  total_kopecks: 'Какова общая сумма договора?',
  deliveryDays: 'Какой срок поставки, в днях (в КП он не указан)?',
  items: 'В выбранном КП нет позиций: уточните позиции, количества и цены.',
};

/** Допустимые ключи `templateFields`: только метки, которые называет сотрудник. */
export function isEmployeeFieldKey(key: string): boolean {
  return Object.hasOwn(EMPLOYEE_FIELD_QUESTIONS, key);
}

/** Метки, общие для четырёх договоров (МГ и ПР, готовая и контрактная продукция). */
const CONTRACT_COMMON_LABELS: readonly string[] = [
  'issuedAt',
  'number',
  'seller',
  'seller_representative',
  'seller_position',
  'seller_authority_basis',
  'seller_inn',
  'seller_kpp',
  'seller_settlementAccount',
  'seller_bankName',
  'seller_correspondentAccount',
  'seller_bik',
  'seller_legalAddress',
  'seller_directorName',
  'spec_number',
  'spec_date',
  'tz_number',
  'payment_variant',
  'delivery_variant',
  'prepayment_percent',
  'final_payment_percent',
  'vat_rate',
  'total_rubles',
  'total_rubles_words',
  'total_kopecks',
  'delivery_address',
  'warranty_period',
  // Во всех четырёх шаблонах «Срок поставки: {{delivery_days}} рабочих дней»
  'delivery_days',
  'buyer_contact_name',
  'buyer_contact_phone',
  'buyer_contact_email',
  'seller_contactName',
  'seller_phone',
  'seller_email',
];

/**
 * Метки каждого шаблона (из templates/FIELDS.md этапа 78). Различия: срок (изготовления или
 * поставки) и гарантия в договоре.
 */
const TEMPLATE_LABELS: Readonly<Record<string, readonly string[]>> = {
  mg_ready: [...CONTRACT_COMMON_LABELS, 'production_days', 'warranty_months'],
  mg_contract: [...CONTRACT_COMMON_LABELS, 'production_days'],
  pr_ready: CONTRACT_COMMON_LABELS,
  pr_contract: [...CONTRACT_COMMON_LABELS, 'production_days'],
  mg_nda: [
    'issuedAt',
    'seller',
    'seller_representative',
    'seller_position',
    'seller_authority_basis',
    'contract_number',
    'contract_date',
    'nda_penalty_amount',
    'nda_penalty_words',
  ],
};

/** Метки шаблона из реестра (пусто для неизвестного шаблона). */
export function templateLabels(templateId: string): readonly string[] {
  return TEMPLATE_LABELS[templateId] ?? [];
}

/** Есть ли у шаблона метка (например, `warranty_months` только в договоре МГ на готовую). */
export function templateHasLabel(templateId: string, label: string): boolean {
  return (TEMPLATE_LABELS[templateId] ?? []).includes(label);
}

/** Недостающая метка и вопрос сотруднику человеческими словами. */
interface MissingTemplateField {
  label: string;
  question: string;
}

/** Проверка меток шаблона перед сборкой. */
export interface TemplateFieldsCheck {
  /** Шаблон из реестра; undefined - другой шаблон (КП, счёт), проверка не применяется. */
  template?: ContractTemplate | undefined;
  missing: MissingTemplateField[];
  /** Ключи `templateFields`, которые не принимаются (код сам задаёт эти метки). */
  rejectedKeys: string[];
  /** Ключи `requisites`, которых нет среди реквизитов поставщика. */
  rejectedRequisites: string[];
  /** Значения, которые не прошли формат или сверку (процент, сумма прописью). */
  invalid: MissingTemplateField[];
  complete: boolean;
}

/** Поля документа, которые проверяет код сверх данных сборки. */
export type TemplateFieldsInput = Pick<DealDocument, 'templateFields' | 'requisites'>;

/**
 * Метки, у которых вариант условия в договоре может быть не выбран: сотрудник отвечает «—»
 * (или код ставит его сам), и это считается заполнением. Остальные метки «—» не закрывает.
 */
const CONDITIONAL_LABELS: ReadonlySet<string> = new Set([
  'prepayment_percent',
  'final_payment_percent',
  'delivery_address',
  'warranty_period',
  'warranty_months',
]);

const PERCENT_LABELS: readonly string[] = ['prepayment_percent', 'final_payment_percent'];
/** Метки сроков, которые шаблоны пишут как «____ рабочих дней». */
export const WORKING_DAY_TERM_LABELS: readonly string[] = ['production_days', 'delivery_days'];
/**
 * Сроки, которые шаблон считает от даты договора, - только их дату код переводит в рабочие
 * дни. В остальных изготовление идёт «с момента согласования макетов / запуска в работу», а
 * поставка «с момента окончания изготовления»: общую дату на эти сроки не разложить.
 */
export const TERMS_FROM_CONTRACT_DATE: Readonly<Record<string, readonly string[]>> = {
  pr_ready: ['delivery_days'],
};
const TERM_NOT_FROM_CONTRACT =
  'в этом договоре срок считается не от даты договора (изготовление - с согласования ' +
  'макетов или запуска в работу, поставка - с окончания изготовления), поэтому дату в число ' +
  'дней не перевести.';
const TERM_NOT_CONVERTED =
  'дата не позже даты договора или её года нет в производственном календаре.';
/** Дата внутри срока («до 05.11.2026», «2026-11-05»): после сборки её быть не должно. */
const DATE_IN_TERM = /\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2}/;
const KNOWN_REQUISITES: ReadonlySet<string> = new Set(REQUISITE_FIELDS);

/**
 * Процент строго по шаблону `^\d{1,3}([.,]\d+)?%?$` и в пределах 0-100; иначе `undefined`.
 * `Number()` не используется: он принимает «1e1», «0x10», пробелы и пустую строку.
 */
export function parsePercent(value: string): number | undefined {
  const trimmed = value.trim();
  if (!PERCENT_PATTERN.test(trimmed)) return undefined;
  const number = Number(trimmed.replace(',', '.').replace('%', ''));
  return number >= PERCENT_MIN && number <= PERCENT_MAX ? number : undefined;
}

/** Метка не заполнена: нет значения, пусто, либо «—» у метки без условного варианта. */
function isUnfilled(label: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' || (trimmed === NOT_APPLICABLE_VALUE && !CONDITIONAL_LABELS.has(label));
}

const hundredths = (percent: number): number => Math.round(percent * PERCENT_PRECISION);

/** Процент: число от 0 до 100 или «—» (вариант не выбран). */
function isValidPercent(value: string): boolean {
  return value.trim() === NOT_APPLICABLE_VALUE || parsePercent(value) !== undefined;
}

/** Строка значения поля данных сборки; не строка - пустая. */
function textOf(data: RenderData, label: string): string {
  const value = data.fields[label];
  return typeof value === 'string' ? value : value === undefined ? '' : String(value);
}

/** Поставщик - ИП: ИНН из 12 цифр, КПП у него нет и не требуется. */
function isIndividualEntrepreneur(data: RenderData): boolean {
  return textOf(data, 'seller_inn').replace(/\D/g, '').length === PERSON_INN_LENGTH;
}

/**
 * Какие метки по варианту условий не нужны. Проценты оплаты нужны только при аванс, пока
 * вариант не назван - о процентах не спрашиваем; адрес доставки - только при доставке; КПП -
 * не у ИП.
 */
function irrelevantLabels(data: RenderData): Set<string> {
  const skip = new Set<string>();
  const payment = textOf(data, 'payment_variant');
  if (payment !== 'advance') {
    skip.add('prepayment_percent');
    skip.add('final_payment_percent');
  }
  // Окончательный платёж считается от предоплаты: пока её нет, о нём отдельно не спрашиваем.
  if (isUnfilled('prepayment_percent', data.fields['prepayment_percent'])) {
    skip.add('final_payment_percent');
  }
  if (textOf(data, 'delivery_variant') !== 'delivery') skip.add('delivery_address');
  // Число тысяч считается от суммы штрафа: пока суммы нет, о нём отдельно не спрашиваем.
  if (data.fields['nda_penalty_amount'] === undefined) skip.add('nda_penalty_words');
  if (isIndividualEntrepreneur(data)) skip.add('seller_kpp');
  return skip;
}

/** Значение варианта выбрано и допустимо (иначе вопрос сотруднику). */
function variantProblems(
  templateFields: Readonly<Record<string, string>>,
  labels: readonly string[],
  questionOf: (label: string) => string,
): MissingTemplateField[] {
  const checks: Array<[string, readonly string[]]> = [
    ['payment_variant', PAYMENT_VARIANTS],
    ['delivery_variant', DELIVERY_VARIANTS],
  ];
  const problems: MissingTemplateField[] = [];
  for (const [label, allowed] of checks) {
    const raw = templateFields[label]?.trim().toLowerCase();
    if (!labels.includes(label) || raw === undefined || raw === '') continue;
    if (!allowed.includes(raw)) {
      problems.push({
        label,
        question: `Значение «${raw}» не подходит (допустимо: ${allowed.join(', ')}). ` +
          questionOf(label),
      });
    }
  }
  return problems;
}

/** Позиции: они есть, у каждой заполнены характеристики и срок (иначе вопрос сотруднику). */
function itemProblems(data: RenderData): MissingTemplateField[] {
  const rows = data.lists[LINES_LIST_NAME] ?? [];
  if (rows.length === 0) {
    return [{ label: 'items', question: DERIVED_FIELD_QUESTIONS['items'] ?? '' }];
  }
  const problems: MissingTemplateField[] = [];
  const unnamed = (key: string): string[] =>
    rows
      .filter((row) => String(row[key] ?? '').trim() === '')
      .map((row) => `«${String(row['name'] ?? '')}»`);
  const noCharacteristics = unnamed('characteristics');
  if (noCharacteristics.length > 0) {
    problems.push({
      label: 'items.characteristics',
      question: `Каковы характеристики позиций: ${noCharacteristics.join(', ')} (в КП их нет)?`,
    });
  }
  const noTerm = unnamed('term');
  if (noTerm.length > 0) {
    problems.push({
      label: 'items.term',
      question: `Какой срок по позициям: ${noTerm.join(', ')} (в КП он не указан)?`,
    });
  }
  return problems;
}

/** Целое число рублей штрафа NDA из ответа сотрудника; не целое и не положительное - нет. */
export function parsePenaltyAmount(raw: string): number | undefined {
  const parsed = parseNumberText(raw);
  if (parsed.kind !== 'ok' || !Number.isInteger(parsed.value) || parsed.value <= 0) {
    return undefined;
  }
  return parsed.value;
}

/**
 * Сверка значений, которые сотрудник назвал, с расчётом кода: окончательный платёж с «100
 * минус предоплата». Расхождение - вопрос сотруднику. Сумма прописью и ставка НДС считаются
 * кодом, сверять их не с чем.
 */
function crossChecks(
  data: RenderData,
  templateFields: Readonly<Record<string, string>>,
  questionOf: (label: string) => string,
): MissingTemplateField[] {
  const problems: MissingTemplateField[] = [];
  const prepayment = parsePercent(String(data.fields['prepayment_percent'] ?? ''));
  const final = parsePercent(templateFields['final_payment_percent'] ?? '');
  if (prepayment !== undefined && final !== undefined) {
    if (hundredths(prepayment) + hundredths(final) !== hundredths(PERCENT_MAX)) {
      problems.push({
        label: 'final_payment_percent',
        question:
          `Предоплата ${prepayment}% и окончательный платёж ${final}% не дают 100%. ` +
          questionOf('final_payment_percent'),
      });
    }
  }
  return problems;
}

/**
 * Какие метки выбранного шаблона остались без значения в данных сборки. Вызывается ДО
 * сборки: список уходит агенту, и он спрашивает сотрудника.
 *
 * @param templatePath Путь шаблона (точный относительный путь реестра).
 * @param data Данные сборки (`buildRenderData`).
 * @param input Ключи `templateFields` и `requisites` от модели (для отчёта о недопустимых).
 * @param templatesPrefix Каталог шаблонов (`TEMPLATES_PREFIX`), от которого считается путь.
 */
export function checkTemplateFields(
  templatePath: string,
  data: RenderData,
  input: TemplateFieldsInput = {},
  templatesPrefix = '',
): TemplateFieldsCheck {
  const template = contractTemplateByPath(templatePath, templatesPrefix);
  const templateFields = input.templateFields ?? {};
  const rejectedKeys = Object.keys(templateFields).filter((key) => !isEmployeeFieldKey(key));
  const rejectedRequisites = Object.keys(input.requisites ?? {}).filter(
    (key) => !KNOWN_REQUISITES.has(key),
  );
  const noRejected = rejectedKeys.length === 0 && rejectedRequisites.length === 0;
  if (template === undefined) {
    return { missing: [], rejectedKeys, rejectedRequisites, invalid: [], complete: noRejected };
  }
  const labels = TEMPLATE_LABELS[template.id] ?? [];
  const questionOf = (label: string): string =>
    EMPLOYEE_FIELD_QUESTIONS[label] ?? DERIVED_FIELD_QUESTIONS[label] ?? `Чему равно «${label}»?`;
  const skip = irrelevantLabels(data);
  const missing: MissingTemplateField[] = labels
    .filter((label) => !skip.has(label) && isUnfilled(label, data.fields[label]))
    .map((label) => ({ label, question: questionOf(label) }));
  // Месяцы и срок спецификации - одно значение: если нет обоих, вопрос один, про месяцы.
  if (missing.some((item) => item.label === 'warranty_months')) {
    const twin = missing.findIndex((item) => item.label === 'warranty_period');
    if (twin >= 0) missing.splice(twin, 1);
  }
  if (template.variant !== 'nda') missing.push(...itemProblems(data));
  const badPercents = PERCENT_LABELS.filter((label) => {
    const value = data.fields[label];
    return (
      !skip.has(label) && typeof value === 'string' && !isUnfilled(label, value) &&
      !isValidPercent(value)
    );
  }).map((label) => ({
    label,
    question: `Значение «${String(data.fields[label])}» не похоже на процент. ${questionOf(label)}`,
  }));
  // Срок датой код переводит в рабочие дни; осталась дата - перевести не удалось.
  const badTerms = WORKING_DAY_TERM_LABELS.filter((label) => {
    const value = data.fields[label];
    return labels.includes(label) && typeof value === 'string' && DATE_IN_TERM.test(value);
  }).map((label) => {
    const fromContract = (TERMS_FROM_CONTRACT_DATE[template.id] ?? []).includes(label);
    const reason = fromContract ? TERM_NOT_CONVERTED : TERM_NOT_FROM_CONTRACT;
    const value = String(data.fields[label]);
    return {
      label,
      question: `Срок «${value}» не переводится в рабочие дни: ${reason} ${questionOf(label)}`,
    };
  });
  const invalid = [
    ...badPercents,
    ...badTerms,
    ...variantProblems(templateFields, labels, questionOf),
    ...crossChecks(data, templateFields, questionOf),
  ];
  return {
    template,
    missing,
    rejectedKeys,
    rejectedRequisites,
    invalid,
    complete: missing.length === 0 && invalid.length === 0 && noRejected,
  };
}

/** Начало маркера пропуска: по нему сотрудник и проверка находят место в тексте договора. */
export const GAP_MARKER_PREFIX = '[ЗАПОЛНИТЬ: ';
const GAP_MARKER_SUFFIX = ']';

/** Маркер пропуска для поля: только название поля, значений и ПДн в нём нет. */
export function gapMarker(title: string): string {
  return `${GAP_MARKER_PREFIX}${title}${GAP_MARKER_SUFFIX}`;
}

/** Названия меток для маркера и списка пропусков; нет в списке - берётся имя метки. */
const FIELD_TITLES: Readonly<Record<string, string>> = {
  issuedAt: 'дата договора',
  number: 'номер договора',
  seller: 'наименование поставщика',
  seller_representative: 'представитель поставщика',
  seller_position: 'должность подписанта поставщика',
  seller_authority_basis: 'основание полномочий подписанта поставщика',
  seller_inn: 'ИНН поставщика',
  seller_kpp: 'КПП поставщика',
  seller_settlementAccount: 'расчётный счёт поставщика',
  seller_bankName: 'банк поставщика',
  seller_correspondentAccount: 'корреспондентский счёт поставщика',
  seller_bik: 'БИК банка поставщика',
  seller_legalAddress: 'юридический адрес поставщика',
  seller_directorName: 'руководитель поставщика',
  spec_number: 'номер спецификации',
  spec_date: 'дата спецификации',
  tz_number: 'номер технического задания',
  contract_number: 'номер основного договора',
  contract_date: 'дата основного договора',
  payment_variant: 'вариант оплаты',
  delivery_variant: 'вариант передачи товара',
  prepayment_percent: 'процент предоплаты',
  final_payment_percent: 'процент окончательного платежа',
  vat_rate: 'ставка НДС',
  vat_amount: 'сумма НДС',
  vat_sum: 'сумма НДС',
  total: 'общая сумма',
  total_sum: 'общая сумма',
  total_rubles: 'общая сумма, рубли',
  total_rubles_words: 'общая сумма прописью',
  total_kopecks: 'общая сумма, копейки',
  delivery_address: 'адрес доставки',
  warranty_period: 'гарантийный срок',
  warranty_months: 'гарантийный срок, месяцы',
  delivery_days: 'срок поставки',
  production_days: 'срок изготовления',
  buyer_contact_name: 'контактное лицо заказчика',
  buyer_contact_phone: 'телефон контактного лица заказчика',
  buyer_contact_email: 'e-mail контактного лица заказчика',
  seller_contactName: 'контактное лицо исполнителя',
  seller_phone: 'телефон контактного лица исполнителя',
  seller_email: 'e-mail контактного лица исполнителя',
  nda_penalty_amount: 'размер штрафа',
  nda_penalty_words: 'размер штрафа прописью',
  nda_penalty_thousands_words: 'размер штрафа, тысячи прописью',
  items: 'позиции договора',
  'items.name': 'наименование позиции',
  'items.quantity': 'количество по позиции',
  'items.unitPrice': 'цена позиции',
  'items.sum': 'сумма позиции',
  'items.characteristics': 'характеристики позиций',
  'items.term': 'срок по позициям',
};

/**
 * Метки, которые код выводит из основной метки пропуска: если пропущена основная, шаблон
 * всё равно ссылается на эти, и без маркера сервис документов вернул бы 422.
 */
const COMPANION_LABELS: Readonly<Record<string, readonly string[]>> = {
  // Номер договора шаблоны берут и как {{number}}, и как {{contract_number}}.
  number: ['contract_number'],
  vat_rate: ['vat_amount', 'vat_sum'],
  warranty_months: ['warranty_period'],
  nda_penalty_amount: ['nda_penalty_words', 'nda_penalty_thousands_words'],
  total_rubles: ['total', 'total_sum', 'total_kopecks'],
  total_rubles_words: ['total', 'total_sum', 'total_kopecks'],
  // Ветки оплаты и доставки скрыты, но метки вне блоков шаблон требует всегда.
  payment_variant: ['prepayment_percent', 'final_payment_percent'],
  delivery_variant: ['delivery_address'],
};

/**
 * Служебное значение варианта, который не назван: не совпадает ни с одной веткой шаблона
 * (`{{#if payment_variant=advance}}`), поэтому все ветки скрыты, а сервис документов вместо
 * них ставит один абзац-маркер из ключа `<метка>__gap`.
 */
export const VARIANT_UNSET_VALUE = 'unset';
/** Суффикс ключа с текстом абзаца-маркера для непоименованного варианта. */
export const VARIANT_GAP_SUFFIX = '__gap';
const PAYMENT_VARIANT_GAP_MARKER =
  '[ЗАПОЛНИТЬ: условия оплаты — выберите вариант: аванс с окончательным платежом / ' +
  'полная предоплата / оплата после поставки]';
const DELIVERY_VARIANT_GAP_MARKER =
  '[ЗАПОЛНИТЬ: способ передачи товара — выберите вариант: самовывоз / доставка по адресу]';
/** Абзац-маркер на место условных блоков по метке-варианту. */
const VARIANT_GAP_MARKERS: Readonly<Record<string, string>> = {
  payment_variant: PAYMENT_VARIANT_GAP_MARKER,
  delivery_variant: DELIVERY_VARIANT_GAP_MARKER,
};

/** Денежные метки, которые без позиций остались бы нулём: ноль в договоре - ложная сумма. */
const MONEY_FROM_LINES_LABELS: readonly string[] = [
  'total',
  'total_sum',
  'total_rubles',
  'total_rubles_words',
  'total_kopecks',
];
/** Ячейки строки таблицы, когда позиций нет вовсе: одна строка из одних маркеров. */
const ITEM_CELLS: readonly string[] = [
  'name',
  'characteristics',
  'quantity',
  'unitPrice',
  'sum',
  'term',
];
const ITEM_CELL_PREFIX = `${LINES_LIST_NAME}.`;

/** Пропуск в договоре: метка, её название, маркер в тексте и вопрос сотруднику. */
export interface TemplateGap {
  label: string;
  title: string;
  marker: string;
  question: string;
}

/** Данные сборки с маркерами на месте пропусков и список этих пропусков. */
export interface GapFilledData {
  data: RenderData;
  gaps: TemplateGap[];
  /** Предупреждения сборки (например, лишние ключи модели, которые код проигнорировал). */
  warnings: ValidationIssue[];
}

const titleOf = (label: string): string => FIELD_TITLES[label] ?? label;

/**
 * Пропуск для метки, о которой код не знал: шаблон потребовал её при рендере. Маркер называет
 * метку как есть: значения выдумывать нельзя, сотрудник заполнит её сам.
 */
export function unknownLabelGap(label: string): TemplateGap {
  const title = titleOf(label);
  return {
    label,
    title,
    marker: gapMarker(title),
    question: `Чему равно «${title}»? (метка есть в шаблоне, значения для неё не было)`,
  };
}

/** Пустая ячейка строки таблицы (нет значения или одни пробелы). */
const isBlankCell = (value: unknown): boolean => String(value ?? '').trim() === '';

/**
 * Подставить маркер `[ЗАПОЛНИТЬ: <поле>]` на место каждой недостающей или неверной метки и
 * пустой ячейки позиции. Пропуск не останавливает сборку: сотрудник получает договор с
 * заметными маркерами и списком, что заполнить до подписания. Для денежных полей маркер, а не
 * ноль. Ключи `templateFields`/`requisites`, которых не бывает (D7), игнорируются с
 * предупреждением (решение владельца 03.11: договор не блокируется). Исходные данные не
 * меняются.
 */
export function fillTemplateGaps(
  templatePath: string,
  data: RenderData,
  input: TemplateFieldsInput,
  templatesPrefix = '',
): GapFilledData {
  const check = checkTemplateFields(templatePath, data, input, templatesPrefix);
  // Лишние ключи модели в документ не попадают (buildRenderData их отбрасывает): сборка идёт
  // дальше, сотрудник получает предупреждение.
  const warnings: ValidationIssue[] =
    check.rejectedKeys.length > 0 || check.rejectedRequisites.length > 0
      ? [warningIssue('unknown_template_keys', describeRejected(check))]
      : [];
  const fields: Record<string, RenderValue> = { ...data.fields };
  const rows = (data.lists[LINES_LIST_NAME] ?? []).map((row) => ({ ...row }));
  const gaps = new Map<string, TemplateGap>();
  const addGap = (label: string, question: string): TemplateGap => {
    const title = titleOf(label);
    const gap = gaps.get(label) ?? { label, title, marker: gapMarker(title), question };
    gaps.set(label, gap);
    return gap;
  };
  for (const item of [...check.missing, ...check.invalid]) {
    const gap = addGap(item.label, item.question);
    if (item.label === LINES_LIST_NAME) {
      // Позиций нет: одна строка из маркеров, иначе шаблон остался бы без строки таблицы.
      const row: Record<string, RenderValue> = {};
      for (const cell of ITEM_CELLS) row[cell] = gapMarker(titleOf(`${ITEM_CELL_PREFIX}${cell}`));
      rows.splice(0, rows.length, row);
      // Суммы нет совсем (ни по строкам, ни от модели): маркер вместо нуля и «00» копеек.
      const rubles = fields['total_rubles'];
      if (rubles === undefined || rubles === 0 || rubles === '') {
        for (const money of MONEY_FROM_LINES_LABELS) fields[money] = gapMarker(titleOf(money));
      }
    } else if (item.label.startsWith(ITEM_CELL_PREFIX)) {
      const cell = item.label.slice(ITEM_CELL_PREFIX.length);
      for (const row of rows) if (isBlankCell(row[cell])) row[cell] = gap.marker;
    } else {
      const variantMarker = VARIANT_GAP_MARKERS[item.label];
      if (variantMarker === undefined) {
        fields[item.label] = gap.marker;
      } else {
        // Маркер в значении варианта не совпал бы ни с одной веткой, и блок исчез бы молча.
        fields[item.label] = VARIANT_UNSET_VALUE;
        fields[`${item.label}${VARIANT_GAP_SUFFIX}`] = variantMarker;
      }
      for (const companion of COMPANION_LABELS[item.label] ?? []) {
        const current = fields[companion];
        if (current === undefined || current === '' || current === 0) {
          // Номер договора в двух метках: маркер один, «основной договор» тут не при чём.
          fields[companion] =
            item.label === 'number' ? gap.marker : gapMarker(titleOf(companion));
        }
      }
    }
  }
  const lists = { ...data.lists, [LINES_LIST_NAME]: rows };
  return { data: { fields, lists }, gaps: [...gaps.values()], warnings };
}

/** Текст предупреждения о недопустимых ключах `templateFields` и `requisites`. */
function describeRejected(check: TemplateFieldsCheck): string {
  const parts: string[] = [];
  if (check.rejectedKeys.length > 0) {
    parts.push(
      `В templateFields есть поля, которых нет у шаблона (не учтены): ` +
        `${check.rejectedKeys.join(', ')}.`,
    );
  }
  if (check.rejectedRequisites.length > 0) {
    parts.push(
      `В requisites есть не реквизиты поставщика (не учтены; допустимы ` +
        `${REQUISITE_FIELDS.join(', ')}): ${check.rejectedRequisites.join(', ')}.`,
    );
  }
  return parts.join('\n');
}
