import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaseFileError, loadCases, parseCase } from '@business-ai/eval';
import { DEFAULT_CASES_DIR, AGENT_IDS } from '../../eval/paths';
import { tempDir } from './support';

const MINIMAL = {
  id: 'prices-min',
  agent: 'prices',
  description: 'минимальный',
  request: 'проверь',
  state: {},
  expect: { maxSteps: 3 },
};

const parse = (value: unknown) => parseCase('x.json', JSON.stringify(value));

describe('схема кейса', () => {
  test('минимальный кейс получает значения по умолчанию', () => {
    const testCase = parse(MINIMAL);
    expect(testCase.followUps).toEqual([]);
    expect(testCase.expect.expectedStatus).toBe('completed');
    expect(testCase.expect.noPiiInRequests).toBe(false);
    expect(testCase.pii).toEqual({ names: [], phones: [], emails: [] });
  });

  test('R2-S-8: проверка ПДн включается сама, если словарь pii не пуст; false отключает', () => {
    const pii = { names: ['Иванов'] };
    expect(parse({ ...MINIMAL, pii }).expect.noPiiInRequests).toBe(true);
    const off = { ...MINIMAL, pii, expect: { maxSteps: 3, noPiiInRequests: false } };
    expect(parse(off).expect.noPiiInRequests).toBe(false);
    const emptyPii = { ...MINIMAL, pii: { names: [], phones: [] } };
    expect(parse(emptyPii).expect.noPiiInRequests).toBe(false);
  });

  test('R4-AGT-12: turnChecks — номер хода в пределах followUps и известный замер', () => {
    const turn = { turn: 1, probe: 'chatMessages', value: 0 };
    const ok = { ...MINIMAL, followUps: ['a'], expect: { maxSteps: 3, turnChecks: [turn] } };
    expect(parse(ok).expect.turnChecks).toEqual([{ ...turn, op: 'eq' }]);
    const far = { ...ok, expect: { maxSteps: 3, turnChecks: [{ ...turn, turn: 2 }] } };
    expect(() => parse(far)).toThrow(/ход/);
    const unknown = { ...ok, expect: { maxSteps: 3, turnChecks: [{ ...turn, probe: 'nope' }] } };
    expect(() => parse(unknown)).toThrow(/nope/);
    expect(parse(MINIMAL).expect.turnChecks).toEqual([]);
  });

  test('неизвестное поле отвергается (опечатки не молчат)', () => {
    expect(() => parse({ ...MINIMAL, extra: 1 })).toThrow(CaseFileError);
    expect(() => parse({ ...MINIMAL, expect: { maxSteps: 3, maxStep: 1 } })).toThrow();
  });

  test('неизвестная проверка состояния отвергается', () => {
    const expectation = { maxSteps: 3, stateChecks: [{ probe: 'nope', value: 1 }] };
    expect(() => parse({ ...MINIMAL, expect: expectation })).toThrow(/неизвестная проверка/);
  });

  test('проверка состояния чужого агента отвергается', () => {
    const expectation = { maxSteps: 3, stateChecks: [{ probe: 'mailSent', value: 1 }] };
    expect(() => parse({ ...MINIMAL, expect: expectation })).toThrow(CaseFileError);
  });

  test('флаг ПДн без словаря отвергается', () => {
    const expectation = { maxSteps: 3, noPiiInRequests: true };
    expect(() => parse({ ...MINIMAL, expect: expectation })).toThrow(/словарь pii пуст/);
  });

  test('некорректная регулярка отвергается', () => {
    const expectation = { maxSteps: 3, outputMatches: ['('] };
    expect(() => parse({ ...MINIMAL, expect: expectation })).toThrow(/регулярное/);
  });

  test('метка выбора лежит в ожиданиях под именем expectedChoice', () => {
    const expectation = { maxSteps: 3, expectedChoice: 's1' };
    expect(parse({ ...MINIMAL, expect: expectation }).expect.expectedChoice).toBe('s1');
  });

  test('метка выбора в состоянии order-calc называется expectedChoice, прежнее имя отвергается', () => {
    const file = join(DEFAULT_CASES_DIR, 'order-calc', 'order-calc-shortlist-pick.json');
    const source = JSON.parse(readFileSync(file, 'utf8')) as { state: Record<string, unknown> };
    expect(parse(source).state).toMatchObject({ expectedChoice: 's1' });
    const { expectedChoice, ...rest } = source.state;
    const legacy = { ...source, state: { ...rest, expectedManagerChoice: expectedChoice } };
    expect(() => parse(legacy)).toThrow(CaseFileError);
  });

  test('id с недопустимыми символами отвергается', () => {
    expect(() => parse({ ...MINIMAL, id: 'Bad Id' })).toThrow(/id/);
  });

  test('не JSON', () => {
    expect(() => parseCase('x.json', '{oops')).toThrow(/не JSON/);
  });
});

describe('loadCases', () => {
  test('кейсы из репозитория валидны, у каждого агента минимум два', () => {
    // У «Актуализации сайта» кейсов публикации больше нет (публикацию удалили, этап 181),
    // кейсов под заполнение шаблона пока нет: проверка идёт по остальным агентам.
    for (const agent of AGENT_IDS.filter((id) => id !== 'site-export')) {
      expect(loadCases(DEFAULT_CASES_DIR, { agents: [agent] }).length).toBeGreaterThanOrEqual(2);
    }
  });

  test('фильтр по id', () => {
    const cases = loadCases(DEFAULT_CASES_DIR, { caseIds: ['prices-update-ok'] });
    expect(cases.map((c) => c.id)).toEqual(['prices-update-ok']);
  });

  test('агент в файле должен совпадать с каталогом', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'documents'));
    writeFileSync(join(dir, 'documents', 'a.json'), JSON.stringify(MINIMAL));
    expect(() => loadCases(dir)).toThrow(/не совпадает с каталогом/);
  });

  test('повтор id в разных файлах отвергается', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'prices'));
    writeFileSync(join(dir, 'prices', 'a.json'), JSON.stringify(MINIMAL));
    writeFileSync(join(dir, 'prices', 'b.json'), JSON.stringify(MINIMAL));
    expect(() => loadCases(dir)).toThrow(/повтор id/);
  });

  test('нет каталога — пустой список', () => {
    expect(loadCases(join(tempDir(), 'nope'))).toEqual([]);
  });
});
