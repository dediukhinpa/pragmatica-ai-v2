import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DESCRIPTION_RULES,
  mapCardToTemplate,
  validateDescription,
  validateExportCards,
  type ExportTemplate,
} from '../../../src/kit/domain/site-export';

const TEMPLATE: ExportTemplate = {
  name: 'тест',
  fields: [
    { name: 'sku', type: 'string', required: true, from: 'article' },
    { name: 'title', type: 'string', required: true, from: 'name' },
    { name: 'price', type: 'number', required: true },
    { name: 'inStock', type: 'boolean', required: false },
  ],
  skuField: 'sku',
  priceField: 'price',
};
const codes = (cards: Parameters<typeof validateExportCards>[0]): string[] =>
  validateExportCards(cards, TEMPLATE).map((issue) => issue.code);

describe('mapCardToTemplate', () => {
  test('переименовывает поля, отбрасывает лишнее и пустое, числа из текста приводит', () => {
    const card = mapCardToTemplate(
      { article: ' A-1 ', name: 'Болт', price: '12,5', secret: 'x', inStock: null },
      TEMPLATE,
    );
    expect(card).toEqual({ sku: 'A-1', title: 'Болт', price: 12.5 });
  });

  test('нечисловой текст в числовом поле остаётся как есть (найдёт проверка)', () => {
    expect(mapCardToTemplate({ article: 'A', name: 'Б', price: 'дорого' }, TEMPLATE).price).toBe(
      'дорого',
    );
  });
});

describe('mapCardToTemplate: числа с разделителями', () => {
  const price = (value: string): unknown =>
    mapCardToTemplate({ article: 'A', name: 'Б', price: value }, TEMPLATE).price;

  test('«1.234,50» разбирается, «0,125» - дробь', () => {
    expect(price('1.234,50')).toBe(1234.5);
    expect(price('0,125')).toBe(0.125);
    expect(price('1 234,5')).toBe(1234.5);
  });

  test('«1,234» неоднозначно: остаётся текстом, проверка вернёт wrong_type', () => {
    expect(price('1,234')).toBe('1,234');
    expect(price('1.234')).toBe('1.234');
  });
});

describe('validateExportCards', () => {
  const good = { sku: 'A-1', title: 'Болт', price: 12 };

  test('корректный набор без замечаний', () => {
    expect(codes([good, { ...good, sku: 'A-2' }])).toEqual([]);
  });

  test('пустой набор', () => {
    expect(codes([])).toEqual(['no_cards']);
  });

  test('нет обязательного поля', () => {
    expect(codes([{ sku: 'A-1', price: 12 }])).toEqual(['missing_field']);
  });

  test('неверный тип', () => {
    expect(codes([{ ...good, price: 'дорого' }])).toContain('wrong_type');
    expect(codes([{ ...good, inStock: 'да' }])).toEqual(['wrong_type']);
  });

  test('пустая и неположительная цена — отдельный код, без двойного замечания', () => {
    expect(codes([{ sku: 'A-1', title: 'Болт' }])).toEqual(['empty_price']);
    expect(codes([{ ...good, price: 0 }])).toEqual(['empty_price']);
  });

  test('дубли артикулов без учёта регистра и пробелов', () => {
    expect(codes([good, { ...good, sku: ' a-1 ' }])).toEqual(['duplicate_sku']);
  });

  test('сообщения называют артикул, но не значения прочих полей', () => {
    const [issue] = validateExportCards([{ sku: 'A-1', title: 'СекретныйТовар' }], TEMPLATE);
    expect(issue?.message).toContain('A-1');
    expect(issue?.message).not.toContain('СекретныйТовар');
  });
});

describe('validateDescription', () => {
  const ok = 'Болт М8 из оцинкованной стали, длина 40 мм, поставляется в упаковке по 100 штук.';

  test('нормальное описание проходит', () => {
    expect(validateDescription(ok)).toEqual([]);
  });

  test('слишком короткое и слишком длинное', () => {
    expect(validateDescription('коротко')[0]?.code).toBe('description_too_short');
    const long = 'а'.repeat(DEFAULT_DESCRIPTION_RULES.maxLength + 1);
    expect(validateDescription(long).map((issue) => issue.code)).toContain('description_too_long');
  });

  test('запрещённая фраза без учёта регистра', () => {
    const issues = validateDescription(`${ok} Лучшая цена!`);
    expect(issues.map((issue) => issue.code)).toEqual(['forbidden_phrase']);
  });

  test('правила берутся из переданных', () => {
    const rules = { minLength: 1, maxLength: 10, forbiddenPhrases: ['бан'] };
    expect(validateDescription('бан', rules).map((issue) => issue.code)).toEqual([
      'forbidden_phrase',
    ]);
  });
});
