import { beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@business-ai/core';
import { resetSpotCache } from '../../src/price-spots';
import { listPriceSpots } from '../../src/price-spots-tool';
import type {
  PdfPriceSpot,
  PptxPriceSpot,
  PriceSpotMap,
  PriceSpotReader,
} from '../../src/price-spots-client';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/** Инструмент listPriceSpots для pdf: страница, число, отрывок и заголовок столбца (этап 9r). */

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

const MAP: PriceSpotMap = {
  spots: [
    pdf({ page: 1, text: '1 250,00', context: 'Итого за единицу: 1 250,00 USD' }),
    pdf({
      page: 2,
      spot: 1,
      text: '980,50',
      context: 'Item B | 980,50 | USD',
      textTable: 0,
      header: 'Price',
    }),
    pdf({ page: 2, spot: 2, text: '2026', context: 'Прайс на 2026 год' }),
    pdf({ page: 3, spot: 0, text: '500', context: 'Цена от 500 USD' }),
  ],
  unreachable: [
    { page: 2, kind: 'rotated' },
    { page: 4, kind: 'no_text' },
  ],
  truncated: false,
};

let deps: FullPricesDeps;
let ctx: ToolContext;

async function setup(map: PriceSpotMap | null, name = 'Offer.pdf'): Promise<string> {
  resetSpotCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-list-pdf', EMPLOYEE_THREAD);
  const reader: PriceSpotReader = { read: async () => map };
  deps = { ...deps, priceSpots: reader };
  const stored = await deps.intake.put(EMPLOYEE_THREAD, name, new TextEncoder().encode('%PDF-1.7'));
  return stored.path;
}

describe('список чисел pdf вне таблиц', () => {
  let path = '';
  beforeEach(async () => {
    path = await setup(MAP);
  });

  test('страница, число, отрывок, заголовок столбца; «от N» неправимо', async () => {
    const out = await listPriceSpots.execute({ path }, deps, ctx);
    expect(out.status).toBe('ok');
    expect(out.total).toBe(4);
    expect(out.spots[0]).toEqual({
      place: 'Страница 1',
      text: '1 250,00',
      value: 1250,
      context: 'Итого за единицу: 1 250,00 USD',
      editable: true,
    });
    expect(out.spots[1]).toMatchObject({
      place: 'Страница 2',
      value: 980.5,
      header: 'Price',
      editable: true,
    });
    expect(out.spots[3]).toMatchObject({ place: 'Страница 3', editable: false });
    expect(out.unreachableCount).toBe(2);
  });

  test('page сужает список и число недоступных страниц', async () => {
    const out = await listPriceSpots.execute({ path, page: 2 }, deps, ctx);
    expect(out.total).toBe(2);
    expect(out.spots.every((item) => item.place === 'Страница 2')).toBe(true);
    expect(out.unreachableCount).toBe(1);
  });

  test('slide для pdf: пусто, а не чужие числа', async () => {
    const out = await listPriceSpots.execute({ path, slide: 1 }, deps, ctx);
    expect(out.total).toBe(0);
    expect(out.spots).toEqual([]);
  });

  test('на странице чисел нет: сообщение называет страницу', async () => {
    const out = await listPriceSpots.execute({ path, page: 9 }, deps, ctx);
    expect(out.status).toBe('ok');
    expect(out.message).toContain('на странице 9');
  });

  test('подсказка в сообщении называет page, а не slide', async () => {
    const out = await listPriceSpots.execute({ path }, deps, ctx);
    expect(out.message).toContain('со page и rowText');
  });

  test('описание инструмента говорит и про pdf', () => {
    expect(listPriceSpots.description).toContain('pdf');
    expect(listPriceSpots.description).toContain('page');
  });
});

describe('pdf без карты и смешанная карта', () => {
  test('сервис не вернул карту: not_available', async () => {
    const path = await setup(null);
    expect((await listPriceSpots.execute({ path }, deps, ctx)).status).toBe('not_available');
  });

  test('число презентации и число pdf в одной карте не смешиваются фильтрами', async () => {
    const slideSpot: PptxPriceSpot = {
      kind: 'pptx',
      slide: 1,
      shape: '5',
      paragraph: 0,
      start: 0,
      text: '680',
      context: 'Акция: 680',
    };
    const path = await setup({
      spots: [slideSpot, pdf({ text: '700', context: 'Цена 700' })],
      unreachable: [],
      truncated: false,
    });
    const bySlide = await listPriceSpots.execute({ path, slide: 1 }, deps, ctx);
    expect(bySlide.spots.map((item) => item.place)).toEqual(['Слайд 1']);
    const byPage = await listPriceSpots.execute({ path, page: 1 }, deps, ctx);
    expect(byPage.spots.map((item) => item.place)).toEqual(['Страница 1']);
  });
});
