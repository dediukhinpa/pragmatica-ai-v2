import {
  GENERAL_GROUP,
  ORDER_GROUP,
  TASK_LINK_FIELD_KEY,
  getRequestForm,
  type RequestKind,
} from './request-forms';
import type { SupplierCard } from './supplier-card';

/**
 * Шаблон письма-запроса поставщику (ТЗ заказчика, раздел 5). Шаблон - данные: подписи и
 * формулировки взяты из ТЗ дословно. Агент письма не отправляет: код собирает текст, сотрудник
 * отправляет его сам. Вопросы, ответы на которые уже есть в карточке поставщика, из текста
 * убираются ("не задаём поставщику вопросы, ответы на которые мы и так знаем").
 */

/** Приветствие и вводная строка письма. */
const SUPPLIER_REQUEST_GREETING = 'Добрый день.';
const SUPPLIER_REQUEST_INTRO = 'Прошу рассчитать:';

/**
 * Общая фраза вместо перечня пропущенных полей. Отступление от ТЗ (разд. 5) по решению
 * владельца 02.11: пустые места `_____` в письме поставщику выглядят как брак, поэтому поля без
 * значения не выводятся, а письмо честно говорит, что остальное будет уточнено позже.
 */
export const SUPPLIER_REQUEST_REST_LINE =
  'Остальные характеристики и условия уточню дополнительно, если потребуется.';

/** Поля шаблона в порядке ТЗ: идентификатор (латиница) и подпись дословно. */
export const SUPPLIER_REQUEST_FIELDS = [
  { id: 'product', label: 'Продукция' },
  { id: 'desired_term', label: 'Желаемый срок изготовления' },
  { id: 'launch_date', label: 'Дата запуска в работу' },
  { id: 'budget', label: 'Бюджет, руб\\шт' },
  { id: 'quantity', label: 'Тираж, шт' },
  { id: 'dimensions', label: 'Габарит изделия, см х см х см' },
  { id: 'color', label: 'Цвет изделия (возможные варианты)' },
  { id: 'material', label: 'Материал изделия' },
  { id: 'personalization_tech', label: 'Технология персонификации' },
  { id: 'personalization_size', label: 'Размер персонификации (изображения), см' },
  { id: 'personalization_colors', label: 'Количество цветов персонификации' },
  { id: 'sample', label: 'Нужен ли образец (без персонификации), да\\нет' },
  {
    id: 'extra',
    label: 'Дополнительные характеристики продукции и условий поставки (референсы)',
  },
] as const;

/** Идентификатор поля шаблона. */
export type SupplierRequestFieldId = (typeof SUPPLIER_REQUEST_FIELDS)[number]['id'];

/**
 * Идентификаторы, которые могут быть известны по карточке поставщика: поля шаблона и два
 * вопроса, не являющихся полями (уточнение НДС в строке о цене и строка о сроках).
 */
export type SupplierRequestKnownId = SupplierRequestFieldId | 'vat' | 'terms';

/** Строка о цене и её уточнение про налогообложение (ТЗ дословно). */
const SUPPLIER_REQUEST_PRICE_LINE = 'Интересует ваша цена за штуку и за весь тираж';
const SUPPLIER_REQUEST_VAT_CLARIFICATION = '(уточните сразу с НДС / без НДС / УСН)';
/** Строка о сроках (ТЗ дословно). */
const SUPPLIER_REQUEST_TERMS_LINE = 'Сроки с учетом ориентиров по запуску заказа';

/** Подписи для сообщений сотруднику о том, что убрано из-за карточки. */
const SUPPLIER_REQUEST_VAT_LABEL = 'Уточнение НДС / без НДС / УСН';
const SUPPLIER_REQUEST_TERMS_LABEL = 'Сроки с учетом ориентиров по запуску заказа';

/** Значения полей шаблона: идентификатор -> непустая строка. */
export type SupplierRequestValues = Readonly<Partial<Record<SupplierRequestFieldId, string>>>;

/** Поле шаблона для сообщений: идентификатор и подпись. */
export interface SupplierRequestFieldRef {
  id: SupplierRequestKnownId;
  label: string;
}

/** Результат сборки текста запроса. */
export interface RenderedSupplierRequest {
  /** Готовый текст письма по шаблону ТЗ (без метки заявки: её добавляет вызывающий). */
  text: string;
  /** Что убрано из текста, потому что это уже известно по карточке поставщика. */
  omitted: SupplierRequestFieldRef[];
  /** Поля без значения: в письмо не вошли, сотрудник сам решает, дописывать ли их. */
  blank: SupplierRequestFieldRef[];
}

const WHITESPACE = /\s+/g;

/** Значение в одну строку: переносы и пробелы сводятся к одному пробелу. */
function singleLine(value: string | undefined): string {
  return (value ?? '').replace(WHITESPACE, ' ').trim();
}

/**
 * Собрать текст запроса по шаблону ТЗ. Поле без значения в текст не выводится ни при каком
 * `known`: если оно известно по карточке - оно в `omitted`, иначе в `blank` (и тогда в конце
 * письма появляется общая фраза `SUPPLIER_REQUEST_REST_LINE`). Поле со значением остаётся
 * в тексте всегда: это сведения о нашем заказе, а не вопрос поставщику. Известное
 * уточнение НДС и строка о сроках убираются. Значения не выдумываются и не меняются (кроме
 * сведения к одной строке).
 */
export function renderSupplierRequest(input: {
  values: SupplierRequestValues;
  known: ReadonlySet<SupplierRequestKnownId>;
}): RenderedSupplierRequest {
  const lines: string[] = [SUPPLIER_REQUEST_GREETING, '', SUPPLIER_REQUEST_INTRO, ''];
  const FIELDS_START_LENGTH = lines.length;
  const omitted: SupplierRequestFieldRef[] = [];
  const blank: SupplierRequestFieldRef[] = [];
  for (const field of SUPPLIER_REQUEST_FIELDS) {
    const value = singleLine(input.values[field.id]);
    if (value !== '') {
      lines.push(`${field.label}: ${value}`);
    } else if (input.known.has(field.id)) {
      omitted.push({ id: field.id, label: field.label });
    } else {
      blank.push({ id: field.id, label: field.label });
    }
  }
  // Ни одной строки поля: пустая строка после вводной уже есть, второй подряд не нужно.
  if (lines.length > FIELDS_START_LENGTH) lines.push('');
  if (input.known.has('vat')) {
    lines.push(SUPPLIER_REQUEST_PRICE_LINE);
    omitted.push({ id: 'vat', label: SUPPLIER_REQUEST_VAT_LABEL });
  } else {
    lines.push(`${SUPPLIER_REQUEST_PRICE_LINE} ${SUPPLIER_REQUEST_VAT_CLARIFICATION}`);
  }
  if (input.known.has('terms')) {
    omitted.push({ id: 'terms', label: SUPPLIER_REQUEST_TERMS_LABEL });
  } else {
    lines.push('', SUPPLIER_REQUEST_TERMS_LINE);
  }
  if (blank.length > 0) lines.push('', SUPPLIER_REQUEST_REST_LINE);
  return { text: lines.join('\n'), omitted, blank };
}

/**
 * Соответствие полей шаблона ключам форм запроса (раздел 11 ТЗ): для каждого вида запроса -
 * какие ключи формы дают значение поля шаблона. Несколько ключей соединяются через «; ».
 * Одно значение может попасть в два поля шаблона, если форма объединяет их в одно
 * («материал и цвет», «технология и количество цветов»). Поля формы без пары в шаблоне
 * (цветопроба, фурнитура, постпечатные работы и т. п.) идут в «Дополнительные характеристики».
 * Размер персонализации в миллиметрах (11.3) в поле «см» не кладётся: единицы не пересчитываем.
 */
export const FORM_TO_TEMPLATE: Readonly<
  Record<RequestKind, Readonly<Partial<Record<SupplierRequestFieldId, readonly string[]>>>>
> = {
  custom_product: {
    product: ['product'],
    desired_term: ['production_date'],
    budget: ['budget'],
    quantity: ['quantity'],
    dimensions: ['dimensions'],
    color: ['material_color'],
    material: ['material_color'],
    personalization_tech: ['personalization_tech'],
    personalization_colors: ['personalization_tech'],
    personalization_size: ['personalization_size'],
    sample: ['sample'],
  },
  apparel: {
    product: ['item_name'],
    desired_term: ['ready_date'],
    launch_date: ['launch_date'],
    quantity: ['quantity'],
    color: ['color'],
    material: ['material'],
    personalization_tech: ['application_method'],
  },
  personalization: {
    product: ['product'],
    quantity: ['quantity'],
    personalization_tech: ['tech_colors'],
    personalization_colors: ['tech_colors'],
    sample: ['sample'],
  },
  print_leaflet: {
    product: ['name'],
    desired_term: ['ready_date'],
    launch_date: ['launch_date'],
    quantity: ['quantity'],
    dimensions: ['size'],
    material: ['material'],
  },
  print_bag: {
    desired_term: ['ready_date'],
    launch_date: ['launch_date'],
    quantity: ['quantity'],
    dimensions: ['size'],
    material: ['material'],
  },
  print_multipage: {
    product: ['name'],
    desired_term: ['ready_date'],
    launch_date: ['launch_date'],
    quantity: ['quantity'],
  },
  print_wall_calendar: {
    desired_term: ['ready_date'],
    launch_date: ['launch_date'],
    quantity: ['quantity'],
  },
  print_desk_calendar: {
    desired_term: ['ready_date'],
    launch_date: ['launch_date'],
    quantity: ['quantity'],
    dimensions: ['finished_size'],
  },
  other: {
    product: ['product'],
    desired_term: ['deadline'],
    quantity: ['quantity'],
  },
};

/** Текст поля, ответ на которое сотрудник отложил. */
export const SUPPLIER_REQUEST_DEFERRED = 'уточним позже';

/** Разделитель нескольких значений одного поля шаблона и пунктов «дополнительных». */
const VALUES_SEPARATOR = '; ';

/** Группы формы, которые в подписи дополнительной характеристики не повторяются. */
const GENERIC_GROUPS: ReadonlySet<string> = new Set([ORDER_GROUP, GENERAL_GROUP]);

/**
 * Значения полей шаблона из сохранённых характеристик заказа (ключи формы вида `kind`).
 * Пустые значения пропускаются. «Дополнительные характеристики» собираются из заполненных
 * полей формы, у которых нет пары в шаблоне: «подпись: значение», в порядке формы.
 */
export function templateValuesFromForm(
  kind: RequestKind,
  formValues: Readonly<Record<string, string>>,
  deferred: readonly string[] = [],
): SupplierRequestValues {
  const postponed = new Set(deferred);
  const mapping = FORM_TO_TEMPLATE[kind];
  const result: Partial<Record<SupplierRequestFieldId, string>> = {};
  const used = new Set<string>();
  for (const field of SUPPLIER_REQUEST_FIELDS) {
    const keys = mapping[field.id] ?? [];
    for (const key of keys) used.add(key);
    const parts = keys.map((key) => singleLine(formValues[key])).filter((part) => part !== '');
    if (parts.length > 0) {
      result[field.id] = parts.join(VALUES_SEPARATOR);
    } else if (keys.some((key) => postponed.has(key))) {
      // Сотрудник сказал «позже»: поставщику честно пишем, что уточним, а не оставляем пропуск.
      result[field.id] = SUPPLIER_REQUEST_DEFERRED;
    }
  }
  const extras: string[] = [];
  for (const field of getRequestForm(kind).fields) {
    const value = singleLine(formValues[field.key]);
    // Ссылка на задачу - внутренний адрес портала, поставщику она не нужна и не уходит.
    if (used.has(field.key) || field.key === TASK_LINK_FIELD_KEY) continue;
    const shown = value !== '' ? value : postponed.has(field.key) ? SUPPLIER_REQUEST_DEFERRED : '';
    if (shown === '') continue;
    const prefix = GENERIC_GROUPS.has(field.group) ? '' : `${field.group}, `;
    extras.push(`${prefix}${field.label}: ${shown}`);
  }
  if (extras.length > 0) result.extra = extras.join(VALUES_SEPARATOR);
  return result;
}

/** Правило «вопрос шаблона уже закрыт полем карточки». */
export interface KnownFromCardRule {
  /** Какой вопрос шаблона убирается. */
  id: SupplierRequestKnownId;
  /** Структурные поля карточки, по которым вопрос считается закрытым (для документации). */
  cardFields: readonly string[];
  /** Заполнено ли поле карточки так, что отвечать поставщику уже нечего. */
  isFilled: (card: SupplierCard) => boolean;
}

const hasText = (value: string | undefined): boolean => (value ?? '').trim() !== '';

/**
 * Явная таблица «вопрос шаблона -> поле карточки». Только структурные поля, текст заметок и
 * условий на поиск слов не разбирается. Пустое поле вопрос не убирает.
 * - Уточнение НДС в строке о цене закрыто, если задан режим НДС или ставка (разд. 10.3).
 * - Пустая «Технология персонификации» закрыта, если у поставщика перечислены виды
 *   персонификации (10.6).
 * - Строка «Сроки с учетом ориентиров по запуску заказа» - вопрос о сроках поставщика;
 *   закрыта, если в условиях карточки указан срок (`terms.leadTime`).
 */
export const KNOWN_FROM_CARD_RULES: readonly KnownFromCardRule[] = [
  {
    id: 'vat',
    cardFields: ['vatMode', 'vatRatePercent'],
    isFilled: (card) => card.vatMode !== undefined || card.vatRatePercent !== undefined,
  },
  {
    id: 'personalization_tech',
    cardFields: ['personalizationTypes'],
    isFilled: (card) => (card.personalizationTypes ?? []).some(hasText),
  },
  {
    id: 'terms',
    cardFields: ['terms.leadTime'],
    isFilled: (card) => hasText(card.terms.leadTime),
  },
];

/**
 * Вопросы и поля шаблона, которые карточка не убирает никогда, с причиной. Вместе с
 * `KNOWN_FROM_CARD_RULES` покрывают все идентификаторы шаблона (проверяет тест).
 */
export const NEVER_KNOWN_FROM_CARD: ReadonlyArray<{
  id: SupplierRequestKnownId;
  reason: string;
}> = [
  { id: 'product', reason: 'сведения о нашем заказе' },
  {
    id: 'desired_term',
    reason: 'наша потребность: срок производства поставщика в карточке - его условие',
  },
  { id: 'launch_date', reason: 'наша потребность' },
  { id: 'budget', reason: 'наша потребность' },
  { id: 'quantity', reason: 'наш тираж; минимальная партия поставщика - его условие, не вопрос' },
  { id: 'dimensions', reason: 'сведения о нашем заказе' },
  { id: 'color', reason: 'сведения о нашем заказе' },
  { id: 'material', reason: 'материал изделия не равен технологиям производства поставщика' },
  { id: 'personalization_size', reason: 'сведения о нашем заказе' },
  { id: 'personalization_colors', reason: 'сведения о нашем заказе' },
  {
    id: 'sample',
    reason: 'наша потребность на этот заказ; условия образцов поставщика вопросом не являются',
  },
  { id: 'extra', reason: 'сведения о нашем заказе' },
];

/**
 * Что поставщик уже раскрыл в карточке и о чём в запросе не спрашиваем: по таблице
 * `KNOWN_FROM_CARD_RULES`, только по структурным полям. Поля о НАШЕЙ потребности
 * («Желаемый срок изготовления», «Дата запуска в работу», «Нужен ли образец») не убираются.
 */
export function knownFieldsFromCard(card: SupplierCard): ReadonlySet<SupplierRequestKnownId> {
  return new Set(KNOWN_FROM_CARD_RULES.filter((rule) => rule.isFilled(card)).map((r) => r.id));
}
