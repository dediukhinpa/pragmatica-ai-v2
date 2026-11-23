import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@business-ai/core';
import { createScanPriceCopy } from '../../src/scan-price-copy';
import {
  configureTurnFileBuffer,
  createTurnFileStore,
  flushTurnFiles,
  resetTurnFileBufferForTests,
  runInTurnFileStore,
  turnFileChat,
} from '../../src/turn-file-buffer';
import {
  EMPLOYEE_THREAD,
  buildFullPricesDeps,
  employeeContext,
  type FullPricesDeps,
} from '../agents/prices-support';
import { MUG_INVOICE, PNG_HEAD, recognizedScan, scanParserOf, unreadScan } from './scan-fixtures';

/**
 * П5, этап 9v: скан-счёт в чате и просьба «измени стоимость кружек на 239 рублей и пересчитай».
 * Сотруднику уходит xlsx-копия с новой ценой и пересчитанными кодом суммой и итого; сам скан не
 * меняется; за ход уходит один файл.
 */

const SCAN_NAME = 'счёт кружки.png';
const NEW_PRICE = 239;
/** Сумма кружек после правки: 10 x 239. */
const MUG_SUM = 2390;
/** Итого до и после правки. */
const OLD_TOTAL = 5302.5;
const NEW_TOTAL = 5192.5;

let deps: FullPricesDeps;
let ctx: ToolContext;
let sent: Array<{ thread: string; name: string; text: string }>;

async function putScan(): Promise<string> {
  const stored = await deps.intake.put(EMPLOYEE_THREAD, SCAN_NAME, PNG_HEAD);
  return stored.path;
}

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  deps.parser = scanParserOf(recognizedScan(MUG_INVOICE));
  ctx = employeeContext('u-scan', EMPLOYEE_THREAD);
  sent = [];
  const realSend = deps.chat.sendFile.bind(deps.chat);
  deps.chat.sendFile = async (thread, file, key) => {
    sent.push({ thread, name: file.name, text: new TextDecoder().decode(file.content) });
    await realSend(thread, file, key);
  };
});

afterEach(() => {
  resetTurnFileBufferForTests();
});

describe('createScanPriceCopy: кружки на 239 и пересчёт', () => {
  test('копия xlsx: новая цена, пересчитанные сумма и итого, таблица было/стало', async () => {
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      { path, edits: [{ match: 'кружек', newPrice: NEW_PRICE }] },
      deps,
      ctx,
    );
    expect(out).toMatchObject({ status: 'sent', delivered: true, doubtful: [] });
    expect(out.oldTotal).toBe(OLD_TOTAL);
    expect(out.newTotal).toBe(NEW_TOTAL);
    expect(out.statedTotal).toBe(OLD_TOTAL);
    expect(out.rows[0]).toMatchObject({ oldPrice: 250, newPrice: NEW_PRICE, newSum: MUG_SUM });
    expect(out.table).toContain('Распознано со скана, сверьте');
    expect(out.table).toContain('| 1 | Кружка керамическая | 10 шт | 250 | 239 | 2500 | 2390 |');
    expect(out.table).toContain('| | Итого | | | | 5302,50 | 5192,50 |');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.thread).toBe(EMPLOYEE_THREAD);
    expect(sent[0]?.name).toBe('счёт кружки (копия).xlsx');
    const text = sent[0]?.text ?? '';
    expect(text).toContain('Кружка керамическая');
    expect(text).toContain('239');
    expect(text).toContain('2390');
    expect(text).toContain('5192.5');
    // Остальные позиции остались как в скане
    expect(text).toContain('Блюдце фарфоровое');
    expect(text).toContain('2400');
  });

  test('сам скан не меняется: байты в хранилище прежние', async () => {
    const path = await putScan();
    await createScanPriceCopy.execute(
      { path, edits: [{ match: 'кружек', newPrice: NEW_PRICE }] },
      deps,
      ctx,
    );
    const after = await deps.intake.read(EMPLOYEE_THREAD, path);
    expect([...after]).toEqual([...PNG_HEAD]);
  });

  test('нет такой позиции: файл не уходит, в ответе список позиций скана', async () => {
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      { path, edits: [{ match: 'тарелка', newPrice: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('no_match');
    expect(out.delivered).toBe(false);
    expect(out.message).toContain('Кружка керамическая');
    expect(sent).toHaveLength(0);
  });

  test('неоднозначная позиция: вопрос вместо угадывания', async () => {
    const text = [
      '1 Кружка керамическая 1 шт 10,00 10,00',
      '2 Кружка стеклянная 1 шт 20,00 20,00',
    ].join('\n');
    deps.parser = scanParserOf(recognizedScan(text));
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      { path, edits: [{ match: 'кружки', newPrice: 5 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('ambiguous');
    expect(sent).toHaveLength(0);
  });

  test('сомнительные позиции возвращаются в doubtful и не правятся', async () => {
    const text = [
      '1 Кружка керамическая 10 шт 250,00 2 500,00',
      '2 Блюдце фарфоровое 20 шт ??? 2 400,00',
    ].join('\n');
    deps.parser = scanParserOf(recognizedScan(text));
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      { path, edits: [{ match: 'кружек', newPrice: NEW_PRICE }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('sent');
    expect(out.doubtful.map((item) => item.name)).toEqual(['Блюдце фарфоровое']);
    expect(out.rows[1]).toMatchObject({ newPrice: null, newSum: 2400, changed: false });
    expect(out.message).toContain('Блюдце фарфоровое');
  });

  test('positions: исправленное моделью чтение, арифметика всё равно у кода', async () => {
    deps.parser = scanParserOf(recognizedScan('Текст с фото: ...'));
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      {
        path,
        edits: [{ match: 'кружка', newPrice: NEW_PRICE }],
        positions: [
          { name: 'Кружка керамическая', qty: 10, price: 250 },
          { name: 'Блюдце фарфоровое', qty: 20, price: 120, sum: 2400 },
        ],
      },
      deps,
      ctx,
    );
    expect(out.newTotal).toBe(MUG_SUM + 2400);
    expect(out.oldTotal).toBe(2500 + 2400);
  });

  test('нечитаемый скан: nothing_read, файл не уходит', async () => {
    deps.parser = scanParserOf(unreadScan());
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      { path, edits: [{ match: 'кружек', newPrice: NEW_PRICE }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('nothing_read');
    expect(sent).toHaveLength(0);
  });

  test('парсер не читает картинки: nothing_read без обращения к разбору', async () => {
    const parser = scanParserOf(recognizedScan(MUG_INVOICE));
    deps.parser = { parse: parser.parse };
    const path = await putScan();
    const out = await createScanPriceCopy.execute(
      { path, edits: [{ match: 'кружек', newPrice: NEW_PRICE }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('nothing_read');
    expect(parser.calls).toBe(0);
  });

  test('обычный файл с таблицей - не скан: отказ с отсылкой к обычной правке', async () => {
    const csv = new TextEncoder().encode('Наименование,Цена\nКружка,250');
    const stored = await deps.intake.put(EMPLOYEE_THREAD, 'прайс.csv', csv);
    deps.parser = {
      async parse() {
        return { ...recognizedScan(''), warnings: [], tables: [[['Наименование', 'Цена']]] };
      },
    };
    const out = await createScanPriceCopy.execute(
      { path: stored.path, edits: [{ match: 'кружка', newPrice: 1 }] },
      deps,
      ctx,
    );
    expect(out.status).toBe('not_a_scan');
    expect(sent).toHaveLength(0);
  });
});

describe('один файл за ход', () => {
  beforeEach(() => {
    configureTurnFileBuffer({ enabled: true });
  });

  test('два вызова за ход: уходит один файл со всеми правками хода', async () => {
    const path = await putScan();
    const memoryChat = deps.chat;
    const buffered = { ...deps, chat: turnFileChat(memoryChat) };
    const store = createTurnFileStore();
    const outputs = await runInTurnFileStore(store, async () => {
      const first = await createScanPriceCopy.execute(
        { path, edits: [{ match: 'кружек', newPrice: NEW_PRICE }] },
        buffered,
        ctx,
      );
      const second = await createScanPriceCopy.execute(
        { path, edits: [{ match: 'ложк', newPrice: 100 }] },
        buffered,
        ctx,
      );
      expect(memoryChat.outbox.filter((item) => item.file !== undefined)).toHaveLength(0);
      return { first, second };
    });
    await flushTurnFiles(store, 'ok');
    const files = memoryChat.outbox.flatMap((item) => (item.file === undefined ? [] : [item.file]));
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('счёт кружки (копия).xlsx');
    // Второй вызов несёт и правку первого: кружки 2390 + блюдца 2400 + ложки 5 x 100 = 5290
    expect(outputs.second.newTotal).toBe(MUG_SUM + 2400 + 500);
    expect(outputs.second.rows.filter((row) => row.changed)).toHaveLength(2);
    const text = new TextDecoder().decode(files[0]?.content);
    expect(text).toContain('5290');
    expect(text).toContain('2390');
  });
});
