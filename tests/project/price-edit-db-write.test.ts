import { beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@business-ai/core';
import { writeEditedPricesToDb } from '../../src/price-edit-db-write';
import {
  PRICE_EDIT_FOLLOWUP_NAMESPACE,
  followupExpiry,
  loadFollowup,
  saveFollowup,
  type FollowupChange,
} from '../../src/price-edit-followup';
import { loadEmployeeFileEdits } from '../../src/employee-file-edits';
import { SUPPLIER_ID } from '../agents/support';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  skuItem,
  SCHEDULER_CTX,
  type FullPricesDeps,
} from '../agents/prices-support';

/**
 * «Да» после правки файла пишет изменённые цены в базу (этап 9q): цену берёт код из ожидания,
 * позицию называет модель; проверки записи прежние; ожидание закрывается.
 */

let deps: FullPricesDeps;
let ctx: ToolContext;

function change(row: number, oldPrice: number, newPrice: number, cells: string[]): FollowupChange {
  return { place: 'Слайд 2', table: 0, row, col: 1, rowCells: cells, oldPrice, newPrice };
}

async function pend(changes: FollowupChange[]): Promise<void> {
  const now = deps.clock.now();
  if (deps.state === undefined) throw new Error('нет состояния');
  await saveFollowup(deps.state, EMPLOYEE_THREAD, {
    createdAt: now.toISOString(),
    expiresAt: followupExpiry(now),
    sourceName: 'спецпредложение.pptx',
    resultName: 'спецпредложение_новые_цены.pptx',
    supplier: null,
    changes,
  });
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  ctx = employeeContext('u-db', EMPLOYEE_THREAD);
  await deps.prices.saveImport(
    SUPPLIER_ID,
    [skuItem('Болт М8', 10, 'B8'), skuItem('Болт М10', 12, 'B10'), skuItem('Гайка', 5, 'G1')],
    'seed',
  );
});

describe('writeEditedPricesToDb', () => {
  test('«да»: цена записана в базу, остальной прайс цел, ожидание закрыто', async () => {
    await pend([change(1, 10, 11, ['Болт М8', 'B8', '10'])]);
    const out = await writeEditedPricesToDb.execute(
      { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('written');
    expect(out.applied).toMatchObject([{ sku: 'B8', previousPrice: 10, newPrice: 11 }]);
    const rows = await deps.prices.listBySupplier(SUPPLIER_ID);
    const byName = new Map(rows.map((row) => [row.sku, row.price]));
    expect(byName.get('B8')).toBe(11);
    expect(byName.get('B10')).toBe(12);
    expect(byName.get('G1')).toBe(5);
    expect(await loadFollowup(deps.state!, EMPLOYEE_THREAD, deps.clock.now())).toBeNull();
  });

  test('аудит: дата, автор, имя файла и цены в реестре поставщика', async () => {
    await pend([change(1, 10, 11, ['Болт М8', 'B8'])]);
    await writeEditedPricesToDb.execute(
      { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
      deps,
      ctx,
    );
    const registry = await loadEmployeeFileEdits(deps.state, SUPPLIER_ID);
    expect(Object.values(registry)).toEqual([
      {
        editedAt: deps.clock.now().toISOString(),
        fileName: 'спецпредложение.pptx',
        author: EMPLOYEE_THREAD,
        price: 11,
        previousPrice: 10,
      },
    ]);
  });

  test('нет ожидания правки: отказ, база прежняя', async () => {
    await expect(
      writeEditedPricesToDb.execute(
        { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
        deps,
        ctx,
      ),
    ).rejects.toThrow();
    const rows = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(rows.find((row) => row.sku === 'B8')?.price).toBe(10);
  });

  test('плановый ход (не сотрудник): отказ', async () => {
    await pend([change(1, 10, 11, ['Болт М8', 'B8'])]);
    await expect(
      writeEditedPricesToDb.execute(
        { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
        deps,
        SCHEDULER_CTX,
      ),
    ).rejects.toThrow();
  });

  test('поставщика нет в базе: отказ', async () => {
    await pend([change(1, 10, 11, ['Болт М8', 'B8'])]);
    await expect(
      writeEditedPricesToDb.execute(
        { supplierId: 'нет-такого', matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
        deps,
        ctx,
      ),
    ).rejects.toThrow();
  });

  test('позиции нет в базе: вопрос, ничего не записано, ожидание остаётся', async () => {
    await pend([change(1, 40, 45, ['Шайба', 'SH1'])]);
    const out = await writeEditedPricesToDb.execute(
      { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'SH1', addIfMissing: false }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('nothing_written');
    expect(out.questions[0]?.code).toBe('not_found');
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(3);
    expect(await loadFollowup(deps.state!, EMPLOYEE_THREAD, deps.clock.now())).not.toBeNull();
  });

  test('addIfMissing с названием добавляет позицию в валюте прайса', async () => {
    await pend([change(1, 40, 45, ['Шайба'])]);
    const out = await writeEditedPricesToDb.execute(
      {
        supplierId: SUPPLIER_ID,
        matches: [{ change: 0, productName: 'Шайба М8', addIfMissing: true }],
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('written');
    expect(out.applied[0]).toMatchObject({ isNew: true, newPrice: 45, currency: 'RUB' });
    expect(await deps.prices.listBySupplier(SUPPLIER_ID)).toHaveLength(4);
  });

  test('часть позиций записана, неоднозначная остаётся в ожидании', async () => {
    await pend([
      change(1, 10, 11, ['Болт М8', 'B8']),
      change(2, 5, 6, ['Гайка', 'G1']),
    ]);
    const out = await writeEditedPricesToDb.execute(
      {
        supplierId: SUPPLIER_ID,
        matches: [
          { change: 0, sku: 'B8', addIfMissing: false },
          { change: 1, productName: 'Болт', addIfMissing: false },
        ],
      },
      deps,
      ctx,
    );
    expect(out.status).toBe('written');
    expect(out.stillPending).toBe(1);
    expect(out.questions).toHaveLength(1);
    const left = await loadFollowup(deps.state!, EMPLOYEE_THREAD, deps.clock.now());
    expect(left?.changes).toHaveLength(1);
    expect(left?.changes[0]?.newPrice).toBe(6);
  });

  test('цена в базе уже такая: вопрос, база не меняется', async () => {
    await pend([change(1, 9, 10, ['Болт М8', 'B8'])]);
    const out = await writeEditedPricesToDb.execute(
      { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('nothing_written');
    expect(out.questions[0]?.code).toBe('same_price');
  });

  test('чужой поставщик в базе: status=blocked с причиной, цена не меняется', async () => {
    await deps.prices.saveImport(
      SUPPLIER_ID,
      [skuItem('Болт М8', 10, 'B8'), { ...skuItem('Гайка', 5, 'G1'), supplierId: 'другой' }],
      'seed-foreign',
    );
    await pend([change(1, 10, 11, ['Болт М8', 'B8'])]);
    const out = await writeEditedPricesToDb.execute(
      { supplierId: SUPPLIER_ID, matches: [{ change: 0, sku: 'B8', addIfMissing: false }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('blocked');
    expect(out.warnings.join(' ')).toContain('другого поставщика');
    const rows = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(rows.find((row) => row.sku === 'B8')?.price).toBe(10);
    expect(await loadFollowup(deps.state!, EMPLOYEE_THREAD, deps.clock.now())).not.toBeNull();
  });

  test('идемпотентность: повтор того же вызова не создаёт второй записи', async () => {
    await pend([change(1, 10, 11, ['Болт М8', 'B8'])]);
    const input = {
      supplierId: SUPPLIER_ID,
      matches: [{ change: 0, sku: 'B8', addIfMissing: false }],
    };
    await writeEditedPricesToDb.execute(input, deps, ctx);
    const after = await deps.prices.listBySupplier(SUPPLIER_ID);
    expect(after.filter((row) => row.sku === 'B8')).toHaveLength(1);
  });
});

test('имя пространства ожидания не менялось', () => {
  expect(PRICE_EDIT_FOLLOWUP_NAMESPACE).toBe('prices:edit-followup');
});
