import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryCrm } from '../../src/kit/adapters/memory/crm.owned';
import { MemoryIdempotencyStore, MemoryPortalLinks, MemoryTaskReader } from '@business-ai/adapters';
import {
  INTAKE_COMMENT_ITEM_MAX_CHARS,
  INTAKE_COMMENTS_MAX_ITEMS,
  INTAKE_DESCRIPTION_MAX_CHARS,
  INTAKE_MAX_ITEMS,
  INTAKE_PROMPT,
} from '../../src/agents/order-calc/intake';
import { HANDOFF_TO_PRICES_PROMPT } from '../../src/agents/order-calc/handoff-to-prices';
import { ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import {
  createToolContext,
  toRunSpec,
  FILE_TOOL_PROMPT,
  SESSION_SUMMARY_PROMPT,
} from '@business-ai/core';
import { readIntakeSource } from '../../src/agents/order-calc/read-intake-source';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { DomainError, type DomainErrorCode } from '@business-ai/core';
import { hoursToMs } from '../../src/kit/domain/time';
import { type PurchaseRequest } from '../../src/kit/domain/models';
import type { PurchaseRequestRepository } from '../../src/kit/ports/repositories.owned';
import type { TaskReader, WorkTask } from '@business-ai/core';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { CREATED_AT, CTX, MODEL_ALIAS } from './support';
import { buildOrderDeps, type OrderTestDeps } from './order-support';

const HOST = 'portal.example.test';
const TASK_LINK = `https://${HOST}/company/personal/user/1/tasks/task/view/77/`;
const DEAL_LINK = `https://${HOST}/crm/deal/details/500/`;
const FOREIGN_LINK = 'https://evil.example.test/company/personal/user/1/tasks/task/view/77/';
const SECRET_TEXT = 'ИНН 7700000000 пароль от шлюза hunter2';

const BOLT = { name: 'Болт М8', quantity: 10, unit: 'шт' };
const NUT = { name: 'Гайка М8', quantity: 20, unit: 'шт', sku: 'N-8' };

const TASK: WorkTask = {
  id: '77',
  title: 'Заказать крепёж',
  description: `Нужно: болты М8 10 шт, гайки М8 20 шт. ${SECRET_TEXT}`,
  checklist: ['Болт М8 - 10 шт', 'Гайка М8 - 20 шт'],
};

const CRM_REQUEST: PurchaseRequest = {
  id: 'crm-own-id',
  dealRef: '500',
  items: [BOLT, NUT],
  createdAt: CREATED_AT,
};

interface IntakeDeps extends OrderTestDeps {
  crm: MemoryCrm;
  tasks: MemoryTaskReader;
  links: MemoryPortalLinks;
}

let deps: IntakeDeps;
let tasks: MemoryTaskReader;

async function build(): Promise<IntakeDeps> {
  const base = await buildOrderDeps({ request: null });
  tasks = new MemoryTaskReader();
  tasks.set(TASK);
  return {
    ...base,
    crm: new MemoryCrm(new Map([['500', CRM_REQUEST]])),
    tasks,
    links: new MemoryPortalLinks(HOST),
  };
}

beforeEach(async () => {
  deps = await build();
});

const save = (input: unknown, context = CTX) => saveIntakeRequest.execute(input, deps, context);

async function expectRejected(
  promise: Promise<unknown>,
  code: DomainErrorCode,
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error('ожидался отказ');
}

describe('приём заявки: из текста', () => {
  test('заявка сохраняется без срока ответа и с dealRef от треда', async () => {
    const out = await save({ source: 'text', items: [BOLT, NUT] });
    expect(out).toMatchObject({ itemCount: 2, source: 'text', duplicate: false });
    expect(out.requestId).toMatch(/^req-/);
    expect(out.dealRef).toMatch(/^text-/);
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items).toEqual([BOLT, NUT]);
    const created = Date.parse(stored?.createdAt ?? '');
    expect(created).toBe(deps.clock.now().getTime());
    expect(stored?.createdAt).toMatch(/Z$/);
  });

  test('повтор: та же заявка, duplicate=true, без второй записи', async () => {
    const first = await save({ source: 'text', items: [BOLT, NUT] });
    deps.clock.advance(hoursToMs(1));
    const again = await save({ source: 'text', items: [NUT, BOLT] });
    expect(again.requestId).toBe(first.requestId);
    expect(again.duplicate).toBe(true);
    const stored = await deps.requests.get(first.requestId);
    // Первая запись не перезаписана: время создания прежнее.
    expect(stored?.createdAt).toBe(CREATED_AT);
  });

  test('другой тред - другая заявка и другой dealRef', async () => {
    const other = createToolContext({ threadId: 'other', agentId: 'a', operationId: 'op-2' });
    const first = await save({ source: 'text', items: [BOLT] });
    const second = await save({ source: 'text', items: [BOLT] }, other);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.dealRef).not.toBe(first.dealRef);
  });

  test('название и единица очищаются от лишних пробелов и переводов строк', async () => {
    const out = await save({
      source: 'text',
      items: [{ name: '  Болт\n  М8 ', quantity: 1, unit: ' шт ' }],
    });
    expect((await deps.requests.get(out.requestId))?.items).toEqual([
      { name: 'Болт М8', quantity: 1, unit: 'шт' },
    ]);
  });
});

describe('приём заявки: из задачи', () => {
  test('позиции от модели, dealRef = task-<id>, тела задачи в заявке нет', async () => {
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT, NUT] });
    expect(out).toMatchObject({ source: 'task', dealRef: 'task-77', itemCount: 2 });
    const stored = await deps.requests.get(out.requestId);
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain(TASK.title);
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ['createdAt', 'dealRef', 'id', 'items'].sort(),
    );
  });

  test('привязка задачи к сделке даёт dealRef сделки, позиции - из сделки', async () => {
    tasks.set({ ...TASK, dealRef: '500' });
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT] });
    expect(out).toMatchObject({ source: 'task', dealRef: '500', itemsFrom: 'deal', itemCount: 2 });
  });

  test('задача со сделкой: позиции модели не подменяют позиции сделки', async () => {
    tasks.set({ ...TASK, dealRef: '500' });
    const out = await save({
      source: 'task',
      link: TASK_LINK,
      items: [{ name: 'Болт М8', quantity: 9999, unit: 'шт' }],
    });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items).toEqual([BOLT, NUT]);
    expect(stored?.dealRef).toBe('500');
    // Создание - из сделки, а не «сейчас».
    expect(stored?.createdAt).toBe(CREATED_AT);
    // Позиции модели, которых нет в тексте задачи, сделке не мешают.
    const phantom = await save({
      source: 'task',
      link: TASK_LINK,
      items: [{ name: 'Выдумка', quantity: 1, unit: 'шт' }],
    });
    expect(phantom.requestId).toBe(out.requestId);
    expect(phantom.duplicate).toBe(true);
  });

  test('заявка из задачи со сделкой и по ссылке на сделку - одна и та же заявка', async () => {
    tasks.set({ ...TASK, dealRef: '500' });
    const viaDeal = await save({ source: 'deal', link: DEAL_LINK });
    const viaTask = await save({ source: 'task', link: TASK_LINK, items: [BOLT] });
    expect(viaTask.requestId).toBe(viaDeal.requestId);
    expect(viaTask.duplicate).toBe(true);
  });

  test('сделки нет в CRM: dealRef = task-<id>, позиции от модели с проверкой', async () => {
    tasks.set({ ...TASK, dealRef: '777' });
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT, NUT] });
    expect(out).toMatchObject({ dealRef: 'task-77', itemsFrom: 'model', itemCount: 2 });
    expect(await deps.requests.listByDeal('777')).toHaveLength(0);
    // Позиции от модели проверяются и тут.
    const phantom = { name: 'Выдумка', quantity: 1, unit: 'шт' };
    await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT, phantom] }),
      'validation_failed',
    );
  });

  test('сделка без позиций в CRM: то же, что «сделки нет»', async () => {
    const empty: PurchaseRequest = { ...CRM_REQUEST, dealRef: '600', items: [] };
    deps = { ...deps, crm: new MemoryCrm(new Map([['600', empty]])) };
    tasks.set({ ...TASK, dealRef: '600' });
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT] });
    expect(out).toMatchObject({ dealRef: 'task-77', itemsFrom: 'model' });
  });

  test('сбой CRM при чтении сделки задачи - ошибка, а не откат на позиции модели', async () => {
    tasks.set({ ...TASK, dealRef: '500' });
    class FailingCrm extends MemoryCrm {
      override async getPurchaseRequest(): Promise<never> {
        throw new DomainError('external_failure', 'сбой');
      }
    }
    deps = { ...deps, crm: new FailingCrm() };
    await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT] }),
      'external_failure',
    );
  });

  test('позиция без опоры в тексте задачи - отказ с номерами, без названий', async () => {
    const phantom = { name: 'Секретная выдумка', quantity: 1, unit: 'шт' };
    const other = { name: 'Секретный призрак', quantity: 2, unit: 'шт' };
    const error = await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT, phantom, NUT, other] }),
      'validation_failed',
    );
    expect(error.message).toContain('Не найдено в задаче: позиции 2, 4');
    expect(error.message).toContain('тексте менеджера');
    // Номера позиций, а не их названия.
    expect(error.message).not.toContain('Секретн');
    expect(await deps.requests.listByDeal('task-77')).toHaveLength(0);
  });

  test('опора в тексте: регистр и пробелы не важны; чек-лист и заголовок', async () => {
    tasks.set({
      ...TASK,
      title: 'Заказать КРЕПЁЖ',
      description: 'без перечня',
      checklist: ['болт   м8 - 10 шт', 'Шайба\nплоская'],
    });
    const out = await save({
      source: 'task',
      link: TASK_LINK,
      items: [
        { name: 'БОЛТ М8', quantity: 10, unit: 'шт' },
        { name: 'шайба плоская', quantity: 5, unit: 'шт' },
        { name: 'Крепеж', quantity: 1, unit: 'компл' },
      ],
    });
    expect(out).toMatchObject({ itemCount: 3, itemsFrom: 'model' });
  });

  test('повтор того же ввода - та же заявка', async () => {
    const first = await save({ source: 'task', link: TASK_LINK, items: [BOLT] });
    const again = await save({ source: 'task', link: TASK_LINK, items: [BOLT] });
    expect(again).toEqual({ ...first, duplicate: true });
  });

  test('задача не найдена - not_found', async () => {
    const link = `https://${HOST}/company/personal/user/1/tasks/task/view/999/`;
    await expectRejected(save({ source: 'task', link, items: [BOLT] }), 'not_found');
    expect(await deps.requests.listByDeal('task-999')).toHaveLength(0);
  });

  test('чужой хост ссылки - отказ с просьбой прислать текстом', async () => {
    const error = await expectRejected(
      save({ source: 'task', link: FOREIGN_LINK, items: [BOLT] }),
      'invalid_input',
    );
    expect(error.message).toContain('пришлите');
    expect(tasks.calls).toBe(0);
  });

  test('ссылка на сделку при source=task - отказ', async () => {
    await expectRejected(save({ source: 'task', link: DEAL_LINK, items: [BOLT] }), 'invalid_input');
  });

  test('сбой порта задачи: понятная ошибка без текста из порта', async () => {
    const leaky: TaskReader = {
      async getTask() {
        throw new DomainError('external_failure', `ответ портала: ${SECRET_TEXT}`);
      },
    };
    deps = { ...deps, tasks: leaky as MemoryTaskReader };
    const error = await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT] }),
      'external_failure',
    );
    expect(error.message).not.toContain('hunter2');
    expect(error.message).toContain('позже');
  });

  test('сбой порта задачи и сделки пишет в журнал имя ошибки, но не её текст', async () => {
    const rows: [string, unknown][] = [];
    const log = (event: string, fields?: unknown): void => void rows.push([event, fields]);
    const leaky: TaskReader = {
      async getTask() {
        throw new TypeError(`ответ портала: ${SECRET_TEXT}`);
      },
    };
    deps = { ...deps, tasks: leaky as MemoryTaskReader, log };
    await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT] }),
      'external_failure',
    );
    class FailingCrm extends MemoryCrm {
      override async getPurchaseRequest(): Promise<never> {
        throw new RangeError(`сделка: ${SECRET_TEXT}`);
      }
    }
    tasks.set({ ...TASK, dealRef: '500' });
    deps = { ...deps, tasks, crm: new FailingCrm(), log };
    await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT] }),
      'external_failure',
    );
    expect(rows).toContainEqual(['intake_task_read_failed', { code: 'TypeError' }]);
    expect(rows).toContainEqual(['intake_deal_read_failed', { code: 'RangeError' }]);
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  test('сбой заглушки портала - external_failure, заявка не создана', async () => {
    tasks.failing = true;
    const input = { source: 'task', link: TASK_LINK, items: [BOLT] };
    await expectRejected(save(input), 'external_failure');
    expect(await deps.requests.listByDeal('task-77')).toHaveLength(0);
  });

  test('без порта задач - not_configured', async () => {
    const { tasks: _omitted, ...rest } = deps;
    await expectRejected(
      saveIntakeRequest.execute({ source: 'task', link: TASK_LINK, items: [BOLT] }, rest, CTX),
      'not_configured',
    );
  });
});

describe('приём заявки: из сделки', () => {
  test('позиции и срок берутся из CRM, позиции от модели игнорируются', async () => {
    const out = await save({
      source: 'deal',
      link: DEAL_LINK,
      items: [{ name: 'Подмена', quantity: 999, unit: 'т' }],
    });
    expect(out).toMatchObject({ source: 'deal', dealRef: '500', itemCount: 2 });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items).toEqual([BOLT, NUT]);
    expect(stored?.id).not.toBe('crm-own-id');
  });

  test('повтор - та же заявка', async () => {
    const first = await save({ source: 'deal', link: DEAL_LINK });
    const again = await save({ source: 'deal', link: DEAL_LINK });
    expect(again.requestId).toBe(first.requestId);
    expect(again.duplicate).toBe(true);
    expect(first.itemsFrom).toBe('deal');
  });

  test('создание заявки - из CRM, а не «сейчас»', async () => {
    deps.clock.advance(hoursToMs(5));
    const out = await save({ source: 'deal', link: DEAL_LINK });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.createdAt).toBe(CREATED_AT);
    expect(deps.clock.now().toISOString()).not.toBe(CREATED_AT);
  });

  test('сделка изменилась: другая заявка, а не старый результат', async () => {
    const first = await save({ source: 'deal', link: DEAL_LINK });
    const changed: PurchaseRequest = { ...CRM_REQUEST, items: [BOLT, { ...NUT, quantity: 50 }] };
    deps = { ...deps, crm: new MemoryCrm(new Map([['500', changed]])) };
    const second = await save({ source: 'deal', link: DEAL_LINK });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.duplicate).toBe(false);
    expect((await deps.requests.get(second.requestId))?.items[1]?.quantity).toBe(50);
  });

  test('сделки нет или в ней нет позиций - отказ «пришлите текстом»', async () => {
    const empty: PurchaseRequest = { ...CRM_REQUEST, items: [] };
    deps = { ...deps, crm: new MemoryCrm(new Map([['500', empty]])) };
    const noItems = await expectRejected(save({ source: 'deal', link: DEAL_LINK }), 'not_found');
    expect(noItems.message).toContain('текстом');
    const missing = `https://${HOST}/crm/deal/details/501/`;
    await expectRejected(save({ source: 'deal', link: missing }), 'not_found');
  });

  test('повторяющиеся строки CRM складываются', async () => {
    const doubled: PurchaseRequest = { ...CRM_REQUEST, items: [BOLT, { ...BOLT, quantity: 5 }] };
    deps = { ...deps, crm: new MemoryCrm(new Map([['500', doubled]])) };
    const out = await save({ source: 'deal', link: DEAL_LINK });
    expect(out.itemCount).toBe(1);
    expect((await deps.requests.get(out.requestId))?.items[0]?.quantity).toBe(15);
  });

  test('без CRM - not_configured', async () => {
    const { crm: _omitted, ...rest } = deps;
    await expectRejected(
      saveIntakeRequest.execute({ source: 'deal', link: DEAL_LINK }, rest, CTX),
      'not_configured',
    );
  });

  test('без разбора ссылок любая ссылка отклоняется', async () => {
    const { links: _omitted, ...rest } = deps;
    const error = await expectRejected(
      saveIntakeRequest.execute({ source: 'deal', link: DEAL_LINK }, rest, CTX),
      'invalid_input',
    );
    expect(error.message).toContain('текстом');
  });
});

describe('приём заявки: ключ идемпотентности', () => {
  const predecessor = (input: unknown, threadId = CTX.threadId) =>
    saveIntakeRequest.idempotencyPredecessor?.(input, deps, threadId) ?? Promise.resolve('');

  test('сделка изменилась - предшественник другой, тот же ввод - тот же', async () => {
    const input = { source: 'deal', link: DEAL_LINK };
    const before = await predecessor(input);
    expect(await predecessor(input)).toBe(before);
    const changed: PurchaseRequest = { ...CRM_REQUEST, items: [BOLT] };
    deps = { ...deps, crm: new MemoryCrm(new Map([['500', changed]])) };
    expect(await predecessor(input)).not.toBe(before);
  });

  test('тот же ввод от другого сотрудника (тред) - другая операция', async () => {
    for (const input of [
      { source: 'deal', link: DEAL_LINK },
      { source: 'task', link: TASK_LINK, items: [BOLT] },
    ]) {
      expect(await predecessor(input, 'thread-a')).not.toBe(await predecessor(input, 'thread-b'));
    }
  });

  test('задача: другие позиции - другой предшественник', async () => {
    const one = await predecessor({ source: 'task', link: TASK_LINK, items: [BOLT] });
    const two = await predecessor({ source: 'task', link: TASK_LINK, items: [BOLT, NUT] });
    expect(two).not.toBe(one);
  });

  test('отказ источника в предшественнике - тот же отказ, что и при выполнении', async () => {
    const missing = `https://${HOST}/crm/deal/details/501/`;
    await expectRejected(predecessor({ source: 'deal', link: missing }), 'not_found');
    await expectRejected(predecessor({ source: 'deal', link: FOREIGN_LINK }), 'invalid_input');
  });

  test('через рантайм: изменённая сделка даёт новую заявку, повтор - прежнюю', async () => {
    const crmRequests = new Map([['500', CRM_REQUEST]]);
    const saved: string[] = [];
    const requests: PurchaseRequestRepository = {
      save: async (request) => {
        saved.push(request.id);
        // Между вызовами менеджер правит сделку.
        if (saved.length === 1) {
          crmRequests.set('500', { ...CRM_REQUEST, items: [BOLT, { ...NUT, quantity: 7 }] });
        }
        return deps.requests.save(request);
      },
      get: (id) => deps.requests.get(id),
      listByDeal: (dealRef) => deps.requests.listByDeal(dealRef),
    };
    const args = { source: 'deal', link: DEAL_LINK };
    const { runtime, spec } = scriptedRuntime(
      createOrderCalcAgent({ model: MODEL_ALIAS, intake: true }),
      { ...deps, crm: new MemoryCrm(crmRequests), requests },
      [
        callTool('c1', 'saveIntakeRequest', args),
        callTool('c2', 'saveIntakeRequest', args),
        callTool('c3', 'saveIntakeRequest', args),
        say('готово'),
      ],
      { runtime: { idempotency: new MemoryIdempotencyStore() } },
    );
    const result = await runtime.run(spec, 'chat-deal', 'заявка из сделки');
    expect(result.status).toBe('completed');
    // c1: исходная сделка; c2: изменённая - новая заявка; c3: повтор c2 - без новой записи.
    expect(saved).toHaveLength(2);
    expect(new Set(saved).size).toBe(2);
  });

  test('через рантайм: тот же ввод во втором треде выполняется', async () => {
    const reads: string[] = [];
    const requests: PurchaseRequestRepository = {
      save: (request) => deps.requests.save(request),
      get: async (id) => {
        reads.push(id);
        return deps.requests.get(id);
      },
      listByDeal: (dealRef) => deps.requests.listByDeal(dealRef),
    };
    const args = { source: 'deal', link: DEAL_LINK };
    const idempotency = new MemoryIdempotencyStore();
    for (const thread of ['chat-a', 'chat-b']) {
      const { runtime, spec } = scriptedRuntime(
        createOrderCalcAgent({ model: MODEL_ALIAS, intake: true }),
        { ...deps, requests },
        [callTool('c1', 'saveIntakeRequest', args), say('готово')],
        { runtime: { idempotency } },
      );
      const result = await runtime.run(spec, thread, 'заявка из сделки');
      expect(result.status).toBe('completed');
    }
    // `execute` отработал в обоих тредах: второй сотрудник не получил чужой кэш.
    expect(reads).toHaveLength(2);
    expect((await deps.requests.listByDeal('500')).length).toBe(1);
  });
});

describe('приём заявки: проверка позиций кодом', () => {
  const bad = (item: Record<string, unknown>) =>
    save({ source: 'text', items: [{ ...BOLT, ...item }] });

  test('количество: ноль, отрицательное, бесконечное - заявка принята без количества', async () => {
    // Этап 177: раньше отказ всей заявке, теперь позиция без количества и предупреждение.
    for (const quantity of [0, -1, Infinity]) {
      const out = await bad({ quantity });
      expect((await deps.requests.get(out.requestId))?.items[0]?.quantity).toBeUndefined();
      expect(out.warnings?.join(' ')).toContain('позиция 1: количество не принято');
    }
    // NaN отсекает уже схема числа.
    await expectRejected(bad({ quantity: NaN }), 'invalid_input');
  });

  test('пустая единица - «не указана»; единственная позиция без названия - отказ', async () => {
    const item = { name: 'Болт М8', quantity: 3, unit: ' ' };
    const out = await save({ source: 'text', items: [item] });
    expect((await deps.requests.get(out.requestId))?.items[0]?.unit).toBe('не указана');
    // Нет ни одной позиции с названием - нечего искать (значения не выдумываем).
    await expectRejected(bad({ name: '' }), 'validation_failed');
    await expectRejected(save({ source: 'text', items: [] }), 'validation_failed');
  });

  test('позиций больше прежнего предела 100 - заявка принимается целиком', async () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...BOLT, name: `Позиция ${index}` }));
    const ok = await save({ source: 'text', items: make(INTAKE_MAX_ITEMS) });
    expect(ok.itemCount).toBe(INTAKE_MAX_ITEMS);
    const more = await save({ source: 'text', items: make(INTAKE_MAX_ITEMS + 1) });
    expect(more.itemCount).toBe(INTAKE_MAX_ITEMS + 1);
  });

  test('дубликат (название, единица) от модели объединяется (O24)', async () => {
    const out = await save({ source: 'text', items: [BOLT, NUT, { ...BOLT, name: 'болт м8' }] });
    expect(out.itemCount).toBe(2);
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items[0]).toMatchObject({ name: 'Болт М8', quantity: 20 });
  });

  test('дубль без единицы сливается с позицией, где единица указана', async () => {
    const out = await save({
      source: 'text',
      items: [{ name: 'Болт М8', quantity: 5 }, BOLT],
    });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items).toHaveLength(1);
    expect(stored?.items[0]).toMatchObject({ unit: 'шт', quantity: 15 });
  });

  test('то же название в другой единице - вопрос на приёме, а не отказ на каждой строке КП', async () => {
    // R9-A1-08: КП сопоставляется с заявкой по названию, и две позиции «Болт М8» (шт и уп)
    // давали ambiguous_line на любой строке КП. Раньше такая заявка принималась.
    const error = await expectRejected(
      save({ source: 'text', items: [BOLT, NUT, { ...BOLT, unit: 'уп' }] }),
      'validation_failed',
    );
    expect(error.message).toContain('разными единицами измерения (номера 1 и 3)');
  });

  test('неверная форма ввода - invalid_input', async () => {
    await expectRejected(save({ source: 'mail', items: [BOLT] }), 'invalid_input');
    await expectRejected(save({ source: 'task', items: [BOLT] }), 'invalid_input');
  });
});

describe('чтение источника', () => {
  test('задача: заголовок, описание, чек-лист; инструмент без побочного эффекта', async () => {
    expect(readIntakeSource.sideEffect).not.toBe(true);
    expect(readIntakeSource.description).toContain('данные');
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(out).toMatchObject({
      kind: 'task',
      ref: '77',
      title: TASK.title,
      checklist: TASK.checklist,
      truncated: false,
    });
    expect('dealRef' in out).toBe(false);
  });

  test('привязка к сделке возвращается', async () => {
    tasks.set({ ...TASK, dealRef: '500' });
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(out).toMatchObject({ kind: 'task', dealRef: '500' });
  });

  test('длинный текст обрезается и помечается', async () => {
    tasks.set({ ...TASK, description: 'я'.repeat(INTAKE_DESCRIPTION_MAX_CHARS + 50) });
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    if (out.kind !== 'task') throw new Error('ожидалась задача');
    expect(out.description).toHaveLength(INTAKE_DESCRIPTION_MAX_CHARS);
    expect(out.truncated).toBe(true);
  });

  test('чат и вложения: сообщения, имена файлов, число фото; без них - пустые', async () => {
    const plain = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(plain).toMatchObject({ kind: 'task', comments: [], attachments: [], imageCount: 0 });
    tasks.set({
      ...TASK,
      comments: [
        { text: 'Коробки 30х20', authorRole: 'creator' },
        { text: 'Нужен микрогофрокартон' },
      ],
      attachments: [
        { name: 'макет.pdf', isImage: false },
        { name: 'фото.jpg', isImage: true },
      ],
    });
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(out).toMatchObject({
      comments: [
        { author: 'creator', text: 'Коробки 30х20' },
        { author: 'other', text: 'Нужен микрогофрокартон' },
      ],
      attachments: [
        { name: 'макет.pdf', kind: 'file' },
        { name: 'фото.jpg', kind: 'image' },
      ],
      imageCount: 1,
      truncated: false,
    });
    expect(readIntakeSource.description).toContain('imageCount');
  });

  test('дубли вложений схлопываются, imageCount считается по уникальным', async () => {
    tasks.set({
      ...TASK,
      attachments: [
        { name: 'фото.jpg', isImage: true },
        { name: 'фото.jpg', isImage: true },
        { name: 'макет.pdf', isImage: false },
      ],
    });
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    if (out.kind !== 'task') throw new Error('ожидалась задача');
    expect(out.attachments).toHaveLength(2);
    expect(out.imageCount).toBe(1);
  });

  test('много и длинные сообщения: остаются последние, обрезка помечается', async () => {
    const total = INTAKE_COMMENTS_MAX_ITEMS + 3;
    const comments = Array.from({ length: total }, (_, index) => ({ text: `м${index}` }));
    comments.push({ text: 'я'.repeat(INTAKE_COMMENT_ITEM_MAX_CHARS + 10) });
    tasks.set({ ...TASK, comments });
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    if (out.kind !== 'task') throw new Error('ожидалась задача');
    expect(out.comments).toHaveLength(INTAKE_COMMENTS_MAX_ITEMS);
    expect(out.comments[0]?.text).toBe('м4');
    expect(out.comments.at(-1)?.text).toHaveLength(INTAKE_COMMENT_ITEM_MAX_CHARS);
    expect(out.truncated).toBe(true);
  });

  test.each(['creator', 'responsible'] as const)(
    'позиция названа только в сообщении роли %s: проверка текста её принимает',
    async (authorRole) => {
      tasks.set({
        ...TASK,
        description: '',
        checklist: [],
        comments: [{ text: 'Нужен Болт М8', authorRole }],
      });
      const out = await saveIntakeRequest.execute(
        { source: 'task', link: TASK_LINK, items: [BOLT] },
        deps,
        CTX,
      );
      expect(out.source).toBe('task');
    },
  );

  test('позиция только в сообщении постороннего или без роли автора: отказ с номером', async () => {
    for (const authorRole of ['other' as const, undefined]) {
      tasks.set({
        ...TASK,
        description: '',
        checklist: [],
        comments: [{ text: 'Нужен Болт М8', authorRole }],
      });
      await expect(
        saveIntakeRequest.execute({ source: 'task', link: TASK_LINK, items: [BOLT] }, deps, CTX),
      ).rejects.toThrow(/позиции 1/);
    }
  });

  test('чат не прочитан: признаки недоступности доходят до модели', async () => {
    const plain = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(plain).toMatchObject({ chatUnavailable: false, attachmentsUnavailable: false });
    tasks.set({ ...TASK, chatUnavailable: true, attachmentsUnavailable: true });
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(out).toMatchObject({ chatUnavailable: true, attachmentsUnavailable: true });
    expect(readIntakeSource.description).toContain('chatUnavailable');
    expect(INTAKE_PROMPT).toContain('chatUnavailable');
  });

  test('промпт приёма: о непрочитанных фото пишет код, модель не добавляет своё предупреждение', () => {
    expect(INTAKE_PROMPT).toContain('imageCount');
    // Один автор у сообщения (этап 189): фразу про фото строит код под шорт-листом.
    expect(INTAKE_PROMPT).toContain('пишет КОД под');
    expect(INTAKE_PROMPT).not.toContain('в задаче есть фото N шт.');
  });

  test('сделка: позиции из CRM; нет сделки - found=false', async () => {
    const found = await readIntakeSource.execute({ link: DEAL_LINK }, deps, CTX);
    expect(found).toMatchObject({ kind: 'deal', ref: '500', found: true, items: [BOLT, NUT] });
    const none = await readIntakeSource.execute(
      { link: `https://${HOST}/crm/deal/details/9/` },
      deps,
      CTX,
    );
    expect(none).toMatchObject({ kind: 'deal', found: false, items: [] });
  });

  test('отказы: чужой хост, задача не найдена, нет порта, сбой портала', async () => {
    const read = (link: string, source: OrderCalcDeps = deps) =>
      readIntakeSource.execute({ link }, source, CTX);
    await expectRejected(read(FOREIGN_LINK), 'invalid_input');
    const missing = `https://${HOST}/company/personal/user/1/tasks/task/view/5/`;
    await expectRejected(read(missing), 'not_found');
    const { tasks: _omitted, ...rest } = deps;
    await expectRejected(read(TASK_LINK, rest), 'not_configured');
    tasks.failing = true;
    const error = await expectRejected(read(TASK_LINK), 'external_failure');
    expect(error.message).not.toContain(TASK.title);
  });
});

describe('декларация агента', () => {
  test('без intake декларация и промпт прежние', () => {
    const plain = createOrderCalcAgent({ model: MODEL_ALIAS });
    const explicit = createOrderCalcAgent({ model: MODEL_ALIAS, intake: false });
    expect(plain.prompt).toBe(ORDER_CALC_PROMPT + SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT);
    expect(toRunSpec(explicit)).toEqual(toRunSpec(plain));
    expect(plain.tools.map((tool) => tool.name)).not.toContain('saveIntakeRequest');
    expect(plain.tools.map((tool) => tool.name)).not.toContain('readIntakeSource');
    expect(plain.validators.length).toBe(explicit.validators.length);
  });

  test('с intake добавлены ровно три инструмента и абзац промпта', () => {
    const plain = createOrderCalcAgent({ model: MODEL_ALIAS });
    const withIntake = createOrderCalcAgent({ model: MODEL_ALIAS, intake: true });
    const known = new Set(plain.tools.map((tool) => tool.name));
    const added = withIntake.tools.map((tool) => tool.name).filter((name) => !known.has(name));
    expect(added).toEqual(['readIntakeSource', 'readChatAttachments', 'saveIntakeRequest']);
    expect(withIntake.prompt).toBe(
      `${ORDER_CALC_PROMPT}${INTAKE_PROMPT}${SESSION_SUMMARY_PROMPT}${FILE_TOOL_PROMPT}`,
    );
    expect(withIntake.validators).toEqual(plain.validators);
    const both = createOrderCalcAgent({ model: MODEL_ALIAS, intake: true, handoffToPrices: true });
    expect(both.prompt).toBe(
      `${ORDER_CALC_PROMPT}${HANDOFF_TO_PRICES_PROMPT}${INTAKE_PROMPT}` +
        `${SESSION_SUMMARY_PROMPT}${FILE_TOOL_PROMPT}`,
    );
  });

  test('двойной вызов через общий механизм идемпотентности даёт один эффект', async () => {
    const saves: string[] = [];
    const requests: PurchaseRequestRepository = {
      save: async (request) => {
        saves.push(request.id);
        return deps.requests.save(request);
      },
      get: (id) => deps.requests.get(id),
      listByDeal: (dealRef) => deps.requests.listByDeal(dealRef),
    };
    const args = { source: 'task', link: TASK_LINK, items: [BOLT] };
    const { runtime, spec } = scriptedRuntime(
      createOrderCalcAgent({ model: MODEL_ALIAS, intake: true }),
      { ...deps, requests },
      [
        callTool('c1', 'saveIntakeRequest', args),
        callTool('c2', 'saveIntakeRequest', args),
        say('готово'),
      ],
      { runtime: { idempotency: new MemoryIdempotencyStore() } },
    );
    const result = await runtime.run(spec, 'chat-intake', 'заявка в задаче');
    expect(result.status).toBe('completed');
    expect(saves).toHaveLength(1);
    expect(await deps.requests.listByDeal('task-77')).toHaveLength(1);
  });
});

describe('приём заявки: сочетание полей под источник проверяет код', () => {
  test('source=text без items и source=task без link - понятный отказ, заявки нет', async () => {
    const noItems = await expectRejected(save({ source: 'text' }), 'invalid_input');
    expect(noItems.message).toContain('source=text: items');
    await expectRejected(save({ source: 'task', items: [BOLT] }), 'invalid_input');
    await expectRejected(save({ source: 'deal' }), 'invalid_input');
  });
});

describe('приём заявки: режимы без обязательной задачи (этап 140)', () => {
  const MANAGER = 'в задаче крепёж, а ещё нужны Шайбы М8 300 шт с цинком';
  const WASHER = { name: 'Шайбы М8', quantity: 300, unit: 'шт' };

  test('режим 1: по задаче, без текста менеджера', async () => {
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT, NUT] });
    expect(out).toMatchObject({ source: 'task', dealRef: 'task-77', itemCount: 2 });
    expect(out.notice).toBeUndefined();
  });

  test('режим 2: позиция из текста менеджера принята, текст дошёл до requirements', async () => {
    const out = await save({
      source: 'task',
      link: TASK_LINK,
      items: [BOLT, WASHER],
      comment: MANAGER,
    });
    expect(out).toMatchObject({ source: 'task', dealRef: 'task-77', itemCount: 2 });
    const stored = await deps.requests.get(out.requestId);
    for (const item of stored?.items ?? []) {
      expect(item.requirements).toContain('Текст менеджера: в задаче крепёж');
    }
  });

  test('режим 2: без текста менеджера та же позиция отклоняется', async () => {
    await expectRejected(
      save({ source: 'task', link: TASK_LINK, items: [BOLT, WASHER] }),
      'validation_failed',
    );
  });

  test('режим 2: текст менеджера не затирает requirements модели', async () => {
    const out = await save({
      source: 'task',
      link: TASK_LINK,
      items: [{ ...BOLT, requirements: 'сталь 8.8' }],
      comment: 'болт нужен оцинкованный',
    });
    const requirements = (await deps.requests.get(out.requestId))?.items[0]?.requirements;
    expect(requirements).toBe('сталь 8.8; Текст менеджера: болт нужен оцинкованный');
  });

  test('режим 3: без ссылки, dealRef = text-<id>', async () => {
    const out = await save({ source: 'text', items: [BOLT], comment: 'срочно' });
    expect(out.dealRef).toMatch(/^text-/);
    expect(out.notice).toBeUndefined();
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items[0]?.requirements).toBe('Текст менеджера: срочно');
  });

  test('реплика чужого участника чата не служит опорой даже с текстом менеджера', async () => {
    tasks.set({
      ...TASK,
      description: '',
      checklist: [],
      comments: [{ text: 'Нужны Шайбы М8', authorRole: 'other' }],
    });
    await expect(
      saveIntakeRequest.execute(
        { source: 'task', link: TASK_LINK, items: [WASHER], comment: 'посчитай, пожалуйста' },
        deps,
        CTX,
      ),
    ).rejects.toThrow(/позиции 1/);
  });

  test('задача не найдена + текст менеджера: режим по тексту с одной фразой', async () => {
    const link = `https://${HOST}/company/personal/user/1/tasks/task/view/999/`;
    const out = await save({ source: 'task', link, items: [WASHER], comment: MANAGER });
    expect(out.dealRef).toMatch(/^text-/);
    expect(out.notice).toContain('Задачу прочитать не удалось');
    expect(await deps.requests.get(out.requestId)).not.toBeNull();
  });

  test('задача недоступна (сбой порта) + текст менеджера: не отказ', async () => {
    const broken: TaskReader = {
      async getTask() {
        throw new Error('портал лежит');
      },
    };
    deps = { ...deps, tasks: broken as MemoryTaskReader };
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT], comment: 'болты' });
    expect(out).toMatchObject({ source: 'task', itemCount: 1 });
    expect(out.notice).toContain('Задачу прочитать не удалось');
  });

  test('задача недоступна и текста менеджера нет - отказ как раньше', async () => {
    const link = `https://${HOST}/company/personal/user/1/tasks/task/view/999/`;
    await expectRejected(save({ source: 'task', link, items: [BOLT] }), 'not_found');
  });
});

describe('приём заявки: количество не указано', () => {
  const NO_QUANTITY = { name: 'Гайка М8', unit: 'шт' };

  test('режим 3 (только текст): позиция без количества принята, число не выдумано', async () => {
    const out = await save({ source: 'text', items: [BOLT, NO_QUANTITY] });
    expect(out).toMatchObject({ itemCount: 2, source: 'text', duplicate: false });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items[0]).toEqual(BOLT);
    // Поля нет вовсе: нижестоящий код читает его как «не указано», а не как 0 или 1.
    expect(stored?.items[1]).toEqual({ name: 'Гайка М8', unit: 'шт' });
    expect(stored?.items[1]).not.toHaveProperty('quantity');
  });

  test('режим 1 (по задаче): позиция без количества принята', async () => {
    tasks.set({ ...TASK, dealRef: '777' });
    const out = await save({ source: 'task', link: TASK_LINK, items: [BOLT, NO_QUANTITY] });
    expect(out).toMatchObject({ itemCount: 2, source: 'task', itemsFrom: 'model' });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items[1]).not.toHaveProperty('quantity');
  });

  test('дубли без количества и с ним складываются; ноль - позиция без количества', async () => {
    const out = await save({
      source: 'text',
      items: [NO_QUANTITY, { name: 'гайка м8', unit: 'шт', quantity: 4 }],
    });
    const stored = await deps.requests.get(out.requestId);
    expect(stored?.items).toEqual([{ name: 'Гайка М8', unit: 'шт', quantity: 4 }]);
    const zero = await save({ source: 'text', items: [{ name: 'Болт М8', quantity: 0 }] });
    expect(zero.warnings).toHaveLength(1);
  });
});
