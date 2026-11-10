import { beforeEach, describe, expect, test } from 'bun:test';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { commitPriceImport } from '../../src/agents/prices/commit-price-import';
import { loadPriceProposal } from '../../src/agents/prices/price-proposals';
import { previewPriceChanges, sendPriceChangeFile } from '../../src/agents/prices/price-changes';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { SUPPLIER_ID } from './support';
import {
  COLUMNS,
  buildFullPricesDeps,
  encode,
  mailMessage,
  skuCsv,
  skuItem,
  type FullPricesDeps,
  USER_1,
  USER_THREAD_1,
  employeeContext,
} from './prices-support';

/**
 * Модель доверия в агенте цен (этап 233): точный адрес из карточки поставщика снимает пометку
 * «отправитель не подтверждён», но цена из письма в базу не пишется при любом уровне доверия.
 */

const rid = (id: string): string => mailRecordId(USER_1, id);
const CTX = employeeContext(USER_1, USER_THREAD_1);
const BASE_PRICE = 10;
const MAIL_PRICE = 11;
const UNVERIFIED_MARK = 'Отправитель письма не подтверждён.';
const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', BASE_PRICE, 'B1')], 'seed');
});

async function stageMail(overrides: Partial<Parameters<typeof mailMessage>[0]> = {}): Promise<string> {
  const csv = skuCsv([['Болт', MAIL_PRICE, 'B1']]);
  const attachments = [{ fileName: 'p.csv', mimeType: 'text/csv', bytes: encode(csv) }];
  deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments, ...overrides }));
  await readPriceMail.execute({}, deps, CTX);
  const staged = await stagePriceRows.execute(
    { path: `mail:${rid('m1')}#0`, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
    deps,
    CTX,
  );
  return staged.fileHash;
}

async function commitAndSend(fileHash: string): Promise<{ done: unknown; text: string }> {
  const { diffHash } = await previewPriceChanges.execute(args(fileHash), deps, CTX);
  const done = await commitPriceImport.execute(args(fileHash), deps, CTX);
  await sendPriceChangeFile.execute({ ...args(fileHash), diffHash }, deps, CTX);
  return { done, text: deps.chat.outbox.map((item) => item.message?.text ?? '').join('\n') };
}

const basePrice = async () => (await deps.prices.listBySupplier(SUPPLIER_ID))[0]?.price;
const proposalOf = (fileHash: string) =>
  loadPriceProposal(deps.state, SUPPLIER_ID, stagingImportId(SUPPLIER_ID, fileHash));

describe('агент цен: доверие к отправителю письма', () => {
  test('модель выключена: письмо с адреса поставщика остаётся неподтверждённым', async () => {
    const fileHash = await stageMail();
    const { text } = await commitAndSend(fileHash);
    expect((await proposalOf(fileHash))?.senderVerified).toBe(false);
    expect(text).toContain(UNVERIFIED_MARK);
  });

  test('модель включена: точный адрес из карточки - доверенный, цена в базу всё равно не пишется', async () => {
    deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
    const fileHash = await stageMail();
    const { done, text } = await commitAndSend(fileHash);
    expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written' });
    expect(await basePrice()).toBe(BASE_PRICE);
    expect((await proposalOf(fileHash))?.senderVerified).toBe(true);
    expect(text).not.toContain(UNVERIFIED_MARK);
  });

  test('модель включена, адреса нет в базе: письмо неопознанное, не доверенное', async () => {
    deps.senderTrust = { policy: { websiteDomain: false, replyThread: false } };
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({
        id: 'x1',
        from: 'stranger@unknown.example',
        attachments: [{ fileName: 'p.csv', mimeType: 'text/csv', bytes: encode('a;b\n1;2') }],
      }),
    );
    const listed = await readPriceMail.execute({}, deps, CTX);
    expect(JSON.stringify(listed)).not.toContain('"senderVerified":true');
  });

  test('подтверждённый DKIM (senderAuth) без модели доверия тоже доверенный, цена не пишется', async () => {
    const fileHash = await stageMail({ senderAuth: 'verified' });
    const { done } = await commitAndSend(fileHash);
    expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written' });
    expect(await basePrice()).toBe(BASE_PRICE);
  });

  test('оба ослабления включены, DKIM выровнен, ответ в наш тред: цена всё равно не пишется', async () => {
    deps.senderTrust = { policy: { websiteDomain: true, replyThread: true } };
    const fileHash = await stageMail({
      senderAuth: 'verified',
      dkim: 'aligned',
      inReplyTo: 'our-message-1',
    });
    const { done } = await commitAndSend(fileHash);
    expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written' });
    expect(await basePrice()).toBe(BASE_PRICE);
  });
});
