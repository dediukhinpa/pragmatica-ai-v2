import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { checkDocument } from '../../src/agents/documents/checks';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import type { SupplierQuote } from '../../src/kit/domain/models';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { CREATED_AT, CTX, OWN_COMPANY } from './support';

const quote = (lines: SupplierQuote['lines']): SupplierQuote => ({
  id: 'quote:req-1:s1',
  requestId: 'req-1',
  supplierId: 's1',
  currency: 'RUB',
  receivedAt: CREATED_AT,
  validUntil: '2026-03-01T00:00:00.000Z',
  paymentTerms: '50% предоплата',
  deliveryDays: 7,
  gaps: [],
  lines,
});

async function build(q: SupplierQuote): Promise<DocumentsDeps> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert(FULL_SUPPLIER);
  const quotes = new MemorySupplierQuoteRepository();
  await quotes.save(q);
  return {
    files: new MemoryFileSource(),
    knowledge: new MemoryKnowledgeSearch(new Map()),
    renderer: new MemoryDocumentRenderer(),
    suppliers,
    chat: new MemoryChatChannel(),
    ownCompanyNames: [OWN_COMPANY],
    quotes,
    state: new MemoryWorkflowStateStore(),
    clock: new FixedClock(),
  };
}

const PREPARE = {
  kind: 'contract' as const,
  requestId: 'req-1',
  supplierId: 's1',
  number: 'Д-1',
  issuedAt: '2026-01-05T00:00:00.000Z',
};

let deps: DocumentsDeps;
const ALL_LINES: SupplierQuote['lines'] = [
  { productName: 'Арматура 12 мм', unitPrice: 50, quantity: 100 },
  { productName: 'Сетка', unitPrice: 200, quantity: 10 },
];

beforeEach(async () => {
  deps = await build(quote(ALL_LINES));
});

describe('D-9: документ по КП (без сделки)', () => {
  test('КП с уточнённым названием («Арматура 12 мм») собирается и проходит', async () => {
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    expect(out.ready).toBe(true);
    const issues = await checkDocument(out.document!, deps);
    expect(issues.map((i) => i.code)).toEqual([]);
  });

  test('неточный регистр, пробелы и тире в названии не мешают', async () => {
    deps = await build(
      quote([
        { productName: ' арматура  12 мм ', unitPrice: 50, quantity: 100 },
        { productName: 'СЕТКА', unitPrice: 200, quantity: 10 },
      ]),
    );
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    const issues = await checkDocument(out.document!, deps);
    expect(issues.map((i) => i.code)).toEqual([]);
  });

  test('источники полей проставляет код: реквизиты и позиции из базы знаний', async () => {
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    expect(out.document?.fieldSources).toMatchObject({
      seller: 'knowledge',
      requisites: 'knowledge',
      lines: 'knowledge',
    });
    expect(Object.values(out.document?.fieldSources ?? {})).not.toContain('web');
  });

  test('позиция КП не попала в документ: замечание', async () => {
    const base = (await prepareSupplierDocument.execute(PREPARE, deps, CTX)).document!;
    const doc = { ...base, lines: [base.lines[0]!], total: 5000 };
    const issues = await checkDocument(doc, deps);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('quote_line_missing');
    expect(issues.find((i) => i.code === 'quote_line_missing')?.message).toContain('Сетка');
  });

  test('строка не из КП и другое количество: замечания', async () => {
    const base = (await prepareSupplierDocument.execute(PREPARE, deps, CTX)).document!;
    const lines = [
      { ...base.lines[0]!, quantity: 90 },
      base.lines[1]!,
      { name: 'Лишняя', quantity: 1, unitPrice: 1 },
    ];
    const total = 90 * 50 + 10 * 200 + 1;
    const codes = (await checkDocument({ ...base, lines, total }, deps)).map((i) => i.code);
    expect(codes).toContain('quantity_differs_from_quote');
    expect(codes).toContain('line_not_in_quote');
  });

  test('количества в КП нет: вопрос сотруднику, а не количество «из заявки»', async () => {
    deps = await build(quote([{ productName: 'Сетка', unitPrice: 200 }]));
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    // Документ собран, строка без количества не выдумана, вопрос задан.
    expect(out.ready).toBe(true);
    expect(out.document?.lines).toEqual([]);
    expect(out.questions.join('\n')).toContain('нет количества');
  });

  test('цены в КП нет: позиция не теряется молча, сотрудник видит причину', async () => {
    deps = await build(quote([{ productName: 'Сетка', quantity: 3 }]));
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    expect(out.ready).toBe(true);
    expect(out.questions.join('\n')).toContain('«Сетка» не вошла в документ: в КП нет цены');
  });

  test('валюта не из КП: не молчаливая подстановка, а предупреждение', async () => {
    const { requestId: _omitted, ...withoutRequest } = PREPARE;
    const out = await prepareSupplierDocument.execute(withoutRequest, deps, CTX);
    expect(out.questions.join('\n')).toContain('Валюта не взята из КП');
  });
});
