import { describe, expect, test } from 'bun:test';
import { loadCases } from '@business-ai/eval';
import { pragmatikaProject } from '../../src';
import { HANDOFF_TO_PRICES_TOOL } from '../../src/agents/order-calc/handoff-to-prices';
import { pragmatikaEvalSpec } from '../../eval';
import { DEFAULT_CASES_DIR, DEFAULT_RECORDINGS_DIR } from '../../eval/paths';

/** Агент, которого гоняет набор по передачам: раннер платформы берёт первого из `agentIds`. */
const HANDOFF_AGENT_ID = 'order-calc';
/** Сколько моделей записано на каждый кейс (две синтетические). */
const MODELS_PER_CASE = 2;

describe('eval/index: описание проекта для раннера', () => {
  const manifestEval = pragmatikaProject.eval;

  test('в манифесте есть описание eval', () => {
    expect(manifestEval).toBeDefined();
  });

  test('агенты spec - те же, что в манифесте, без потерь и повторов', () => {
    const expected = [...(manifestEval?.agentIds ?? [])].sort();
    expect([...pragmatikaEvalSpec.agentIds].sort()).toEqual(expected);
    expect(new Set(pragmatikaEvalSpec.agentIds).size).toBe(pragmatikaEvalSpec.agentIds.length);
  });

  test('агент набора по передачам стоит первым', () => {
    expect(pragmatikaEvalSpec.agentIds[0]).toBe(HANDOFF_AGENT_ID);
  });

  test('имена замеров берутся из манифеста', () => {
    expect(pragmatikaEvalSpec.probeNames).toEqual(manifestEval?.probeNames ?? {});
  });

  test('схема состояния есть у каждого агента', () => {
    expect(Object.keys(pragmatikaEvalSpec.stateSchemas ?? {}).sort()).toEqual(
      [...pragmatikaEvalSpec.agentIds].sort(),
    );
  });

  test('набор по передачам гоняет передачу агенту прайсов', () => {
    expect(pragmatikaEvalSpec.handoffToolName).toBe(HANDOFF_TO_PRICES_TOOL);
    expect(pragmatikaEvalSpec.buildHandoffEnvironment).toBeDefined();
  });
});

describe('eval: данные проекта', () => {
  test('кейсы читаются схемой проекта, у каждого известный агент', () => {
    const cases = loadCases(DEFAULT_CASES_DIR);
    expect(cases.length).toBeGreaterThan(0);
    const known = new Set(pragmatikaEvalSpec.agentIds);
    expect(cases.filter((testCase) => !known.has(testCase.agent)).map((c) => c.id)).toEqual([]);
  });

  test('на каждый кейс есть записи обеих синтетических моделей', () => {
    const cases = loadCases(DEFAULT_CASES_DIR);
    const files = new Bun.Glob('*.json').scanSync({ cwd: DEFAULT_RECORDINGS_DIR });
    const recorded = new Set([...files].map((name) => name.replace(/\.model-[ab]\.json$/, '')));
    const counted = [...recorded].length;
    expect(counted).toBeGreaterThan(0);
    for (const testCase of cases) {
      if (!recorded.has(testCase.id)) continue;
      const models = [...new Bun.Glob(`${testCase.id}.model-*.json`).scanSync({
        cwd: DEFAULT_RECORDINGS_DIR,
      })];
      expect(models.length).toBe(MODELS_PER_CASE);
    }
  });
});
