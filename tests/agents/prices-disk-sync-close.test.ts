import { describe, expect, test } from 'bun:test';
import { FixedClock, MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  NO_FINAL_ACTION_CODE,
  closeUnreportedDiskSyncRun,
} from '../../src/agents/prices/disk-sync-close';
import { diskSyncThreadId } from '../../src/agents/prices/price-disk-sync';
import {
  queueDiskSyncOutcome,
  readDiskSyncOutcome,
  recordDiskSyncOutcome,
} from '../../src/agents/prices/disk-sync-outcome';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';

const RUN = '2026-10-27T05:46:24.397Z';
const PATH = 'Поставщик/прайс шары.xlsx';

async function queued() {
  const state = new MemoryWorkflowStateStore();
  const clock = new FixedClock();
  const threadId = diskSyncThreadId(PATH);
  await queueDiskSyncOutcome(state, threadId, RUN, PATH, clock.now().toISOString());
  return { deps: { state, clock }, threadId };
}

describe('итог файла импорта, который агент не записал', () => {
  test('«в очереди» после хода -> skipped с причиной no_result:<код>', async () => {
    const { deps, threadId } = await queued();
    expect(await closeUnreportedDiskSyncRun(deps, threadId, NO_FINAL_ACTION_CODE)).toBe(true);
    expect(await readDiskSyncOutcome(deps.state, threadId)).toMatchObject({
      status: 'skipped',
      reason: `no_result:${NO_FINAL_ACTION_CODE}`,
      run: RUN,
    });
  });

  test('записанный итог не затирается', async () => {
    const { deps, threadId } = await queued();
    await recordDiskSyncOutcome(deps, threadId, { status: 'written', rows: 3 });
    expect(await closeUnreportedDiskSyncRun(deps, threadId, NO_FINAL_ACTION_CODE)).toBe(false);
    expect((await readDiskSyncOutcome(deps.state, threadId))?.status).toBe('written');
  });

  test('отложенный агентом итог (needs_review) не меняется', async () => {
    const { deps, threadId } = await queued();
    await recordDiskSyncOutcome(deps, threadId, { status: 'skipped', reason: 'needs_review:x' });
    expect(await closeUnreportedDiskSyncRun(deps, threadId, 'validation_failed')).toBe(false);
    expect((await readDiskSyncOutcome(deps.state, threadId))?.reason).toBe('needs_review:x');
  });

  test('тред не из синхронизации диска и тред без записи - ничего не происходит', async () => {
    const { deps } = await queued();
    expect(await closeUnreportedDiskSyncRun(deps, 'chat-1', NO_FINAL_ACTION_CODE)).toBe(false);
    const other = diskSyncThreadId('Другой/файл.xlsx');
    expect(await closeUnreportedDiskSyncRun(deps, other, NO_FINAL_ACTION_CODE)).toBe(false);
    expect(await readDiskSyncOutcome(deps.state, other)).toBeNull();
  });
});

test('staging строк прайса не подчиняется пределу результатов хода (шаг записи)', () => {
  expect(stagePriceRows.budgetExempt).toBe(true);
});
