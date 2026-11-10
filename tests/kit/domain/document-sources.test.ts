import { describe, expect, test } from 'bun:test';
import {
  checkFieldSources,
  checkWebConfirmation,
  describeFieldPath,
  documentFieldPaths,
  fieldSourceOf,
  fieldLabelOf,
  webFieldPaths,
  webMatchedPaths,
  webValuesSignature,
} from '../../../src/kit/domain/document-sources';
import { type DealDocument } from '../../../src/kit/domain/models';

const DOC: DealDocument = {
  id: 'd',
  kind: 'contract',
  number: '1',
  buyer: 'ООО Заказчик',
  seller: 'ООО Поставщик',
  lines: [
    { name: 'Болт', quantity: 2, unitPrice: 5 },
    { name: 'Гайка', quantity: 1, unitPrice: 3, unit: 'шт' },
  ],
  total: 13,
  currency: 'RUB',
  issuedAt: '2026-01-06T00:00:00.000Z',
  requisites: { inn: '7707083893' },
  paymentTerms: '30 дней',
};

describe('документные источники', () => {
  test('существенные поля: стороны, реквизиты, позиции, суммы, условия', () => {
    expect(documentFieldPaths(DOC)).toEqual([
      'buyer',
      'seller',
      'total',
      'paymentTerms',
      'requisites.inn',
      'lines.0.name',
      'lines.0.quantity',
      'lines.0.unitPrice',
      'lines.1.name',
      'lines.1.quantity',
      'lines.1.unitPrice',
      'lines.1.unit',
    ]);
  });

  test('без отметок: замечание со списком; ключ родителя покрывает вложенные', () => {
    expect(checkFieldSources(DOC).map((i) => i.code)).toEqual(['field_source_missing']);
    const covered: DealDocument = {
      ...DOC,
      fieldSources: {
        buyer: 'employee',
        seller: 'employee',
        total: 'employee',
        paymentTerms: 'employee',
        requisites: 'knowledge',
        lines: 'employee',
      },
    };
    expect(checkFieldSources(covered)).toEqual([]);
    expect(fieldSourceOf(covered, 'requisites.inn')).toBe('knowledge');
  });

  test('веб-поля: список по отметкам, замечание без значений', () => {
    const web: DealDocument = {
      ...DOC,
      fieldSources: { buyer: 'employee', lines: 'web', requisites: 'web' },
    };
    const paths = webFieldPaths(web);
    expect(paths).toContain('lines.1.unit');
    expect(paths).toContain('requisites.inn');
    expect(paths).not.toContain('buyer');
    const issue = checkWebConfirmation(paths, 'unconfirmed')[0];
    expect(issue?.code).toBe('web_fields_unconfirmed');
    expect(issue?.message).toContain('ИНН (реквизит поставщика)');
    expect(issue?.message).not.toContain('7707083893');
    expect(checkWebConfirmation(paths, 'rejected')[0]?.code).toBe('web_fields_rejected');
    expect(checkWebConfirmation(paths, 'confirmed')).toEqual([]);
    expect(checkWebConfirmation([], 'unconfirmed')).toEqual([]);
  });

  test('значения из текста веб-поиска опознаются независимо от отметки', () => {
    const doc: DealDocument = { ...DOC, fieldSources: { buyer: 'employee' } };
    const text = 'карточка компании: инн 7707083893, оплата  30 дней';
    expect(webMatchedPaths(doc, text)).toEqual(['paymentTerms', 'requisites.inn']);
    expect(webMatchedPaths(doc, '')).toEqual([]);
    // Короткие значения (количества) не сверяются.
    expect(webMatchedPaths(doc, '2 1 5 3 13')).toEqual([]);
    expect(webFieldPaths(doc, new Set(['paymentTerms']))).toEqual(['paymentTerms']);
  });

  test('подпись значений меняется при смене значения и не зависит от порядка путей', () => {
    const first = webValuesSignature(DOC, ['paymentTerms', 'buyer']);
    expect(webValuesSignature(DOC, ['buyer', 'paymentTerms'])).toBe(first);
    const changed = { ...DOC, paymentTerms: '60 дней' };
    expect(webValuesSignature(changed, ['paymentTerms', 'buyer'])).not.toBe(first);
    expect(fieldLabelOf('paymentTerms')).toBe('условия оплаты');
  });

  test('описание поля со значением', () => {
    expect(describeFieldPath(DOC, 'paymentTerms')).toBe('условия оплаты = 30 дней');
  });
});
