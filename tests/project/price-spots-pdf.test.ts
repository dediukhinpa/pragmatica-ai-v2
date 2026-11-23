import { describe, expect, test } from 'bun:test';
import {
  findSpotCandidates,
  isEditableSpot,
  keyOfSpot,
  pagePlace,
  pdfSpotKey,
  spotKey,
  spotPlace,
} from '../../src/price-spots';
import type { PdfPriceSpot, PptxPriceSpot, PriceSpot } from '../../src/price-spots-client';

/** Поиск цены среди чисел PDF вне таблиц с линиями (этап 9r). Данные синтетические. */

function pdf(over: Partial<PdfPriceSpot> & Pick<PdfPriceSpot, 'text' | 'context'>): PdfPriceSpot {
  return {
    kind: 'pdf',
    page: 1,
    spot: 0,
    textTable: null,
    row: null,
    col: null,
    header: null,
    ...over,
  };
}

const SENTENCE = pdf({ page: 1, spot: 0, text: '1 250,00', context: 'Итого: 1 250,00 USD' });
const COLUMN_A = pdf({
  page: 2,
  spot: 1,
  text: '1 250,00',
  context: 'Item A | 1 250,00 | USD',
  textTable: 0,
  row: 1,
  col: 1,
  header: 'Price',
});
const COLUMN_B = pdf({ page: 2, spot: 2, text: '980,50', context: 'Item B | 980,50 | USD' });
const PDF_SPOTS: PdfPriceSpot[] = [SENTENCE, COLUMN_A, COLUMN_B];

const SLIDE_SPOT: PptxPriceSpot = {
  kind: 'pptx',
  slide: 2,
  shape: '5',
  paragraph: 0,
  start: 0,
  text: '1 250,00',
  context: 'Акция 1 250,00',
};

describe('поиск числа среди мест pdf', () => {
  test('находит по старой цене на всех страницах, число с пробелом и запятой - числом', () => {
    expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 1250 })).toEqual([SENTENCE, COLUMN_A]);
    expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 980.5 })).toEqual([COLUMN_B]);
  });

  test('страница из указания сотрудника сужает поиск', () => {
    expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 1250, page: 2 })).toEqual([COLUMN_A]);
    expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 1250, page: 3 })).toEqual([]);
  });

  test('слова из строки ищутся в контексте, регистр и пробелы не важны', () => {
    const found = findSpotCandidates(PDF_SPOTS, { oldPrice: 1250, rowText: 'ITEM   a' });
    expect(found).toEqual([COLUMN_A]);
  });

  test('слова можно взять и из заголовка столбца таблицы без линий', () => {
    expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 1250, rowText: 'price' })).toEqual([COLUMN_A]);
  });

  test('слайд к pdf не подходит', () => {
    expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 1250, slide: 1 })).toEqual([]);
  });

  test('указания таблицы, строки и листа относятся к ячейкам: мест pdf нет', () => {
    for (const only of [{ table: 0 }, { row: 1 }, { sheet: 'Прайс' }]) {
      expect(findSpotCandidates(PDF_SPOTS, { oldPrice: 1250, ...only })).toEqual([]);
    }
  });

  test('«от», «до» и диапазон по контексту исключают число, как у pptx', () => {
    const from = pdf({ text: '1 250,00', context: 'Цена от 1 250,00 USD' });
    const upTo = pdf({ text: '1 250,00', context: 'Скидка до 1 250,00 USD' });
    const range = pdf({ text: '1 250,00', context: 'Цена 1 250,00-1 500,00 USD' });
    for (const spot of [from, upTo, range]) {
      expect(findSpotCandidates([spot], { oldPrice: 1250 })).toEqual([]);
      expect(isEditableSpot(spot)).toBe(false);
    }
    expect(isEditableSpot(SENTENCE)).toBe(true);
  });

  test('число без валюты в тексте места не мешает разбору цены', () => {
    expect(isEditableSpot(pdf({ text: '12', context: 'Qty 12 pcs' }))).toBe(true);
  });

  test('смешанная карта: слайд подходит только местам pptx, страница - только pdf', () => {
    const mixed: PriceSpot[] = [SLIDE_SPOT, SENTENCE];
    expect(findSpotCandidates(mixed, { oldPrice: 1250, slide: 2 })).toEqual([SLIDE_SPOT]);
    expect(findSpotCandidates(mixed, { oldPrice: 1250, page: 1 })).toEqual([SENTENCE]);
  });
});

describe('подписи и ключи мест pdf', () => {
  test('метка «Страница N» и ключ не совпадают с ключом слайда', () => {
    expect(pagePlace(3)).toBe('Страница 3');
    expect(spotPlace(COLUMN_A)).toBe('Страница 2');
    expect(spotPlace(SLIDE_SPOT)).toBe('Слайд 2');
    expect(pdfSpotKey({ page: 2, spot: 1 })).toBe('pdf:2:1');
    expect(keyOfSpot(COLUMN_A)).toBe('pdf:2:1');
    expect(keyOfSpot(SLIDE_SPOT)).toBe(spotKey(SLIDE_SPOT));
    expect(keyOfSpot(SLIDE_SPOT)).not.toBe(keyOfSpot(COLUMN_A));
  });
});
