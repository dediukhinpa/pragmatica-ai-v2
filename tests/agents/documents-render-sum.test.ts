import { describe, expect, test } from 'bun:test';
import { LINES_LIST_NAME } from '../../src/agents/documents/template-fields';
import { buildRenderData } from '../../src/agents/documents/render-data';
import type { DealDocument } from '../../src/kit/domain/models';

const DOC: DealDocument = {
  id: 'd',
  kind: 'invoice',
  number: '1',
  buyer: 'Б',
  seller: 'П',
  lines: [
    { name: 'Болт', quantity: 3, unitPrice: 0.1 },
    { name: 'Гайка', quantity: 3, unitPrice: 0.335 },
  ],
  total: 1.31,
  currency: 'RUB',
  issuedAt: '2026-01-06T00:00:00.000Z',
};

describe('R3-ALG-21: сумма строки в шаблон', () => {
  test('округлена до копеек, без хвоста двоичной дроби', () => {
    const rows = buildRenderData(DOC).lists[LINES_LIST_NAME];
    expect(rows?.map((row) => row.sum)).toEqual([0.3, 1.01]);
  });
});
