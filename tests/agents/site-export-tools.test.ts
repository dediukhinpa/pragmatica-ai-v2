import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import { PUBLISH_BATCH_SIZE } from '../../src/agents/site-export/deps';
import { applyExportTemplate } from '../../src/agents/site-export/apply-export-template';
import {
  buildExportReportText,
  reportExportToManager,
} from '../../src/agents/site-export/report-to-manager';
import { cardKey, loadAllCards } from '../../src/agents/site-export/cards';
import { draftDescription } from '../../src/agents/site-export/draft-description';
import { readCards } from '../../src/agents/site-export/read-cards';
import { validateCards } from '../../src/agents/site-export/validate-cards';
import { CTX, MANAGER_THREAD } from './support';
import { EXPORT_ID, GOOD_DESCRIPTION, buildSiteDeps, type SiteTestDeps } from './site-support';

let deps: SiteTestDeps;

beforeEach(async () => {
  deps = await buildSiteDeps();
});

/** Прочитать все карточки по запросу и сложить в набор одной частью. */
async function loadSet(query = 'Болт'): Promise<void> {
  const page = await readCards.execute({ query, cursor: 0, limit: 50 }, deps, CTX);
  await applyExportTemplate.execute(
    { exportId: EXPORT_ID, part: 0, reset: true, cards: page.cards },
    deps,
    CTX,
  );
}

async function validated(): Promise<string> {
  return (await validateCards.execute({ exportId: EXPORT_ID }, deps, CTX)).setHash;
}

describe('readCards', () => {
  test('читает карточки из базы с подсказками из базы знаний', async () => {
    const out = await readCards.execute({ query: 'Болт', cursor: 0, limit: 50 }, deps, CTX);
    expect(out.cards).toHaveLength(3);
    expect(out.cards[0]).toMatchObject({ sku: 'ART-001', name: 'Болт 1', price: 10 });
    expect(out.nextCursor).toBeNull();
    expect(out.hints[0]?.documentId).toBe('kb-1');
  });

  test('страницами с курсором; подсказки только на первой странице', async () => {
    const first = await readCards.execute({ query: 'Болт', cursor: 0, limit: 2 }, deps, CTX);
    expect(first.cards).toHaveLength(2);
    expect(first.nextCursor).toBe(2);
    const second = await readCards.execute(
      { query: 'Болт', cursor: first.nextCursor ?? 0, limit: 2 },
      deps,
      CTX,
    );
    expect(second.cards).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.hints).toEqual([]);
  });
});

describe('applyExportTemplate и validateCards', () => {
  test('R4-ALG-10: одинаковое число в разных валютах - не «одна цена»', async () => {
    const base = { productName: 'Болт', sku: 'ART-001', price: 10, date: '2026-01-01' };
    await deps.prices.saveImport(
      's2',
      [{ ...base, supplierId: 's2', currency: 'USD' }],
      'seed-usd',
    );
    await applyExportTemplate.execute(
      {
        exportId: EXPORT_ID,
        part: 0,
        reset: true,
        cards: [{ sku: 'ART-001', name: 'Болт', price: 10, currency: 'RUB' }],
      },
      deps,
      CTX,
    );
    const [card] = await loadAllCards(deps, EXPORT_ID);
    expect(card?.card.price).toBeUndefined();
  });

  test('R4-ALG-10: точный артикул находится, даже если подстрока даёт дешёвых', async () => {
    const neighbours = Array.from({ length: 20 }, (_, i) => ({
      supplierId: 's9',
      productName: `Сосед ${i}`,
      sku: `XYZ-1${String(i).padStart(2, '0')}`,
      price: 1,
      currency: 'RUB',
      date: '2026-01-01',
    }));
    const target = { ...neighbours[0], sku: 'XYZ-1', productName: 'Цель', price: 77 };
    await deps.prices.saveImport('s9', [...neighbours, target as never], 'seed-xyz');
    await applyExportTemplate.execute(
      {
        exportId: EXPORT_ID,
        part: 0,
        reset: true,
        cards: [{ sku: 'xyz-1', name: 'Цель', price: 5, currency: 'RUB' }],
      },
      deps,
      CTX,
    );
    const [card] = await loadAllCards(deps, EXPORT_ID);
    expect(card?.card.price).toBe(77);
  });

  test('набор складывается по шаблону и проходит проверку', async () => {
    await loadSet();
    const out = await validateCards.execute({ exportId: EXPORT_ID }, deps, CTX);
    expect(out).toMatchObject({ ok: true, total: 3, issues: [] });
    const [first] = await loadAllCards(deps, EXPORT_ID);
    expect(Object.keys(first?.card ?? {}).sort()).toEqual(['currency', 'name', 'price', 'sku']);
  });

  test('reset очищает набор, повтор той же части заменяет её, а не дублирует', async () => {
    await loadSet();
    await loadSet();
    expect((await loadAllCards(deps, EXPORT_ID)).length).toBe(3);
  });

  test('невалидные карточки дают замечания с кодами', async () => {
    await applyExportTemplate.execute(
      {
        exportId: EXPORT_ID,
        part: 0,
        reset: true,
        cards: [
          { sku: 'A-1', name: 'Болт', price: 10, currency: 'RUB' },
          { sku: 'A-1', name: 'Болт', price: 10, currency: 'RUB' },
          { sku: 'A-2', name: 'Гайка', price: null, currency: 'RUB' },
          { sku: 'A-3', price: 5, currency: 'RUB' },
        ],
      },
      deps,
      CTX,
    );
    const out = await validateCards.execute({ exportId: EXPORT_ID }, deps, CTX);
    expect(out.ok).toBe(false);
    // Цены этих артикулов в базе нет: код снимает чужую цену, поэтому empty_price у каждой.
    expect([...new Set(out.issues.map((issue) => issue.code))].sort()).toEqual([
      'duplicate_sku',
      'empty_price',
      'missing_field',
    ]);
  });

  test('отпечаток набора меняется при правке и стабилен без неё', async () => {
    await loadSet();
    const hash = await validated();
    expect(await validated()).toBe(hash);
    await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-001', text: GOOD_DESCRIPTION },
      deps,
      CTX,
    );
    expect(await validated()).not.toBe(hash);
  });

  test('ключи частей сортируются как числа', () => {
    expect(cardKey(2, 0) < cardKey(10, 0)).toBe(true);
    expect(cardKey(0, 2) < cardKey(0, 10)).toBe(true);
  });
});

describe('draftDescription', () => {
  test('сохраняет проверенное описание в карточку', async () => {
    await loadSet();
    const out = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'art-001', text: `  ${GOOD_DESCRIPTION} ` },
      deps,
      CTX,
    );
    expect(out).toMatchObject({ saved: true, issues: [] });
    const stored = (await loadAllCards(deps, EXPORT_ID)).map((item) => item.card['description']);
    expect(stored).toEqual([GOOD_DESCRIPTION, undefined, undefined]);
  });

  test('короткое описание и запрещённая фраза сохраняются с предупреждениями', async () => {
    await loadSet();
    const short = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-001', text: 'Болт.' },
      deps,
      CTX,
    );
    expect(short).toMatchObject({ saved: true });
    expect(short.issues.map((i) => i.code)).toEqual(['description_too_short']);
    const banned = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-001', text: `${GOOD_DESCRIPTION} Лучшая цена!` },
      deps,
      CTX,
    );
    expect(banned.issues.map((i) => i.code)).toEqual(['forbidden_phrase']);
    expect(banned.saved).toBe(true);
    expect((await loadAllCards(deps, EXPORT_ID))[0]?.card['description']).toContain('Лучшая цена');
  });

  test('неизвестный артикул — not_found; шаблон без описаний — validation_failed', async () => {
    await loadSet();
    const missing = draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'нет', text: GOOD_DESCRIPTION },
      deps,
      CTX,
    );
    await expect(missing).rejects.toMatchObject({ code: 'not_found' });
    const { descriptionField: _omit, ...noDescription } = deps.template;
    const refused = draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-001', text: GOOD_DESCRIPTION },
      { ...deps, template: noDescription },
      CTX,
    );
    await expect(refused).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('reportToManager', () => {
  test('текст из кода, без ПДн, один раз на ключ', async () => {
    const input = {
      kind: 'blocked' as const,
      exportId: EXPORT_ID,
      total: 3,
      issueCodes: ['missing_field'],
    };
    await reportExportToManager.execute(input, deps, CTX);
    await reportExportToManager.execute(input, deps, CTX);
    expect(deps.chat.outbox).toHaveLength(1);
    expect(deps.chat.outbox[0]?.threadId).toBe(MANAGER_THREAD);
    expect(deps.chat.outbox[0]?.message?.text).toBe(buildExportReportText(input));
    expect(deps.chat.outbox[0]?.message?.text).toContain('не принята');
  });

  test('хранилище состояния изолирует наборы по exportId', async () => {
    await loadSet();
    const other = { ...deps, state: new MemoryWorkflowStateStore() };
    expect(await loadAllCards(other, EXPORT_ID)).toEqual([]);
  });
});
