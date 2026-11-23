import { describe, expect, test } from 'bun:test';
import { buildRenderData } from '../../src/agents/documents/render-data';
import type { DealDocument } from '../../src/kit/domain/models';
import { buildDocument } from './support';

/** Договор на 120 000 руб. одной строкой: 10 шт. по 12 000. */
function contract(overrides: Partial<DealDocument> = {}): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: 'МОДЕЛЬ-1',
    issuedAt: '2026-10-21',
    seller: 'ООО «Ромашка»',
    total: 1,
    lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12_000 }],
    ...overrides,
  });
}

describe('итог и НДС для таблицы спецификации', () => {
  test('total_sum - итог по строкам, vat_sum - НДС по ставке на дату', () => {
    const { fields, lists } = buildRenderData(contract());
    expect(fields['total_sum']).toBe(120_000);
    expect(fields['vat_sum']).toBe(21_639.34);
    // Тот же вид числа, что у суммы строки: шаблон показывает их одинаково.
    expect(typeof fields['total_sum']).toBe(typeof lists['items']?.[0]?.['sum']);
  });

  test('ставка прошлого периода даёт свой НДС', () => {
    const { fields } = buildRenderData(contract({ issuedAt: '2025-12-31' }));
    expect(fields['vat_sum']).toBe(20_000);
  });

  test('ставка по дате не определена: НДС - прочерк, а не ноль', () => {
    const { fields } = buildRenderData(contract({ issuedAt: 'вчера' }));
    expect(fields['total_sum']).toBe(120_000);
    expect(fields['vat_sum']).toBe('—');
  });

  test('слово модели и сотрудника на суммы не влияет', () => {
    const { fields } = buildRenderData(
      contract({ templateFields: { total_sum: '1', vat_sum: '2' } }),
    );
    expect(fields['total_sum']).toBe(120_000);
  });

  test('не договор: полей нет', () => {
    const { fields } = buildRenderData(contract({ kind: 'invoice' }));
    expect(fields['total_sum']).toBeUndefined();
  });
});
