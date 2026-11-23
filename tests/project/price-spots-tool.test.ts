import { beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@business-ai/core';
import { resetSpotCache } from '../../src/price-spots';
import type { PriceSpot, PriceSpotMap, PriceSpotReader } from '../../src/price-spots-client';
import { SPOTS_LIST_MAX, listPriceSpots } from '../../src/price-spots-tool';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';

/** Инструмент listPriceSpots: числа вне таблиц слайдов для выбора места (этап 9q). */

function spot(over: Partial<PriceSpot>): PriceSpot {
  return {
    slide: 1,
    shape: '5',
    paragraph: 0,
    start: 0,
    text: '680',
    context: 'Акция: 680',
    ...over,
  };
}

const MAP: PriceSpotMap = {
  spots: [
    spot({ slide: 2, text: '680 ₽', context: 'Акция недели: 680 ₽ за штуку' }),
    spot({ slide: 2, shape: '6', text: '1 200,50 руб.', context: 'Набор 1 200,50 руб.' }),
    spot({ slide: 4, text: '690', context: 'Цена от 690 за штуку' }),
  ],
  unreachable: [
    { slide: 2, shape: '9', kind: 'chart' },
    { slide: 5, shape: '3', kind: 'picture' },
  ],
  truncated: false,
};

let deps: FullPricesDeps;
let ctx: ToolContext;

async function setup(reader: PriceSpotReader | undefined, name = 'Акции.pptx'): Promise<string> {
  resetSpotCache();
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-list', EMPLOYEE_THREAD);
  deps = { ...deps, ...(reader === undefined ? {} : { priceSpots: reader }) };
  const stored = await deps.intake.put(
    EMPLOYEE_THREAD,
    name,
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  );
  return stored.path;
}

function readerOf(map: PriceSpotMap | null): PriceSpotReader {
  return { read: async () => map };
}

describe('список чисел вне таблиц', () => {
  let path = '';
  beforeEach(async () => {
    path = await setup(readerOf(MAP));
  });

  test('числа со слайдом, значением и текстом вокруг; «от N» помечено как неправимое', async () => {
    const out = await listPriceSpots.execute({ path }, deps, ctx);
    expect(out.status).toBe('ok');
    expect(out.total).toBe(3);
    expect(out.spots).toEqual([
      {
        place: 'Слайд 2',
        text: '680 ₽',
        value: 680,
        context: 'Акция недели: 680 ₽ за штуку',
        editable: true,
      },
      {
        place: 'Слайд 2',
        text: '1 200,50 руб.',
        value: 1200.5,
        context: 'Набор 1 200,50 руб.',
        editable: true,
      },
      {
        place: 'Слайд 4',
        text: '690',
        value: 690,
        context: 'Цена от 690 за штуку',
        editable: false,
      },
    ]);
    expect(out.unreachableCount).toBe(2);
  });

  test('слайд сужает список и число недоступных фигур', async () => {
    const out = await listPriceSpots.execute({ path, slide: 2 }, deps, ctx);
    expect(out.total).toBe(2);
    expect(out.spots.every((item) => item.place === 'Слайд 2')).toBe(true);
    expect(out.unreachableCount).toBe(1);
  });

  test('на слайде чисел нет: пустой список с понятным сообщением', async () => {
    const out = await listPriceSpots.execute({ path, slide: 9 }, deps, ctx);
    expect(out.status).toBe('ok');
    expect(out.spots).toEqual([]);
    expect(out.message).toContain('на слайде 9');
  });

  test('вывод ограничен: остальное числом и просьбой назвать слайд', async () => {
    const many: PriceSpotMap = {
      spots: Array.from({ length: SPOTS_LIST_MAX + 5 }, (_, index) =>
        spot({ slide: 1 + index, text: `${100 + index}`, context: `Цена ${100 + index}` }),
      ),
      unreachable: [],
      truncated: true,
    };
    const bigPath = await setup(readerOf(many), 'Большая.pptx');
    const out = await listPriceSpots.execute({ path: bigPath }, deps, ctx);
    expect(out.total).toBe(SPOTS_LIST_MAX + 5);
    expect(out.spots).toHaveLength(SPOTS_LIST_MAX);
    expect(out.truncated).toBe(true);
    expect(out.message).toContain('укажи slide');
    expect(out.message).toContain('обрезал');
  });
});

describe('нет карты', () => {
  test('клиент не подключён (флаг выключен): not_available, ничего не придумывается', async () => {
    const path = await setup(undefined);
    const out = await listPriceSpots.execute({ path }, deps, ctx);
    expect(out.status).toBe('not_available');
    expect(out.spots).toEqual([]);
    expect(out.message).toContain('Не придумывай');
  });

  test('сервис не вернул карту: not_available', async () => {
    const path = await setup(readerOf(null));
    expect((await listPriceSpots.execute({ path }, deps, ctx)).status).toBe('not_available');
  });

  test('не презентация: not_applicable', async () => {
    const path = await setup(readerOf(MAP), 'Прайс.xlsx');
    const out = await listPriceSpots.execute({ path }, deps, ctx);
    expect(out.status).toBe('not_applicable');
  });
});
