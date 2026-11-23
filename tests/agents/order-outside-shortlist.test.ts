import { beforeEach, describe, expect, test } from 'bun:test';
import {
  askManagerToChoose,
  recordManagerChoice,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import {
  loadChoiceAsk,
  loadChoiceConfirmation,
} from '../../src/agents/order-calc/choice-confirmation';
import { loadSelection } from '../../src/agents/order-calc/state';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { recordSelection, selectionValidator } from '../../src/agents/order-calc/record-selection';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import type { ToolContext } from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

// Синтетические поставщики: в базе есть, в шорт-лист по арматуре не попадают (нет прайса).
const OUTSIDE_ID = 's10';
const OUTSIDE_NAME = 'Гвоздь-Опт';
const OUTSIDE_EMAIL = 'info@gvozd.test';
const TWIN_NAMES = ['Альфа Снаб', 'Альфа Метиз'];

const MANAGER = 'manager-1';
const employee: ToolContext = { ...CTX, initiator: { kind: 'user', userId: MANAGER } };

let deps: OrderTestDeps;
let shortlistIds: string[] = [];

/** Шорт-лист собран и показан: вопрос менеджеру открыт. */
beforeEach(async () => {
  deps = await buildOrderDeps();
  await deps.suppliers.upsert({ id: OUTSIDE_ID, name: OUTSIDE_NAME, email: OUTSIDE_EMAIL });
  await deps.suppliers.upsert({ id: 's11', name: TWIN_NAMES[0] ?? '' });
  await deps.suppliers.upsert({ id: 's12', name: TWIN_NAMES[1] ?? '' });
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  const { version } = await buildShortlist.execute(input, deps, CTX);
  await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
  shortlistIds = (await loadChoiceAsk(deps.state, CTX.threadId))?.entries.map(
    (entry) => entry.supplierId,
  ) ?? [];
});

const choose = (picks: string[]) =>
  recordManagerChoice.execute({ requestId: REQUEST_ID, decision: 'picked', picks }, deps, employee);

describe('выбор поставщика вне шорт-листа', () => {
  test('исходные данные: назвать некого из списка, нужных поставщиков в нём нет', () => {
    expect(shortlistIds.length).toBeGreaterThan(0);
    for (const id of [OUTSIDE_ID, 's11', 's12']) expect(shortlistIds).not.toContain(id);
  });

  test('из шорт-листа: по номеру, как и раньше', async () => {
    const out = await choose(['1']);
    expect(out.status).toBe('recorded');
    const saved = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect(saved?.supplierIds).toEqual([shortlistIds[0] ?? '']);
  });

  test('вне шорт-листа, найден в базе: выбор записан, смесь со списком допустима', async () => {
    const out = await choose(['1', OUTSIDE_NAME]);
    expect(out.status).toBe('recorded');
    expect(out.chosen).toHaveLength(2);
    expect(out.chosen).toContain(OUTSIDE_NAME);
    const saved = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect(saved?.done).toBe(true);
    expect(saved?.supplierIds).toContain(OUTSIDE_ID);
    expect(await selectionValidator.validate({ requestId: REQUEST_ID }, deps, CTX)).toEqual([]);
  });

  test('неизвестный: в базе нет - card_missing (этап 163), выбор не записан', async () => {
    const out = await choose(['Несуществующий Поставщик']);
    expect(out.status).toBe('card_missing');
    expect(out.missing).toEqual(['Несуществующий Поставщик']);
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
  });

  test('неоднозначный: подходят две карточки - ambiguous, не угадываем', async () => {
    const out = await choose(['Альфа']);
    expect(out.status).toBe('ambiguous');
    expect(out.ambiguous?.[0]?.candidates.slice().sort()).toEqual([...TWIN_NAMES].sort());
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
  });

  test('номер вне диапазона в базе не ищется', async () => {
    const out = await choose(['99']);
    expect(out).toEqual({ status: 'unmatched', unmatched: ['99'] });
  });

  test('письмо поставщику X сразу после шорт-листа: письмо для X, не шорт-лист', async () => {
    expect((await choose([OUTSIDE_NAME])).status).toBe('recorded');
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, employee);
    expect((await loadSelection(deps, REQUEST_ID))?.supplierIds).toEqual([OUTSIDE_ID]);
    const before = deps.chat.outbox.length;
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      employee,
    );
    expect(out.shownSupplierIds).toEqual([OUTSIDE_ID]);
    const texts = deps.chat.outbox
      .slice(before)
      .map((record) => record.message?.text ?? '');
    expect(texts.some((text) => text.includes(`Кому: ${OUTSIDE_EMAIL}`))).toBe(true);
    expect(texts.some((text) => text.includes(`Поставщик: ${OUTSIDE_NAME}`))).toBe(true);
  });
});
