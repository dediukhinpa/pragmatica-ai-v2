import type { PriceItem } from '../../../../src/kit/domain/models';

export const OLD_DATE = '2026-01-01T00:00:00.000Z';

export function item(name: string, price: number, extra: Partial<PriceItem> = {}): PriceItem {
  return { supplierId: 's1', productName: name, price, currency: 'RUB', date: OLD_DATE, ...extra };
}
