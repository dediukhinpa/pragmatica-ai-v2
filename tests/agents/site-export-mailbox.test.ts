import { beforeEach, describe, expect, test } from 'bun:test';
import { createToolContext } from '@business-ai/core';
import { gatherItemData } from '../../src/agents/site-export/gather-item-data';
import {
  MAIL_USER_1,
  MAIL_USER_2,
  MAIL_USER_NO_MAILBOX,
  buildMailboxes,
  buildSiteDeps,
  employeeContext,
  schedulerContext,
  type SiteTestDeps,
} from './site-support';
import { CREATED_AT } from './support';

const EXPORT_ID = 'exp-mail';
const SUPPLIER_ADDRESS = 'sales@s1.test';

let deps: SiteTestDeps;
beforeEach(async () => {
  deps = await buildSiteDeps();
});

function mail(id: string, body: string) {
  return {
    id,
    from: SUPPLIER_ADDRESS,
    subject: 'Болт 1',
    body,
    receivedAt: CREATED_AT,
    attachments: [],
  };
}

describe('gatherItemData: почта сотрудника', () => {
  test('ищет в ящике сотрудника из хода; чужой ящик не читается', async () => {
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, mail('a1', 'Болт 1: цена 11 у первого сотрудника'));
    mailboxes.deliver(MAIL_USER_2, mail('b1', 'Болт 1: цена 12 у второго сотрудника'));
    const withBoxes = { ...deps, mailboxes };
    const first = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      withBoxes,
      employeeContext(MAIL_USER_1),
    );
    const second = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      withBoxes,
      employeeContext(MAIL_USER_2),
    );
    expect(first.emails.map((m) => m.source)).toEqual(['письмо a1']);
    expect(second.emails.map((m) => m.source)).toEqual(['письмо b1']);
    // Чтение без пометки «обработано»: ни в чьём ящике.
    expect(mailboxes.processedIds(MAIL_USER_1)).toEqual([]);
  });

  test('у сотрудника нет ящика: источник «почта» недоступен, остальные работают', async () => {
    const withBoxes = { ...deps, mailboxes: buildMailboxes() };
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      withBoxes,
      employeeContext(MAIL_USER_NO_MAILBOX),
    );
    expect(out.emails).toEqual([]);
    expect(out.unavailableSources).toContainEqual({ source: 'email', reason: 'not_configured' });
    expect(out.prices.length).toBeGreaterThan(0);
  });

  test('плановый ход без сотрудника: почта недоступна', async () => {
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, mail('a1', 'Болт 1: цена 11'));
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      { ...deps, mailboxes },
      schedulerContext(),
    );
    expect(out.emails).toEqual([]);
    expect(out.unavailableSources).toContainEqual({ source: 'email', reason: 'not_configured' });
  });

  test('неизвестный инициатор: почта недоступна', async () => {
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      { ...deps, mailboxes: buildMailboxes() },
      createToolContext({ threadId: 't', agentId: 'site-export', operationId: 'op-unknown' }),
    );
    expect(out.emails).toEqual([]);
    expect(out.unavailableSources).toContainEqual({ source: 'email', reason: 'not_configured' });
  });

  test('без каталога ящиков почта недоступна для любого хода', async () => {
    const { mailboxes: _unused, ...withoutBoxes } = deps;
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      withoutBoxes,
      employeeContext(MAIL_USER_1),
    );
    expect(out.emails).toEqual([]);
    expect(out.unavailableSources).toContainEqual({ source: 'email', reason: 'not_configured' });
  });

  test('письмо неизвестного отправителя из ящика сотрудника в карточки не попадает', async () => {
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, { ...mail('x1', 'Болт 1: цена 1'), from: 'evil@spam.test' });
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      { ...deps, mailboxes },
      employeeContext(MAIL_USER_1),
    );
    expect(out.emails).toEqual([]);
  });
});
