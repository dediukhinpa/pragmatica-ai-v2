import { describe, expect, test } from 'bun:test';
import { markdownToTables } from '@business-ai/adapters';
import {
  describeTablePlaces,
  placeLabel,
  tablePlacesFromMarkdown,
  type TablePlace,
} from '../../src/document-places';

/** Образец разбора презентации: три слайда, у второго нет таблиц, у третьего их две. */
const PPTX_SAMPLE = [
  '## Слайд 1: Обзор [hidden]',
  '',
  'Текст без таблиц.',
  '',
  '## Слайд 2',
  '',
  '| Наименование | Количество |',
  '|---|---|',
  '| Товар A | 10 |',
  '',
  '## Слайд 3: Итоги',
  '',
  '| Название | Цена |',
  '| --- | --- |',
  '| Товар A | 5 |',
  '',
  'Пояснение между таблицами.',
  '',
  '| Название | Срок |',
  '|:--|--:|',
  '| Товар B | 3 |',
  '',
].join('\n');

const PDF_SAMPLE = [
  '## Страница 1',
  '',
  'Вводный текст.',
  '',
  '## Страница 2',
  '',
  '| Пункт | Значение |',
  '|---|---|',
  '| Первый | 1 |',
  '',
  '## Страница 3',
  '',
  '| Пункт | Значение |',
  '|---|---|',
  '| Второй | 2 |',
].join('\n');

describe('место таблицы в документе', () => {
  test('слайды: номер, название и признак скрытого', () => {
    const places = tablePlacesFromMarkdown(PPTX_SAMPLE);
    expect(places).toEqual([
      { kind: 'slide', number: 2 },
      { kind: 'slide', number: 3, title: 'Итоги' },
      { kind: 'slide', number: 3, title: 'Итоги' },
    ]);
  });

  test('скрытый слайд с названием и без него разбирается в признак hidden', () => {
    const markdown = [
      '## Слайд 4: План работ [hidden]',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '## Слайд 5 [hidden]',
      '| A | B |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');
    expect(tablePlacesFromMarkdown(markdown)).toEqual([
      { kind: 'slide', number: 4, title: 'План работ', hidden: true },
      { kind: 'slide', number: 5, hidden: true },
    ]);
  });

  test('страницы pdf', () => {
    expect(tablePlacesFromMarkdown(PDF_SAMPLE)).toEqual([
      { kind: 'page', number: 2 },
      { kind: 'page', number: 3 },
    ]);
  });

  test('без заголовков места нет (null для каждой таблицы)', () => {
    const markdown = '| A | B |\n|---|---|\n| 1 | 2 |\n\nТекст\n\n| C |\n|---|\n| 3 |';
    expect(tablePlacesFromMarkdown(markdown)).toEqual([null, null]);
  });

  test('заголовок внутри ячейки или не с начала строки заголовком не считается', () => {
    const markdown = [
      '## Слайд 1',
      '| Колонка | Другая |',
      '|---|---|',
      '| ## Слайд 9 | текст |',
      '',
      'Строка с ## Слайд 7 внутри',
      ' ## Слайд 8',
      '',
      '| X | Y |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    expect(tablePlacesFromMarkdown(markdown)).toEqual([
      { kind: 'slide', number: 1 },
      { kind: 'slide', number: 1 },
    ]);
  });

  test('заголовок после таблицы не относится к ней', () => {
    const markdown = '| A |\n|---|\n| 1 |\n## Страница 5\n| B |\n|---|\n| 2 |';
    expect(tablePlacesFromMarkdown(markdown)).toEqual([null, { kind: 'page', number: 5 }]);
  });

  test('подпись места: слайд, страница, неизвестно', () => {
    const slide: TablePlace = { kind: 'slide', number: 11 };
    const page: TablePlace = { kind: 'page', number: 3, title: 'не используется' };
    expect(placeLabel(slide)).toBe('Слайд 11');
    expect(placeLabel(page)).toBe('Страница 3');
    expect(placeLabel(null)).toBeNull();
  });

  test('описание мест даёт и места, и подписи', () => {
    const described = describeTablePlaces(PPTX_SAMPLE);
    expect(described.places).toHaveLength(3);
    expect(described.labels).toEqual(['Слайд 2', 'Слайд 3', 'Слайд 3']);
    expect(describeTablePlaces('просто текст')).toEqual({ places: [], labels: [] });
  });

  test('перевод строки CRLF не мешает заголовку', () => {
    const markdown = '## Страница 2\r\n\r\n| A |\r\n|---|\r\n| 1 |\r\n';
    expect(tablePlacesFromMarkdown(markdown)).toEqual([{ kind: 'page', number: 2 }]);
  });
});

describe('места таблиц совпадают с разбором таблиц платформы', () => {
  const samples: Record<string, string> = {
    pptx: PPTX_SAMPLE,
    pdf: PDF_SAMPLE,
    'пусто': '',
    'строка с | в обычном тексте без разделителя': 'Абзац\n| не таблица\nещё текст\n| и снова',
    'две таблицы подряд': '| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |\n| C |\n|---|\n| 3 |',
    'таблица в конце без перевода строки': 'Текст\n| A | B |\n|---|---|\n| 1 | 2 |',
    'последняя строка с | без перевода строки': 'Текст\n| A | B |',
    'заголовок без таблиц': '## Слайд 1\n\nТекст\n## Слайд 2',
    'разделитель вместо первой строки': '|---|---|\n| 1 | 2 |',
    'таблица вплотную к заголовку': '## Страница 1\n| A |\n|---|\n## Страница 2\n| B |\n|---|',
    'экранированная вертикальная черта': '| a \\| b | c |\n|---|---|\n| 1 | 2 |',
    'перевод строки CRLF': '| A |\r\n|---|\r\n| 1 |\r\n\r\n| B |\r\n|---|\r\n',
  };

  for (const [name, markdown] of Object.entries(samples)) {
    test(`длина результата равна числу таблиц: ${name}`, () => {
      expect(tablePlacesFromMarkdown(markdown)).toHaveLength(markdownToTables(markdown).length);
    });
  }
});

describe('случайные сборки строк', () => {
  /** Фрагменты, из которых собираются строки: границы таблиц, заголовки, обычный текст. */
  const PIECES = [
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '|',
    '## Слайд 3',
    '## Страница 4: Название',
    '## Слайд 5 [hidden]',
    '## Слайд',
    'Обычный текст',
    '',
    '  | с отступом |',
  ];
  /** Псевдослучайный генератор с фиксированным зерном: тест воспроизводим. */
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  test('длина результата равна числу таблиц на 300 случайных текстах', () => {
    const random = generator(20_260_101);
    for (let round = 0; round < 300; round += 1) {
      const count = 1 + Math.floor(random() * 12);
      const lines: string[] = [];
      for (let index = 0; index < count; index += 1) {
        lines.push(PIECES[Math.floor(random() * PIECES.length)] ?? '');
      }
      const markdown = lines.join(random() < 0.5 ? '\n' : '\r\n') + (random() < 0.5 ? '\n' : '');
      expect(tablePlacesFromMarkdown(markdown)).toHaveLength(markdownToTables(markdown).length);
    }
  });
});
