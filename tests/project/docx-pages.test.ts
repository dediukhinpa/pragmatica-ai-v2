import { describe, expect, test } from 'bun:test';
import {
  annotateTextWithPages,
  normalizeForPageMatch,
  pageOfTables,
  type RenderedPage,
} from '../../src/docx-pages';

/** Тексты страниц синтетического договора, как их отдаёт отрисовка. */
const PAGES: RenderedPage[] = [
  {
    number: 1,
    text: [
      'Договор №1',
      'г. Москва',
      '1.1. Исполнитель обязуется передать Товар A в количестве десяти штук.',
      'Подписи сторон',
      'Заказчик ______ Исполнитель ______',
    ].join('\n'),
  },
  {
    number: 2,
    text: [
      '2.1. Стоимость товара определяется спецификацией к договору.',
      'Наименование\tКоличество\tСрок',
      'Товар A\t10\tнеделя',
      'Товар B\t20\tдве недели',
      'Товар C\t30\tмесяц',
      'Подписи сторон',
    ].join('\n'),
  },
  {
    number: 3,
    text: [
      '3.1. Срок действия договора составляет один год.',
      'Реквизиты сторон',
      'Подписи сторон',
    ].join('\n'),
  },
];

const MARKDOWN = [
  '# Договор №1',
  '',
  'г. Москва',
  '',
  '1.1. Исполнитель обязуется передать Товар A в количестве десяти штук.',
  '',
  '**Подписи сторон**',
  '',
  'Заказчик ______ Исполнитель ______',
  '',
  '2.1. Стоимость товара определяется спецификацией к договору.',
  '',
  '| Наименование | Количество | Срок |',
  '|---|---|---|',
  '| Товар A | 10 | неделя |',
  '| Товар B | 20 | две недели |',
  '| Товар C | 30 | месяц |',
  '',
  'Подписи сторон',
  '',
  '3.1. Срок действия договора составляет один год.',
  '',
  'Реквизиты сторон',
  '',
  'Подписи сторон',
].join('\n');

describe('нормализация для сопоставления', () => {
  test('регистр, пробелы, разделители таблицы и пунктуация убираются', () => {
    expect(normalizeForPageMatch('| Товар  A |\t10, шт. |')).toBe('товар a 10 шт');
    expect(normalizeForPageMatch('Ёлка')).toBe('елка');
    expect(normalizeForPageMatch('пере­нос')).toBe('перенос');
    expect(normalizeForPageMatch('|---|---|')).toBe('');
  });
});

describe('страница таблицы по фактической раскладке', () => {
  test('таблица находится на своей странице', () => {
    const tables = [
      [
        ['Наименование', 'Количество', 'Срок'],
        ['Товар A', '10', 'неделя'],
        ['Товар B', '20', 'две недели'],
        ['Товар C', '30', 'месяц'],
      ],
    ];
    expect(pageOfTables(tables, PAGES)).toEqual([2]);
  });

  test('несколько таблиц идут монотонно вперёд, повтор шапки не уводит назад', () => {
    const header = ['Наименование', 'Количество', 'Срок'];
    const pages: RenderedPage[] = [
      { number: 1, text: 'Наименование Количество Срок\nТовар A 10 неделя' },
      { number: 2, text: 'Наименование Количество Срок\nТовар B 20 две недели' },
      { number: 3, text: 'Итоговая таблица\nВсего позиций три штуки' },
    ];
    const tables = [
      [header, ['Товар A', '10', 'неделя']],
      [header, ['Товар B', '20', 'две недели']],
      [['Итоговая таблица'], ['Всего позиций три штуки']],
    ];
    expect(pageOfTables(tables, pages)).toEqual([1, 2, 3]);
  });

  test('ненайденная и слишком короткая таблицы дают null, остальные не страдают', () => {
    const tables = [
      [['Совсем другой текст таблицы'], ['которого нет в документе']],
      [['A'], ['1']],
      [
        ['Наименование', 'Количество', 'Срок'],
        ['Товар A', '10', 'неделя'],
      ],
    ];
    expect(pageOfTables(tables, PAGES)).toEqual([null, null, 2]);
  });

  test('пустые страницы и пустые таблицы дают null', () => {
    expect(pageOfTables([[['Наименование', 'Количество', 'Срок']]], [])).toEqual([null]);
    expect(pageOfTables([[], [['', '']]], PAGES)).toEqual([null, null]);
    expect(pageOfTables([], PAGES)).toEqual([]);
  });

  test('шапка длиннее первой строки: берётся первая содержательная строка', () => {
    const tables = [[['№', 'шт'], ['Наименование', 'Количество', 'Срок']]];
    expect(pageOfTables(tables, PAGES)).toEqual([2]);
  });
});

describe('разметка текста номерами страниц', () => {
  test('маркеры ставятся при смене страницы, таблица не разрывается', () => {
    const result = annotateTextWithPages(MARKDOWN, PAGES);
    expect(result.pagesKnown).toBe(true);
    expect(result.pageCount).toBe(3);
    expect(result.matchedBlocks).toBe(result.totalBlocks);
    const lines = result.text.split('\n');
    const markers = lines.filter((line) => /^\[стр\. \d+\]$/.test(line));
    expect(markers).toEqual(['[стр. 1]', '[стр. 2]', '[стр. 3]']);
    // Маркер стоит перед своим блоком, окружён пустыми строками.
    const first = lines.indexOf('[стр. 1]');
    // Короткие блоки («Договор №1», «г. Москва») не ищутся: маркер перед первым найденным.
    expect(lines.slice(first - 1, first + 3)).toEqual([
      '',
      '[стр. 1]',
      '',
      '1.1. Исполнитель обязуется передать Товар A в количестве десяти штук.',
    ]);
    const second = lines.indexOf('[стр. 2]');
    expect(lines[second - 1]).toBe('');
    expect(lines[second + 1]).toBe('');
    expect(lines[second + 2]).toBe('2.1. Стоимость товара определяется спецификацией к договору.');
    // Строки таблицы идут подряд: маркер внутрь не попал.
    const head = lines.indexOf('| Наименование | Количество | Срок |');
    expect(lines.slice(head, head + 5)).toEqual([
      '| Наименование | Количество | Срок |',
      '|---|---|---|',
      '| Товар A | 10 | неделя |',
      '| Товар B | 20 | две недели |',
      '| Товар C | 30 | месяц |',
    ]);
  });

  test('исходный текст сохраняется, если убрать маркеры', () => {
    const result = annotateTextWithPages(MARKDOWN, PAGES);
    const collapse = (text: string): string => text.replace(/\n{2,}/g, '\n');
    const withoutMarkers = result.text.replace(/\[стр\. \d+\]/g, '');
    expect(collapse(withoutMarkers)).toBe(collapse(MARKDOWN));
  });

  test('повтор «Подписи сторон» на каждой странице не ломает монотонность', () => {
    const result = annotateTextWithPages(MARKDOWN, PAGES);
    const lines = result.text.split('\n');
    const pageAt = (needle: string): number => {
      const at = lines.findIndex((line) => line.includes(needle));
      const before = lines.slice(0, at).filter((line) => /^\[стр\. \d+\]$/.test(line));
      return Number((before.at(-1) ?? '').replace(/\D/g, ''));
    };
    expect(pageAt('Заказчик ______')).toBe(1);
    expect(pageAt('2.1. Стоимость')).toBe(2);
    expect(pageAt('3.1. Срок действия')).toBe(3);
    // Подписи после таблицы остаются на странице 3 (где закончилась таблица), а не откатываются.
    const numbers = lines
      .filter((line) => /^\[стр\. \d+\]$/.test(line))
      .map((line) => Number(line.replace(/\D/g, '')));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  test('таблица на границе страниц получает страницу начала', () => {
    const pages: RenderedPage[] = [
      { number: 1, text: 'Вводная часть документа.\nПоз Количество Срок\nТовар A 10 неделя' },
      { number: 2, text: 'Товар B 20 две недели\nЗаключительная часть документа.' },
    ];
    const markdown = [
      'Вводная часть документа.',
      '',
      '| Поз | Количество | Срок |',
      '|---|---|---|',
      '| Товар A | 10 | неделя |',
      '| Товар B | 20 | две недели |',
      '',
      'Заключительная часть документа.',
    ].join('\n');
    const result = annotateTextWithPages(markdown, pages);
    expect(result.pagesKnown).toBe(true);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('[стр. 1]');
    expect(lines.filter((line) => line.startsWith('[стр.'))).toEqual(['[стр. 1]', '[стр. 2]']);
    // Маркер второй страницы стоит перед абзацем после таблицы, не внутри неё.
    const second = lines.indexOf('[стр. 2]');
    expect(lines[second + 2]).toBe('Заключительная часть документа.');
    expect(lines[second - 2]).toBe('| Товар B | 20 | две недели |');
  });

  test('нераспознанный текст (страницы от другого документа): текст без изменений', () => {
    const other: RenderedPage[] = [
      { number: 1, text: 'Совершенно посторонний текст первой страницы' },
      { number: 2, text: 'Ничего общего с исходным документом нет' },
    ];
    const result = annotateTextWithPages(MARKDOWN, other);
    expect(result.pagesKnown).toBe(false);
    expect(result.text).toBe(MARKDOWN);
    expect(result.matchedBlocks).toBe(0);
    expect(result.totalBlocks).toBeGreaterThan(0);
    expect(result.pageCount).toBe(2);
  });

  test('слишком малая доля найденных блоков: страница не определена', () => {
    // Из пяти содержательных блоков на страницах найден один.
    const markdown = [
      'Единственный найденный абзац документа.',
      'Первый потерянный абзац без следа в тексте страниц.',
      'Второй потерянный абзац без следа в тексте страниц.',
      'Третий потерянный абзац без следа в тексте страниц.',
      'Четвёртый потерянный абзац без следа в тексте страниц.',
    ].join('\n\n');
    const pages: RenderedPage[] = [{ number: 1, text: 'Единственный найденный абзац документа.' }];
    const result = annotateTextWithPages(markdown, pages);
    expect(result.matchedBlocks).toBe(1);
    expect(result.totalBlocks).toBe(5);
    expect(result.pagesKnown).toBe(false);
    expect(result.text).toBe(markdown);
  });

  test('пустые pages: страницы неизвестны, текст без изменений', () => {
    const result = annotateTextWithPages(MARKDOWN, []);
    expect(result).toEqual({
      text: MARKDOWN,
      pagesKnown: false,
      matchedBlocks: 0,
      totalBlocks: result.totalBlocks,
      pageCount: 0,
    });
  });

  test('короткие блоки не учитываются в долях', () => {
    const pages: RenderedPage[] = [{ number: 1, text: 'Достаточно длинный абзац документа' }];
    const markdown = 'Да\n\nДостаточно длинный абзац документа\n\n1.\n\nНет';
    const result = annotateTextWithPages(markdown, pages);
    expect(result.totalBlocks).toBe(1);
    expect(result.matchedBlocks).toBe(1);
    expect(result.text.startsWith('Да\n\n[стр. 1]\n\nДостаточно')).toBe(true);
  });

  test('абзац, начало которого на одной странице, а продолжение на другой, находится', () => {
    const pages: RenderedPage[] = [
      { number: 1, text: 'Первый абзац первой страницы целиком.\nНачало длинного абзаца, которое' },
      { number: 2, text: 'переходит на вторую страницу.\nПоследний абзац документа здесь.' },
    ];
    const markdown = [
      'Первый абзац первой страницы целиком.',
      'Начало длинного абзаца, которое переходит на вторую страницу.',
      'Последний абзац документа здесь.',
    ].join('\n\n');
    const result = annotateTextWithPages(markdown, pages);
    expect(result.matchedBlocks).toBe(3);
    expect(result.pagesKnown).toBe(true);
    expect(result.text.startsWith('[стр. 1]\n\nПервый абзац')).toBe(true);
    // Абзац принадлежит странице начала; маркер второй страницы - перед следующим блоком.
    const lines = result.text.split('\n');
    const second = lines.indexOf('[стр. 2]');
    expect(lines[second - 2]).toContain('которое переходит на вторую страницу');
    expect(lines[second + 2]).toBe('Последний абзац документа здесь.');
  });

  test('пустой markdown: нечего размечать', () => {
    const result = annotateTextWithPages('', PAGES);
    expect(result.pagesKnown).toBe(false);
    expect(result.text).toBe('');
    expect(result.totalBlocks).toBe(0);
  });
});
