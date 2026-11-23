import { describe, expect, test } from 'bun:test';
import {
  isoDateOrInstantSchema,
  isoDeadlineSchema,
  isoInstantSchema,
  normalizeIsoDeadline,
  parseIsoDeadline,
  parseIsoInstant,
} from '../../../src/kit/domain/iso-datetime';
import {
  priceItemSchema,
  purchaseRequestSchema,
  supplierQuoteSchema,
} from '../../../src/kit/domain/models';

const BAD_INSTANTS = [
  '2026-01-02T18:00:00', // без пояса
  '2026-01-02T18:00', // без пояса
  '01.02.2026 18:00',
  '01/02/2026',
  '2026-02-30',
  '2026-02-30T10:00:00Z',
  '2026-13-01T10:00:00Z',
  '2026-01-02T24:00:00Z',
  '2026-01-02T10:60:00Z',
  '2026-01-02T10:00:00+24:00',
  '2026-01-02',
  '2 января 2026',
  '',
];

describe('parseIsoInstant', () => {
  test('момент с поясом разбирается однозначно', () => {
    expect(parseIsoInstant('2026-01-02T18:00:00+03:00')).toBe(Date.UTC(2026, 0, 2, 15));
    expect(parseIsoInstant('2026-01-02T15:00:00Z')).toBe(Date.UTC(2026, 0, 2, 15));
    expect(parseIsoInstant('2026-01-02T15:00:00.250Z')).toBe(Date.UTC(2026, 0, 2, 15, 0, 0, 250));
    expect(parseIsoInstant('2026-01-02T10:00:00-05:00')).toBe(Date.UTC(2026, 0, 2, 15));
  });

  test('високосный день существует только в високосный год', () => {
    expect(parseIsoInstant('2028-02-29T00:00:00Z')).toBeDefined();
    expect(parseIsoInstant('2026-02-29T00:00:00Z')).toBeUndefined();
  });

  test.each(BAD_INSTANTS)('отказ: %p', (input) => {
    expect(parseIsoInstant(input)).toBeUndefined();
    expect(isoInstantSchema.safeParse(input).success).toBe(false);
  });
});

describe('срок без времени - конец суток по МСК', () => {
  test('дата без времени = 23:59:59.999 МСК', () => {
    expect(parseIsoDeadline('2026-01-02')).toBe(Date.UTC(2026, 0, 2, 20, 59, 59, 999));
    expect(normalizeIsoDeadline('2026-01-02')).toBe('2026-01-02T23:59:59.999+03:00');
  });

  test('схема нормализует дату и оставляет момент', () => {
    expect(isoDeadlineSchema.parse('2026-01-02')).toBe('2026-01-02T23:59:59.999+03:00');
    expect(isoDeadlineSchema.parse('2026-01-02T10:00:00Z')).toBe('2026-01-02T10:00:00Z');
  });

  test.each(['2026-02-30', '01.02.2026', '01/02/2026', '2026-01-02T18:00:00', 'вчера'])(
    'отказ: %p',
    (input) => {
      expect(isoDeadlineSchema.safeParse(input).success).toBe(false);
      expect(parseIsoDeadline(input)).toBeUndefined();
    },
  );

  test('дата позиции прайса: дата или момент с поясом, без правок значения', () => {
    expect(isoDateOrInstantSchema.parse('2026-01-02')).toBe('2026-01-02');
    expect(isoDateOrInstantSchema.safeParse('2026-01-02T18:00:00').success).toBe(false);
    expect(isoDateOrInstantSchema.safeParse('01.02.2026').success).toBe(false);
  });
});

describe('применение в моделях', () => {
  const request = {
    id: 'r1',
    dealRef: 'd1',
    items: [{ name: 'Болт', quantity: 1, unit: 'шт' }],
    createdAt: '2026-01-01T10:00:00Z',
  };

  test('createdAt заявки: без пояса и «01.02.2026» отклоняются', () => {
    expect(purchaseRequestSchema.safeParse(request).success).toBe(true);
    for (const createdAt of ['2026-01-02T18:00:00', '01.02.2026 18:00', '2026-02-30T10:00:00Z']) {
      expect(purchaseRequestSchema.safeParse({ ...request, createdAt }).success).toBe(false);
    }
  });

  test('validUntil КП: дата без времени не истекает в начале суток', () => {
    const quote = supplierQuoteSchema.parse({
      id: 'q',
      requestId: 'r1',
      supplierId: 's',
      lines: [{ productName: 'Болт' }],
      currency: 'RUB',
      receivedAt: '2026-01-01T10:00:00Z',
      validUntil: '2026-01-02',
    });
    expect(Date.parse(quote.validUntil ?? '')).toBe(Date.UTC(2026, 0, 2, 20, 59, 59, 999));
    expect(
      supplierQuoteSchema.safeParse({ ...quote, validUntil: '01/02/2026' }).success,
    ).toBe(false);
  });

  test('дата позиции прайса проверяется строго', () => {
    const item = { supplierId: 's', productName: 'Болт', price: 1, currency: 'RUB' };
    expect(priceItemSchema.safeParse({ ...item, date: '2026-01-02' }).success).toBe(true);
    expect(priceItemSchema.safeParse({ ...item, date: '2026-02-30' }).success).toBe(false);
    expect(priceItemSchema.safeParse({ ...item, date: '01.02.2026' }).success).toBe(false);
    expect(priceItemSchema.safeParse({ ...item, date: '2026-01-02T10:00:00' }).success).toBe(false);
  });
});
