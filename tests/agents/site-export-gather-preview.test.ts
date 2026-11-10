import { beforeEach, describe, expect, test } from 'bun:test';
import { gatherItemData } from '../../src/agents/site-export/gather-item-data';
import { PREVIEW_BODY_BYTES } from '@business-ai/adapters';
import type { FetchNewOptions } from '@business-ai/core';
import {
  MAIL_USER_1,
  buildMailboxes,
  buildSiteDeps,
  employeeContext,
  type SiteTestDeps,
} from './site-support';
import { CREATED_AT } from './support';

const EXPORT_ID = 'exp-preview';
const SUPPLIER_ADDRESS = 'sales@s1.test';
const CONTACT_ADDRESS = 'buyer@s1.test';
/** Сколько писем за раз отдаёт «урезанный по байтам» ящик (меньше запрошенной страницы). */
const TRUNCATED_PAGE = 2;
/** Чужих писем перед письмом поставщика: больше нескольких урезанных страниц. */
const FOREIGN_BEFORE = 5;

let deps: SiteTestDeps;
beforeEach(async () => {
  deps = await buildSiteDeps();
});

function mail(id: string, from: string, body = 'Болт 1: цена 11', subject = 'Болт 1') {
  return { id, from, subject, body, receivedAt: CREATED_AT, attachments: [] };
}

/** Ящик сотрудника с подсчётом обращений: режимы `fetchNew` и id, прочитанные целиком. */
async function spyOnMailbox(mailboxes: ReturnType<typeof buildMailboxes>, pageCap?: number) {
  const box = await mailboxes.forEmployee(MAIL_USER_1);
  const calls: Array<FetchNewOptions | undefined> = [];
  const fullReads: string[] = [];
  const fetchNew = box.fetchNew.bind(box);
  const getMessage = box.getMessage.bind(box);
  box.fetchNew = (cursor, limit, options) => {
    calls.push(options);
    return fetchNew(cursor, pageCap === undefined ? limit : Math.min(limit, pageCap), options);
  };
  box.getMessage = (id) => {
    fullReads.push(id);
    return getMessage(id);
  };
  return { calls, fullReads };
}

async function gather(mailboxes: ReturnType<typeof buildMailboxes>) {
  return gatherItemData.execute(
    { exportId: EXPORT_ID, query: 'Болт 1' },
    { ...deps, mailboxes },
    employeeContext(MAIL_USER_1),
  );
}

describe('gatherItemData: обход ящика в режиме предпросмотра', () => {
  test('обход идёт с preview, полное письмо читается только у письма поставщика', async () => {
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, mail('x1', 'evil@spam.test'));
    mailboxes.deliver(MAIL_USER_1, mail('x2', 'other@elsewhere.test'));
    mailboxes.deliver(MAIL_USER_1, mail('ok', SUPPLIER_ADDRESS));
    const spy = await spyOnMailbox(mailboxes);
    const out = await gather(mailboxes);
    expect(out.emails.map((m) => m.source)).toEqual(['письмо ok']);
    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.every((options) => options?.preview === true)).toBe(true);
    expect(spy.fullReads).toEqual(['ok']);
  });

  test('слово из хвоста письма находится полным чтением, а не урезанным предпросмотром', async () => {
    const mailboxes = buildMailboxes();
    const tail = `${'x '.repeat(PREVIEW_BODY_BYTES)}болт`;
    mailboxes.deliver(MAIL_USER_1, mail('tail', SUPPLIER_ADDRESS, tail, 'Прайс'));
    const out = await gather(mailboxes);
    expect(out.emails.map((m) => m.source)).toEqual(['письмо tail']);
  });

  test('письмо с адреса контакта поставщика (не основного email) учитывается', async () => {
    await deps.suppliers?.saveCard({
      id: 's1',
      name: 'МеталлТорг',
      status: 'new',
      contacts: [
        { email: SUPPLIER_ADDRESS, isPrimary: true },
        { email: CONTACT_ADDRESS, isPrimary: false },
      ],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, mail('c1', 'Закупки <Buyer@S1.test>'));
    const out = await gather(mailboxes);
    expect(out.emails.map((m) => m.source)).toEqual(['письмо c1']);
  });

  test('страница короче запрошенной не обрывает обход: конец по курсору', async () => {
    const mailboxes = buildMailboxes();
    for (let i = 0; i < FOREIGN_BEFORE; i += 1) {
      mailboxes.deliver(MAIL_USER_1, mail(`f${i}`, 'evil@spam.test'));
    }
    mailboxes.deliver(MAIL_USER_1, mail('late', SUPPLIER_ADDRESS));
    await spyOnMailbox(mailboxes, TRUNCATED_PAGE);
    const out = await gather(mailboxes);
    expect(out.emails.map((m) => m.source)).toEqual(['письмо late']);
  });

  test('письмо с неизвестным отправителем не читается целиком', async () => {
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, mail('x1', 'evil@spam.test'));
    const spy = await spyOnMailbox(mailboxes);
    const out = await gather(mailboxes);
    expect(out.emails).toEqual([]);
    expect(spy.fullReads).toEqual([]);
  });
});
