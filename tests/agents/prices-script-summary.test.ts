import { describe, expect, test } from 'bun:test';
import { MemoryScheduler } from '@business-ai/adapters';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import {
  buildInitialImportSummary,
  buildRetrySummary,
} from '../../src/agents/prices/initial-import-summary';
import {
  createToolContext,
  scriptTurnOf,
  type ScriptTurnCounters,
  type ToolContext,
} from '@business-ai/core';
import { diskSyncThreadId, runPriceDiskSync } from '../../src/agents/prices/price-disk-sync';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { type DiskSyncOutcome } from '../../src/agents/prices/disk-sync-outcome';
import { SCRIPT_FIX_STEPS } from '@business-ai/core';
import type { IdGenerator } from '@business-ai/core';
import { RESPONSIBLE_THREAD, buildFullPricesDeps, encode } from './prices-support';

const AT = '2026-10-27T10:00:00.000Z';
const ids: IdGenerator = { next: (prefix = 'id') => `${prefix}-1` };

function outcome(patch: Partial<DiskSyncOutcome>): DiskSyncOutcome {
  return { run: 'r', file: 'f.xlsx', status: 'written', at: AT, ...patch };
}

describe('сводка импорта: файлы, разобранные скриптом', () => {
  test('первичный импорт и догрузка называют число файлов, разобранных скриптом', () => {
    const outcomes = [
      outcome({ file: 'a.xlsx', rows: 10, viaScript: true }),
      outcome({ file: 'b.xlsx', rows: 5 }),
      outcome({ file: 'c.xlsx', rows: 7, viaScript: true }),
    ];
    expect(buildInitialImportSummary(outcomes, false)).toContain(
      'Из записанных файлов разобрано скриптом: 2.',
    );
    expect(buildRetrySummary(outcomes, 1, false)).toContain('разобрано скриптом: 2');
    expect(buildInitialImportSummary([outcome({ rows: 1 })], false)).not.toContain('скриптом');
  });

  test('причина «скрипт не помог» читается словами', () => {
    const text = buildInitialImportSummary(
      [outcome({ status: 'skipped', reason: 'needs_review:complex_table,script_did_not_help' })],
      false,
    );
    expect(text).toContain('нужна проверка (сложная таблица, скрипт не помог)');
  });
});

describe('reportToManager: «скрипт не помог»', () => {
  const exhausted = (): ScriptTurnCounters => ({
    steps: SCRIPT_FIX_STEPS,
    scriptSeriesStart: 0,
    scriptExhausted: true,
  });
  const ctxWith = (counters: ScriptTurnCounters, threadId = 'manager-thread'): ToolContext =>
    createToolContext({
      threadId,
      agentId: PRICES_AGENT_ID,
      operationId: 'op',
      scriptTurn: scriptTurnOf(counters),
    });
  const input = { kind: 'needs_review' as const, path: 'a/b.xlsx', fileHash: 'h1', issueCodes: [] };

  test('сообщение менеджеру получает пометку, когда скрипт пробовали и он не помог', async () => {
    const deps = await buildFullPricesDeps();
    await reportToManager.execute(input, deps, ctxWith(exhausted()));
    const text = deps.chat.outbox.at(-1)?.message?.text ?? '';
    expect(text).toContain('скрипт не помог');
  });

  test('без попыток или после удачного скрипта пометки нет; другие виды итога - тоже', async () => {
    const deps = await buildFullPricesDeps();
    await reportToManager.execute(input, deps, ctxWith({ steps: 1 }));
    await reportToManager.execute(
      { ...input, fileHash: 'h2' },
      deps,
      ctxWith({ ...exhausted(), scriptHelped: true }),
    );
    await reportToManager.execute(
      { ...input, fileHash: 'h3', kind: 'import_done' },
      deps,
      ctxWith(exhausted()),
    );
    for (const item of deps.chat.outbox) {
      expect(item.message?.text).not.toContain('скрипт не помог');
    }
  });

  test('в первичном импорте причина пропуска получает код script_did_not_help', async () => {
    const deps = await buildFullPricesDeps();
    const scheduler = new MemoryScheduler(ids);
    const file = 'Сложный/прайс.csv';
    (deps.files as import('../../src/kit/adapters/index.shim').MemoryFileSource).put(
      file,
      encode('Наименование,Цена\nБолт,10'),
      1_000,
    );
    await runPriceDiskSync(deps, scheduler, { initialImport: true });
    const thread = diskSyncThreadId(file);
    await reportToManager.execute(
      { ...input, path: file, issueCodes: ['complex_table'] },
      deps,
      ctxWith(exhausted(), thread),
    );
    await runPriceDiskSync(deps, scheduler, { initialImport: true });
    const summary = deps.chat.outbox
      .filter((item) => item.threadId === RESPONSIBLE_THREAD)
      .map((item) => item.message?.text ?? '')
      .join('\n');
    expect(summary).toContain('скрипт не помог');
  });
});
