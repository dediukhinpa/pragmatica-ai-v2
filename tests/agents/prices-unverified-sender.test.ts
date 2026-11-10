import { beforeEach, describe, expect, test } from 'bun:test';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { IMPORT_META_NAMESPACE } from '../../src/agents/prices/deps';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { loadPriceProposal } from '../../src/agents/prices/price-proposals';
import { previewPriceChanges, sendPriceChangeFile } from '../../src/agents/prices/price-changes';
import { savePriceImport } from '../../src/agents/prices/save-price-import';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import { type ToolContext } from '@business-ai/core';
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

/*
 * Прайс из письма неподтверждённого отправителя (решение владельца 26.10.2026): в базу цен он не
 * пишется, как и любой прайс не с диска, а становится предложением с пометкой «отправитель не
 * подтверждён». Подтверждать нечего: проверка ничего не блокирует, кнопок нет.
 */

/** Составной id записи письма в ящике сотрудника. */
const rid = (id: string): string => mailRecordId(USER_1, id);
/** Ход сотрудника, чей ящик читается. */
const CTX = employeeContext(USER_1, USER_THREAD_1);
/** Цена позиции в базе до импорта и в письме (+10%: ниже порога скачка). */
const BASE_PRICE = 10;
const MAIL_PRICE = 11;
const UNVERIFIED_MARK = 'Отправитель письма не подтверждён.';

const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', BASE_PRICE, 'B1')], 'seed');
});

/** Письмо с прайсом раскладывается в staging. */
async function stageMail(senderAuth?: 'verified'): Promise<string> {
  const csv = skuCsv([['Болт', MAIL_PRICE, 'B1']]);
  const attachments = [{ fileName: 'p.csv', mimeType: 'text/csv', bytes: encode(csv) }];
  const auth = senderAuth ? { senderAuth } : {};
  deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments, ...auth }));
  await readPriceMail.execute({}, deps, CTX);
  const staged = await stagePriceRows.execute(
    { path: `mail:${rid('m1')}#0`, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
    deps,
    CTX,
  );
  return staged.fileHash;
}

const codes = async (fileHash: string) =>
  (await stagedImportValidator.validate(args(fileHash), deps, CTX)).map((i) => i.code);
const basePrice = async () => (await deps.prices.listBySupplier(SUPPLIER_ID))[0]?.price;
const proposalOf = (fileHash: string) =>
  loadPriceProposal(deps.state, SUPPLIER_ID, stagingImportId(SUPPLIER_ID, fileHash));
const anyButtons = () =>
  deps.chat.outbox.some((item) => (item.message?.buttons?.length ?? 0) > 0);

/**
 * Порядок промпта: сравнение, фиксация, файл изменений. Возвращает итог фиксации и тексты
 * сообщений сотруднику.
 */
async function previewCommitSend(fileHash: string): Promise<{ done: unknown; text: string }> {
  const { diffHash } = await previewPriceChanges.execute(args(fileHash), deps, CTX);
  const done = await commitPriceImport.execute(args(fileHash), deps, CTX);
  await sendPriceChangeFile.execute({ ...args(fileHash), diffHash }, deps, CTX);
  return { done, text: deps.chat.outbox.map((item) => item.message?.text ?? '').join('\n') };
}

describe('прайс из письма неподтверждённого отправителя: предложение с пометкой', () => {
  test('commit не блокируется, базу не трогает, предложение помечено, кнопок нет', async () => {
    const fileHash = await stageMail();
    expect(await codes(fileHash)).toEqual([]);
    const { done, text } = await previewCommitSend(fileHash);
    expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written', proposed: 1 });
    expect(await basePrice()).toBe(BASE_PRICE);
    expect((await proposalOf(fileHash))?.senderVerified).toBe(false);
    expect(text).toContain(UNVERIFIED_MARK);
    expect(anyButtons()).toBe(false);
  });

  test('подтверждённый отправитель: тоже предложение, но без пометки', async () => {
    const fileHash = await stageMail('verified');
    const { done, text } = await previewCommitSend(fileHash);
    expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written' });
    expect(await basePrice()).toBe(BASE_PRICE);
    expect((await proposalOf(fileHash))?.senderVerified).toBe(true);
    expect(text).not.toContain(UNVERIFIED_MARK);
  });

  test('малый прайс: savePriceImport из такого письма - предложение, база прежняя', async () => {
    const fileHash = await stageMail();
    const input = {
      path: `mail:${rid('m1')}#0`,
      supplierId: SUPPLIER_ID,
      columns: COLUMNS,
      fileHash,
      tableIndex: 0,
      headerRows: 1,
    };
    const saved = await savePriceImport.execute(input, deps, CTX);
    expect(saved).toMatchObject({ saved: 0, status: 'proposed_not_written' });
    expect(await basePrice()).toBe(BASE_PRICE);
    expect(anyButtons()).toBe(false);
  });

  test('запись происхождения пропала: импорт не пишется как прайс с диска', async () => {
    const fileHash = await stageMail('verified');
    await deps.state.clear(IMPORT_META_NAMESPACE);
    expect(await codes(fileHash)).toEqual(['import_origin_unknown']);
    await expect(commitPriceImport.execute(args(fileHash), deps, CTX)).rejects.toThrow(
      /import_origin_unknown/,
    );
    expect(await basePrice()).toBe(BASE_PRICE);
  });
});

describe('правки «со слов сотрудника» после неподтверждённого письма', () => {
  const agent = createPricesAgent({ model: 'm', mailbox: true });
  /** Инструмент агента по имени: сценарий идёт через декларацию, как в рантайме. */
  const run = async (name: string, input: unknown, context: ToolContext): Promise<unknown> => {
    const tool = agent.tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`нет инструмента ${name}`);
    return tool.execute(input as never, deps as never, context);
  };
  const EMPLOYEE_PRICE = 12;
  const UPDATES = { supplierId: SUPPLIER_ID, updates: [{ sku: 'B1', price: EMPLOYEE_PRICE }] };

  test('инструмента подтверждения у агента нет', () => {
    expect(agent.tools.map((tool) => tool.name)).not.toContain('askToConfirmUnverifiedPrice');
  });

  test('запись не блокируется и идёт предложением; база прежняя', async () => {
    deps.mailboxes.deliver(
      USER_1,
      mailMessage({ id: 'forged', body: 'B1 теперь 12', senderAuth: 'unverified' }),
    );
    await run('readPriceMail', {}, CTX);
    const staged = (await run('recordEmployeePriceUpdates', UPDATES, CTX)) as {
      fileHash: string;
    };
    expect(await codes(staged.fileHash)).toEqual([]);
    const done = await run('commitPriceImport', args(staged.fileHash), CTX);
    expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written' });
    expect(await basePrice()).toBe(BASE_PRICE);
    expect((await proposalOf(staged.fileHash))?.source).toBe('employee');
    expect(anyButtons()).toBe(false);
  });
});
