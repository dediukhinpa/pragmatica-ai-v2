import { describe, expect, test } from 'bun:test';
import { HANDOFF_TO_PRICES_TOOL } from '../../src/agents/order-calc/handoff-to-prices';
import { loadCases } from '@business-ai/eval';
import {
  AGENT_IDS,
  DEFAULT_CASES_DIR,
  DEFAULT_HANDOFF_CASES_DIR,
  DEFAULT_HANDOFF_RECORDINGS_DIR,
} from '../../eval/paths';
import { HANDOFF_CATEGORIES, loadHandoffCases, parseHandoffCase } from '@business-ai/eval';
import type { HandoffVerdict } from '@business-ai/eval';
import { handoffReportData, runHandoffSuite } from '@business-ai/eval';
import { readRecording } from '@business-ai/eval';
import { replaySessions } from '@business-ai/eval';
import {
  HANDOFF_SCENARIOS,
  HANDOFF_SYNTHETIC_ALIASES,
  recordHandoffSynthetic,
} from '../../eval/synthetic/handoff-scenarios';

/** Тест пересоздаёт все синтетические записи: на слабом хосте дольше 5 с. */
const SLOW_TEST_MS = 60_000;

const cases = loadHandoffCases(DEFAULT_HANDOFF_CASES_DIR);
const sessions = replaySessions(DEFAULT_HANDOFF_RECORDINGS_DIR);

/** Ожидаемая оценка синтетической model-b по кейсам (сценарии написаны именно так). */
const MODEL_B_VERDICTS: Readonly<Record<string, HandoffVerdict>> = {
  'handoff-need-explicit': 'wrong',
  'handoff-need-stale-prices': 'wrong',
  'handoff-no-need-regular-flow': 'wrong',
  'handoff-no-need-prices-fresh': 'correct',
  'handoff-unavailable-access-denied': 'wrong',
  'handoff-unavailable-target-not-listed': 'wrong',
  'handoff-ambiguous-prices-state': 'warning',
  'handoff-ambiguous-complaint': 'correct',
};

describe('набор по передачам: кейсы', () => {
  test('есть все четыре категории, по два кейса, id не пересекаются с основным набором', () => {
    for (const category of HANDOFF_CATEGORIES) {
      expect(cases.filter((item) => item.category === category)).toHaveLength(2);
    }
    const main = loadCases(DEFAULT_CASES_DIR).map((item) => item.id);
    for (const item of cases) expect(main).not.toContain(item.id);
  });

  test('каталог передач не входит в основной набор агентов', () => {
    expect(AGENT_IDS as readonly string[]).not.toContain('handoff');
    expect(loadCases(DEFAULT_CASES_DIR).every((item) => !item.id.startsWith('handoff-'))).toBe(
      true,
    );
  });

  test('есть кейс с закрытым доступом и кейс с целью вне списка', () => {
    expect(cases.some((item) => item.access === 'denied')).toBe(true);
    const outside = cases.find((item) => item.id === 'handoff-unavailable-target-not-listed');
    expect(outside?.evalCase.expect.forbiddenTools).toContain(HANDOFF_TO_PRICES_TOOL);
  });

  test('в каждом кейсе включена проверка ПДн', () => {
    for (const item of cases) expect(item.evalCase.expect.noPiiInRequests).toBe(true);
  });
});

describe('набор по передачам: схема', () => {
  const base = {
    id: 'handoff-x',
    description: 'кейс',
    request: 'запрос',
    state: {
      requests: [
        {
          id: 'req-1',
          dealRef: 'D-1',
          items: [{ name: 'Болт', quantity: 1, unit: 'шт' }],
          createdAt: '2026-01-01T00:00:00.000Z',
          slaDeadline: '2026-01-02T00:00:00.000Z',
        },
      ],
    },
  };
  const parse = (override: object): unknown =>
    parseHandoffCase('x.json', JSON.stringify({ ...base, ...override }));

  test('need без обязательного вызова передачи не принимается', () => {
    const bad = {
      expect: { maxSteps: 3 },
      handoff: { category: 'need', allowedHandoffCalls: 1 },
    };
    expect(() => parse(bad)).toThrow('need: обязателен вызов передачи');
  });

  test('no_need без запрета передачи не принимается', () => {
    const bad = { expect: { maxSteps: 3 }, handoff: { category: 'no_need' } };
    expect(() => parse(bad)).toThrow('no_need: передача запрещена');
  });

  test('unavailable без проверки handoffsQueued = 0 не принимается', () => {
    const bad = { expect: { maxSteps: 3 }, handoff: { category: 'unavailable' } };
    expect(() => parse(bad)).toThrow('handoffsQueued');
  });

  test('неизвестный замер и лишние поля отвергаются', () => {
    const stateChecks = [{ probe: 'nope', value: 0 }];
    const unknownProbe = {
      expect: { maxSteps: 3, stateChecks },
      handoff: { category: 'ambiguous' },
    };
    expect(() => parse(unknownProbe)).toThrow('неизвестная проверка');
    expect(() => parse({ extra: 1, expect: { maxSteps: 3 } })).toThrow();
  });

  test('закрытый доступ вне категории unavailable не принимается', () => {
    const bad = {
      expect: { maxSteps: 3 },
      handoff: { category: 'ambiguous', access: 'denied' },
    };
    expect(() => parse(bad)).toThrow('закрытый доступ');
  });
});

describe('набор по передачам: replay на синтетических записях', () => {
  test('есть сценарий и запись под каждый кейс и алиас', () => {
    for (const item of cases) {
      for (const model of HANDOFF_SYNTHETIC_ALIASES) {
        expect(HANDOFF_SCENARIOS[item.id]?.[model]).toBeDefined();
        expect(readRecording(DEFAULT_HANDOFF_RECORDINGS_DIR, item.id, model)).not.toBeNull();
      }
    }
  });

  test('записи совпадают с тем, что дают сценарии на текущих агентах (нет дрейфа)', async () => {
    for (const item of cases) {
      for (const model of HANDOFF_SYNTHETIC_ALIASES) {
        const fresh = await recordHandoffSynthetic(item, model);
        const stored = readRecording(DEFAULT_HANDOFF_RECORDINGS_DIR, item.id, model);
        expect(fresh).toEqual(stored!);
      }
    }
  }, SLOW_TEST_MS);

  test('model-a выбирает верно во всех кейсах без лишних передач', async () => {
    const output = await runHandoffSuite({ cases, models: ['model-a'], sessions });
    expect(output.skipped).toEqual([]);
    expect(output.judgements.map((j) => `${j.caseId}:${j.verdict}:${j.reason}`)).toEqual(
      cases.map((item) => `${item.id}:correct:ок`),
    );
    const [stats] = output.stats;
    expect(stats?.correctShare).toBe(1);
    expect(stats?.extraHandoffs).toBe(0);
    expect(stats?.warnings).toBe(0);
  });

  test('model-b: ожидаемые оценки, лишние передачи, предупреждение и шаги', async () => {
    const output = await runHandoffSuite({ cases, models: ['model-b'], sessions });
    for (const judgement of output.judgements) {
      expect(judgement.verdict).toBe(MODEL_B_VERDICTS[judgement.caseId]!);
    }
    const byId = new Map(output.judgements.map((j) => [j.caseId, j]));
    // Повтор передачи (2 вызова при допустимом 1) и передача не туда или без нужды
    expect(byId.get('handoff-need-explicit')?.extraHandoffs).toBe(1);
    expect(byId.get('handoff-no-need-regular-flow')?.extraHandoffs).toBe(1);
    expect(byId.get('handoff-unavailable-target-not-listed')?.extraHandoffs).toBe(1);
    // Двусмысленный запрос: передача без уточнения — предупреждение, не ошибка
    expect(byId.get('handoff-ambiguous-prices-state')?.reason).toBe('передача без уточнения');
    const [stats] = output.stats;
    expect(stats?.correct).toBe(2);
    expect(stats?.warnings).toBe(1);
    expect(stats?.wrong).toBe(5);
    expect(stats?.correct).toBe(
      output.judgements.filter((j) => j.verdict === 'correct').length,
    );
    // Вызовы передачи видны и там, где политика их отклонила (кейс с закрытым доступом)
    expect(byId.get('handoff-unavailable-access-denied')?.handoffCalls).toBe(1);
  });

  test('шаги и метрики по категориям считаются по прогонам', async () => {
    const output = await runHandoffSuite({ cases, models: ['model-a'], sessions });
    const [stats] = output.stats;
    const totalSteps = output.judgements.reduce((sum, j) => sum + j.steps, 0);
    expect(stats?.avgSteps).toBeCloseTo(totalSteps / cases.length);
    expect(stats?.byCategory.map((c) => `${c.category}:${c.correct}/${c.runs}`)).toEqual([
      'need:2/2',
      'no_need:2/2',
      'unavailable:2/2',
      'ambiguous:2/2',
    ]);
  });

  test('передача действительно ставится: запись, а не только вызов инструмента', async () => {
    const need = cases.filter((item) => item.category === 'need');
    const output = await runHandoffSuite({ cases: need, models: ['model-a'], sessions });
    for (const run of output.runs) {
      expect(run.toolNames).toContain(HANDOFF_TO_PRICES_TOOL);
      const state = run.checks.find((check) => check.name === 'state:handoffsQueued');
      expect(state).toMatchObject({ passed: true, detail: '1' });
    }
  });

  test('утечек ПДн нет, проверка выполнена в каждом прогоне', async () => {
    const output = await runHandoffSuite({
      cases,
      models: ['model-a', 'model-b'],
      sessions,
    });
    expect(output.runs.every((run) => run.leakChecked)).toBe(true);
    expect(handoffReportData(output, { date: '2026-01-01', mode: 'replay' }).leakCount).toBe(0);
  });

  test('без записи пара пропускается, а не засчитывается', async () => {
    const output = await runHandoffSuite({ cases, models: ['нет-такой'], sessions });
    expect(output.judgements).toEqual([]);
    expect(output.skipped).toHaveLength(cases.length);
  });
});
