import { describe, expect, test } from 'bun:test';
import { webPriceText } from '../../src/agents/order-calc/shortlist-message';

describe('цена со страницы сайта в шорт-листе', () => {
  test('подпись - товар страницы, а не позиция заявки; НДС и пометка источника', () => {
    const text = webPriceText(
      { item: 'мед', amount: 1305, currency: 'RUB', unit: '9шт', offer: 'Крем-мёд, 500 г' },
      '₽',
    );
    expect(text).toBe('Крем-мёд, 500 г: 1 305 ₽ за 9 шт (НДС не указан) (ИЗ ИНТЕРНЕТА)');
  });

  test('похожий товар помечен', () => {
    const text = webPriceText(
      { item: 'мед', amount: 1305, currency: 'RUB', offer: 'Крем-мёд', approximate: true },
      '₽',
    );
    expect(text).toBe('Крем-мёд: 1 305 ₽ (НДС не указан; похожий товар) (ИЗ ИНТЕРНЕТА)');
  });

  test('прежняя цена без позиции показывается как раньше', () => {
    expect(webPriceText({ amount: 61800, currency: 'RUB', unit: 'т' }, '₽')).toBe(
      '61 800 ₽/т (НДС не указан) (ИЗ ИНТЕРНЕТА)',
    );
  });

  test('НДС по данным страницы и условия цены', () => {
    const text = webPriceText(
      { item: 'мед', amount: 100, currency: 'RUB', unit: 'кг', note: 'от 32 кг', vat: 'excluded' },
      '₽',
    );
    expect(text).toBe('мед: 100 ₽/кг (без НДС; от 32 кг) (ИЗ ИНТЕРНЕТА)');
  });
});
