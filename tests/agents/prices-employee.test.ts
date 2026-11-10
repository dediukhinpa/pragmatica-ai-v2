import { beforeEach, describe, expect, test } from 'bun:test';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { recordEmployeePriceUpdates } from '../../src/agents/prices/employee-updates';
import { type ToolContext } from '@business-ai/core';
import { isDomainError } from '@business-ai/core';
import { CTX, SUPPLIER_ID, existingPrice } from './support';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  skuItem,
  type FullPricesDeps,
} from './prices-support';

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(
    SUPPLIER_ID,
    [skuItem('Болт М8', 10, 'B8'), skuItem('Болт М10', 12, 'B10'), skuItem('Гайка', 5, 'G1')],
    'seed',
  );
});

const EMPLOYEE_CTX: ToolContext = {
  ...CTX,
  threadId: EMPLOYEE_THREAD,
  initiator: { kind: 'user', userId: 'employee-1' },
};
const record = (updates: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  recordEmployeePriceUpdates.execute(
    { supplierId: SUPPLIER_ID, updates, ...extra },
    deps,
    EMPLOYEE_CTX,
  );

describe('recordEmployeePriceUpdates', () => {
  test('правка по артикулу: staging = полный прайс, автор из контекста', async () => {
    const out = await record([{ sku: 'B8', price: 11, note: 'сообщил менеджер' }]);
    expect(out.applied).toMatchObject([{ sku: 'B8', oldPrice: 10, newPrice: 11, isNew: false }]);
    expect(out.questions).toEqual([]);
    expect(out.totalItems).toBe(3);
    const staged = await deps.staging.load(out.importId ?? '');
    expect(staged?.items.map((i) => [i.sku, i.price])).toEqual([
      ['B8', 11],
      ['B10', 12],
      ['G1', 5],
    ]);
    expect(staged?.sourceRowCount).toBe(3);
    const meta = await deps.state.get(IMPORT_META_NAMESPACE, out.importId ?? '');
    expect(meta).toMatchObject({
      source: 'employee',
      author: EMPLOYEE_THREAD,
      notes: ['сообщил менеджер'],
    });
    // До фиксации в базе ничего не изменилось.
    const inBase = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(inBase.map((i) => i.price)).toEqual([10, 12, 5]);
  });

  test('автора и источник модель задать не может: лишние поля игнорируются', async () => {
    const out = await record([{ sku: 'B8', price: 11 }], { author: 'директор', source: 'disk' });
    const meta = await deps.state.get(IMPORT_META_NAMESPACE, out.importId ?? '');
    expect(meta).toMatchObject({ source: 'employee', author: EMPLOYEE_THREAD });
  });

  test('точное название применяется, приблизительное — вопрос с кандидатами', async () => {
    const out = await record([
      { productName: 'гайка', price: 6 },
      { productName: 'Болт', price: 13 },
    ]);
    expect(out.applied.map((a) => a.productName)).toEqual(['Гайка']);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]).toMatchObject({ index: 1, code: 'not_found' });
    expect(out.questions[0]?.candidates.map((c) => c.sku)).toEqual(['B8', 'B10']);
  });

  test('неоднозначное совпадение не применяется', async () => {
    await deps.prices.saveImport(
      SUPPLIER_ID,
      [skuItem('Шайба', 1, 'S1'), skuItem('Шайба', 2, 'S2')],
      'seed-2',
    );
    const out = await record([{ productName: 'Шайба', price: 3 }]);
    expect(out.importId).toBeNull();
    expect(out.applied).toEqual([]);
    expect(out.questions[0]).toMatchObject({ code: 'ambiguous_match' });
    expect(out.questions[0]?.candidates).toHaveLength(2);
  });

  test('чужая валюта, неизвестная валюта, та же цена и повтор позиции — вопросы', async () => {
    const out = await record([
      { sku: 'B8', price: 11, currency: 'USD' },
      { sku: 'B10', price: 13, currency: 'XXX' },
      { sku: 'G1', price: 5 },
      { sku: 'B8', price: 11 },
      { sku: 'B8', price: 12 },
    ]);
    expect(out.questions.map((q) => q.code)).toEqual([
      'currency_mismatch',
      'unknown_currency',
      'same_price',
      'duplicate_update',
    ]);
    expect(out.applied.map((a) => [a.index, a.newPrice])).toEqual([[3, 11]]);
  });

  test('новая позиция добавляется только явно и без похожих', async () => {
    const denied = await record([{ productName: 'Саморез', price: 2 }]);
    expect(denied.questions[0]?.code).toBe('not_found');
    const added = await record([{ productName: 'Саморез', price: 2, addIfMissing: true }]);
    expect(added.applied[0]).toMatchObject({ isNew: true, currency: 'RUB' });
    expect(added.totalItems).toBe(4);
  });

  test('цена не положительная — ошибка ввода, а не запись', async () => {
    const error = await record([{ sku: 'B8', price: 0 }]).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('invalid_input');
  });

  test('неизвестный поставщик — not_found', async () => {
    const error = await recordEmployeePriceUpdates
      .execute({ supplierId: 'нет', updates: [{ sku: 'B8', price: 11 }] }, deps, EMPLOYEE_CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_found');
  });

  test('фиксация правки сотрудника: предложение, база (данные диска) не меняется', async () => {
    const before = await deps.prices.listBySupplier(SUPPLIER_ID);
    const out = await record([{ sku: 'B8', price: 11 }]);
    const args = { supplierId: SUPPLIER_ID, fileHash: out.fileHash };
    expect(await stagedImportValidator.validate(args, deps, CTX)).toEqual([]);
    const done = await commitPriceImport.execute(args, deps, CTX);
    expect(done).toMatchObject({
      saved: 0,
      changed: 1,
      proposed: 3,
      status: 'proposed_not_written',
    });
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toEqual(before);
  });

  test('база изменилась после записи правок: фиксация блокируется (base_changed)', async () => {
    const first = await record([{ sku: 'B8', price: 11 }]);
    const second = await record([{ sku: 'G1', price: 6 }]);
    expect(first.fileHash).not.toBe(second.fileHash);
    // Базу меняет только импорт с диска: имитируем его прямой записью.
    await deps.prices.saveImport(SUPPLIER_ID, [existingPrice('Другой', 1)], 'disk-change');
    const issues = await stagedImportValidator.validate(
      { supplierId: SUPPLIER_ID, fileHash: second.fileHash },
      deps,
      CTX,
    );
    expect(issues.map((i) => i.code)).toContain('base_changed');
  });
});
