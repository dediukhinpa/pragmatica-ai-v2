import { beforeEach, describe, expect, test } from 'bun:test';
import { listStalePriceSuppliers } from '../../src/agents/prices/stale-price-suppliers';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { recordEmployeePriceUpdates } from '../../src/agents/prices/employee-updates';
import { savePriceUpload } from '../../src/agents/prices/price-state';
import { type ToolContext } from '@business-ai/core';
import { PRICE_UPLOAD_NAMESPACE } from '../../src/agents/prices/deps';
import type { PriceItem } from '../../src/kit/domain/models';
import { CTX, SUPPLIER_ID } from './support';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  stageDiskCsv,
  type FullPricesDeps,
} from './prices-support';

/**
 * Стоимость операций агента «Актуализация прайса (ИИ агент)» (R5-CORE-3, 4, 8): число чтений и
 * время на большом прайсе.
 */

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

/** Подсчёт вызовов `listBySupplier`: прайс поставщика целиком разбирается каждый раз. */
function countListCalls(target: FullPricesDeps): { calls: number } {
  const counter = { calls: 0 };
  const original = target.prices.listBySupplier.bind(target.prices);
  target.prices.listBySupplier = async (supplierId: string) => {
    counter.calls += 1;
    return original(supplierId);
  };
  return counter;
}

describe('R5-CORE-8: listStalePriceSuppliers', () => {
  test('прайс читается только у поставщиков без даты загрузки', async () => {
    const STALE_DAYS_AGO = 100;
    const day = new Date(deps.clock.now().getTime() - STALE_DAYS_AGO * 86_400_000).toISOString();
    for (const id of ['u1', 'u2', 'u3']) {
      await deps.suppliers.upsert({ id, name: `Поставщик ${id}` });
      await deps.prices.saveImport(id, [{ ...item('Болт', 1), supplierId: id }], 'k');
      await savePriceUpload(deps, id, day);
    }
    await deps.suppliers.upsert({ id: 'no-upload', name: 'Без даты загрузки' });
    const lone = { ...item('Гайка', 1), supplierId: 'no-upload' };
    await deps.prices.saveImport('no-upload', [lone], 'k');
    const counter = countListCalls(deps);
    const out = await listStalePriceSuppliers.execute({}, deps, CTX);
    // Читается только прайс поставщика, у которого даты загрузки нет (и «МеталлТорг» без
    // прайса из общей заготовки теста): трое с датой загрузки прайс не читают.
    expect(counter.calls).toBeLessThanOrEqual(2);
    expect(out.suppliers.map((s) => s.supplierId).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  test('даты загрузки читаются одним проходом, а не get на каждого поставщика', async () => {
    const STALE_DAYS_AGO = 100;
    const SUPPLIERS = 5;
    const day = new Date(deps.clock.now().getTime() - STALE_DAYS_AGO * 86_400_000).toISOString();
    for (let i = 0; i < SUPPLIERS; i += 1) {
      await deps.suppliers.upsert({ id: `s${i}`, name: `Поставщик ${i}` });
      await savePriceUpload(deps, `s${i}`, day);
    }
    const state = deps.state;
    if (state === undefined) throw new Error('нужно хранилище состояния');
    let gets = 0;
    let lists = 0;
    const originalGet = state.get.bind(state);
    const originalList = state.list.bind(state);
    state.get = async (namespace, key) => {
      if (namespace === PRICE_UPLOAD_NAMESPACE) gets += 1;
      return originalGet(namespace, key);
    };
    state.list = async (namespace, after, limit, options) => {
      if (namespace === PRICE_UPLOAD_NAMESPACE) lists += 1;
      return originalList(namespace, after, limit, options);
    };
    const out = await listStalePriceSuppliers.execute({}, deps, CTX);
    expect(out.suppliers).toHaveLength(SUPPLIERS);
    expect(gets).toBe(0);
    expect(lists).toBe(1);
  });

  test('повреждённая запись даты загрузки по-прежнему даёт external_failure', async () => {
    await deps.suppliers.upsert({ id: 'broken', name: 'Битый' });
    await deps.state?.put(PRICE_UPLOAD_NAMESPACE, 'broken', { at: 42 });
    await expect(listStalePriceSuppliers.execute({}, deps, CTX)).rejects.toMatchObject({
      code: 'external_failure',
    });
  });
});

function item(name: string, price: number, sku?: string): PriceItem {
  return {
    supplierId: SUPPLIER_ID,
    productName: name,
    ...(sku === undefined ? {} : { sku }),
    price,
    currency: 'RUB',
    date: '2026-01-01T00:00:00.000Z',
  };
}

describe('R5-CORE-4: recordEmployeePriceUpdates на большом прайсе', () => {
  test('200 правок к прайсу на 8000 позиций укладываются в секунды, а не в десятки', async () => {
    const BASE = 8000;
    const UPDATES = 200;
    const STEP = 37;
    const base = Array.from({ length: BASE }, (_, i) =>
      item(`Товар номер ${i} Ёмкость`, 100 + (i % 50), `AB-${i}`),
    );
    await deps.prices.saveImport(SUPPLIER_ID, base, 'seed');
    const ctx: ToolContext = {
      ...CTX,
      threadId: EMPLOYEE_THREAD,
      initiator: { kind: 'user', userId: 'employee-1' },
    };
    const updates = Array.from({ length: UPDATES }, (_, q) => ({
      sku: `ab-${q * STEP}`,
      productName: `Товар номер ${q * STEP} Емкость`,
      price: 500 + q,
    }));
    const started = performance.now();
    const out = await recordEmployeePriceUpdates.execute(
      { supplierId: SUPPLIER_ID, updates },
      deps,
      ctx,
    );
    const elapsed = performance.now() - started;
    expect(out.applied).toHaveLength(UPDATES);
    expect(out.questions).toEqual([]);
    expect(out.totalItems).toBe(BASE);
    // Раньше каждая правка нормализовала весь прайс: порядка 7 с на этом размере.
    expect(elapsed).toBeLessThan(2500);
  });
});

describe('R5-CORE-3: previewPriceChanges', () => {
  test('прайс поставщика в базе читается один раз, а не на каждый отпечаток', async () => {
    await deps.prices.saveImport(
      SUPPLIER_ID,
      [item('Болт', 10, 'B1'), item('Гайка', 5, 'G1')],
      'seed',
    );
    const { fileHash } = await stageDiskCsv(deps, [
      ['Болт', 100, 'B1'],
      ['Гайка', 5, 'G1'],
    ]);
    const counter = countListCalls(deps);
    const out = await previewPriceChanges.execute({ supplierId: SUPPLIER_ID, fileHash }, deps, CTX);
    expect(out.counts.jumps).toBe(1);
    expect(counter.calls).toBe(1);
  });
});
