import { beforeEach, describe, expect, test } from 'bun:test';
import { askManagerToChoose } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import {
  choiceToken,
  recordChoiceButton,
  recordChoiceDone,
} from '../../src/agents/order-calc/choice-confirmation';
import { loadSelection, loadSent } from '../../src/agents/order-calc/state';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { recordSelection, selectionValidator } from '../../src/agents/order-calc/record-selection';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { CTX } from './support';
import {
  REQUEST_ID,
  buildOrderDeps,
  deliverReply,
  employeeToolContext,
  prepareRequestsText,
  type OrderTestDeps,
} from './order-support';

const MANAGER = 'm';

let deps: OrderTestDeps;
let version = '';

beforeEach(async () => {
  deps = await buildOrderDeps();
  // Заявку ведёт менеджер: письма уходят с его ящика, ответы приходят в него же.
  deps.mailboxes.connect(MANAGER, 'manager@company.test');
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  version = (await buildShortlist.execute(input, deps, CTX)).version;
  await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX).catch(() => {});
});

const token = () => choiceToken(REQUEST_ID, version);
const press = (id: string) =>
  recordChoiceButton(deps.state, deps.clock, {
    supplierId: `${token()}:${id}`,
    userId: MANAGER,
    threadId: CTX.threadId,
  });
const done = () =>
  recordChoiceDone(deps.state, deps.clock, {
    token: token(),
    userId: MANAGER,
    threadId: CTX.threadId,
  });

describe('R4-AGT-1: выбор копится нажатиями и фиксируется по «Готово»', () => {
  test('оба нажатия попадают в выбор, рассылка идёт по накопленному набору', async () => {
    await press('s1');
    // Пока менеджер не нажал «Готово», фиксировать и рассылать нечего.
    const early = await selectionValidator.validate({ requestId: REQUEST_ID }, deps, CTX);
    expect(early.map((i) => i.code)).toEqual(['selection_not_finished']);
    await press('s2');
    await done();

    // Модель называет только s2, но набор берётся из подтверждения менеджера.
    await recordSelection.execute({ requestId: REQUEST_ID, supplierIds: ['s2'] }, deps, CTX);
    expect((await loadSelection(deps, REQUEST_ID))?.supplierIds).toEqual(['s1', 's2']);

    // Текст запроса готовится по накопленному набору; письма агент не отправляет.
    await prepareRequestsText(deps, { requestId: REQUEST_ID }, MANAGER, CTX.threadId);
    const shown = deps.chat.outbox.flatMap((record) => record.message?.text ?? []).join('\n');
    expect(shown).toContain('sales@metall.test');
    expect(shown).toContain('info@boltik.test');
    expect(deps.mailboxes.sentBy(MANAGER)).toEqual([]);
    expect(Object.keys((await loadSent(deps, REQUEST_ID))?.sentBySupplier ?? {}).sort()).toEqual([
      's1',
      's2',
    ]);
  });

  test('модель не может добавить поставщика вне подтверждения', async () => {
    await press('s1');
    await done();
    const issues = await selectionValidator.validate(
      { requestId: REQUEST_ID, supplierIds: ['s1', 's2'] },
      deps,
      CTX,
    );
    expect(issues.map((i) => i.code)).toEqual(['selection_not_confirmed']);
  });

  test('ушедший поставщик остаётся в выборе: его ответы читаются', async () => {
    await press('s1');
    await done();
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, CTX);
    await prepareRequestsText(deps, { requestId: REQUEST_ID }, MANAGER, CTX.threadId);

    // Повторный вопрос по той же заявке (новый тред): менеджер выбрал уже другого.
    await askManagerToChoose
      .execute({ requestId: REQUEST_ID, version }, deps, { ...CTX, threadId: 't-again' })
      .catch(() => {});
    // Подтверждение прежней версии уже завершено: выбор по этой версии не меняется.
    const second = await recordChoiceButton(deps.state, deps.clock, {
      supplierId: `${token()}:s2`,
      userId: MANAGER,
      threadId: 't-again',
    });
    expect(second).toEqual({ kind: 'already_done' });

    deliverReply(
      deps,
      {
        id: 'r1',
        from: 'sales@metall.test',
        subject: 'Re: запрос',
        body: 'цена 50',
        receivedAt: new Date(deps.clock.now().getTime() + 3_600_000).toISOString(),
        attachments: [],
      },
      MANAGER,
    );
    const ctx = employeeToolContext(MANAGER, CTX.threadId);
    const replies = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, ctx);
    expect(replies.replies.map((r) => r.supplierId)).toEqual(['s1']);
  });

  test('выбор после рассылки не вытесняет ушедшего поставщика', async () => {
    await press('s1');
    await done();
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, CTX);
    await prepareRequestsText(deps, { requestId: REQUEST_ID }, MANAGER, CTX.threadId);
    // Подтверждение подменено другим набором той же версии (например, текстом менеджера).
    await deps.state.put('order-calc:choice-confirm', REQUEST_ID, {
      requestId: REQUEST_ID,
      version,
      supplierIds: ['s2'],
      confirmedBy: MANAGER,
      confirmedAt: deps.clock.now().toISOString(),
      via: 'text',
      done: true,
    });
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect((await loadSelection(deps, REQUEST_ID))?.supplierIds.sort()).toEqual(['s1', 's2']);
  });
});
