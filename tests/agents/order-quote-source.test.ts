import { beforeEach, describe, expect, test } from 'bun:test';
import { quoteValidator } from '../../src/agents/order-calc/record-quote';
import { saveSelection } from '../../src/agents/order-calc/state';
import { storeReply, repliesNamespace } from '../../src/agents/order-calc/reply-store';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { CREATED_AT, CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

let deps: OrderTestDeps;

/** Сохранить ответ поставщика, как это делает readSupplierReplies. */
async function seedReply(
  d: OrderCalcDeps,
  id: string,
  supplierId: string,
  requestId = REQUEST_ID,
): Promise<void> {
  await storeReply(d.state, requestId, {
    id,
    channel: 'email',
    supplierId,
    text: 'Арматура 50',
    receivedAt: CREATED_AT,
    attachments: [],
  });
}

const args = (supplierId: string, sourceRef?: string, price = 50) => ({
  requestId: REQUEST_ID,
  supplierId,
  currency: 'RUB',
  lines: [{ productName: 'Арматура', unitPrice: price, quantity: 100 }],
  ...(sourceRef === undefined ? {} : { sourceRef }),
});

const codes = async (input: unknown): Promise<string[]> =>
  (await quoteValidator.validate(input, deps, CTX)).map((issue) => issue.code);

beforeEach(async () => {
  deps = await buildOrderDeps();
  await saveSelection(deps, {
    requestId: REQUEST_ID,
    supplierIds: ['s1', 's2'],
    createdAt: CREATED_AT,
  });
});

describe('R3-SEC-2: источник КП', () => {
  test('без sourceRef КП не принимается', async () => {
    expect(await codes(args('s1'))).toEqual(['invalid_input']);
  });

  test('ответа с таким sourceRef нет - отказ', async () => {
    expect(await codes(args('s1', 'out:нет'))).toEqual(['source_not_found']);
  });

  test('письмо другого поставщика не записывается как КП этого', async () => {
    await seedReply(deps, 'out:r2', 's2');
    expect(await codes(args('s1', 'out:r2'))).toEqual(['source_supplier_mismatch']);
    expect(await codes(args('s2', 'out:r2'))).toEqual([]);
  });

  test('ответ от другой заявки не подходит', async () => {
    await seedReply(deps, 'out:r9', 's1', 'req-other');
    expect(await codes(args('s1', 'out:r9'))).toEqual(['source_not_found']);
    expect(repliesNamespace('req-other')).not.toBe(repliesNamespace(REQUEST_ID));
  });

  test('перезапись КП из другого источника - только через человека', async () => {
    await seedReply(deps, 'out:r1', 's1');
    await seedReply(deps, 'out:r3', 's1');
    const { recordQuote } = await import('../../src/agents/order-calc/record-quote');
    await recordQuote.execute(args('s1', 'out:r1'), deps, CTX);
    // тот же источник: уточнение разбора допускается
    expect(await codes(args('s1', 'out:r1', 55))).toEqual([]);
    // другой источник того же поставщика: отказ с указанием на менеджера
    const issues = await quoteValidator.validate(args('s1', 'out:r3', 10), deps, CTX);
    expect(issues.map((i) => i.code)).toEqual(['quote_source_conflict']);
    expect(issues[0]?.message).toContain('менеджер');
  });
});

describe('R4-ALG-4: НДС КП в записи и сводке', () => {
  test('НДС всего КП переносится в позиции, сводка не называет минимум при смеси', async () => {
    const { recordQuote } = await import('../../src/agents/order-calc/record-quote');
    const { buildQuoteSummaryText, loadComparison } = await import(
      '../../src/agents/order-calc/quote-summary'
    );
    await seedReply(deps, 'out:r1', 's1');
    await seedReply(deps, 'out:r2', 's2');
    await recordQuote.execute(
      { ...args('s1', 'out:r1'), vatIncluded: true, vatRate: 20, validUntil: '2026-03-01' },
      deps,
      CTX,
    );
    await recordQuote.execute(
      { ...args('s2', 'out:r2', 40), vatIncluded: false, vatRate: 20 },
      deps,
      CTX,
    );
    const saved = await deps.quotes.get(REQUEST_ID, 's1');
    expect(saved?.lines[0]?.vatIncluded).toBe(true);
    expect(saved?.validUntil).toBe('2026-03-01T23:59:59.999+03:00');
    const { comparison } = await loadComparison(deps, REQUEST_ID);
    const text = buildQuoteSummaryText(comparison).text;
    expect(text).toContain('НЕСОПОСТАВИМО');
    expect(text).not.toContain('Минимальные цены за единицу');
  });
});

describe('R4-ALG-5: поиск поставщиков в знаниях', () => {
  test('десяток вариантов одного поставщика не вытесняет остальных; пустой — отказ', async () => {
    const { searchKnowledgeSuppliers } = await import('../../src/agents/order-calc/search-sources');
    const item = (supplierId: string, name: string, price: number) => ({
      supplierId,
      productName: name,
      price,
      currency: 'RUB',
      date: '2026-01-01',
    });
    const many = Array.from({ length: 12 }, (_, i) => item('s1', `Арматура вариант ${i}`, 1));
    await deps.suppliers.upsert({ id: 's1', name: 'Первый' });
    await deps.suppliers.upsert({ id: 's2', name: 'Второй' });
    await deps.prices.saveImport('s1', many, 'imp-1');
    await deps.prices.saveImport('s2', [item('s2', 'Арматура 12', 90)], 'imp-2');
    const out = await searchKnowledgeSuppliers.execute(
      { requestId: REQUEST_ID, query: 'арматура' },
      deps,
      CTX,
    );
    expect(out.status).toBe('ok');
    expect(out.found).toBe(2);
    const blank = await searchKnowledgeSuppliers
      .execute({ requestId: REQUEST_ID, query: '   ' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(blank).toBeInstanceOf(Error);
  });
});
