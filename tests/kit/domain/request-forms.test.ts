import { describe, expect, test } from 'bun:test';
import {
  COMPLETENESS_QUESTION_INTRO,
  PAPER_GUIDE,
  REQUEST_FORMS,
  REQUEST_KINDS,
  TASK_GROUP,
  TASK_LINK_FIELD_KEY,
  buildCompletenessQuestion,
  buildMandatoryQuestion,
  describeRequestForms,
  findMissingFields,
  getRequestForm,
  mandatoryMissing,
  requestFieldKeys,
  requestFormSchema,
  type RequestKind,
} from '../../../src/kit/domain/request-forms';

/** Подписи полей из раздела 11 ТЗ (дословно, без точки в конце строки). */
const LABELS: Record<RequestKind, string[]> = {
  custom_product: [
    'Продукция',
    'Тираж, шт.',
    'Дата изготовления',
    'Бюджет, руб./шт.',
    'Габариты изделия, см',
    'Материал и цвет изделия — возможные варианты',
    'Технология и количество цветов персонализации',
    'Размер персонализации — изображения, см',
    'Образец: да/нет',
  ],
  apparel: [
    'Тираж',
    'Дата запуска',
    'Дата готовности',
    'Наименование изделия',
    'Материал',
    'Цвет',
    'Способ нанесения',
    'Цветопроба: да/нет',
    'Фурнитура',
    'Подклад',
    'Информация на ярлыке',
    'Размеры: стандартные или больше 58–60',
  ],
  personalization: [
    'Продукция: артикул, поставщик, ссылка',
    'Тираж, шт.',
    'Технология и количество цветов',
    'Размер, мм',
    'Место персонализации',
    'Образец: да/нет',
  ],
  print_leaflet: [
    'Дата запуска',
    'Дата готовности',
    'Наименование',
    'Тираж',
    'Размер',
    'Материал: вид и плотность бумаги',
    'Печать: цветность / пантон',
    'Дополнительные опции: ламинация с одной или двух сторон, УФ-лак и т. п.',
    'Постпечатные работы: биговка, фальцовка, вырубка, резка, приклеивание скотча и т. п.',
    'Упаковка: да/нет',
  ],
  print_bag: [
    'Дата запуска',
    'Дата готовности',
    'Тираж',
    'Размер: ширина, высота, глубина; горизонтальный или вертикальный',
    'Материал: вид и плотность бумаги',
    'Печать',
    'Изображение: одинаковое или разное с обеих сторон',
    'Ламинация: матовая, глянцевая, софт-тач или другая',
    'Дополнительные опции: УФ-лак, тиснение и т. п.',
    'Люверсы',
    'Ручки',
  ],
  print_multipage: [
    'Дата запуска',
    'Дата готовности',
    'Наименование',
    'Тираж',
    'Материал: вид, плотность бумаги, матовая или глянцевая',
    'Печать: цветность / пантон',
    'Дополнительные опции: ламинация с одной или двух сторон, УФ-лак, тиснение и т. п.',
    'Материал: вид, плотность бумаги, матовая или глянцевая',
    'Печать: цветность / пантон',
    'Дополнительные опции: ламинация с одной или двух сторон, УФ-лак, тиснение и т. п.',
    'Количество листов',
    'Материал: вид и плотность бумаги',
    'Печать: цветность / пантон',
    'Вид скрепления',
    'Упаковка',
  ],
  print_wall_calendar: [
    'Дата запуска',
    'Дата готовности',
    'Тираж',
    'Размер',
    'Материал: вид и плотность бумаги',
    'Печать: цветность / пантон',
    'Дополнительные опции: ламинация с одной или двух сторон, УФ-лак, тиснение и т. п.',
    'Размер',
    'Материал: вид и плотность бумаги',
    'Печать: цветность / пантон',
    'Дополнительные опции: ламинация с одной или двух сторон, УФ-лак, тиснение и т. п.',
    'Размер',
    'Готовые сетки: какие именно',
    'Индивидуальные сетки: вид и плотность бумаги, количество, печать — цветность / пантон',
    'Вид скрепления',
    'Курсор',
    'Упаковка',
  ],
  print_desk_calendar: [
    'Дата запуска',
    'Дата готовности',
    'Тираж',
    'Размер готового изделия: ширина, высота, глубина',
    'Размер',
    'Материал: вид и плотность бумаги',
    'Печать: цветность / пантон',
    'Дополнительные опции: ламинация, УФ-лак, тиснение и т. п.',
    'Количество листов',
    'Материал: вид, плотность бумаги, матовая или глянцевая',
    'Печать: цветность / пантон',
    'Вид скрепления',
    'Упаковка',
  ],
  other: ['Что нужно', 'Тираж, шт.', 'Срок', 'Дополнительные сведения'],
};

const PRINT_KINDS = REQUEST_KINDS.filter((kind) => kind.startsWith('print_'));

/** Значения для всех полей формы вида. */
function fullValues(kind: RequestKind): Record<string, string> {
  return Object.fromEntries(requestFieldKeys(kind).map((key) => [key, `значение ${key}`]));
}

describe('формы запросов: данные', () => {
  test('девять видов: 11.1, 11.2, 11.3, пять подвидов полиграфии и «прочее»', () => {
    expect([...REQUEST_KINDS]).toEqual([
      'custom_product',
      'apparel',
      'personalization',
      'print_leaflet',
      'print_bag',
      'print_multipage',
      'print_wall_calendar',
      'print_desk_calendar',
      'other',
    ]);
    expect(REQUEST_FORMS.map((form) => form.kind)).toEqual([...REQUEST_KINDS]);
    expect(REQUEST_FORMS.map((form) => form.section)).toEqual([
      '11.1',
      '11.2',
      '11.3',
      '11.4',
      '11.4',
      '11.4',
      '11.4',
      '11.4',
      'вне 11.1–11.4',
    ]);
  });

  test('подписи полей совпадают с ТЗ дословно и идут в порядке ТЗ', () => {
    for (const kind of REQUEST_KINDS) {
      const fields = getRequestForm(kind).fields.filter((f) => f.key !== TASK_LINK_FIELD_KEY);
      expect(fields.map((field) => field.label)).toEqual(LABELS[kind]);
    }
  });

  test('ссылка на задачу - последнее поле формы, не обязательное и не недостающее', () => {
    for (const kind of REQUEST_KINDS) {
      const last = getRequestForm(kind).fields.at(-1);
      expect(last).toMatchObject({
        key: TASK_LINK_FIELD_KEY,
        group: TASK_GROUP,
        required: false,
        mandatory: false,
      });
      expect(findMissingFields(kind, {}).map((item) => item.key)).not.toContain(
        TASK_LINK_FIELD_KEY,
      );
    }
    expect(mandatoryMissing(findMissingFields('apparel', {}))).toEqual([]);
    expect(buildMandatoryQuestion(findMissingFields('apparel', {}))).toBe('');
  });

  test('ключи латиницей и уникальны в форме; схема формы принимает данные', () => {
    for (const form of REQUEST_FORMS) {
      const keys = form.fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(requestFormSchema.safeParse(form).success).toBe(true);
    }
  });

  test('по ТЗ запрашиваются все поля формы (кроме ссылки на задачу)', () => {
    for (const form of REQUEST_FORMS.filter((candidate) => candidate.kind !== 'other')) {
      const fields = form.fields.filter((field) => field.key !== TASK_LINK_FIELD_KEY);
      expect(fields.every((field) => field.required)).toBe(true);
    }
  });

  test('«прочее»: мягкая проверка - только что нужно, тираж и срок', () => {
    const missing = findMissingFields('other', {});
    expect(missing.map((item) => item.key)).toEqual([
      'product',
      'quantity',
      'deadline',
    ]);
    // Минимум есть, дополнительные сведения и ссылка на задачу не нужны.
    const enough = {
      product: 'ежедневники',
      quantity: '200',
      deadline: 'до 15.11',
    };
    expect(findMissingFields('other', enough)).toEqual([]);
    expect(buildCompletenessQuestion('other', missing)).toContain('Что нужно');
  });

  test('11.2: информация на ярлыке - три варианта из ТЗ', () => {
    const label = getRequestForm('apparel').fields.find((field) => field.key === 'label_info');
    expect(label?.options).toEqual([
      'только размер',
      'размер с логотипом производителя',
      'размер с логотипом заказчика',
    ]);
  });

  test('все формы полиграфии начинаются с дат запуска и готовности', () => {
    expect(PRINT_KINDS).toHaveLength(5);
    for (const kind of PRINT_KINDS) {
      const [first, second] = getRequestForm(kind).fields;
      expect(first?.label).toBe('Дата запуска');
      expect(second?.label).toBe('Дата готовности');
      expect(first?.group).toBe('Общие сведения');
    }
  });

  test('подвиды полиграфии: группы из ТЗ', () => {
    const groups = (kind: RequestKind): string[] => [
      ...new Set(
        getRequestForm(kind)
          .fields.filter((field) => field.group !== TASK_GROUP)
          .map((field) => field.group),
      ),
    ];
    expect(groups('print_leaflet')).toEqual(['Общие сведения', 'Листовая продукция']);
    expect(groups('print_bag')).toEqual(['Общие сведения', 'Бумажный пакет']);
    expect(groups('print_multipage')).toEqual([
      'Общие сведения',
      'Общие параметры',
      'Обложка',
      'Подложка',
      'Блок',
      'Постпечатные работы',
    ]);
    expect(groups('print_wall_calendar')).toEqual([
      'Общие сведения',
      'Общие параметры',
      'Шапка / ТОП',
      'Подложки',
      'Сетки / блок',
      'Постпечатные работы',
    ]);
    expect(groups('print_desk_calendar')).toEqual([
      'Общие сведения',
      'Общие параметры',
      'Основание',
      'Блок',
      'Постпечатные работы',
    ]);
  });
});

describe('справка «Бумага для стандартных запросов»', () => {
  test('одиннадцать строк, рекомендации из ТЗ', () => {
    expect(PAPER_GUIDE.map((entry) => entry.product)).toEqual([
      'Шубер',
      'Открытка',
      'Полиграфическая вставка в часы',
      'Листовка, лифлет / буклет',
      'Наклейки',
      'Бумажный пакет',
      'Блокнот',
      'Брошюра',
      'Куб-блоки',
      'Квартальный календарь',
      'Настольный календарь «Домик»',
    ]);
    const byProduct = (product: string): string | undefined =>
      PAPER_GUIDE.find((entry) => entry.product === product)?.recommendation;
    expect(byProduct('Шубер')).toBe('мелованная матовая или глянцевая бумага, 300 г/м²');
    expect(byProduct('Куб-блоки')).toBe('ВХИ, «офсетка», 80 г/м²');
    expect(byProduct('Бумажный пакет')).toBe(
      'мелованная бумага с обязательной ламинацией, 170–250 г/м²; рекомендуется не более ' +
        '200 г/м²',
    );
    expect(byProduct('Настольный календарь «Домик»')).toBe(
      'основание — картон одностороннего мелования, 300 г/м²; блок — мелованная матовая или ' +
        'глянцевая бумага, 150 г/м², либо ВХИ, 80 г/м²',
    );
  });

  test('подсказка прикладывается к полям материала полиграфии, не к другим', () => {
    const missing = findMissingFields('print_bag', {});
    const material = missing.find((item) => item.key === 'material');
    expect(material?.hint).toContain('170–250 г/м²');
    expect(missing.find((item) => item.key === 'print')?.hint).toBeUndefined();
  });

  test('у форм без бумаги подсказок нет', () => {
    for (const kind of ['custom_product', 'apparel', 'personalization'] as const) {
      expect(findMissingFields(kind, {}).every((item) => item.hint === undefined)).toBe(true);
    }
  });

  test('листовая продукция: подсказка перечисляет шубер, открытку, вставку, листовку', () => {
    const hint = findMissingFields('print_leaflet', {}).find((i) => i.key === 'material')?.hint;
    for (const word of ['Шубер', 'Открытка', 'вставка в часы', 'Листовка', 'Наклейки']) {
      expect(hint).toContain(word);
    }
  });
});

describe('findMissingFields', () => {
  test('пустые значения: не хватает всех полей, порядок формы', () => {
    for (const kind of REQUEST_KINDS.filter((k) => k !== 'print_wall_calendar')) {
      // Необязательные поля («прочее: дополнительные сведения») недостающими не считаются.
      const required = getRequestForm(kind).fields.filter((f) => f.required);
      expect(findMissingFields(kind, {}).map((item) => item.key)).toEqual(
        required.map((f) => f.key),
      );
    }
  });

  test('полная форма: не хватает ничего', () => {
    for (const kind of REQUEST_KINDS) {
      expect(findMissingFields(kind, fullValues(kind))).toEqual([]);
    }
  });

  test('пробелы вместо значения - поле не заполнено', () => {
    const values = { ...fullValues('personalization'), place: '   ', size_mm: '' };
    expect(findMissingFields('personalization', values).map((item) => item.key)).toEqual([
      'size_mm',
      'place',
    ]);
  });

  test('лишние ключи не мешают', () => {
    const values = { ...fullValues('personalization'), unknown_key: 'x' };
    expect(findMissingFields('personalization', values)).toEqual([]);
  });

  test('у недостающего поля группа и подпись из ТЗ', () => {
    const [first] = findMissingFields('custom_product', { product: 'кружка' });
    expect(first).toMatchObject({
      key: 'quantity',
      label: 'Тираж, шт.',
      group: 'Сведения о заказе',
    });
  });

  test('ярлык одежды: варианты приходят вместе с недостающим полем', () => {
    const missing = findMissingFields('apparel', {});
    expect(missing.find((item) => item.key === 'label_info')?.options).toHaveLength(3);
  });

  test('календарь: готовые или индивидуальные сетки - достаточно одного', () => {
    const base = fullValues('print_wall_calendar');
    delete base['ready_grids'];
    delete base['custom_grids'];
    const none = findMissingFields('print_wall_calendar', base);
    expect(none.map((item) => item.key)).toEqual(['ready_grids', 'custom_grids']);
    expect(none.every((item) => item.anyOf === 'grids')).toBe(true);
    expect(findMissingFields('print_wall_calendar', { ...base, ready_grids: 'ВХИ' })).toEqual([]);
    expect(findMissingFields('print_wall_calendar', { ...base, custom_grids: '150 г' })).toEqual(
      [],
    );
  });

  test('многостраничная продукция: обложка, подложка и блок спрашиваются отдельно', () => {
    const missing = findMissingFields('print_multipage', {
      launch_date: '1 ноября',
      ready_date: '20 ноября',
      name: 'Блокнот',
      quantity: '500',
    });
    const groups = new Set(missing.map((item) => item.group));
    expect(groups).toEqual(new Set(['Обложка', 'Подложка', 'Блок', 'Постпечатные работы']));
    expect(missing.filter((item) => item.group === 'Обложка').map((i) => i.key)).toEqual([
      'cover_material',
      'cover_print',
      'cover_options',
    ]);
  });

  test('настольный календарь: основание с размером, блок без него', () => {
    const keys = requestFieldKeys('print_desk_calendar');
    expect(keys).toContain('base_size');
    expect(keys).not.toContain('block_size');
  });
});

describe('вопрос сотруднику и описание для модели', () => {
  test('вопрос начинается со слов из ТЗ и перечисляет недостающее по группам', () => {
    const question = buildCompletenessQuestion(
      'print_bag',
      findMissingFields('print_bag', { launch_date: '1.11', ready_date: '10.11' }),
    );
    expect(question.startsWith(COMPLETENESS_QUESTION_INTRO)).toBe(true);
    expect(question.toLowerCase()).toContain(
      'не хочешь ли ты например дополнить по заказу определенные сведения для более ' +
        'точного поиска, так как их не хватает',
    );
    expect(question).toContain('- Бумажный пакет: Тираж; Размер: ширина, высота, глубина');
    expect(question).not.toContain('Дата запуска');
    expect(question).toContain('Подсказка по бумаге.');
    expect(question.match(/Подсказка по бумаге/g)).toHaveLength(1);
  });

  test('вопроса нет, если не хватает нечего; варианты ярлыка в вопросе', () => {
    expect(buildCompletenessQuestion('apparel', [])).toBe('');
    const question = buildCompletenessQuestion('apparel', findMissingFields('apparel', {}));
    expect(question).toContain(
      'Информация на ярлыке (только размер / размер с логотипом производителя / размер ' +
        'с логотипом заказчика)',
    );
  });

  test('вопрос про календарь называет сетки как «одно из»', () => {
    const question = buildCompletenessQuestion(
      'print_wall_calendar',
      findMissingFields('print_wall_calendar', {}),
    );
    expect(question).toContain('достаточно одного из: Готовые сетки: какие именно | ');
  });

  test('в вопрос не попадают значения заявки', () => {
    const secret = 'ИНН-7700000000-СЕКРЕТ';
    const missing = findMissingFields('personalization', { product: secret });
    expect(buildCompletenessQuestion('personalization', missing)).not.toContain(secret);
  });

  test('описание форм содержит все виды, ключи и подписи', () => {
    const text = describeRequestForms();
    for (const form of REQUEST_FORMS) {
      expect(text).toContain(`- ${form.kind} [ТЗ ${form.section}]`);
      for (const field of form.fields) expect(text).toContain(`${field.key}=${field.label}`);
    }
    expect(text).toContain('Шуберы, открытки, полиграфические вставки');
    expect(text).toContain('(достаточно одного из двух)');
  });
});

describe('отложенные поля', () => {
  test('отложенное поле не считается недостающим', () => {
    const base = findMissingFields('custom_product', {}).map((item) => item.key);
    const withDeferred = findMissingFields('custom_product', {}, ['sample', 'task_link']).map(
      (item) => item.key,
    );
    expect(base).toContain('sample');
    expect(withDeferred).not.toContain('sample');
    expect(withDeferred).not.toContain('task_link');
  });
});
