import {
  DOCUMENT_FLOW_LABELS,
  MATERIAL_KIND_LABELS,
  MATERIAL_KINDS,
  PACKAGING_KIND_LABELS,
  PACKAGING_PRICING_LABELS,
  SUPPLIER_FULL_TEXT_FIELDS,
  SUPPLIER_KIND_LABELS,
  TRAINING_FORMAT_LABELS,
  type SupplierFullParts,
  type SupplierFullTextKey,
  type SupplierTurnoverYear,
} from '../../kit/domain/supplier-card-full';
import {
  DUPLICATE_REASON_LABELS,
  SUPPLIER_STATUS_LABELS,
  type DuplicateMatch,
  type SupplierCard,
  type SupplierContact,
} from '../../kit/domain/supplier-card';
import { REQUISITE_FIELDS, REQUISITE_LABELS } from '../../kit/domain/requisites';
import { VAT_MODE_LABELS } from '../../kit/domain/supplier-card-values';
import { SUPPLIER_REPORT_LIST_LIMIT } from './deps';

/**
 * Показ карточки сотруднику строит код, а не модель. В сообщении сотруднику допустимы полные
 * значения (ИНН, телефон, адрес): это не запрос к модели. Всё, что уходит модели из
 * инструментов, проходит маскирование ниже.
 */

/** Серия из стольких цифр и больше модели не отдаётся (под правило шлюза: ИНН, телефон). */
const MIN_MASKED_DIGIT_RUN = 10;
const DIGIT_RUN = new RegExp(`\\d{${MIN_MASKED_DIGIT_RUN},}`, 'g');
/** Сколько последних цифр видно в маске. */
const VISIBLE_TAIL = 4;
const MASK = '***';

/** Заменить в тексте длинные серии цифр (ИНН, счета, телефоны) на `***` и четыре последние. */
export function maskDigitSeries(text: string): string {
  return text.replace(DIGIT_RUN, (run) => `${MASK}${run.slice(-VISIBLE_TAIL)}`);
}

/** Адрес для модели: первая буква и домен (`i***@example.ru`); без «@» - только маска. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASK;
  return `${email.slice(0, 1)}${MASK}${email.slice(at)}`;
}

/** Телефон для модели: последние четыре цифры (`***4567`). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= VISIBLE_TAIL ? MASK : `${MASK}${digits.slice(-VISIBLE_TAIL)}`;
}

/** Четыре последние цифры ИНН: чтобы сотрудник мог сверить, не раскрывая номер целиком. */
export function innLast4(inn: string): string {
  const digits = inn.replace(/\D/g, '');
  return digits.slice(-VISIBLE_TAIL);
}

function describeContact(contact: SupplierContact, index: number): string {
  const parts = [
    contact.fullName,
    contact.position,
    contact.email,
    contact.phone,
    contact.messenger,
  ].filter((part): part is string => part !== undefined);
  const main = contact.isPrimary ? ' (основной)' : '';
  return `  ${index + 1}. ${parts.join(', ')}${main}`;
}

const YES = 'да';
const NO = 'нет';
const yesNo = (value: boolean | undefined): string | undefined =>
  value === undefined ? undefined : value ? YES : NO;

/** Подпись значения перечисления; нет значения - нет подписи. */
function labelOf<K extends string>(
  labels: Readonly<Record<K, string>>,
  value: K | undefined,
): string | undefined {
  return value === undefined ? undefined : labels[value];
}

const numberText = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

/** Группы по три цифры в сумме (пробелы разбивают серию: маска цифр её не заденет). */
const THOUSANDS_GROUP = /\B(?=(?:\d{3})+(?!\d))/g;

/** Процент для показа: `5%`, `5,5%`. */
const percentText = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : `${String(value).replace('.', ',')}%`;

const MONEY_FRACTION_DIGITS = 2;

/** Сумма в рублях для показа: `150 000 000 руб.`, копейки только если есть. */
function rublesText(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const [whole = '0', fraction] = value.toFixed(MONEY_FRACTION_DIGITS).split('.');
  const kopecks = fraction === undefined || /^0+$/.test(fraction) ? '' : `,${fraction}`;
  return `${whole.replace(THOUSANDS_GROUP, ' ')}${kopecks} руб.`;
}

/** Оборот по годам для показа: `2025 - 150 000 000 руб.; 2024 - 120 000 000 руб.`. */
function turnoverYearsText(years: readonly SupplierTurnoverYear[] | undefined): string | undefined {
  if (years === undefined || years.length === 0) return undefined;
  return years.map((item) => `${item.year} - ${rublesText(item.rub) ?? ''}`).join('; ');
}

/** «Без НДС» с пояснением режима: УСН - самый частый случай. */
const NO_VAT_TEXT = `${VAT_MODE_LABELS.no_vat} (УСН)`;

/** НДС для показа: `с НДС 20%`, `с НДС`, `без НДС`. */
function vatText(card: SupplierFullParts): string | undefined {
  if (card.vatMode === undefined) return undefined;
  const rate = percentText(card.vatRatePercent);
  if (card.vatMode === 'no_vat') return rate === undefined ? NO_VAT_TEXT : `${NO_VAT_TEXT} ${rate}`;
  const label = VAT_MODE_LABELS[card.vatMode];
  return rate === undefined ? label : `${label} ${rate}`;
}

/** Подпись текстового поля полной карточки из доменной таблицы. */
const fullLabel = (key: SupplierFullTextKey): string => SUPPLIER_FULL_TEXT_FIELDS[key].label;

/** Раздел карточки по ТЗ (разд. 10): для компактного вида модели. */
type CardSection =
  | 'company'
  | 'terms'
  | 'delivery'
  | 'documents'
  | 'products'
  | 'location'
  | 'service'
  | 'assessment';

/**
 * Поле карточки для показа: раздел, ключи карточки, из которых оно собрано, подпись и
 * значение (пусто - не выводится). Ключи нужны, чтобы явно решать «показывать модели или нет».
 */
export interface CardFieldEntry {
  section: CardSection;
  keys: readonly (keyof SupplierCard)[];
  label: string;
  value: string | undefined;
}

/**
 * Поля полной карточки (разд. 10.1-10.9 ТЗ) для показа сотруднику, в порядке разделов ТЗ.
 * Значения полные: это сообщение сотруднику, а не запрос к модели. Пустые не выводятся.
 */
function cardFieldEntries(card: SupplierCard): CardFieldEntry[] {
  const samples = [
    yesNo(card.samplesAvailable),
    card.samplesQuantity === undefined ? undefined : `${card.samplesQuantity} шт.`,
    card.samplesTerms,
  ].filter((part): part is string => part !== undefined);
  const packaging = [
    labelOf(PACKAGING_KIND_LABELS, card.packaging),
    labelOf(PACKAGING_PRICING_LABELS, card.packagingPricing),
  ].filter((part): part is string => part !== undefined);
  const materials = (kind: (typeof MATERIAL_KINDS)[number]): string | undefined => {
    const items = (card.materials ?? []).filter((item) => item.kind === kind);
    if (items.length === 0) return undefined;
    return items
      .map((item) => (item.title === undefined ? item.ref : `${item.title}: ${item.ref}`))
      .join('; ');
  };
  const entities = (card.legalEntities ?? [])
    .map((entity) =>
      entity.inn === undefined ? entity.name : `${entity.name} (ИНН ${entity.inn})`,
    )
    .join('; ');
  const training = card.trainingFormats?.map((format) => TRAINING_FORMAT_LABELS[format]).join(', ');
  const entry = (
    section: CardSection,
    keys: readonly (keyof SupplierCard)[],
    label: string,
    value: string | undefined,
  ): CardFieldEntry => ({ section, keys, label, value });
  return [
    // 10.1 О компании (реквизиты юрлица: ИНН выводится отдельной строкой выше)
    ...REQUISITE_FIELDS.filter((key) => key !== 'inn').map((key) =>
      entry('company', [key], `Реквизит: ${REQUISITE_LABELS[key]}`, card[key]),
    ),
    entry('company', ['logoRef'], fullLabel('logoRef'), card.logoRef),
    entry(
      'company',
      ['supplierKind'],
      'Вид поставщика',
      labelOf(SUPPLIER_KIND_LABELS, card.supplierKind),
    ),
    entry('company', ['foundedYear'], 'Год основания', numberText(card.foundedYear)),
    // 10.3 Условия работы
    entry(
      'terms',
      ['agencyDiscountPercent'],
      'Скидка для агентства',
      percentText(card.agencyDiscountPercent),
    ),
    entry('terms', ['minOrderAmount'], fullLabel('minOrderAmount'), card.minOrderAmount),
    entry(
      'terms',
      ['samplesAvailable', 'samplesQuantity', 'samplesTerms'],
      'Бесплатные образцы',
      samples.length === 0 ? undefined : samples.join(', '),
    ),
    entry('terms', ['paymentNotes'], fullLabel('paymentNotes'), card.paymentNotes),
    entry('terms', ['vatMode', 'vatRatePercent'], 'НДС', vatText(card)),
    // 10.4 Доставка
    entry('delivery', ['freeDelivery'], fullLabel('freeDelivery'), card.freeDelivery),
    // 10.5 Документы и договор
    entry(
      'documents',
      ['documentFlow'],
      'Документооборот',
      labelOf(DOCUMENT_FLOW_LABELS, card.documentFlow),
    ),
    entry('documents', ['contractNotes'], fullLabel('contractNotes'), card.contractNotes),
    entry(
      'documents',
      ['legalEntities'],
      'Юридические лица',
      entities === '' ? undefined : entities,
    ),
    // 10.6 О продукции
    entry(
      'products',
      ['packaging', 'packagingPricing'],
      'Упаковка',
      packaging.length === 0 ? undefined : packaging.join(', '),
    ),
    entry('products', ['technologies'], 'Технологии производства', card.technologies?.join(', ')),
    entry(
      'products',
      ['personalizationTypes'],
      'Виды персонификации',
      card.personalizationTypes?.join(', '),
    ),
    entry(
      'products',
      ['materials'],
      `Презентации (${MATERIAL_KIND_LABELS.presentation})`,
      materials('presentation'),
    ),
    entry(
      'products',
      ['materials'],
      `Портфолио (${MATERIAL_KIND_LABELS.portfolio})`,
      materials('portfolio'),
    ),
    entry(
      'products',
      ['technicalRequirements'],
      fullLabel('technicalRequirements'),
      card.technicalRequirements,
    ),
    entry(
      'products',
      ['pragmatikaPortfolio'],
      fullLabel('pragmatikaPortfolio'),
      card.pragmatikaPortfolio,
    ),
    // 10.7 Расположение
    entry('location', ['transportInfo'], fullLabel('transportInfo'), card.transportInfo),
    // 10.8 Сервис
    entry('service', ['marketingSupport'], fullLabel('marketingSupport'), card.marketingSupport),
    entry('service', ['trainingFormats'], 'Обучение менеджеров', training),
    entry('service', ['exclusivity'], fullLabel('exclusivity'), card.exclusivity),
    entry('service', ['hasOwnDesigners'], 'Собственные дизайнеры', yesNo(card.hasOwnDesigners)),
    entry('service', ['designServices'], fullLabel('designServices'), card.designServices),
    entry(
      'service',
      ['hasQualityControl'],
      'Отдел контроля качества',
      yesNo(card.hasQualityControl),
    ),
    entry(
      'service',
      ['additionalServices'],
      fullLabel('additionalServices'),
      card.additionalServices,
    ),
    // 10.9 Оценка поставщика
    entry('assessment', ['claimsHandling'], fullLabel('claimsHandling'), card.claimsHandling),
    entry(
      'assessment',
      ['competitiveAdvantages'],
      fullLabel('competitiveAdvantages'),
      card.competitiveAdvantages,
    ),
    entry('assessment', ['customers'], fullLabel('customers'), card.customers),
    entry(
      'assessment',
      ['turnoverByYear'],
      'Оборот по годам',
      turnoverYearsText(card.turnoverByYear),
    ),
    entry('assessment', ['turnoverRub'], 'Оборот', rublesText(card.turnoverRub)),
    entry('assessment', ['okved'], 'Основной ОКВЭД', card.okved),
    entry(
      'assessment',
      ['employeeCount'],
      'Численность сотрудников',
      numberText(card.employeeCount),
    ),
  ];
}

/** Поля расположения и оценки, которые карточка хранила до полной (10.7 и 10.9). */
function assessmentEntries(card: SupplierCard): CardFieldEntry[] {
  return [
    {
      section: 'location',
      keys: ['productionCity'],
      label: 'Город производства',
      value: card.productionCity,
    },
    {
      section: 'location',
      keys: ['address'],
      label: 'Адрес склада и производства',
      value: card.address,
    },
    { section: 'assessment', keys: ['strengths'], label: 'Сильные стороны', value: card.strengths },
    {
      section: 'assessment',
      keys: ['weaknesses'],
      label: 'Слабые стороны',
      value: card.weaknesses,
    },
    {
      section: 'assessment',
      keys: ['defectRatePercent'],
      label: 'Процент брака',
      value: card.defectRatePercent === undefined ? undefined : `${card.defectRatePercent}%`,
    },
  ];
}

/** Строки «подпись: значение» только для заполненных полей. */
function entryLines(entries: readonly CardFieldEntry[]): string[] {
  return entries.flatMap((item) =>
    item.value === undefined || item.value === '' ? [] : [`${item.label}: ${item.value}`],
  );
}

/** Значение «не указано» для обязательных строк показа. */
const NOT_SET = 'не указано';

/**
 * Карточка «как будет сохранена»: текст показа. `header` - первая строка (что делаем).
 * Пустые разделы не выводятся, кроме названия.
 */
export function describeSupplierCard(card: SupplierCard, header: string): string {
  const lines: string[] = [header, `Название: ${card.name === '' ? NOT_SET : card.name}`];
  if (card.inn !== undefined) lines.push(`ИНН: ${card.inn}`);
  if (card.website !== undefined) lines.push(`Сайт: ${card.website}`);
  lines.push(`Тип поставщика: ${SUPPLIER_STATUS_LABELS[card.status]}`);
  if (card.contacts.length > 0) {
    lines.push('Контакты:', ...card.contacts.map(describeContact));
  }
  const lists: Array<[string, string[]]> = [
    ['Категории', card.supplies.categories],
    ['Бренды', card.supplies.brands],
    ['Регионы', card.supplies.regions],
  ];
  for (const [label, values] of lists) {
    if (values.length > 0) lines.push(`${label}: ${values.join(', ')}`);
  }
  const terms: Array<[string, string | undefined]> = [
    ['Оплата', card.terms.payment],
    ['Доставка', card.terms.delivery],
    ['Минимальная партия', card.terms.minBatch],
    ['Сроки', card.terms.leadTime],
    ['Дополнительная скидка (условия)', card.terms.discounts],
  ];
  for (const [label, value] of terms) {
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  lines.push(...entryLines(assessmentEntries(card)));
  lines.push(...entryLines(cardFieldEntries(card)));
  const lastNote = card.notes.at(-1);
  if (lastNote !== undefined) lines.push(`Заметка: ${lastNote.text}`);
  return lines.join('\n');
}

/** Причины совпадения словами: «совпадает ИНН, совпадает email». */
function reasonsText(match: DuplicateMatch): string {
  return match.reasons.map((reason) => DUPLICATE_REASON_LABELS[reason]).join(', ');
}

/** Найденные дубли: «похоже на существующего: «Название» (совпадает ИНН)». Пусто - ''. */
export function describeDuplicates(matches: readonly DuplicateMatch[]): string {
  if (matches.length === 0) return '';
  const shown = matches.slice(0, SUPPLIER_REPORT_LIST_LIMIT);
  const lines = shown.map(
    (match) => `Похоже на существующего: «${match.name}» (${reasonsText(match)})`,
  );
  const rest = matches.length - shown.length;
  if (rest > 0) lines.push(`И ещё похожих: ${rest}.`);
  return lines.join('\n');
}

/** Разделы компактного вида карточки для модели: порядок и заголовки (разд. 10 ТЗ). */
const MODEL_SECTION_TITLES: ReadonlyArray<readonly [CardSection, string]> = [
  ['company', '10.1 О компании'],
  ['terms', '10.3 Условия работы'],
  ['delivery', '10.4 Доставка'],
  ['documents', '10.5 Документы и договор'],
  ['products', '10.6 О продукции'],
  ['location', '10.7 Расположение'],
  ['service', '10.8 Сервис'],
  ['assessment', '10.9 Оценка'],
];

/**
 * Поля, которые модели НЕ отдаются: логотип и материалы - ссылки на файлы базы знаний
 * (презентации и портфолио как вложения), смысла для работы агента они не несут; реквизиты
 * юрлица (КПП, ОГРН, юридический адрес, банк, БИК, счета, подписант) модели для разбора
 * не нужны, документ из них собирает код (`prepareSupplierDocument` читает базу сам).
 * Названия юрлиц и маскированный ИНН (разд. 10.5) остаются. Любое другое поле карточки
 * показывается; решение «показать или исключить» принимается здесь явно, а тест полноты
 * ломается на новом поле без решения.
 */
export const MODEL_EXCLUDED_CARD_KEYS = [
  'logoRef',
  'materials',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
] as const;
const MODEL_EXCLUDED: ReadonlySet<string> = new Set(MODEL_EXCLUDED_CARD_KEYS);

/** Предел длины компактного вида карточки для модели, символов (с запасом на длинные поля). */
export const MODEL_CARD_DETAILS_MAX_CHARS = 6000;
/** Пометка, что вид обрезан по пределу длины. */
const MODEL_CARD_TRUNCATED = '... (остальное не показано)';

/** Поля карточки (кроме исключённых), которые видит модель, по разделам. */
export function modelVisibleEntries(card: SupplierCard): CardFieldEntry[] {
  return [...assessmentEntries(card), ...cardFieldEntries(card)].filter(
    (item) => !item.keys.some((key) => MODEL_EXCLUDED.has(key)),
  );
}

/**
 * Компактный текст карточки для модели по разделам ТЗ: пустые поля не печатаются, длинные
 * серии цифр (ИНН юрлиц, счета, ОГРН) маскируются так же, как остальная выдача инструмента.
 * Контакты сюда не входят: они идут отдельным маскированным полем.
 */
export function describeCardForModel(card: SupplierCard): string {
  const visible = modelVisibleEntries(card);
  const lines: string[] = [];
  for (const [section, title] of MODEL_SECTION_TITLES) {
    const sectionLines = entryLines(visible.filter((item) => item.section === section));
    if (sectionLines.length === 0) continue;
    lines.push(`${title}:`, ...sectionLines.map((line) => `  ${maskDigitSeries(line)}`));
  }
  const text = lines.join('\n');
  if (text.length <= MODEL_CARD_DETAILS_MAX_CHARS) return text;
  // Обрезка по границе строки: половина значения модели только вредит.
  const head = text.slice(0, MODEL_CARD_DETAILS_MAX_CHARS);
  const lineEnd = head.lastIndexOf('\n');
  return `${lineEnd > 0 ? head.slice(0, lineEnd) : head}\n${MODEL_CARD_TRUNCATED}`;
}
