import type { PurchaseRequest } from '../../../../src/kit/domain/models';

/** Момент «сейчас» для сравнения КП: после получения, до окончания срока действия. */
export const NOW = new Date('2026-01-10T00:00:00.000Z');
/** Заявка из двух позиций, под которую собираются КП в тестах сравнения. */
export const REQUEST: PurchaseRequest = {
  id: 'r1',
  dealRef: 'D',
  items: [
    { name: 'Арматура', quantity: 100, unit: 'м' },
    { name: 'Сетка', quantity: 10, unit: 'шт' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
};
