import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  FixedClock,
  MastraAgentRuntime,
  MemoryAccessPolicy,
  MemoryAuditRepository,
  MemoryIdempotencyStore,
  MemoryThreadStore,
  createMemoryDurableSteps,
} from '@business-ai/adapters';
import {
  AGENT_CALL_ISSUE,
  agentCallThreadId,
  defineAgentCallTool,
  toRunSpec,
  type AgentCallCapable,
  type AgentDeclaration,
} from '@business-ai/core';
import { ORDER_CALC_AGENT_ID, type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { PRICES_AGENT_ID, type PricesDeps } from '../../src/agents/prices/deps';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import type { ModelRequest } from '@business-ai/core';
import { askHuman, callTool, say, ScriptedGateway } from '../kit/adapters/mastra/support';
import { buildOrderDeps } from './order-support';
import { buildFullPricesDeps } from './prices-support';
import { toolMessages } from './support';

/**
 * Пример пары «Поиск поставщика (ИИ агент)» спрашивает «Актуализация прайса (ИИ агент)» в одном
 * ходе. В боевую декларацию пара НЕ
 * включена (у агента «Актуализация прайса (ИИ агент)» нет безопасного чтения актуальной цены по
 * позициям), поэтому инструмент
 * определён здесь и подключается к реальным декларациям тестовой обёрткой.
 */

const THREAD = 'chat-1';
const USER = 'user-1';
const REQUEST_ID = 'req-1';
const POSITIONS = ['Арматура 12 мм', 'Болт М8'];
const BUDGET_MS = 10 * 60_000;
const ASK_TOOL = 'askPricesForPositions';
const ANSWER = 'Цены проверены.';
const QUESTION = 'Какой прайс считать основным?';
const CHILD_ANSWER = JSON.stringify({
  positions: POSITIONS.map((name) => ({ name, status: 'actual' })),
});

const inputSchema = z.object({
  requestId: z.string().min(1),
  positions: z.array(z.string().min(1)).min(1).max(30),
});
const outputSchema = z.object({
  positions: z.array(z.object({ name: z.string(), status: z.enum(['actual', 'stale']) })),
});

/** Ввод дочернему агенту собирает код из проверенной структуры, а не модель родителя. */
function buildPricesQuestion(input: z.infer<typeof inputSchema>): string {
  const lines = input.positions.map((position) => `- ${position}`).join('\n');
  return (
    `Заявка ${input.requestId}: сообщи актуальность цен по позициям. Только чтение, ` +
    `ничего не запрашивай у поставщиков и не записывай.\nПозиции:\n${lines}`
  );
}

const asked = defineAgentCallTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  OrderCalcDeps
>({
  name: ASK_TOOL,
  description: 'Спросить «Актуализация прайса (ИИ агент)» об актуальности цен по позициям ' +
    'заявки (только чтение).',
  from: ORDER_CALC_AGENT_ID,
  target: PRICES_AGENT_ID,
  inputSchema,
  outputSchema,
  buildInput: buildPricesQuestion,
});

/**
 * Для проверки цикла: «Актуализация прайса (ИИ агент)» пытаются вызвать «Поиск поставщика (ИИ
 * агент)» обратно.
 */
const askBack = defineAgentCallTool<
  { note: string },
  { ok: boolean },
  PricesDeps & AgentCallCapable
>({
  name: 'askOrderCalc',
  description: 'Спросить «Поиск поставщика (ИИ агент)» (в боевой системе такого инструмента нет).',
  from: PRICES_AGENT_ID,
  target: ORDER_CALC_AGENT_ID,
  inputSchema: z.object({ note: z.string().min(1) }),
  outputSchema: z.object({ ok: z.boolean() }),
  buildInput: (input) => input.note,
});

interface WorldOptions {
  allowed?: boolean;
  childSteps?: (step: number, request: ModelRequest) => ReturnType<typeof say>;
  /**
   * «Актуализация прайса (ИИ агент)» с вопросом человеку (askHuman добавлен к реальной декларации).
   */
  childAsks?: boolean;
}

async function createWorld(options: WorldOptions = {}) {
  const clock = new FixedClock();
  const mem = createMemoryDurableSteps(clock);
  const access = new MemoryAccessPolicy();
  if (options.allowed !== false) {
    access.allow({
      userId: USER,
      botId: PRICES_AGENT_ID,
      action: 'chat.message',
    });
    access.allow({
      userId: USER,
      botId: ORDER_CALC_AGENT_ID,
      action: 'chat.message',
    });
  }
  const audit = new MemoryAuditRepository();
  const capable: AgentCallCapable = {
    agentCall: { steps: mem.steps, state: mem.state, clock, access, audit },
  };
  const orderDeps = {
    ...(await buildOrderDeps()),
    ...capable,
  } as OrderCalcDeps;
  const pricesDeps = { ...(await buildFullPricesDeps()), ...capable };

  const realParent = createOrderCalcAgent({ model: ORDER_CALC_AGENT_ID });
  const parent: AgentDeclaration = {
    ...realParent,
    tools: [...realParent.tools, asked.tool],
    validators: [...realParent.validators, asked.validator],
  };
  const realChild = createPricesAgent({ model: PRICES_AGENT_ID });
  const child: AgentDeclaration = {
    ...realChild,
    tools: [...realChild.tools, askBack.tool, ...(options.childAsks === true ? [askHuman] : [])],
    validators: [...realChild.validators, askBack.validator],
  };

  const stepOf = (request: ModelRequest): number => {
    const lastUser = request.messages.map((m) => m.role).lastIndexOf('user');
    return request.messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
  };
  const gateway = new ScriptedGateway((request) => {
    const step = stepOf(request);
    if (request.model === ORDER_CALC_AGENT_ID) {
      return step === 0
        ? callTool('p1', ASK_TOOL, {
            requestId: REQUEST_ID,
            positions: POSITIONS,
          })
        : say(ANSWER);
    }
    if (options.childSteps !== undefined) return options.childSteps(step, request);
    return step === 0 ? callTool('c1', 'listStalePriceSuppliers', {}) : say(CHILD_ANSWER);
  });
  const runtime = new MastraAgentRuntime({
    models: gateway,
    declarations: [parent, child],
    agentDeps: {
      [ORDER_CALC_AGENT_ID]: orderDeps,
      [PRICES_AGENT_ID]: pricesDeps,
    },
    threads: new MemoryThreadStore(),
    idempotency: new MemoryIdempotencyStore(),
    audit,
    clock,
  });
  const run = (text = 'Проверь цены по заявке') =>
    runtime.run(toRunSpec(parent), THREAD, text, {
      context: {
        initiator: { kind: 'user', userId: USER },
        deadlineAtMs: clock.now().getTime() + BUDGET_MS,
      },
    });
  const childThread = agentCallThreadId(
    THREAD,
    1,
    PRICES_AGENT_ID,
    buildPricesQuestion({ requestId: REQUEST_ID, positions: POSITIONS }),
  );
  return { runtime, gateway, audit, run, childThread, orderDeps };
}

const childRequests = (gateway: ScriptedGateway) =>
  gateway.requests.filter((request) => request.model === PRICES_AGENT_ID);
const parentRequests = (gateway: ScriptedGateway) =>
  gateway.requests.filter((request) => request.model === ORDER_CALC_AGENT_ID);

describe('«Поиск поставщика (ИИ агент)» спрашивает «Актуализация прайса (ИИ агент)» (пример, не ' +
  'боевая пара)', () => {
  test('итог дочернего возвращается в тот же ход, читает инструмент агента «Актуализация прайса ' +
    '(ИИ агент)»', async () => {
    const world = await createWorld();
    const result = await world.run();

    expect(result.status).toBe('completed');
    expect(result.output).toBe(ANSWER);
    // Дочерний вызвал настоящий read-only инструмент агента «Актуализация прайса (ИИ агент)» и
    // ответил по Zod-структуре.
    const second = childRequests(world.gateway)[1];
    expect(toolMessages(second).join('')).toContain('suppliers');
    // Родитель получил структурированный итог в этом же ходе (второй запрос модели родителя).
    const parentSecond = parentRequests(world.gateway)[1];
    expect(toolMessages(parentSecond).join('')).toContain('"status":"done"');
    expect(toolMessages(parentSecond).join('')).toContain('Болт М8');
    const child = await world.runtime.getThread(world.childThread);
    expect(child?.status).toBe('completed');
    const finished = (await world.audit.list()).filter(
      (entry) => entry.action === 'agent_call' && entry.result === 'ok',
    );
    expect(finished).toHaveLength(1);
  });

  test('needs_human: дочерний не приостановлен, вопрос возвращается родителю', async () => {
    const world = await createWorld({
      childAsks: true,
      childSteps: (step) =>
        step === 0 ? callTool('c1', askHuman.name, { question: QUESTION }) : say(CHILD_ANSWER),
    });
    const result = await world.run();

    expect(result.status).toBe('completed');
    const parentSecond = parentRequests(world.gateway)[1];
    const text = toolMessages(parentSecond).join('');
    expect(text).toContain('needs_human');
    expect(text).toContain(QUESTION);
    // Дочерний тред не остаётся приостановленным: вопрос задаёт родитель.
    const child = await world.runtime.getThread(world.childThread);
    expect(child?.status).not.toBe('suspended');
  });

  test('отказ по правам: у сотрудника нет доступа к агенту «Актуализация прайса (ИИ агент)», ' +
    'дочерний не стартует', async () => {
    const world = await createWorld({ allowed: false });
    const result = await world.run();

    expect(result.status).toBe('completed');
    expect(childRequests(world.gateway)).toHaveLength(0);
    expect(await world.runtime.getThread(world.childThread)).toBeNull();
    const parentSecond = parentRequests(world.gateway)[1];
    expect(toolMessages(parentSecond).join('')).toContain(AGENT_CALL_ISSUE.accessDenied);
  });

  test('цикл: дочерний не может вызвать обратно «Поиск поставщика (ИИ агент)»', async () => {
    const world = await createWorld({
      childSteps: (step) =>
        step === 0
          ? callTool('c1', 'askOrderCalc', { note: 'вернись к расчёту' })
          : say(CHILD_ANSWER),
    });
    const result = await world.run();

    expect(result.status).toBe('completed');
    // Запросов к модели агента «Поиск поставщика (ИИ агент)» только два (его собственный ход):
    // вложенного нет.
    expect(parentRequests(world.gateway)).toHaveLength(2);
    const second = childRequests(world.gateway)[1];
    expect(toolMessages(second).join('')).toContain(AGENT_CALL_ISSUE.cycle);
  });
});
