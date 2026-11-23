import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { buildReport, renderMarkdown, writeReport } from '@business-ai/eval';
import type { EvalRunOutput, RunResult } from '@business-ai/eval';
import { tempDir } from './support';

function run(overrides: Partial<RunResult>): RunResult {
  return {
    caseId: 'c1',
    agent: 'prices',
    model: 'model-a',
    passed: true,
    checks: [{ name: 'max_steps', passed: true, detail: '2 из 3' }],
    steps: 2,
    inputTokens: 100,
    outputTokens: 10,
    cost: 0.5,
    latencyMs: 1_000,
    toolNames: [],
    leaks: [],
    leakChecked: false,
    synthetic: false,
    staleRecording: false,
    ...overrides,
  };
}

const OUTPUT: EvalRunOutput = {
  runs: [
    run({}),
    run({ caseId: 'c2', steps: 4, inputTokens: 300, cost: null, latencyMs: 3_000 }),
    run({
      caseId: 'c3',
      passed: false,
      checks: [{ name: 'tool_required:x', passed: false, detail: 'не вызван' }],
      leaks: ['запрос #0: имя №1 из словаря'],
      leakChecked: true,
    }),
    run({ model: 'model-b', agent: 'documents', inputTokens: null, outputTokens: null }),
  ],
  skipped: [
    { caseId: 'c9', agent: 'prices', model: 'model-x', reason: 'нет записи ответов модели' },
  ],
};

const INFO = { date: '2026-10-07', mode: 'replay' as const };

describe('отчёт', () => {
  const data = buildReport(OUTPUT, INFO);

  test('сводка по паре агент × модель: доля, средние, пропуск неизвестных значений', () => {
    const group = data.groups.find((g) => g.agent === 'prices' && g.model === 'model-a');
    expect(group).toMatchObject({ runs: 3, passed: 2, avgSteps: (2 + 4 + 2) / 3 });
    expect(group?.passRate).toBeCloseTo(2 / 3);
    expect(group?.avgInputTokens).toBeCloseTo(166.667, 2);
    expect(group?.avgCost).toBe(0.5);
    const unknown = data.groups.find((g) => g.model === 'model-b');
    expect(unknown?.avgInputTokens).toBeNull();
  });

  test('провалы с причинами и сводка по утечкам', () => {
    expect(data.failures).toEqual([
      {
        caseId: 'c3',
        agent: 'prices',
        model: 'model-a',
        reasons: ['tool_required:x: не вызван'],
      },
    ]);
    expect(data.pii).toMatchObject({ checkedRuns: 1, uncheckedRuns: 3, leakCount: 1 });
  });

  test('markdown содержит таблицу, провалы, ПДн и пропуски', () => {
    const text = renderMarkdown(data);
    expect(text).toContain('| prices | model-a | 3 | 2 (67%) |');
    expect(text).toContain('н/д');
    expect(text).toContain('tool_required:x: не вызван');
    expect(text).toContain('Найдено утечек: **1**');
    expect(text).toContain('c9 × model-x');
  });

  test('без провалов и утечек отчёт так и говорит', () => {
    const clean = renderMarkdown(buildReport({ runs: [run({})], skipped: [] }, INFO));
    expect(clean).toContain('Провалов нет.');
    expect(clean).toContain('Найдено утечек: **0**');
  });

  test('файлы <дата>.md и <дата>.json записываются', () => {
    const dir = tempDir();
    const paths = writeReport(dir, data);
    expect(paths.md.endsWith('2026-10-07.md')).toBe(true);
    expect(existsSync(paths.md)).toBe(true);
    const json: unknown = JSON.parse(readFileSync(paths.json, 'utf8'));
    expect(json).toMatchObject({ date: '2026-10-07', mode: 'replay' });
  });

  test('в json нет текстов ответов и запросов', () => {
    expect(Object.keys(data.runs[0] ?? {})).not.toContain('output');
  });

  test('R4-AGT-13: «0 утечек» относится только к прогонам с проверкой', () => {
    const none = buildReport({ runs: [run({}), run({ caseId: 'c2' })], skipped: [] }, INFO);
    expect(none.pii).toMatchObject({ checkedRuns: 0, uncheckedRuns: 2, checkedShare: 0 });
    const text = renderMarkdown(none);
    expect(text).toContain('Прогонов с проверкой: 0 из 2');
    expect(text).toContain('не выполнялась');
    const half = buildReport(
      { runs: [run({ leakChecked: true }), run({ caseId: 'c2' })], skipped: [] },
      INFO,
    );
    expect(half.pii.checkedShare).toBe(0.5);
    expect(renderMarkdown(half)).toContain('только по 1 прогонам с проверкой');
  });

  test('R4-AGT-13: охват проверки ПДн сверяется с порогом', () => {
    const half = buildReport(
      { runs: [run({ leakChecked: true }), run({ caseId: 'c2' })], skipped: [] },
      INFO,
    );
    expect(half.pii.coverageOk).toBe(false);
    expect(renderMarkdown(half)).toContain('ниже порога');
    const relaxed = buildReport(
      { runs: [run({ leakChecked: true }), run({ caseId: 'c2' })], skipped: [] },
      { ...INFO, minPiiShare: 0.5 },
    );
    expect(relaxed.pii.coverageOk).toBe(true);
    const full = buildReport({ runs: [run({ leakChecked: true })], skipped: [] }, INFO);
    expect(full.pii.coverageOk).toBe(true);
  });

  test('R4-AGT-13: синтетика помечена в заголовке таблицы, устаревшие записи считаются', () => {
    const mixed = buildReport(
      {
        runs: [run({ synthetic: true, staleRecording: true }), run({ caseId: 'c2' })],
        skipped: [],
      },
      INFO,
    );
    expect(mixed).toMatchObject({ syntheticRuns: 1, staleRuns: 1 });
    const text = renderMarkdown(mixed);
    expect(text).toMatch(/## Агент × модель \(синтетика: 1 из 2/);
    expect(text).toContain('Запись устарела');
    expect(text).toContain('не для выбора модели');
    const live = renderMarkdown(buildReport({ runs: [run({})], skipped: [] }, INFO));
    expect(live).toContain('## Агент × модель\n');
  });
});
