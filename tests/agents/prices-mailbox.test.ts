import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MAIL_CURSOR_NAMESPACE,
  MAIL_FILE_NAMESPACE,
  MAIL_NAMESPACE,
} from '../../src/agents/prices/deps';
import { createToolContext, resolveOperationKey } from '@business-ai/core';
import { markPriceMailHandled, readPriceMail } from '../../src/agents/prices/price-mail';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { saveMail } from '../../src/agents/prices/price-state';
import { savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { isDomainError } from '@business-ai/core';
import { CTX, SUPPLIER_ID } from './support';
import {
  COLUMNS,
  SCHEDULER_CTX,
  USER_1,
  USER_2,
  USER_NO_MAILBOX,
  USER_THREAD_1,
  USER_THREAD_2,
  USER_THREAD_3,
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

const CSV = skuCsv([['Болт', 10, 'B1'], ['Гайка', 5, 'G1']]);
const attach = (fileName: string) => ({
  fileName,
  mimeType: 'text/csv',
  bytes: encode(CSV),
});
const ctx1 = () => employeeContext(USER_1, USER_THREAD_1);
const ctx2 = () => employeeContext(USER_2, USER_THREAD_2);

describe('readPriceMail из ящика сотрудника', () => {
  test('два сотрудника: письма и курсоры не пересекаются, одинаковые id не сливаются', async () => {
    // Один и тот же id письма в двух ящиках (так бывает: UID у каждого ящика свой).
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    deps.mailboxes.deliver(
      USER_2,
      mailMessage({ id: 'm1', subject: 'Другой прайс', attachments: [attach('b.csv')] }),
    );
    const first = await readPriceMail.execute({}, deps, ctx1());
    const second = await readPriceMail.execute({}, deps, ctx2());
    expect(first.mails.map((m) => m.subject)).toEqual(['Прайс']);
    expect(second.mails.map((m) => m.subject)).toEqual(['Другой прайс']);
    expect(first.mails[0]?.messageId).not.toBe(second.mails[0]?.messageId);
    // Курсор у каждого свой: повторный вызов ничего нового не забирает.
    expect((await readPriceMail.execute({}, deps, ctx1())).fetched).toBe(0);
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_1)).not.toBeNull();
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_2)).not.toBeNull();
    // Общий ящик прежнего режима не трогается.
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, 'main')).toBeNull();
  });

  test('сотрудник не видит ожидающие письма чужого ящика', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    await readPriceMail.execute({}, deps, ctx1());
    const other = await readPriceMail.execute({}, deps, ctx2());
    expect(other.mails).toEqual([]);
  });

  test('markPriceMailHandled помечает письмо в ящике владельца, а не в чужом', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    deps.mailboxes.deliver(USER_2, mailMessage({ id: 'm1', attachments: [attach('b.csv')] }));
    const mails = (await readPriceMail.execute({}, deps, ctx1())).mails;
    await readPriceMail.execute({}, deps, ctx2());
    const mail = mails[0];
    if (mail === undefined) throw new Error('письмо не прочитано');
    await stagePriceRows.execute(
      {
        path: mail.attachments[0]?.path ?? '',
        supplierId: SUPPLIER_ID,
        columns: COLUMNS,
        reset: true,
      },
      deps,
      ctx1(),
    );
    // Закрывает письмо его владелец: пометка в его ящике, а не в ящике другого сотрудника.
    await markPriceMailHandled.execute(
      { messageId: mail.messageId, outcome: 'staged' },
      deps,
      ctx1(),
    );
    expect(deps.mailboxes.processedIds(USER_1)).toEqual(['m1']);
    expect(deps.mailboxes.processedIds(USER_2)).toEqual([]);
    expect((await readPriceMail.execute({}, deps, ctx1())).mails).toEqual([]);
  });

  test('плановый разбор без указанного ящика: not_configured «не указан ящик»', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    const { mailboxOwnerUserId: _unused, ...unowned } = deps;
    const error = await readPriceMail
      .execute({}, unowned, SCHEDULER_CTX)
      .then(() => null, (e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_configured');
    expect(isDomainError(error) && error.message).toContain('Не указан ящик');
  });

  test('плановый разбор с mailboxOwnerUserId читает ящик этого сотрудника', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    deps.mailboxes.deliver(USER_2, mailMessage({ id: 'm2', attachments: [attach('b.csv')] }));
    const planned = { ...deps, mailboxOwnerUserId: USER_2 };
    const out = await readPriceMail.execute({}, planned, SCHEDULER_CTX);
    expect(out.mails).toHaveLength(1);
    expect(out.mails[0]?.messageId).toContain('m2');
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_2)).not.toBeNull();
  });

  test('сотрудник без ящика: not_configured', async () => {
    const error = await readPriceMail
      .execute({}, deps, employeeContext(USER_NO_MAILBOX, USER_THREAD_3))
      .then(() => null, (e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_configured');
  });

  test('проверка отправителя сохраняется: без senderAuth - не подтверждён', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({ id: 'm2', senderAuth: 'verified', attachments: [attach('b.csv')] }),
    );
    const out = await readPriceMail.execute({}, deps, ctx1());
    const byId = (id: string) => out.mails.find((m) => m.messageId.endsWith(id));
    expect(byId('m1')?.senderVerified).toBe(false);
    expect(byId('m2')?.senderVerified).toBe(true);
    expect(byId('m1')).toMatchObject({ known: true, supplierId: SUPPLIER_ID });
  });
});

describe('чужое письмо: составной id чужого ящика недоступен другому сотруднику', () => {
  /** Письмо сотрудника 1 прочитано; возвращает составной id и путь вложения. */
  async function ownMail(): Promise<{ messageId: string; path: string }> {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    const mail = (await readPriceMail.execute({}, deps, ctx1())).mails[0];
    if (mail === undefined) throw new Error('письмо не прочитано');
    return { messageId: mail.messageId, path: mail.attachments[0]?.path ?? '' };
  }
  const denied = async (promise: Promise<unknown>): Promise<string> => {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('access_denied');
    return isDomainError(error) ? error.message : '';
  };

  test('readPriceFile: B получает отказ, A и плановый ход читают', async () => {
    const { path } = await ownMail();
    const message = await denied(readPriceFile.execute({ path }, deps, ctx2()));
    expect(message).not.toContain(USER_1);
    expect(message).not.toContain('Болт');
    expect((await readPriceFile.execute({ path }, deps, ctx1())).markdown).toContain('Болт');
    expect((await readPriceFile.execute({ path }, deps, SCHEDULER_CTX)).markdown).toContain(
      'Болт',
    );
  });

  test('stagePriceRows: B не ставит прайс из чужого письма в staging', async () => {
    const { path } = await ownMail();
    await denied(
      stagePriceRows.execute(
        { path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
        deps,
        ctx2(),
      ),
    );
  });

  test('markPriceMailHandled: B не закрывает чужое письмо, пометки в ящике нет', async () => {
    const { messageId, path } = await ownMail();
    await stagePriceRows.execute(
      { path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      ctx1(),
    );
    await denied(
      markPriceMailHandled.execute({ messageId, outcome: 'staged' }, deps, ctx2()),
    );
    await denied(
      markPriceMailHandled.execute({ messageId, outcome: 'no_price_data' }, deps, ctx2()),
    );
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);
    expect((await readPriceMail.execute({}, deps, ctx1())).mails).toHaveLength(1);
  });
});

describe('личная почта не сохраняется и не показывается (режим ящиков)', () => {
  const PERSONAL_FROM = 'friend@home.test';
  const PERSONAL_SUBJECT = 'Личное: фото с отпуска';

  test('письмо от адреса вне базы поставщиков: не в состоянии, только счётчик', async () => {
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({
        id: 'p1',
        from: PERSONAL_FROM,
        subject: PERSONAL_SUBJECT,
        body: 'Личный текст',
        attachments: [attach('photo.csv')],
      }),
    );
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    // Плановый проход (не по просьбе сотрудника): чужие адреса не читаются и не сохраняются.
    const planned = { ...deps, mailboxOwnerUserId: USER_1 };
    const out = await readPriceMail.execute({}, planned, SCHEDULER_CTX);
    expect(out.ignoredPersonal).toBe(1);
    expect(out.fetched).toBe(1);
    expect(out.mails.map((m) => m.subject)).toEqual(['Прайс']);
    expect(JSON.stringify(out)).not.toContain(PERSONAL_FROM);
    expect(JSON.stringify(out)).not.toContain(PERSONAL_SUBJECT);
    // В состоянии нет ни записи, ни содержимого личного письма.
    const records = await deps.state.list(MAIL_NAMESPACE, null, 100);
    expect(JSON.stringify(records)).not.toContain(PERSONAL_FROM);
    expect(JSON.stringify(records)).not.toContain(PERSONAL_SUBJECT);
    expect(JSON.stringify(records)).not.toContain('Личный текст');
    expect(records).toHaveLength(1);
    expect(await deps.state.list(MAIL_FILE_NAMESPACE, null, 100)).toHaveLength(1);
    // Курсор ушёл вперёд: повторный вызов письмо не перечитывает и не пересчитывает.
    expect((await readPriceMail.execute({}, planned, SCHEDULER_CTX)).ignoredPersonal).toBe(0);
    // Письмо в ящике не помечено обработанным: это личная почта, код её не трогает.
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);
  });

  test('без подключённых ящиков чтение почты: not_configured', async () => {
    const { mailboxes: _unused, ...legacy } = deps;
    const error = await readPriceMail
      .execute({}, legacy, ctx1())
      .then(() => null, (e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_configured');
  });

  test('старая запись неопознанного письма в ящике не показывается, считается', async () => {
    await saveMail(deps, {
      id: `${USER_1}:old`,
      mailboxOwnerId: USER_1,
      mailboxMessageId: 'old',
      from: PERSONAL_FROM,
      subject: PERSONAL_SUBJECT,
      receivedAt: '2026-01-01T00:00:00.000Z',
      bodyExcerpt: 'текст',
      senderVerified: false,
      status: 'unknown',
      attachments: [],
    });
    const out = await readPriceMail.execute({}, deps, ctx1());
    expect(out.mails).toEqual([]);
    expect(out.ignoredPersonal).toBe(1);
  });

  test('reportToManager unknown_sender: менеджеру не уходят отправитель и тема', async () => {
    await saveMail(deps, {
      id: `${USER_1}:old`,
      mailboxOwnerId: USER_1,
      mailboxMessageId: 'old',
      from: PERSONAL_FROM,
      subject: PERSONAL_SUBJECT,
      receivedAt: '2026-01-01T00:00:00.000Z',
      bodyExcerpt: 'текст',
      senderVerified: true,
      status: 'unknown',
      attachments: [],
    });
    const out = await reportToManager.execute(
      {
        kind: 'unknown_sender',
        path: `mail:${USER_1}:old#0`,
        fileHash: `${USER_1}:old`,
        updated: 0,
        needsReview: 0,
        issueCodes: [],
      },
      deps,
      ctx1(),
    );
    expect(out.delivered).toBe(true);
    const sent = JSON.stringify(deps.chat.outbox);
    expect(sent).toContain('вне базы поставщиков');
    expect(sent).not.toContain(PERSONAL_FROM);
    expect(sent).not.toContain(PERSONAL_SUBJECT);
  });
});

describe('неизвестный инициатор в режиме ящиков: отказ', () => {
  const denied = async (promise: Promise<unknown>): Promise<void> => {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('access_denied');
  };

  test('readPriceMail: ящик «по умолчанию» не выбирается, даже при владельце', async () => {
    deps.mailboxes.deliver(USER_2, mailMessage({ id: 'm2', attachments: [attach('b.csv')] }));
    await denied(readPriceMail.execute({}, { ...deps, mailboxOwnerUserId: USER_2 }, CTX));
    expect(await deps.state.get(MAIL_CURSOR_NAMESPACE, USER_2)).toBeNull();
  });

  test('пользователь с пустым id: отказ', async () => {
    const empty = createToolContext({
      threadId: USER_THREAD_1,
      agentId: 'prices',
      operationId: 'op-empty',
      initiator: { kind: 'user', userId: '' },
    });
    await denied(readPriceMail.execute({}, deps, empty));
  });

  test('чужое письмо с неизвестным инициатором: отказ, плановый запуск читает', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    const mail = (await readPriceMail.execute({}, deps, ctx1())).mails[0];
    const path = mail?.attachments[0]?.path ?? '';
    await denied(readPriceFile.execute({ path }, deps, CTX));
    expect((await readPriceFile.execute({ path }, deps, SCHEDULER_CTX)).markdown).toContain(
      'Болт',
    );
  });
});

describe('ключи операций чтения почты зависят от треда в режиме ящиков', () => {
  const keyIn = (tool: Parameters<typeof resolveOperationKey>[0], input: unknown, thread: string) =>
    resolveOperationKey(tool, input, deps, thread, '');

  test('markPriceMailHandled, reportToManager, savePriceImport(mail:...)', async () => {
    const handled = { messageId: 'u1:m1', outcome: 'staged' };
    expect(await keyIn(markPriceMailHandled, handled, USER_THREAD_1)).not.toBe(
      await keyIn(markPriceMailHandled, handled, USER_THREAD_2),
    );
    const report = {
      kind: 'needs_review',
      path: 'mail:u1:m1#0',
      fileHash: 'u1:m1',
      issueCodes: [],
    };
    expect(await keyIn(reportToManager, report, USER_THREAD_1)).not.toBe(
      await keyIn(reportToManager, report, USER_THREAD_2),
    );
    const save = {
      path: 'mail:u1:m1#0',
      supplierId: SUPPLIER_ID,
      columns: COLUMNS,
      fileHash: 'h',
    };
    expect(await keyIn(savePriceImport, save, USER_THREAD_1)).not.toBe(
      await keyIn(savePriceImport, save, USER_THREAD_2),
    );
    // Файл с диска от треда не зависит: тот же импорт тем же ключом.
    const disk = { ...save, path: 'price.csv' };
    expect(await keyIn(savePriceImport, disk, USER_THREAD_1)).toBe(
      await keyIn(savePriceImport, disk, USER_THREAD_2),
    );
  });

  test('без режима ящиков ключ markPriceMailHandled не зависит от треда', async () => {
    const { mailboxes: _unused, ...legacy } = deps;
    const handled = { messageId: 'm1', outcome: 'staged' };
    const key = (thread: string) =>
      resolveOperationKey(markPriceMailHandled, handled, legacy, thread, '');
    expect(await key(USER_THREAD_1)).toBe(await key(USER_THREAD_2));
  });
});
