import { describe, expect, test } from 'bun:test';
import { handoffKey } from '../../src/agents/documents/handoff-for-review';
import { joinKey } from '@business-ai/core';
import { quoteIdOf, recordQuoteKey } from '../../src/agents/order-calc/record-quote';
import { saveDocumentKey } from '../../src/agents/documents/save-document';

describe('R3-ALG-23: составные ключи', () => {
  test('обычные идентификаторы дают прежний ключ', () => {
    expect(joinKey('order-request', 'r1', 's-2')).toBe('order-request:r1:s-2');
    expect(quoteIdOf('r1', 's1')).toBe('quote:r1:s1');
  });

  test('двоеточие и процент внутри части экранированы: пары не склеиваются', () => {
    expect(joinKey('a:b', 'c')).not.toBe(joinKey('a', 'b:c'));
    expect(joinKey('a%3Ab', 'c')).not.toBe(joinKey('a:b', 'c'));
    expect(quoteIdOf('a:b', 'c')).not.toBe(quoteIdOf('a', 'b:c'));
  });

  test('ключи инструментов различают склейку', () => {
    const quote = (requestId: string, supplierId: string) => ({
      requestId,
      supplierId,
      sourceRef: 'm',
      currency: 'RUB',
      lines: [{ productName: 'x' }],
    });
    expect(recordQuoteKey(quote('a:b', 'c'))).not.toBe(recordQuoteKey(quote('a', 'b:c')));
    const doc = (supplierId: string, number: string) => ({
      document: { supplierId, seller: 's', kind: 'contract', number, issuedAt: 'd', lines: [] },
    });
    expect(handoffKey(doc('a:b', 'c') as never)).not.toBe(handoffKey(doc('a', 'b:c') as never));
    const save = (templatePath: string, supplierId: string) =>
      saveDocumentKey({ templatePath, document: { ...doc(supplierId, '1').document } } as never);
    expect(save('b:c', 'a')).not.toBe(save('c', 'a:b'));
  });
});
