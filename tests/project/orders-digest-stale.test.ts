import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock } from '@business-ai/adapters';
import { bindingThreadId, createToolContext, recordWorkOwner } from '@business-ai/core';
import { saveSent } from '../../src/agents/order-calc/state';
import {
  ORDER_DIGEST_MAX_STALE_LISTED,
  runOrdersDigest,
} from '../../src/agents/order-calc/orders-digest';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import { MAIL_OWNER, ORDER_REQUEST, buildOrderDeps, type OrderTestDeps } from '../agents/order-support';

/**
 * Утренняя сводка (этап 9p, решение владельца 22.11.26): старые заявки перечисляются по названию
 * отдельным блоком, без висящего «и N заказов»; перед просьбой проверить статус - пустая строка;
 * заголовок жирным с датой в часовом поясе сводки.
 */

const TIMEZONE = 'Europe/Moscow';
const THREAD = bindingThreadId({ botId: 'order-bot', userId: 'ivanov' });
/** Понедельник 09:30 по Москве. */
const MONDAY_MORNING = '2026-10-12T06:30:00.000Z';
const FRESH_SENT = '2026-10-09T08:00:00.000Z';
const STALE_SENT = '2026-09-01T10:00:00.000Z';
const STATUS_CHECK = 'Проверьте, пожалуйста, статус по этим заявкам';

let deps: OrderTestDeps;
beforeEach(async () => {
  deps = await buildOrderDeps();
  deps.clock = new FixedClock(new Date(MONDAY_MORNING));
});

async function order(id: string, sentAt: string): Promise<void> {
  await deps.requests.save({
    ...ORDER_REQUEST,
    id: `req-${id}`,
    items: [{ name: `товар ${id}`, quantity: 1, unit: 'шт' }],
  });
  await saveSent(deps, {
    requestId: `req-${id}`,
    supplierIds: ['s1', 's2'],
    sentAt,
    sentBySupplier: { s1: sentAt, s2: sentAt },
    mailboxOwnerId: MAIL_OWNER,
    state: 'prepared',
  });
  await recordWorkOwner(
    deps.state,
    workSubject.order(`req-${id}`),
    createToolContext({
      threadId: THREAD,
      agentId: 'test-agent',
      operationId: 'op',
      initiator: { kind: 'user', userId: THREAD },
    }),
  );
}

async function digest(): Promise<string> {
  await runOrdersDigest(deps, { timezone: TIMEZONE });
  const text = deps.chat.outboxOf(THREAD)[0]?.message?.text;
  if (text === undefined) throw new Error('сводка не отправлена');
  return text;
}

describe('сводка: заголовок и абзац перед финальной фразой', () => {
  test('заголовок жирный, с датой в часовом поясе сводки', async () => {
    await order('fresh', FRESH_SENT);
    const text = await digest();
    expect(text.split('\n')[0]).toBe('**План на день (12.10.2026):**');
  });

  test('дата берётся в часовом поясе сводки, а не UTC', async () => {
    // 22:30 UTC воскресенья - уже понедельник 01:30 в Москве; сводка не уходит (до 9:00)
    deps.clock = new FixedClock(new Date('2026-10-11T22:30:00.000Z'));
    await order('fresh', FRESH_SENT);
    expect((await runOrdersDigest(deps, { timezone: TIMEZONE })).status).toBe('not_due');
    // 09:30 по Москве во вторник: дата вторника
    deps.clock = new FixedClock(new Date('2026-10-13T06:30:00.000Z'));
    const text = await digest();
    expect(text.split('\n')[0]).toBe('**План на день (13.10.2026):**');
  });

  test('перед финальной фразой пустая строка', async () => {
    await order('fresh', FRESH_SENT);
    const lines = (await digest()).split('\n');
    const at = lines.findIndex((line) => line.startsWith(STATUS_CHECK));
    expect(at).toBeGreaterThan(1);
    expect(lines[at - 1]).toBe('');
    expect(lines[at - 2]).not.toBe('');
  });
});

describe('сводка: старые заявки перечисляются', () => {
  test('только старые: блок с названием, датой, числом поставщиков, без висящего «и»', async () => {
    await order('old', STALE_SENT);
    const text = await digest();
    expect(text).toContain('Без ответа больше 14 дней:');
    expect(text).toContain('• товар old: отправлено 01.09, поставщиков: 2, 41 день без ответа.');
    expect(text).not.toContain('• и 1 заказ');
    expect(text).not.toContain('1. Проверьте');
    expect(text).not.toMatch(/план на день[^\n]*\n• и /iu);
  });

  test('подсказка, как закрыть заказ, называет заявку', async () => {
    await order('old', STALE_SENT);
    const text = await digest();
    expect(text).toContain('«заказ «товар old» закрыт»');
    expect(text).toContain('пропадёт из сводки');
  });

  test('только свежие: блока старых нет', async () => {
    await order('fresh', FRESH_SENT);
    const text = await digest();
    expect(text).not.toContain('Без ответа больше');
    expect(text).toContain('- товар fresh');
  });

  test('смешанные: свежие в плане, старые отдельным блоком после него', async () => {
    await order('fresh', FRESH_SENT);
    await order('old', STALE_SENT);
    const text = await digest();
    expect(text.indexOf('- товар fresh')).toBeLessThan(text.indexOf('Без ответа больше'));
    expect(text.indexOf('Без ответа больше')).toBeLessThan(text.indexOf(STATUS_CHECK));
    expect(text).toContain('• товар old: отправлено 01.09');
    // в плане дня старой заявки нет
    expect(text.slice(0, text.indexOf('Без ответа больше'))).not.toContain('товар old');
  });

  test('больше предела: перечислено не больше предела, остаток - «и ещё N»', async () => {
    const total = ORDER_DIGEST_MAX_STALE_LISTED + 3;
    for (let index = 0; index < total; index += 1) {
      await order(`s${String(index).padStart(2, '0')}`, STALE_SENT);
    }
    const text = await digest();
    const listed = text.split('\n').filter((line) => /^• товар s\d\d: отправлено/u.test(line));
    expect(listed).toHaveLength(ORDER_DIGEST_MAX_STALE_LISTED);
    expect(text).toContain('• и ещё 3 заказа');
    // «и ещё» стоит после перечисленных заказов, а не вместо них
    expect(text.indexOf('• и ещё 3 заказа')).toBeGreaterThan(text.indexOf('• товар s00'));
  });

  test('предел задаётся параметром, склонение дней в заголовке', async () => {
    await order('fresh', FRESH_SENT);
    await runOrdersDigest(deps, { timezone: TIMEZONE, openMaxDays: 2 });
    const text = deps.chat.outboxOf(THREAD)[0]?.message?.text ?? '';
    expect(text).toContain('Без ответа больше 2 дней:');
    expect(text).toContain('• товар fresh: отправлено 09.10, поставщиков: 2');
  });
});
