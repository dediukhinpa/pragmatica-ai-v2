import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWebCandidateEnricher } from '../../src/kit/adapters/memory/web-candidate-model';
import { MemoryWebPageReader } from '@business-ai/adapters';
import {
  askManagerToChoose,
  recordManagerChoice,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadChoiceConfirmation } from '../../src/agents/order-calc/choice-confirmation';
import { loadSelection } from '../../src/agents/order-calc/state';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { recordSelection } from '../../src/agents/order-calc/record-selection';
import { recordSupplierCardDecision } from '../../src/agents/order-calc/supplier-card-offer';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import type { ToolContext } from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';
import { SwitchableAccess } from './suppliers-support';

// Синтетика: поставщик «66print» с сайтом; в базе его нет. Гвоздь-Опт в базе есть.
const NEW_NAME = '66print';
const NEW_SITE = 'https://66print.test';
const NEW_LINK = `${NEW_SITE}/catalog/boxes`;
const IN_BASE_NAME = 'Гвоздь-Опт';
const IN_BASE_ID = 's10';
const MANAGER = 'manager-1';
const employee: ToolContext = { ...CTX, initiator: { kind: 'user', userId: MANAGER } };
const QUESTION_FRAGMENT = 'Создать карточку (по данным с сайта) и подготовить письмо?';

let deps: OrderTestDeps;
let logged: string[] = [];

beforeEach(async () => {
  deps = await buildOrderDeps();
  await deps.suppliers.upsert({ id: IN_BASE_ID, name: IN_BASE_NAME, email: 'info@gvozd.test' });
  deps.webPageReader = new MemoryWebPageReader({
    '66print.test': [{ url: `${NEW_SITE}/`, text: 'Главная. Пермь, тел. +7 342 555-00-11' }],
  });
  deps.webEnricher = new MemoryWebCandidateEnricher(() => ({
    city: 'Пермь',
    phone: '+7 342 555-00-11',
    email: 'sales@66print.test',
  }));
  logged = [];
  deps.log = (event) => logged.push(event);
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  const { version } = await buildShortlist.execute(input, deps, CTX);
  await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
});

/** Сколько раз инструмент попросил не заканчивать ход (`holdTurn`). */
let held = 0;
beforeEach(() => {
  held = 0;
});

const choose = (picks: string[], siteUrl?: string) =>
  recordManagerChoice.execute(
    {
      requestId: REQUEST_ID,
      decision: 'picked',
      picks,
      ...(siteUrl === undefined ? {} : { siteUrl }),
    },
    deps,
    { ...employee, holdTurn: () => (held += 1) },
  );
const decide = (decision: 'create' | 'decline' | 'unclear') =>
  recordSupplierCardDecision.execute({ decision }, deps, employee);
const cardsByName = async (name: string) => deps.suppliers.searchCards({ query: name, limit: 10 });

describe('названный поставщик без карточки: один вопрос', () => {
  test('вопрос про создание, карточки нет, ничего не создано и не записано', async () => {
    const before = deps.chat.outbox.length;
    const out = await choose([NEW_LINK]);
    expect(out.status).toBe('card_missing');
    expect(out.missing).toEqual([NEW_NAME]);
    expect(out.question).toContain('в базе нет');
    // Этап 179: вопрос про карточку задаёт модель - письмо кода ход не заканчивает.
    expect(held).toBe(1);
    expect(out.question).toContain(`«${NEW_NAME}»`);
    expect(out.question).toContain(QUESTION_FRAGMENT);
    // Повторного шорт-листа и вообще сообщений от кода нет: сообщение пишет модель.
    expect(deps.chat.outbox.length).toBe(before);
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
    expect(await loadChoiceConfirmation(deps.state, REQUEST_ID)).toBeNull();
    expect(logged).toContain('supplier_card_offer');
  });

  test('смесь: найденный записан и письмо не блокируется, вопрос про недостающего', async () => {
    const out = await choose([IN_BASE_NAME, NEW_NAME], NEW_SITE);
    expect(out.status).toBe('card_missing');
    expect(out.chosen).toEqual([IN_BASE_NAME]);
    expect(out.missing).toEqual([NEW_NAME]);
    const saved = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect(saved?.supplierIds).toEqual([IN_BASE_ID]);
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, employee);
    const prepared = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      employee,
    );
    expect(prepared.shownSupplierIds).toEqual([IN_BASE_ID]);
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
  });

  test('номер вне списка - не поставщик без карточки: прежний unmatched', async () => {
    const out = await choose(['99']);
    expect(out).toEqual({ status: 'unmatched', unmatched: ['99'] });
    expect(logged).not.toContain('supplier_card_offer');
  });
});

describe('право заводить карточки в общей базе (этап 234)', () => {
  const right = (): SwitchableAccess => deps.access as SwitchableAccess;

  test('не руководитель: вопрос про создание не задаётся, предложения нет', async () => {
    right().mode = 'deny';
    const out = await choose([NEW_LINK]);
    expect(out.status).toBe('card_missing');
    expect(out.missing).toEqual([NEW_NAME]);
    expect(out.question).toBeUndefined();
    expect(out.note).toContain('руководитель отдела');
    expect(logged).not.toContain('supplier_card_offer');
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
    expect((await decide('create')).status).toBe('not_asked');
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
  });

  test('не руководитель, смесь: найденный записан, письмо ему не блокируется', async () => {
    right().mode = 'deny';
    const out = await choose([IN_BASE_NAME, NEW_NAME], NEW_SITE);
    expect(out).toMatchObject({ status: 'card_missing', chosen: [IN_BASE_NAME] });
    expect(out.question).toBeUndefined();
    const saved = await loadChoiceConfirmation(deps.state, REQUEST_ID);
    expect(saved?.supplierIds).toEqual([IN_BASE_ID]);
  });

  test('право отозвано после вопроса: no_permission, вопрос остаётся открытым', async () => {
    await choose([NEW_LINK]);
    right().mode = 'deny';
    const out = await decide('create');
    expect(out.status).toBe('no_permission');
    expect(out.message).toContain('руководитель отдела');
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
    right().mode = 'allow';
    expect((await decide('create')).status).toBe('created');
    expect(await cardsByName(NEW_NAME)).toHaveLength(1);
  });

  test('справочник недоступен: вопрос задан, create даёт unavailable', async () => {
    right().mode = 'down';
    const asked = await choose([NEW_LINK]);
    expect(asked.question).toContain(QUESTION_FRAGMENT);
    const out = await decide('create');
    expect(out.status).toBe('unavailable');
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
    // Сбой не записан как отказ: после восстановления тот же ответ проходит.
    right().mode = 'allow';
    expect((await decide('create')).status).toBe('created');
    expect(await cardsByName(NEW_NAME)).toHaveLength(1);
  });

  test('decline и unclear права не требуют', async () => {
    await choose([NEW_LINK]);
    right().mode = 'deny';
    expect((await decide('unclear')).status).toBe('unclear');
    expect((await decide('decline')).status).toBe('declined');
  });
});

describe('ответ сотрудника на вопрос о карточке', () => {
  test('create: карточка с данными сайта (непроверенная) и письмо', async () => {
    await choose([NEW_LINK]);
    const out = await decide('create');
    expect(out.status).toBe('created');
    expect(out.choiceRecorded).toBe(true);
    expect(out.cards?.[0]).toMatchObject({ name: NEW_NAME, created: true });
    expect(out.cards?.[0]?.fromWeb.sort()).toEqual(['город', 'почта', 'телефон']);
    const [card] = await cardsByName(NEW_NAME);
    expect(card).not.toHaveProperty('isDraft');
    expect(card?.website).toBe(NEW_SITE);
    expect(card?.contacts[0]?.email).toBe('sales@66print.test');
    expect(JSON.stringify(card?.notes)).toContain('подтвердите');
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, employee);
    expect((await loadSelection(deps, REQUEST_ID))?.supplierIds).toEqual([card?.id ?? '']);
    const before = deps.chat.outbox.length;
    const prepared = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      employee,
    );
    expect(prepared.shownSupplierIds).toEqual([card?.id ?? '']);
    const texts = deps.chat.outbox.slice(before).map((record) => record.message?.text ?? '');
    expect(texts.some((text) => text.includes('Кому: sales@66print.test'))).toBe(true);
  });

  test('create в смеси: к уже записанному найденному добавляется новая карточка', async () => {
    await choose([IN_BASE_NAME, NEW_NAME], NEW_SITE);
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, employee);
    const out = await decide('create');
    expect(out.choiceRecorded).toBe(true);
    await recordSelection.execute({ requestId: REQUEST_ID }, deps, employee);
    const ids = (await loadSelection(deps, REQUEST_ID))?.supplierIds ?? [];
    expect(ids).toContain(IN_BASE_ID);
    expect(ids).toHaveLength(2);
  });

  test('повторный create не плодит дубль карточки', async () => {
    await choose([NEW_LINK]);
    const first = await decide('create');
    const second = await decide('create');
    expect(first.status).toBe('created');
    expect(second.status).toBe('already_created');
    expect(second.cards?.[0]?.supplierId).toBe(first.cards?.[0]?.supplierId ?? '');
    expect(await cardsByName(NEW_NAME)).toHaveLength(1);
  });

  test('decline: карточки нет, список не отправляется, открытый выбор остался', async () => {
    await choose([NEW_LINK]);
    const before = deps.chat.outbox.length;
    const out = await decide('decline');
    expect(out).toMatchObject({ status: 'declined', choiceStillOpen: true });
    expect(deps.chat.outbox.length).toBe(before);
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
    // Вернулись к выбору из шорт-листа: номер принимается, как и раньше.
    expect((await choose(['1'])).status).toBe('recorded');
    expect((await decide('create')).status).toBe('not_asked');
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
  });

  test('unclear: карточка не создана, вопрос повторяется один раз', async () => {
    await choose([NEW_LINK]);
    const first = await decide('unclear');
    expect(first).toMatchObject({ status: 'unclear', repeatQuestion: true });
    expect(first.question).toContain(QUESTION_FRAGMENT);
    const second = await decide('unclear');
    expect(second.repeatQuestion).toBe(false);
    expect(second.question).toBeUndefined();
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
    // После неясных ответов явное согласие всё ещё работает.
    expect((await decide('create')).status).toBe('created');
  });

  test('без вопроса о карточке create ничего не создаёт', async () => {
    expect((await decide('create')).status).toBe('not_asked');
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
  });

  test('не в ходе сотрудника (плановый запуск) - отказ, карточки нет', async () => {
    await choose([NEW_LINK]);
    await expect(
      recordSupplierCardDecision.execute({ decision: 'create' }, deps, CTX),
    ).rejects.toThrow();
    expect(await cardsByName(NEW_NAME)).toHaveLength(0);
  });

  test('сайт недоступен: карточка заводится по названию, без полей из интернета', async () => {
    deps.webPageReader = new MemoryWebPageReader({});
    await choose([NEW_LINK]);
    const out = await decide('create');
    expect(out.status).toBe('created');
    expect(out.cards?.[0]?.fromWeb).toEqual([]);
    expect(await cardsByName(NEW_NAME)).toHaveLength(1);
  });
});
