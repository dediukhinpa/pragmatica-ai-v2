import { describe, expect, test } from 'bun:test';
import { draftDescription } from '../../src/agents/site-export/draft-description';
import { fillTemplateRows } from '../../src/agents/site-export/fill-template-rows';
import { loadWorkbook } from '../../src/agents/site-export/template-store';
import { openChatTemplate } from '../../src/agents/site-export/open-chat-template';
import { prepareCleanTemplate } from '../../src/agents/site-export/prepare-clean-template';
import { readCards } from '../../src/agents/site-export/read-cards';
import { buildSiteExportPrompt } from '../../src/agents/site-export/prompt';
import { computeSitePrice } from '../../src/agents/site-export/site-price';
import { indexSheet, planFill } from '../../src/agents/site-export/fill-plan';
import { CTX } from './support';
import { EXPORT_ID, GOOD_DESCRIPTION, buildSiteDeps } from './site-support';
import { EXAMPLE_CELLS, buildBook, buildTemplateWorld } from './site-template-support';

/** Этап 177: вместо отказа и вопроса до выдачи - результат и предупреждение. */

type Cell = { column: string; value: string | number };
const base = {
  requestedByEmployee: false,
  confirmedByEmployee: false,
  overwrite: false,
  stampManager: true,
} as const;
const item = (cells: Cell[], row?: number) => ({ ...(row === undefined ? {} : { row }), cells });

describe('site-export: предупреждения вместо вопросов (177)', () => {
  test('менеджера нет в каталоге: файл записан, вопроса нет, предупреждение есть', async () => {
    const world = await buildTemplateWorld({ identity: null });
    const book = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const out = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: book.workbookId ?? '',
        items: [item([{ column: 'Название', value: 'Кепка' }])],
      },
      world.deps,
      world.ctx,
    );
    expect(out.written).toBeGreaterThan(0);
    expect(out.askEmployee).toEqual([]);
    expect(out.warnings.join(' ')).toContain('Менеджер не проставлен');
  });

  test('значение вне списка: без просьбы пропуск, по просьбе - как есть + warning', async () => {
    const world = await buildTemplateWorld();
    const book = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const id = book.workbookId ?? '';
    const cells = [
      { column: 'Название', value: 'Кепка' },
      { column: 'Упаковка', value: 'особая' },
    ];
    const without = await fillTemplateRows.execute(
      { ...base, workbookId: id, items: [item(cells)] },
      world.deps,
      world.ctx,
    );
    expect(without.skipped[0]).toMatchObject({ reason: 'not_in_list' });
    expect(without.skipped[0]?.message).not.toContain('спроси');
    const asked = await fillTemplateRows.execute(
      {
        ...base,
        workbookId: id,
        requestedByEmployee: true,
        requestQuote: 'упаковка особая',
        items: [item([{ column: 'Упаковка', value: 'особая' }], 12)],
      },
      world.deps,
      world.ctx,
    );
    expect(asked.skippedTotal).toBe(0);
    expect(asked.warnings.join(' ')).toContain('особая');
    const stored = await loadWorkbook(world.deps, id);
    expect(new TextDecoder().decode(stored.bytes)).toContain('особая');
  });

  test('список колонки не прочитан: пропуск остаётся, текст без «спроси»', async () => {
    const world = await buildTemplateWorld();
    const book = await prepareCleanTemplate.execute({}, world.deps, world.ctx);
    const loaded = await loadWorkbook(world.deps, book.workbookId ?? '');
    const structure = await world.deps.workbook.inspect({ bytes: loaded.bytes });
    const headers = structure.headers.map((header) =>
      header.text.startsWith('Упаковка') ? { ...header, listUnresolved: true } : header,
    );
    const plan = planFill({
      sheet: structure.sheet,
      isMainSheet: true,
      structure: { ...structure, headers },
      index: indexSheet(structure, false),
      items: [item([{ column: 'Название', value: 'Кепка' }, { column: 'Упаковка', value: 'х' }])],
      permissions: { requested: false, confirmed: false, overwrite: false },
      written: new Set(),
      stamp: { enabled: false, managerName: null, dateIso: null },
    });
    const skip = plan.skips.find((entry) => entry.reason === 'list_not_readable');
    expect(skip?.message).toContain('не записано');
    expect(skip?.message).not.toContain('спроси');
  });

  test('несколько xlsx в чате: берётся последний, предупреждение вместо вопроса', async () => {
    const world = await buildTemplateWorld();
    const files = new Map<number, { name: string; bytes: Uint8Array }>();
    files.set(7, { name: 'a.xlsx', bytes: buildBook({ cells: EXAMPLE_CELLS }) });
    files.set(8, { name: 'b.xlsx', bytes: buildBook({ cells: EXAMPLE_CELLS }) });
    world.deps.botFiles.remember('orders/2002', { botId: 1, fileId: 7, name: 'a.xlsx' });
    world.deps.botFiles.remember('orders/2002', { botId: 1, fileId: 8, name: 'b.xlsx' });
    const reader = {
        async fetchAttachments(request: { botFiles?: readonly { fileId: number }[] }) {
          const picked = files.get(request.botFiles?.[0]?.fileId ?? 0);
          if (picked === undefined) return { attachments: [], errors: [] };
          return {
            attachments: [
              {
                name: picked.name,
                mime: 'application/octet-stream',
                bytes: picked.bytes,
                source: 'bot' as const,
              },
            ],
            errors: [],
          };
        },
    };
    const deps = { ...world.deps, attachments: reader as unknown as typeof world.deps.attachments };
    const out = await openChatTemplate.execute({}, deps, world.ctx);
    expect(out.status).toBe('ok');
    expect(out.fileName).toBe('b.xlsx');
    expect(out.warnings?.join(' ')).toContain('b.xlsx');
  });

  test('описание с короткой длиной и фразой сохраняется, ПДн/ссылка - нет', async () => {
    const deps = await buildSiteDeps();
    const { applyExportTemplate } = await import('../../src/agents/site-export/apply-export-template');
    const page = await readCards.execute({ query: 'Болт', cursor: 0, limit: 50 }, deps, CTX);
    await applyExportTemplate.execute(
      { exportId: EXPORT_ID, part: 0, reset: true, cards: page.cards },
      deps,
      CTX,
    );
    const short = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-001', text: 'Болт.' },
      deps,
      CTX,
    );
    expect(short.saved).toBe(true);
    expect(short.issues.map((i) => i.code)).toEqual(['description_too_short']);
    const link = await draftDescription.execute(
      { exportId: EXPORT_ID, sku: 'ART-002', text: `${GOOD_DESCRIPTION} https://example.org/x` },
      deps,
      CTX,
    );
    expect(link.saved).toBe(false);
  });

  test('выдача readCards упёрлась в предел: есть warning', async () => {
    const deps = await buildSiteDeps(5000);
    const out = await readCards.execute({ query: 'Болт', cursor: 0, limit: 50 }, deps, CTX);
    expect(out.warning).toContain('5000');
    const small = await buildSiteDeps(3);
    const page = await readCards.execute({ query: 'Болт', cursor: 0, limit: 50 }, small, CTX);
    expect(page.warning).toBeUndefined();
  });

  test('промпт: итог - результат и один список предупреждений, без вопросов до выдачи', () => {
    const flat = buildSiteExportPrompt().replace(/\s+/g, ' ');
    expect(flat).toContain('ОДИН список «Предупреждения»');
    expect(flat).not.toContain('один раз спроси');
    expect(flat).not.toContain('нет в каталоге — спроси');
    expect(flat).not.toContain('что нужно уточнить у сотрудника');
    expect(flat).toContain('сотрудника до выдачи не спрашивай');
  });

  test('computeSitePrice: диапазон не определён - стоимость всё равно возвращается', async () => {
    const out = await computeSitePrice.execute(
      { supplierPrice: 100, priceIncludesVat: false, rangeLabels: ['abc'] },
      (await buildTemplateWorld()).deps,
      CTX,
    );
    expect(out.cost).toBe(207);
    expect(out.rangeStatus).not.toBe('ok');
  });
});
