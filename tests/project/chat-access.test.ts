import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryAuditRepository, MemoryWorkflowStateStore } from '@business-ai/adapters';
import type { AccessPolicy } from '@business-ai/core';
import { CHAT_ACCESS_CHECK_UNAVAILABLE_TEXT } from '@business-ai/core/compose';
import { ACTION_CONFIRM_SUPPLIER_CARD, ACTION_ROUTE_MAIL } from '../../src/access-actions';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import { supplierCardButtonId } from '../../src/agents/suppliers/card-request';
import {
  CHAT_ROUTE_DENIED_TEXT,
  CHAT_SUPPLIER_CARD_DENIED_TEXT,
  PROJECT_BUTTONS,
} from '../../src/chat-hooks';
import {
  clearPragmatikaRuntime,
  setPragmatikaRuntime,
  type PragmatikaRuntime,
} from '../../src/runtime';
import { RecordingChannel, TEST_USER_ID, buildPump, recordingRuntime } from './chat-support';

const THREAD = `orders/${TEST_USER_ID}`;
const BOT = 'orders';

beforeEach(() => {
  setPragmatikaRuntime({
    clock: new FixedClock(),
    state: new MemoryWorkflowStateStore(),
  } as unknown as PragmatikaRuntime);
});

afterEach(() => {
  clearPragmatikaRuntime();
});

/** Политика: обычный доступ к боту проходит, право на разнесение писем - сбой каталога. */
const failingRouteRight: AccessPolicy = {
  isAllowed: async () => true,
  decide: async (request) => {
    if (request.action === ACTION_ROUTE_MAIL) throw new Error('каталог недоступен');
    return { allowed: true, reason: 'allowed', message: '' };
  },
};

/** Код причины, с которым политика отказывает руководителю карточек (не сбой каталога). */
const NOT_HEAD_REASON = 'not_department_head';

/** Политика: право на подтверждение карточек - сбой каталога либо обычный отказ. */
function cardRight(outcome: 'directory_failure' | 'not_head'): AccessPolicy {
  return {
    isAllowed: async () => true,
    decide: async (request) => {
      if (request.action !== ACTION_CONFIRM_SUPPLIER_CARD) {
        return { allowed: true, reason: 'allowed', message: '' };
      }
      if (outcome === 'directory_failure') throw new Error('каталог недоступен');
      return { allowed: false, reason: NOT_HEAD_REASON, message: '' };
    },
  };
}

/** Состояние приложения с карточками: запрос по кнопке известен и принадлежит агенту заказов. */
function cardsRuntime(): PragmatikaRuntime {
  return {
    clock: new FixedClock(),
    state: new MemoryWorkflowStateStore(),
    supplierCards: {
      buttons: { lookup: async () => ({ kind: 'card', agentId: ORDER_CALC_AGENT_ID }) },
    },
  } as unknown as PragmatikaRuntime;
}

describe('сбой проверки права в кнопке закрывает доступ (R4-AGT-14)', () => {
  test('сбой политики при праве на разнесение: отказ прежним текстом', async () => {
    const audit = new MemoryAuditRepository();
    const channel = new RecordingChannel();
    const { runtime, inputs } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      audit,
      access: failingRouteRight,
      agent: ORDER_CALC_AGENT_ID,
      bots: { [BOT]: ORDER_CALC_AGENT_ID },
      buttons: PROJECT_BUTTONS,
    });
    await channel.emit({
      kind: 'button',
      threadId: THREAD,
      userId: TEST_USER_ID,
      botId: BOT,
      buttonId: 'rfq:mailtoken:requesttoken',
    });
    await pump.whenIdle();
    expect(channel.texts.map((item) => item.text)).toEqual([CHAT_ROUTE_DENIED_TEXT]);
    expect(inputs).toEqual([]);
  });

  test('аудит кнопки: код denied:directory_unavailable при сбое каталога', async () => {
    const audit = new MemoryAuditRepository();
    const channel = new RecordingChannel();
    const { runtime } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      audit,
      access: failingRouteRight,
      agent: ORDER_CALC_AGENT_ID,
      bots: { [BOT]: ORDER_CALC_AGENT_ID },
      buttons: PROJECT_BUTTONS,
    });
    await channel.emit({
      kind: 'button',
      threadId: THREAD,
      userId: TEST_USER_ID,
      botId: BOT,
      buttonId: 'rfq:mailtoken:requesttoken',
    });
    await pump.whenIdle();
    // Как в прежнем насосе: причина отказа доходит до аудита через код результата обработчика.
    expect((await audit.list(TEST_USER_ID)).at(-1)?.result).toBe('denied:directory_unavailable');
  });

  /** Нажатие кнопки карточки под политикой: тексты ответа и код аудита. */
  async function pressCard(outcome: 'directory_failure' | 'not_head') {
    setPragmatikaRuntime(cardsRuntime());
    const audit = new MemoryAuditRepository();
    const channel = new RecordingChannel();
    const { runtime, inputs } = recordingRuntime();
    const pump = buildPump({
      channel,
      runtime,
      audit,
      access: cardRight(outcome),
      agent: ORDER_CALC_AGENT_ID,
      bots: { [BOT]: ORDER_CALC_AGENT_ID },
      buttons: PROJECT_BUTTONS,
    });
    await channel.emit({
      kind: 'button',
      threadId: THREAD,
      userId: TEST_USER_ID,
      botId: BOT,
      buttonId: supplierCardButtonId('save', 'tok-1'),
    });
    await pump.whenIdle();
    return {
      texts: channel.texts.map((item) => item.text),
      result: (await audit.list(TEST_USER_ID)).at(-1)?.result,
      inputs,
    };
  }

  test('карточка поставщика: сбой каталога - «не удалось проверить доступ»', async () => {
    const pressed = await pressCard('directory_failure');
    expect(pressed.texts).toEqual([CHAT_ACCESS_CHECK_UNAVAILABLE_TEXT]);
    expect(pressed.result).toBe('denied:directory_unavailable');
    expect(pressed.inputs).toEqual([]);
  });

  test('карточка поставщика: не руководитель - прежний отказ, причина в аудите', async () => {
    const pressed = await pressCard('not_head');
    expect(pressed.texts).toEqual([CHAT_SUPPLIER_CARD_DENIED_TEXT]);
    expect(pressed.result).toBe(`denied:${NOT_HEAD_REASON}`);
  });
});
