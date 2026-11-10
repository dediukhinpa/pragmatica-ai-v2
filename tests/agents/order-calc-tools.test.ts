import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryScheduler, MemoryWebSearch, UnconfiguredWebSearch } from '@business-ai/adapters';
import { findDigitSeries } from '@business-ai/core';
import { AGENT_RUN_TASK_NAME, reminderThreadId } from '../../src/agents/order-calc/deps';
import {
  askManagerToChoose,
  buildChoiceMessage,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { recordChoiceButton, saveChoiceAsk } from '../../src/agents/order-calc/choice-confirmation';
import { loadProposal, loadSent } from '../../src/agents/order-calc/state';
import { recordSelection, selectionValidator } from '../../src/agents/order-calc/record-selection';
import { remindManager } from '../../src/agents/order-calc/remind-manager';
import { reminderValidator, scheduleReminder } from '../../src/agents/order-calc/schedule-reminder';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { checkSupplierRequest } from '../../src/agents/order-calc/supplier-request-shared';
import { AGENT_RUN_JOB } from '@business-ai/core/compose';
import { DomainError } from '@business-ai/core';
import { hoursToMs } from '../../src/kit/domain/time';
import { CTX, MANAGER_THREAD } from './support';
import {
  MAIL_OWNER,
  REQUEST_ID,
  buildOrderDeps,
  markRequestsSent,
  pickTarget,
  pressDone,
  type OrderTestDeps,
} from './order-support';

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps();
});

async function searchAll(): Promise<void> {
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
}

async function proposeAndSelect(supplierIds: string[]): Promise<void> {
  await searchAll();
  await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
  // Вопрос менеджеру запоминаем без отправки сообщения: журнал чата здесь не нужен.
  const proposal = await loadProposal(deps, REQUEST_ID);
  if (proposal !== null) await saveChoiceAsk(deps.state, deps.clock, CTX.threadId, proposal);
  await pickAsManager(supplierIds);
  await recordSelection.execute({ requestId: REQUEST_ID, supplierIds }, deps, CTX);
}

/** Менеджер нажимает кнопки выбора: подтверждение пишет код чата, а не инструмент. */
async function pickAsManager(supplierIds: string[]): Promise<void> {
  for (const supplierId of supplierIds) {
    const target = await pickTarget(deps.state, CTX.threadId, supplierId);
    const press = { supplierId: target, userId: 'manager', threadId: CTX.threadId };
    await recordChoiceButton(deps.state, deps.clock, press);
  }
  await pressDone(deps, CTX.threadId);
}

describe('поиск по источникам', () => {
  test('база знаний: поставщики с позицией заявки в прайсе, подсказки-документы', async () => {
    const out = await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out).toMatchObject({ source: 'knowledge', status: 'ok', found: 2 });
    expect(out.references.map((ref) => ref.documentId)).toEqual(['kb-1']);
  });

  test('веб находит кандидатов', async () => {
    expect((await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX)).found).toBe(2);
  });

  test('query принимается только как название позиции заявки (R3-SEC-3)', async () => {
    const out = await searchWeb.execute({ requestId: REQUEST_ID, query: 'арматура' }, deps, CTX);
    expect(out.found).toBe(2);
    const free = searchWeb.execute({ requestId: REQUEST_ID, query: 'сетка' }, deps, CTX);
    await expect(free).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('сбой источника не бросается: статус unavailable с кодом причины', async () => {
    deps.web.failWith(new DomainError('external_failure', 'таймаут', { retryable: true }));
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out).toMatchObject({ status: 'unavailable', reason: 'external_failure', found: 0 });
  });

  test('заглушка «не настроено» = источник недоступен с кодом not_configured', async () => {
    const out = await searchWeb.execute(
      { requestId: REQUEST_ID },
      { ...deps, web: new UnconfiguredWebSearch() },
      CTX,
    );
    expect(out).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
  });

  test('неизвестная заявка — not_found', async () => {
    const run = searchWeb.execute({ requestId: 'нет' }, deps, CTX);
    await expect(run).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('buildShortlist', () => {
  test('объединяет источники, дедуплицирует по названию, указывает источники', async () => {
    await searchAll();
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const metall = out.entries.find((entry) => entry.supplierId === 's1');
    expect(metall?.sources).toEqual(['knowledge', 'web']);
    expect(out.entries.map((entry) => entry.supplierId)).toHaveLength(3);
    expect(out.unavailableSources).toEqual([]);
    expect(out.empty).toBe(false);
  });

  test('оценка уходит модели округлённой, в шорт-листе остаётся точной', async () => {
    // Три результата веба: места в выдаче дают 1, 2/3 и 1/3; с весом типа «оптовик» (тестовый
    // классификатор) оценка = 0,5 * место + 0,45 - дроби с шестнадцатью цифрами.
    deps.web = new MemoryWebSearch(
      ['Альфа', 'Бета', 'Гамма'].map((title) => ({
        title,
        url: `https://${title}.test`,
        snippet: 'Арматура',
      })),
    );
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.entries.map((entry) => entry.score)).toEqual([0.95, 0.78, 0.62]);
    expect(findDigitSeries(JSON.stringify(out.entries.map((entry) => entry.score)))).toEqual([]);
    const stored = await loadProposal(deps, REQUEST_ID);
    expect(stored?.entries[1]?.score).toBeCloseTo(0.5 * (2 / 3) + 0.45, 12);
  });

  test('агенту уходят id и счётчики, но не названия', async () => {
    await searchAll();
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(JSON.stringify(out)).not.toContain('МеталлТорг');
  });

  test('недоступный источник помечен', async () => {
    deps.web.failWith(new DomainError('external_failure', 'x'));
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.unavailableSources).toEqual([
      { source: 'web', status: 'unavailable', reason: 'external_failure' },
    ]);
    expect(out.entries).toHaveLength(2);
  });

  test('данные с прежним источником community читаются, запись о нём не мешает', async () => {
    await deps.state.put('order-calc:source', `${REQUEST_ID}:community`, {
      source: 'community',
      status: 'ok',
      candidates: [{ name: 'Сталь-Опт', reference: 'community:m1', score: 0.8 }],
    });
    await deps.state.put('order-calc:proposal', REQUEST_ID, {
      requestId: REQUEST_ID,
      version: 'old',
      createdAt: '2026-01-01T00:00:00Z',
      managerThreadId: MANAGER_THREAD,
      entries: [
        {
          supplierId: 's1',
          name: 'А',
          sources: ['knowledge', 'community'],
          score: 1,
          references: [],
        },
        { supplierId: 'ext-б', name: 'Б', sources: ['community'], score: 1, references: [] },
      ],
      truncated: 0,
      sources: [
        { source: 'community', status: 'ok' },
        { source: 'knowledge', status: 'ok' },
        { source: 'web', status: 'not_searched' },
      ],
    });
    const proposal = await loadProposal(deps, REQUEST_ID);
    expect(proposal?.sources.map((item) => item.source)).toEqual(['knowledge', 'web']);
    expect(proposal?.entries.map((entry) => entry.supplierId)).toEqual(['s1']);
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.unavailableSources).toEqual([{ source: 'web', status: 'not_searched' }]);
  });

  test('не запрошенный источник помечен not_searched', async () => {
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.unavailableSources).toEqual([{ source: 'web', status: 'not_searched' }]);
  });

  test('размер ограничен limit, остаток считается', async () => {
    await searchAll();
    const out = await buildShortlist.execute({ requestId: REQUEST_ID, limit: 1 }, deps, CTX);
    expect(out.entries).toHaveLength(1);
    expect(out.truncated).toBe(2);
  });

  test('пересборка даёт новый version (новый раунд вопроса)', async () => {
    await searchAll();
    const first = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    deps.clock.advance(1_000);
    const second = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(second.version).not.toBe(first.version);
  });
});

describe('askManagerToChoose', () => {
  test('показывает менеджеру нумерованный список текстом, ход не приостанавливается', async () => {
    await searchAll();
    const { version } = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const ask = await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    expect(ask).toEqual({ asked: true });
    const sent = deps.chat.outbox[0];
    expect(sent?.threadId).toBe(CTX.threadId);
    expect(sent?.message?.buttons).toBeUndefined();
    expect(sent?.message?.text).toMatch(/\d\. Поставщик: МеталлТорг/u);
    // Вопрос выбора - отдельным сообщением после карточек.
    expect(deps.chat.outbox[1]?.message?.text).toContain('«берём 1 и 3»');
  });

  test('устаревший version — conflict, сообщение не отправляется', async () => {
    await searchAll();
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const ask = askManagerToChoose.execute({ requestId: REQUEST_ID, version: 'старый' }, deps, CTX);
    await expect(ask).rejects.toMatchObject({ code: 'conflict' });
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('без шорт-листа — not_found', async () => {
    const ask = askManagerToChoose.execute({ requestId: REQUEST_ID, version: 'v' }, deps, CTX);
    await expect(ask).rejects.toMatchObject({ code: 'not_found' });
  });

  test('сообщение при пустой выдаче — вопрос без кнопок, с пометками источников', () => {
    const message = buildChoiceMessage({
      requestId: REQUEST_ID,
      version: 'v',
      createdAt: '2026-01-01T00:00:00.000Z',
      managerThreadId: 't',
      entries: [],
      truncated: 0,
      sources: [{ source: 'web', status: 'unavailable', reason: 'external_failure' }],
    });
    expect(message.buttons).toBeUndefined();
    expect(message.text).toContain('не нашлось');
    expect(message.text).toContain('Источник «ИЗ ИНТЕРНЕТА» недоступен');
    expect(message.text.split('\n').slice(0, 2)).toEqual([
      '[B]Шорт-лист поставщиков[/B]',
      'Заявка: [B]заявка[/B]',
    ]);
  });
});

describe('recordSelection', () => {
  test('выбор не из шорт-листа блокируется валидатором, без шорт-листа — no_proposal', async () => {
    const input = { requestId: REQUEST_ID, supplierIds: ['s1'] };
    const before = await selectionValidator.validate(input, deps, CTX);
    expect(before.map((i) => i.code)).toEqual(['no_proposal']);
    await searchAll();
    const { version } = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const stranger = { requestId: REQUEST_ID, supplierIds: ['s3'] };
    const issues = await selectionValidator.validate(stranger, deps, CTX);
    expect(issues.map((i) => i.code)).toEqual(['not_in_proposal']);
    // Без вопроса менеджеру и его ответа выбор не подтверждён.
    const unconfirmed = await selectionValidator.validate(input, deps, CTX);
    expect(unconfirmed.map((i) => i.code)).toEqual(['selection_unconfirmed']);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX).catch(() => {});
    await pickAsManager(['s1']);
    expect(await selectionValidator.validate(input, deps, CTX)).toEqual([]);
  });

  test('внешний поставщик заводится в базе, поставщики без контакта перечислены', async () => {
    await searchAll();
    const out = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const external = out.entries.find((entry) => entry.supplierId.startsWith('ext-'));
    expect(external).toBeDefined();
    const externalId = external?.supplierId ?? '';
    const ids = ['s1', externalId];
    const input = { requestId: REQUEST_ID, supplierIds: ids };
    await askManagerToChoose
      .execute({ requestId: REQUEST_ID, version: out.version }, deps, CTX)
      .catch(() => {});
    await pickAsManager(ids);
    const result = await recordSelection.execute(input, deps, CTX);
    expect(result).toEqual({ requestId: REQUEST_ID, selected: 2, withoutContact: [externalId] });
    expect((await deps.suppliers.get(externalId))?.name).toBeDefined();
    expect((await deps.suppliers.get(externalId))?.email).toBeUndefined();
  });
});

describe('проверка запроса поставщикам (checkSupplierRequest)', () => {
  const draft = (ids: string[], body = 'Просим цену на арматуру 12, 100 м.') => ({
    requestId: REQUEST_ID,
    recipientSupplierIds: ids,
    subject: 'Запрос цены',
    body,
  });

  test('без выбора менеджера — no_selection', async () => {
    const issues = await checkSupplierRequest(draft(['s1']), deps);
    expect(issues.map((i) => i.code)).toEqual(['no_selection']);
  });

  test('адресат вне выбранного шорт-листа и токены в тексте — замечания', async () => {
    await proposeAndSelect(['s1']);
    const outsider = await checkSupplierRequest(draft(['s1', 's2']), deps);
    expect(outsider.map((i) => i.code)).toEqual(['recipient_not_in_shortlist']);
    const withToken = draft(['s1'], 'Для [ORG_1]');
    const tokens = await checkSupplierRequest(withToken, deps);
    expect(tokens.map((i) => i.code)).toEqual(['unresolved_token']);
    expect(await checkSupplierRequest(draft(['s1']), deps)).toEqual([]);
  });

  test('учёт отправленного: время первой отправки не сдвигается, владелец тот же', async () => {
    await proposeAndSelect(['s1', 's2']);
    await markRequestsSent(deps, ['s1']);
    const first = await loadSent(deps, REQUEST_ID);
    deps.clock.advance(hoursToMs(2));
    await markRequestsSent(deps, ['s1', 's2'], { owner: 'другой' });
    const second = await loadSent(deps, REQUEST_ID);
    expect(second?.sentBySupplier['s1']).toBe(first?.sentBySupplier['s1']);
    expect(second?.sentBySupplier['s2']).toBe(deps.clock.now().toISOString());
    expect(second?.mailboxOwnerId).toBe(MAIL_OWNER);
  });
});

describe('напоминание', () => {
  test('нельзя до отправки запросов', async () => {
    const issues = await reminderValidator.validate({ requestId: REQUEST_ID }, deps, CTX);
    expect(issues.map((i) => i.code)).toEqual(['requests_not_sent']);
  });

  test('задача agent.run на +24 часа, повтор не создаёт вторую', async () => {
    await proposeAndSelect(['s1']);
    await markRequestsSent(deps, ['s1']);
    expect(await reminderValidator.validate({ requestId: REQUEST_ID }, deps, CTX)).toEqual([]);
    const first = await scheduleReminder.execute({ requestId: REQUEST_ID }, deps, CTX);
    const again = await scheduleReminder.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(again.taskId).toBe(first.taskId);
    expect(Date.parse(first.runAt)).toBe(deps.clock.now().getTime() + hoursToMs(24));
    expect(await deps.scheduler.claimDue(deps.clock.now())).toEqual([]);
    // В расписании только суточное напоминание: проверок срока ответа больше не ставят.
    const all = await deps.scheduler.claimDue(new Date(first.runAt));
    const reminders = all.filter((t) => t.payload.includes('прошли сутки'));
    expect(all).toHaveLength(1);
    const [task, ...rest] = reminders;
    expect(rest).toEqual([]);
    expect(task?.name).toBe(AGENT_RUN_TASK_NAME);
    expect(JSON.parse(task?.payload ?? '{}')).toMatchObject({
      agentId: 'order-calc',
      threadId: reminderThreadId(REQUEST_ID),
    });
  });

  test('имя задачи совпадает с обработчиком службы', () => {
    expect(AGENT_RUN_TASK_NAME).toBe(AGENT_RUN_JOB);
    expect(deps.scheduler).toBeInstanceOf(MemoryScheduler);
  });

  test('remindManager пишет в тред менеджера текст без ПДн, один раз', async () => {
    await proposeAndSelect(['s1']);
    await remindManager.execute({ requestId: REQUEST_ID }, deps, CTX);
    await remindManager.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(deps.chat.outbox).toHaveLength(1);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('Проверьте, пожалуйста, статус вручную');
    expect(text).not.toContain('МеталлТорг');
    // Запросы подготовлены, а не «ушли»; статус предлагается проверить вручную.
    expect(text).not.toMatch(/отправк|отправили|ушли/);
  });

  test('без сохранённого треда напоминание идёт в тред менеджера по умолчанию', async () => {
    await remindManager.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(deps.chat.outbox[0]?.threadId).toBe(MANAGER_THREAD);
  });
});
