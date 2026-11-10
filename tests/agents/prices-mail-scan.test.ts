import { beforeEach, describe, expect, test } from 'bun:test';
import { IMAGE_TABLE_WARNINGS, VisionTableDocumentParser } from '@business-ai/adapters';
import { MAIL_FILE_NAMESPACE } from '../../src/agents/prices/deps';
import { mailFileKey } from '../../src/agents/prices/price-state';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { readPriceFile } from '../../src/agents/prices/read-price-file';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import type { ParsedDocument } from '@business-ai/core';
import { SUPPLIER_ID } from './support';
import {
  USER_1,
  USER_THREAD_1,
  buildFullPricesDeps,
  employeeContext,
  mailMessage,
  type FullPricesDeps,
} from './prices-support';

const TABLE = '| Наименование | Цена |\n|---|---|\n| Ручка | 15 |\n| Блокнот | 40 |';
const EMPTY_DOC: ParsedDocument = {
  text: '',
  tables: [],
  needsOcr: true,
  hasHiddenContent: false,
  hiddenSheets: [],
  truncated: false,
  warnings: [],
};
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
/** Размер сверх лимита вложения письма (50 МБ, этап 231). */
const OVERSIZE_BYTES = 50_000_001;
/** Крупное вложение в пределах лимита: прайс с картинками, прежний предел 10 МБ его резал. */
const LARGE_BYTES = 30_000_000;
const CTX = employeeContext(USER_1, USER_THREAD_1);
const rid = (id: string): string => mailRecordId(USER_1, id);

const visionParser = (): VisionTableDocumentParser =>
  new VisionTableDocumentParser(
    {
      async parse() {
        return EMPTY_DOC;
      },
      async parseWithImages() {
        return { document: EMPTY_DOC, images: [] };
      },
    },
    {
      async describe(images) {
        return {
          items: images.map((image) => ({
            name: image.name,
            source: image.source,
            status: 'ok' as const,
            text: TABLE,
          })),
          usage: { inputTokens: 0, outputTokens: 0, images: images.length },
        };
      },
    },
  );

const scanMail = (id: string, bytes: Uint8Array) =>
  mailMessage({
    id,
    senderAuth: 'verified',
    attachments: [{ fileName: 'scan.jpg', mimeType: 'image/jpeg', bytes }],
  });

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
});

describe('скан во вложении письма поставщика', () => {
  test('зрение включено: скан сохраняется и читается как таблица со staging', async () => {
    deps.parser = visionParser();
    deps.visionEnabled = true;
    deps.mailboxes.deliver(USER_1, scanMail('s1', IMAGE_BYTES));
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: true });
    const path = `mail:${rid('s1')}#0`;
    const page = await readPriceFile.execute({ path }, deps, CTX);
    expect(page.needsOcr).toBe(false);
    expect(page.warnings).toContain(IMAGE_TABLE_WARNINGS.recognized);
    const staged = await stagePriceRows.execute(
      {
        path,
        supplierId: SUPPLIER_ID,
        tableIndex: 0,
        headerRows: 1,
        columns: { name: 0, price: 1 },
        defaultCurrency: 'RUB',
        fromRow: 1,
        toRow: 3,
        reset: false,
      },
      deps,
      CTX,
    );
    expect(staged.staged).toBe(2);
  });

  test('зрение выключено флагом: прежнее поведение, скан не сохраняется', async () => {
    deps.parser = visionParser();
    deps.visionEnabled = false;
    deps.mailboxes.deliver(USER_1, scanMail('s2', IMAGE_BYTES));
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: false });
    expect(await deps.state.get(MAIL_FILE_NAMESPACE, mailFileKey(rid('s2'), 0))).toBeNull();
  });

  test('отправитель не подтверждён: скан не сохраняется и письмо нечитаемо', async () => {
    deps.parser = visionParser();
    deps.visionEnabled = true;
    const mail = { ...scanMail('s5', IMAGE_BYTES), senderAuth: 'unverified' as const };
    deps.mailboxes.deliver(USER_1, mail);
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: false });
    expect(await deps.state.get(MAIL_FILE_NAMESPACE, mailFileKey(rid('s5'), 0))).toBeNull();
  });

  test('парсер без чтения картинок: скан не сохраняется', async () => {
    deps.mailboxes.deliver(USER_1, scanMail('s3', IMAGE_BYTES));
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: false });
  });

  test('скан сверх лимита размера не сохраняется даже при включённом зрении', async () => {
    deps.parser = visionParser();
    deps.visionEnabled = true;
    deps.mailboxes.deliver(USER_1, scanMail('s4', new Uint8Array(OVERSIZE_BYTES)));
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: false });
  });

  test('вложение 30 МБ сохраняется (предел 50 МБ), сверх предела - нет', async () => {
    deps.parser = visionParser();
    deps.visionEnabled = true;
    const big = new Uint8Array(LARGE_BYTES);
    big.set(IMAGE_BYTES);
    deps.mailboxes.deliver(USER_1, scanMail('s6', big));
    const out = await readPriceMail.execute({}, deps, CTX);
    expect(out.mails[0]?.attachments[0]).toMatchObject({ isScan: true, readable: true });
    expect(await deps.state.get(MAIL_FILE_NAMESPACE, mailFileKey(rid('s6'), 0))).not.toBeNull();
  });
});
