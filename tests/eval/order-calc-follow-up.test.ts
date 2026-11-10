import { describe, expect, test } from 'bun:test';
import { pickButtonId, pickDoneButtonId } from '../../src/agents/order-calc/choice-confirmation';
import { toOrderCalcCase, type OrderCalcCase } from '../../eval/cases';
import { loadCases } from '@business-ai/eval';
import { DEFAULT_CASES_DIR, DEFAULT_RECORDINGS_DIR } from '../../eval/paths';
import {
  parseDoneTokens,
  parsePickPresses,
  renderPickPlaceholders,
} from '../../eval/environments/order-calc';
import { replaySessions } from '@business-ai/eval';
import { runCase } from '@business-ai/eval';

const REQUEST_ID = 'req-1';
const VERSION = 'v-abc';

describe('кнопки выбора в реплике человека (order-calc, R4-AGT-12)', () => {
  test('метка {pick:id} превращается в id кнопки из pickButtonId ядра', () => {
    const text = renderPickPlaceholders('Нажата кнопка: {pick:s1}', REQUEST_ID, VERSION);
    expect(text).toBe(`Нажата кнопка: ${pickButtonId(REQUEST_ID, VERSION, 's1')}`);
  });

  test('метка {done} превращается в pickDoneButtonId и разбирается обратно', () => {
    const text = renderPickPlaceholders('Нажата кнопка: {done}', REQUEST_ID, VERSION);
    expect(text).toBe(`Нажата кнопка: ${pickDoneButtonId(REQUEST_ID, VERSION)}`);
    expect(parseDoneTokens(text)).toHaveLength(1);
    expect(parseDoneTokens('Готово')).toEqual([]);
    expect(parsePickPresses(text)).toEqual([]);
  });

  test('нажатие разбирается на отпечаток и поставщика, по порядку', () => {
    const a = pickButtonId(REQUEST_ID, VERSION, 's1');
    const b = pickButtonId(REQUEST_ID, VERSION, 'ext-00a1234567890123');
    const presses = parsePickPresses(`Нажата кнопка: ${a}. И ещё ${b}`);
    expect(presses.map((p) => p.supplierId)).toEqual(['s1', 'ext-00a1234567890123']);
    expect(new Set(presses.map((p) => p.token)).size).toBe(1);
  });

  test('старый формат pick:<id> без отпечатка ничего не подтверждает', () => {
    expect(parsePickPresses('Нажата кнопка: pick:s1 и pick:s2')).toEqual([]);
  });

  test('реплика без кнопок ничего не подтверждает', () => {
    expect(parsePickPresses('Готово')).toEqual([]);
    expect(parsePickPresses('pickdone:abc')).toEqual([]);
    expect(parsePickPresses('pick: s1')).toEqual([]);
  });
});

describe('кейс order-calc-shortlist-pick: выбор ответом менеджера', () => {
  const found = loadCases(DEFAULT_CASES_DIR).find((c) => c.id === 'order-calc-shortlist-pick');
  if (found === undefined || found.agent !== 'order-calc') throw new Error('нет кейса');
  const testCase: OrderCalcCase = toOrderCalcCase(found);
  const sessions = replaySessions(DEFAULT_RECORDINGS_DIR);

  async function runModelA(turned: OrderCalcCase) {
    const session = await sessions('model-a', turned);
    if (session === null) throw new Error('нет записи');
    return runCase(turned, 'model-a', session);
  }

  test('ответ менеджера одной репликой текстом, без кнопок', () => {
    expect(testCase.followUps).toEqual(['Берём МеталлТорг и Болтик']);
    expect(testCase.followUps[0]).not.toMatch(/\{pick:|\{done\}|(^|\s)pick:/);
  });

  test('писем нет; выбор записан ответом менеджера и равен подтверждению', async () => {
    const run = await runModelA(testCase);
    const byName = new Map(run.checks.map((c) => [c.name, c]));
    for (const name of [
      'turn1:confirmedSupplierCount',
      'turn1:mailSent',
      'state:selectionMatchesConfirmation',
    ]) {
      expect(byName.get(name)?.passed).toBe(true);
    }
    expect(run.passed).toBe(true);
  });

  test('ход, до которого прогон не дошёл, проваливает проверку', async () => {
    const withTurn = {
      ...testCase,
      expect: {
        ...testCase.expect,
        turnChecks: [
          ...testCase.expect.turnChecks,
          { turn: 2, probe: 'chatMessages', op: 'gte' as const, value: 99 },
        ],
      },
    };
    const run = await runModelA(withTurn);
    expect(run.checks.find((c) => c.name === 'turn2:chatMessages')?.passed).toBe(false);
  });
});
