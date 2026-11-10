import { describe, expect, jest, test } from 'bun:test';
import {
  MAIL_CURSOR_NAMESPACE,
  MAIL_NAMESPACE,
  MAIL_TRIGGER_NAMESPACE,
  PRICES_AGENT_ID,
  TRIGGER_CURSOR_NAMESPACE,
} from '../../src/agents/prices/deps';
import { MONITORING_NAMESPACE, monitoringKey, recordEmployeeContact } from '@business-ai/core';
import { readPriceMail } from '../../src/agents/prices/price-mail';
import { runPriceMailTriggers } from '../../src/agents/prices/price-mail-triggers';
import { FixedClock, MemoryAccessPolicy } from '@business-ai/adapters';
import { MemoryPriceMailAssessor } from '../../src/kit/adapters/memory/price-mail-assessor';
import { DAY_MS, HOUR_MS } from '../../src/kit/domain/time';
import { DomainError } from '@business-ai/core';
import type { InboxMessage } from '@business-ai/core';
import type { PriceMailAssessor } from '../../src/kit/ports/price-mail-assessor';
import {
  SECOND_SUPPLIER_EMAIL,
  SUPPLIER_EMAIL,
  USER_1,
  USER_2,
  USER_NO_MAILBOX,
  USER_THREAD_1,
  USER_THREAD_2,
  USER_THREAD_3,
  buildMailboxPricesDeps,
  encode,
} from './prices-support';
import {
  BUSINESS_ZONE,
  MONDAY_NOON,
  PRICES_BOT_ID,
  buildTriggerDeps,
  ctxOf,
  triggerMail,
} from './prices-trigger-support';

/** Сколько раз уступить очереди микрозадач, пока прогон дойдёт до вызова оценщика. */
const MICROTASK_TURNS = 1_000;
const OPTIONS = { timezone: BUSINESS_ZONE };
const SLOT_KEY = monitoringKey.slot('price-mail-triggers', '2026-10-12');

describe('просмотр писем с триггерами', () => {
  test('письмо поставщика с триггером: одно сообщение шаблоном кода без кнопок', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ status: 'done', employees: 2, notified: 1 });
    expect(deps.chat.outbox).toHaveLength(1);
    const sent = deps.chat.outbox[0];
    expect(sent?.threadId).toBe(USER_THREAD_1);
    expect(sent?.message?.text).toBe(
      'Письмо от поставщика «МеталлТорг»: тема «Повышение цен с 1 ноября», ' +
        'получено 11.10.2026 13:00. Найдено: повышение цен.',
    );
    // Готового «обновления прайса» агент не предлагает: кнопок нет.
    expect(sent?.message?.buttons ?? []).toEqual([]);
  });

  test('письмо не помечается обработанным и не сохраняется как прайс', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);
    expect(await deps.state.list(MAIL_NAMESPACE, null, 10)).toEqual([]);
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toBeNull();
  });

  test('запись об уведомлении без текстов и адресов', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1', { subject: 'Повышение цен секретно' }));
    await runPriceMailTriggers(deps, OPTIONS);
    const entries = await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10);
    expect(entries).toHaveLength(1);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain('секретно');
    expect(dump).not.toContain(SUPPLIER_EMAIL);
    expect(dump).not.toContain(USER_THREAD_1);
    expect(Object.keys((entries[0]?.value ?? {}) as object).sort()).toEqual([
      'createdAt',
      'messageId',
      'notifiedAt',
      'token',
      'userId',
    ]);
  });

  test('письмо не от поставщика не попадает в уведомление и не сохраняется', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', { from: 'friend@private.example', subject: 'Повышение цен' }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result.notified).toBe(0);
    expect(result.skippedForeign).toBe(1);
    expect(deps.chat.outbox).toEqual([]);
    expect(await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10)).toEqual([]);
    expect(await deps.state.list(MAIL_NAMESPACE, null, 10)).toEqual([]);
  });

  test('отправитель не подтверждён: письмо поставщика читается и уведомляет', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1', { senderAuth: 'unverified' }));
    deps.mailboxes.deliver(USER_1, triggerMail('m2', { senderAuth: undefined as never }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result.notified).toBe(2);
    expect(result.skippedForeign).toBe(0);
  });

  test('письмо поставщика без триггера не даёт уведомления', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1', { subject: 'Счёт 123', body: 'Оплатите' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, noTrigger: 1 });
  });

  test('триггер во вложении: «Прайс_2026.xlsx»', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', {
        subject: 'Документы',
        body: 'Во вложении',
        attachments: [{ fileName: 'Прайс_2026.xlsx', mimeType: 'x', bytes: encode('1') }],
      }),
    );
    await runPriceMailTriggers(deps, OPTIONS);
    expect(deps.chat.outbox[0]?.message?.text).toContain('Найдено: новый прайс.');
  });

  test('тема очищается от управляющих символов и обрезается до 200 знаков', async () => {
    const deps = await buildTriggerDeps();
    const subject = `Повышение цен\r\nBcc: x\u0007${'я'.repeat(400)}`;
    deps.mailboxes.deliver(USER_1, triggerMail('m1', { subject }));
    await runPriceMailTriggers(deps, OPTIONS);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).not.toMatch(/[\u0000-\u001f]/);
    const shown = /тема «([^»]*)»/.exec(text)?.[1] ?? '';
    expect(shown.length).toBe(200);
    expect(shown.startsWith('Повышение цен Bcc: x')).toBe(true);
  });

  test('два сотрудника получают каждый своё в своём треде', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    deps.mailboxes.deliver(
      USER_2,
      triggerMail('m1', { from: SECOND_SUPPLIER_EMAIL, subject: 'Новый прайс-лист' }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result.notified).toBe(2);
    const byThread = new Map(deps.chat.outbox.map((o) => [o.threadId, o.message]));
    expect(byThread.get(USER_THREAD_1)?.text).toContain('«МеталлТорг»');
    expect(byThread.get(USER_THREAD_1)?.text).toContain('повышение цен');
    expect(byThread.get(USER_THREAD_2)?.text).toContain('«Болтик»');
    expect(byThread.get(USER_THREAD_2)?.text).toContain('новый прайс');
    // Одинаковый id письма в двух ящиках: токены разные.
    const keys = (await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10)).map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });

  test('повтор задачи (слот потерян) не дублирует уведомление', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(deps.chat.outbox).toHaveLength(1);
    // Тот же день: слот стоит, второй запуск ничего не делает.
    expect((await runPriceMailTriggers(deps, OPTIONS)).status).toBe('not_due');
    // Через 3 суток курсор потерян (откат состояния): письмо видно снова, токен уже известен.
    deps.clock.advance(3 * DAY_MS);
    await deps.state.put(TRIGGER_CURSOR_NAMESPACE, USER_1, { cursor: '' });
    const again = await runPriceMailTriggers(deps, OPTIONS);
    expect(again).toMatchObject({ status: 'done', notified: 0, duplicates: 1 });
    expect(deps.chat.outbox).toHaveLength(1);
  });

  test('сбой отправки: запуск падает, слота нет, повтор шлёт ровно одно сообщение', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const realReply = deps.chat.reply.bind(deps.chat);
    let failures = 1;
    deps.chat.reply = async (threadId, message, key) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('канал недоступен');
      }
      await realReply(threadId, message, key);
    };
    await expect(runPriceMailTriggers(deps, OPTIONS)).rejects.toThrow('канал недоступен');
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).toBeNull();
    const retry = await runPriceMailTriggers(deps, OPTIONS);
    expect(retry).toMatchObject({ status: 'done', notified: 1 });
    expect(deps.chat.outbox).toHaveLength(1);
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).not.toBeNull();
  });

  test('сбой одного ящика не мешает остальным', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_2, triggerMail('m2'));
    const realFor = deps.mailboxes.forEmployee.bind(deps.mailboxes);
    deps.mailboxes.forEmployee = async (userId) => {
      if (userId === USER_1) throw new Error('ящик недоступен');
      return realFor(userId);
    };
    await expect(runPriceMailTriggers(deps, OPTIONS)).rejects.toThrow('ящик недоступен');
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([USER_THREAD_2]);
  });
});

describe('время запуска и курсор', () => {
  test('до часа проверки по поясу бизнеса - не время, слот не ставится', async () => {
    const deps = await buildTriggerDeps(new Date('2026-10-12T05:00:00.000Z')); // 08:00 МСК
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    expect((await runPriceMailTriggers(deps, OPTIONS)).status).toBe('not_due');
    expect(deps.chat.outbox).toEqual([]);
    // В поясе Екатеринбурга (UTC+5) в этот момент уже 10:00.
    const ekb = await runPriceMailTriggers(deps, { timezone: 'Asia/Yekaterinburg' });
    expect(ekb.status).toBe('done');
    expect(deps.chat.outbox).toHaveLength(1);
  });

  test('после проверки мониторинг ждёт 3 суток; новое письмо уходит, старое - нет', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(deps.chat.outbox).toHaveLength(1);
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m2', { subject: 'Изменение цен', receivedAt: '2026-10-13T09:00:00.000Z' }),
    );
    deps.clock.advance(2 * DAY_MS);
    expect((await runPriceMailTriggers(deps, OPTIONS)).status).toBe('not_due');
    deps.clock.advance(DAY_MS);
    const third = await runPriceMailTriggers(deps, OPTIONS);
    expect(third).toMatchObject({ status: 'done', notified: 1, duplicates: 0 });
    expect(deps.chat.outbox).toHaveLength(2);
    expect(deps.chat.outbox[1]?.message?.text).toContain('изменение цен');
  });

  test('курсор на ящик: свой у каждого, отдельный от курсора разбора прайсов', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('a1'));
    deps.mailboxes.deliver(USER_1, triggerMail('a2', { subject: 'Счёт' }));
    deps.mailboxes.deliver(USER_2, triggerMail('b1', { subject: 'Счёт' }));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '2' });
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_2)).toEqual({ cursor: '1' });
    // Разбор прайсов (readPriceMail) своего курсора не сдвинут просмотром триггеров.
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toBeNull();
    await readPriceMail.execute({}, deps, ctxOf(USER_1, USER_THREAD_1));
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '2' });
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);
  });

  test('старые письма пропускаются, курсор сдвигается', async () => {
    const deps = await buildTriggerDeps();
    const old: InboxMessage = triggerMail('old', {
      receivedAt: new Date(deps.clock.now().getTime() - 8 * DAY_MS - HOUR_MS).toISOString(),
    });
    deps.mailboxes.deliver(USER_1, old);
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, skippedOld: 1 });
    // Уведомления сотрудникам не уходят; ответственному - одно сообщение о пропуске по сроку.
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([lagThread(deps)]);
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '1' });
  });
});

describe('сотрудники и ящики', () => {
  test('сотрудник реестра без ящика в просмотр не попадает', async () => {
    const deps = await buildTriggerDeps();
    await recordEmployeeContact(
      deps.state,
      deps.clock,
      { threadId: USER_THREAD_3, userId: USER_NO_MAILBOX },
      PRICES_AGENT_ID,
    );
    deps.mailboxes.deliver(USER_2, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ status: 'done', employees: 2, notConnected: 0, notified: 1 });
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_NO_MAILBOX)).toBeNull();
  });

  test('ящик из списка каталога не подключён: сотрудник пропускается, остальные идут', async () => {
    const deps = await buildTriggerDeps();
    const real = deps.mailboxes;
    // Каталог называет сотрудника, ящик которого при обращении оказался не подключён.
    const directory = {
      forEmployee: (userId: string) => real.forEmployee(userId),
      employeeIds: () => [...(real.employeeIds?.() ?? []), USER_NO_MAILBOX],
    };
    await recordEmployeeContact(
      deps.state,
      deps.clock,
      { threadId: USER_THREAD_3, userId: USER_NO_MAILBOX },
      PRICES_AGENT_ID,
    );
    real.deliver(USER_2, triggerMail('m1'));
    const result = await runPriceMailTriggers({ ...deps, mailboxes: directory }, OPTIONS);
    expect(result).toMatchObject({ status: 'done', employees: 3, notConnected: 1, notified: 1 });
  });

  test('без ящиков сотрудников: not_configured, слот не ставится', async () => {
    const deps = await buildTriggerDeps();
    const result = await runPriceMailTriggers({ ...deps, mailboxes: undefined }, OPTIONS);
    expect(result.status).toBe('not_configured');
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).toBeNull();
  });

  test('сотрудники других агентов в просмотр не попадают', async () => {
    const deps = await buildTriggerDeps();
    await recordEmployeeContact(
      deps.state,
      deps.clock,
      { threadId: 'other-thread', userId: 'u9' },
      'order-calc',
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result.employees).toBe(2);
  });

  test('владелец ящика без своего треда: письмо не уходит ответственному', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.connect('owner', 'owner@company.test');
    deps.mailboxes.deliver('owner', triggerMail('m1'));
    const result = await runPriceMailTriggers({ ...deps, mailboxOwnerUserId: 'owner' }, OPTIONS);
    expect(result).toMatchObject({ employees: 2, notified: 0, skippedNoThread: 1 });
    expect(deps.chat.outbox).toEqual([]);
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, 'owner')).toBeNull();
  });

  test('владелец общего ящика со своим тредом получает уведомление в нём', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.connect('owner', 'owner@company.test');
    deps.mailboxes.deliver('owner', triggerMail('m1'));
    await recordEmployeeContact(
      deps.state,
      deps.clock,
      { threadId: USER_THREAD_3, userId: 'owner' },
      PRICES_AGENT_ID,
    );
    const result = await runPriceMailTriggers({ ...deps, mailboxOwnerUserId: 'owner' }, OPTIONS);
    expect(result).toMatchObject({ employees: 3, notified: 1, skippedNoThread: 0 });
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([USER_THREAD_3]);
  });
});

describe('пустой реестр обращений', () => {
  test('слот не закрывается, после обращения сотрудника просмотр идёт', async () => {
    const base = await buildMailboxPricesDeps();
    const deps = { ...base, clock: new FixedClock(MONDAY_NOON) };
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const first = await runPriceMailTriggers(deps, OPTIONS);
    expect(first).toMatchObject({ status: 'done', employees: 0, notified: 0 });
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).toBeNull();
    expect(deps.chat.outbox).toEqual([]);

    await recordEmployeeContact(
      deps.state,
      deps.clock,
      { threadId: USER_THREAD_1, userId: USER_1, botId: PRICES_BOT_ID },
      PRICES_AGENT_ID,
    );
    const second = await runPriceMailTriggers(deps, OPTIONS);
    expect(second).toMatchObject({ status: 'done', employees: 1, notified: 1 });
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([USER_THREAD_1]);
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).not.toBeNull();
  });
});

describe('запись уведомления', () => {
  test('одно письмо - одно уведомление, старая запись с лишними полями читается', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    expect((await runPriceMailTriggers(deps, OPTIONS)).notified).toBe(1);
    const [entry] = await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10);
    // Запись прежней версии (кнопки): лишние поля читаются и дубль не создают.
    await deps.state.put(MAIL_TRIGGER_NAMESPACE, entry?.key ?? '', {
      ...(entry?.value as object),
      threadId: USER_THREAD_1,
      pressedAt: '2026-10-11T10:00:00.000Z',
    });
    await deps.state.delete(MONITORING_NAMESPACE, SLOT_KEY);
    await deps.state.delete(MONITORING_NAMESPACE, 'last:price-mail-triggers');
    await deps.state.delete(TRIGGER_CURSOR_NAMESPACE, USER_1);
    const again = await runPriceMailTriggers(deps, OPTIONS);
    expect(again).toMatchObject({ notified: 0, duplicates: 1 });
    expect(deps.chat.outbox).toHaveLength(1);
  });
});

/** Тред, куда уходит сообщение ответственному об отставании просмотра. */
function lagThread(deps: { responsibleThreadId?: string; managerThreadId: string }): string {
  return deps.responsibleThreadId ?? deps.managerThreadId;
}

describe('R6-01-01: недоступный по паролю ящик не оставляет слот открытым', () => {
  test('auth_failed у одного: остальные обработаны, слот закрыт, исключения нет', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_2, triggerMail('m2'));
    const realFor = deps.mailboxes.forEmployee.bind(deps.mailboxes);
    let calls = 0;
    deps.mailboxes.forEmployee = async (userId) => {
      if (userId === USER_1) {
        calls += 1;
        throw new DomainError('external_failure', 'пароль не принят', { retryable: false });
      }
      return realFor(userId);
    };
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ status: 'done', failed: 1, notified: 1 });
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).not.toBeNull();
    // Слот закрыт: следующий тик ящики не обходит.
    deps.clock.advance(15 * 60_000);
    expect((await runPriceMailTriggers(deps, OPTIONS)).status).toBe('not_due');
    expect(calls).toBe(1);
  });
});

describe('R6-06-03: отставание просмотра не прекращает уведомления молча', () => {
  test('больше 1000 писем читаются за один запуск, пока бюджет времени не исчерпан', async () => {
    const deps = await buildTriggerDeps();
    for (let i = 1; i <= 1100; i += 1) {
      deps.mailboxes.deliver(USER_1, triggerMail(`b${i}`, { subject: 'Счёт', body: 'Оплата' }));
    }
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ status: 'done', noTrigger: 1100 });
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '1100' });
  });

  test('бюджет времени исчерпан: слот открыт, сообщение, повтор дочитывает', async () => {
    const deps = await buildTriggerDeps();
    for (let i = 1; i <= 200; i += 1) {
      deps.mailboxes.deliver(USER_1, triggerMail(`b${i}`, { subject: 'Счёт', body: 'Оплата' }));
    }
    const box = await deps.mailboxes.forEmployee(USER_1);
    const realFetch = box.fetchNew.bind(box);
    // Каждая страница «занимает» две минуты: после третьей бюджет в 5 минут исчерпан.
    box.fetchNew = async (cursor, limit, options) => {
      deps.clock.advance(2 * 60_000);
      return realFetch(cursor, limit, options);
    };
    const first = await runPriceMailTriggers(deps, OPTIONS);
    // Второй сотрудник бюджета уже не застал: его ящик тоже ждёт следующего тика.
    expect(first).toMatchObject({ status: 'done', lagging: 2 });
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).toBeNull();
    const notices = deps.chat.outbox.filter((o) => o.threadId === lagThread(deps));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message?.text ?? '').not.toContain('@');
    // Повтор на следующем тике продолжает с курсора и закрывает слот.
    box.fetchNew = realFetch;
    const second = await runPriceMailTriggers(deps, OPTIONS);
    expect(second).toMatchObject({ status: 'done', lagging: 0 });
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '200' });
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).not.toBeNull();
  });

  test('проход просит содержимое писем от любых отправителей', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const box = await deps.mailboxes.forEmployee(USER_1);
    const realFetch = box.fetchNew.bind(box);
    const seen: Array<boolean | undefined> = [];
    // Память опцию не исполняет, поэтому проверяется сам запрос: без флага боевой адаптер
    // отдаёт письма чужих адресов без текста, и название поставщика в них не находится.
    box.fetchNew = async (cursor, limit, options) => {
      seen.push(options?.anySender);
      return realFetch(cursor, limit, options);
    };
    await runPriceMailTriggers(deps, OPTIONS);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((flag) => flag === true)).toBe(true);
  });

  test('письма старше срока: сообщение ответственному один раз за день', async () => {
    const deps = await buildTriggerDeps();
    const old = new Date(deps.clock.now().getTime() - 9 * DAY_MS).toISOString();
    deps.mailboxes.deliver(USER_1, triggerMail('old1', { receivedAt: old }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result.skippedOld).toBe(1);
    const notices = deps.chat.outbox.filter((o) => o.threadId === lagThread(deps));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message?.text ?? '').toContain('1');
  });
});

describe('R6-03-03: получатели фильтруются по политике доступа', () => {
  test('сотрудник без права на агента «Актуализация прайса (ИИ агент)» уведомления не ' +
    'получает', async () => {
    const deps = await buildTriggerDeps();
    const access = new MemoryAccessPolicy();
    access.allow({ userId: USER_2, botId: PRICES_AGENT_ID, action: 'chat.message' });
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    deps.mailboxes.deliver(USER_2, triggerMail('m2'));
    const result = await runPriceMailTriggers({ ...deps, access }, OPTIONS);
    expect(result).toMatchObject({ employees: 1, notified: 1, skippedDenied: 1 });
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([USER_THREAD_2]);
    // Ящик отказанного не читался: курсор не создан.
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toBeNull();
  });
});

describe('R7-05: письмо поставщика без содержимого не теряется', () => {
  test('too_large: триггер находится по теме и именам вложений', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', {
        subject: 'Документы',
        body: '',
        contentOmitted: 'too_large',
        attachmentNames: ['Прайс_2026.xlsx'],
      }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, noTrigger: 0 });
    expect(deps.chat.outbox[0]?.message?.text).toContain('Найдено: новый прайс.');
  });

  test('содержимое пропущено, триггера нет: уведомление «без содержимого»', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', { subject: 'Письмо', body: '', contentOmitted: 'parse_failed' }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, noTrigger: 0 });
    const sent = deps.chat.outbox[0];
    expect(sent?.threadId).toBe(USER_THREAD_1);
    expect(sent?.message?.text).toContain('Получено письмо без содержимого от поставщика');
    expect(sent?.message?.text).toContain('тема «Письмо»');
    // В записи об уведомлении темы нет (только идентификаторы).
    expect(JSON.stringify(await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10))).not.toContain(
      'Письмо',
    );
  });

  test('allowlist_unavailable: курсор не двигается, слот дня не закрывается', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', { body: '', subject: 'Письмо', contentOmitted: 'allowlist_unavailable' }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result.notified).toBe(0);
    expect(deps.chat.outbox).toEqual([]);
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, USER_1)).toBeNull();
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).toBeNull();
  });
});


/** Оценщик, который падает с текстом, похожим на фрагмент письма. */
function failingAssessor(message: string): PriceMailAssessor & { calls: number } {
  return {
    calls: 0,
    async assess() {
      this.calls += 1;
      throw new Error(message);
    },
  };
}

describe('оценка письма моделью поверх кодового фильтра', () => {
  test('без оценщика уведомляет один кодовый фильтр', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, assessedNotRelevant: 0, assessorFailed: 0 });
  });

  test('оценщик вызывается только для писем, прошедших кодовый фильтр', async () => {
    const assessor = new MemoryPriceMailAssessor();
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, triggerMail('relevant'));
    // Не поставщик, письмо без признака, пропуск содержимого; неподтверждённый отправитель не
    // помеха (подлинность не проверяется).
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('foreign', { from: 'friend@private.example', subject: 'Повышение цен' }),
    );
    deps.mailboxes.deliver(USER_1, triggerMail('unverified', { senderAuth: 'unverified' }));
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('plain', { subject: 'Акт сверки', body: 'Во вложении акт.' }),
    );
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('omitted', { subject: 'Письмо', body: '', contentOmitted: 'parse_failed' }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(assessor.calls).toBe(2);
    expect(result.notified).toBe(3);
  });

  test('оценщику уходят тема, текст, вложения и коды признаков, адреса нет', async () => {
    const seen: string[] = [];
    const assessor = new MemoryPriceMailAssessor((input) => {
      seen.push(JSON.stringify(input));
      return { verdict: 'relevant', reason: 'price_change_announced' };
    });
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Повышение цен с 1 ноября');
    expect(seen[0]).toContain('price_increase');
    expect(seen[0]).not.toContain(SUPPLIER_EMAIL);
  });

  test('not_relevant гасит уведомление, повтор просмотра не зовёт оценщика снова', async () => {
    const assessor = new MemoryPriceMailAssessor(() => ({
      verdict: 'not_relevant',
      reason: 'newsletter',
    }));
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, assessedNotRelevant: 1, assessorFailed: 0 });
    expect(deps.chat.outbox).toEqual([]);
    const [entry] = await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10);
    expect(entry?.value).toHaveProperty('suppressedAt');
    expect(entry?.value).not.toHaveProperty('notifiedAt');
    // Повторный просмотр того же письма (слот и граница сброшены, курсор потерян).
    await deps.state.delete(MONITORING_NAMESPACE, SLOT_KEY);
    await deps.state.delete(MONITORING_NAMESPACE, 'last:price-mail-triggers');
    await deps.state.delete(TRIGGER_CURSOR_NAMESPACE, USER_1);
    const again = await runPriceMailTriggers(deps, OPTIONS);
    expect(again).toMatchObject({ notified: 0, duplicates: 1 });
    expect(assessor.calls).toBe(1);
  });

  test('сбой оценщика: откат к уведомлению, текст ошибки нигде не виден', async () => {
    const leaked = 'СЕКРЕТНАЯ_ТЕМА_ИЗ_ПИСЬМА';
    const assessor = failingAssessor(`модель вернула: ${leaked}`);
    const logged: string[] = [];
    const deps = {
      ...(await buildTriggerDeps()),
      mailAssessor: assessor,
      log: (event: string, fields?: Record<string, string | number | boolean>) => {
        logged.push(JSON.stringify([event, fields]));
      },
    };
    deps.mailboxes.deliver(USER_1, triggerMail('m1', { subject: 'Повышение цен' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, assessorFailed: 1, assessedNotRelevant: 0 });
    expect(deps.chat.outbox).toHaveLength(1);
    expect(assessor.calls).toBe(1);
    expect(logged.join('')).toContain('price_mail_assess_failed');
    expect(logged.join('')).not.toContain(leaked);
    expect(logged.join('')).not.toContain('Повышение цен');
    const stored = JSON.stringify(await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10));
    expect(stored).not.toContain(leaked);
  });

  test('оценщику передаётся сигнал отмены; по таймауту он срабатывает', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const assessor: PriceMailAssessor = {
        assess: (_input, { signal }) => {
          signals.push(signal);
          return new Promise(() => {});
        },
      };
      const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
      deps.mailboxes.deliver(USER_1, triggerMail('m1'));
      const running = runPriceMailTriggers(deps, OPTIONS);
      // Пока прогон дойдёт до оценщика, нужно несколько микрозадач; затем таймер срабатывает.
      for (let i = 0; i < MICROTASK_TURNS && signals.length === 0; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(31_000);
      const result = await running;
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(result).toMatchObject({ notified: 1, assessorFailed: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('бюджет времени проверяется перед каждым письмом, не только между страницами', async () => {
    const deps = await buildTriggerDeps();
    const assessor = new MemoryPriceMailAssessor();
    for (let i = 1; i <= 5; i += 1) {
      deps.mailboxes.deliver(USER_1, triggerMail(`m${i}`, { subject: `Повышение цен ${i}` }));
    }
    // Каждая оценка «занимает» две минуты: после третьей бюджет в 5 минут исчерпан.
    const slow: PriceMailAssessor = {
      assess: (input, options) => {
        deps.clock.advance(2 * 60_000);
        return assessor.assess(input, options);
      },
    };
    const result = await runPriceMailTriggers({ ...deps, mailAssessor: slow }, OPTIONS);
    expect(assessor.calls).toBe(3);
    expect(result).toMatchObject({ notified: 3, lagging: 2 });
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).toBeNull();
  });

  test('неверный ответ оценщика считается сбоем: уведомление уходит', async () => {
    const assessor = {
      async assess() {
        return { verdict: 'maybe', reason: 'who_knows' };
      },
    } as unknown as PriceMailAssessor;
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, assessorFailed: 1 });
  });

  test('в итоге запуска, записях и сообщении нет текстов письма', async () => {
    const assessor = new MemoryPriceMailAssessor(() => ({
      verdict: 'not_relevant',
      reason: 'unrelated_mention',
    }));
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', { subject: 'Повышение цен ТАЙНА', body: 'Тело ТАЙНА-ТЕЛО' }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    const records = await deps.state.list(MAIL_TRIGGER_NAMESPACE, null, 10);
    const dump = JSON.stringify(result) + JSON.stringify(records);
    expect(dump).not.toContain('ТАЙНА');
    expect(dump).not.toContain(SUPPLIER_EMAIL);
  });
});

describe('ящики всех подключённых сотрудников (реестр обращений не условие)', () => {
  const NEWCOMER = 'u77';
  const NEWCOMER_ADDRESS = 'newcomer@company.test';

  test('сотрудник, ни разу не писавший боту: тред связки строится по его id', async () => {
    const deps = { ...(await buildTriggerDeps()), botId: PRICES_BOT_ID };
    deps.mailboxes.connect(NEWCOMER, NEWCOMER_ADDRESS);
    deps.mailboxes.deliver(NEWCOMER, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ status: 'done', employees: 3, notified: 1 });
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([`${PRICES_BOT_ID}/${NEWCOMER}`]);
  });

  test('пустой реестр: просмотр идёт сразу и слот дня закрывается', async () => {
    const base = await buildMailboxPricesDeps();
    const deps = { ...base, clock: new FixedClock(MONDAY_NOON), botId: PRICES_BOT_ID };
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ status: 'done', employees: 2, notified: 1 });
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([`${PRICES_BOT_ID}/${USER_1}`]);
    expect(await deps.state.get(MONITORING_NAMESPACE, SLOT_KEY)).not.toBeNull();
  });

  test('известный тред из реестра главнее построенного по id', async () => {
    const deps = { ...(await buildTriggerDeps()), botId: PRICES_BOT_ID };
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([USER_THREAD_1]);
  });

  test('без права по политике доступа новый сотрудник не уведомляется и не читается', async () => {
    const deps = { ...(await buildTriggerDeps()), botId: PRICES_BOT_ID };
    deps.mailboxes.connect(NEWCOMER, NEWCOMER_ADDRESS);
    deps.mailboxes.deliver(NEWCOMER, triggerMail('m1'));
    const access = new MemoryAccessPolicy();
    access.allow({ userId: USER_1, botId: PRICES_AGENT_ID, action: 'chat.message' });
    access.allow({ userId: USER_2, botId: PRICES_AGENT_ID, action: 'chat.message' });
    const result = await runPriceMailTriggers({ ...deps, access }, OPTIONS);
    expect(result).toMatchObject({ employees: 2, notified: 0, skippedDenied: 1 });
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, NEWCOMER)).toBeNull();
  });

  test('ключа бота нет и в реестре нет: ящик пропускается без чтения', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.connect(NEWCOMER, NEWCOMER_ADDRESS);
    deps.mailboxes.deliver(NEWCOMER, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ employees: 2, notified: 0 });
    expect(deps.chat.outbox).toEqual([]);
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, NEWCOMER)).toBeNull();
  });

  test('владелец общего ящика без реестра получает уведомление в треде по id', async () => {
    const deps = { ...(await buildTriggerDeps()), botId: PRICES_BOT_ID };
    deps.mailboxes.connect('owner', 'owner@company.test');
    deps.mailboxes.deliver('owner', triggerMail('m1'));
    const result = await runPriceMailTriggers({ ...deps, mailboxOwnerUserId: 'owner' }, OPTIONS);
    expect(result).toMatchObject({ employees: 3, notified: 1, skippedNoThread: 0 });
    expect(deps.chat.outbox.map((o) => o.threadId)).toEqual([`${PRICES_BOT_ID}/owner`]);
  });
});

describe('ящик-источник (этап 220)', () => {
  test('просмотр писем о ценах обходит только ящики сотрудников', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.connectSource('info-source', 'info@company.test');
    deps.mailboxes.deliverToSource('info-source', triggerMail('s1'));
    deps.mailboxes.deliver(USER_1, triggerMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    // Источник не считается сотрудником: ни адресата, ни курсора, ни счётчиков.
    expect(result).toMatchObject({
      status: 'done',
      employees: 2,
      notified: 1,
      scanned: 1,
      notConnected: 0,
      failed: 0,
    });
    expect(await deps.state.get(TRIGGER_CURSOR_NAMESPACE, 'info-source')).toBeNull();
  });

  test('ящик-источник нельзя открыть как ящик сотрудника', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.connectSource('info-source', 'info@company.test');
    await expect(deps.mailboxes.forEmployee('info-source')).rejects.toThrow();
  });
});
