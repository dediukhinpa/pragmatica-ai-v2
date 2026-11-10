import { beforeEach, describe, expect, test } from 'bun:test';
import { MAIL_CURSOR_NAMESPACE, MAIL_NAMESPACE } from '../../src/agents/prices/deps';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { mailKey } from '../../src/agents/prices/price-state';
import type {
  EmployeeMailbox,
  FetchNewOptions,
  InboxMessage,
  MailboxDirectory,
  OutgoingMail,
} from '@business-ai/core';
import {
  COLUMNS,
  SCHEDULER_CTX,
  SUPPLIER_EMAIL,
  USER_1,
  USER_THREAD_1,
  buildMailboxPricesDeps,
  employeeContext,
  encode,
  mailMessage,
  skuCsv,
  type MailboxPricesDeps,
} from './prices-support';

/** Этап 144: по просьбе человека читается любое письмо; плановый проход - только известные. */

const STRANGER = 'someone@unknown.example';
const CSV = skuCsv([['Болт', 10, 'B1']]);
const FILE = { fileName: 'price.csv', mimeType: 'text/csv', bytes: encode(CSV) };
const ctx = () => employeeContext(USER_1, USER_THREAD_1);

type TestDeps = Omit<MailboxPricesDeps, 'mailboxes'> & { mailboxes: MailboxDirectory };
let deps: TestDeps;
let seen: Array<boolean | undefined>;

/**
 * Ящик, повторяющий правило адаптера: без `anySender` содержимое писем вне базы поставщиков
 * не отдаётся (`sender_not_allowed`).
 */
function installAllowlistMailbox(letters: InboxMessage[]): void {
  const box: EmployeeMailbox = {
    employeeId: USER_1,
    address: 'ivanov@company.test',
    async fetchNew(cursor: string, _limit: number, options?: FetchNewOptions) {
      seen.push(options?.anySender);
      const start = cursor === '' ? 0 : Number(cursor);
      const messages = letters.slice(start).map((letter) =>
        letter.from === SUPPLIER_EMAIL || options?.anySender === true
          ? letter
          : { ...letter, body: '', attachments: [], contentOmitted: 'sender_not_allowed' as const },
      );
      return { messages, nextCursor: String(letters.length) };
    },
    async markProcessed() {},
    async getMessage() {
      return null;
    },
    async send(_mail: OutgoingMail) {
      throw new Error('отправка не должна вызываться');
    },
  };
  deps = { ...deps, mailboxes: { forEmployee: async () => box } };
}

beforeEach(async () => {
  deps = await buildMailboxPricesDeps();
  seen = [];
});

describe('чтение письма с чужого адреса по просьбе человека', () => {
  test('тело и вложение читаются, отправитель помечен «не из базы»', async () => {
    installAllowlistMailbox([
      mailMessage({ id: 'x1', from: STRANGER, body: 'Наш новый прайс', attachments: [FILE] }),
    ]);
    const out = await readPriceMail.execute({ senderQuery: 'unknown.example' }, deps, ctx());
    expect(seen).toEqual([true]);
    const item = out.mails[0];
    expect(item).toMatchObject({
      known: false,
      senderNotInBase: true,
      senderVerified: false,
      bodyExcerpt: 'Наш новый прайс',
    });
    const path = item?.attachments[0]?.path ?? '';
    expect(item?.attachments[0]?.readable).toBe(true);
    const page = await readPriceFile.execute({ path }, deps, ctx());
    expect(page.markdown).toContain('Болт');
    expect(out.ignoredPersonal).toBe(0);
  });

  test('в базу прайс из письма чужого адреса не разбирается', async () => {
    installAllowlistMailbox([mailMessage({ id: 'x1', from: STRANGER, attachments: [FILE] })]);
    const out = await readPriceMail.execute({ senderQuery: 'unknown.example' }, deps, ctx());
    const path = out.mails[0]?.attachments[0]?.path ?? '';
    await expect(
      stagePriceRows.execute(
        { path, supplierId: 's1', columns: COLUMNS, reset: true },
        deps,
        ctx(),
      ),
    ).rejects.toThrow();
  });

  test('письмо известного поставщика читается как раньше и помечено known', async () => {
    installAllowlistMailbox([mailMessage({ id: 'k1', attachments: [FILE] })]);
    const out = await readPriceMail.execute({}, deps, ctx());
    expect(out.mails[0]).toMatchObject({ known: true, senderNotInBase: false });
  });

  test('причина, по которой письмо не прочитано, названа точно', async () => {
    installAllowlistMailbox([
      mailMessage({ id: 'big', from: STRANGER, body: '', contentOmitted: 'too_large' }),
    ]);
    const out = await readPriceMail.execute({ senderQuery: 'unknown.example' }, deps, ctx());
    expect(out.mails[0]).toMatchObject({
      senderNotInBase: true,
      contentOmitted: 'too_large',
      contentOmittedText: 'письмо слишком большое, почтовый сервис его не загружает',
    });
  });
});

describe('чужие письма сохраняются только по запросу сотрудника', () => {
  test('без запроса anySender не просится и чужое письмо не сохраняется', async () => {
    installAllowlistMailbox([mailMessage({ id: 'x1', from: STRANGER, attachments: [FILE] })]);
    const out = await readPriceMail.execute({}, deps, ctx());
    expect(seen).toEqual([undefined]);
    expect(out.mails).toEqual([]);
  });

  test('с запросом сохраняется только подошедшее письмо, остальные чужие - нет', async () => {
    installAllowlistMailbox([
      mailMessage({ id: 'x1', from: STRANGER, subject: 'Прайс', attachments: [FILE] }),
      mailMessage({ id: 'x2', from: 'other@else.example', body: 'секрет', attachments: [FILE] }),
    ]);
    const out = await readPriceMail.execute({ senderQuery: 'someone@' }, deps, ctx());
    expect(out.mails.map((mail) => mail.messageId)).toHaveLength(1);
    expect(out.mails[0]?.messageId.endsWith('x1')).toBe(true);
    const stored = await deps.state.get(MAIL_NAMESPACE, mailKey(mailRecordId(USER_1, 'x2')));
    expect(stored).toBeNull();
  });

  test('запрос не двигает курсор: другой запрос находит остальные письма', async () => {
    installAllowlistMailbox([
      mailMessage({ id: 'x1', from: STRANGER, attachments: [FILE] }),
      mailMessage({ id: 'x2', from: 'other@else.example', attachments: [FILE] }),
    ]);
    await readPriceMail.execute({ senderQuery: 'someone@' }, deps, ctx());
    const out = await readPriceMail.execute({ senderQuery: 'else.example' }, deps, ctx());
    expect(out.mails.some((mail) => mail.messageId.endsWith('x2'))).toBe(true);
  });
});

describe('записи «по просьбе» не видны плановому проходу', () => {
  test('плановый ход того же ящика не получает чужое письмо сотрудника', async () => {
    installAllowlistMailbox([mailMessage({ id: 'x1', from: STRANGER, attachments: [FILE] })]);
    const asked = await readPriceMail.execute({ senderQuery: 'someone@' }, deps, ctx());
    expect(asked.mails).toHaveLength(1);
    const planned = { ...deps, mailboxOwnerUserId: USER_1 };
    const out = await readPriceMail.execute({}, planned, SCHEDULER_CTX);
    expect(out.mails).toEqual([]);
  });
});

describe('автоматический (плановый) проход не читает чужие адреса', () => {
  test('без сотрудника anySender не просится, чужое письмо не сохраняется', async () => {
    installAllowlistMailbox([
      mailMessage({ id: 'x1', from: STRANGER, body: 'Наш новый прайс', attachments: [FILE] }),
    ]);
    const planned = { ...deps, mailboxOwnerUserId: USER_1 };
    const out = await readPriceMail.execute({}, planned, SCHEDULER_CTX);
    expect(seen).toEqual([undefined]);
    expect(out.mails).toEqual([]);
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '1' });
  });
});
