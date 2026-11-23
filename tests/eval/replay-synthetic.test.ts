import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { loadCases } from '@business-ai/eval';
import { DEFAULT_CASES_DIR, DEFAULT_RECORDINGS_DIR } from '../../eval/paths';
import { readRecording } from '@business-ai/eval';
import { replaySessions } from '@business-ai/eval';
import { runEval, runCase, type RunResult } from '@business-ai/eval';
import { DictionaryPseudonymizer } from '@business-ai/eval';
import { SCENARIOS, SYNTHETIC_MODELS } from '../../eval/synthetic/scenarios';
import { recordSynthetic } from '../../eval/synthetic';
import { ReplayGateway } from '@business-ai/eval';

/** Тест перезаписывает все синтетические записи: на загруженном хосте дольше 5 с. */
const SLOW_TEST_MS = 60_000;
// Кейсы гоняются целиком в replay: с решениями текстом ходов стало больше, 5 с по умолчанию мало.
setDefaultTimeout(SLOW_TEST_MS);

const cases = loadCases(DEFAULT_CASES_DIR);

/** Что должно проваливаться у синтетической model-b (сценарии написаны именно так). */
const MODEL_B_FAILURES: Readonly<Record<string, readonly string[]>> = {
  'prices-price-jump-saved': [
    'tool_required:reportToManager',
    'tool_order',
    'state:chatMessages',
  ],
  'documents-template-missing': [
    'tool_required:findTemplate',
    'tool_forbidden:saveDocument',
    'output_matches:шаблон',
  ],
  'order-calc-shortlist-pick': ['max_steps'],
};

const failedNames = (run: RunResult): string[] =>
  run.checks.filter((check) => !check.passed).map((check) => check.name);

describe('синтетические кейсы в режиме replay', () => {
  test('есть сценарий и запись под каждый кейс и алиас, минимум 8 кейсов', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const testCase of cases) {
      for (const model of SYNTHETIC_MODELS) {
        expect(SCENARIOS[testCase.id]?.[model]).toBeDefined();
        expect(readRecording(DEFAULT_RECORDINGS_DIR, testCase.id, model)).not.toBeNull();
      }
    }
  });

  test('записи совпадают с тем, что дают сценарии на текущих агентах (нет дрейфа)', async () => {
    for (const testCase of cases) {
      for (const model of SYNTHETIC_MODELS) {
        const fresh = await recordSynthetic(testCase, model);
        expect(fresh).toEqual(readRecording(DEFAULT_RECORDINGS_DIR, testCase.id, model)!);
      }
    }
  }, SLOW_TEST_MS);

  test('model-a проходит все кейсы, у model-b проваливаются ровно ожидаемые проверки', async () => {
    const { runs, skipped } = await runEval({
      cases,
      models: [...SYNTHETIC_MODELS],
      sessions: replaySessions(DEFAULT_RECORDINGS_DIR),
    });
    expect(skipped).toEqual([]);
    expect(runs).toHaveLength(cases.length * SYNTHETIC_MODELS.length);
    for (const run of runs.filter((r) => r.model === 'model-a')) {
      expect(failedNames(run)).toEqual([]);
    }
    for (const run of runs.filter((r) => r.model === 'model-b')) {
      expect(failedNames(run)).toEqual([...(MODEL_B_FAILURES[run.caseId] ?? [])]);
    }
  });

  test('утечек ПДн нет, а проверка включена минимум в одном кейсе на агента', async () => {
    const { runs } = await runEval({
      cases,
      models: ['model-a'],
      sessions: replaySessions(DEFAULT_RECORDINGS_DIR),
    });
    expect(runs.flatMap((run) => run.leaks)).toEqual([]);
    const checkedAgents = new Set(runs.filter((r) => r.leakChecked).map((r) => r.agent));
    expect([...checkedAgents].sort()).toEqual(['documents', 'order-calc', 'prices']);
  });

  test('без псевдонимизации проверка ПДн срабатывает (проверка не пустая)', async () => {
    const testCase = cases.find((c) => c.id === 'prices-update-ok');
    if (testCase === undefined) throw new Error('нет кейса');
    const recording = readRecording(DEFAULT_RECORDINGS_DIR, testCase.id, 'model-a')!;
    const gateway = new ReplayGateway(recording);
    const run = await runCase(
      testCase,
      'model-a',
      { gateway, latencyOf: gateway.latencyOf },
      { pseudonymizerFor: () => new DictionaryPseudonymizer({}) },
    );
    expect(run.passed).toBe(false);
    expect(run.leaks.length).toBeGreaterThan(0);
    expect(failedNames(run)).toContain('no_pii');
  });

  test('нет записи для алиаса: пара пропускается, а не падает', async () => {
    const { runs, skipped } = await runEval({
      cases: cases.slice(0, 2),
      models: ['model-a', 'model-x'],
      sessions: replaySessions(DEFAULT_RECORDINGS_DIR),
    });
    expect(runs).toHaveLength(2);
    expect(skipped.map((s) => s.model)).toEqual(['model-x', 'model-x']);
  });

  test('токены и задержка берутся из записи, стоимость — из файла цен', async () => {
    const testCase = cases.find((c) => c.id === 'documents-template-missing');
    if (testCase === undefined) throw new Error('нет кейса');
    const recording = readRecording(DEFAULT_RECORDINGS_DIR, testCase.id, 'model-a')!;
    const gateway = new ReplayGateway(recording);
    const prices = {
      note: 'сверить вручную',
      currency: 'USD',
      models: { 'model-a': { inputPerMillion: 1_000_000, outputPerMillion: 0 } },
    };
    const run = await runCase(
      testCase,
      'model-a',
      { gateway, latencyOf: gateway.latencyOf },
      { tariffs: prices },
    );
    const input = recording.steps.reduce((sum, s) => sum + (s.usage.inputTokens ?? 0), 0);
    expect(run.inputTokens).toBe(input);
    expect(run.cost).toBe(input);
    expect(run.latencyMs).toBe(recording.steps.reduce((sum, s) => sum + s.latencyMs, 0));
    expect(run.steps).toBe(recording.steps.length);
  });

  test('R4-AGT-13: записи свежие и синтетические; подмена отпечатка даёт «устарела»', async () => {
    const { runs } = await runEval({
      cases,
      models: [...SYNTHETIC_MODELS],
      sessions: replaySessions(DEFAULT_RECORDINGS_DIR),
    });
    expect(runs.every((run) => run.synthetic)).toBe(true);
    expect(runs.some((run) => run.staleRecording)).toBe(false);

    const testCase = cases.find((c) => c.id === 'prices-update-ok');
    if (testCase === undefined) throw new Error('нет кейса');
    const recording = readRecording(DEFAULT_RECORDINGS_DIR, testCase.id, 'model-a')!;
    const steps = recording.steps.map((step, at) =>
      at === 1 ? { ...step, requestHash: 'устаревший' } : step,
    );
    const gateway = new ReplayGateway({ ...recording, steps });
    const run = await runCase(testCase, 'model-a', {
      gateway,
      latencyOf: gateway.latencyOf,
      isStale: () => gateway.stale,
      synthetic: gateway.synthetic,
    });
    expect(run.staleRecording).toBe(true);
    expect(run.passed).toBe(false);
    expect(failedNames(run)).toContain('replay_fresh');
  });
});
