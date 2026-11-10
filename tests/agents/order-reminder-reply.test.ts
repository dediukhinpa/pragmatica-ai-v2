import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock } from '@business-ai/adapters';
import { EVENT_SEVERITY } from '@business-ai/adapters';
import { bindingThreadId } from '@business-ai/core';
import { activeRequestBlocks, setActiveRequest } from '../../src/agents/order-calc/active-request';
import { answerOrderReminder, recordDigestShown } from '../../src/agents/order-calc/reminder-reply';
import { closeOrder } from '../../src/agents/order-calc/order-status';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import {
  createToolContext,
  MONITORING_NAMESPACE,
  monitoringKey,
  recordWorkOwner,
  type ToolContext,
} from '@business-ai/core';
import { closeOrderRecord, isOrderClosed } from '../../src/agents/order-calc/order-progress';
import { requestTag } from '../../src/agents/order-calc/reply-routing';
import { runOrdersDigest } from '../../src/agents/order-calc/orders-digest';
import { saveSent } from '../../src/agents/order-calc/state';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import {
  callTool,
  say,
  scriptedRuntime,
  type Step,
  type StepFn,
} from '../kit/adapters/mastra/support';
import { MODEL_ALIAS } from './support';
import { MAIL_OWNER, ORDER_REQUEST, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Пояс бизнеса заказчика: Екатеринбург (UTC+5). */
const TIMEZONE = 'Asia/Yekaterinburg';
const BOT = 'order-bot';
const THREAD = bindingThreadId({ botId: BOT, userId: MAIL_OWNER });
const HEADLINE = 'План на день:';

/** Пятница 10:00 по Екатеринбургу (05:00 UTC): первая сводка. */
const FRIDAY_DIGEST = '2026-10-09T05:00:00.000Z';
/** Заявки подготовлены в среду. */
const WEDNESDAY_SENT = '2026-10-07T10:00:00.000Z';
/** Понедельник 08:00 по Екатеринбургу: сотрудница отвечает на пятничное напоминание. */
const MONDAY_REPLY = '2026-10-12T03:00:00.000Z';
/** Понедельник 10:00 по Екатеринбургу: сводка. */
const MONDAY_DIGEST = '2026-10-12T05:00:00.000Z';
const TUESDAY_DIGEST = '2026-10-13T05:00:00.000Z';
const THURSDAY_DIGEST = '2026-10-15T05:00:00.000Z';

const PORCELAIN = 'req-porcelain';
const PANEL = 'req-panel';

let deps: OrderTestDeps;

function setNow(iso: string): void {
  deps.clock = new FixedClock(new Date(iso));
}

/** Ход сотрудника в его треде связки. */
function turn(turnNumber = 1, threadId = THREAD, userId = MAIL_OWNER): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'test-agent',
    operationId: `op-turn-${turnNumber}`,
    initiator: { kind: 'user', userId },
    turnNumber,
  });
}

/** Заявка с названием; запросы поставщику s1 подготовлены в среду (или в `sentAt`). */
async function prepared(
  requestId: string,
  title: string,
  options: { owner?: string; sentAt?: string } = {},
): Promise<void> {
  const owner = options.owner ?? MAIL_OWNER;
  const sentAt = options.sentAt ?? WEDNESDAY_SENT;
  await deps.requests.save({
    ...ORDER_REQUEST,
    id: requestId,
    items: [{ name: title, quantity: 1, unit: 'шт' }],
  });
  await saveSent(deps, {
    requestId,
    supplierIds: ['s1'],
    sentAt,
    sentBySupplier: { s1: sentAt },
    mailboxOwnerId: owner,
    state: 'prepared',
  });
  // Владелец заявки - тред сотрудника: туда и придёт сводка.
  const thread = bindingThreadId({ botId: BOT, userId: owner });
  await recordWorkOwner(deps.state, workSubject.order(requestId), turn(1, thread, owner));
}

const digest = () => runOrdersDigest(deps, { timezone: TIMEZONE });

/** Тексты системных блоков хода одной строкой. */
async function blocksText(threadId = THREAD): Promise<string> {
  return (await activeRequestBlocks(deps, threadId)).map((block) => block.text).join('\n');
}

/** Тексты сводок, отправленных в тред. */
function digests(): string[] {
  return deps.chat
    .outboxOf(THREAD)
    .map((record) => record.message?.text ?? '')
    .filter((text) => text.startsWith(HEADLINE));
}

/** Заявка есть в последней отправленной сводке. */
function lastDigestMentions(title: string): boolean {
  const last = digests().at(-1) ?? '';
  return last.includes(title);
}

beforeEach(async () => {
  deps = await buildOrderDeps({ request: null });
  deps.reminderReply = { timezone: TIMEZONE };
  setNow(FRIDAY_DIGEST);
  await prepared(PORCELAIN, 'фарфоровые конфеты');
  await prepared(PANEL, 'панно с медсестрой');
});

describe('ответ на утреннее напоминание: запоминание показанного', () => {
  test('сводка запоминает показанные заявки треда', async () => {
    await digest();
    const shown = await deps.state.get('order-calc:digest-shown', THREAD);
    expect(shown).not.toBeNull();
    const orders = (shown as { orders: Array<{ requestId: string }> }).orders;
    expect(orders.map((o) => o.requestId).sort()).toEqual([PANEL, PORCELAIN]);
  });

  test('справка: заявки напоминания с requestId, даже без активной заявки', async () => {
    await digest();
    setNow(MONDAY_REPLY);
    const blocks = await activeRequestBlocks(deps, THREAD);
    expect(blocks.map((block) => block.id)).toEqual(['order_reminder']);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('фарфоровые конфеты');
    expect(text).toContain(`requestId: ${PORCELAIN}`);
    expect(text).toContain('answerOrderReminder');
  });

  test('справка идёт отдельным блоком рядом с активной заявкой и не подменяет её', async () => {
    await digest();
    await setActiveRequest(deps, THREAD, PANEL);
    setNow(MONDAY_REPLY);
    const blocks = await activeRequestBlocks(deps, THREAD);
    expect(blocks.map((block) => block.id)).toEqual(['active_request', 'order_reminder']);
    expect(blocks[0]?.text).toContain('активная заявка этого диалога');
    expect(blocks[1]?.text).toContain('напоминание');
  });

  test('после окна времени справки о напоминании нет', async () => {
    await digest();
    setNow('2026-10-20T05:00:00.000Z');
    expect(await activeRequestBlocks(deps, THREAD)).toEqual([]);
  });

  test('чужой тред справки не получает', async () => {
    await digest();
    setNow(MONDAY_REPLY);
    expect(await blocksText(bindingThreadId({ botId: BOT, userId: 'other' }))).toBe('');
  });

  test('запись о сводке не хранит текст сообщения, только заявки с датой', async () => {
    await digest();
    const shown = (await deps.state.get('order-calc:digest-shown', THREAD)) as Record<
      string,
      unknown
    >;
    expect(shown['text']).toBeUndefined();
    expect(shown['dateKey']).toBe('2026-10-09');
  });
});

describe('answerOrderReminder: действия', () => {
  beforeEach(async () => {
    await digest();
    setNow(MONDAY_REPLY);
  });

  test('«да, ответили» → напомнить позже: нет в сводке до даты, потом возвращается', async () => {
    const result = await answerOrderReminder.execute(
      { action: 'remind_later', requestId: PORCELAIN, days: 3 },
      deps,
      turn(),
    );
    expect(result.status).toBe('snoozed');
    expect(result.untilDate).toBe('2026-10-15');

    setNow(MONDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(false);
    expect(lastDigestMentions('панно с медсестрой')).toBe(true);
    setNow(TUESDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(false);
    // В дату напоминания заявка возвращается в сводку.
    setNow(THURSDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(true);
  });

  test('отложить до даты: сводка пропускает заявку до этой даты', async () => {
    const result = await answerOrderReminder.execute(
      { action: 'snooze', requestId: PORCELAIN, untilDate: '2026-10-14' },
      deps,
      turn(),
    );
    expect(result).toMatchObject({ status: 'snoozed', untilDate: '2026-10-14' });
    setNow(TUESDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(false);
    setNow('2026-10-14T05:00:00.000Z');
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(true);
  });

  test('день отсчитывается по Екатеринбургу, а не по UTC и не по Москве', async () => {
    // 20:00 UTC в понедельник - уже вторник 01:00 в Екатеринбурге.
    setNow('2026-10-12T20:00:00.000Z');
    const result = await answerOrderReminder.execute(
      { action: 'remind_later', requestId: PORCELAIN, days: 1 },
      deps,
      turn(),
    );
    expect(result.untilDate).toBe('2026-10-14');
    setNow(TUESDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(false);
  });

  test('закрыть: двухшаговый протокол closeOrder, «да» отдельной репликой', async () => {
    const before = deps.chat.outboxOf(THREAD).length;
    const shown = await answerOrderReminder.execute(
      { action: 'close', requestId: PORCELAIN },
      deps,
      turn(1),
    );
    expect(shown.status).toBe('needs_confirmation');
    // Первый вызов ничего не закрывает и показывает сотруднику вопрос.
    expect(await isOrderClosed(deps, PORCELAIN)).toBe(false);
    const asked = deps.chat.outboxOf(THREAD).slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message?.text ?? '').toContain('Закрыть заказ');
    // Подтверждение в той же реплике (без отдельного сообщения сотрудника) не принимается.
    await expect(
      answerOrderReminder.execute(
        { action: 'close', requestId: PORCELAIN, confirmed: true },
        deps,
        turn(1),
      ),
    ).rejects.toThrow(/отдельным сообщением/);
    expect(await isOrderClosed(deps, PORCELAIN)).toBe(false);
    // Отдельная реплика с «да» закрывает.
    const closed = await answerOrderReminder.execute(
      { action: 'close', requestId: PORCELAIN, confirmed: true },
      deps,
      turn(2),
    );
    expect(closed.status).toBe('closed');
    expect(await isOrderClosed(deps, PORCELAIN)).toBe(true);
    const again = await answerOrderReminder.execute(
      { action: 'close', requestId: PORCELAIN },
      deps,
      turn(3),
    );
    expect(again.status).toBe('already_closed');
    setNow(MONDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(false);
  });

  test('закрыть без показанного вопроса: confirmed отклоняется, заказ открыт', async () => {
    await expect(
      answerOrderReminder.execute(
        { action: 'close', requestId: PORCELAIN, confirmed: true },
        deps,
        turn(2),
      ),
    ).rejects.toThrow(/не показывали/);
    expect(await isOrderClosed(deps, PORCELAIN)).toBe(false);
  });

  test('уточнить: сотруднику уходит вопрос со списком заявок, ничего не меняется', async () => {
    const before = deps.chat.outboxOf(THREAD).length;
    const result = await answerOrderReminder.execute({ action: 'clarify' }, deps, turn());
    expect(result.status).toBe('clarify_shown');
    const sent = deps.chat.outboxOf(THREAD).slice(before);
    expect(sent).toHaveLength(1);
    const text = sent[0]?.message?.text ?? '';
    expect(text).toContain('фарфоровые конфеты');
    expect(text).toContain('панно с медсестрой');
    expect(await isOrderClosed(deps, PORCELAIN)).toBe(false);
    setNow(MONDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(true);
  });

  test('заявка не из показанных - отказ, состояние не меняется', async () => {
    await deps.requests.save({ ...ORDER_REQUEST, id: 'req-other' });
    await expect(
      answerOrderReminder.execute({ action: 'close', requestId: 'req-other' }, deps, turn()),
    ).rejects.toThrow(/сводк/);
    expect(await isOrderClosed(deps, 'req-other')).toBe(false);
  });

  test('чужой тред: напоминания не было - отказ', async () => {
    const other = bindingThreadId({ botId: BOT, userId: 'other' });
    await expect(
      answerOrderReminder.execute(
        { action: 'close', requestId: PORCELAIN },
        deps,
        turn(1, other),
      ),
    ).rejects.toThrow();
    expect(await isOrderClosed(deps, PORCELAIN)).toBe(false);
  });

  test('напоминание старше окна - отказ', async () => {
    setNow('2026-10-20T05:00:00.000Z');
    await expect(
      answerOrderReminder.execute({ action: 'close', requestId: PORCELAIN }, deps, turn()),
    ).rejects.toThrow(/устар/);
  });

  test('нужные поля: отложить без даты и «позже» без дней - отказ', async () => {
    await expect(
      answerOrderReminder.execute({ action: 'snooze', requestId: PORCELAIN }, deps, turn()),
    ).rejects.toThrow();
    await expect(
      answerOrderReminder.execute({ action: 'remind_later', requestId: PORCELAIN }, deps, turn()),
    ).rejects.toThrow();
    await expect(
      answerOrderReminder.execute({ action: 'close' }, deps, turn()),
    ).rejects.toThrow();
  });

  test('дата в прошлом и слишком далёкая - отказ', async () => {
    for (const untilDate of ['2026-10-12', '2026-10-01', '2027-06-01', '2026-13-45']) {
      await expect(
        answerOrderReminder.execute(
          { action: 'snooze', requestId: PORCELAIN, untilDate },
          deps,
          turn(),
        ),
      ).rejects.toThrow();
    }
  });

  test('плановый запуск без сотрудника в чате - отказ', async () => {
    const scheduled = createToolContext({
      threadId: THREAD,
      agentId: 'test-agent',
      operationId: 'op-sched',
      initiator: { kind: 'scheduler' },
    });
    await expect(
      answerOrderReminder.execute({ action: 'close', requestId: PORCELAIN }, deps, scheduled),
    ).rejects.toThrow();
  });
});

describe('ответ «да, ответили» целиком: модель выбирает, код исполняет', () => {
  test('справка в запросе, действие из списка, на следующий день заявки в сводке нет', async () => {
    await digest();
    setNow(MONDAY_REPLY);
    // Что делает записанная модель: видит справку про фарфоровые конфеты (а не про последнюю
    // заявку «панно») и выбирает «напомнить через 3 дня» именно для неё.
    const script: StepFn = (request, call) => {
      if (call === 0) {
        const seen = JSON.stringify(request.messages);
        expect(seen).toContain(`requestId: ${PORCELAIN}`);
        expect(seen).toContain('да, ответили');
        return callTool('c-reminder', 'answerOrderReminder', {
          action: 'remind_later',
          requestId: PORCELAIN,
          days: 3,
        });
      }
      return say('Хорошо, напомню в четверг');
    };
    const declaration = createOrderCalcAgent({
      model: MODEL_ALIAS,
      dailyDigest: true,
      reminderReply: true,
    });
    const { runtime, spec } = scriptedRuntime(declaration, deps, script);
    // Вне истории: справка идёт системным блоком хода, как её подаёт чат.
    const blocks = await activeRequestBlocks(deps, THREAD);
    const result = await runtime.run(spec, THREAD, 'да, ответили', {
      context: { initiator: { kind: 'user', userId: MAIL_OWNER }, systemContext: blocks },
    });
    expect(result.status).toBe('completed');

    setNow(TUESDAY_DIGEST);
    await digest();
    expect(lastDigestMentions('фарфоровые конфеты')).toBe(false);
    expect(lastDigestMentions('панно с медсестрой')).toBe(true);
  });
});

describe('флаг выключен: прежнее поведение', () => {
  beforeEach(() => {
    delete deps.reminderReply;
  });

  test('сводка ничего не запоминает, блока хода нет, закрытие прежнее', async () => {
    await digest();
    expect(await deps.state.get('order-calc:digest-shown', THREAD)).toBeNull();
    setNow(MONDAY_REPLY);
    expect(await activeRequestBlocks(deps, THREAD)).toEqual([]);
    await expect(
      answerOrderReminder.execute({ action: 'close', requestId: PORCELAIN }, deps, turn()),
    ).rejects.toThrow();
    // Прежний двухшаговый closeOrder работает.
    const shown = await closeOrder.execute({ requestId: PORCELAIN }, deps, turn(1));
    expect(shown.status).toBe('needs_confirmation');
  });

  test('инструмента нет в декларации и промпт не меняется', () => {
    const plain = createOrderCalcAgent({ model: MODEL_ALIAS, dailyDigest: true });
    const off = createOrderCalcAgent({
      model: MODEL_ALIAS,
      dailyDigest: true,
      reminderReply: false,
    });
    expect(off.tools.map((t) => t.name)).toEqual(plain.tools.map((t) => t.name));
    expect(off.prompt).toBe(plain.prompt);
    expect(plain.tools.map((t) => t.name)).not.toContain('answerOrderReminder');
  });

  test('флаг без утренней сводки инструмента не объявляет', () => {
    const declaration = createOrderCalcAgent({ model: MODEL_ALIAS, reminderReply: true });
    expect(declaration.tools.map((t) => t.name)).not.toContain('answerOrderReminder');
  });

  test('флаг включён: инструмент и дополнение промпта', () => {
    const on = createOrderCalcAgent({ model: MODEL_ALIAS, dailyDigest: true, reminderReply: true });
    const plain = createOrderCalcAgent({ model: MODEL_ALIAS, dailyDigest: true });
    expect(on.tools.map((t) => t.name)).toContain('answerOrderReminder');
    expect(on.prompt).toContain('answerOrderReminder');
    expect(plain.prompt).not.toContain('answerOrderReminder');
  });
});

describe('этап 226, ревью: ключи идемпотентности через рантайм', () => {
  const OTHER = 'other';
  const OTHER_THREAD = bindingThreadId({ botId: BOT, userId: OTHER });

  /** Вопросы «по какой заявке», показанные в треде. */
  const questions = (threadId: string): string[] =>
    deps.chat
      .outboxOf(threadId)
      .map((record) => record.message?.text ?? '')
      .filter((text) => text.startsWith('Уточните'));

  async function runAs(
    runtime: ReturnType<typeof scriptedRuntime>,
    threadId: string,
    userId: string,
    text: string,
  ): Promise<void> {
    const result = await runtime.runtime.run(runtime.spec, threadId, text, {
      context: { initiator: { kind: 'user', userId } },
    });
    expect(result.status).toBe('completed');
  }

  test('clarify в двух тредах и повторный clarify в треде - каждый показывает вопрос', async () => {
    await prepared('req-second', 'заказ второго сотрудника', { owner: OTHER });
    await digest();
    setNow(MONDAY_REPLY);
    const steps: Step[] = [];
    for (let index = 0; index < 3; index += 1) {
      steps.push(callTool(`c-${index}`, 'answerOrderReminder', { action: 'clarify' }));
      steps.push(say('Спросила'));
    }
    const declaration = createOrderCalcAgent({
      model: MODEL_ALIAS,
      dailyDigest: true,
      reminderReply: true,
    });
    const scripted = scriptedRuntime(declaration, deps, steps);
    await runAs(scripted, THREAD, MAIL_OWNER, 'да');
    await runAs(scripted, OTHER_THREAD, OTHER, 'да');
    await runAs(scripted, THREAD, MAIL_OWNER, 'ну да, ответили');
    expect(questions(THREAD)).toHaveLength(2);
    expect(questions(OTHER_THREAD)).toHaveLength(1);
    expect(questions(OTHER_THREAD)[0]).toContain('заказ второго сотрудника');
    expect(questions(OTHER_THREAD)[0]).not.toContain('фарфоровые конфеты');
  });
});

describe('этап 226, ревью: справка и допустимые заявки', () => {
  const MANAGER = bindingThreadId({ botId: BOT, userId: 'boss' });

  test('заявка чужого сотрудника в справку и в clarify не попадает', async () => {
    await digest();
    await saveSent(deps, {
      requestId: PANEL,
      supplierIds: ['s1'],
      sentAt: WEDNESDAY_SENT,
      sentBySupplier: { s1: WEDNESDAY_SENT },
      mailboxOwnerId: 'other',
      state: 'prepared',
    });
    setNow(MONDAY_REPLY);
    const text = await blocksText();
    expect(text).toContain('фарфоровые конфеты');
    expect(text).not.toContain('панно с медсестрой');
    const before = deps.chat.outboxOf(THREAD).length;
    await answerOrderReminder.execute({ action: 'clarify' }, deps, turn());
    const asked = deps.chat.outboxOf(THREAD).slice(before)[0]?.message?.text ?? '';
    expect(asked).toContain('фарфоровые конфеты');
    expect(asked).not.toContain('панно с медсестрой');
  });

  test('тред менеджера: заявки не его - справки с действиями нет', async () => {
    await recordDigestShown(deps, MANAGER, {
      dateKey: '2026-10-09',
      at: FRIDAY_DIGEST,
      orders: [{ requestId: PORCELAIN, label: 'фарфоровые конфеты', listed: true }],
    });
    setNow(MONDAY_REPLY);
    expect(await blocksText(MANAGER)).toBe('');
  });

  test('старые заявки («старше N дней») тоже допустимы как показанные', async () => {
    await prepared('req-stale', 'старая заявка', { sentAt: '2026-09-01T10:00:00.000Z' });
    await digest();
    expect(digests().at(-1)).toContain('старше');
    setNow(MONDAY_REPLY);
    expect(await blocksText()).toContain('requestId: req-stale');
    const result = await answerOrderReminder.execute(
      { action: 'remind_later', requestId: 'req-stale', days: 3 },
      deps,
      turn(),
    );
    expect(result.status).toBe('snoozed');
  });

  test('заявки нет в репозитории - отказ до действия, отметка не пишется', async () => {
    await recordDigestShown(deps, THREAD, {
      dateKey: '2026-10-09',
      at: FRIDAY_DIGEST,
      orders: [{ requestId: 'req-ghost', label: 'призрак', listed: true }],
    });
    setNow(MONDAY_REPLY);
    await expect(
      answerOrderReminder.execute(
        { action: 'remind_later', requestId: 'req-ghost', days: 2 },
        deps,
        turn(),
      ),
    ).rejects.toThrow(/не найдена/);
    expect(await deps.state.get('order-calc:reminder-snooze', 'req-ghost')).toBeNull();
  });
});

describe('этап 226, ревью: сбой справки, сводка, даты', () => {
  test('сбой чтения справки не убивает блок активной заявки', async () => {
    await digest();
    await setActiveRequest(deps, THREAD, PANEL);
    setNow(MONDAY_REPLY);
    const events: string[] = [];
    deps.log = (event) => {
      events.push(event);
    };
    const original = deps.state;
    deps.state = new Proxy(original, {
      get(target, property) {
        if (property === 'get') {
          return async (namespace: string, key: string) => {
            if (namespace === 'order-calc:digest-shown') throw new Error('сбой хранилища');
            return target.get(namespace, key);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const blocks = await activeRequestBlocks(deps, THREAD);
    expect(blocks.map((block) => block.id)).toEqual(['active_request']);
    expect(events).toContain('order_reminder_context_failed');
  });

  test('отложенная заявка не мешает чтению почты: письмо поставщика обработано', async () => {
    await digest();
    await closeOrderRecord(deps, PANEL, MAIL_OWNER);
    setNow(MONDAY_REPLY);
    await answerOrderReminder.execute(
      { action: 'remind_later', requestId: PORCELAIN, days: 3 },
      deps,
      turn(),
    );
    deps.mailboxes.deliver(MAIL_OWNER, {
      id: 'mail-snoozed',
      from: 'sales@metall.test',
      subject: `КП ${requestTag(PORCELAIN)}`,
      body: 'Цена 50',
      receivedAt: '2026-10-12T02:00:00.000Z',
      attachments: [],
      senderAuth: 'verified',
    });
    const sentBefore = digests().length;
    setNow(MONDAY_DIGEST);
    await digest();
    // Заявки в сводке нет (других открытых нет - сообщения нет), но почта прочитана.
    expect(digests()).toHaveLength(sentBefore);
    expect(deps.mailboxes.processedIds(MAIL_OWNER)).toEqual(['mail-snoozed']);
  });

  test('дата напоминания на выходной сдвигается на рабочий день и называется', async () => {
    await digest();
    setNow(MONDAY_REPLY);
    const saturday = await answerOrderReminder.execute(
      { action: 'snooze', requestId: PORCELAIN, untilDate: '2026-10-17' },
      deps,
      turn(),
    );
    expect(saturday.untilDate).toBe('2026-10-19');
    expect(saturday.message).toContain('19.10');
    const sunday = await answerOrderReminder.execute(
      { action: 'snooze', requestId: PANEL, untilDate: '2026-10-18' },
      deps,
      turn(),
    );
    expect(sunday.untilDate).toBe('2026-10-19');
    const later = await answerOrderReminder.execute(
      { action: 'remind_later', requestId: PORCELAIN, days: 5 },
      deps,
      turn(2),
    );
    expect(later.untilDate).toBe('2026-10-19');
    const weekday = await answerOrderReminder.execute(
      { action: 'snooze', requestId: PANEL, untilDate: '2026-10-14' },
      deps,
      turn(3),
    );
    expect(weekday.untilDate).toBe('2026-10-14');
  });

  test('повтор прогона сводки в тот же день запись о показанном не перезаписывает', async () => {
    await digest();
    const first = (await deps.state.get('order-calc:digest-shown', THREAD)) as { at: string };
    // Повтор после частичного сбоя: слот дня не поставлен, сообщения ушли ключами.
    const slot = monitoringKey.slot('orders-digest', '2026-10-09');
    await deps.state.delete(MONITORING_NAMESPACE, slot);
    setNow('2026-10-09T08:00:00.000Z');
    await digest();
    const second = (await deps.state.get('order-calc:digest-shown', THREAD)) as { at: string };
    expect(second.at).toBe(first.at);
  });

  test('сбой записи справки - warning, а не serious', () => {
    expect(EVENT_SEVERITY['order_digest_shown_failed']).toBe('warning');
    expect(EVENT_SEVERITY['order_reminder_context_failed']).toBe('warning');
  });
});
