import { beforeEach, describe, expect, test } from 'bun:test';
import { DISK_SYNC_THREAD_PREFIX } from '../../src/agents/prices/price-disk-sync';
import { commitPriceImport } from '../../src/agents/prices/commit-price-import';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { previewPriceChanges, sendPriceChangeFile } from '../../src/agents/prices/price-changes';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { bindingThreadId } from '@business-ai/core';
import { SUPPLIER_ID, putFile } from './support';
import {
  COLUMNS,
  buildFullPricesDeps,
  skuCsv,
  skuItem,
  type FullPricesDeps,
} from './prices-support';

// Плановая обработка прайса с диска молчит: прайс уже на диске, а сообщения на каждый файл ТЗ
// не предусматривает. Сбои и работа, которую поручил сотрудник, сообщаются как раньше.

const EMPLOYEE_THREAD = bindingThreadId({ botId: 'bot-a', userId: 'ivanov' });

function ctxOf(threadId: string, operationId: string): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'prices',
    operationId,
    initiator:
      threadId === EMPLOYEE_THREAD ? { kind: 'user', userId: 'ivanov' } : { kind: 'scheduler' },
  });
}

const diskCtx = (operationId = 'op-disk'): ToolContext =>
  ctxOf(`${DISK_SYNC_THREAD_PREFIX}tick-1`, operationId);

let deps: FullPricesDeps;

beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', 10, 'B1')], 'seed');
});

/** Цепочка импорта прайса до файла изменений; возвращает ответ sendPriceChangeFile. */
async function importAndSend(ctx: ToolContext, price: number) {
  const path = `price-${price}.csv`;
  putFile(deps, path, skuCsv([['Болт', price, 'B1']]));
  const staged = await stagePriceRows.execute(
    { path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
    deps,
    ctx,
  );
  const input = { supplierId: SUPPLIER_ID, fileHash: staged.fileHash };
  const { diffHash } = await previewPriceChanges.execute(input, deps, ctx);
  await commitPriceImport.execute(input, deps, ctx);
  const sent = await sendPriceChangeFile.execute({ ...input, diffHash }, deps, ctx);
  return { sent, fileHash: staged.fileHash };
}

const report = (kind: 'import_done' | 'needs_review', fileHash: string, ctx: ToolContext) =>
  reportToManager.execute(
    { kind, path: 'price.csv', fileHash, updated: 1, needsReview: 0, issueCodes: [] },
    deps,
    ctx,
  );

describe('плановая обработка прайса с диска', () => {
  test('файл изменений и итог импорта не отправляются', async () => {
    const { sent, fileHash } = await importAndSend(diskCtx(), 11);
    expect(sent).toMatchObject({ delivered: false, skipped: 'scheduled_disk_run' });
    expect(await report('import_done', fileHash, diskCtx('op-r'))).toEqual({ delivered: false });
    expect(deps.chat.outbox).toHaveLength(0);
  });

  test('сбой (прайс не загружен) сообщается', async () => {
    const out = await report('needs_review', 'hash-bad', diskCtx('op-bad'));
    expect(out).toEqual({ delivered: true });
    expect(deps.chat.outbox).toHaveLength(1);
  });

  test('работа, которую поручил сотрудник, - файл ему, как раньше', async () => {
    const { sent } = await importAndSend(ctxOf(EMPLOYEE_THREAD, 'op-emp'), 13);
    expect(sent.delivered).toBe(true);
    expect(deps.chat.outbox.map((item) => item.threadId)).toContain(EMPLOYEE_THREAD);
  });
});
