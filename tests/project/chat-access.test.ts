import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryAuditRepository, MemoryWorkflowStateStore } from '@business-ai/adapters';
import type { AccessPolicy } from '@business-ai/core';
import { ACTION_ROUTE_MAIL } from '../../src/access-actions';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import { CHAT_ROUTE_DENIED_TEXT, PROJECT_BUTTONS } from '../../src/chat-hooks';
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

/** Тело пока не написано: без метода платформы проверить нечем (при запуске с --todo падает). */
async function pendingG12(): Promise<void> {
  throw new Error('нужен ChatHookContext.check (запись G-12 в platform-gaps.md)');
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
    // Прежний насос писал в аудит `denied:directory_unavailable`; хук кнопки получает от
    // платформы только да/нет (`ChatHookContext.allowed`), причина теряется: пробел G-12.
    expect((await audit.list(TEST_USER_ID)).at(-1)?.result).toBe('denied');
  });

  // Нужен `ChatHookContext.check(action, agentId?) -> { allowed, reason }` (запись G-12).
  test.todo('аудит кнопки: код denied:directory_unavailable при сбое каталога', pendingG12);
  test.todo(
    'кнопка карточки поставщика: сбой каталога - «не удалось проверить доступ», не отказ',
    pendingG12,
  );
});
