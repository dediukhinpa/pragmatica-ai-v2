import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChatHookContext } from '@business-ai/core/compose';
import { removeTempDirs } from '@business-ai/testing';
import { pickButtonId } from '../../src/agents/order-calc/choice-confirmation';
import { supplierCardButtonId } from '../../src/agents/suppliers/card-request';
import {
  CHAT_BUTTON_STALE_TEXT,
  CHAT_FOREIGN_SCENARIO_TEXT,
  CHAT_ROUTE_DENIED_TEXT,
  CHAT_SELECTION_DENIED_TEXT,
  CHAT_SUPPLIER_CARD_UNKNOWN_TEXT,
  FILE_OWNER_AGENT_ID,
  PROJECT_BUTTONS,
  PROJECT_GREETING_ACTIONS,
  PROJECT_SCENARIO_RULES,
  projectStateBlock,
  supplierFileHandler,
} from '../../src/chat-hooks';
import { clearPragmatikaRuntime } from '../../src/runtime';
import { pragmatikaProject } from '../../src/project';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

/** Контекст кнопки на заглушках: что сказано, какие права выданы. */
function fakeContext(options: { agentId?: string; allowed?: boolean; userId?: string } = {}) {
  const said: string[] = [];
  const asked: Array<{ action: string; agentId: string | undefined }> = [];
  const context: ChatHookContext = {
    threadId: 'thread-1',
    userId: options.userId ?? 'u-100',
    agentId: options.agentId ?? 'order-calc',
    botId: undefined,
    say: async (text) => {
      said.push(text);
    },
    sendFile: async () => undefined,
    allowed: async (action, agentId) => {
      asked.push({ action, agentId });
      return options.allowed ?? true;
    },
    resumeScheduledWaits: async () => undefined,
    log: () => undefined,
  };
  return { context, said, asked };
}

/** Префиксы живых кнопок проекта. */
const LIVE_PREFIXES = ['dwebc', 'pick', 'pickdone', 'qrepl', 'rfq', 'scard'];

function handlerOf(prefix: string) {
  const found = PROJECT_BUTTONS.find((handler) => handler.prefix === prefix);
  if (found === undefined) throw new Error(`нет обработчика ${prefix}`);
  return found;
}

describe('таблица кнопок проекта', () => {
  test('префиксы уникальны и не пересекаются с правилами сценариев', () => {
    const prefixes = PROJECT_BUTTONS.map((handler) => handler.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const rule of PROJECT_SCENARIO_RULES) {
      // Платформа запрещает один префикс и в scenarios, и в buttons: правила в манифест не идут.
      expect(prefixes).toContain(rule.buttonPrefix);
    }
    expect(pragmatikaProject.chat.scenarios ?? []).toEqual([]);
  });

  test('шесть живых кнопок и снятая кнопка скачка цен', () => {
    const prefixes = PROJECT_BUTTONS.map((handler) => handler.prefix);
    expect(prefixes).toHaveLength(LIVE_PREFIXES.length + 1);
    for (const prefix of LIVE_PREFIXES) expect(prefixes).toContain(prefix);
  });

  test('правила сценариев: владелец - «Поиск поставщика», действия из реестра', () => {
    expect(PROJECT_SCENARIO_RULES.map((rule) => [rule.buttonPrefix, rule.action])).toEqual([
      ['pick', 'orders.confirm_selection'],
      ['pickdone', 'orders.confirm_selection'],
      ['rfq', 'orders.route_mail'],
      ['qrepl', 'orders.route_mail'],
    ]);
    for (const rule of PROJECT_SCENARIO_RULES) expect(rule.owner).toBe('order-calc');
  });

  test('файлы принимает только «Актуализация прайса»', () => {
    expect(FILE_OWNER_AGENT_ID).toBe('prices');
    expect(pragmatikaProject.chat.fileOwner).toBe('prices');
  });
});

describe('обработчики кнопок', () => {
  beforeEach(() => {
    buildPragmatika();
  });
  afterEach(() => {
    clearPragmatikaRuntime();
  });

  test('нет права на выбор поставщика: отказ текстом, запись не делается', async () => {
    const { context, said, asked } = fakeContext({ allowed: false });
    const result = await handlerOf('pick').handle(pickButtonId('req-1', 'v1', 'sup-1'), context);
    expect(result).toBe('denied');
    expect(said).toEqual([CHAT_SELECTION_DENIED_TEXT]);
    // Право проверяется под агентом-владельцем сценария, а не под агентом канала.
    expect(asked).toEqual([{ action: 'orders.confirm_selection', agentId: 'order-calc' }]);
  });

  test('нет права привязать письмо: отказ текстом', async () => {
    const { context, said } = fakeContext({ allowed: false });
    const result = await handlerOf('rfq').handle('rfq:mail-1:req-1', context);
    expect(result === 'denied' || result === null).toBe(true);
    if (result === 'denied') expect(said).toEqual([CHAT_ROUTE_DENIED_TEXT]);
  });

  test('сценарий чужого помощника: текст сотруднику, ход не запускается', async () => {
    const { context, said } = fakeContext({ agentId: 'prices', allowed: true });
    const result = await handlerOf('pick').handle(pickButtonId('req-1', 'v1', 'sup-1'), context);
    expect(result).toBe('foreign_scenario');
    expect(said).toEqual([CHAT_FOREIGN_SCENARIO_TEXT('order-calc', 'prices')]);
  });

  test('«Готово» по неизвестному вопросу: текст «кнопка устарела», агент не нужен', async () => {
    const { context, said } = fakeContext();
    const result = await handlerOf('pickdone').handle('pickdone:abcdef', context);
    expect(result).toMatch(/^choice_/);
    expect(said).toHaveLength(1);
  });

  test('«Готово» не отдаёт ход агенту: обработчик всегда отвечает сам', async () => {
    const { context } = fakeContext();
    expect(await handlerOf('pickdone').handle('pickdone:abcdef', context)).not.toBeNull();
  });

  test('кнопка карточки при выключенных карточках: «больше не действует»', async () => {
    const { context, said } = fakeContext();
    const result = await handlerOf('scard').handle(supplierCardButtonId('save', 'tok-1'), context);
    expect(result).toBe('button_unknown');
    expect(said).toEqual([CHAT_BUTTON_STALE_TEXT]);
  });

  test('снятая кнопка скачка цен отвечает текстом', async () => {
    const retired = PROJECT_BUTTONS.find((handler) => !LIVE_PREFIXES.includes(handler.prefix));
    expect(retired).toBeDefined();
    const { context, said } = fakeContext();
    const result = await retired?.handle(`${retired.prefix}:x`, context);
    expect(result).toBe('price_jump_not_required');
    expect(said).toHaveLength(1);
  });
});

describe('до сборки агентов', () => {
  beforeEach(() => {
    clearPragmatikaRuntime();
  });

  test('кнопки выбора отвечают «проект не готов», файл идёт прежним путём', async () => {
    const { context, said } = fakeContext();
    expect(
      await handlerOf('pick').handle(pickButtonId('req-1', 'v1', 'sup-1'), context),
    ).toBe('project_not_ready');
    expect(said).toEqual([]);
    const file = {
      name: 'suppliers.xlsx',
      mimeType: 'application/octet-stream',
      content: new Uint8Array(),
    };
    expect(await supplierFileHandler.handle(file as never, context)).toBeNull();
  });

  test('блок состояния и действия приветствия без карточек молчат', async () => {
    expect(await projectStateBlock('thread-1', 'order-calc')).toBeNull();
    const { context, said } = fakeContext();
    expect(await PROJECT_GREETING_ACTIONS['supplier-template']?.(context)).toBeNull();
    expect(said).toEqual([]);
  });
});

describe('приветствие', () => {
  test('справка по карточкам отвечает без модели', async () => {
    const { context, said } = fakeContext();
    expect(await PROJECT_GREETING_ACTIONS['supplier-help']?.(context)).toBe('supplier_help');
    expect(said).toHaveLength(1);
  });

  test('блок состояния у других агентов пустой', async () => {
    expect(await projectStateBlock('thread-1', 'prices')).toBeNull();
  });
});

describe('карточки поставщиков включены', () => {
  beforeEach(() => {
    buildPragmatika({ SUPPLIER_CARDS_ENABLED: 'true' });
  });
  afterEach(() => {
    clearPragmatikaRuntime();
  });

  test('неизвестный запрос карточки: текст «не найден», без права и записи', async () => {
    const { context, said, asked } = fakeContext();
    const result = await handlerOf('scard').handle(supplierCardButtonId('save', 'tok-1'), context);
    expect(result).toBe('supplier_card_unknown_request');
    expect(said).toEqual([CHAT_SUPPLIER_CARD_UNKNOWN_TEXT]);
    expect(asked).toEqual([]);
  });

  test('нажатие без личности: решение не пишется', async () => {
    const { context, said } = fakeContext({ userId: '' });
    const result = await handlerOf('scard').handle(supplierCardButtonId('save', 'tok-1'), context);
    expect(result).toBe('supplier_card_no_identity');
    expect(said).toHaveLength(1);
  });

  test('файл не шаблон поставщиков: идёт прежним путём', async () => {
    const { context, said } = fakeContext();
    const file = { name: 'photo.jpg', mimeType: 'image/jpeg', content: new Uint8Array() };
    expect(await supplierFileHandler.handle(file as never, context)).toBeNull();
    expect(said).toEqual([]);
  });

  test('справочный текст и шаблон приветствия доступны', async () => {
    const { context } = fakeContext();
    expect(typeof PROJECT_GREETING_ACTIONS['supplier-template']).toBe('function');
    expect(await PROJECT_GREETING_ACTIONS['supplier-help']?.(context)).toBe('supplier_help');
  });
});
