import { describe, expect, test } from 'bun:test';
import {
  FORM_TO_TEMPLATE,
  KNOWN_FROM_CARD_RULES,
  NEVER_KNOWN_FROM_CARD,
  SUPPLIER_REQUEST_DEFERRED,
  SUPPLIER_REQUEST_FIELDS,
  SUPPLIER_REQUEST_REST_LINE,
  knownFieldsFromCard,
  renderSupplierRequest,
  templateValuesFromForm,
  type SupplierRequestKnownId,
} from '../../../src/kit/domain/supplier-request-template';
import { REQUEST_KINDS, getRequestForm } from '../../../src/kit/domain/request-forms';
import { type SupplierCard } from '../../../src/kit/domain/supplier-card';

/** Строки шаблона из ТЗ заказчика (разд. 5), дословно. */
const TZ_LABELS = [
  'Продукция',
  'Желаемый срок изготовления',
  'Дата запуска в работу',
  'Бюджет, руб\\шт',
  'Тираж, шт',
  'Габарит изделия, см х см х см',
  'Цвет изделия (возможные варианты)',
  'Материал изделия',
  'Технология персонификации',
  'Размер персонификации (изображения), см',
  'Количество цветов персонификации',
  'Нужен ли образец (без персонификации), да\\нет',
  'Дополнительные характеристики продукции и условий поставки (референсы)',
] as const;
const TZ_GREETING = 'Добрый день.';
const TZ_INTRO = 'Прошу рассчитать:';
const TZ_PRICE_LINE =
  'Интересует ваша цена за штуку и за весь тираж (уточните сразу с НДС / без НДС / УСН)';
const TZ_PRICE_LINE_NO_VAT = 'Интересует ваша цена за штуку и за весь тираж';
const TZ_TERMS_LINE = 'Сроки с учетом ориентиров по запуску заказа';

const NO_KNOWN: ReadonlySet<SupplierRequestKnownId> = new Set();

function card(overrides: Partial<SupplierCard> = {}): SupplierCard {
  return {
    id: 'sup-1',
    name: 'Поставщик',
    status: 'active',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...overrides,
  };
}

describe('шаблон запроса поставщику: слова ТЗ дословно', () => {
  test('подписи полей и их порядок совпадают с ТЗ', () => {
    expect(SUPPLIER_REQUEST_FIELDS.map((field) => field.label)).toEqual([...TZ_LABELS]);
  });

  test('ничего не указано: строк полей нет, есть цена, сроки и общая фраза', () => {
    const { text, omitted, blank } = renderSupplierRequest({ values: {}, known: NO_KNOWN });
    const expected = [
      TZ_GREETING,
      '',
      TZ_INTRO,
      '',
      TZ_PRICE_LINE,
      '',
      TZ_TERMS_LINE,
      '',
      SUPPLIER_REQUEST_REST_LINE,
    ].join('\n');
    expect(text).toBe(expected);
    expect(omitted).toEqual([]);
    // Всё пусто: в письмо не вошли все тринадцать полей.
    expect(blank.map((item) => item.label)).toEqual([...TZ_LABELS]);
  });

  test('значения подставляются без изменений, лишние пробелы и переносы сводятся к одному', () => {
    const { text, blank } = renderSupplierRequest({
      values: { product: 'Ручка\nметаллическая', quantity: '  500   шт ', budget: '120' },
      known: NO_KNOWN,
    });
    expect(text).toContain('Продукция: Ручка металлическая');
    expect(text).toContain('Тираж, шт: 500 шт');
    expect(text).toContain('Бюджет, руб\\шт: 120');
    expect(blank.map((item) => item.id)).not.toContain('product');
    expect(blank.map((item) => item.id)).not.toContain('quantity');
    expect(blank.map((item) => item.id)).toContain('material');
  });

  test('значения не выдумываются: пустая строка и пробелы - поле не выводится', () => {
    const { text, blank } = renderSupplierRequest({ values: { product: '   ' }, known: NO_KNOWN });
    expect(text).not.toContain('Продукция');
    expect(blank.map((item) => item.id)).toContain('product');
  });

  test('у письма с пропусками нет подчёркиваний-заглушек', () => {
    const { text } = renderSupplierRequest({ values: { product: 'Ручка' }, known: NO_KNOWN });
    expect(text).not.toContain('_____');
    expect(text).not.toContain('Заполните');
  });

  test('общая фраза есть при пропуске и в самом конце, при полном заполнении её нет', () => {
    const partial = renderSupplierRequest({ values: { product: 'Ручка' }, known: NO_KNOWN });
    expect(partial.text.endsWith(`${TZ_TERMS_LINE}\n\n${SUPPLIER_REQUEST_REST_LINE}`)).toBe(true);

    const values = Object.fromEntries(SUPPLIER_REQUEST_FIELDS.map((f) => [f.id, 'x']));
    const full = renderSupplierRequest({ values, known: NO_KNOWN });
    expect(full.blank).toEqual([]);
    expect(full.text).not.toContain(SUPPLIER_REQUEST_REST_LINE);
  });

  test('сроки убраны карточкой: общая фраза идёт после строки о цене', () => {
    const { text } = renderSupplierRequest({
      values: {},
      known: new Set<SupplierRequestKnownId>(['terms']),
    });
    expect(text.endsWith(`${TZ_PRICE_LINE}\n\n${SUPPLIER_REQUEST_REST_LINE}`)).toBe(true);
  });

  test('всё пропущенное известно по карточке: это omitted, фразы нет', () => {
    const known = new Set<SupplierRequestKnownId>(SUPPLIER_REQUEST_FIELDS.map((f) => f.id));
    const { text, blank, omitted } = renderSupplierRequest({ values: {}, known });
    expect(blank).toEqual([]);
    expect(omitted).toHaveLength(SUPPLIER_REQUEST_FIELDS.length);
    expect(text).not.toContain(SUPPLIER_REQUEST_REST_LINE);
  });
});

describe('известное по карточке убирается из текста', () => {
  test('известный срок: нет строки о сроках и пустого «Желаемый срок»', () => {
    const { text, omitted } = renderSupplierRequest({
      values: {},
      known: new Set<SupplierRequestKnownId>(['terms', 'desired_term']),
    });
    expect(text).not.toContain(TZ_TERMS_LINE);
    expect(text).not.toContain('Желаемый срок изготовления');
    expect(omitted.map((item) => item.id)).toEqual(['desired_term', 'terms']);
    // Остальное по шаблону на месте.
    expect(text).toContain(TZ_PRICE_LINE);
    expect(text).not.toContain('Дата запуска в работу');
  });

  test('известное налогообложение: цена спрашивается без уточнения НДС', () => {
    const { text, omitted } = renderSupplierRequest({
      values: {},
      known: new Set<SupplierRequestKnownId>(['vat']),
    });
    expect(text).toContain(`\n${TZ_PRICE_LINE_NO_VAT}\n`);
    expect(text).not.toContain('уточните сразу');
    expect(omitted.map((item) => item.id)).toEqual(['vat']);
  });

  test('известное поле пропущено только без значения: наши сведения о заказе остаются', () => {
    const known = new Set<SupplierRequestKnownId>(['sample', 'personalization_tech']);
    const empty = renderSupplierRequest({ values: {}, known });
    expect(empty.text).not.toContain('Нужен ли образец');
    expect(empty.text).not.toContain('Технология персонификации');
    expect(empty.omitted.map((item) => item.id)).toEqual(['personalization_tech', 'sample']);
    expect(empty.blank.map((item) => item.id)).not.toContain('sample');

    const filled = renderSupplierRequest({
      values: { sample: 'да', personalization_tech: 'тампопечать' },
      known,
    });
    expect(filled.text).toContain('Нужен ли образец (без персонификации), да\\нет: да');
    expect(filled.text).toContain('Технология персонификации: тампопечать');
    expect(filled.omitted).toEqual([]);
  });

  test('«Дополнительные характеристики» без значения не выводятся', () => {
    const { text, blank } = renderSupplierRequest({ values: {}, known: NO_KNOWN });
    expect(text).not.toContain('референсы)');
    expect(blank.map((item) => item.id)).toContain('extra');
  });

  test('пустое известное множество и множество без совпадений дают один и тот же текст', () => {
    const full = renderSupplierRequest({ values: {}, known: NO_KNOWN }).text;
    const other = renderSupplierRequest({ values: {}, known: knownFieldsFromCard(card()) }).text;
    expect(other).toBe(full);
  });
});

describe('knownFieldsFromCard: структурные поля карточки', () => {
  const NOTE = { authorId: 'u1', createdAt: '2026-01-01T00:00:00.000Z' };

  /** Таблица случаев: поле карточки -> что становится известным. */
  const CASES: ReadonlyArray<{
    name: string;
    card: Partial<SupplierCard>;
    expected: SupplierRequestKnownId[];
  }> = [
    { name: 'режим НДС', card: { vatMode: 'no_vat' }, expected: ['vat'] },
    { name: 'плательщик НДС без ставки', card: { vatMode: 'with_vat' }, expected: ['vat'] },
    {
      name: 'режим и ставка НДС',
      card: { vatMode: 'with_vat', vatRatePercent: 22 },
      expected: ['vat'],
    },
    { name: 'только ставка НДС', card: { vatRatePercent: 20 }, expected: ['vat'] },
    {
      name: 'виды персонификации',
      card: { personalizationTypes: ['тампопечать', 'гравировка'] },
      expected: ['personalization_tech'],
    },
    { name: 'срок производства', card: { terms: { leadTime: '10 дней' } }, expected: ['terms'] },
  ];

  for (const item of CASES) {
    test(`заполнено: ${item.name}`, () => {
      expect([...knownFieldsFromCard(card(item.card))].sort()).toEqual([...item.expected].sort());
    });
  }

  test('карточка без сведений: ничего не известно', () => {
    expect(knownFieldsFromCard(card()).size).toBe(0);
  });

  test('пустое поле не убирает вопрос: пустой список и срок из пробелов', () => {
    const empty = card({ personalizationTypes: [], terms: { leadTime: '   ' } });
    expect(knownFieldsFromCard(empty).size).toBe(0);
    const blankItems = card({ personalizationTypes: ['  '] });
    expect(knownFieldsFromCard(blankItems).size).toBe(0);
  });

  test('текст заметок, категорий и условий больше не разбирается', () => {
    const textual = card({
      terms: { payment: 'предоплата, цены без НДС УСН', discounts: 'НДС включён' },
      supplies: { categories: ['Тампопечать', 'Гравировка'], brands: [], regions: [] },
      notes: [
        { text: 'Работают на УСН, делают шелкографию', ...NOTE },
        { text: 'Срок производства 5 дней', ...NOTE },
      ],
    });
    expect(knownFieldsFromCard(textual).size).toBe(0);
  });

  test('срок производства убирает строку о сроках, «Желаемый срок» остаётся нашим', () => {
    const supplierCard = card({ terms: { leadTime: '10-14 рабочих дней' } });
    const { text, omitted } = renderSupplierRequest({
      values: {},
      known: knownFieldsFromCard(supplierCard),
    });
    // Наши потребности без значения не спрашиваются, но и не считаются известными по карточке.
    expect(text).not.toContain('Желаемый срок изготовления');
    expect(text).not.toContain('Дата запуска в работу');
    expect(text).not.toContain(TZ_TERMS_LINE);
    expect(omitted.map((item) => item.id)).toEqual(['terms']);
  });

  test('НДС в карточке: цена спрашивается без уточнения', () => {
    const { text } = renderSupplierRequest({
      values: {},
      known: knownFieldsFromCard(card({ vatMode: 'no_vat' })),
    });
    expect(text).toContain(TZ_PRICE_LINE_NO_VAT);
    expect(text).not.toContain('уточните сразу');
  });

  test('виды персонификации убирают пустую строку технологии, но не заполненную', () => {
    const known = knownFieldsFromCard(card({ personalizationTypes: ['тампопечать'] }));
    const empty = renderSupplierRequest({ values: {}, known });
    expect(empty.text).not.toContain('Технология персонификации');
    const filled = renderSupplierRequest({ values: { personalization_tech: 'гравировка' }, known });
    expect(filled.text).toContain('Технология персонификации: гравировка');
  });

  test('образцы поставщика не убирают «Нужен ли образец»: это наша потребность', () => {
    const known = knownFieldsFromCard(
      card({ samplesAvailable: true, samplesQuantity: 3, samplesTerms: 'бесплатно' }),
    );
    expect(known.size).toBe(0);
    const { text, blank } = renderSupplierRequest({ values: {}, known });
    expect(text).not.toContain('Нужен ли образец');
    expect(blank.map((item) => item.id)).toContain('sample');
  });

  test('минимальная партия, технологии, доставка ничего не убирают', () => {
    const known = knownFieldsFromCard(
      card({
        terms: { minBatch: 'от 100 шт', delivery: 'СДЭК' },
        technologies: ['литьё'],
        minOrderAmount: '10 000 руб.',
      }),
    );
    expect(known.size).toBe(0);
  });

  test('таблица правил и список «никогда» покрывают все вопросы шаблона без пересечений', () => {
    const fromRules = KNOWN_FROM_CARD_RULES.map((rule) => rule.id);
    const never = NEVER_KNOWN_FROM_CARD.map((item) => item.id);
    expect(fromRules.filter((id) => never.includes(id))).toHaveLength(0);
    const all: string[] = [...SUPPLIER_REQUEST_FIELDS.map((field) => field.id), 'vat', 'terms'];
    all.sort();
    const covered: string[] = [...fromRules, ...never];
    expect(covered.sort()).toEqual(all);
  });
});

describe('соответствие полей шаблона ключам форм 11.x', () => {
  test('каждый ключ таблицы существует в форме своего вида', () => {
    for (const kind of REQUEST_KINDS) {
      const keys = new Set(getRequestForm(kind).fields.map((field) => field.key));
      for (const formKeys of Object.values(FORM_TO_TEMPLATE[kind])) {
        for (const key of formKeys) expect(keys.has(key)).toBe(true);
      }
    }
  });

  test('11.1: значения формы попадают в поля шаблона', () => {
    const values = templateValuesFromForm('custom_product', {
      product: 'Ручка',
      quantity: '500',
      production_date: '15.12.2026',
      budget: '120',
      dimensions: '15 х 1 х 1',
      material_color: 'металл, чёрный или синий',
      personalization_tech: 'тампопечать, 2 цвета',
      personalization_size: '4 х 1',
      sample: 'да',
    });
    expect(values).toEqual({
      product: 'Ручка',
      desired_term: '15.12.2026',
      budget: '120',
      quantity: '500',
      dimensions: '15 х 1 х 1',
      color: 'металл, чёрный или синий',
      material: 'металл, чёрный или синий',
      personalization_tech: 'тампопечать, 2 цвета',
      personalization_colors: 'тампопечать, 2 цвета',
      personalization_size: '4 х 1',
      sample: 'да',
    });
  });

  test('поля формы без пары в шаблоне идут в «Дополнительные характеристики»', () => {
    const values = templateValuesFromForm('apparel', {
      quantity: '100',
      item_name: 'Куртка',
      color_proof: 'да',
      label_info: 'только размер',
    });
    expect(values.product).toBe('Куртка');
    expect(values.extra).toBe(
      'Параметры изделия, Цветопроба: да/нет: да; ' +
        'Параметры изделия, Информация на ярлыке: только размер',
    );
  });

  test('ссылка на задачу поставщику не уходит: ни в поля, ни в дополнительные', () => {
    const link = 'https://portal.example.test/company/personal/user/1/tasks/task/view/42/';
    const values = templateValuesFromForm('apparel', { item_name: 'Куртка', task_link: link });
    expect(values.product).toBe('Куртка');
    expect(values.extra).toBeUndefined();
    expect(JSON.stringify(values)).not.toContain('tasks');
  });

  test('размер в миллиметрах (11.3) в поле «см» не попадает', () => {
    const values = templateValuesFromForm('personalization', {
      product: 'Кружка',
      size_mm: '40 х 20',
    });
    expect(values.personalization_size).toBeUndefined();
    expect(values.extra).toBe('Размер, мм: 40 х 20');
  });

  test('группа формы называется в дополнительных, кроме общих групп', () => {
    const values = templateValuesFromForm('print_multipage', {
      name: 'Блокнот',
      cover_print: '4+0',
    });
    expect(values.product).toBe('Блокнот');
    expect(values.extra).toBe('Обложка, Печать: цветность / пантон: 4+0');
  });

  test('пустые значения и неизвестные ключи пропускаются, выдумок нет', () => {
    const values = templateValuesFromForm('custom_product', { product: ' ', unknown_key: 'x' });
    expect(values).toEqual({});
  });
});

describe('отложенные поля в тексте запроса', () => {
  test('отложенное поле шаблона получает «уточним позже», а не пропуск', () => {
    const values = templateValuesFromForm('custom_product', { quantity: '30' }, ['budget']);
    const text = renderSupplierRequest({ values, known: new Set() }).text;
    expect(text).toContain(`Бюджет, руб\\шт: ${SUPPLIER_REQUEST_DEFERRED}`);
    expect(text).toContain('Тираж, шт: 30');
  });

  test('без deferred результат прежний', () => {
    expect(templateValuesFromForm('custom_product', { quantity: '30' })).toEqual(
      templateValuesFromForm('custom_product', { quantity: '30' }, []),
    );
  });
});
