import { beforeEach, describe, expect, test } from 'bun:test';
import { readPriceMail } from '../../src/agents/prices/price-mail';
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

/** Тема 4 этапа 151: акционные вложения почты не индексируются, обычные принимаются. */

const BYTES = encode(skuCsv([['Болт', 10, 'B1']]));
const file = (fileName: string) => ({ fileName, mimeType: 'text/csv', bytes: BYTES });
const ctx = () => employeeContext(USER_1, USER_THREAD_1);

let deps: MailboxPricesDeps;
let events: Array<{ event: string; fields?: Record<string, string | number | boolean> }>;

beforeEach(async () => {
  deps = await buildMailboxPricesDeps();
  events = [];
  deps = {
    ...deps,
    log: (event, fields) => events.push(fields === undefined ? { event } : { event, fields }),
  };
});

describe('акционные имена вложений', () => {
  test.each(['Акция_май.csv', 'СЛИВ.csv', 'Распродажа.csv', 'SALE_2026.csv', 'Скидки.csv'])(
    '%s пропущен, пишется одно событие info',
    async (name) => {
      deps.mailboxes.deliver(USER_1, mailMessage({ id: 'p1', attachments: [file(name)] }));
      const out = await readPriceMail.execute({}, deps, ctx());
      expect(out.mails.length).toBe(0);
      const promo = events.filter((item) => item.event === 'price_mail_promo_skipped');
      expect(promo.length).toBe(1);
      expect(promo[0]?.fields?.reason).toBe('promo_file_name');
    },
  );

  test('обычный файл принят, акционный рядом пропущен', async () => {
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({ id: 'p2', attachments: [file('price.csv'), file('sale.csv')] }),
    );
    const out = await readPriceMail.execute({}, deps, ctx());
    expect(out.mails[0]?.attachments.length).toBe(1);
    expect(events.filter((item) => item.event === 'price_mail_promo_skipped').length).toBe(1);
  });
});
