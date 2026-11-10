import { beforeEach, describe, expect, test } from 'bun:test';
import { commitPriceImport } from '../../src/agents/prices/commit-price-import';
import { previewPriceChanges, sendPriceChangeFile } from '../../src/agents/prices/price-changes';
import { recordEmployeePriceUpdates } from '../../src/agents/prices/employee-updates';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { type ToolContext } from '@business-ai/core';
import { isDomainError } from '@business-ai/core';
import { CTX, MANAGER_THREAD, SUPPLIER_ID, putFile } from './support';
import {
  EMPLOYEE_THREAD,
  COLUMNS,
  RESPONSIBLE_THREAD,
  SCHEDULER_CTX,
  buildFullPricesDeps,
  skuCsv,
  skuItem,
  stageDiskCsv,
  type FullPricesDeps,
} from './prices-support';

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(
    SUPPLIER_ID,
    [skuItem('Болт', 10, 'B1'), skuItem('Гайка', 5, 'G1'), skuItem('Шайба', 1, 'S1')],
    'seed',
    { sourceFile: 'price.csv' },
  );
});

const ROWS: Array<[string, number, string]> = [
  ['Болт', 12, 'B1'],
  ['Гайка', 5, 'G1'],
  ['Винт', 7, 'V1'],
];
const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });

describe('previewPriceChanges', () => {
  test('новые, снятые, изменения в процентах; фиксации не происходит', async () => {
    const { fileHash } = await stageDiskCsv(deps, ROWS);
    const out = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    expect(out.counts).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      jumps: 0,
      review: 0,
      unchanged: 1,
    });
    expect(out.changedExamples[0]).toMatchObject({ sku: 'B1', changePct: 20 });
    expect(out).not.toHaveProperty('approvalStatus');
    // База не тронута: сравнение выполняется ДО фиксации.
    expect((await deps.prices.listBySupplier(SUPPLIER_ID)).map((i) => i.sku)).toEqual([
      'B1',
      'G1',
      'S1',
    ]);
  });

  test('без staging — not_found', async () => {
    const error = await previewPriceChanges
      .execute(args('нет'), deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_found');
  });

  test('примеров не больше лимита: полный список хранится для файла', async () => {
    const many: Array<[string, number, string]> = Array.from({ length: 40 }, (_, i) => [
      `Товар ${i}`,
      i + 1,
      `T${i}`,
    ]);
    const { fileHash } = await stageDiskCsv(deps, many);
    const out = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    expect(out.counts.added).toBe(40);
    expect(out.changedExamples.length).toBeLessThanOrEqual(20);
  });
});

/** Ход сотрудника, поручившего работу: ему уходит файл изменений. */
const EMPLOYEE_CTX: ToolContext = {
  ...CTX,
  threadId: EMPLOYEE_THREAD,
  initiator: { kind: 'user', userId: 'employee-1' },
};

describe('sendPriceChangeFile', () => {
  async function prepare(ctx: ToolContext = EMPLOYEE_CTX) {
    // Владелец работы запоминается при сборке staging: файл получит тот, кто поручил работу.
    putFile(deps, 'price.csv', skuCsv(ROWS));
    const staged = await stagePriceRows.execute(
      { path: 'price.csv', supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      deps,
      ctx,
    );
    const fileHash = staged.fileHash;
    const preview = await previewPriceChanges.execute(args(fileHash), deps, ctx);
    return { fileHash, diffHash: preview.diffHash };
  }

  test('плановый запуск без владельца: файл уходит ответственному', async () => {
    const { fileHash, diffHash } = await prepare(SCHEDULER_CTX);
    await sendPriceChangeFile.execute({ ...args(fileHash), diffHash }, deps, SCHEDULER_CTX);
    const threads = deps.chat.outbox.map((o) => o.threadId);
    expect(threads).toEqual([RESPONSIBLE_THREAD, RESPONSIBLE_THREAD]);
  });

  test('файл с пятью листами и сообщение уходят сотруднику, поручившему работу', async () => {
    const { fileHash, diffHash } = await prepare();
    const out = await sendPriceChangeFile.execute(
      { ...args(fileHash), diffHash },
      deps,
      EMPLOYEE_CTX,
    );
    expect(out.delivered).toBe(true);
    const [message, file] = deps.chat.outbox;
    expect(message?.threadId).toBe(EMPLOYEE_THREAD);
    expect(message?.message?.text).toContain(
      'подготовлено для внесения в корпоративный диск, проверьте и внесите',
    );
    expect(message?.message?.text).toContain('ждут фиксации');
    expect(file?.threadId).toBe(EMPLOYEE_THREAD);
    const text = new TextDecoder().decode(file?.file?.content);
    for (const sheet of ['Изменения', 'Новые', 'Снятые', 'На проверку', 'Источник']) {
      expect(text).toContain(`# ${sheet}`);
    }
    expect(text).toContain('B1;Болт;10;12;20;RUB');
    expect(text).toContain('V1;Винт;7;RUB');
    expect(text).toContain('S1;Шайба;1;RUB');
    expect(text).toContain('Файл с сетевого диска');
    expect(text).toContain('ожидает фиксации');
  });

  test('после фиксации: статус «зафиксировано», файл тот же набор', async () => {
    const { fileHash, diffHash } = await prepare();
    await commitPriceImport.execute(args(fileHash), deps, CTX);
    await sendPriceChangeFile.execute({ ...args(fileHash), diffHash }, deps, CTX);
    const text = new TextDecoder().decode(deps.chat.outbox[1]?.file?.content);
    expect(text).toContain('зафиксировано');
    expect(deps.chat.outbox[0]?.message?.text).toContain('уже записаны в базу');
  });

  test('идемпотентно по importId и хэшу: повтор не шлёт второй файл', async () => {
    const { fileHash, diffHash } = await prepare();
    const input = { ...args(fileHash), diffHash };
    await sendPriceChangeFile.execute(input, deps, CTX);
    await sendPriceChangeFile.execute(input, deps, CTX);
    expect(deps.chat.outbox).toHaveLength(2);
    expect(sendPriceChangeFile.idempotencyKey?.(input)).toBe(
      sendPriceChangeFile.idempotencyKey?.({ ...input }),
    );
    expect(sendPriceChangeFile.idempotencyKey?.({ ...input, diffHash: 'другой' })).not.toBe(
      sendPriceChangeFile.idempotencyKey?.(input),
    );
  });

  test('устаревший diffHash и отсутствие preview — ошибки', async () => {
    const { fileHash } = await prepare();
    const stale = await sendPriceChangeFile
      .execute({ ...args(fileHash), diffHash: 'старый' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(stale) && stale.code).toBe('conflict');
    const none = await sendPriceChangeFile
      .execute({ ...args('другой-файл'), diffHash: 'x' }, deps, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(none) && none.code).toBe('not_found');
  });

  test('без владельца и ответственного — менеджер; без выгрузки — not_configured', async () => {
    const { fileHash, diffHash } = await prepare(SCHEDULER_CTX);
    const noThread = { ...deps, responsibleThreadId: undefined };
    await sendPriceChangeFile.execute({ ...args(fileHash), diffHash }, noThread, SCHEDULER_CTX);
    expect(deps.chat.outbox[0]?.threadId).toBe(MANAGER_THREAD);
    const noExporter = { ...deps, tableExporter: undefined };
    const error = await sendPriceChangeFile
      .execute({ ...args(fileHash), diffHash: 'x' }, noExporter, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('not_configured');
  });

  test('скачок попадает на лист «На проверку» с пометкой «проверьте перед внесением»', async () => {
    const { fileHash } = await stageDiskCsv(deps, [['Болт', 40, 'B1']]);
    const preview = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    await sendPriceChangeFile.execute({ ...args(fileHash), diffHash: preview.diffHash }, deps, CTX);
    const text = new TextDecoder().decode(deps.chat.outbox[1]?.file?.content);
    // Ячейка с запятой экранируется кавычками в csv-заглушке.
    expect(text).toContain('Скачок цены;"было 10, стало 40 (+300%); проверьте перед внесением"');
  });

  test('правка сотрудника: в «Источнике» сотрудник и его пометка', async () => {
    const ctx: ToolContext = {
      ...CTX,
      threadId: EMPLOYEE_THREAD,
      initiator: { kind: 'user', userId: 'employee-1' },
    };
    const rec = await recordEmployeePriceUpdates.execute(
      { supplierId: SUPPLIER_ID, updates: [{ sku: 'B1', price: 11, note: 'по телефону' }] },
      deps,
      ctx,
    );
    const fileHash = rec.fileHash ?? '';
    const preview = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    await sendPriceChangeFile.execute({ ...args(fileHash), diffHash: preview.diffHash }, deps, CTX);
    const text = new TextDecoder().decode(deps.chat.outbox[1]?.file?.content);
    expect(text).toContain('Сообщение сотрудника');
    expect(text).toContain(`Передал сотрудник (чат);${EMPLOYEE_THREAD}`);
    expect(text).toContain('Пометка сотрудника;по телефону');
  });
});
