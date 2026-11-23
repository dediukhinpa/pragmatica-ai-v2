import { beforeEach, describe, expect, test } from 'bun:test';
import {
  findSpotCandidates,
  isEditableSpot,
  isPlainPrice,
  isQualifiedInContext,
  loadSpotMap,
  resetSpotCache,
  slidePlace,
  spotExcerpt,
  spotKey,
} from '../../src/price-spots';
import type {
  PriceSpot,
  PriceSpotFile,
  PriceSpotReader,
  PptxPriceSpot,
} from '../../src/price-spots-client';
import type { PriceSource } from '../../src/agents/prices/price-sources';

/** Поиск цены среди чисел вне таблиц слайдов (этап 9q). Данные синтетические. */

function spot(
  over: Partial<PptxPriceSpot> & Pick<PptxPriceSpot, 'text' | 'context'>,
): PptxPriceSpot {
  return { kind: 'pptx', slide: 1, shape: '5', paragraph: 0, start: 0, ...over };
}

/** Слайд и фигура места pptx (у места другого вида - undefined). */
function slideOf(item: PriceSpot): number | undefined {
  return item.kind === 'pptx' ? item.slide : undefined;
}
function shapeOf(item: PriceSpot | undefined): string | undefined {
  return item?.kind === 'pptx' ? item.shape : undefined;
}

const SPOTS: PptxPriceSpot[] = [
  spot({ slide: 1, text: '680', context: 'Болт М8: 680' }),
  spot({ slide: 2, shape: '7/12', text: '680 ₽', context: 'Акция недели: 680 ₽ за штуку' }),
  spot({ slide: 2, shape: '7/13', text: '1 200,50 руб.', context: 'Набор 1 200,50 руб.' }),
  spot({ slide: 3, text: '2026', context: 'Прайс на 2026 год' }),
];

describe('цена как число', () => {
  test('валюта и разделители не мешают сравнению со старой ценой', () => {
    expect(isPlainPrice('680 ₽', 680)).toBe(true);
    expect(isPlainPrice('1 200,50 руб.', 1200.5)).toBe(true);
    expect(isPlainPrice('680', 681)).toBe(false);
    expect(isPlainPrice('от 680', 680)).toBe(false);
  });
});

describe('поиск числа среди текстовых блоков', () => {
  test('находит по старой цене во всех слайдах', () => {
    const found = findSpotCandidates(SPOTS, { oldPrice: 680 });
    expect(found.map(slideOf)).toEqual([1, 2]);
  });

  test('слайд сужает поиск', () => {
    const found = findSpotCandidates(SPOTS, { oldPrice: 680, slide: 2 });
    expect(found).toHaveLength(1);
    expect(shapeOf(found[0])).toBe('7/12');
  });

  test('слова из строки ищутся в контексте, регистр не важен', () => {
    const found = findSpotCandidates(SPOTS, { oldPrice: 680, rowText: 'АКЦИЯ  недели' });
    expect(found.map(slideOf)).toEqual([2]);
  });

  test('цена с пробелами в тысячах и запятой находится числом', () => {
    expect(findSpotCandidates(SPOTS, { oldPrice: 1200.5 })).toHaveLength(1);
  });

  test('указание, относящееся к таблице, текстовые блоки исключает', () => {
    for (const only of [{ table: 0 }, { row: 1 }, { sheet: 'Прайс' }, { page: 2 }]) {
      expect(findSpotCandidates(SPOTS, { oldPrice: 680, ...only })).toEqual([]);
    }
  });

  test('нет такой цены: пусто', () => {
    expect(findSpotCandidates(SPOTS, { oldPrice: 999 })).toEqual([]);
  });
});

describe('«от», «до» и диапазон не точные цены', () => {
  test('«от 680»: число не правится как точная цена', () => {
    const from = spot({ text: '680', context: 'Цена от 680 за штуку' });
    expect(isQualifiedInContext(from)).toBe(true);
    expect(findSpotCandidates([from], { oldPrice: 680 })).toEqual([]);
    expect(isEditableSpot(from)).toBe(false);
  });

  test('«до 680», «100-680», «680-900»: край диапазона', () => {
    for (const context of ['Скидка до 680 руб', 'Цена 100-680 руб', 'Цена 680-900 руб']) {
      expect(isQualifiedInContext(spot({ text: '680', context }))).toBe(true);
    }
  });

  test('число встречается в контексте дважды: положение неизвестно, число не исключается', () => {
    const twice = spot({ text: '680', context: 'от 680 до 680' });
    expect(isQualifiedInContext(twice)).toBe(false);
  });

  test('обычная фраза с ценой правится', () => {
    expect(isEditableSpot(spot({ text: '680 ₽', context: 'Акция недели: 680 ₽ за штуку' }))).toBe(
      true,
    );
  });
});

describe('подписи места', () => {
  test('слайд и ключ локатора', () => {
    expect(slidePlace(11)).toBe('Слайд 11');
    expect(spotKey({ slide: 2, shape: '7/12', paragraph: 1, start: 8 })).toBe('2:7/12:1:8');
  });

  test('отрывок содержит число и не длиннее предела', () => {
    const long = spot({
      text: '680',
      context: `${'слово '.repeat(20)}680${' слово'.repeat(20)}`,
    });
    const excerpt = spotExcerpt(long, 40);
    expect(excerpt).toContain('680');
    expect(excerpt.length).toBeLessThanOrEqual(42);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('короткий контекст отдаётся целиком', () => {
    expect(spotExcerpt(spot({ text: '5', context: ' цена 5 ' }), 40)).toBe('цена 5');
  });
});

describe('чтение карты с кэшем', () => {
  beforeEach(resetSpotCache);

  function source(name: string, hash = 'h1', onDisk = false): PriceSource {
    const base = {
      path: `/chat/${name}`,
      name,
      hash,
      kind: 'chat',
      read: async () => new Uint8Array([1, 2, 3]),
      meta: {},
    };
    const disk = { path: '/tmp/x.pptx', size: 3 };
    return (onDisk ? { ...base, disk: async () => disk } : base) as unknown as PriceSource;
  }

  class CountingReader implements PriceSpotReader {
    files: PriceSpotFile[] = [];
    constructor(private readonly answer: 'map' | 'null' | 'throw' = 'map') {}
    async read(file: PriceSpotFile) {
      this.files.push(file);
      if (this.answer === 'throw') throw new Error('сбой');
      return this.answer === 'null' ? null : { spots: SPOTS, unreachable: [], truncated: false };
    }
  }

  test('второй вызов за тот же файл сервис не спрашивает', async () => {
    const reader = new CountingReader();
    const deps = { priceSpots: reader };
    expect((await loadSpotMap(deps, source('a.pptx')))?.spots).toHaveLength(SPOTS.length);
    await loadSpotMap(deps, source('a.pptx'));
    expect(reader.files).toHaveLength(1);
  });

  test('нет клиента или не презентация: null, сервис не спрашивается', async () => {
    const reader = new CountingReader();
    expect(await loadSpotMap({}, source('a.pptx'))).toBeNull();
    expect(await loadSpotMap({ priceSpots: reader }, source('a.xlsx'))).toBeNull();
    expect(reader.files).toHaveLength(0);
  });

  test('файл на диске уходит с диска, а не байтами в памяти', async () => {
    const reader = new CountingReader();
    await loadSpotMap({ priceSpots: reader }, source('b.pptx', 'h2', true));
    expect(reader.files[0]?.disk).toBeDefined();
    expect(reader.files[0]?.bytes).toBeUndefined();
  });

  test('неудача и исключение дают null и в кэше не остаются', async () => {
    const failing = new CountingReader('throw');
    expect(await loadSpotMap({ priceSpots: failing }, source('c.pptx', 'h3'))).toBeNull();
    const empty = new CountingReader('null');
    expect(await loadSpotMap({ priceSpots: empty }, source('d.pptx', 'h4'))).toBeNull();
    await Promise.resolve();
    await loadSpotMap({ priceSpots: empty }, source('d.pptx', 'h4'));
    expect(empty.files).toHaveLength(2);
  });
});
