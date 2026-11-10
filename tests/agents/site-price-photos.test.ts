import { describe, expect, test } from 'bun:test';
import {
  computeSiteCost,
  computeSitePrice,
  parsePriceLabel,
  pickPriceRange,
} from '../../src/agents/site-export/site-price';
import { namePhotos, nameSitePhotos } from '../../src/agents/site-export/site-photo-names';
import { openChatTemplate } from '../../src/agents/site-export/open-chat-template';
import { PRICE_LIST, buildBook, buildTemplateWorld } from './site-template-support';

/** Цена для сайта: формула, округление, диапазон «по цене» из списка файла; имена фото. */

describe('стоимость для сайта', () => {
  test('без НДС цена x 1,7 x 1,22, с НДС цена x 1,7, округление до рубля', () => {
    expect(computeSiteCost(1000, false)).toBe(2074);
    expect(computeSiteCost(1000, true)).toBe(1700);
    expect(computeSiteCost(1500, false)).toBe(3111);
    // 333 x 1,7 = 566,1 -> 566; 333 x 1,7 x 1,22 = 690,642 -> 691
    expect(computeSiteCost(333, true)).toBe(566);
    expect(computeSiteCost(333, false)).toBe(691);
  });

  test('2755 рублей стоимости - «2-5 тыс.»', () => {
    expect(pickPriceRange(2755, PRICE_LIST)).toEqual({ status: 'ok', value: '2-5 тыс.' });
  });

  test('границы 500..20000: верхняя граница входит в свой интервал', () => {
    const at = (cost: number) => {
      const choice = pickPriceRange(cost, PRICE_LIST);
      return choice.status === 'ok' ? choice.value : choice.status;
    };
    expect(at(1)).toBe('до 500 руб.');
    expect(at(500)).toBe('до 500 руб.');
    expect(at(501)).toBe('до 1 тыс.');
    expect(at(1000)).toBe('до 1 тыс.');
    expect(at(1001)).toBe('до 2 тыс.');
    expect(at(2000)).toBe('до 2 тыс.');
    expect(at(2001)).toBe('2-5 тыс.');
    expect(at(5000)).toBe('2-5 тыс.');
    expect(at(5001)).toBe('5-10 тыс.');
    expect(at(10000)).toBe('5-10 тыс.');
    expect(at(10001)).toBe('10-20 тыс.');
    expect(at(20000)).toBe('10-20 тыс.');
    expect(at(20001)).toBe('более 20 тыс.');
  });

  test('несколько подходящих интервалов: меньшая верхняя граница, порядок не важен', () => {
    const labels = ['до 1 тыс.', 'до 500 руб.', 'до 2 тыс.'];
    for (const order of [labels, [...labels].reverse(), [labels[1], labels[2], labels[0]]]) {
      expect(pickPriceRange(400, order as string[])).toEqual({
        status: 'ok',
        value: 'до 500 руб.',
      });
    }
  });

  test('подписи разбираются текстом: другие формулировки, тире, числа', () => {
    expect(parsePriceLabel('до 1 000 руб.')).toMatchObject({ to: 1000 });
    expect(parsePriceLabel('2–5 тыс.')).toMatchObject({ from: 2000, to: 5000 });
    expect(parsePriceLabel('свыше 20 тыс. руб.')).toMatchObject({ from: 20000 });
    expect(parsePriceLabel(500)).toBeNull();
    expect(pickPriceRange(100, ['дёшево', 'дорого'])).toEqual({
      status: 'list_unparsed',
      labels: ['дёшево', 'дорого'],
    });
  });

  test('инструмент берёт список из файла (workbookId) и принимает свой список', async () => {
    const world = await buildTemplateWorld();
    world.setChatFile('x.xlsx', buildBook());
    const opened = await openChatTemplate.execute({}, world.deps, world.ctx);
    const withVat = await computeSitePrice.execute(
      { supplierPrice: 1620, priceIncludesVat: true, workbookId: opened.workbookId },
      world.deps,
      world.ctx,
    );
    // 1620 x 1,7 = 2754
    expect(withVat).toMatchObject({ cost: 2754, rangeStatus: 'ok', rangeValue: '2-5 тыс.' });
    const noVat = await computeSitePrice.execute(
      { supplierPrice: 1000, priceIncludesVat: false, rangeLabels: PRICE_LIST },
      world.deps,
      world.ctx,
    );
    expect(noVat).toMatchObject({ cost: 2074, rangeValue: '2-5 тыс.' });
    const noList = await computeSitePrice.execute(
      { supplierPrice: 10, priceIncludesVat: false },
      world.deps,
      world.ctx,
    );
    expect(noList.rangeStatus).toBe('no_list');
  });
});

describe('имена фото', () => {
  test('с артикулом: артикул, артикул-1, -2, -3, расширение по умолчанию jpg', () => {
    const [item] = namePhotos([{ sku: 'AB-100', photoCount: 4 }]);
    expect(item?.photos.map((photo) => photo.fileName)).toEqual([
      'AB-100.jpg',
      'AB-100-1.jpg',
      'AB-100-2.jpg',
      'AB-100-3.jpg',
    ]);
    expect(item?.basedOn).toBe('sku');
    expect(item?.photos[0]?.slot).toBe('Основное фото');
  });

  test('без артикула: по короткому названию; расширение и очистка имени', () => {
    const [item] = namePhotos([{ shortName: 'тюбинг', photoCount: 2, extension: '.PNG' }]);
    expect(item?.photos.map((photo) => photo.fileName)).toEqual(['тюбинг.png', 'тюбинг-1.png']);
    expect(item?.basedOn).toBe('short_name');
    const [dirty] = namePhotos([{ sku: ' a/b:c  d?.', photoCount: 1, extension: 'exe!' }]);
    expect(dirty?.photos[0]?.fileName).toBe('a_b_c_d.jpg');
  });

  test('ни артикула, ни названия - no_name; повтор основы получает суффикс', () => {
    const out = namePhotos([
      { photoCount: 1 },
      { sku: 'X1', photoCount: 1 },
      { sku: 'x1', photoCount: 2 },
    ]);
    expect(out[0]).toMatchObject({ status: 'no_name', photos: [] });
    expect(out[2]?.photos.map((photo) => photo.fileName)).toEqual(['x1_2.jpg', 'x1_2-1.jpg']);
    expect(out[2]?.deduplicated).toBe(true);
  });

  test('инструмент применяет значения по умолчанию', async () => {
    const world = await buildTemplateWorld();
    const out = await nameSitePhotos.execute({ items: [{ sku: 'Z9' }] }, world.deps, world.ctx);
    expect(out.items[0]?.photos).toEqual([{ slot: 'Основное фото', fileName: 'Z9.jpg' }]);
  });
});
