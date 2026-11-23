import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryMailboxDirectory } from '@business-ai/adapters';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  MAIL_TRUST_SURVEY_WINDOW_DAYS,
  formatMailTrustSurvey,
  runMailTrustSurvey,
  type MailTrustSurveyDeps,
  type MailTrustSurveyOptions,
} from '../../src/agents/suppliers/mail-trust-survey';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import type { InboxMessage } from '@business-ai/core';

/**
 * Обследование доверия к отправителям (этап 233, только чтение): на синтетических ящиках
 * проверяются корзины, гипотетические колонки, окно и предел, отсутствие ПДн в выводе.
 */

const NOW = new Date('2026-11-08T09:00:00.000Z');
const SOURCE_ID = 'info-source';
const SOURCE_ADDRESS = 'info@company.test';
const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_SUBJECT = 'Секретная тема про картон';

let clock: FixedClock;
let suppliers: MemorySupplierRepository;
let mailboxes: MemoryMailboxDirectory;
let counter = 0;

beforeEach(() => {
  clock = new FixedClock(NOW);
  suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  mailboxes = new MemoryMailboxDirectory();
  mailboxes.connectSource(SOURCE_ID, SOURCE_ADDRESS);
  counter = 0;
});

async function seed(fields: SupplierCardFields): Promise<void> {
  const card = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-10-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  await suppliers.saveCard(card, { createOnly: true });
}

function mail(from: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  counter += 1;
  return {
    id: `m${counter}`,
    from,
    subject: SECRET_SUBJECT,
    body: 'Текст письма с адресом hidden@secret-body.test',
    receivedAt: '2026-03-01T10:00:00.000Z',
    attachments: [],
    senderAuth: 'unverified',
    ...overrides,
  };
}

function deliver(...messages: InboxMessage[]): void {
  for (const message of messages) mailboxes.deliverToSource(SOURCE_ID, message);
}

function deps(overrides: Partial<MailTrustSurveyDeps> = {}): MailTrustSurveyDeps {
  return {
    suppliers,
    mailboxes,
    clock,
    ownCompanyRequisites: ['zakupki@own-company.test'],
    sourceAddress: SOURCE_ADDRESS,
    ...overrides,
  };
}

const OPTIONS: MailTrustSurveyOptions = {
  windowDays: MAIL_TRUST_SURVEY_WINDOW_DAYS,
  maxMessagesPerMailbox: 100_000,
  maxMinutesPerMailbox: 600,
  scope: 'all',
};

async function seedCards(): Promise<void> {
  await seed({ name: 'ООО «Вега Трейд»', contacts: [{ email: 'boss@vega-trade.test' }] });
  await seed({ name: 'ИП Частный', contacts: [{ email: 'ivan@gmail.com' }] });
  await seed({
    name: 'ООО «Сайт Групп»',
    website: 'https://www.site-group.test',
    contacts: [{ email: 'office@other-mail.test' }],
  });
}

async function sources(overrides: Partial<MailTrustSurveyOptions> = {}) {
  const result = await runMailTrustSurvey(deps(), { ...OPTIONS, ...overrides });
  const group = result.groups.find((item) => item.group === 'sources');
  if (group === undefined) throw new Error('нет группы источников');
  return group;
}

describe('обследование доверия к отправителям', () => {
  test('окно по умолчанию - два года', () => {
    expect(MAIL_TRUST_SURVEY_WINDOW_DAYS).toBe(730);
  });

  test('письма раскладываются по корзинам взаимоисключающе', async () => {
    await seedCards();
    deliver(
      mail('boss@vega-trade.test'), // адрес карточки
      mail('other@vega-trade.test'), // домен карточки
      mail('sales@aligned.test', { dkim: 'aligned' }), // DKIM
      mail('sales@second-aligned.test', { dkim: 'aligned' }),
      mail('boss@vega-trade.test', { dkim: 'aligned' }), // DKIM и карточка вместе
      mail('ivan@gmail.com'), // публичный почтовик: точный адрес из карточки
      mail('petr@gmail.com'), // публичный почтовик: чужой адрес
      mail('sales@fail.test', { dkim: 'fail' }),
      mail('sales@server.test', { serverAuth: 'verified' }), // только ответ сервера
      mail('news@shop.test', { bulk: true }),
      mail('noreply@robot.test'),
      mail('zakupki@own-company.test'),
    );
    const group = await sources();
    expect(group.total).toBe(12);
    expect(group.newsletters).toBe(1);
    expect(group.system).toBe(1);
    expect(group.own).toBe(1);
    // Письма поставщиков: отправитель есть в карточке (адрес или корпоративный домен).
    expect(group.supplier.count).toBe(4);
    expect(group.supplier.trust).toEqual({ dkim: 1, cardAddress: 2, cardDomain: 1, unverified: 0 });
    expect(group.supplier.dkimAndCard).toBe(1);
    expect(group.supplier.dkimResults).toMatchObject({ aligned: 1, none: 3 });
    // Неизвестные отправители: карточек нет; ответ сервера в доверие не входит, только справка.
    expect(group.unknown.count).toBe(5);
    expect(group.unknown.trust).toEqual({ dkim: 2, cardAddress: 0, cardDomain: 0, unverified: 3 });
    expect(group.unknown.serverPass).toBe(1);
    expect(group.unknown.dkimResults).toMatchObject({ aligned: 2, fail: 1, none: 2 });
    for (const stats of [group.supplier, group.unknown]) {
      const sum = Object.values(stats.trust).reduce((a, b) => a + b, 0);
      expect(sum).toBe(stats.count);
    }
    expect(group.supplier.count + group.unknown.count).toBe(
      group.total - group.newsletters - group.system - group.own,
    );
  });

  test('гипотетические колонки считаются только среди непроверенных', async () => {
    await seedCards();
    deliver(
      mail('sales@site-group.test'), // домен сайта карточки
      mail('sales@shop.site-group.test'), // поддомен сайта карточки
      mail('person@free.test', { inReplyTo: 'our-msg-1' }), // ответ в наш тред
      mail('sales@site-group.test', { inReplyTo: 'our-msg-2' }), // оба ослабления
      mail('sales@nobody.test'), // ни то ни другое
      mail('boss@vega-trade.test', { inReplyTo: 'our-msg-3' }), // уже доверен по карточке
    );
    const group = await sources();
    // Боссы карточки доверены по карточке (поставщик), прочие - неизвестные.
    expect(group.supplier.trust.cardAddress).toBe(1);
    expect(group.unknown.trust.unverified).toBe(5);
    expect(group.unknown.hypothetical).toEqual({ cardWebsite: 3, replyThread: 2, either: 4 });
    expect(group.supplier.hypothetical).toEqual({ cardWebsite: 0, replyThread: 0, either: 0 });
  });

  test('публичный почтовик не доверяется по домену сайта или карточки', async () => {
    await seed({ name: 'ООО «Почтовик»', website: 'https://gmail.com', contacts: [] });
    deliver(mail('anyone@gmail.com'));
    const group = await sources();
    expect(group.unknown.trust.unverified).toBe(1);
    expect(group.unknown.hypothetical.cardWebsite).toBe(0);
  });

  test('письма старше окна не считаются', async () => {
    deliver(
      mail('a@old.test', { receivedAt: '2020-01-01T00:00:00.000Z' }),
      mail('a@new.test'),
    );
    const group = await sources();
    expect(group.total).toBe(1);
    expect(group.limited).toBeNull();
    expect(group.coveredDays).toBe(730);
  });

  test('предел по числу писем: читаются самые свежие, вывод «последние N дней»', async () => {
    await seedCards();
    // Старые письма - от неизвестных, свежие - от поставщика из карточки: по классам видно,
    // какой кусок окна прочитан.
    const dates = ['2025-01-10', '2025-02-10', '2025-03-10', '2025-04-10', '2025-05-10'];
    deliver(
      ...dates.map((day, index) =>
        mail(index < 3 ? 'a@x.test' : 'boss@vega-trade.test', {
          receivedAt: `${day}T10:00:00.000Z`,
        }),
      ),
    );
    const group = await sources({ maxMessagesPerMailbox: 2 });
    expect(group.total).toBe(2);
    expect(group.supplier.count).toBe(2);
    expect(group.unknown.count).toBe(0);
    expect(group.limited).toBe('messages');
    expect(group.limitedMailboxes).toBe(1);
    const earliest = Date.parse('2025-04-10T10:00:00.000Z');
    expect(group.coveredDays).toBe(Math.floor((NOW.getTime() - earliest) / DAY_MS));
    const lines = formatMailTrustSurvey({ groups: [group] }).join('\n');
    expect(lines).toContain(`последние ${group.coveredDays} дней из 730`);
    expect(lines).toContain('упёрлись в предел');
  });

  test('ящик целиком прочитан, но моложе окна: вывод называет возраст раннего письма', async () => {
    deliver(mail('a@x.test', { receivedAt: '2026-08-10T10:00:00.000Z' }), mail('b@x.test'));
    const group = await sources();
    expect(group.limited).toBeNull();
    expect(group.coveredDays).toBe(730);
    const lines = formatMailTrustSurvey({ groups: [group] }).join('\n');
    expect(lines).toContain('прочитано целиком');
    expect(lines).toContain('самое раннее письмо');
  });

  test('предел по времени', async () => {
    deliver(mail('a@x.test'), mail('b@x.test'), mail('c@x.test'));
    let tick = 0;
    const result = await runMailTrustSurvey(
      deps({ timeMs: () => (tick += 60_000) }),
      { ...OPTIONS, maxMinutesPerMailbox: 1 },
    );
    const group = result.groups.find((item) => item.group === 'sources');
    expect(group?.limited).toBe('time');
    expect(group?.total).toBeLessThan(3);
  });

  test('ящики сотрудников: свои числа, сбойный ящик не роняет обход', async () => {
    mailboxes.connect('emp-1', 'one@company.test');
    mailboxes.connect('emp-2', 'two@company.test');
    mailboxes.deliver('emp-1', mail('x@vega-trade.test'));
    mailboxes.deliver('emp-2', mail('y@nobody.test'));
    const broken: MailboxDirectoryLike = {
      employeeIds: () => mailboxes.employeeIds(),
      sourceMailboxes: () => mailboxes.sourceMailboxes(),
      forEmployee: async (id: string) => {
        if (id === 'emp-2') throw new Error('boom');
        return mailboxes.forEmployee(id);
      },
    };
    const result = await runMailTrustSurvey(deps({ mailboxes: broken }), OPTIONS);
    const group = result.groups.find((item) => item.group === 'employees');
    expect(group).toMatchObject({ mailboxes: 2, failedMailboxes: 1, total: 1 });
  });

  test('область: только источники или только сотрудники', async () => {
    mailboxes.connect('emp-1', 'one@company.test');
    const onlySources = await runMailTrustSurvey(deps(), { ...OPTIONS, scope: 'sources' });
    expect(onlySources.groups.map((item) => item.group)).toEqual(['sources']);
    const onlyEmployees = await runMailTrustSurvey(deps(), { ...OPTIONS, scope: 'employees' });
    expect(onlyEmployees.groups.map((item) => item.group)).toEqual(['employees']);
  });

  test('только чтение: письма не помечаются, вывод без адресов, тем и имён', async () => {
    await seedCards();
    deliver(mail('boss@vega-trade.test'), mail('sales@aligned.test', { dkim: 'aligned' }));
    const before = (await suppliers.searchCards({ limit: 500 })).length;
    const result = await runMailTrustSurvey(deps(), OPTIONS);
    expect(mailboxes.sourceMailboxes()).toHaveLength(1);
    expect((await suppliers.searchCards({ limit: 500 })).length).toBe(before);
    const text = [...formatMailTrustSurvey(result), JSON.stringify(result)].join('\n');
    for (const secret of [
      'vega-trade',
      'aligned.test',
      'gmail',
      'company.test',
      SECRET_SUBJECT,
      'hidden',
      'Вега',
      SOURCE_ADDRESS,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test('читаемый вывод содержит проценты и обе гипотетические колонки', async () => {
    await seedCards();
    deliver(mail('sales@site-group.test'), mail('boss@vega-trade.test'));
    const lines = formatMailTrustSurvey(await runMailTrustSurvey(deps(), OPTIONS));
    const text = lines.join('\n');
    expect(text).toContain('домен сайта карточки');
    expect(text).toContain('ответ в тред');
    expect(text).toMatch(/50%/);
  });
});

type MailboxDirectoryLike = MailTrustSurveyDeps['mailboxes'];
