import { describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import { applyExportTemplate } from '../../src/agents/site-export/apply-export-template';
import { draftDescription } from '../../src/agents/site-export/draft-description';
import { loadAllCards } from '../../src/agents/site-export/cards';
import { notesNamespace } from '../../src/agents/site-export/deps';
import { loadConflicts, saveItemValues } from '../../src/agents/site-export/item-notes';
import { validateCards } from '../../src/agents/site-export/validate-cards';
import { stableHash } from '@business-ai/core';
import type { PriceItem } from '../../src/kit/domain/models';
import type { JsonValue, WorkflowStateEntry } from '@business-ai/core';
import { CTX } from './support';
import { EXPORT_ID, GOOD_DESCRIPTION, buildSiteDeps } from './site-support';

/** Хранилище, считающее записи, отданные `list` (стоимость чтения набора). */
class CountingStore extends MemoryWorkflowStateStore {
  listed = 0;
  override async list(
    namespace: string,
    afterKey: string | null,
    limit: number,
  ): Promise<WorkflowStateEntry[]> {
    const page = await super.list(namespace, afterKey, limit);
    this.listed += page.length;
    return page;
  }
}

const TOTAL = 600;

async function buildSet(total = TOTAL) {
  const deps = await buildSiteDeps(total);
  const store = new CountingStore();
  deps.state = store;
  const cards = Array.from({ length: total }, (_, index) => ({
    sku: `ART-${String(index + 1).padStart(3, '0')}`,
    name: `Болт ${index + 1}`,
    price: 1,
    currency: 'RUB',
  }));
  const input = { exportId: EXPORT_ID, part: 0, reset: true, cards };
  await applyExportTemplate.execute(input, deps, CTX);
  const { setHash } = await validateCards.execute({ exportId: EXPORT_ID }, deps, CTX);
  return { deps, store, setHash };
}

describe('R5-CORE-6: описание карточки по индексу артикулов', () => {
  test('описания пишутся без чтения набора целиком', async () => {
    const { deps, store } = await buildSet();
    store.listed = 0;
    for (const index of [3, 77, 150, 599]) {
      const sku = `art-${String(index + 1).padStart(3, '0')}`;
      const out = await draftDescription.execute(
        { exportId: EXPORT_ID, sku: ` ${sku} `, text: GOOD_DESCRIPTION },
        deps,
        CTX,
      );
      expect(out.saved).toBe(true);
    }
    // До правки: набор целиком на каждый вызов (4 * TOTAL записей).
    expect(store.listed).toBeLessThan(TOTAL);
    const stored = await loadAllCards(deps, EXPORT_ID);
    const described = stored.filter((item) => item.card['description'] === GOOD_DESCRIPTION);
    expect(described.map((item) => item.card['sku'])).toEqual([
      'ART-004',
      'ART-078',
      'ART-151',
      'ART-600',
    ]);
  });

  test('нет такого артикула - not_found, дубль - conflict', async () => {
    const { deps } = await buildSet(5);
    await expect(
      draftDescription.execute(
        { exportId: EXPORT_ID, sku: 'НЕТ', text: GOOD_DESCRIPTION },
        deps,
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const cards = [
      { sku: 'DUP-1', name: 'А', price: 1, currency: 'RUB' },
      { sku: 'dup-1 ', name: 'Б', price: 1, currency: 'RUB' },
    ];
    await applyExportTemplate.execute(
      { exportId: EXPORT_ID, part: 0, reset: true, cards },
      deps,
      CTX,
    );
    await expect(
      draftDescription.execute(
        { exportId: EXPORT_ID, sku: 'DUP-1', text: GOOD_DESCRIPTION },
        deps,
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('замена части меняет артикул: старая запись индекса не находит чужую карточку', async () => {
    const { deps } = await buildSet(3);
    const cards = [{ sku: 'NEW-1', name: 'Новая', price: 1, currency: 'RUB' }];
    await applyExportTemplate.execute(
      { exportId: EXPORT_ID, part: 0, reset: false, cards },
      deps,
      CTX,
    );
    // Карточка p0:0 была ART-001, стала NEW-1; ART-001 больше нет.
    await expect(
      draftDescription.execute(
        { exportId: EXPORT_ID, sku: 'ART-001', text: GOOD_DESCRIPTION },
        deps,
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const ok = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'NEW-1', text: GOOD_DESCRIPTION },
      deps,
      CTX,
    );
    expect(ok.saved).toBe(true);
  });

  test('набор без индекса (создан до правки): работает полным просмотром', async () => {
    const { deps } = await buildSet(3);
    await deps.state.clear(`site-export-sku:${EXPORT_ID}`);
    const out = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-002', text: GOOD_DESCRIPTION },
      deps,
      CTX,
    );
    expect(out.saved).toBe(true);
  });
});

describe('R5-CORE-6: applyExportTemplate - пакетный поиск цен', () => {
  test('один пакетный запрос на пачку, цены те же, что при поиске по одному', async () => {
    const deps = await buildSiteDeps(40);
    // Расходящиеся цены у ART-002: цена снимается.
    await deps.prices.saveImport(
      's2',
      [
        {
          supplierId: 's2',
          productName: 'Болт 2',
          sku: 'ART-002',
          price: 99,
          currency: 'RUB',
          date: '2026-01-01T00:00:00.000Z',
        },
      ],
      'x',
    );
    let single = 0;
    let batched = 0;
    const original = deps.prices;
    const spy = Object.create(original) as typeof original;
    spy.listBySku = (sku, limit) => {
      single += 1;
      return original.listBySku(sku, limit);
    };
    spy.listBySkus = (skus, limit) => {
      batched += 1;
      return original.listBySkus(skus, limit);
    };
    deps.prices = spy;
    const cards = [
      ...Array.from({ length: 40 }, (_, i) => ({
        sku: `ART-${String(i + 1).padStart(3, '0')}`,
        name: `Болт ${i + 1}`,
        price: 5,
        currency: 'RUB',
      })),
      { sku: 'ART-001', name: 'Повтор', price: 5, currency: 'RUB' },
      { sku: 'НЕТ-1', name: 'Нет', price: 5, currency: 'RUB' },
    ];
    const input = { exportId: EXPORT_ID, part: 0, reset: true, cards };
  await applyExportTemplate.execute(input, deps, CTX);
    expect(single).toBe(0);
    expect(batched).toBe(1);
    const stored = await loadAllCards(deps, EXPORT_ID);
    const priceOf = (sku: string): unknown =>
      stored.find((item) => item.card['sku'] === sku)?.card['price'];
    expect(priceOf('ART-001')).toBe(10);
    expect(priceOf('ART-002')).toBeUndefined();
    expect(priceOf('НЕТ-1')).toBeUndefined();
    expect(stored).toHaveLength(42);
  });
});

describe('R5-CORE-6: значения позиций читаются по индексу', () => {
  const value = (itemKey: string, field: string, source: string, v: string | number) => ({
    itemKey,
    field,
    value: v,
    source,
  });

  test('конфликты те же, чтение не зависит от числа чужих значений', async () => {
    const { deps, store } = await buildSet(3);
    const noise = Array.from({ length: 300 }, (_, i) =>
      value(`other-${i}`, 'price', 'прайс s1', i),
    );
    await saveItemValues(deps, EXPORT_ID, noise);
    // Первое чтение достраивает индекс по позиции (как после записи значений в бою).
    await loadConflicts(deps, EXPORT_ID, new Set(['other-0']));
    store.listed = 0;
    const fresh = [value('k1', 'price', 'прайс s1', 50), value('k1', 'price', 'письмо m1', 55)];
    await saveItemValues(deps, EXPORT_ID, fresh);
    const conflicts = await loadConflicts(deps, EXPORT_ID, new Set(['k1']));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.itemKey).toBe('k1');
    // До правки: все 300+ значений набора на каждый вызов.
    expect(store.listed).toBeLessThan(100);
  });

  test('значения, записанные до индекса, не теряются (достройка при первом чтении)', async () => {
    const { deps } = await buildSet(3);
    const namespace = notesNamespace(EXPORT_ID);
    for (const legacy of [
      value('k9', 'price', 'прайс s1', 10),
      value('k9', 'price', 'прайс s2', 20),
    ]) {
      const key = `val:${stableHash([legacy.itemKey, legacy.field, legacy.source])}`;
      await deps.state.put(namespace, key, legacy);
    }
    await saveItemValues(deps, EXPORT_ID, [value('k9', 'name', 'прайс s1', 'Болт')]);
    const conflicts = await loadConflicts(deps, EXPORT_ID, new Set(['k9']));
    expect(conflicts.map((c) => `${c.itemKey}:${c.field}`)).toEqual(['k9:price']);
  });
});

describe('R5-CORE-6: listBySkus совпадает с listBySku', () => {
  test('случайные артикулы, фиксированный seed', async () => {
    const deps = await buildSiteDeps(1);
    let seed = 42;
    const next = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed;
    };
    const items: PriceItem[] = Array.from({ length: 200 }, (_, i) => ({
      supplierId: `s${next() % 4}`,
      productName: `Товар ${i}`,
      sku: `Ab-${next() % 40}${next() % 2 === 0 ? ' - x' : ''}`,
      price: 1 + (next() % 9),
      currency: next() % 2 === 0 ? 'RUB' : 'USD',
      date: '2026-01-01T00:00:00.000Z',
    }));
    for (const supplier of ['s0', 's1', 's2', 's3']) {
      await deps.prices.saveImport(
        supplier,
        items.filter((item) => item.supplierId === supplier),
        `k-${supplier}`,
      );
    }
    const wanted = ['AB-1', 'ab-7 - X', ' ab-33', '', 'нет', 'ab-1', 'AB-12'];
    for (const limit of [1, 3, 100]) {
      const batched = await deps.prices.listBySkus(wanted, limit);
      for (const sku of wanted) {
        expect(batched.get(sku)).toEqual(await deps.prices.listBySku(sku, limit));
      }
    }
  });
});
