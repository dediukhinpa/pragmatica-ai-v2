import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryAuditRepository, MemoryWorkflowStateStore } from '@business-ai/adapters';
import { ChatEventNotAcceptedError, writeState, type ChatEvent } from '@business-ai/core';
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
import { wrapChatChannel } from '../../src/chat-intake';
import {
  CHAT_CHOICE_NOTHING_TEXT,
  PROJECT_BUTTONS,
  quoteReplaceAgentInput,
} from '../../src/chat-hooks';
import {
  LAUNCH_DEDUPE_WINDOW_MS,
  clearChatLauncher,
  launchAgentTurn,
  setChatLauncher,
} from '../../src/chat-launch';
import {
  clearPragmatikaRuntime,
  setPragmatikaRuntime,
  type PragmatikaRuntime,
} from '../../src/runtime';
import {
  RecordingChannel,
  TEST_USER_ID,
  buildPump,
  messageEvent,
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
  clearChatLauncher();
});

describe('launchAgentTurn: запуск хода агента из проекта', () => {
  const request = {
    threadId: THREAD,
    userId: TEST_USER_ID,
    botId: BOT,
    text: 'Нажата кнопка: pickdone:abc',
    dedupeKey: 'pickdone:abc',
  } as const;

  test('нет моста к насосу: ход не запускается, вызывающий отвечает сам', async () => {
    expect(await launchAgentTurn(request, 0)).toBe('unavailable');
  });

  test('событие уходит насосу сообщением сотрудника в тот же тред', async () => {
    const events: ChatEvent[] = [];
    setChatLauncher(async (event) => {
      events.push(event);
    });
    expect(await launchAgentTurn(request, 0)).toBe('launched');
    expect(events).toEqual([
      {
        kind: 'message',
        threadId: THREAD,
        userId: TEST_USER_ID,
        botId: BOT,
        text: request.text,
      },
    ]);
  });

  test('двойное нажатие в окне не запускает ход дважды; потом и другой ключ - можно', async () => {
    const events: ChatEvent[] = [];
    setChatLauncher(async (event) => {
      events.push(event);
    });
    expect(await launchAgentTurn(request, 0)).toBe('launched');
    expect(await launchAgentTurn(request, LAUNCH_DEDUPE_WINDOW_MS - 1)).toBe('duplicate');
    expect(await launchAgentTurn({ ...request, dedupeKey: 'other' }, 1)).toBe('launched');
    expect(await launchAgentTurn(request, LAUNCH_DEDUPE_WINDOW_MS + 1)).toBe('launched');
    expect(events).toHaveLength(3);
  });

  test('насос не принял событие: код причины, повтор потом разрешён', async () => {
    let busy = true;
    setChatLauncher(async () => {
      if (busy) throw new ChatEventNotAcceptedError('busy');
    });
    expect(await launchAgentTurn(request, 0)).toBe('not_accepted');
    busy = false;
    expect(await launchAgentTurn(request, 1)).toBe('launched');
  });
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

/** Насос заказов на канале с мостом: нажатие кнопки идёт в обработчики проекта. */
function ordersWorld(options: { bridge: boolean }) {
  const channel = new RecordingChannel();
  if (options.bridge) {
    wrapChatChannel(channel, {
      state,
      agents: { chatAgentId: ORDER_CALC_AGENT_ID, chatBots: { [BOT]: ORDER_CALC_AGENT_ID } },
      log: () => undefined,
    });
  }
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
    const world = ordersWorld({ bridge: true });
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([
      { threadId: THREAD, agentId: ORDER_CALC_AGENT_ID, input: `Нажата кнопка: ${buttonId}` },
    ]);
    // Просить сотрудника написать «продолжай» больше не нужно: в чат уходит только ответ агента.
    expect(world.channel.texts.map((item) => item.text)).toEqual(['готово']);
  });

  test('двойное нажатие запускает ход один раз', async () => {
    const buttonId = await openChoice(true);
    const world = ordersWorld({ bridge: true });
    await world.press(buttonId);
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toHaveLength(1);
  });

  test('ничего не выбрано: отказ текстом, агент не запускается', async () => {
    const buttonId = await openChoice(false);
    const world = ordersWorld({ bridge: true });
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([]);
    expect(world.channel.texts.map((item) => item.text)).toEqual([CHAT_CHOICE_NOTHING_TEXT]);
  });

  test('моста нет (канал без установки): прежний текст «напишите агенту»', async () => {
    const buttonId = await openChoice(true);
    const world = ordersWorld({ bridge: false });
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([]);
    expect(world.channel.texts).toHaveLength(1);
    expect(world.channel.texts[0]?.text).toContain('Напишите агенту');
  });

  test('моста нет: код результата для аудита называет причину', async () => {
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
    expect((await audit.list(TEST_USER_ID)).at(-1)?.result).toBe(
      'choice_finalized_unavailable',
    );
  });

  test('сообщение-запуск не принимается за текст сотрудника документов', async () => {
    // Текст запроса агенту системный: перехват реквизитов его не записывает.
    const channel = new RecordingChannel();
    wrapChatChannel(channel, {
      state,
      agents: { chatAgentId: 'documents' },
      log: () => undefined,
    });
    const seen: ChatEvent[] = [];
    channel.onEvent(async (event) => {
      seen.push(event);
    });
    const outcome = await launchAgentTurn(
      {
        threadId: 'documents/u-1',
        userId: 'u-1',
        botId: undefined,
        text: 'Нажата кнопка: x',
        dedupeKey: 'k',
      },
      0,
    );
    expect(outcome).toBe('launched');
    expect(seen).toHaveLength(1);
    expect(await state.get('documents:employee-text', 'documents/u-1')).toBeNull();
    // Живое сообщение сотрудника, напротив, записывается.
    const live = { threadId: 'documents/u-1', userId: 'u-1' };
    await channel.emit(messageEvent('ИНН 7707083893', live));
    expect(await state.get('documents:employee-text', 'documents/u-1')).not.toBeNull();
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
    const world = ordersWorld({ bridge: true });
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
    const world = ordersWorld({ bridge: true });
    await world.press(quoteReplaceButtonId('unknowntoken'));
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([]);
    expect(world.channel.texts).toHaveLength(1);
  });

  test('моста нет: прежний текст «напишите агенту»', async () => {
    const buttonId = await openReplaceOffer();
    const world = ordersWorld({ bridge: false });
    await world.press(buttonId);
    await world.pump.whenIdle();
    expect(world.inputs).toEqual([]);
    expect(world.channel.texts[0]?.text).toContain('Напишите агенту');
  });
});

describe('вспомогательные id кнопок', () => {
  test('кнопки выбора не путаются с «Готово»', () => {
    expect(pickButtonId(REQUEST_ID, VERSION, 's1')).not.toBe(pickDoneButtonId(REQUEST_ID, VERSION));
  });
});
