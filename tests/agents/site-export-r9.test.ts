import { describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import { applyExportTemplate } from '../../src/agents/site-export/apply-export-template';
import { draftDescription } from '../../src/agents/site-export/draft-description';
import { loadAllCards } from '../../src/agents/site-export/cards';
import { CTX } from './support';
import { EXPORT_ID, GOOD_DESCRIPTION, buildSiteDeps } from './site-support';

/**
 * R9-A2-02: повтор части заменяет её карточки, а не оставляет лишние за новой длиной.
 * R9-A2-08: промах по артикулу в наборе с полным индексом не читает весь набор.
 */

interface CardInput {
  sku: string;
  name: string;
  price: number;
  currency: string;
}

const SKU_WIDTH = 4;
const BIG_SET = 2_000;
const MISSES = 10;
/**
 * Промах читает одну страницу индекса за префиксом артикула; все 10 промахов вместе читают
 * меньше одного полного набора (раньше - по набору на промах, 20 тыс. записей).
 */
const MISS_LISTED_MAX = BIG_SET;

function cards(count: number, from = 1): CardInput[] {
  return Array.from({ length: count }, (_, offset) => {
    const number = offset + from;
    return {
      sku: `ART-${String(number).padStart(SKU_WIDTH, '0')}`,
      name: `Болт ${number}`,
      price: 1,
      currency: 'RUB',
    };
  });
}

/** Хранилище, которое считает прочитанные списком записи. */
class CountingStore extends MemoryWorkflowStateStore {
  listed = 0;

  override async list(
    namespace: string,
    after: string | null,
    limit: number,
  ): ReturnType<MemoryWorkflowStateStore['list']> {
    const page = await super.list(namespace, after, limit);
    this.listed += page.length;
    return page;
  }
}

async function skus(deps: Awaited<ReturnType<typeof buildSiteDeps>>): Promise<string[]> {
  return (await loadAllCards(deps, EXPORT_ID)).map((entry) => String(entry.card['sku']));
}

describe('R9-A2-02: повтор части заменяет её карточки', () => {
  test('часть 10 -> 7: в наборе 7 новых карточек, лишних нет', async () => {
    const deps = await buildSiteDeps(20);
    const input = { exportId: EXPORT_ID, part: 0, reset: true, cards: cards(10) };
    await applyExportTemplate.execute(input, deps, CTX);
    await applyExportTemplate.execute(
      { exportId: EXPORT_ID, part: 0, reset: false, cards: cards(7, 11) },
      deps,
      CTX,
    );
    expect(await skus(deps)).toEqual(cards(7, 11).map((card) => card.sku));
  });

  test('повтор одной части не трогает другие части', async () => {
    const deps = await buildSiteDeps(20);
    const first = { exportId: EXPORT_ID, part: 0, reset: true, cards: cards(5) };
    await applyExportTemplate.execute(first, deps, CTX);
    const second = { exportId: EXPORT_ID, part: 1, reset: false, cards: cards(5, 6) };
    await applyExportTemplate.execute(second, deps, CTX);
    await applyExportTemplate.execute({ ...first, reset: false, cards: cards(2) }, deps, CTX);
    expect(await skus(deps)).toEqual([...cards(2), ...cards(5, 6)].map((card) => card.sku));
  });

  test('убранная из части карточка больше не находится по артикулу', async () => {
    const deps = await buildSiteDeps(20);
    const input = { exportId: EXPORT_ID, part: 0, reset: true, cards: cards(3) };
    await applyExportTemplate.execute(input, deps, CTX);
    await applyExportTemplate.execute({ ...input, reset: false, cards: cards(1) }, deps, CTX);
    const gone = { exportId: EXPORT_ID, sku: 'ART-0003', text: GOOD_DESCRIPTION };
    await expect(draftDescription.execute(gone, deps, CTX)).rejects.toThrow();
  });
});

describe('R9-A2-08: промах по артикулу без полного просмотра', () => {
  test('10 промахов по набору из 2000 карточек не читают набор', async () => {
    const deps = await buildSiteDeps(3);
    const store = new CountingStore();
    deps.state = store;
    const input = { exportId: EXPORT_ID, part: 0, reset: true, cards: cards(BIG_SET) };
    await applyExportTemplate.execute(input, deps, CTX);
    store.listed = 0;
    for (let miss = 0; miss < MISSES; miss += 1) {
      const lookup = { exportId: EXPORT_ID, sku: `NOPE-${miss}`, text: GOOD_DESCRIPTION };
      await expect(draftDescription.execute(lookup, deps, CTX)).rejects.toThrow();
    }
    expect(store.listed).toBeLessThan(MISS_LISTED_MAX);
    // Попадание по-прежнему находит карточку.
    const hit = { exportId: EXPORT_ID, sku: 'ART-1500', text: GOOD_DESCRIPTION };
    await draftDescription.execute(hit, deps, CTX);
  });

  test('набор без метки полного индекса (создан раньше) - полный просмотр, как раньше', async () => {
    const deps = await buildSiteDeps(3);
    const input = { exportId: EXPORT_ID, part: 0, reset: true, cards: cards(3) };
    await applyExportTemplate.execute(input, deps, CTX);
    // Имитация старого набора: индекса и метки нет, карточки есть.
    await deps.state.clear(`site-export-sku:${EXPORT_ID}`);
    const hit = { exportId: EXPORT_ID, sku: 'ART-0002', text: GOOD_DESCRIPTION };
    await draftDescription.execute(hit, deps, CTX);
  });
});
