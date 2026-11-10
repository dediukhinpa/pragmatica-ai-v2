import { describe, expect, test } from 'bun:test';
import { MemoryIdempotencyStore, ServiceError } from '@business-ai/adapters';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { saveProposal, saveSelection } from '../../src/agents/order-calc/state';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { DomainError } from '@business-ai/core';
import type { ModelRequest } from '@business-ai/core';
import {
  callTool,
  say,
  scriptedRuntime,
  type Step,
  type StepFn,
} from '../kit/adapters/mastra/support';
import { MODEL_ALIAS, lastToolResult, toolMessages } from './support';

/** Чат сотрудника-владельца ящика: в него показывается текст запроса поставщикам. */
const EMPLOYEE_THREAD = `order-calc/${MAIL_OWNER}`;
/** Ход сотрудника: текст запроса готовится только по его просьбе. */
const EMPLOYEE_TURN = {
  context: { initiator: { kind: 'user', userId: MAIL_OWNER } },
} as const;
import { MAIL_OWNER, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Два поиска одним шагом модели: источники запускаются независимо. */
function searchesFor(requestId: string): Step {
  return {
    content: '',
    stopReason: 'tool_use',
    toolCalls: ['searchKnowledgeSuppliers', 'searchWeb'].map((name, index) => ({
      id: `search-${index}`,
      name,
      arguments: { requestId },
    })),
  };
}
const SEARCHES = searchesFor(REQUEST_ID);
const BUILD = callTool('c-build', 'buildShortlist', { requestId: REQUEST_ID });
/** Ответ менеджера текстом: агент записывает выбор по названиям из списка. */
const MANAGER_ANSWER = 'Берём МеталлТорг и Болтик';
function askFromBuild(request: ModelRequest): Step {
  const { version } = lastToolResult(request);
  return callTool('c-ask', 'askManagerToChoose', { requestId: REQUEST_ID, version });
}

/**
 * Полный сценарий: поиск, шорт-лист, вопрос текстом (ход закончен), ответ менеджера в новом
 * ходе, запись выбора, текст запроса поставщикам (показан в чате, письмо не отправлено),
 * напоминание.
 */
const FULL_SCRIPT: StepFn = (request, call) => {
  const steps: Array<Step | ((r: ModelRequest) => Step)> = [
    SEARCHES,
    BUILD,
    askFromBuild,
    // Этап 179: askManagerToChoose заканчивает ход, шага модели «Жду выбора» нет.
    callTool('c-choice', 'recordManagerChoice', {
      requestId: REQUEST_ID,
      decision: 'picked',
      picks: ['МеталлТорг', 'Болтик'],
    }),
    callTool('c-select', 'recordSelection', { requestId: REQUEST_ID, supplierIds: ['s1', 's2'] }),
    callTool('c-text', 'prepareSupplierRequestText', { requestId: REQUEST_ID }),
    callTool('c-remind', 'scheduleReminder', { requestId: REQUEST_ID }),
    say('Текст запроса готов, письма отправляет сотрудник, напоминание через сутки'),
  ];
  const step = steps[call] ?? say('сценарий закончился');
  return typeof step === 'function' ? step(request) : step;
};

function runtimeFor(
  deps: OrderCalcDeps,
  steps: StepFn,
  idempotency = new MemoryIdempotencyStore(),
) {
  const declaration = createOrderCalcAgent({ model: MODEL_ALIAS, mailbox: true });
  return scriptedRuntime(declaration, deps, steps, { runtime: { idempotency } });
}

describe('агент «Поиск поставщика (ИИ агент)»: сценарии', () => {
  test('с почтой сотрудников у агента девятнадцать инструментов, модель из параметра', () => {
    const declaration = createOrderCalcAgent({ model: 'алиас', mailbox: true });
    expect(declaration.model).toBe('алиас');
    expect(declaration.tools.map((tool) => tool.name)).toEqual([
      'searchKnowledgeSuppliers',
      'searchWeb',
      'searchInternet',
      'searchConversationHistory',
      'createFile',
      'buildShortlist',
      'askManagerToChoose',
      'recordManagerChoice',
      'recordSupplierCardDecision',
      'recordSelection',
      'prepareSupplierRequestText',
      'scheduleReminder',
      'remindManager',
      'readSupplierReplies',
      'readReplyAttachment',
      'routeSupplierMail',
      'recordSupplierReply',
      'recordQuote',
      'confirmQuoteReplacement',
      'compareQuotes',
      'sendQuoteSummary',
      'orderStatus',
      'closeOrder',
    ]);
  });

  test('без почты сотрудников инструментов чтения писем нет, текст запроса готовится', () => {
    const declaration = createOrderCalcAgent({ model: 'алиас' });
    const names = declaration.tools.map((tool) => tool.name);
    expect(names).toEqual([
      'searchKnowledgeSuppliers',
      'searchWeb',
      'searchInternet',
      'searchConversationHistory',
      'createFile',
      'buildShortlist',
      'askManagerToChoose',
      'recordManagerChoice',
      'recordSupplierCardDecision',
      'recordSelection',
      'prepareSupplierRequestText',
      // Ответ мог прийти по телефону или в мессенджере: эти инструменты работают без почты.
      'recordSupplierReply',
      'recordQuote',
      'confirmQuoteReplacement',
      'compareQuotes',
      'sendQuoteSummary',
      'orderStatus',
      'closeOrder',
    ]);
    for (const mailTool of [
      'readSupplierReplies',
      'readReplyAttachment',
      'routeSupplierMail',
      'scheduleReminder',
      'remindManager',
    ]) {
      expect(names).not.toContain(mailTool);
      // Промпт и приветствие не называют недоступные инструменты.
      expect(declaration.prompt).not.toContain(mailTool);
    }
    // Без почты агент честно говорит: ответы он не читает, статус проверяется вручную.
    expect(declaration.prompt).toContain('почта не подключена');
    expect(declaration.prompt).toContain('prepareSupplierRequestText');
    // Агент не обещает отправлять письма и читать ответы.
    expect(JSON.stringify(declaration.greeting)).not.toMatch(/отправляю|ответы поставщиков/i);
    // Проверок писем тоже нет: выбор менеджера остаётся.
    expect(declaration.validators?.map((validator) => validator.name)).toEqual([
      'shortlist-selection',
      'supplier-quote',
      'quote-summary',
    ]);
  });

  test('шорт-лист → вопрос текстом → ответ менеджера → текст запроса → напоминание', async () => {
    const deps = await buildOrderDeps();
    const { runtime, spec } = runtimeFor(deps, FULL_SCRIPT);

    const asked = await runtime.run(spec, EMPLOYEE_THREAD, `Заявка ${REQUEST_ID}, в работу`, {
      ...EMPLOYEE_TURN,
    });
    // Кнопок нет: ход закончен, менеджер видит нумерованный список и подсказку жирным.
    expect(asked.status).toBe('completed');
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
    const question = deps.chat.outbox[0]?.message;
    expect(question?.buttons).toBeUndefined();
    expect(question?.text).toContain('1. Поставщик:');
    // Вопрос выбора - отдельным сообщением после карточек (этап 171).
    expect(deps.chat.outbox[1]?.message?.text).toContain('«берём 1 и 3»');

    // Выбор принят: текст запроса показан в чате, агент не останавливается на кнопке отправки.
    const done = await runtime.run(spec, EMPLOYEE_THREAD, MANAGER_ANSWER, { ...EMPLOYEE_TURN });
    expect(done).toMatchObject({ status: 'completed' });
    const shown = deps.chat.outbox.flatMap((record) => record.message ?? []);
    const texts = shown.map((message) => message.text);
    expect(texts.filter((text) => text.includes('Добрый день.'))).toHaveLength(2);
    expect(texts.join('\n')).toContain('sales@metall.test');
    expect(texts.join('\n')).toContain('info@boltik.test');
    // Кнопок отправки нет, письма с ящика сотрудника не ушли.
    expect(shown.flatMap((message) => message.buttons ?? []).map((b) => b.id)).not.toContain(
      expect.stringMatching(/^edraft:/),
    );
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
    const tasks = await deps.scheduler.claimDue(new Date('2026-01-03T00:00:00.000Z'));
    // Только суточное напоминание: проверок срока ответа больше не ставят.
    expect(tasks.map((task) => task.name)).toEqual(['agent.run']);
  });

  test('два источника запускаются одним шагом, результаты не мешают друг другу', async () => {
    const deps = await buildOrderDeps();
    const { gateway, runtime, spec } = runtimeFor(deps, (request, call) =>
      call === 0 ? SEARCHES : call === 1 ? BUILD : say('готово'),
    );
    await runtime.run(spec, 't1', 'заявка');
    const results = toolMessages(gateway.requests[1]).join('\n');
    for (const source of ['knowledge', 'web']) expect(results).toContain(source);
    const build = lastToolResult(gateway.requests[2] as ModelRequest);
    expect(build['empty']).toBe(false);
  });

  test('один источник недоступен: шорт-лист собран с пометкой, остальные работают', async () => {
    const deps = await buildOrderDeps();
    deps.web.failWith(new DomainError('external_failure', 'нет связи', { retryable: true }));
    const { gateway, runtime, spec } = runtimeFor(deps, (request, call) => {
      if (call === 0) return SEARCHES;
      if (call === 1) return BUILD;
      if (call === 2) return askFromBuild(request);
      return say('сценарий закончился');
    });
    const asked = await runtime.run(spec, 't1', 'заявка');
    expect(asked.status).toBe('completed');
    const build = toolMessages(gateway.requests[2]).join('\n');
    expect(build).toContain('"source":"web","status":"unavailable"');
    const question = deps.chat.outbox[0]?.message;
    expect(deps.chat.outbox[1]?.message?.text).toContain('Источник «ИЗ ИНТЕРНЕТА» недоступен');
    expect(question?.text).toContain('2. Поставщик:');
  });

  test('квота Яндекса: ровно одна строка про интернет, остальные источники работают', async () => {
    const deps = await buildOrderDeps();
    deps.web.failWith(
      new ServiceError('Лимит исчерпан.', { kind: 'quota_exhausted', provider: 'yandex_search' }),
    );
    const { gateway, runtime, spec } = runtimeFor(deps, (request, call) => {
      if (call === 0) return SEARCHES;
      if (call === 1) return BUILD;
      if (call === 2) return askFromBuild(request);
      return say('сценарий закончился');
    });
    const asked = await runtime.run(spec, 't1', 'заявка');
    expect(asked.status).toBe('completed');
    const build = toolMessages(gateway.requests[2]).join('\n');
    expect(build).toContain('"source":"web","status":"unavailable","reason":"quota_exhausted"');
    const texts = deps.chat.outbox.map((item) => item.message?.text ?? '').join('\n');
    const line = 'Поиск в интернете временно недоступен (исчерпан лимит), использую только базу.';
    expect(texts.split(line)).toHaveLength(2);
    expect(texts).not.toContain('Источник «ИЗ ИНТЕРНЕТА» недоступен');
    expect(deps.chat.outbox[0]?.message?.text).toContain('2. Поставщик:');
  });

  test('адресатов модель назвать не может: текст только выбранным менеджером', async () => {
    const deps = await buildOrderDeps();
    const now = deps.clock.now().toISOString();
    await saveSelection(deps, { requestId: REQUEST_ID, supplierIds: ['s1'], createdAt: now });
    const { runtime, spec } = runtimeFor(deps, (_request, call) =>
      call === 0
        ? callTool('c-text', 'prepareSupplierRequestText', {
            requestId: REQUEST_ID,
            recipientSupplierIds: ['s1', 's2'],
          })
        : say('Текст готов'),
    );
    await runtime.run(spec, EMPLOYEE_THREAD, 'подготовь запрос', { ...EMPLOYEE_TURN });
    const shown = deps.chat.outbox.flatMap((record) => record.message?.text ?? []).join('\n');
    expect(shown).toContain('sales@metall.test');
    expect(shown).not.toContain('info@boltik.test');
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
  });

  test('пустая выдача: агент спрашивает менеджера, а не выдумывает поставщиков', async () => {
    const empty = {
      id: 'req-9',
      dealRef: 'D-9',
      items: [{ name: 'Космолёт', quantity: 1, unit: 'шт' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const deps = await buildOrderDeps({ request: empty });
    const input = { requestId: 'req-9' };
    const script: StepFn = (request, call) => {
      if (call === 0) return searchesFor('req-9');
      if (call === 1) return callTool('c-build', 'buildShortlist', input);
      if (call === 2) {
        const { version } = lastToolResult(request);
        return callTool('c-ask', 'askManagerToChoose', { ...input, version });
      }
      return say('Повторю поиск по уточнению менеджера');
    };
    const { gateway, runtime, spec } = runtimeFor(deps, script);
    const asked = await runtime.run(spec, 't1', 'заявка req-9');
    expect(asked.status).toBe('completed');
    expect(toolMessages(gateway.requests[2]).join('\n')).toContain('"empty":true');
    const question = deps.chat.outbox[0]?.message;
    expect(question?.text).toContain('не нашлось');
    expect(question?.buttons).toBeUndefined();
    const done = await runtime.run(spec, 't1', 'Ищи «металлопрокат»');
    expect(done.status).toBe('completed');
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
  });

  test('повторный запуск не показывает текст дважды и не плодит напоминаний', async () => {
    const deps = await buildOrderDeps();
    const idempotency = new MemoryIdempotencyStore();
    const first = runtimeFor(deps, FULL_SCRIPT, idempotency);
    await first.runtime.run(first.spec, EMPLOYEE_THREAD, 'заявка', { ...EMPLOYEE_TURN });
    await first.runtime.run(first.spec, EMPLOYEE_THREAD, MANAGER_ANSWER, { ...EMPLOYEE_TURN });
    const requestTexts = (): number =>
      deps.chat.outbox.filter((record) => record.message?.text.includes('Добрый день.') === true)
        .length;
    expect(requestTexts()).toBe(2);

    // Новый процесс, общее хранилище ключей: та же заявка запущена заново. Данные не менялись:
    // текст второй раз не показывается, напоминания не плодятся.
    const second = runtimeFor(deps, FULL_SCRIPT, idempotency);
    await second.runtime.run(second.spec, EMPLOYEE_THREAD, 'заявка ещё раз', {
      ...EMPLOYEE_TURN,
    });
    await second.runtime.run(second.spec, EMPLOYEE_THREAD, MANAGER_ANSWER, { ...EMPLOYEE_TURN });
    expect(requestTexts()).toBe(2);
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
    const tasks = await deps.scheduler.claimDue(new Date('2026-01-03T00:00:00.000Z'));
    // Повтор не плодит задач: напоминание ровно одно, проверок срока нет.
    expect(tasks).toHaveLength(1);
  });

  test('подготовка текста до выбора менеджера блокируется (нет выбора)', async () => {
    const deps = await buildOrderDeps();
    const { gateway, runtime, spec } = runtimeFor(deps, (_request, call) =>
      call === 0
        ? callTool('c-text', 'prepareSupplierRequestText', { requestId: REQUEST_ID })
        : say('жду выбора'),
    );
    await runtime.run(spec, EMPLOYEE_THREAD, 'подготовь сразу', { ...EMPLOYEE_TURN });
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
    expect(deps.chat.outbox).toHaveLength(0);
    expect(toolMessages(gateway.requests[1]).join('\n')).toContain('Менеджер ещё не выбрал');
  });

  test('ящик сотрудника не подключён: текст готов, агенту сказано про почту', async () => {
    const deps: OrderTestDeps = await buildOrderDeps();
    const { gateway, runtime, spec } = runtimeFor(deps, FULL_SCRIPT);
    const turn = { context: { initiator: { kind: 'user', userId: 'u7' } } } as const;
    await runtime.run(spec, 'order-calc/u7', 'заявка', turn);
    await runtime.run(spec, 'order-calc/u7', MANAGER_ANSWER, turn);
    const all = gateway.requests.flatMap((request) => toolMessages(request)).join('\n');
    expect(all).toContain('"mailConnected":false');
    const chat = deps.chat.outbox.flatMap((record) => record.message?.text ?? []).join('\n');
    expect(chat).toContain('Почта не подключена');
    expect(chat).toContain('Добрый день.');
    expect(deps.mailboxes.sentBy(MAIL_OWNER)).toHaveLength(0);
  });
});
