import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryAuditRepository, MemoryWorkflowStateStore } from '@business-ai/adapters';
import { writeState } from '@business-ai/core';
import type { ChatHookContext } from '@business-ai/core/compose';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import {
  pickDoneButtonId,
  pickButtonId,
  recordChoiceButton,
  saveChoiceAsk,
  choiceToken,
} from '../../src/agents/order-calc/choice-confirmation';
import { QUOTE_REPLACE_OFFER_NAMESPACE } from '../../src/agents/order-calc/deps';
import {
  quoteReplaceButtonId,
  quoteReplaceToken,
} from '../../src/agents/order-calc/quote-replacement';
import type { ShortlistProposal } from '../../src/kit/domain/shortlist';
import {
  CHAT_CHOICE_NOTHING_TEXT,
  PROJECT_BUTTONS,
  quoteReplaceAgentInput,
} from '../../src/chat-hooks';
import {
  clearPragmatikaRuntime,
  setPragmatikaRuntime,
  type PragmatikaRuntime,
} from '../../src/runtime';
import {
  RecordingChannel,
  TEST_USER_ID,
  buildPump,
  recordingRuntime,
} from './chat-support';

const THREAD = `orders/${TEST_USER_ID}`;
const BOT = 'orders';
const REQUEST_ID = 'req-1';
const VERSION = 'v1';

let clock: FixedClock;
let state: MemoryWorkflowStateStore;

beforeEach(() => {
  clock = new FixedClock();
  state = new MemoryWorkflowStateStore();
  // Обработчикам кнопок нужны только часы и состояние: остальное состояние приложения не читается.
  setPragmatikaRuntime({ clock, state } as unknown as PragmatikaRuntime);
});

afterEach(() => {
  clearPragmatikaRuntime();
});

/** Вопрос выбора открыт в треде заказов; менеджер отметил поставщика. */
async function openChoice(pickSupplier: boolean): Promise<string> {
  const proposal: ShortlistProposal = {
    requestId: REQUEST_ID,
    version: VERSION,
    createdAt: clock.now().toISOString(),
    managerThreadId: THREAD,
    entries: [{ supplierId: 's1', name: 'Поставщик 1' }] as unknown as ShortlistProposal['entries'],
    truncated: 0,
    sources: [],
  };
  await saveChoiceAsk(state, clock, THREAD, proposal);
  if (pickSupplier) {
    await recordChoiceButton(state, clock, {
      supplierId: `${choiceToken(REQUEST_ID, VERSION)}:s1`,
      userId: TEST_USER_ID,
      threadId: THREAD,
    });
  }
  return pickDoneButtonId(REQUEST_ID, VERSION);
}

/** Насос заказов: нажатие кнопки идёт в обработчики проекта. */
function ordersWorld() {
  const channel = new RecordingChannel();
  const { runtime, inputs } = recordingRuntime();
  const pump = buildPump({
    channel,
    runtime,
    state,
    agent: ORDER_CALC_AGENT_ID,
    bots: { [BOT]: ORDER_CALC_AGENT_ID },
    buttons: PROJECT_BUTTONS,
  });
  const press = (buttonId: string) =>
    channel.emit({ kind: 'button', threadId: THREAD, userId: TEST_USER_ID, botId: BOT, buttonId });
  return { channel, pump, inputs, press };
}

describe('«Готово» запускает агента после кода (как в прежнем насосе)', () => {
  test('выбор записан кодом, затем ход в том же треде с прежним текстом запроса', async () => {
    const buttonId = await openChoice(true);
    const world = ordersWorld();
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([
      { threadId: THREAD, agentId: ORDER_CALC_AGENT_ID, input: `Нажата кнопка: ${buttonId}` },
    ]);
    // Просить сотрудника написать «продолжай» больше не нужно: в чат уходит только ответ агента.
    expect(world.channel.texts.map((item) => item.text)).toEqual(['готово']);
  });

  test('повторное нажатие после записи выбора: новый ход (окна 30 с больше нет)', async () => {
    // Платформа защищает только повтор `runAgent` внутри одного нажатия; два разных нажатия
    // «Готово» - два хода (агент идемпотентен: выбор уже завершён, запросы не задваиваются).
    const buttonId = await openChoice(true);
    const world = ordersWorld();
    await world.press(buttonId);
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs.map((item) => item.input)).toEqual([
      `Нажата кнопка: ${buttonId}`,
      `Нажата кнопка: ${buttonId}`,
    ]);
  });

  test('ничего не выбрано: отказ текстом, агент не запускается', async () => {
    const buttonId = await openChoice(false);
    const world = ordersWorld();
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([]);
    expect(world.channel.texts.map((item) => item.text)).toEqual([CHAT_CHOICE_NOTHING_TEXT]);
  });

  test('код результата для аудита - итог выбора, без хвоста «нет моста»', async () => {
    const buttonId = await openChoice(true);
    const audit = new MemoryAuditRepository();
    const channel = new RecordingChannel();
    const { runtime } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      state,
      audit,
      agent: ORDER_CALC_AGENT_ID,
      bots: { [BOT]: ORDER_CALC_AGENT_ID },
      buttons: PROJECT_BUTTONS,
    });
    const event = { threadId: THREAD, userId: TEST_USER_ID, botId: BOT, buttonId } as const;
    await channel.emit({ kind: 'button', ...event });
    await pump.whenIdle();
    expect((await audit.list(TEST_USER_ID)).at(-1)?.result).toBe('choice_finalized');
  });
});

/** Контекст кнопки на заглушках: считает запуски агента и сказанные тексты. */
function recordingContext() {
  const launched: string[] = [];
  const said: string[] = [];
  const context: ChatHookContext = {
    threadId: THREAD,
    userId: TEST_USER_ID,
    agentId: ORDER_CALC_AGENT_ID,
    botId: BOT,
    say: async (text) => {
      said.push(text);
    },
    sendFile: async () => undefined,
    allowed: async () => true,
    check: async () => ({ allowed: true }),
    runAgent: async (input) => {
      launched.push(input);
    },
    resumeScheduledWaits: async () => undefined,
    log: () => undefined,
  };
  return { context, launched, said };
}

describe('обработчики зовут context.runAgent ровно один раз на нажатие', () => {
  test('«Готово»: один вызов с прежним текстом, сотруднику ничего не говорят', async () => {
    const buttonId = await openChoice(true);
    const { context, launched, said } = recordingContext();
    const handler = PROJECT_BUTTONS.find((item) => item.prefix === 'pickdone');
    expect(await handler?.handle(buttonId, context)).toBe('choice_finalized');
    expect(launched).toEqual([`Нажата кнопка: ${buttonId}`]);
    expect(said).toEqual([]);
  });

  test('«Готово» без выбора: отказ текстом, runAgent не вызван', async () => {
    const buttonId = await openChoice(false);
    const { context, launched, said } = recordingContext();
    const handler = PROJECT_BUTTONS.find((item) => item.prefix === 'pickdone');
    await handler?.handle(buttonId, context);
    expect(launched).toEqual([]);
    expect(said).toEqual([CHAT_CHOICE_NOTHING_TEXT]);
  });

  test('«заменить КП»: один вызов с текстом из quoteReplaceAgentInput', async () => {
    const buttonId = await openReplaceOffer();
    const { context, launched, said } = recordingContext();
    const handler = PROJECT_BUTTONS.find((item) => item.prefix === 'qrepl');
    expect(await handler?.handle(buttonId, context)).toBe('quote_replace_approved');
    expect(launched).toEqual([
      quoteReplaceAgentInput({
        kind: 'approved',
        requestId: REQUEST_ID,
        supplierId: 's1',
        replyId: 'reply-7',
      }),
    ]);
    expect(said).toEqual([]);
  });
});

/** Предложение заменить КП открыто в треде заказов. */
async function openReplaceOffer(): Promise<string> {
  const token = quoteReplaceToken(REQUEST_ID, 's1', 'reply-7');
  await writeState(state, QUOTE_REPLACE_OFFER_NAMESPACE, token, {
    requestId: REQUEST_ID,
    supplierId: 's1',
    replyId: 'reply-7',
    threadId: THREAD,
    offeredAt: clock.now().toISOString(),
  });
  return quoteReplaceButtonId(token);
}

describe('«заменить КП» запускает агента с подготовленным запросом', () => {
  test('решение записано кодом, затем ход с прежним текстом запроса', async () => {
    const buttonId = await openReplaceOffer();
    const world = ordersWorld();
    await world.press(buttonId);
    await world.pump.whenIdle();
    const expected = quoteReplaceAgentInput({
      kind: 'approved',
      requestId: REQUEST_ID,
      supplierId: 's1',
      replyId: 'reply-7',
    });
    expect(world.inputs).toEqual([
      { threadId: THREAD, agentId: ORDER_CALC_AGENT_ID, input: expected },
    ]);
    expect(expected).toBe(
      'Менеджер разрешил заменить КП поставщика s1 по заявке req-1 ответом reply-7. ' +
        'Вызови readSupplierReplies, затем recordQuote с sourceRef=reply-7 (только данные ' +
        'из этого ответа), затем compareQuotes и sendQuoteSummary.',
    );
  });

  test('предложение неизвестно: отказ текстом, агент не запускается', async () => {
    const world = ordersWorld();
    await world.press(quoteReplaceButtonId('unknowntoken'));
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([]);
    expect(world.channel.texts).toHaveLength(1);
  });
});

describe('вспомогательные id кнопок', () => {
  test('кнопки выбора не путаются с «Готово»', () => {
    expect(pickButtonId(REQUEST_ID, VERSION, 's1')).not.toBe(pickDoneButtonId(REQUEST_ID, VERSION));
  });
});
