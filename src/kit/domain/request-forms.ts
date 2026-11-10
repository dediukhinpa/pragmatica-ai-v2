import { z } from 'zod';

/**
 * Эталонные формы запросов для поиска поставщиков (ТЗ заказчика, раздел 11) и проверка
 * запроса сотрудника на полноту (раздел 2). Формы - данные, а не текст промпта: подписи полей
 * взяты из ТЗ дословно, по ним код строит вопрос сотруднику и описание для модели.
 */

/** Виды запроса: 11.1, 11.2, 11.3 и подвиды полиграфии 11.4. */
export const REQUEST_KINDS = [
  'custom_product',
  'apparel',
  'personalization',
  'print_leaflet',
  'print_bag',
  'print_multipage',
  'print_wall_calendar',
  'print_desk_calendar',
  // Заявка вне форм 11.1-11.4: мягкая проверка (что нужно, тираж, срок), см. OTHER_REQUEST_KIND.
  'other',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const requestKindSchema = z.enum(REQUEST_KINDS);

/** Вид «прочее»: заявка, не подходящая ни под одну из форм 11.1-11.4. */
export const OTHER_REQUEST_KIND = 'other' satisfies RequestKind;
/** Раздел формы «прочее»: в ТЗ её нет, поэтому не номер, а пометка. */
const OTHER_SECTION = 'вне 11.1–11.4';

/** Предел длины значения одного поля формы (символов): значение хранится в состоянии заявки. */
export const REQUEST_VALUE_MAX_CHARS = 500;

/** Вопрос сотруднику: формулировка из раздела 2 ТЗ. */
export const COMPLETENESS_QUESTION_INTRO =
  'Не хочешь ли ты например дополнить по заказу определенные сведения для более точного ' +
  'поиска, так как их не хватает?';
/** Что можно ответить на вопрос: частично, полностью или отказаться. */
const COMPLETENESS_QUESTION_OUTRO =
  'Можно ответить на часть пунктов. Если пункт не нужен, так и напиши («нет»). Если не ' +
  'хочешь дополнять, скажи об этом: поиск пойдёт по тому, что есть.';

/** Группа для форм, у которых в ТЗ нет собственных подзаголовков (11.1 и 11.3). */
export const ORDER_GROUP = 'Сведения о заказе';
export const GENERAL_GROUP = 'Общие сведения';
/** Группа ссылки на задачу: её добавляет каждая форма (уточнение заказчика к разделу 11). */
export const TASK_GROUP = 'Задача';
/** Ключ поля ссылки на задачу сотрудника в Bitrix24. */
export const TASK_LINK_FIELD_KEY = 'task_link';
const TASK_LINK_LABEL = 'Ссылка на задачу в Bitrix24';
/** Вопрос, когда сотрудник отказался дополнять, а обязательного поля всё ещё нет. */
const MANDATORY_QUESTION_INTRO = 'Без этих сведений поиск поставщиков не начнётся:';
const MANDATORY_QUESTION_OUTRO = 'Пришли их, пожалуйста, одним сообщением.';

/** Поле формы. */
const requestFieldSchema = z
  .object({
    /** Ключ поля (латиница): им модель передаёт значение, он уникален в пределах формы. */
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Подпись из ТЗ дословно. */
    label: z.string().min(1),
    /** Группа (подзаголовок ТЗ): общие сведения, обложка, блок и т. п. */
    group: z.string().min(1),
    /** Поле запрашивается, если его нет. Необязательное поле недостающим не считается. */
    required: z.boolean(),
    /** Варианты ответа, которые перечисляет ТЗ (например, информация на ярлыке). */
    options: z.array(z.string().min(1)).min(1).optional(),
    /** К полю прикладывается справка «Бумага для стандартных запросов». */
    paper: z.boolean().optional(),
    /**
     * Поля с одинаковой меткой взаимозаменяемы: требование выполнено, если заполнено любое
     * из них (готовые или индивидуальные сетки календаря).
     */
    alternativeGroup: z.string().min(1).optional(),
    /**
     * Отказ сотрудника дополнять запрос это поле не снимает: без него поиск не начинается.
     * Заказчик потребовал так для ссылки на задачу (уточнение к разделу 11 ТЗ, 22.10.2026).
     */
    mandatory: z.boolean().optional(),
  })
  .strict();
type RequestField = z.infer<typeof requestFieldSchema>;

/** Строка справки «Бумага для стандартных запросов»: вид изделия -> рекомендация. */
const paperGuideEntrySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Вид изделия, как в ТЗ. */
    product: z.string().min(1),
    /** Рекомендация текстом, как в ТЗ. */
    recommendation: z.string().min(1),
  })
  .strict();
export type PaperGuideEntry = z.infer<typeof paperGuideEntrySchema>;

/** Форма запроса одного вида. */
export const requestFormSchema = z
  .object({
    kind: requestKindSchema,
    /** Номер раздела ТЗ. */
    section: z.string().min(1),
    title: z.string().min(1),
    /** Пояснение из ТЗ, какие изделия относятся к виду. */
    description: z.string().min(1).optional(),
    fields: z.array(requestFieldSchema).min(1),
    /** Ключи строк справки по бумаге, относящихся к виду; пусто - бумага не при чём. */
    paperGuide: z.array(z.string().min(1)),
  })
  .strict();
export type RequestForm = z.infer<typeof requestFormSchema>;

/** Справка «Бумага для стандартных запросов» (ТЗ, конец раздела 11.4). */
const PAPER_GUIDE_RAW: PaperGuideEntry[] = [
  {
    key: 'shuber',
    product: 'Шубер',
    recommendation: 'мелованная матовая или глянцевая бумага, 300 г/м²',
  },
  {
    key: 'postcard',
    product: 'Открытка',
    recommendation:
      'мелованная матовая или глянцевая бумага либо картон двустороннего мелования, 300 г/м²',
  },
  {
    key: 'watch_insert',
    product: 'Полиграфическая вставка в часы',
    recommendation: 'картон одностороннего мелования, 300 г/м²',
  },
  {
    key: 'leaflet',
    product: 'Листовка, лифлет / буклет',
    recommendation: 'мелованная матовая или глянцевая бумага, 130–150 г/м²',
  },
  {
    key: 'stickers',
    product: 'Наклейки',
    recommendation: 'самоклеящаяся бумага, прозрачная или белая плёнка. Плотность не указана',
  },
  {
    key: 'paper_bag',
    product: 'Бумажный пакет',
    recommendation:
      'мелованная бумага с обязательной ламинацией, 170–250 г/м²; рекомендуется не более ' +
      '200 г/м²',
  },
  {
    key: 'notebook',
    product: 'Блокнот',
    recommendation:
      'обложка и подложка — картон одностороннего мелования, 300 г/м²; блок — ВХИ, ' +
      '«офсетка», 80 г/м²',
  },
  {
    key: 'brochure',
    product: 'Брошюра',
    recommendation:
      'обложка — мелованная глянцевая или матовая бумага, 200–300 г/м²; блок — мелованная ' +
      'глянцевая или матовая бумага, 130–150 г/м²',
  },
  {
    key: 'cube_block',
    product: 'Куб-блоки',
    recommendation: 'ВХИ, «офсетка», 80 г/м²',
  },
  {
    key: 'wall_calendar',
    product: 'Квартальный календарь',
    recommendation:
      'шапка / ТОП и подложки — картон одностороннего мелования, 300 г/м²; индивидуальные ' +
      'сетки — мелованная матовая или глянцевая бумага, 150–170 г/м²; готовые сетки — ВХИ ' +
      'или мелованная бумага',
  },
  {
    key: 'desk_calendar',
    product: 'Настольный календарь «Домик»',
    recommendation:
      'основание — картон одностороннего мелования, 300 г/м²; блок — мелованная матовая или ' +
      'глянцевая бумага, 150 г/м², либо ВХИ, 80 г/м²',
  },
];

export const PAPER_GUIDE: readonly PaperGuideEntry[] = z
  .array(paperGuideEntrySchema)
  .parse(PAPER_GUIDE_RAW);

/** Поле, запрашиваемое по умолчанию (по ТЗ все перечисленные поля запрашиваются). */
function field(
  group: string,
  key: string,
  label: string,
  extra: Partial<Omit<RequestField, 'key' | 'label' | 'group'>> = {},
): RequestField {
  return { key, label, group, required: true, ...extra };
}

/** Даты запуска и готовности: общие сведения всех форм полиграфии (ТЗ 11.4). */
const PRINT_GENERAL: RequestField[] = [
  field(GENERAL_GROUP, 'launch_date', 'Дата запуска'),
  field(GENERAL_GROUP, 'ready_date', 'Дата готовности'),
];

const PRINT_TITLE = 'Заявка на расчёт печати полиграфической продукции';
const LAMINATION_OPTIONS = 'Дополнительные опции: ламинация с одной или двух сторон, УФ-лак';
const EXTRA_OPTIONS_TAIL = ', тиснение и т. п.';
const PRINT_COLORS = 'Печать: цветность / пантон';
const PAPER_KIND_DENSITY = 'Материал: вид и плотность бумаги';
const PAPER_KIND_DENSITY_FINISH = 'Материал: вид, плотность бумаги, матовая или глянцевая';

/** Группа «материал, печать, опции» обложки, подложки и подобных частей изделия. */
function partFields(
  group: string,
  prefix: string,
  material: string,
  options: string,
  withSize: boolean,
): RequestField[] {
  return [
    ...(withSize ? [field(group, `${prefix}_size`, 'Размер')] : []),
    field(group, `${prefix}_material`, material, { paper: true }),
    field(group, `${prefix}_print`, PRINT_COLORS),
    field(group, `${prefix}_options`, options),
  ];
}

const REQUEST_FORMS_RAW: RequestForm[] = [
  {
    kind: 'custom_product',
    section: '11.1',
    title:
      'Запрос на расчёт нестандартной контрактной продукции или готовой продукции от ' +
      'неосновных поставщиков',
    fields: [
      field(ORDER_GROUP, 'product', 'Продукция'),
      field(ORDER_GROUP, 'quantity', 'Тираж, шт.'),
      field(ORDER_GROUP, 'production_date', 'Дата изготовления'),
      field(ORDER_GROUP, 'budget', 'Бюджет, руб./шт.'),
      field(ORDER_GROUP, 'dimensions', 'Габариты изделия, см'),
      field(ORDER_GROUP, 'material_color', 'Материал и цвет изделия — возможные варианты'),
      field(ORDER_GROUP, 'personalization_tech', 'Технология и количество цветов персонализации'),
      field(ORDER_GROUP, 'personalization_size', 'Размер персонализации — изображения, см'),
      field(ORDER_GROUP, 'sample', 'Образец: да/нет'),
    ],
    paperGuide: [],
  },
  {
    kind: 'apparel',
    section: '11.2',
    title: 'Заявка на расчёт стоимости отшива корпоративной одежды',
    fields: [
      field(GENERAL_GROUP, 'quantity', 'Тираж'),
      field(GENERAL_GROUP, 'launch_date', 'Дата запуска'),
      field(GENERAL_GROUP, 'ready_date', 'Дата готовности'),
      field('Параметры изделия', 'item_name', 'Наименование изделия'),
      field('Параметры изделия', 'material', 'Материал'),
      field('Параметры изделия', 'color', 'Цвет'),
      field('Параметры изделия', 'application_method', 'Способ нанесения'),
      field('Параметры изделия', 'color_proof', 'Цветопроба: да/нет'),
      field('Параметры изделия', 'fittings', 'Фурнитура'),
      field('Параметры изделия', 'lining', 'Подклад'),
      field('Параметры изделия', 'label_info', 'Информация на ярлыке', {
        options: [
          'только размер',
          'размер с логотипом производителя',
          'размер с логотипом заказчика',
        ],
      }),
      field('Параметры изделия', 'sizes', 'Размеры: стандартные или больше 58–60'),
    ],
    paperGuide: [],
  },
  {
    kind: 'personalization',
    section: '11.3',
    title: 'Запрос на расчёт стоимости персонализации готовой сувенирной продукции',
    fields: [
      field(ORDER_GROUP, 'product', 'Продукция: артикул, поставщик, ссылка'),
      field(ORDER_GROUP, 'quantity', 'Тираж, шт.'),
      field(ORDER_GROUP, 'tech_colors', 'Технология и количество цветов'),
      field(ORDER_GROUP, 'size_mm', 'Размер, мм'),
      field(ORDER_GROUP, 'place', 'Место персонализации'),
      field(ORDER_GROUP, 'sample', 'Образец: да/нет'),
    ],
    paperGuide: [],
  },
  {
    kind: 'print_leaflet',
    section: '11.4',
    title: `${PRINT_TITLE}: листовая продукция`,
    description: 'Шуберы, открытки, полиграфические вставки, наклейки, листовки, лифлеты и т. п.',
    fields: [
      ...PRINT_GENERAL,
      field('Листовая продукция', 'name', 'Наименование'),
      field('Листовая продукция', 'quantity', 'Тираж'),
      field('Листовая продукция', 'size', 'Размер'),
      field('Листовая продукция', 'material', PAPER_KIND_DENSITY, { paper: true }),
      field('Листовая продукция', 'print', PRINT_COLORS),
      field('Листовая продукция', 'options', `${LAMINATION_OPTIONS} и т. п.`),
      field(
        'Листовая продукция',
        'postpress',
        'Постпечатные работы: биговка, фальцовка, вырубка, резка, приклеивание скотча и т. п.',
      ),
      field('Листовая продукция', 'packaging', 'Упаковка: да/нет'),
    ],
    paperGuide: ['shuber', 'postcard', 'watch_insert', 'leaflet', 'stickers'],
  },
  {
    kind: 'print_bag',
    section: '11.4',
    title: `${PRINT_TITLE}: бумажный пакет`,
    fields: [
      ...PRINT_GENERAL,
      field('Бумажный пакет', 'quantity', 'Тираж'),
      field(
        'Бумажный пакет',
        'size',
        'Размер: ширина, высота, глубина; горизонтальный или вертикальный',
      ),
      field('Бумажный пакет', 'material', PAPER_KIND_DENSITY, { paper: true }),
      field('Бумажный пакет', 'print', 'Печать'),
      field('Бумажный пакет', 'image', 'Изображение: одинаковое или разное с обеих сторон'),
      field(
        'Бумажный пакет',
        'lamination',
        'Ламинация: матовая, глянцевая, софт-тач или другая',
      ),
      field('Бумажный пакет', 'options', 'Дополнительные опции: УФ-лак, тиснение и т. п.'),
      field('Бумажный пакет', 'eyelets', 'Люверсы'),
      field('Бумажный пакет', 'handles', 'Ручки'),
    ],
    paperGuide: ['paper_bag'],
  },
  {
    kind: 'print_multipage',
    section: '11.4',
    title: `${PRINT_TITLE}: многостраничная продукция`,
    description: 'Блокноты, брошюры, куб-блоки и т. п.',
    fields: [
      ...PRINT_GENERAL,
      field('Общие параметры', 'name', 'Наименование'),
      field('Общие параметры', 'quantity', 'Тираж'),
      ...partFields(
        'Обложка',
        'cover',
        PAPER_KIND_DENSITY_FINISH,
        `${LAMINATION_OPTIONS}${EXTRA_OPTIONS_TAIL}`,
        false,
      ),
      ...partFields(
        'Подложка',
        'backing',
        PAPER_KIND_DENSITY_FINISH,
        `${LAMINATION_OPTIONS}${EXTRA_OPTIONS_TAIL}`,
        false,
      ),
      field('Блок', 'block_sheets', 'Количество листов'),
      field('Блок', 'block_material', PAPER_KIND_DENSITY, { paper: true }),
      field('Блок', 'block_print', PRINT_COLORS),
      field('Постпечатные работы', 'binding', 'Вид скрепления'),
      field('Постпечатные работы', 'packaging', 'Упаковка'),
    ],
    paperGuide: ['notebook', 'brochure', 'cube_block'],
  },
  {
    kind: 'print_wall_calendar',
    section: '11.4',
    title: `${PRINT_TITLE}: квартальный настенный календарь`,
    fields: [
      ...PRINT_GENERAL,
      field('Общие параметры', 'quantity', 'Тираж'),
      ...partFields(
        'Шапка / ТОП',
        'top',
        PAPER_KIND_DENSITY,
        `${LAMINATION_OPTIONS}${EXTRA_OPTIONS_TAIL}`,
        true,
      ),
      ...partFields(
        'Подложки',
        'backing',
        PAPER_KIND_DENSITY,
        `${LAMINATION_OPTIONS}${EXTRA_OPTIONS_TAIL}`,
        true,
      ),
      field('Сетки / блок', 'grid_size', 'Размер'),
      field('Сетки / блок', 'ready_grids', 'Готовые сетки: какие именно', {
        alternativeGroup: 'grids',
        paper: true,
      }),
      field(
        'Сетки / блок',
        'custom_grids',
        'Индивидуальные сетки: вид и плотность бумаги, количество, печать — цветность / пантон',
        { alternativeGroup: 'grids', paper: true },
      ),
      field('Постпечатные работы', 'binding', 'Вид скрепления'),
      field('Постпечатные работы', 'cursor', 'Курсор'),
      field('Постпечатные работы', 'packaging', 'Упаковка'),
    ],
    paperGuide: ['wall_calendar'],
  },
  {
    kind: 'print_desk_calendar',
    section: '11.4',
    title: `${PRINT_TITLE}: настольный календарь «Домик»`,
    fields: [
      ...PRINT_GENERAL,
      field('Общие параметры', 'quantity', 'Тираж'),
      field(
        'Общие параметры',
        'finished_size',
        'Размер готового изделия: ширина, высота, глубина',
      ),
      ...partFields(
        'Основание',
        'base',
        PAPER_KIND_DENSITY,
        'Дополнительные опции: ламинация, УФ-лак, тиснение и т. п.',
        true,
      ),
      field('Блок', 'block_sheets', 'Количество листов'),
      field('Блок', 'block_material', PAPER_KIND_DENSITY_FINISH, { paper: true }),
      field('Блок', 'block_print', PRINT_COLORS),
      field('Постпечатные работы', 'binding', 'Вид скрепления'),
      field('Постпечатные работы', 'packaging', 'Упаковка'),
    ],
    paperGuide: ['desk_calendar'],
  },
  {
    // Мягкая форма для заявок вне 11.1-11.4 (решение владельца 26.10): минимум - что нужно,
    // тираж и срок. Дополнительные сведения необязательны и недостающими не считаются.
    kind: OTHER_REQUEST_KIND,
    section: OTHER_SECTION,
    title: 'Прочий запрос на поиск поставщиков (вне форм ТЗ)',
    description: 'Заявка, не подходящая ни под одну из форм 11.1–11.4',
    fields: [
      field(ORDER_GROUP, 'product', 'Что нужно'),
      field(ORDER_GROUP, 'quantity', 'Тираж, шт.'),
      field(ORDER_GROUP, 'deadline', 'Срок'),
      field(ORDER_GROUP, 'details', 'Дополнительные сведения', { required: false }),
    ],
    paperGuide: [],
  },
];

/**
 * Ссылка на задачу - последним полем каждой формы, но НЕ обязательная (владелец, 01.11.2026,
 * этап 140): заявка может прийти только текстом. Поле не считается недостающим, агент о ссылке
 * не спрашивает; ключ остаётся, чтобы принять ссылку, если сотрудник дал её сам.
 */
function withTaskLink(form: RequestForm): RequestForm {
  const taskLink = field(TASK_GROUP, TASK_LINK_FIELD_KEY, TASK_LINK_LABEL, {
    required: false,
    mandatory: false,
  });
  return { ...form, fields: [...form.fields, taskLink] };
}

/** Формы всех видов: данные проверяются схемой при загрузке модуля. */
export const REQUEST_FORMS: readonly RequestForm[] = z
  .array(requestFormSchema)
  .parse(REQUEST_FORMS_RAW.map(withTaskLink));

/** Форма запроса указанного вида. */
export function getRequestForm(kind: RequestKind): RequestForm {
  const form = REQUEST_FORMS.find((candidate) => candidate.kind === kind);
  if (form === undefined) throw new Error(`Нет формы запроса вида ${kind}`);
  return form;
}

/** Ключи полей формы вида (для проверки значений, пришедших от модели). */
export function requestFieldKeys(kind: RequestKind): string[] {
  return getRequestForm(kind).fields.map((candidate) => candidate.key);
}

/** Недостающее поле формы: что спросить у сотрудника. */
export interface MissingField {
  key: string;
  label: string;
  group: string;
  /** Варианты ответа из ТЗ. */
  options?: readonly string[] | undefined;
  /** Подсказка по бумаге для стандартных запросов (поля материала). */
  hint?: string | undefined;
  /** Достаточно заполнить любое из полей с такой же меткой (взаимозаменяемые поля). */
  anyOf?: string | undefined;
  /** Отказ дополнять запрос поле не снимает. */
  mandatory?: boolean | undefined;
}

/** Значения полей формы: ключ -> непустая строка. */
export type RequestValues = Readonly<Record<string, string>>;

const hasValue = (values: RequestValues, key: string): boolean =>
  (values[key] ?? '').trim() !== '';

/** Ключи полей, ответ на которые отложен («позже», «пока не знаем»): повторно не спрашиваются. */
export type DeferredKeys = readonly string[];

/** Заголовок блока уже известных форме сведений в вопросе. */
const UNDERSTOOD_HEADER = 'Уже понял:';
/** Пометка отложенного поля в блоке «Уже понял». */
const DEFERRED_MARK = 'уточним позже';

/** Справка по бумаге для вида запроса одной строкой; пусто, если бумага не при чём. */
function paperHint(form: RequestForm): string | undefined {
  const entries = form.paperGuide.flatMap((key) => PAPER_GUIDE.filter((e) => e.key === key));
  if (entries.length === 0) return undefined;
  const text = entries.map((entry) => `${entry.product}: ${entry.recommendation}`).join('; ');
  return `Для стандартных запросов — ${text}.`;
}

/**
 * Проверка полноты: какие поля формы вида `kind` не заполнены. Поле заполнено, если значение
 * есть и не состоит из пробелов. Необязательные поля не считаются недостающими; из
 * взаимозаменяемых полей достаточно заполнить любое. Отложенное поле (`deferred`) считается
 * отвеченным: сотрудник уже сказал «позже», второй раз его не спрашиваем. Обязательное поле
 * (ссылка на задачу) отложить нельзя. Порядок - как в форме.
 */
export function findMissingFields(
  kind: RequestKind,
  values: RequestValues,
  deferred: DeferredKeys = [],
): MissingField[] {
  const form = getRequestForm(kind);
  const hint = paperHint(form);
  const postponed = new Set(deferred);
  const answered = (candidate: RequestForm['fields'][number]): boolean =>
    hasValue(values, candidate.key) ||
    (postponed.has(candidate.key) && candidate.mandatory !== true);
  const filledAlternatives = new Set(
    form.fields.flatMap((candidate) =>
      candidate.alternativeGroup !== undefined && answered(candidate)
        ? [candidate.alternativeGroup]
        : [],
    ),
  );
  const missing: MissingField[] = [];
  for (const candidate of form.fields) {
    if (!candidate.required || answered(candidate)) continue;
    const alternative = candidate.alternativeGroup;
    if (alternative !== undefined && filledAlternatives.has(alternative)) continue;
    missing.push({
      key: candidate.key,
      label: candidate.label,
      group: candidate.group,
      ...(candidate.options === undefined ? {} : { options: candidate.options }),
      ...(candidate.paper === true && hint !== undefined ? { hint } : {}),
      ...(alternative === undefined ? {} : { anyOf: alternative }),
      ...(candidate.mandatory === true ? { mandatory: true } : {}),
    });
  }
  return missing;
}

/** Недостающие поля, которые отказ сотрудника дополнять запрос не снимает. */
export function mandatoryMissing(missing: readonly MissingField[]): MissingField[] {
  return missing.filter((item) => item.mandatory === true);
}

/** Строка недостающего поля в вопросе: подпись и варианты ответа, если они есть. */
function questionLine(item: MissingField): string {
  const options = item.options === undefined ? '' : ` (${item.options.join(' / ')})`;
  const mandatory = item.mandatory === true ? ' (обязательно)' : '';
  return `${item.label}${options}${mandatory}`;
}

/**
 * Вопрос после отказа дополнять запрос: только обязательные поля, без приглашения ответить
 * «нет». Пусто, если обязательного не хватает нечего.
 */
export function buildMandatoryQuestion(missing: readonly MissingField[]): string {
  const required = mandatoryMissing(missing);
  if (required.length === 0) return '';
  const lines = required.map((item) => `- ${item.label}`);
  return [MANDATORY_QUESTION_INTRO, ...lines, '', MANDATORY_QUESTION_OUTRO].join('\n');
}

/**
 * Вопрос сотруднику о недостающих сведениях. Собирается кодом из подписей формы, значений
 * заявки в нём нет (ПДн не попадают). Пусто, если не хватает нечего. Справка по бумаге
 * выводится один раз в конце.
 */
export function buildCompletenessQuestion(
  kind: RequestKind,
  missing: readonly MissingField[],
  understood: readonly string[] = [],
): string {
  if (missing.length === 0) return '';
  const form = getRequestForm(kind);
  const groups = new Map<string, MissingField[]>();
  for (const item of missing) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  const lines: string[] = [COMPLETENESS_QUESTION_INTRO, ''];
  // Сначала показываем, что уже понято: сотрудник видит, что его ответ учтён, и не повторяется.
  if (understood.length > 0) lines.push(`${UNDERSTOOD_HEADER} ${understood.join('; ')}.`, '');
  lines.push(`Форма: ${form.title}. Не хватает:`);
  for (const [group, items] of groups) {
    const plain = items.filter((item) => item.anyOf === undefined).map(questionLine);
    const either = items.filter((item) => item.anyOf !== undefined).map(questionLine);
    const parts = [...plain];
    if (either.length > 0) parts.push(`достаточно одного из: ${either.join(' | ')}`);
    lines.push(`- ${group}: ${parts.join('; ')}`);
  }
  const hint = missing.find((item) => item.hint !== undefined)?.hint;
  if (hint !== undefined) lines.push('', `Подсказка по бумаге. ${hint}`);
  lines.push('', COMPLETENESS_QUESTION_OUTRO);
  return lines.join('\n');
}

/**
 * Краткая сводка известного форме: подписи заполненных полей и «подпись: уточним позже» для
 * отложенных. Сами значения не выводятся: ответ инструмента уходит модели, а в значениях могут
 * быть персональные данные (инвариант «ПДн в модель не уходят»). Ссылка на задачу не входит
 * (служебная). Порядок - как в форме.
 */
export function summarizeUnderstood(
  kind: RequestKind,
  values: RequestValues,
  deferred: DeferredKeys = [],
): string[] {
  const postponed = new Set(deferred);
  const result: string[] = [];
  for (const candidate of getRequestForm(kind).fields) {
    if (candidate.key === TASK_LINK_FIELD_KEY) continue;
    if (hasValue(values, candidate.key)) result.push(candidate.label);
    else if (postponed.has(candidate.key)) result.push(`${candidate.label} - ${DEFERRED_MARK}`);
  }
  return result;
}

/**
 * Описание всех форм для модели: вид, раздел ТЗ, поля как `ключ=подпись` по группам. Строится
 * из данных, поэтому не расходится с проверкой полноты.
 */
export function describeRequestForms(): string {
  const lines: string[] = [];
  for (const form of REQUEST_FORMS) {
    const description = form.description === undefined ? '' : ` (${form.description})`;
    lines.push(`- ${form.kind} [ТЗ ${form.section}]: ${form.title}${description}`);
    const groups = new Map<string, string[]>();
    for (const candidate of form.fields) {
      const optional = candidate.required ? '' : ' (необязательно)';
      const either = candidate.alternativeGroup === undefined ? '' : ' (достаточно одного из двух)';
      const mandatory = candidate.mandatory === true ? ' (обязательно, отказ не снимает)' : '';
      const mark = optional + either + mandatory;
      const entry = `${candidate.key}=${candidate.label}${mark}`;
      groups.set(candidate.group, [...(groups.get(candidate.group) ?? []), entry]);
    }
    for (const [group, entries] of groups) lines.push(`  ${group}: ${entries.join('; ')}`);
  }
  return lines.join('\n');
}
