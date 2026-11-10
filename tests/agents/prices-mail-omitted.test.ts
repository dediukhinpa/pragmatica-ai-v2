import { beforeEach, describe, expect, test } from 'bun:test';
import { MAIL_CURSOR_NAMESPACE } from '../../src/agents/prices/deps';
import { readPriceMail } from '../../src/agents/prices/price-mail';
import { HELD_MAX_REREADS, HELD_REREAD_MIN_INTERVAL_MS } from '@business-ai/core';
import type { EmployeeMailbox, InboxMessage, OutgoingMail } from '@business-ai/core';
import {
  USER_1,
  USER_THREAD_1,
  buildMailboxPricesDeps,
  employeeContext,
  encode,
  mailMessage,
  skuCsv,
  type MailboxPricesDeps,
} from './prices-support';

let deps: MailboxPricesDeps;
beforeEach(async () => {
  deps = await buildMailboxPricesDeps();
});

const CSV = skuCsv([['Болт', 10, 'B1']]);
const ctx = () => employeeContext(USER_1, USER_THREAD_1);
const FILE = { fileName: 'a.csv', mimeType: 'text/csv', bytes: encode(CSV) };

describe('письмо без содержимого не считается письмом без прайса', () => {
  test('too_large от известного поставщика: запись с причиной, курсор идёт дальше', async () => {
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({ id: 'big', body: '', contentOmitted: 'too_large' }),
    );
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'ok', attachments: [FILE] }));
    const out = await readPriceMail.execute({}, deps, ctx());
    const big = out.mails.find((item) => item.messageId.endsWith('big'));
    expect(big?.contentOmitted).toBe('too_large');
    expect(big?.attachments).toEqual([]);
    expect(big?.bodyExcerpt).toBe('');
    expect(out.mails.some((item) => item.messageId.endsWith('ok'))).toBe(true);
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '2' });
  });

  describe('перечитываемая причина', () => {
    let failReads: number;
    let reads: string[];

    /** Ящик: список отдаёт письмо без содержимого, `getMessage` - полное (если не «упало»). */
    function install(): void {
      const full = mailMessage({ id: 'm1', attachments: [FILE] });
      const omitted: InboxMessage = {
        ...full,
        body: '',
        attachments: [],
        contentOmitted: 'fetch_failed',
      };
      const box: EmployeeMailbox = {
        employeeId: USER_1,
        address: 'ivanov@company.test',
        async fetchNew(cursor: string) {
          const first = cursor === '';
          return { messages: first ? [omitted] : [], nextCursor: first ? '1' : cursor };
        },
        async markProcessed() {},
        async getMessage(id: string) {
          reads.push(id);
          if (failReads > 0) {
            failReads -= 1;
            throw new Error('сервер недоступен');
          }
          return full;
        },
        async send(_mail: OutgoingMail) {
          throw new Error('не используется');
        },
      };
      deps.mailboxes.forEmployee = async () => box;
    }

    beforeEach(() => {
      failReads = 1;
      reads = [];
      install();
    });

    test('перечитать не удалось: курсор стоит, причина видна, потом письмо читается', async () => {
      const first = await readPriceMail.execute({}, deps, ctx());
      expect(first.mails).toEqual([]);
      expect(first.unreadReasons).toEqual(['fetch_failed']);
      expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toBeNull();
      const second = await readPriceMail.execute({}, deps, ctx());
      expect(second.unreadReasons).toBeUndefined();
      expect(second.mails.map((item) => item.attachments.length)).toEqual([1]);
      expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '1' });
      expect(reads).toEqual(['m1', 'm1']);
    });
  });
});

describe('R7-04: письмо без читаемого содержимого не держит курсор вечно', () => {
  /** Письмо поставщика, которое стабильно не разбирается, и за ним письмо с прайсом. */
  function deliverBrokenThenPrice(): void {
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({
        id: 'bad',
        subject: 'Битый прайс май',
        body: '',
        contentOmitted: 'parse_failed',
      }),
    );
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'ok', attachments: [FILE] }));
  }

  test('на пределе курсор идёт дальше, сотрудник получает уведомление', async () => {
    deliverBrokenThenPrice();
    // Предел исчерпан за HELD_MAX_REREADS проходов с шагом интервала, но пропуск - только
    // когда с первой попытки прошло интервал × предел.
    for (let pass = 1; pass <= HELD_MAX_REREADS; pass += 1) {
      const held = await readPriceMail.execute({}, deps, ctx());
      expect(held.unreadReasons).toEqual(['parse_failed']);
      expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toBeNull();
      expect(deps.chat.outbox).toEqual([]);
      deps.clock.advance(HELD_REREAD_MIN_INTERVAL_MS);
    }
    const last = await readPriceMail.execute({}, deps, ctx());
    expect(last.unreadReasons).toBeUndefined();
    expect(last.mails.some((item) => item.messageId.endsWith('ok'))).toBe(true);
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toEqual({ cursor: '2' });
    expect(deps.chat.outbox).toHaveLength(1);
    const sent = deps.chat.outbox[0];
    expect(sent?.threadId).toBe(USER_THREAD_1);
    expect(sent?.message?.text).toContain('Не удалось прочитать письмо от');
    expect(sent?.message?.text).toContain('Битый прайс май');
    expect(sent?.message?.text).toContain('откройте в почте');
    // Повторный проход письмо не поднимает и уведомление не дублирует.
    await readPriceMail.execute({}, deps, ctx());
    expect(deps.chat.outbox).toHaveLength(1);
  });

  test('письмо перечитывается не больше предела', async () => {
    deliverBrokenThenPrice();
    const reads: string[] = [];
    const box = await deps.mailboxes.forEmployee(USER_1);
    const original = box.getMessage?.bind(box);
    box.getMessage = async (id: string) => {
      reads.push(id);
      return original === undefined ? null : original(id);
    };
    for (let pass = 0; pass < HELD_MAX_REREADS + 3; pass += 1) {
      await readPriceMail.execute({}, deps, ctx());
      deps.clock.advance(HELD_REREAD_MIN_INTERVAL_MS);
    }
    expect(reads.filter((id) => id === 'bad')).toHaveLength(HELD_MAX_REREADS);
  });
  test('быстрые проходы подряд (краткий сбой) письмо не пропускают', async () => {
    deliverBrokenThenPrice();
    for (let pass = 0; pass < HELD_MAX_REREADS * 3; pass += 1) {
      const held = await readPriceMail.execute({}, deps, ctx());
      expect(held.unreadReasons).toEqual(['parse_failed']);
      deps.clock.advance(60_000 / HELD_MAX_REREADS);
    }
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).toBeNull();
    expect(deps.chat.outbox).toEqual([]);
  });
});
