import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// zod лежит в зависимостях core (у e2e нет своего node_modules): берём ту же копию, что у ядра.
import { z } from 'zod';
import {
  MemoryChatChannel,
  MemoryCrm,
  MastraAgentRuntime,
  SystemClock,
  type PgClient,
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
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { composeProduction } from '../lib/project-env';
import { type ProductionApp } from '@business-ai/core/compose';
import { DualLlmStub, stepInTurn, type DualHandler } from '@business-ai/testing/e2e';
import { e2eConfig, e2eEnv, openDb } from '../lib/project-env';
import {
  ORDER_CALC_MODEL,
  PRICES_MODEL,
  handoffAudit,
  parentHandoffReply,
  resetHandoffTables,
  writeAccessRules,
} from '../lib/handoff-core';
import { toolResults } from '@business-ai/testing/e2e';
import { BUYER_PII } from '../lib/pii.owned';
import { findLeaks, REAL_PERSON, REAL_PHONE } from '@business-ai/testing/e2e';

/**
 * Сценарий m: синхронный вызов агента (этап 37, `AGENT_CALL_ENABLED`) на настоящих Postgres
 * (долговечные шаги, аренда, индекс вызовов), pseudonymizer и pii-guard.
 *
 * В боевой композиции НЕТ конкретного инструмента на `defineAgentCallTool`: флаг лишь
 * подключает порты вызова к зависимостям агентов. Поэтому инструмент «Поиск поставщика (ИИ агент)»
 * спрашивает «Актуализация прайса (ИИ агент)» объявлен здесь (как в примере core) и добавлен к
 * НАСТОЯЩЕЙ декларации
 * Агента «Поиск поставщика (ИИ агент)»; рантайм собран из частей боевого приложения (модели с
 * псевдонимизацией,
 * хранилища, зависимости агентов с портами вызова, права по файлу правил).
 */

const USER = 'emp-e2e-m';
const USER_NO_PRICES = 'emp-e2e-m-noprices';
const THREAD = 'e2e-m-thread';
const ASK_TOOL = 'askPricesForPositions';
const REQUEST_ID = 'req-e2e-m';
const POSITION = 'Арматура А500С d12';
const BUDGET_MS = 10 * 60_000;
const FIRST_TURN = 1;
const PARENT_FINAL = 'Цены по заявке проверены.';

const inputSchema = z.object({
  requestId: z.string().min(1),
  positions: z.array(z.string().min(1)).min(1).max(30),
});
const outputSchema = z.object({
  positions: z.array(z.object({ name: z.string(), status: z.enum(['actual', 'stale']) })),
});

/** Ввод дочернему агенту строит код из проверенной структуры, а не модель родителя. */
function buildChildInput(input: z.infer<typeof inputSchema>): string {
  const lines = input.positions.map((position) => `- ${position}`).join('\n');
  return (
    `Заявка ${input.requestId}: сообщи актуальность цен по позициям. Только чтение, ` +
    `ничего не запрашивай у поставщиков и не записывай.\nПозиции:\n${lines}`
  );
}

const askTool = defineAgentCallTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  OrderCalcDeps & AgentCallCapable
>({
  name: ASK_TOOL,
  description: 'Спросить «Актуализация прайса (ИИ агент)» об актуальности цен по позициям ' +
    'заявки (только чтение).',
  from: ORDER_CALC_AGENT_ID,
  target: PRICES_AGENT_ID,
  inputSchema,
  outputSchema,
  buildInput: buildChildInput,
});

const stub = new DualLlmStub();
let db: PgClient;
let rules = '';
const apps: ProductionApp[] = [];
/** Сколько раз родитель вызывает инструмент за ход (повтор проверяет шаг и аренду). */
let callsPerTurn = 1;

function lastResultText(body: Record<string, unknown>): string {
  return JSON.stringify(toolResults(body).get(ASK_TOOL)?.at(-1) ?? null);
}

const script: DualHandler = ({ model, raw, body }) => {
  if (model === ORDER_CALC_MODEL) {
    const step = stepInTurn(body);
    if (step >= callsPerTurn) {
      return { kind: 'text', text: `${PARENT_FINAL} ${lastResultText(body)}` };
    }
    return parentHandoffReply(raw, ASK_TOOL, REQUEST_ID, POSITION);
  }
  if (model !== PRICES_MODEL) throw new Error(`неизвестная модель ${model}`);
  if (stepInTurn(body) === 0) return { kind: 'tool', name: 'listStalePriceSuppliers', input: {} };
  // Позиции берутся из ввода (в токенах): настоящее имя вернётся только после восстановления.
  const position = /^- (.+)$/m.exec(raw.replaceAll('\\n', '\n'))?.[1]?.replace(/"[\s\S]*$/, '');
  if (position === undefined) throw new Error('во вводе дочернему агенту нет позиций');
  const answer = { positions: [{ name: position, status: 'actual' }] };
  return { kind: 'text', text: JSON.stringify(answer) };
};

/** Боевое приложение + рантайм с инструментом вызова у агента «Поиск поставщика (ИИ агент)». */
function build(env: Record<string, string>) {
  const config = e2eConfig({
    ACCESS_POLICY_FILE: rules,
    CHAT_AGENT_ID: ORDER_CALC_AGENT_ID,
    ...env,
  });
  const app = composeProduction(config, {
    chat: new MemoryChatChannel(),
    crm: new MemoryCrm(new Map()),
  });
  apps.push(app);
  const base = app.registry.get(ORDER_CALC_AGENT_ID);
  const parent: AgentDeclaration = {
    ...base,
    tools: [...base.tools, askTool.tool],
    validators: [...base.validators, askTool.validator],
  };
  const declarations = app.registry
    .list()
    .map((declaration) => (declaration.id === ORDER_CALC_AGENT_ID ? parent : declaration));
  const runtime = new MastraAgentRuntime({
    models: app.models,
    declarations,
    agentDeps: app.agentDeps,
    threads: app.threads,
    idempotency: app.idempotency,
    audit: app.audit,
    metrics: app.metrics,
    clock: new SystemClock(),
  });
  const run = (userId: string, text: string) =>
    runtime.run(toRunSpec(parent), THREAD, text, {
      context: {
        initiator: { kind: 'user', userId },
        deadlineAtMs: Date.now() + BUDGET_MS,
      },
    });
  return { app, runtime, run, config };
}

const TEXT = `Проверь цены: ${POSITION} для ${REAL_PERSON}, тел. ${REAL_PHONE}`;
const childThreadId = (): string =>
  agentCallThreadId(
    THREAD,
    FIRST_TURN,
    PRICES_AGENT_ID,
    buildChildInput({ requestId: REQUEST_ID, positions: [`${POSITION} для ${REAL_PERSON}`] }),
  );

function expectNoLeaks(): void {
  expect(stub.errors).toEqual([]);
  expect(findLeaks(stub.bodies(), BUYER_PII)).toEqual([]);
  expect(stub.bodies().join('\n')).not.toContain('555-12-34');
}

beforeAll(async () => {
  db = openDb();
  stub.start(e2eEnv().llmPort);
  rules = await writeAccessRules('m', {
    'order-calc': [USER, USER_NO_PRICES],
    prices: [USER],
  });
});

beforeEach(async () => {
  await resetHandoffTables(db);
  stub.begin(script);
  callsPerTurn = 1;
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
});

afterAll(async () => {
  await resetHandoffTables(db);
  await db.close();
  await stub.stop();
});

describe('сценарий m: синхронный вызов агента на настоящих сервисах', () => {
  test('флаг только подключает порты: декларации и инструменты прежние', () => {
    const off = build({});
    const on = build({ AGENT_CALL_ENABLED: 'true' });
    // Флаг проекта читается из конфигурации (в ProductionApp платформы поля `agentCallEnabled` нет).
    expect(off.config.project['AGENT_CALL_ENABLED']).toBe('false');
    expect(on.config.project['AGENT_CALL_ENABLED']).toBe('true');
    const names = (app: ProductionApp): string[] =>
      app.registry
        .list()
        .flatMap((declaration) => declaration.tools.map((tool) => `${declaration.id}.${tool.name}`))
        .sort();
    // В боевой композиции нет ни одного инструмента вызова: флаг набор инструментов не меняет.
    expect(names(on.app)).toEqual(names(off.app));
    const orderOff = off.app.agentDeps[ORDER_CALC_AGENT_ID] as AgentCallCapable;
    const orderOn = on.app.agentDeps[ORDER_CALC_AGENT_ID] as AgentCallCapable;
    expect(orderOff.agentCall).toBeUndefined();
    expect(orderOn.agentCall).toBeDefined();
  });

  test('итог дочернего агента возвращается в тот же ход, без ПДн в трафике', async () => {
    const { run, runtime } = build({ AGENT_CALL_ENABLED: 'true' });
    const result = await run(USER, TEXT);
    expect(stub.errors).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.output).toContain(PARENT_FINAL);
    // Родитель получил структурированный итог: статус done и позицию с настоящим именем.
    expect(result.output).toContain('"status":"done"');
    expect(result.output).toContain(REAL_PERSON);
    expect(stub.ofModel(ORDER_CALC_MODEL)).toHaveLength(2);
    expect(stub.ofModel(PRICES_MODEL)).toHaveLength(2); // инструмент и итог
    const child = await runtime.getThread(childThreadId());
    expect(child?.status).toBe('completed');
    const audit = await handoffAudit(db, 'agent_call');
    expect(audit.map((entry) => `${entry.stage}:${entry.result}`)).toEqual([
      'started:started',
      'finished:ok',
    ]);
    expect(audit.map((entry) => entry.details).join('\n')).not.toContain('Сидоров');
    // Дочерние запросы к модели ушли в токенах, а не с настоящим именем клиента.
    expect(stub.ofModel(PRICES_MODEL).every((request) => /\[PERSON_\d+\]/.test(request.raw))).toBe(
      true,
    );
    expectNoLeaks();
  });

  test('повторный вызов с тем же вводом берёт итог шага, дочерний не стартует снова', async () => {
    callsPerTurn = 2;
    const { run } = build({ AGENT_CALL_ENABLED: 'true' });
    const result = await run(USER, TEXT);
    expect(result.status).toBe('completed');
    expect(stub.ofModel(ORDER_CALC_MODEL)).toHaveLength(3);
    expect(stub.ofModel(PRICES_MODEL)).toHaveLength(2); // дочерний отработал один раз
    const audit = await handoffAudit(db, 'agent_call');
    const finished = audit.filter((entry) => entry.stage === 'finished');
    expect(finished).toHaveLength(1);
    expectNoLeaks();
  });

  test('отказ по правам: у сотрудника нет доступа к агенту «Актуализация прайса (ИИ агент)», ' +
    'дочерний не стартует', async () => {
    const { run, runtime } = build({ AGENT_CALL_ENABLED: 'true' });
    const result = await run(USER_NO_PRICES, TEXT);
    expect(result.status).toBe('completed');
    expect(result.output).toContain(AGENT_CALL_ISSUE.accessDenied);
    expect(stub.ofModel(PRICES_MODEL)).toEqual([]);
    expect(await runtime.getThread(childThreadId())).toBeNull();
    expect(await handoffAudit(db, 'agent_call')).toEqual([]);
    expectNoLeaks();
  });

  test('флаг выключен: инструмент отвечает «не подключено», дочерний не стартует', async () => {
    const { run } = build({});
    const result = await run(USER, TEXT);
    expect(result.status).toBe('completed');
    expect(result.output).toContain(AGENT_CALL_ISSUE.notConfigured);
    expect(stub.ofModel(PRICES_MODEL)).toEqual([]);
    expectNoLeaks();
  });
});
