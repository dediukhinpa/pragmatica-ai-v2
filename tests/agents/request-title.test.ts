import { z } from 'zod';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createToolContext } from '@business-ai/core';
import {
  fallbackRequestTitle,
  labelsOf,
  requestLabel,
  resolveRequestRef,
  sanitizeRequestTitle,
  withRequestRef,
} from '../../src/agents/order-calc/request-title';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { recordWorkOwner } from '@business-ai/core';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import { DomainError } from '@business-ai/core';
import type { AnyToolDefinition } from '@business-ai/core';
import { buildOrderDeps, type OrderTestDeps } from './order-support';

/** Тред связки «бот/сотрудник»: по нему код узнаёт, чьи заявки искать. */
const THREAD = 'bot/u1';
const OTHER_THREAD = 'bot/u2';
const ctxOf = (threadId: string) =>
  createToolContext({ threadId, agentId: 'test-agent', operationId: `op-${threadId}` });

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps({ request: null });
});

const save = (input: unknown, threadId = THREAD) =>
  saveIntakeRequest.execute(input, deps, ctxOf(threadId));

describe('название заявки: проверка и сборка кодом', () => {
  test('нормальное название от модели принимается и обрезается по слову', () => {
    expect(sanitizeRequestTitle('  мёд с орехами ')).toBe('мёд с орехами');
    const long = sanitizeRequestTitle('коробка '.repeat(20));
    expect((long ?? '').length).toBeLessThanOrEqual(60);
    expect(long?.endsWith('коробка')).toBe(true);
  });

  test.each([
    ['req-984a54499693a138'],
    ['Иванов Иван Иванович'],
    ['пледы +7 999 123-45-67'],
    ['заказ 12345678'],
    ['mail me@test.example'],
    ['   '],
  ])('«%s» не годится: название соберёт код', (raw) => {
    expect(sanitizeRequestTitle(raw)).toBeNull();
  });

  test('без названия от модели - первые три позиции', () => {
    const items = [
      { name: 'Мёд с орехами (банка 250 г)', quantity: 1, unit: 'шт' },
      { name: 'Пледы', quantity: 1, unit: 'шт' },
      { name: 'Коробка', quantity: 1, unit: 'шт' },
      { name: 'Четвёртая', quantity: 1, unit: 'шт' },
    ];
    expect(fallbackRequestTitle(items)).toBe('Мёд с орехами, Пледы, Коробка');
  });

  test('одинаковые названия получают дату создания', () => {
    const labels = labelsOf([
      { requestId: 'a', title: 'Пледы', createdAt: '2026-10-27T09:00:00.000Z' },
      { requestId: 'b', title: 'пледы', createdAt: '2026-10-28T09:00:00.000Z' },
      { requestId: 'c', title: 'Мёд', createdAt: '2026-10-28T09:00:00.000Z' },
    ]);
    expect(labels.get('a')).toBe('Пледы от 27.10');
    expect(labels.get('b')).toBe('пледы от 28.10');
    expect(labels.get('c')).toBe('Мёд');
  });
});

describe('название заявки при приёме', () => {
  test('название модели сохраняется и показывается вместо id', async () => {
    const out = await save({
      source: 'text',
      title: 'мёд с орехами',
      items: [{ name: 'Мёд цветочный с грецким орехом', quantity: 5, unit: 'шт' }],
    });
    expect(out.title).toBe('мёд с орехами');
    expect(await requestLabel(deps, out.requestId)).toBe('мёд с орехами');
  });

  test('модель дала id вместо названия - название из позиций', async () => {
    const out = await save({
      source: 'text',
      title: 'req-984a54499693a138',
      items: [{ name: 'Пледы', quantity: 3, unit: 'шт' }],
    });
    expect(out.title).toBe('Пледы');
  });

  test('старая заявка без записи названия - название из позиций при показе', async () => {
    const old = await deps.requests.get('req-1');
    expect(old).toBeNull();
    await deps.requests.save({
      id: 'req-old',
      dealRef: 'D-9',
      items: [{ name: 'Фарфоровые конфеты', quantity: 10, unit: 'шт' }],
      createdAt: '2026-10-20T09:00:00.000Z',
    });
    expect(await requestLabel(deps, 'req-old')).toBe('Фарфоровые конфеты');
    expect(await requestLabel(deps, 'req-missing')).not.toContain('req-');
  });
});

describe('поиск заявки по названию', () => {
  test('название находит заявку сотрудника, id и чужие заявки не затрагиваются', async () => {
    const mine = await save({
      source: 'text',
      title: 'пледы',
      items: [{ name: 'Плед флисовый', quantity: 3, unit: 'шт' }],
    });
    const theirs = await save(
      {
        source: 'text',
        title: 'коробка для адвент-календаря',
        items: [{ name: 'Коробка', quantity: 3, unit: 'шт' }],
      },
      OTHER_THREAD,
    );
    expect(await resolveRequestRef(deps, 'Пледы', THREAD)).toBe(mine.requestId);
    expect(await resolveRequestRef(deps, mine.requestId, THREAD)).toBe(mine.requestId);
    // Чужая заявка по названию не находится: ссылка остаётся как есть.
    expect(await resolveRequestRef(deps, 'адвент-календаря', THREAD)).toBe('адвент-календаря');
    expect(await resolveRequestRef(deps, 'адвент', OTHER_THREAD)).toBe(theirs.requestId);
  });

  test('старая заявка без названия, которую сотрудник ведёт (шорт-лист без отправки)', async () => {
    await deps.requests.save({
      id: 'req-old',
      dealRef: 'D-9',
      items: [{ name: 'Мёд с орехами', quantity: 30, unit: 'шт' }],
      createdAt: '2026-10-28T09:00:00.000Z',
    });
    // Ни записи названия, ни отправленных запросов: только владелец работы по заявке
    await recordWorkOwner(deps.state, workSubject.order('req-old'), ctxOf(THREAD));
    expect(await resolveRequestRef(deps, 'мёд с орехами', THREAD)).toBe('req-old');
    // Чужому сотруднику заявка по названию не находится
    expect(await resolveRequestRef(deps, 'мёд с орехами', OTHER_THREAD)).toBe('мёд с орехами');
  });

  test('одинаковые названия: вопрос списком, а с датой - одна заявка', async () => {
    const first = await save({
      source: 'text',
      title: 'пледы',
      items: [{ name: 'Плед', quantity: 1, unit: 'шт' }],
    });
    deps.clock.advance(24 * 60 * 60 * 1000);
    const second = await save({
      source: 'text',
      title: 'пледы',
      items: [{ name: 'Плед', quantity: 2, unit: 'шт' }],
    });
    expect(first.requestId).not.toBe(second.requestId);
    const error = await resolveRequestRef(deps, 'пледы', THREAD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).not.toContain('req-');
    expect((error as DomainError).message).toContain('пледы от ');
    const label = await requestLabel(deps, second.requestId);
    expect(await resolveRequestRef(deps, label, THREAD)).toBe(second.requestId);
  });

  test('инструмент по заявке понимает название в requestId', async () => {
    const saved = await save({
      source: 'text',
      title: 'пледы',
      items: [{ name: 'Плед', quantity: 1, unit: 'шт' }],
    });
    const base: Omit<AnyToolDefinition, 'inputSchema'> = {
      name: 't',
      description: '',
      outputSchema: z.unknown(),
      execute: async () => null,
    };
    const wrapped = withRequestRef({ ...base, inputSchema: z.object({ requestId: z.string() }) });
    const resolved = await wrapped.resolveInput?.({ requestId: 'пледы' }, deps, THREAD);
    expect(resolved).toEqual({ requestId: saved.requestId });
    // Инструмент без requestId не трогаем.
    const plain = withRequestRef({ ...base, inputSchema: z.object({}) });
    expect(plain.resolveInput).toBeUndefined();
  });

  test('все инструменты агента по заявке получают подмену названия', () => {
    const tools = createOrderCalcAgent({ model: 'm', mailbox: true, intake: true }).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ['buildShortlist', 'orderStatus', 'closeOrder', 'remindManager']) {
      expect(byName.get(name)?.resolveInput).toBeDefined();
    }
    expect(byName.get('saveIntakeRequest')?.resolveInput).toBeUndefined();
  });
});
