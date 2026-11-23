import { describe, expect, test } from 'bun:test';
import {
  PRICE_MAIL_TRIGGER_SPECS,
  type PriceMailTriggerId,
} from '../../../src/kit/domain/price-mail-trigger-phrases';
import {
  PRICE_MAIL_TRIGGERS,
  detectPriceMailTriggers,
} from '../../../src/kit/domain/price-mail-triggers';

/** Идентификаторы триггеров, найденных в письме с заданной темой/текстом/вложениями. */
function ids(parts: {
  subject?: string;
  body?: string;
  attachmentNames?: string[];
}): PriceMailTriggerId[] {
  return detectPriceMailTriggers({
    subject: parts.subject ?? '',
    body: parts.body ?? '',
    attachmentNames: parts.attachmentNames ?? [],
  }).map((match) => match.id);
}

describe('словарь триггеров', () => {
  test('данные в одном месте: у каждого триггера есть подпись и правила', () => {
    expect(PRICE_MAIL_TRIGGERS.map((item) => item.id)).toEqual([
      'price_increase',
      'price_change',
      'new_price',
    ]);
    for (const trigger of PRICE_MAIL_TRIGGERS) {
      expect(trigger.label.length).toBeGreaterThan(0);
      expect(trigger.rules.length).toBeGreaterThan(0);
    }
  });
});

describe('повышение цен: словоформы', () => {
  test.each([
    ['Повышение цен'],
    ['О повышении цен с 1 октября'],
    ['Повышаем цены на продукцию'],
    ['Рост стоимости материалов'],
    ['Цены вырастут с понедельника'],
    ['Индексация цен'],
    ['Подорожание прайса'],
    ['Price increase from November'],
  ])('«%s»', (subject) => {
    expect(ids({ subject })).toContain('price_increase');
  });

  test('слова рядом в любом порядке и в теле письма', () => {
    expect(ids({ body: 'Сообщаем: цены будут повышены.' })).toContain('price_increase');
  });

  test('регистр и буква ё не важны', () => {
    expect(ids({ subject: 'ПОВЫШЕНИЕ ЦЕН' })).toContain('price_increase');
    expect(ids({ subject: 'Повышение стоимости, ЦЕНЫ ПОДНЯЛИСЬ' })).toContain('price_increase');
    expect(ids({ body: 'Цены поднялись; корректировка', subject: 'ПОДОРОЖАНИЕ ЦЕН' })).toContain(
      'price_increase',
    );
  });
});

describe('изменение цен: словоформы', () => {
  test.each([
    ['Изменение цен'],
    ['Об изменении цен на товары'],
    ['Корректировка стоимости'],
    ['Пересмотр цен'],
    ['Обновление цен с 1 числа'],
  ])('«%s»', (subject) => {
    expect(ids({ subject })).toContain('price_change');
  });
});

describe('новый прайс: словоформы', () => {
  test.each([
    ['Новый прайс-лист'],
    ['Новый прайс'],
    ['Актуальный прайс на октябрь'],
    ['Обновлённый прайс'],
    ['В новом прайсе изменения'],
    ['Свежий прайс-лист'],
    ['New price list'],
  ])('«%s» в теме', (subject) => {
    expect(ids({ subject })).toContain('new_price');
  });

  test('слово «прайс» в теме само по себе', () => {
    expect(ids({ subject: 'Прайс' })).toEqual(['new_price']);
    expect(ids({ subject: 'price list' })).toEqual(['new_price']);
  });

  test('вложение: Прайс_2026.xlsx, price list.xlsx', () => {
    expect(ids({ attachmentNames: ['Прайс_2026.xlsx'] })).toEqual(['new_price']);
    expect(ids({ attachmentNames: ['Price List 2026.XLSX'] })).toEqual(['new_price']);
    expect(ids({ attachmentNames: ['price-list.pdf'] })).toEqual(['new_price']);
  });

  test('поля: найденное в теме и во вложении перечисляется', () => {
    const [match] = detectPriceMailTriggers({
      subject: 'Новый прайс',
      body: '',
      attachmentNames: ['Прайс_2026.xlsx'],
    });
    expect(match?.fields).toEqual(['subject', 'attachment']);
    expect(match?.label).toBe('новый прайс');
  });

  test('несколько триггеров в одном письме', () => {
    expect(
      ids({ subject: 'Повышение цен', attachmentNames: ['Прайс_2026.xlsx'] }),
    ).toEqual(['price_increase', 'new_price']);
  });
});

describe('отрицательные', () => {
  test.each([
    ['Цена вопроса'],
    ['Прайсовая политика компании'],
    ['Центр обработки заказов'],
    ['Счёт на оплату'],
    ['Акт сверки'],
    ['Новости компании'],
    ['Рост компании и новые сотрудники'],
    ['Ростов-на-Дону: график отгрузок'],
    ['Изменение графика работы склада'],
    ['Обновление реквизитов'],
  ])('«%s»', (subject) => {
    expect(ids({ subject })).toEqual([]);
  });

  test('якорь и партнёр далеко друг от друга не связываются', () => {
    const body = 'Повышение квалификации сотрудников прошло в сентябре в нашем офисе, а цена ' +
      'обеда в столовой осталась прежней.';
    expect(ids({ body })).toEqual([]);
  });

  test('вложение без слова «прайс» не триггер, расширение таблицы не считается', () => {
    expect(ids({ attachmentNames: ['Счёт_123.xlsx', 'Договор.pdf'] })).toEqual([]);
    expect(ids({ attachmentNames: ['Прайсовая_политика.pdf'] })).toEqual([]);
  });

  test('пустое письмо', () => {
    expect(ids({})).toEqual([]);
  });

  test('слово «прайс» в теле само по себе не триггер', () => {
    expect(ids({ body: 'Прайс отправим позже.' })).toEqual([]);
  });
});

describe('фразы из ТЗ (п. 7.2) и данные словаря', () => {
  test.each([
    ['повышение цен', 'price_increase'],
    ['Повышение цены на услуги', 'price_increase'],
    ['Рост цен с 1 ноября', 'price_increase'],
    ['Индексация цен', 'price_increase'],
    ['Повышение стоимости материалов', 'price_increase'],
    ['Price increase', 'price_increase'],
    ['Изменение цен', 'price_change'],
    ['Изменение стоимости услуг', 'price_change'],
    ['Корректировка цен', 'price_change'],
    ['Пересмотр цен', 'price_change'],
    ['Price change notice', 'price_change'],
    ['Новый прайс', 'new_price'],
    ['Новый прайс-лист', 'new_price'],
    ['Обновление прайса', 'new_price'],
    ['Актуальный прайс', 'new_price'],
    ['Новые цены с 1 числа', 'new_price'],
    ['New price list', 'new_price'],
  ] as const)('«%s» -> %s', (subject, id) => {
    expect(ids({ subject })).toContain(id);
  });

  test('падежи и порядок слов в теле письма', () => {
    expect(ids({ body: 'Информируем: стоимости продукции будут пересмотрены' })).toContain(
      'price_change',
    );
    expect(ids({ body: 'Цен металла коснётся повышение' })).toContain('price_increase');
    expect(ids({ body: 'Высылаем прайсы, обновлённые к октябрю' })).toContain('new_price');
  });

  test('каждая фраза-образец из данных находится своим триггером', () => {
    for (const spec of PRICE_MAIL_TRIGGER_SPECS) {
      expect(spec.examples.length, spec.id).toBeGreaterThan(0);
      for (const example of spec.examples) {
        expect(ids({ subject: example }), example).toContain(spec.id);
        expect(ids({ body: example }), example).toContain(spec.id);
      }
    }
  });

  test('ложные срабатывания: прайсовая политика, центр и похожие слова', () => {
    for (const text of [
      'Прайсовая политика',
      'Новая прайсовая политика компании',
      'Центр',
      'Новый центр обработки заказов',
      'Ценность клиента',
      'Ценный груз: повышенная осторожность',
      'Повышение квалификации',
      'Новости об изменениях в графике',
      'Pricey restaurant reviews',
    ]) {
      expect(ids({ subject: text }), text).toEqual([]);
      expect(ids({ body: text }), text).toEqual([]);
    }
  });
});
