import {
  FixedClock,
  MemoryAuditRepository,
  MemoryChatChannel,
  MemoryPairNoteStore,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  createSupplierCardService,
  type SupplierCardPress,
  type SupplierCardService,
} from '../../src/agents/suppliers/card-approval';
import { createToolContext, type ToolContext } from '@business-ai/core';
import {
  pendingSupplierRequest,
  supplierCardButtonId,
  type SupplierCardAction,
} from '../../src/agents/suppliers/card-request';
import { rememberForMe } from '../../src/agents/suppliers/pair-notes';
import { type SupplierCardsDeps, type SupplierCardsHost } from '../../src/agents/suppliers/deps';
import type { AccessDecision } from '@business-ai/core';
import type { AccessPolicy, DocumentParser, ParsedDocument } from '@business-ai/core';

/** Сотрудники и их треды связки `<бот>/<сотрудник>`. */
export const USER_A = 'u-100';
export const USER_B = 'u-200';
export const BOT_PRICES = 'prices';
export const BOT_ORDERS = 'orders';
export const THREAD_A = `${BOT_PRICES}/${USER_A}`;
export const THREAD_B = `${BOT_PRICES}/${USER_B}`;
export const THREAD_A_ORDERS = `${BOT_ORDERS}/${USER_A}`;

/** Весовые коэффициенты ИНН юрлица (10 цифр). */
const INN_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_MODULUS = 11;
const DECIMAL = 10;

/** ИНН юрлица с верной контрольной суммой из девяти цифр основы. */
export function validInn(base: string): string {
  const sum = INN_WEIGHTS.reduce((acc, weight, index) => acc + weight * Number(base[index]), 0);
  return `${base}${(sum % INN_MODULUS) % DECIMAL}`;
}

export const INN_ALPHA = validInn('770708389');
export const INN_BETA = validInn('500100732');
export const INN_GAMMA = validInn('780412345');
/** Десять цифр с неверной контрольной суммой. */
export const INN_BROKEN = `${INN_ALPHA.slice(0, 9)}${(Number(INN_ALPHA[9]) + 1) % DECIMAL}`;

/** Разобранный документ с заданными таблицами (заглушка разбора xlsx). */
export class TablesParser implements DocumentParser {
  tables: string[][][] = [];
  async parse(): Promise<ParsedDocument> {
    return {
      text: '',
      tables: this.tables,
      needsOcr: false,
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  }
}

export interface SupplierWorld {
  deps: SupplierCardsDeps;
  host: SupplierCardsHost;
  suppliers: MemorySupplierRepository;
  chat: MemoryChatChannel;
  clock: FixedClock;
  state: MemoryWorkflowStateStore;
  pairNotes: MemoryPairNoteStore;
  audit: MemoryAuditRepository;
  parser: TablesParser;
  service: SupplierCardService;
}

export function buildSupplierWorld(): SupplierWorld {
  const clock = new FixedClock(new Date('2026-05-04T09:00:00.000Z'));
  const suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  const chat = new MemoryChatChannel();
  const state = new MemoryWorkflowStateStore(() => clock.now().getTime());
  const pairNotes = new MemoryPairNoteStore();
  const audit = new MemoryAuditRepository();
  const parser = new TablesParser();
  const deps: SupplierCardsDeps = { suppliers, chat, clock, state, pairNotes, audit, parser };
  STATE_BY_CHAT.set(chat, state);
  return {
    deps,
    host: { supplierCards: deps },
    suppliers,
    chat,
    clock,
    state,
    pairNotes,
    audit,
    parser,
    service: createSupplierCardService(deps),
  };
}

/** Контекст хода сотрудника в треде связки. */
export function turnContext(userId: string, threadId: string, agentId = 'prices'): ToolContext {
  return createToolContext({
    threadId,
    agentId,
    operationId: `op-${userId}`,
    initiator: { kind: 'user', userId },
  });
}

/** Плановый запуск: не сотрудник. */
export const SCHEDULER_CONTEXT: ToolContext = createToolContext({
  threadId: 'prices-weekly',
  agentId: 'prices',
  operationId: 'op-scheduler',
  initiator: { kind: 'scheduler' },
});

/**
 * Последний показ треда, ждущий ответа: токен и предложенные решения - из указателя показа,
 * текст - последнее сообщение треда. `ids` - id прежних кнопок тех же решений (старые нажатия
 * обработчик чата по-прежнему принимает).
 */
export async function lastShown(
  chat: MemoryChatChannel,
  threadId: string,
  state?: MemoryWorkflowStateStore,
): Promise<{ token: string; text: string; actions: SupplierCardAction[]; ids: string[] }> {
  const store = state ?? stateOf(chat);
  const pending = await pendingSupplierRequest(store, threadId);
  const found = [...chat.outbox]
    .reverse()
    .find(
      (item) => item.threadId === threadId && item.message?.text.includes('Например:') === true,
    );
  if (found?.message === undefined || pending === null) throw new Error('карточка не показана');
  return {
    token: pending.token,
    text: found.message.text,
    actions: pending.actions,
    ids: pending.actions.map((action) => supplierCardButtonId(action, pending.token)),
  };
}

/** Хранилище состояния мира по его каналу (lastShown вызывают с каналом). */
const STATE_BY_CHAT = new WeakMap<MemoryChatChannel, MemoryWorkflowStateStore>();
function stateOf(chat: MemoryChatChannel): MemoryWorkflowStateStore {
  const state = STATE_BY_CHAT.get(chat);
  if (state === undefined) throw new Error('мир поставщиков не найден для канала');
  return state;
}

/** Нажатие кнопки действия. */
export function pressOf(
  token: string,
  userId: string,
  threadId: string,
  action: SupplierCardPress['action'],
): SupplierCardPress {
  return { token, userId, threadId, action };
}

/**
 * Личная заметка в два шага, как в чате: инструмент готовит вопрос «Запомнить: ...?», затем
 * сотрудник нажимает «Да» (событие канала). Возвращает итог нажатия.
 */
export async function rememberAndConfirm(
  world: SupplierWorld,
  context: ToolContext,
  input: { text: string; kind: 'preference' | 'note' },
  presser: { userId: string; threadId: string } = {
    userId: context.initiator.kind === 'user' ? context.initiator.userId : '',
    threadId: context.threadId,
  },
): Promise<Awaited<ReturnType<SupplierCardService['press']>>> {
  await rememberForMe.execute(input, world.host, context);
  const shown = await lastShown(world.chat, context.threadId);
  return world.service.press(pressOf(shown.token, presser.userId, presser.threadId, 'save'));
}

/** Режим проверки права: допуск, отказ руководителя или недоступный справочник руководителей. */
export type RightMode = 'allow' | 'deny' | 'down';

/**
 * Политика с переключаемым исходом (этап 234): сбой справочника (`down`) отличается от отказа
 * (`deny`), а после восстановления (`allow`) тот же вызов проходит.
 */
export class SwitchableAccess implements AccessPolicy {
  mode: RightMode = 'allow';

  async isAllowed(): Promise<boolean> {
    return this.mode === 'allow';
  }

  async decide(): Promise<AccessDecision> {
    if (this.mode === 'allow') return { allowed: true, reason: 'allowed', message: '' };
    return {
      allowed: false,
      reason: this.mode === 'down' ? 'directory_unavailable' : 'not_department_head',
      message: '',
    };
  }
}
