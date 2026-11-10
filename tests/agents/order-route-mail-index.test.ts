import { describe, expect, test } from 'bun:test';
import { buildSentIndex, routeMail } from '../../src/agents/order-calc/reply-routing';
import { sentSchema, type SentRecord } from '../../src/agents/order-calc/state';

const SENT_AT = '2026-03-01T00:00:00.000Z';
const AFTER = '2026-03-02T00:00:00.000Z';

describe('routeMail: индекс отправок по поставщикам', () => {
  const record = (overrides: Partial<SentRecord> & { requestId: string }): SentRecord =>
    sentSchema.parse({ supplierIds: ['s1'], sentAt: SENT_AT, ...overrides });
  const routed = {
    subject: 'КП',
    body: 'цена',
    receivedAt: AFTER,
    inReplyTo: undefined,
  };

  test('результат с индексом совпадает с результатом по списку записей', () => {
    const sent = [
      record({ requestId: 'req-1', supplierIds: ['s1', 's2'] }),
      record({ requestId: 'req-2', supplierIds: ['s2'], sentBySupplier: { s1: SENT_AT } }),
      record({ requestId: 'req-3', supplierIds: ['s1'], sentAt: 'не дата' }),
      record({ requestId: 'req-4', supplierIds: ['s1'], messageIds: { s1: 'box-4' } }),
      record({ requestId: 'req-5', supplierIds: ['s1'], sentAt: '2026-03-10T00:00:00.000Z' }),
    ];
    const index = buildSentIndex(sent);
    const cases = [
      { mail: routed, suppliers: ['s1'] },
      { mail: routed, suppliers: ['s2', 's1'] },
      { mail: { ...routed, inReplyTo: 'box-4' }, suppliers: ['s1', 's2'] },
      { mail: { ...routed, subject: `Re: ${'[RFQ-0000000000000000]'}` }, suppliers: ['s1'] },
      { mail: { ...routed, receivedAt: 'не дата' }, suppliers: ['s1'] },
      { mail: routed, suppliers: ['s9'] },
    ];
    for (const item of cases) {
      expect(routeMail(item.mail, item.suppliers, index)).toEqual(
        routeMail(item.mail, item.suppliers, sent),
      );
    }
    const route = routeMail(routed, ['s2', 's1'], index);
    expect(route.kind).toBe('ambiguous');
    if (route.kind === 'ambiguous') {
      // Порядок прежний: по записям отправки, внутри записи - по поставщикам письма.
      expect(route.candidates.map((item) => `${item.requestId}:${item.supplierId}`)).toEqual([
        'req-1:s2',
        'req-1:s1',
        'req-2:s2',
        'req-2:s1',
        'req-4:s1',
      ]);
    }
  });

  test('одна запись с ответом на наше письмо привязывается без перебора записей', () => {
    const sent = [
      record({ requestId: 'req-1', messageIds: { s1: 'box-1' } }),
      record({ requestId: 'req-2', messageIds: { s1: 'box-2' } }),
    ];
    const route = routeMail({ ...routed, inReplyTo: 'box-2' }, ['s1'], buildSentIndex(sent));
    expect(route).toEqual({ kind: 'assigned', candidate: { requestId: 'req-2', supplierId: 's1' } });
  });
});
