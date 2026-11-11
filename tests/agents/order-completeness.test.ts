import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryPortalLinks, MemoryTaskReader } from '@business-ai/adapters';
import { COMPLETENESS_NAMESPACE, type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import {
  COMPLETENESS_PROMPT,
  checkRequestCompleteness,
} from '../../src/agents/order-calc/check-request-completeness';
import { INTAKE_PROMPT } from '../../src/agents/order-calc/intake';
import { ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { loadCompleteness } from '../../src/agents/order-calc/state';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { type AgentDeclaration, FILE_TOOL_PROMPT } from '@business-ai/core';
import { SESSION_SUMMARY_PROMPT } from '../../src/agents/shared/legacy-prompts.owned';
import {
  COMPLETENESS_QUESTION_INTRO,
  REQUEST_VALUE_MAX_CHARS,
  describeRequestForms,
  requestFieldKeys,
} from '../../src/kit/domain/request-forms';
import { isDomainError } from '@business-ai/core';
import type { WorkTask } from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const MODEL = 'test-model';
const SEARCH_TOOLS = ['searchKnowledgeSuppliers', 'searchWeb'] as const;
const SECRET = 'Иванов, ИНН 7700000000';
const PORTAL_HOST = 'portal.example.test';
const TASK_URL = `https://${PORTAL_HOST}/company/personal/user/1/tasks/task/view/42/`;

let deps: OrderTestDeps;
let logged: string[];
beforeEach(async () => {
  deps = await buildOrderDeps();
  logged = [];
  deps.log = (event) => {
    logged.push(event);
  };
});

function toolOf(declaration: AgentDeclaration, name: string) {
  const tool = declaration.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`инструмента ${name} нет в декларации`);
  return tool;
}

const check = (input: unknown, target: OrderCalcDeps = deps) =>
  checkRequestCompleteness.execute(input, target, CTX);

/** Отказ шлюза: код ошибки и текст с кодом замечания. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(isDomainError(error)).toBe(true);
    return error instanceof Error ? error.message : '';
  }
  throw new Error('ожидался отказ');
}

describe('checkRequestCompleteness', () => {
  test('неполный запрос: missing и один вопрос формы, без ссылки на задачу', async () => {
    const out = await check({
      requestId: REQUEST_ID,
      kind: 'personalization',
      values: { product: 'Кружка арт. 5, поставщик Х, ссылка', quantity: '300' },
    });
    expect(out.complete).toBe(false);
    expect(out.missing.map((item) => item.key)).toEqual([
      'tech_colors',
      'size_mm',
      'place',
      'sample',
    ]);
    expect(out.question?.startsWith(COMPLETENESS_QUESTION_INTRO)).toBe(true);
    expect(out.question).toContain('Технология и количество цветов');
    expect(out.question).not.toContain('Ссылка на задачу');
    expect(out.question).not.toContain('Кружка');
    expect(out.paperHint).toBeUndefined();
    expect(out).not.toHaveProperty('searchAllowed');
  });

  test('раунда «спросить и ждать» нет: вопрос приходит и в следующем ходе', async () => {
    const values = { product: 'кружка', quantity: '300' };
    await check({ requestId: REQUEST_ID, kind: 'personalization', values });
    const reply = await checkRequestCompleteness.execute(
      { requestId: REQUEST_ID, kind: 'personalization', values: { place: 'дно' } },
      deps,
      { ...CTX, turnNumber: CTX.turnNumber + 1 },
    );
    expect(reply.question?.startsWith(COMPLETENESS_QUESTION_INTRO)).toBe(true);
    expect(reply.missing.map((item) => item.key)).not.toContain('place');
    expect(reply.missing.length).toBeGreaterThan(0);
  });

  test('пустая форма: проверка не падает, ссылка на задачу не спрашивается', async () => {
    const out = await check({ requestId: REQUEST_ID, kind: 'apparel', values: {} });
    expect(out.missing.map((item) => item.key)).not.toContain('task_link');
    expect(out.question).not.toContain('Ссылка на задачу');
  });

  test('полиграфия: подсказка по бумаге приходит один раз на ответ', async () => {
    const out = await check({ requestId: REQUEST_ID, kind: 'print_bag', values: {} });
    expect(out.paperHint).toContain('170–250 г/м²');
    expect(out.missing.length).toBeGreaterThan(5);
    expect(JSON.stringify(out.missing)).not.toContain('г/м²');
  });

  test('повторный вызов дополняет значения, пустые ничего не стирают', async () => {
    await check({
      requestId: REQUEST_ID,
      kind: 'personalization',
      values: { product: 'кружка', quantity: '300' },
    });
    const second = await check({
      requestId: REQUEST_ID,
      kind: 'personalization',
      values: { quantity: '  ', place: 'дно', tech_colors: 'тампопечать, 1 цвет' },
    });
    expect(second.missing.map((item) => item.key)).toEqual(['size_mm', 'sample']);
    const stored = await loadCompleteness(deps, REQUEST_ID);
    expect(stored?.values).toEqual({
      product: 'кружка',
      quantity: '300',
      place: 'дно',
      tech_colors: 'тампопечать, 1 цвет',
    });
  });

  test('форма заполнена: complete, вопроса нет, поиск разрешён', async () => {
    const values = Object.fromEntries(requestFieldKeys('personalization').map((k) => [k, 'да']));
    const out = await check({ requestId: REQUEST_ID, kind: 'personalization', values });
    expect(out).toMatchObject({ complete: true, missing: [] });
    expect(out.question).toBeUndefined();
  });

  test('значения лежат в состоянии заявки и больше нигде: ни журнала, ни задач', async () => {
    await check({
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: SECRET },
    });
    expect(JSON.stringify(await deps.state.get(COMPLETENESS_NAMESPACE, REQUEST_ID))).toContain(
      SECRET,
    );
    expect(logged).toEqual([]);
    expect(await deps.scheduler.claimDue(new Date(deps.clock.now().getTime() + 1e12))).toEqual(
      [],
    );
  });

  test('ответ модели не содержит значений заявки', async () => {
    const out = await check({
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: SECRET },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('лишние ключи вызова игнорируются, известные сохраняются (O6, O7)', async () => {
    const out = await check({
      requestId: REQUEST_ID,
      kind: 'apparel',
      values: { colour: 'красный', color: 'синий' },
      deferred: ['нет_такого', 'lining'],
    });
    expect(out.missing.map((item) => item.key)).not.toContain('lining');
    const stored = await loadCompleteness(deps, REQUEST_ID);
    expect(stored?.values).toEqual({ color: 'синий' });
    expect(stored?.deferred).toEqual(['lining']);
  });

  test('слишком длинное значение и неизвестный вид отклоняются схемой', async () => {
    const long = 'я'.repeat(REQUEST_VALUE_MAX_CHARS + 1);
    await refusal(check({ requestId: REQUEST_ID, kind: 'apparel', values: { color: long } }));
    await refusal(check({ requestId: REQUEST_ID, kind: 'unknown', values: {} }));
  });

  test('заявки нет - not_found, состояние не создаётся', async () => {
    await refusal(check({ requestId: 'req-нет', kind: 'apparel', values: {} }));
    expect(await loadCompleteness(deps, 'req-нет')).toBeNull();
  });

  test('другой вид запроса: значения чужой формы сбрасываются', async () => {
    await check({
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: 'кружка', quantity: '10' },
    });
    await check({
      requestId: REQUEST_ID,
      kind: 'personalization',
      values: { place: 'дно' },
    });
    const stored = await loadCompleteness(deps, REQUEST_ID);
    expect(stored?.kind).toBe('personalization');
    // Ключи product и quantity есть в обеих формах, но значения прежней формы не переносятся.
    expect(stored?.values).toEqual({ place: 'дно' });
  });

  test('«прочее»: минимум есть - вопросов нет, ссылка не нужна', async () => {
    const out = await check({
      requestId: REQUEST_ID,
      kind: 'other',
      values: { product: 'ежедневники', quantity: '200', deadline: 'до 15.11' },
    });
    expect(out).toMatchObject({ complete: true, missing: [] });
    expect(out.question).toBeUndefined();
  });

  test('«прочее»: не хватает срока - один вопрос о сроке', async () => {
    const out = await check({
      requestId: REQUEST_ID,
      kind: 'other',
      values: { product: 'ежедневники', quantity: '200' },
    });
    expect(out.missing.map((item) => item.key)).toEqual(['deadline']);
    expect(out.question).toContain('Срок');
    // Известное показано в «Уже понял», но не в списке недостающего.
    expect(out.question?.split('Не хватает:')[1]).not.toContain('Что нужно');
  });

  test('промпт: для «прочее» вид у сотрудника не спрашивается', () => {
    expect(COMPLETENESS_PROMPT).toContain('о виде запроса сотрудника не спрашивай');
  });

  test('кривая ссылка на задачу - предупреждение, остальное сохраняется (O5)', async () => {
    deps.links = new MemoryPortalLinks(PORTAL_HOST);
    const wrong = [
      'нет',
      'https://other.example.test/company/personal/user/1/tasks/task/view/5/',
      `https://${PORTAL_HOST}/crm/deal/details/9/`,
    ];
    for (const value of wrong) {
      const out = await check({
        requestId: REQUEST_ID,
        kind: 'apparel',
        values: { task_link: value, color: 'синий' },
      });
      expect(out.warnings?.[0]).toContain('task_link');
      expect(out.missing.map((item) => item.key)).not.toContain('color');
    }
    const stored = await loadCompleteness(deps, REQUEST_ID);
    expect(stored?.values).toEqual({ color: 'синий' });
    const good = await check({
      requestId: REQUEST_ID,
      kind: 'apparel',
      values: { task_link: TASK_URL },
    });
    expect(good.warnings).toBeUndefined();
    expect((await loadCompleteness(deps, REQUEST_ID))?.values['task_link']).toBe(TASK_URL);
  });
});

describe('поиск не блокируется полнотой (этап 140)', () => {
  const declaration = createOrderCalcAgent({ model: MODEL, completeness: true });
  const search = (name: (typeof SEARCH_TOOLS)[number]) =>
    toolOf(declaration, name).execute({ requestId: REQUEST_ID }, deps, CTX);

  test('поиск открыт без проверки полноты', async () => {
    for (const name of SEARCH_TOOLS) expect(await search(name)).toMatchObject({ status: 'ok' });
  });

  test('поиск открыт при пустой форме и не хватающих сведениях', async () => {
    await check({ requestId: REQUEST_ID, kind: 'apparel', values: {} });
    for (const name of SEARCH_TOOLS) expect(await search(name)).toMatchObject({ status: 'ok' });
  });

  test('инструменты поиска в декларации те же, что и без флага', () => {
    const plain = createOrderCalcAgent({ model: MODEL });
    for (const name of SEARCH_TOOLS) {
      expect(toolOf(declaration, name).description).toBe(toolOf(plain, name).description);
    }
    expect(toolOf(declaration, 'searchWeb').description).toBe(searchWeb.description);
  });

  test('старая запись состояния с отказом и номером хода читается без ошибок', async () => {
    await deps.state.put(COMPLETENESS_NAMESPACE, REQUEST_ID, {
      requestId: REQUEST_ID,
      kind: 'personalization',
      values: { product: 'кружка' },
      declined: true,
      askedTurn: 3,
      updatedAt: deps.clock.now().toISOString(),
    });
    const stored = await loadCompleteness(deps, REQUEST_ID);
    expect(stored).toMatchObject({ declined: true, askedTurn: 3, deferred: [] });
    const out = await check({
      requestId: REQUEST_ID,
      kind: 'personalization',
      values: { quantity: '50' },
    });
    expect(out.question).toBeDefined();
    expect(out.missing.map((item) => item.key)).not.toContain('quantity');
    for (const name of SEARCH_TOOLS) expect(await search(name)).toMatchObject({ status: 'ok' });
  });
});

describe('декларация и флаг completeness', () => {
  test('без флага декларация прежняя: те же инструменты, промпт, без шлюза', () => {
    const baseline = createOrderCalcAgent({ model: MODEL });
    for (const declaration of [
      baseline,
      createOrderCalcAgent({ model: MODEL, completeness: false }),
    ]) {
      expect(declaration.prompt).toBe(
        ORDER_CALC_PROMPT + SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT,
      );
      expect(toolOf(declaration, 'searchWeb').execute).toBe(searchWeb.execute);
      expect(toolOf(declaration, 'searchKnowledgeSuppliers').execute).toBe(searchKnowledgeSuppliers.execute);
      const names = declaration.tools.map((tool) => tool.name);
      expect(names).not.toContain('checkRequestCompleteness');
      expect(declaration.validators).toEqual(baseline.validators);
    }
    const plain = createOrderCalcAgent({ model: MODEL });
    const off = createOrderCalcAgent({ model: MODEL, completeness: false });
    expect(off.tools).toEqual(plain.tools);
    expect(off.prompt).toBe(plain.prompt);
  });

  test('без флага поиск без проверки полноты работает как прежде', async () => {
    const out = await toolOf(createOrderCalcAgent({ model: MODEL }), 'searchWeb').execute(
      { requestId: REQUEST_ID },
      deps,
      CTX,
    );
    expect(out).toMatchObject({ status: 'ok' });
  });

  test('с флагом: один инструмент, дописанный промпт, остальные инструменты те же', () => {
    const plain = createOrderCalcAgent({ model: MODEL, intake: true });
    const on = createOrderCalcAgent({ model: MODEL, intake: true, completeness: true });
    expect(on.prompt).toBe(
      ORDER_CALC_PROMPT +
        INTAKE_PROMPT +
        COMPLETENESS_PROMPT +
        SESSION_SUMMARY_PROMPT +
        FILE_TOOL_PROMPT,
    );
    expect(on.tools.map((tool) => tool.name)).toEqual([
      ...plain.tools.map((tool) => tool.name),
      'checkRequestCompleteness',
    ]);
    expect(toolOf(on, 'searchWeb').description).toBe(searchWeb.description);
    expect(toolOf(on, 'buildShortlist').execute).toBe(toolOf(plain, 'buildShortlist').execute);
  });

  test('промпт: порядок шагов, связка с приёмом задачи и описание форм из данных', () => {
    expect(COMPLETENESS_PROMPT).toContain('readIntakeSource');
    expect(COMPLETENESS_PROMPT).toContain('saveIntakeRequest');
    expect(COMPLETENESS_PROMPT).toContain('НЕ блокирует поиск');
    // Этап 162: строку о недостающем собирает код, модель её не пишет.
    expect(COMPLETENESS_PROMPT).toContain('собирает код под шорт-листом');
    expect(COMPLETENESS_PROMPT).toContain(describeRequestForms());
    for (const banned of ['Поиск не запускай', 'спроси менеджера', 'recordCompletenessDecision']) {
      expect(COMPLETENESS_PROMPT).not.toContain(banned);
    }
    const order = ['Заявка.', 'Вид запроса.', 'Значения полей.', 'сразу вызывай поиск'];
    const positions = order.map((part) => COMPLETENESS_PROMPT.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('заявка из задачи портала -> полнота -> вопрос -> ответ -> поиск', () => {
  const HOST = 'portal.example.test';
  const TASK_LINK = `https://${HOST}/company/personal/user/1/tasks/task/view/77/`;
  const TASK: WorkTask = {
    id: '77',
    title: 'Кружки с логотипом',
    description: 'Нужны кружки белые, 300 шт, логотип компании тампопечатью в 1 цвет.',
    checklist: ['Кружки белые - 300 шт'],
  };
  const declaration = createOrderCalcAgent({ model: MODEL, intake: true, completeness: true });
  let taskDeps: OrderTestDeps;

  beforeEach(async () => {
    taskDeps = await buildOrderDeps({ request: null });
    const tasks = new MemoryTaskReader();
    tasks.set(TASK);
    taskDeps.tasks = tasks;
    taskDeps.links = new MemoryPortalLinks(HOST);
  });

  async function saveFromTask(): Promise<string> {
    const saved = await saveIntakeRequest.execute(
      {
        source: 'task',
        link: TASK_LINK,
        items: [{ name: 'Кружки белые', quantity: 300, unit: 'шт' }],
      },
      taskDeps,
      CTX,
    );
    return saved.requestId;
  }

  test('поиск и подсказка идут сразу; дополнение сотрудника сохраняется', async () => {
    const requestId = await saveFromTask();
    const webSearch = () =>
      toolOf(declaration, 'searchWeb').execute({ requestId }, taskDeps, CTX);
    // Поиск сразу после приёма, до проверки полноты.
    expect(await webSearch()).toMatchObject({ status: 'ok' });

    const first = await checkRequestCompleteness.execute(
      {
        requestId,
        kind: 'personalization',
        values: {
          product: 'Кружки белые',
          quantity: '300',
          tech_colors: 'тампопечать, 1 цвет',
        },
      },
      taskDeps,
      CTX,
    );
    expect(first.missing.map((item) => item.key)).toEqual(['size_mm', 'place', 'sample']);
    expect(first.question).toContain('Размер, мм');
    expect(first.question).not.toContain('Кружки');
    expect(await webSearch()).toMatchObject({ status: 'ok' });

    const second = await checkRequestCompleteness.execute(
      {
        requestId,
        kind: 'personalization',
        values: { size_mm: '40x40', place: 'боковая стенка', sample: 'нет' },
      },
      taskDeps,
      CTX,
    );
    expect(second).toMatchObject({ complete: true, missing: [] });
    const stored = await loadCompleteness(taskDeps, requestId);
    expect(stored?.values['tech_colors']).toBe('тампопечать, 1 цвет');
    expect(stored?.values['size_mm']).toBe('40x40');
  });

  test('заявка без ссылки на задачу (только текст): подсказка и поиск работают', async () => {
    const saved = await saveIntakeRequest.execute(
      { source: 'text', items: [{ name: 'Кружки белые', quantity: 300, unit: 'шт' }] },
      taskDeps,
      CTX,
    );
    const out = await checkRequestCompleteness.execute(
      { requestId: saved.requestId, kind: 'personalization', values: { product: 'Кружки' } },
      taskDeps,
      CTX,
    );
    expect(out.question).not.toContain('Ссылка на задачу');
    const found = await toolOf(declaration, 'searchKnowledgeSuppliers').execute(
      { requestId: saved.requestId },
      taskDeps,
      CTX,
    );
    expect(found).toMatchObject({ status: 'ok' });
  });
});

describe('отложенные ответы и «Уже понял»', () => {
  const FORM_KIND = 'custom_product';
  const ANSWERED = { quantity: '30', budget: 'самая дешёвая цена', task_link: TASK_URL };

  test('«персонализация будет позже» закрывает поле: повторно не спрашивается', async () => {
    const first = await check({ requestId: REQUEST_ID, kind: FORM_KIND, values: ANSWERED });
    expect(first.missing.map((item) => item.key)).toContain('personalization_tech');
    const second = await check({
      requestId: REQUEST_ID,
      kind: FORM_KIND,
      values: {},
      deferred: ['personalization_tech', 'personalization_size'],
    });
    const keys = second.missing.map((item) => item.key);
    expect(keys).not.toContain('personalization_tech');
    expect(keys).not.toContain('personalization_size');
    expect(keys).not.toContain('budget');
    expect(second.question?.split('Не хватает:')[1]).not.toContain('персонализации');
    expect(second.question).toContain('Уже понял:');
    expect(second.question).toContain('Бюджет, руб./шт.');
    expect(second.question).toContain('уточним позже');
  });

  test('отложено всё недостающее: вопроса нет', async () => {
    const first = await check({ requestId: REQUEST_ID, kind: FORM_KIND, values: ANSWERED });
    const rest = first.missing.map((item) => item.key);
    const out = await check({
      requestId: REQUEST_ID,
      kind: FORM_KIND,
      values: {},
      deferred: rest,
    });
    expect(out.complete).toBe(true);
    expect(out.question).toBeUndefined();
  });

  test('значение позже снимает отложенность; чужой ключ игнорируется', async () => {
    await check({ requestId: REQUEST_ID, kind: FORM_KIND, values: {}, deferred: ['sample'] });
    await check({ requestId: REQUEST_ID, kind: FORM_KIND, values: { sample: 'да' } });
    expect((await loadCompleteness(deps, REQUEST_ID))?.deferred).toEqual([]);
    await check({ requestId: REQUEST_ID, kind: FORM_KIND, values: {}, deferred: ['x'] });
    expect((await loadCompleteness(deps, REQUEST_ID))?.deferred).toEqual([]);
  });

  test('«Уже понял» не содержит значений заявки', async () => {
    const out = await check({
      requestId: REQUEST_ID,
      kind: FORM_KIND,
      values: { product: SECRET },
    });
    expect(out.question).toContain('Уже понял: Продукция');
    expect(out.question).not.toContain(SECRET);
  });

  test('запись состояния прежнего формата (без deferred) читается', async () => {
    await deps.state.put(COMPLETENESS_NAMESPACE, REQUEST_ID, {
      requestId: REQUEST_ID,
      kind: FORM_KIND,
      values: { quantity: '30' },
      declined: false,
      updatedAt: deps.clock.now().toISOString(),
    });
    expect((await loadCompleteness(deps, REQUEST_ID))?.deferred).toEqual([]);
    const out = await check({
      requestId: REQUEST_ID,
      kind: FORM_KIND,
      values: {},
      deferred: ['sample'],
    });
    expect(out.missing.map((item) => item.key)).not.toContain('sample');
  });
});
