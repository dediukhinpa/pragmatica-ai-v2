import { describe, expect, test } from 'bun:test';
import { ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { PRICES_PROMPT } from '../../src/agents/prices/prompt';
import { SUPPLIER_BATCH_MAX_ROWS } from '../../src/agents/suppliers/deps';
import {
  SUPPLIER_CARDS_PROMPT,
  SUPPLIER_CARDS_PROMPT_WITHOUT_ENRICH,
  SUPPLIER_HELP_TEXT,
} from '../../src/agents/suppliers/prompt';
import {
  assertDeclarationValid,
  defineProject,
  findDigitSeries,
  type AgentDeclaration,
  type GreetingButtonAction,
  FILE_TOOL_PROMPT,
  SESSION_SUMMARY_PROMPT,
} from '@business-ai/core';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { supplierCardsTools } from '../../src/agents/suppliers/tools';
import { ORDER_CALC_GREETING } from '../../src/agents/order-calc/greeting';
import { PRICES_GREETING } from '../../src/agents/prices/greeting';
import { digitSeriesOf } from '@business-ai/testing';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { MODEL_ALIAS } from './support';
import { INN_ALPHA, THREAD_A, USER_A, buildSupplierWorld, lastShown } from './suppliers-support';

const MODEL = 'test-model';
const MODULE_TOOLS = supplierCardsTools().map((tool) => tool.name);
/** Общий абзац промпта про дополнение карточки (у агента документов его нет). */
const GENERAL_ENRICH_BLOCK = 'Дополнить СУЩЕСТВУЮЩУЮ карточку сведениями из материала';

const names = (declaration: AgentDeclaration): string[] =>
  declaration.tools.map((tool) => tool.name);

describe('опция supplierCards: без неё декларации прежние', () => {
  test('«Актуализация прайса (ИИ агент)»: нет инструментов модуля, промпт и приветствие без ' +
    'изменений', () => {
    const plain = createPricesAgent({ model: MODEL });
    expect(plain.prompt).toBe(PRICES_PROMPT + SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT);
    expect(plain.greeting).toBe(PRICES_GREETING);
    for (const name of MODULE_TOOLS) expect(names(plain)).not.toContain(name);
    expect(plain.prompt).not.toContain('Карточки поставщиков');
    // Явное «выключено» - то же самое, что отсутствие опции.
    expect(createPricesAgent({ model: MODEL, mailbox: false })).toEqual(plain);
  });

  test('«Поиск поставщика (ИИ агент)»: то же', () => {
    const plain = createOrderCalcAgent({ model: MODEL });
    expect(plain.prompt).toBe(ORDER_CALC_PROMPT + SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT);
    expect(plain.greeting).toBe(ORDER_CALC_GREETING);
    for (const name of MODULE_TOOLS) expect(names(plain)).not.toContain(name);
  });

  test('с опцией: инструменты, дополнение промпта и три кнопки приветствия', () => {
    for (const [base, withCards, greeting] of [
      [
        createPricesAgent({ model: MODEL }),
        createPricesAgent({ model: MODEL, supplierCards: {} }),
        PRICES_GREETING,
      ],
      [
        createOrderCalcAgent({ model: MODEL }),
        createOrderCalcAgent({ model: MODEL, supplierCards: {} }),
        ORDER_CALC_GREETING,
      ],
    ] as const) {
      expect(names(withCards)).toEqual([...names(base), ...MODULE_TOOLS]);
      // Правило про сводку прошлых диалогов всегда последнее: карточки вставляются перед ним.
      const tail = SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT;
      expect(withCards.prompt).toBe(
        base.prompt.slice(0, -tail.length) + SUPPLIER_CARDS_PROMPT + tail,
      );
      expect(withCards.validators).toEqual(base.validators);
      const added = withCards.greeting?.buttons.slice(greeting.buttons.length) ?? [];
      const help: GreetingButtonAction = 'supplier-help';
      const template: GreetingButtonAction = 'supplier-template';
      expect(added.map((button) => [button.id, button.action])).toEqual([
        ['add-supplier', undefined],
        ['supplier-help', help],
        ['supplier-template', template],
      ]);
      const kept = withCards.greeting?.buttons.slice(0, greeting.buttons.length);
      expect(kept).toEqual(greeting.buttons);
      expect(() => assertDeclarationValid(withCards)).not.toThrow();
    }
  });

  test('greetingButtons: false - инструменты есть, кнопок нет', () => {
    const declaration = createPricesAgent({
      model: MODEL,
      supplierCards: { greetingButtons: false },
    });
    expect(declaration.greeting).toBe(PRICES_GREETING);
    expect(names(declaration)).toContain('prepareSupplierCard');
  });

  test('с остальными опциями вместе: приветствие укладывается в предел', () => {
    const prices = createPricesAgent({
      model: MODEL,
      mailbox: true,
      monitoring: true,
      supplierCards: {},
    });
    expect(prices.greeting?.buttons).toHaveLength(6);
    expect(() => assertDeclarationValid(prices)).not.toThrow();
  });
});

describe('проверка приветствия: действие кнопки и предел', () => {
  const declaration = (): AgentDeclaration =>
    createPricesAgent({ model: MODEL, supplierCards: {} });

  /**
   * Манифест проекта с приветствием агента прайсов и обработчиками действий Прагматики. Набор
   * действий замыкает манифест (`chat.greetingActions`), а не декларация: платформа проверяет в
   * декларации только вид имени.
   */
  const projectWith = (greeting: NonNullable<AgentDeclaration['greeting']>) => {
    const handler = async (): Promise<string | null> => 'ok';
    return defineProject({
      id: 'pragmatika',
      models: { prices: 'PRICES_MODEL' },
      chat: {
        defaultAgentId: 'prices',
        greetings: { prices: greeting },
        greetingActions: { 'supplier-help': handler, 'supplier-template': handler },
      },
      agents: () => ({ declarations: [], deps: {} }),
    });
  };

  test('неизвестное действие кнопки отклоняется', () => {
    const base = declaration();
    const greeting = base.greeting;
    if (greeting === undefined) throw new Error('нет приветствия');
    expect(() => projectWith(greeting)).not.toThrow();
    const buttons = [
      ...greeting.buttons.slice(0, -1),
      { id: 'bad', label: 'Плохая', prompt: 'х', action: 'launch-missiles' as never },
    ];
    expect(() => projectWith({ ...greeting, buttons })).toThrow(/launch-missiles/);
    // Имя не вида «латиница, цифры, дефис» отклоняет уже декларация.
    const malformed = [
      ...greeting.buttons.slice(0, -1),
      { id: 'bad', label: 'Плохая', prompt: 'х', action: 'Launch Missiles' as never },
    ];
    expect(() =>
      assertDeclarationValid({ ...base, greeting: { ...greeting, buttons: malformed } }),
    ).toThrow(/имя действия/);
  });

  test('седьмая кнопка отклоняется', () => {
    const base = declaration();
    const greeting = base.greeting;
    if (greeting === undefined) throw new Error('нет приветствия');
    const buttons = [...greeting.buttons, { id: 'extra', label: 'Ещё', prompt: 'х' }];
    expect(() => assertDeclarationValid({ ...base, greeting: { ...greeting, buttons } })).toThrow(
      /кнопок не больше 6/,
    );
  });
});

describe('справка', () => {
  test('SUPPLIER_HELP_TEXT: три способа и обязательное поле, без длинных цифр', () => {
    expect(SUPPLIER_HELP_TEXT).toContain('Текстом');
    expect(SUPPLIER_HELP_TEXT).toContain('Файлом');
    expect(SUPPLIER_HELP_TEXT).toContain('Письмом');
    expect(SUPPLIER_HELP_TEXT).toContain('Обязательно только название');
    // Лимит пачки в справке совпадает с кодом, личный слой и заметка упомянуты.
    expect(SUPPLIER_HELP_TEXT).toContain(`до ${SUPPLIER_BATCH_MAX_ROWS} строк`);
    expect(SUPPLIER_HELP_TEXT).toContain('запомни');
    expect(SUPPLIER_HELP_TEXT).toContain('заметку к поставщику');
    expect(findDigitSeries(SUPPLIER_HELP_TEXT)).toEqual([]);
  });
});

describe('сквозной ход агента на заглушке модели', () => {
  test('модель готовит карточку: показ с кнопками, в базе пусто, без серий цифр', async () => {
    const world = buildSupplierWorld();
    world.chat.outbox.length = 0;
    // Уже существующая карточка с ИНН: поиск вернёт её модели маскированной.
    await world.suppliers.saveCard({
      id: 'sup-exists',
      name: 'Омега Снаб',
      inn: INN_ALPHA,
      status: 'active',
      contacts: [{ fullName: 'Анна', phone: '+79001112233', isPrimary: true }],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    const toolDeps = { supplierCards: world.deps };
    const { gateway, runtime, spec } = scriptedRuntime(
      createPricesAgent({ model: MODEL_ALIAS, supplierCards: {} }),
      toolDeps,
      (_request, call) => {
        if (call === 0) return callTool('c-find', 'findSupplierCard', { query: 'Омега' });
        if (call === 1) {
          return callTool('c-prep', 'prepareSupplierCard', {
            name: 'Новый Поставщик',
            contacts: [{ fullName: 'Иван', email: 'ivan@new.example.ru' }],
          });
        }
        return say('Карточка показана, жду нажатия.');
      },
    );
    const result = await runtime.run(spec, THREAD_A, 'добавь поставщика', {
      context: { initiator: { kind: 'user', userId: USER_A } },
    });
    expect(result.output).toBe('Карточка показана, жду нажатия.');
    const shown = await lastShown(world.chat, THREAD_A);
    expect(shown.text).toContain('Новый Поставщик');
    expect(shown.actions).toEqual(['save', 'cancel']);
    expect(await world.suppliers.searchCards({ query: 'Новый', limit: 5 })).toHaveLength(0);
    expect(gateway.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of gateway.requests) expect(digitSeriesOf(request)).toEqual([]);
  });
});

describe('карточки поставщиков у всех четырёх агентов (SUPPLIER_CARDS_ENABLED)', () => {
  const factories = [
    ['prices', (o: object) => createPricesAgent({ model: MODEL, ...o })],
    ['documents', (o: object) => createDocumentsAgent({ model: MODEL, ...o })],
    ['order-calc', (o: object) => createOrderCalcAgent({ model: MODEL, ...o })],
    ['site-export', (o: object) => createSiteExportAgent({ model: MODEL, ...o })],
  ] as const;

  for (const [id, make] of factories) {
    test(`${id}: флаг включён - инструменты, промпт и кнопки; выключен - ничего`, () => {
      const off = make({});
      const on = make({ supplierCards: {} });
      // Агент документов: общего абзаца про дополнение нет (этап 218); инструмент
      // `enrichSupplierCard` у него - обёртка только для договора со своим абзацем (этап 219).
      const withoutEnrich = id === 'documents';
      for (const name of MODULE_TOOLS) {
        expect(names(off)).not.toContain(name);
        expect(names(on)).toContain(name);
      }
      const prompt = withoutEnrich ? SUPPLIER_CARDS_PROMPT_WITHOUT_ENRICH : SUPPLIER_CARDS_PROMPT;
      expect(off.prompt).not.toContain(SUPPLIER_CARDS_PROMPT);
      expect(off.prompt).not.toContain(SUPPLIER_CARDS_PROMPT_WITHOUT_ENRICH);
      expect(on.prompt).toContain(prompt);
      expect(on.prompt.includes(GENERAL_ENRICH_BLOCK)).toBe(!withoutEnrich);
      const ids = (d: AgentDeclaration): string[] => (d.greeting?.buttons ?? []).map((b) => b.id);
      expect(ids(off)).not.toContain('add-supplier');
      expect(ids(on)).toContain('add-supplier');
      expect(ids(on)).toContain('supplier-template');
    });
  }
});
