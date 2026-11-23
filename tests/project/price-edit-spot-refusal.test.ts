import { describe, expect, test } from 'bun:test';
import { refusedMessage } from '../../src/agents/prices/price-edit-source';
import {
  isSpotRefusal,
  refusalTextOf,
  refusedMessageForSpots,
  spotRefusalKey,
} from '../../src/price-edit-spot-refusal';

/** Тексты отказов правки числа в тексте pdf (этап 9r). Прежние отказы ячеек не меняются. */

const NO_PLACES = new Map<string, string>();

describe('причина отказа по коду', () => {
  test('у числа в тексте часть кодов звучит иначе, чем у ячейки', () => {
    expect(refusalTextOf({ code: 'no_fit', page: 1, spot: 0 })).toContain('длиннее старого');
    expect(refusalTextOf({ code: 'no_fit', table: 0, row: 1, col: 1 })).toBe(
      'новая цена не помещается на месте старой',
    );
    expect(refusalTextOf({ code: 'negative_in_text', page: 1, spot: 0 })).toContain('минус');
  });

  test('новые коды 1.1.9 названы по-человечески', () => {
    for (const code of [
      'spot_not_found',
      'align_unclear',
      'text_edit_disabled',
      'unsupported_layout',
      'write_failed',
    ]) {
      const text = refusalTextOf({ code, page: 1, spot: 0 });
      expect(text).not.toBe(code);
    }
  });

  test('прежние коды у места pdf берутся из общего списка; неизвестный - как есть', () => {
    expect(refusalTextOf({ code: 'price_not_isolated', page: 1, spot: 0 })).toContain('слита');
    expect(refusalTextOf({ code: 'glyph_missing', page: 1, spot: 0 })).toContain('цифр');
    expect(refusalTextOf({ code: 'brand_new_code', page: 1, spot: 0 })).toBe('brand_new_code');
  });

  test('отказ без page/spot: новые тексты не применяются', () => {
    expect(isSpotRefusal({ code: 'spot_not_found' })).toBe(false);
    expect(refusalTextOf({ code: 'spot_not_found' })).toBe('spot_not_found');
  });
});

describe('сообщение об отказе', () => {
  test('без чисел в тексте - слово в слово прежнее сообщение', () => {
    const reasons = [{ code: 'no_fit', table: 0, row: 4, col: 2 }, { code: 'encrypted' }];
    const keyAt = new Map([['0:4', 'Страница 2, строка «Bolt | 400»']]);
    expect(refusedMessageForSpots(reasons, keyAt, NO_PLACES)).toBe(refusedMessage(reasons, keyAt));
  });

  test('число в тексте называется по подписи места, остальное - как раньше', () => {
    const key = spotRefusalKey({ code: 'no_fit', page: 2, spot: 4 });
    expect(key).toBe('pdf:2:4');
    const message = refusedMessageForSpots(
      [
        { code: 'no_fit', page: 2, spot: 4 },
        { code: 'glyph_missing', table: 0, row: 3, col: 2 },
        { code: 'encrypted' },
      ],
      new Map([['0:3', 'Страница 1, строка «A | 5»']]),
      new Map([['pdf:2:4', 'Страница 2, текст «Итого 1 250,00 USD»']]),
    );
    expect(message).toContain('Страница 2, текст «Итого 1 250,00 USD»: новое число длиннее');
    expect(message).toContain('Страница 1, строка «A | 5»: в шрифте файла нет нужных цифр');
    expect(message).toContain('файл целиком: файл зашифрован');
    expect(message).toContain('xlsx-копию');
  });

  test('подписи места нет: называется страница из причины', () => {
    const message = refusedMessageForSpots(
      [{ code: 'spot_not_found', page: 3, spot: 1 }],
      NO_PLACES,
      NO_PLACES,
    );
    expect(message).toContain('Страница 3: числа на этом месте');
  });

  test('больше десяти причин: остальное числом', () => {
    const reasons = Array.from({ length: 12 }, (_, spot) => ({ code: 'no_fit', page: 1, spot }));
    expect(refusedMessageForSpots(reasons, NO_PLACES, NO_PLACES)).toContain('и ещё 2');
  });
});
