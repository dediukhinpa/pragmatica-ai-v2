import { describe, expect, test } from 'bun:test';
import { parseCase } from '@business-ai/eval';
import { evaluateRun, evaluateTurnChecks, isSubsequence, type RunFacts } from '@business-ai/eval';
import type { EvalEnvironment } from '@business-ai/eval';

const baseCase = (expectation: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseCase(
    'x.json',
    JSON.stringify({
      id: 'c1',
      agent: 'prices',
      description: 'd',
      request: 'r',
      state: {},
      expect: { maxSteps: 3, ...expectation },
      ...extra,
    }),
  );

const ENV: EvalEnvironment = {
  declaration: { id: 'x', prompt: '', tools: [], validators: [], model: 'm' },
  toolDeps: {},
  probe: async (name) => (name === 'chatMessages' ? 1 : null),
};

const FACTS: RunFacts = {
  status: 'completed',
  output: 'Прайс обновлён',
  toolNames: ['readPriceFile', 'savePriceImport'],
  steps: 3,
  requestBodies: ['чисто'],
  replayExhausted: false,
};

const failed = async (testCase: ReturnType<typeof baseCase>, facts: RunFacts = FACTS) =>
  (await evaluateRun(testCase, facts, ENV)).checks.filter((c) => !c.passed).map((c) => c.name);

describe('isSubsequence', () => {
  test('порядок учитывается, лишние вызовы между ними допустимы', () => {
    expect(isSubsequence(['a', 'c'], ['a', 'b', 'c'])).toBe(true);
    expect(isSubsequence(['c', 'a'], ['a', 'b', 'c'])).toBe(false);
    expect(isSubsequence([], [])).toBe(true);
  });
});

describe('evaluateRun', () => {
  test('все ожидания выполнены', async () => {
    const testCase = baseCase({
      requiredTools: ['savePriceImport'],
      forbiddenTools: ['commitPriceImport'],
      outputContains: ['обновлён'],
      outputMatches: ['^Прайс'],
      stateChecks: [{ probe: 'chatMessages', value: 1 }],
    });
    expect(await failed(testCase)).toEqual([]);
  });

  test('серия из десяти цифр в запросе проваливает прогон; токены замены - нет', async () => {
    const testCase = baseCase({});
    const body = 'срок 2026-10-09T08:12:34.567Z, [INN_1234567890]';
    const clean = { ...FACTS, requestBodies: [body] };
    expect(await failed(testCase, clean)).toEqual([]);
    const dirty = { ...FACTS, requestBodies: ['{"mtimeMs":1760000000000}', 'чисто'] };
    const { checks } = await evaluateRun(testCase, dirty, ENV);
    const check = checks.find((item) => item.name === 'no_digit_series');
    expect(check?.passed).toBe(false);
    // В описании только число находок, без самих значений.
    expect(check?.detail).toBe('1 серий из 10+ цифр в запросах');
  });

  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    [
      'каждая проверка отдельно: обязательный и запрещённый инструмент',
      { requiredTools: ['reportToManager'], forbiddenTools: ['savePriceImport'] },
      ['tool_required:reportToManager', 'tool_forbidden:savePriceImport'],
    ],
    [
      'порядок вызовов проверяется при toolOrder=ordered',
      { requiredTools: ['savePriceImport', 'readPriceFile'], toolOrder: 'ordered' },
      ['tool_order'],
    ],
    ['потолок шагов', { maxSteps: 2 }, ['max_steps']],
    ['статус: ожидали паузу, получили завершение', { expectedStatus: 'suspended' }, ['status']],
    [
      'текст ответа: подстрока без регистра, запрещённая подстрока, регулярка',
      {
        outputContains: ['ОБНОВЛЁН', 'отправлено'],
        outputNotContains: ['Прайс'],
        outputMatches: ['^ничего$'],
      },
      ['output_contains:отправлено', 'output_not_contains:Прайс', 'output_matches:^ничего$'],
    ],
    [
      'состояние: сравнение и отсутствие значения',
      {
        stateChecks: [
          { probe: 'chatMessages', op: 'gte', value: 2 },
          { probe: 'storedPrice', arg: 's1:Болт', value: 1 },
        ],
      },
      ['state:chatMessages', 'state:storedPrice(s1:Болт)'],
    ],
  ];

  test.each(cases)('%s', async (_name, expectation, names) => {
    expect(await failed(baseCase(expectation))).toEqual(names);
  });

  test('ошибка прогона и исчерпание записи — отдельные проверки', async () => {
    const facts: RunFacts = { ...FACTS, status: null, runError: 'boom', replayExhausted: true };
    expect(await failed(baseCase({}), facts)).toEqual(['run_finished', 'replay_consistent']);
  });

  test('R4-AGT-13: устаревшая запись проваливает прогон отдельной проверкой', async () => {
    const facts: RunFacts = { ...FACTS, replayStale: true };
    expect(await failed(baseCase({}), facts)).toEqual(['replay_fresh']);
    expect(await failed(baseCase({}), { ...FACTS, replayStale: false })).toEqual([]);
  });

  test('утечка ПДн находится и в описании нет значения', async () => {
    const testCase = baseCase(
      { noPiiInRequests: true },
      { pii: { names: ['Иванов'] } },
    );
    const facts: RunFacts = { ...FACTS, requestBodies: ['звонил Иванов'] };
    const result = await evaluateRun(testCase, facts, ENV);
    expect(result.leaks).toHaveLength(1);
    expect(result.leakChecked).toBe(true);
    expect(JSON.stringify(result.checks)).not.toContain('Иванов');
  });

  test('с явным noPiiInRequests=false утечки не ищутся', async () => {
    const testCase = baseCase({ noPiiInRequests: false }, { pii: { names: ['Иванов'] } });
    const facts: RunFacts = { ...FACTS, requestBodies: ['звонил Иванов'] };
    const result = await evaluateRun(testCase, facts, ENV);
    expect(result.leaks).toEqual([]);
    expect(result.leakChecked).toBe(false);
  });
});

// Пробел платформы: раннер платформы не считает выбор менеджера (проверка `manager_choice`,
// `EvalEnvironment.proposal`, `Evaluation.managerChoice`). Метка `expectedManagerChoice` лежит в
// состоянии кейсов order-calc как данные; тесты прежнего раннера ждут расширения платформы.
describe('метка выбора менеджера', () => {
  test.todo('метка в шорт-листе, но не первая', () => undefined);
  test.todo('метки нет в шорт-листе или шорт-листа нет: проверка падает', () => undefined);
});

describe('проверки после хода (turnChecks, R4-AGT-12)', () => {
  const turnCase = baseCase({
    turnChecks: [
      { turn: 1, probe: 'chatMessages', value: 1 },
      { turn: 2, probe: 'chatMessages', op: 'gte', value: 5 },
      { turn: 1, probe: 'storedPrice', arg: 's1:Болт', value: 1 },
    ],
  }, { followUps: ['a', 'b'] });

  test('проверяются только записи своего хода; имя содержит номер хода', async () => {
    const first = await evaluateTurnChecks(turnCase.expect.turnChecks, 1, ENV);
    expect(first.map((c) => [c.name, c.passed])).toEqual([
      ['turn1:chatMessages', true],
      ['turn1:storedPrice(s1:Болт)', false],
    ]);
    const second = await evaluateTurnChecks(turnCase.expect.turnChecks, 2, ENV);
    expect(second.map((c) => [c.name, c.passed])).toEqual([['turn2:chatMessages', false]]);
  });

  test('результаты хода попадают в итог прогона', async () => {
    const turnChecks = await evaluateTurnChecks(turnCase.expect.turnChecks, 2, ENV);
    const result = await evaluateRun(turnCase, { ...FACTS, turnChecks }, ENV);
    expect(result.checks.map((c) => c.name)).toContain('turn2:chatMessages');
  });
});
