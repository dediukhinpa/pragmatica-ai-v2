import { describe, expect, test } from 'bun:test';
import { MemoryMailboxDirectory } from '@business-ai/adapters';
import { createToolContext, type ToolContext } from '@business-ai/core';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { saveSelection } from '../../src/agents/order-calc/state';
import { MAIL_OWNER, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const CHAT = 'order-calc/u1';

function context(): ToolContext {
  return createToolContext({
    threadId: CHAT,
    agentId: 'order-calc',
    operationId: 'op-new-choice',
    initiator: { kind: 'user', userId: MAIL_OWNER },
  });
}

async function select(deps: OrderTestDeps, supplierIds: string[]): Promise<void> {
  await saveSelection(deps, {
    requestId: REQUEST_ID,
    supplierIds,
    createdAt: deps.clock.now().toISOString(),
  });
}

function shown(deps: OrderTestDeps): string[] {
  return deps.chat.outbox.map((record) => record.message?.text ?? '');
}

async function setup(): Promise<OrderTestDeps> {
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(MAIL_OWNER, 'ivanov@company.test');
  return buildOrderDeps({ mailboxes });
}

describe('prepareSupplierRequestText: письма только новым выбранным', () => {
  test('выбор s1, затем s2: второе обращение даёт одно письмо новому поставщику', async () => {
    const deps = await setup();
    await select(deps, ['s1']);
    const first = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      context(),
    );
    expect(first.shownSupplierIds).toEqual(['s1']);
    // Выбор копит прежних (так устроен recordSelection): s1 остаётся в нём вместе с s2.
    await select(deps, ['s1', 's2']);
    const before = shown(deps).length;
    const second = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      context(),
    );
    expect(second.shownSupplierIds).toEqual(['s2']);
    const added = shown(deps).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('Поставщик: Болтик');
    expect(added[0]).not.toContain('МеталлТорг');
  });

  test('явная просьба includePreviouslyChosen собирает письма и прежним', async () => {
    const deps = await setup();
    await select(deps, ['s1']);
    await prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, deps, context());
    await select(deps, ['s1', 's2']);
    await prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, deps, context());
    const before = shown(deps).length;
    const again = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID, includePreviouslyChosen: true },
      deps,
      context(),
    );
    expect(again.shownSupplierIds).toEqual(['s1', 's2']);
    expect(shown(deps).slice(before)).toHaveLength(2);
  });

  test('новых нет, а текст запрошен: не молчим, показываем выбранных', async () => {
    const deps = await setup();
    await select(deps, ['s1']);
    await prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, deps, context());
    const again = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID, values: {}, kind: 'custom_product' },
      deps,
      context(),
    );
    expect(again.shownSupplierIds).toEqual(['s1']);
  });
});
