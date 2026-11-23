import { beforeEach, describe, expect, test } from 'bun:test';
import {
  mailRecordId,
  markPriceMailHandled,
  readPriceMail,
} from '../../src/agents/prices/price-mail';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import { listIntakeFiles, readIntakeFile } from '../../src/agents/prices/intake-tools';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { saveMail } from '../../src/agents/prices/price-state';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { type ToolContext } from '@business-ai/core';
import { isDomainError } from '@business-ai/core';
import { SUPPLIER_ID } from './support';
import {
  COLUMNS,
  EMPLOYEE_THREAD,
  SUPPLIER_EMAIL,
  buildFullPricesDeps,
  encode,
  mailMessage,
  skuCsv,
  type FullPricesDeps,
  USER_1,
  USER_THREAD_1,
  employeeContext,
} from './prices-support';

/** Составной id записи письма в ящике сотрудника. */
const rid = (id: string): string => mailRecordId(USER_1, id);
/** Ход сотрудника, чей ящик читается. */
const CTX = employeeContext(USER_1, USER_THREAD_1);

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

const EMPLOYEE_CTX: ToolContext = { ...CTX, threadId: EMPLOYEE_THREAD };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const CSV = skuCsv([['Болт', 10, 'B1'], ['Гайка', 5, 'G1']]);

describe('файлы от сотрудников', () => {
  test('listIntakeFiles показывает файлы своего треда и помечает сканы', async () => {
    await deps.intake.put(EMPLOYEE_THREAD, 'price.csv', encode(CSV));
    await deps.intake.put(EMPLOYEE_THREAD, 'scan.png', PNG_BYTES);
    await deps.intake.put('other-thread', 'other.csv', encode(CSV));
    const { files } = await listIntakeFiles.execute({}, deps, EMPLOYEE_CTX);
    expect(files.map((f) => [f.fileName, f.isScan])).toEqual([
      ['price.csv', false],
      ['scan.png', true],
    ]);
  });

  test('readIntakeFile читает файл по идентификатору из хранилища', async () => {
    const put = await deps.intake.put(EMPLOYEE_THREAD, 'price.csv', encode(CSV));
    const out = await readIntakeFile.execute({ path: put.path }, deps, EMPLOYEE_CTX);
    expect(out.markdown).toContain('Болт');
    expect(out.needsOcr).toBe(false);
  });

  test('readIntakeFile не читает путь диска и скан не разбирает', async () => {
    const error = await readIntakeFile
      .execute({ path: '../etc/passwd' }, deps, EMPLOYEE_CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('invalid_input');
    const scan = await deps.intake.put(EMPLOYEE_THREAD, 'scan.png', PNG_BYTES);
    const out = await readIntakeFile.execute({ path: scan.path }, deps, EMPLOYEE_CTX);
    expect(out).toMatchObject({ needsOcr: true, markdown: '' });
  });

  test('stagePriceRows принимает файл от сотрудника и запоминает источник', async () => {
    const put = await deps.intake.put(EMPLOYEE_THREAD, 'price.csv', encode(CSV));
    const staged = await stagePriceRows.execute(
      { path: put.path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      EMPLOYEE_CTX,
    );
    expect(staged.totalStaged).toBe(2);
    const meta = await deps.state.get(IMPORT_META_NAMESPACE, staged.importId);
    expect(meta).toMatchObject({ source: 'intake', fileName: 'price.csv' });
  });

  test('без хранилища приёма инструменты отвечают not_configured', async () => {
    const bare = { ...deps, intake: undefined };
    const error = await listIntakeFiles.execute({}, bare, CTX).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_configured');
  });
});

describe('почта с прайсами', () => {
  const attach = (fileName: string, text = CSV) => ({
    fileName,
    mimeType: 'text/csv',
    bytes: encode(text),
  });

  test('известный отправитель по адресу без учёта регистра, неизвестный — в отчёт', async () => {
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm1', from: SUPPLIER_EMAIL.toUpperCase(), attachments: [attach('p.csv')] }),
    );
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm2', from: 'stranger@spam.example', attachments: [attach('x.csv')] }),
    );
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm3', attachments: [] }));
    const out = await readPriceMail.execute({ senderQuery: 'spam.example' }, deps, CTX);
    expect(out.fetched).toBe(2);
    const known = out.mails.find((m) => m.messageId === rid('m1'));
    expect(known).toMatchObject({ known: true, supplierId: SUPPLIER_ID });
    expect(known?.attachments[0]).toMatchObject({ path: `mail:${rid('m1')}#0`, readable: true });
    // Неизвестный отправитель: по просьбе сотрудника письмо показано с пометкой «не из базы».
    expect(out.mails.map((m) => m.messageId)).toEqual([rid('m1'), rid('m2')]);
    expect(out.mails[1]).toMatchObject({ known: false, senderNotInBase: true });
    expect(out.ignoredPersonal).toBe(0);
    expect(out.mails.some((m) => m.messageId === rid('m3'))).toBe(false);
  });

  test('курсор сохраняется: повторный вызов не забирает письма заново', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('p.csv')] }));
    await readPriceMail.execute({}, deps, CTX);
    const again = await readPriceMail.execute({}, deps, CTX);
    expect(again.fetched).toBe(0);
    expect(again.mails.map((m) => m.messageId)).toEqual([rid('m1')]);
  });

  test('вложение разбирается через staging; письмо закрывается только после него', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('p.csv')] }));
    await readPriceMail.execute({}, deps, CTX);
    const page = await readPriceFile.execute({ path: `mail:${rid('m1')}#0` }, deps, CTX);
    expect(page.markdown).toContain('Болт');
    // До staging закрыть письмо нельзя, и в почте оно не помечается обработанным.
    const early = await markPriceMailHandled
      .execute({ messageId: rid('m1'), outcome: 'staged' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(early) && early.code).toBe('conflict');
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);

    const staged = await stagePriceRows.execute(
      { path: `mail:${rid('m1')}#0`, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      CTX,
    );
    expect(staged.totalStaged).toBe(2);
    const meta = await deps.state.get(IMPORT_META_NAMESPACE, staged.importId);
    expect(meta).toMatchObject({ source: 'mail', sender: SUPPLIER_EMAIL, subject: 'Прайс' });
    await markPriceMailHandled.execute({ messageId: rid('m1'), outcome: 'staged' }, deps, CTX);
    expect(deps.mailboxes.processedIds(USER_1)).toEqual(['m1']);
    expect((await readPriceMail.execute({}, deps, CTX)).mails).toEqual([]);
  });

  test('письмо неизвестного читается по просьбе, но не закрывается и не разбирается', async () => {
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm2', from: 'stranger@spam.example', attachments: [attach('x.csv')] }),
    );
    await readPriceMail.execute({ senderQuery: 'spam.example' }, deps, CTX);
    const closed = await markPriceMailHandled
      .execute({ messageId: rid('m2'), outcome: 'staged' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(closed) && closed.code).toBe('conflict');
    // Читать по просьбе можно, разбирать в базу нельзя.
    const read = await readPriceFile.execute({ path: `mail:${rid('m2')}#0` }, deps, CTX);
    expect(read.markdown).toContain('Болт');
    const staged: unknown = await stagePriceRows
      .execute(
        { path: `mail:${rid('m2')}#0`, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
        deps,
        CTX,
      )
      .catch((e: unknown) => e);
    expect(isDomainError(staged) && staged.code).toBe('conflict');
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);
  });

  test('отчёт о неизвестном: адрес не показывается, письмо не дублируется', async () => {
    // В ящике сотрудника неизвестные письма не сохраняются; запись осталась от прежних версий.
    await saveMail(deps, {
      id: rid('m2'),
      mailboxOwnerId: USER_1,
      mailboxMessageId: 'm2',
      from: 'stranger@spam.example',
      subject: 'Прайс',
      receivedAt: '2026-01-01T00:00:00.000Z',
      bodyExcerpt: 'текст',
      senderVerified: false,
      status: 'unknown',
      attachments: [],
    });
    await reportToManager.execute(
      { kind: 'unknown_sender', path: `mail:${rid('m2')}`, fileHash: rid('m2') },
      deps,
      CTX,
    );
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    // Отчёт уходит сотруднику, чей это ящик.
    expect(deps.chat.outbox[0]?.threadId).toBe(USER_THREAD_1);
    // Ящик личный: адрес неопознанного отправителя менеджеру не показывается.
    expect(text).not.toContain('stranger@spam.example');
    expect(text).toContain('не обработано');
    expect((await readPriceMail.execute({}, deps, CTX)).mails).toEqual([]);
  });

  test('скан во вложении: needsOcr, в отчёте подпись — имя вложения', async () => {
    deps.mailboxes.deliver(USER_1,
      mailMessage({
        id: 'm4',
        attachments: [{ fileName: 'scan.jpg', mimeType: 'image/jpeg', bytes: PNG_BYTES }],
      }),
    );
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: false });
    const page = await readPriceFile.execute({ path: `mail:${rid('m4')}#0` }, deps, CTX);
    expect(page.needsOcr).toBe(true);
    await reportToManager.execute(
      { kind: 'scan_skipped', path: `mail:${rid('m4')}#0`, fileHash: page.hash },
      deps,
      CTX,
    );
    expect(deps.chat.outbox[0]?.message?.text).toContain('«scan.jpg»');
    await markPriceMailHandled.execute(
      { messageId: rid('m4'), outcome: 'no_price_data' },
      deps,
      CTX,
    );
    expect((await readPriceMail.execute({}, deps, CTX)).mails).toEqual([]);
    expect(deps.mailboxes.processedIds(USER_1)).toEqual([]);
  });
});
