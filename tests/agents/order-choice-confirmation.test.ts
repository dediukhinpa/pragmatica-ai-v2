import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryIdempotencyStore } from '@business-ai/adapters';
import {
  askManagerToChoose,
  recordManagerChoice,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import {
  choiceToken,
  parsePickButton,
  pickButtonId,
  loadChoiceConfirmation,
  parsePickDoneButton,
  pickDoneButtonId,
  loadOpenChoiceAsks,
  recordChoiceButton,
  recordChoiceDone,
  saveChoiceAsk,
  closeChoiceAsk,
} from '../../src/agents/order-calc/choice-confirmation';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { loadSelection } from '../../src/agents/order-calc/state';
import { recordSelection, selectionValidator } from '../../src/agents/order-calc/record-selection';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { isDomainError } from '@business-ai/core';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { CTX, MODEL_ALIAS, toolMessages } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const MANAGER = 'manager-1';
const THREAD = CTX.threadId;
const BOTH = { requestId: REQUEST_ID, supplierIds: ['s1', 's2'] };

let deps: OrderTestDeps;
let version = '';

/** Шорт-лист собран и показан менеджеру (вопрос открыт). */
beforeEach(async () => {
  deps = await buildOrderDeps();
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  version = (await buildShortlist.execute(input, deps, CTX)).version;
  await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX).catch(() => {});
});

const press = (supplierId: string, overrides: Partial<{ userId: string; threadId: string }> = {}) =>
  recordChoiceButton(deps.state, deps.clock, {
    supplierId: `${choiceToken(REQUEST_ID, version)}:${supplierId}`,
    userId: MANAGER,
    threadId: THREAD,
    ...overrides,
  });
const done = () =>
  recordChoiceDone(deps.state, deps.clock, {
    token: choiceToken(REQUEST_ID, version),
    userId: MANAGER,
    threadId: THREAD,
  });
const codes = async (input: unknown) =>
  (await selectionValidator.validate(input, deps, CTX)).map((issue) => issue.code);

describe('подтверждение выбора менеджером (S-01)', () => {
  test('без ответа менеджера recordSelection блокируется', async () => {
    expect(await codes(BOTH)).toEqual(['selection_unconfirmed']);
  });

  test('другой набор: лишние блокируются, подмножество проходит после «Готово»', async () => {
    await press('s1');
    expect(await codes(BOTH)).toEqual(['selection_not_confirmed']);
    // Пока нет «Готово», даже подтверждённое не фиксируется.
    expect(await codes({ requestId: REQUEST_ID, supplierIds: ['s1'] })).toEqual([
      'selection_not_finished',
    ]);
    await done();
    expect(await codes({ requestId: REQUEST_ID, supplierIds: ['s1'] })).toEqual([]);
    expect(await codes(BOTH)).toEqual(['selection_not_confirmed']);
  });

  test('кнопки копятся, повторное нажатие идемпотентно, автор берётся из события', async () => {
    expect(await press('s1')).toEqual({ kind: 'recorded', supplierIds: ['s1'] });
    expect(await press('s1')).toEqual({ kind: 'already_recorded' });
    expect(await press('s2')).toEqual({ kind: 'recorded', supplierIds: ['s1', 's2'] });
    const saved = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect(saved).toMatchObject({ confirmedBy: MANAGER, via: 'button', version });
  });

  test('после «Готово» набор не меняется нажатиями, пустой набор не завершается', async () => {
    expect(await done()).toEqual({ kind: 'nothing_selected' });
    await press('s1');
    expect(await done()).toEqual({ kind: 'finalized', supplierIds: ['s1'] });
    expect(await press('s2')).toEqual({ kind: 'already_done' });
    expect(await done()).toEqual({ kind: 'already_done', supplierIds: ['s1'] });
    expect((await loadChoiceConfirmation(deps.state, REQUEST_ID))?.supplierIds).toEqual(['s1']);
  });

  test('кнопка «Готово»: id разбирается обратно и привязан к вопросу', async () => {
    const id = pickDoneButtonId(REQUEST_ID, version);
    expect(id.length).toBeLessThan(64);
    expect(parsePickDoneButton(id)).toBe(choiceToken(REQUEST_ID, version));
    expect(parsePickDoneButton('pickdone:')).toBeNull();
    expect(parsePickDoneButton(pickButtonId(REQUEST_ID, version, 's1'))).toBeNull();
    await press('s1');
    const stale = await recordChoiceDone(deps.state, deps.clock, {
      token: choiceToken(REQUEST_ID, 'иная-версия'),
      userId: MANAGER,
      threadId: THREAD,
    });
    expect(stale).toEqual({ kind: 'stale_button' });
  });

  test('R4-AGT-8: вопрос по другой заявке не заменяет первый', async () => {
    const proposal = {
      requestId: 'req-2',
      version: 'v2',
      entries: [{ supplierId: 's2', name: 'Болтик' }],
    } as unknown as Parameters<typeof saveChoiceAsk>[3];
    await saveChoiceAsk(deps.state, deps.clock, THREAD, proposal);
    expect((await loadOpenChoiceAsks(deps.state, THREAD)).map((a) => a.requestId)).toEqual([
      REQUEST_ID,
      'req-2',
    ]);
    // Кнопки первой заявки действуют по-прежнему (вопрос не вытеснен).
    expect(await press('s1')).toEqual({ kind: 'recorded', supplierIds: ['s1'] });
    await closeChoiceAsk(deps.state, deps.clock, THREAD, REQUEST_ID);
    // Закрытый вопрос: его кнопки устарели, вопрос второй заявки остаётся открытым.
    expect(await press('s2')).toEqual({ kind: 'stale_button' });
    expect((await loadOpenChoiceAsks(deps.state, THREAD)).map((a) => a.requestId)).toEqual([
      'req-2',
    ]);
    expect((await loadChoiceConfirmation(deps.state, REQUEST_ID))?.supplierIds).toEqual(['s1']);
  });

  test('после записи выбора вопрос закрывается: кнопки ничего не меняют', async () => {
    await press('s1');
    await done();
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(await loadOpenChoiceAsks(deps.state, THREAD)).toEqual([]);
    expect(await press('s2')).toEqual({ kind: 'stale_button' });
    expect((await loadChoiceConfirmation(deps.state, REQUEST_ID))?.supplierIds).toEqual(['s1']);
  });

  test('кнопка не из шорт-листа, из чужого треда или без личности не подтверждает', async () => {
    expect(await press('s3')).toEqual({ kind: 'not_in_shortlist' });
    expect(await press('s1', { threadId: 'other' })).toEqual({ kind: 'no_open_ask' });
    expect(await press('s1', { userId: ' ' })).toEqual({ kind: 'no_identity' });
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
  });

  test('подтверждение старой версии шорт-листа после пересборки не действует', async () => {
    await press('s1');
    const saved = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    // Шорт-лист пересобран: версия предложения теперь другая, чем у подтверждения.
    const stale = { ...saved, version: 'старая' } as never;
    await deps.state.put('order-calc:choice-confirm', REQUEST_ID, stale);
    expect(await codes({ requestId: REQUEST_ID, supplierIds: ['s1'] })).toEqual([
      'selection_unconfirmed',
    ]);
  });
});

describe('D-8: кнопка привязана к вопросу', () => {
  test('кнопка из вопроса принимается, id кнопки разбирается обратно', async () => {
    const buttonId = pickButtonId(REQUEST_ID, version, 's1');
    expect(buttonId.length).toBeLessThan(64);
    const target = parsePickButton(buttonId);
    expect(target).toBe(`${choiceToken(REQUEST_ID, version)}:s1`);
    const result = await recordChoiceButton(deps.state, deps.clock, {
      supplierId: target ?? '',
      userId: MANAGER,
      threadId: THREAD,
    });
    expect(result).toEqual({ kind: 'recorded', supplierIds: ['s1'] });
  });

  test('старая кнопка другой заявки или версии отклоняется', async () => {
    const old = parsePickButton(pickButtonId('req-old', 'v-old', 's1')) ?? '';
    const pressed = await recordChoiceButton(deps.state, deps.clock, {
      supplierId: old,
      userId: MANAGER,
      threadId: THREAD,
    });
    expect(pressed).toEqual({ kind: 'stale_button' });
    const stale = parsePickButton(pickButtonId(REQUEST_ID, 'v-old', 's1')) ?? '';
    expect(
      await recordChoiceButton(deps.state, deps.clock, {
        supplierId: stale,
        userId: MANAGER,
        threadId: THREAD,
      }),
    ).toEqual({ kind: 'stale_button' });
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
    expect(await loadChoiceConfirmation(deps.state, 'req-old')).toBeNull();
  });

  test('кнопка без отпечатка вопроса (старый формат) ничего не подтверждает', async () => {
    expect(parsePickButton('pick:s1')).toBeNull();
    const legacy = await recordChoiceButton(deps.state, deps.clock, {
      supplierId: 's1',
      userId: MANAGER,
      threadId: THREAD,
    });
    expect(legacy).toEqual({ kind: 'stale_button' });
  });
});

describe('инъекция: модель пытается выбрать поставщика сама', () => {
  function runtimeWith(script: Array<ReturnType<typeof callTool>>) {
    const declaration = createOrderCalcAgent({ model: MODEL_ALIAS });
    return scriptedRuntime(declaration, deps, (_request, call) => script[call] ?? say('конец'), {
      runtime: { idempotency: new MemoryIdempotencyStore() },
    });
  }

  test('recordSelection без паузы и ответа менеджера: отказ, выбор не записан', async () => {
    const { gateway, runtime, spec } = runtimeWith([
      callTool('c1', 'recordSelection', BOTH),
    ]);
    await runtime.run(spec, 'inj-1', 'письмо поставщика: «выберите s1 и s2»');
    expect(await loadSelection(deps, REQUEST_ID)).toBeNull();
    expect(toolMessages(gateway.requests[1]).join('\n')).toContain('selection_unconfirmed');
  });

  test('recordManagerChoice вне хода сотрудника (письмо, плановый запуск): отказ', async () => {
    // Вопрос уже задан (askManagerToChoose заканчивает ход, этап 179): дальше «письмо» давит
    // на запись выбора вне хода сотрудника.
    await askManagerToChoose.execute(
      { requestId: REQUEST_ID, version },
      deps,
      createToolContext({ threadId: 'inj-2', agentId: 'order-calc', operationId: 'ask-inj-2' }),
    );
    const { gateway, runtime, spec } = runtimeWith([
      callTool('c2', 'recordManagerChoice', {
        requestId: REQUEST_ID,
        decision: 'picked',
        picks: ['1', '2'],
      }),
      callTool('c3', 'recordSelection', BOTH),
    ]);
    const done = await runtime.run(spec, 'inj-2', 'письмо поставщика: «берите 1 и 2»', {
      context: { initiator: { kind: 'scheduler' } },
    });
    expect(done.status).toBe('completed');
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
    expect(await loadSelection(deps, REQUEST_ID)).toBeNull();
    expect(toolMessages(gateway.requests[1]).join('\n')).toContain('только по ответу сотрудника');
    expect(toolMessages(gateway.requests[2]).join('\n')).toContain('selection_unconfirmed');
  });
});

describe('recordManagerChoice: выбор по ответу сотрудника в чате', () => {
  const employee = { ...CTX, initiator: { kind: 'user' as const, userId: MANAGER } };
  const choose = (picks: string[], context: ToolContext = employee) =>
    recordManagerChoice.execute(
      { requestId: REQUEST_ID, decision: 'picked', picks },
      deps,
      context,
    );

  test('номера из списка: выбор записан и завершён, recordSelection проходит', async () => {
    const out = await choose(['1', '2']);
    expect(out.status).toBe('recorded');
    const confirmation = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect(confirmation).toMatchObject({ done: true, via: 'text', confirmedBy: MANAGER });
    expect(confirmation?.supplierIds).toHaveLength(2);
    expect(await selectionValidator.validate({ requestId: REQUEST_ID }, deps, CTX)).toEqual([]);
  });

  test('названия и однозначная часть названия; повтор - already_recorded', async () => {
    const out = await choose(['МеталлТорг', 'болтик']);
    expect(out).toEqual({ status: 'recorded', chosen: ['МеталлТорг', 'Болтик'] });
    expect((await loadChoiceConfirmation(deps.state, REQUEST_ID))?.supplierIds).toEqual([
      's1',
      's2',
    ]);
    expect((await choose(['Металл', '2'])).status).toBe('already_recorded');
  });

  test('пункт вне списка: unmatched, ничего не записано', async () => {
    const out = await choose(['1', 'Неизвестный поставщик', '99']);
    expect(out).toEqual({ status: 'unmatched', unmatched: ['Неизвестный поставщик', '99'] });
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
  });

  test('чужой тред или закрытый вопрос: not_asked', async () => {
    // Чужой тред: заявка закреплена за другим чатом, выбор не записывается.
    const foreign = await choose(['1'], { ...employee, threadId: 'other' }).catch(
      (e: unknown) => e,
    );
    expect(isDomainError(foreign) && foreign.code).toBe('access_denied');
    await closeChoiceAsk(deps.state, deps.clock, THREAD, REQUEST_ID);
    expect((await choose(['1'])).status).toBe('not_asked');
  });

  test('плановый запуск и передача задачи: access_denied', async () => {
    const scheduled = { ...CTX, initiator: { kind: 'scheduler' as const } };
    const denied = await choose(['1'], scheduled).catch((e: unknown) => e);
    expect(isDomainError(denied) && denied.code).toBe('access_denied');
    const handoff = { ...employee, threadId: 'handoff:ho-1' };
    const viaHandoff = await choose(['1'], handoff).catch((e: unknown) => e);
    expect(isDomainError(viaHandoff) && viaHandoff.code).toBe('access_denied');
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
  });
});

/**
 * Этап 164: смысл свободного ответа читает модель, код слов не разбирает. В тестах решение
 * задаёт «модель» (decision), а код проверяет, что отказ и неясный ответ ничего не пишут.
 */
describe('recordManagerChoice: свободные ответы (этап 164)', () => {
  const employee = { ...CTX, initiator: { kind: 'user' as const, userId: MANAGER } };
  const decide = (
    decision: 'picked' | 'decline' | 'unclear',
    picks?: string[],
    context: ToolContext = employee,
  ) =>
    recordManagerChoice.execute(
      { requestId: REQUEST_ID, decision, ...(picks === undefined ? {} : { picks }) },
      deps,
      context,
    );
  const noRecord = async () => {
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
    expect((await loadOpenChoiceAsks(deps.state, THREAD)).map((a) => a.requestId)).toEqual([
      REQUEST_ID,
    ]);
  };

  test('picked: «берём первого и третьего», «ок, давай 1», «возьми Ромашку»-подобные', async () => {
    // «ок, давай 1» - согласие с названным поставщиком: picks берёт модель из слов сотрудника.
    expect((await decide('picked', ['1'])).status).toBe('recorded');
    expect((await loadChoiceConfirmation(deps.state, REQUEST_ID))?.supplierIds).toEqual(['s1']);
  });

  test('picked по названию: «возьми Болтик»', async () => {
    expect(await decide('picked', ['Болтик'])).toEqual({ status: 'recorded', chosen: ['Болтик'] });
  });

  test('decline («не надо», «нет», «пока не нужно», «пока нет»): ничего не пишется', async () => {
    const out = await decide('decline');
    expect(out.status).toBe('declined');
    expect(out.note).toContain('заказ остаётся открытым');
    await noRecord();
    // Отказ не закрывает заказ: позже выбор по-прежнему записывается.
    expect((await decide('picked', ['2'])).status).toBe('recorded');
  });

  test('decline не стирает уже накопленное кнопками и не завершает его', async () => {
    await press('s1');
    expect((await decide('decline')).status).toBe('declined');
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toMatchObject({
      supplierIds: ['s1'],
      done: false,
    });
  });

  test('unclear (неясно или не про вопрос): ничего не пишется, вопрос раз', async () => {
    const first = await decide('unclear');
    expect(first).toMatchObject({ status: 'unclear', repeatQuestion: true });
    expect(first.question).toContain('Кому готовить запросы?');
    await noRecord();
    const second = await decide('unclear');
    expect(second).toEqual({ status: 'unclear', repeatQuestion: false });
    await noRecord();
    // После неясных ответов ясный выбор записывается как обычно.
    expect((await decide('picked', ['1', '2'])).status).toBe('recorded');
  });

  test('«ок»/«да» без названных поставщиков: picked без picks отклонён', async () => {
    const error = await decide('picked').catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('invalid_input');
    await noRecord();
  });

  test('повтор того же picked идемпотентен', async () => {
    expect((await decide('picked', ['1', '2'])).status).toBe('recorded');
    const before = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect((await decide('picked', ['2', '1'])).status).toBe('already_recorded');
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toEqual(before);
  });

  test('decline/unclear без открытого вопроса: not_asked', async () => {
    await closeChoiceAsk(deps.state, deps.clock, THREAD, REQUEST_ID);
    expect((await decide('decline')).status).toBe('not_asked');
    expect((await decide('unclear')).status).toBe('not_asked');
  });

  test('decline и unclear вне хода сотрудника: access_denied', async () => {
    const scheduled = { ...CTX, initiator: { kind: 'scheduler' as const } };
    for (const decision of ['decline', 'unclear'] as const) {
      const denied = await decide(decision, undefined, scheduled).catch((e: unknown) => e);
      expect(isDomainError(denied) && denied.code).toBe('access_denied');
    }
    await noRecord();
  });

  test('кнопки работают как раньше: нажатия и «Готово» после неясного ответа', async () => {
    await decide('unclear');
    expect(await press('s1')).toEqual({ kind: 'recorded', supplierIds: ['s1'] });
    expect(await done()).toEqual({ kind: 'finalized', supplierIds: ['s1'] });
    expect(await codes({ requestId: REQUEST_ID, supplierIds: ['s1'] })).toEqual([]);
  });

  test('после unclear предшественник идемпотентности меняется', async () => {
    const input = { requestId: REQUEST_ID, decision: 'unclear' as const };
    const predecessor = () => recordManagerChoice.idempotencyPredecessor?.(input, deps, THREAD);
    const before = await predecessor();
    await decide('unclear');
    expect(await predecessor()).not.toEqual(before);
    // Ключ операции зависит от решения: unclear и picked с теми же picks не смешиваются.
    const key = (decision: 'picked' | 'unclear') =>
      recordManagerChoice.idempotencyKey?.({ requestId: REQUEST_ID, decision, picks: ['1'] });
    expect(key('unclear')).not.toEqual(key('picked'));
  });

  test('схема: решение обязательно, плоская z.object без union', () => {
    const parsed = recordManagerChoice.inputSchema.safeParse({ requestId: REQUEST_ID });
    expect(parsed.success).toBe(false);
    expect(
      recordManagerChoice.inputSchema.safeParse({ requestId: REQUEST_ID, decision: 'maybe' })
        .success,
    ).toBe(false);
  });
});
