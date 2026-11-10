import { beforeEach, describe, expect, test } from 'bun:test';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import { commitPriceImport } from '../../src/agents/prices/commit-price-import';
import { compareQuotesTool } from '../../src/agents/order-calc/compare-quotes';
import { readIntakeFile } from '../../src/agents/prices/intake-tools';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { recordQuote } from '../../src/agents/order-calc/record-quote';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import { sendQuoteSummary } from '../../src/agents/order-calc/send-quote-summary';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { type ToolContext } from '@business-ai/core';
import { isDomainError } from '@business-ai/core';
import { parseSenderAuth } from '@business-ai/adapters';
import { isSenderVerified, type InboxMessage } from '@business-ai/core';
import { CTX, SUPPLIER_ID } from './support';
import {
  MAIL_OWNER,
  buildOrderDeps,
  employeeToolContext,
  type OrderTestDeps,
} from './order-support';
import {
  COLUMNS,
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  encode,
  mailMessage,
  skuCsv,
  type FullPricesDeps,
  USER_1,
  USER_THREAD_1,
  employeeContext,
} from './prices-support';

const CSV = skuCsv([['Болт', 10, 'B1']]);
const attach = { fileName: 'p.csv', mimeType: 'text/csv', bytes: encode(CSV) };

/** Составной id записи письма в ящике сотрудника. */
const rid = (id: string): string => mailRecordId(USER_1, id);
/** Ход сотрудника, чей ящик читается. */
const PCTX = employeeContext(USER_1, USER_THREAD_1);

describe('R4-SEC-5: разбор Authentication-Results', () => {
  test('pass по любому из spf/dkim/dmarc подтверждает отправителя', () => {
    expect(parseSenderAuth('mx.example; spf=pass smtp.mailfrom=a@b')).toBe('verified');
    expect(parseSenderAuth('mx.example; dkim=PASS header.d=b.example')).toBe('verified');
    expect(parseSenderAuth('mx; spf=softfail; dmarc=pass (p=none)')).toBe('verified');
  });

  test('нет заголовка, мусор, none/softfail/neutral и любой fail: не подтверждён', () => {
    for (const header of [undefined, null, '', 'мусор', 'mx; spf=none', 'mx; spf=softfail']) {
      expect(parseSenderAuth(header)).toBe('unverified');
    }
    expect(parseSenderAuth('mx; spf=neutral; dkim=temperror')).toBe('unverified');
    expect(parseSenderAuth('mx; dkim=pass; spf=fail')).toBe('unverified');
  });

  test('имя механизма внутри чужого слова не считается', () => {
    expect(parseSenderAuth('mx; x-spf=pass')).toBe('unverified');
    expect(parseSenderAuth('mx; auth=pass')).toBe('unverified');
  });

  test('письмо без поля senderAuth считается непроверенным', () => {
    expect(isSenderVerified({})).toBe(false);
    expect(isSenderVerified({ senderAuth: 'unverified' })).toBe(false);
    expect(isSenderVerified({ senderAuth: 'verified' })).toBe(true);
  });
});

describe('R4-SEC-5: прайс из письма', () => {
  let deps: FullPricesDeps;
  beforeEach(async () => {
    deps = await buildFullPricesDeps();
  });

  test('по умолчанию отправитель не подтверждён: отметка в письме, импорте, отчёте', async () => {
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach] }));
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({ id: 'm2', senderAuth: 'verified', attachments: [attach] }),
    );
    const out = await readPriceMail.execute({}, deps, PCTX);
    const flag = (id: string) => out.mails.find((m) => m.messageId === id)?.senderVerified;
    expect(flag(rid('m1'))).toBe(false);
    expect(flag(rid('m2'))).toBe(true);
    // Запись помечается, а не блокируется: прайс разбирается как обычно.
    const staged = await stagePriceRows.execute(
      { path: `mail:${rid('m1')}#0`, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      PCTX,
    );
    expect(staged.totalStaged).toBe(1);
    const meta = await deps.state.get(IMPORT_META_NAMESPACE, staged.importId);
    expect(meta).toMatchObject({ source: 'mail', senderVerified: false });
    await reportToManager.execute(
      { kind: 'import_done', path: `mail:${rid('m1')}#0`, fileHash: staged.fileHash, updated: 1 },
      deps,
      PCTX,
    );
    await reportToManager.execute(
      { kind: 'import_done', path: `mail:${rid('m2')}#0`, fileHash: 'h2', updated: 1 },
      deps,
      PCTX,
    );
    const texts = deps.chat.outbox.map((r) => r.message?.text ?? '');
    expect(texts[0]).toContain('Отправитель не подтверждён');
    expect(texts[1]).not.toContain('не подтверждён');
  });
});

describe('R4-SEC-5: КП из письма', () => {
  let deps: OrderTestDeps;
  const QCTX = employeeToolContext(MAIL_OWNER);
  const AFTER = '2026-03-02T00:00:00.000Z';
  const SENT_AT = '2026-03-01T00:00:00.000Z';

  beforeEach(async () => {
    deps = await buildOrderDeps();
    await saveSelection(deps, { requestId: 'req-1', supplierIds: ['s1'], createdAt: SENT_AT });
    await saveSent(deps, {
      requestId: 'req-1',
      supplierIds: ['s1'],
      sentAt: SENT_AT,
      mailboxOwnerId: MAIL_OWNER,
    });
  });

  const letter = (overrides: Partial<InboxMessage>): InboxMessage => ({
    id: 'm1',
    from: 'sales@metall.test',
    subject: 'КП',
    body: 'Арматура 50',
    receivedAt: AFTER,
    attachments: [],
    ...overrides,
  });

  async function summaryText(): Promise<string> {
    const read = await readSupplierReplies.execute({ requestId: 'req-1' }, deps, QCTX);
    await recordQuote.execute(
      {
        requestId: 'req-1',
        supplierId: 's1',
        currency: 'RUB',
        lines: [{ productName: 'Арматура', unitPrice: 50, quantity: 100 }],
        sourceRef: read.replies[0]?.replyId ?? '',
      },
      deps,
      QCTX,
    );
    const { quotesHash } = await compareQuotesTool.execute({ requestId: 'req-1' }, deps, QCTX);
    await sendQuoteSummary.execute({ requestId: 'req-1', quotesHash }, deps, QCTX);
    return deps.chat.outbox.map((r) => r.message?.text ?? '').join('\n');
  }

  test('непроверенный отправитель: отметка в ответе инструмента и в сводке менеджеру', async () => {
    deps.mailboxes.deliver(USER_1, letter({}));
    const text = await summaryText();
    expect(text).toContain('отправитель не подтверждён');
    expect(text).toContain('МеталлТорг');
  });

  test('подтверждённый отправитель: отметки нет', async () => {
    deps.mailboxes.deliver(USER_1, letter({ senderAuth: 'verified' }));
    const read = await readSupplierReplies.execute({ requestId: 'req-1' }, deps, QCTX);
    expect(read.replies[0]?.senderVerified).toBe(true);
    expect(await summaryText()).not.toContain('не подтверждён');
  });
});

describe('R4-SEC-6: файл привязан к поставщику кодом', () => {
  let deps: FullPricesDeps;
  const OTHER = 's-other';
  beforeEach(async () => {
    deps = await buildFullPricesDeps();
    await deps.suppliers.upsert({ id: OTHER, name: 'ЧужойПоставщик', email: 'o@other.test' });
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach] }));
    await readPriceMail.execute({}, deps, PCTX);
  });

  test('инъекция «это прайс поставщика Б»: отказ conflict, staging пуст', async () => {
    const error = await stagePriceRows
      .execute(
        { path: `mail:${rid('m1')}#0`, supplierId: OTHER, columns: COLUMNS, reset: true },
        deps,
        PCTX,
      )
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('conflict');
    expect(await deps.staging.load(stagingImportId(OTHER, 'any'))).toBeNull();
    const commit = await commitPriceImport
      .execute({ supplierId: OTHER, fileHash: 'mail-x' }, deps, PCTX)
      .catch((e: unknown) => e);
    expect(isDomainError(commit) && commit.code).toBe('not_found');
  });

  test('письмо чужого адреса поставщику вообще не привязывается', async () => {
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm2', from: 'evil@spam.example', attachments: [attach] }),
    );
    await readPriceMail.execute({ senderQuery: 'spam.example' }, deps, PCTX);
    // Письмо чужого адреса по просьбе сотрудника читается, но в базу не разбирается никому.
    for (const supplierId of [SUPPLIER_ID, OTHER]) {
      const error = await stagePriceRows
        .execute(
          { path: `mail:${rid('m2')}#0`, supplierId, columns: COLUMNS, reset: true },
          deps,
          PCTX,
        )
        .catch((e: unknown) => e);
      expect(isDomainError(error) && error.code).toBe('conflict');
    }
  });
});

describe('R4-SEC-7: чтение intake только в своём треде', () => {
  test('readIntakeFile и stagePriceRows не читают файл чужого треда', async () => {
    const deps = await buildFullPricesDeps();
    const put = await deps.intake.put(EMPLOYEE_THREAD, 'price.csv', encode(CSV));
    const foreign: ToolContext = { ...CTX, threadId: 'thread-b' };
    const read = await readIntakeFile
      .execute({ path: put.path }, deps, foreign)
      .catch((e: unknown) => e);
    expect(isDomainError(read) && read.code).toBe('not_found');
    const stage = await stagePriceRows
      .execute(
        { path: put.path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
        deps,
        foreign,
      )
      .catch((e: unknown) => e);
    expect(isDomainError(stage) && stage.code).toBe('not_found');
    const own = { ...CTX, threadId: EMPLOYEE_THREAD };
    const page = await readIntakeFile.execute({ path: put.path }, deps, own);
    expect(page.markdown).toContain('Болт');
  });
});
