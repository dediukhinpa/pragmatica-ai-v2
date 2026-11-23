import { describe, expect, test } from 'bun:test';
import { priceItemKey } from '../../src/kit/domain/price-diff';
import {
  fileDateEnd,
  protectEmployeeEdits,
  type EmployeeFileEdit,
} from '../../src/employee-file-edits';
import type { PriceItem } from '../../src/kit/domain/models';

/**
 * Правило «более старый файл с диска не затирает цены сотрудника» (этап 9q): сравнение по дате
 * прайса из имени файла и моменту записи сотрудника.
 */

const EDITED_AT = '2026-11-23T10:00:00.000Z';

function item(sku: string, price: number, date: string): PriceItem {
  return { supplierId: 's1', productName: `Позиция ${sku}`, sku, price, currency: 'RUB', date };
}

const REGISTRY: Record<string, EmployeeFileEdit> = {
  'sku:a1': { editedAt: EDITED_AT, fileName: 'f.pptx', author: 't', price: 700 },
};

/** Реестр по реальному ключу позиции. */
function registryFor(row: PriceItem): Record<string, EmployeeFileEdit> {
  return {
    [priceItemKey(row)]: {
      editedAt: EDITED_AT,
      fileName: 'f.pptx',
      author: 't',
      price: row.price,
    },
  };
}

describe('fileDateEnd', () => {
  test('день в имени: конец этого дня; месяц: конец месяца; нет даты: null', () => {
    const end = (day: number): number => Date.UTC(2026, 10, day, 23, 59, 59, 999);
    expect(fileDateEnd('Прайсы/Значки_05.11.2026.xlsx')).toBe(end(5));
    expect(fileDateEnd('Прайсы/Значки_11.2026.xlsx')).toBe(end(30));
    expect(fileDateEnd('Прайсы/Значки.xlsx')).toBeNull();
  });
});

describe('protectEmployeeEdits', () => {
  const ours = item('A1', 700, EDITED_AT);

  test('файл старее правки сотрудника: цена сотрудника остаётся', () => {
    const result = protectEmployeeEdits(
      [item('A1', 680, '2026-11-20T00:00:00.000Z')],
      [ours],
      registryFor(ours),
      'Прайсы/Значки_10.11.2026.xlsx',
    );
    expect(result.kept).toBe(1);
    expect(result.items[0]?.price).toBe(700);
  });

  test('файл новее правки сотрудника: обычная замена', () => {
    const result = protectEmployeeEdits(
      [item('A1', 690, '2026-11-25T00:00:00.000Z')],
      [ours],
      registryFor(ours),
      'Прайсы/Значки_24.11.2026.xlsx',
    );
    expect(result.kept).toBe(0);
    expect(result.items[0]?.price).toBe(690);
  });

  test('файл того же дня, что правка: заменяет (дата прайса не старее)', () => {
    const result = protectEmployeeEdits(
      [item('A1', 690, '2026-11-23T12:00:00.000Z')],
      [ours],
      registryFor(ours),
      'Прайсы/Значки_23.11.2026.xlsx',
    );
    expect(result.kept).toBe(0);
  });

  test('в имени файла нет даты: порядок неизвестен, заменяет как обычно', () => {
    const result = protectEmployeeEdits(
      [item('A1', 680, '2026-11-20T00:00:00.000Z')],
      [ours],
      registryFor(ours),
      'Прайсы/Значки.xlsx',
    );
    expect(result.kept).toBe(0);
  });

  test('цену в базе уже сменил другой импорт: запись реестра устарела, не защищаем', () => {
    const changed = item('A1', 705, '2026-11-24T00:00:00.000Z');
    const result = protectEmployeeEdits(
      [item('A1', 680, '2026-11-20T00:00:00.000Z')],
      [changed],
      registryFor(ours),
      'Прайсы/Значки_10.11.2026.xlsx',
    );
    expect(result.kept).toBe(0);
  });

  test('чужие позиции и пустой реестр не затрагиваются', () => {
    const other = item('B2', 5, '2026-11-20T00:00:00.000Z');
    expect(
      protectEmployeeEdits([other], [other], registryFor(ours), 'Прайсы/Значки_10.11.2026.xlsx')
        .kept,
    ).toBe(0);
    expect(
      protectEmployeeEdits([other], [other], {}, 'Прайсы/Значки_10.11.2026.xlsx').kept,
    ).toBe(0);
    expect(protectEmployeeEdits([other], [other], REGISTRY, undefined).kept).toBe(0);
  });
});
