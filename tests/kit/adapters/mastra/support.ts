import { z } from 'zod';
import {
  defineTool,
  toRunSpec,
  ToolSuspension,
  type AgentDeclaration,
  type AgentValidator,
} from '@business-ai/core';
import { validateOutreachRecipients } from '../../../../src/kit/domain/validators.owned';
import { type ShortList } from '../../../../src/kit/domain/models';
import {
  MastraAgentRuntime,
  MemoryModelGateway,
  type MastraAgentRuntimeOptions,
  type MemoryModelGatewayOptions,
  type TurnScript,
} from '@business-ai/adapters';
import type { JsonValue, ModelRequest, ModelResponse } from '@business-ai/core';
import { noteModelRequest } from '@business-ai/testing';

/** Ответ заглушки модели на шаг: текст или вызов инструмента. */
export type Step = Omit<ModelResponse, 'model'>;

/** Параметры заглушки со сценарием. */
export interface ScriptedGatewayOptions extends MemoryModelGatewayOptions {
  /**
   * Серии цифр, которые в этом тесте являются содержимым (реквизиты, артикул), а не
   * техническим идентификатором: общая проверка «модели не уходят серии цифр» их пропускает.
   * Остальные серии по-прежнему считаются нарушением.
   */
  contentDigitSeries?: readonly string[];
}

/**
 * Заглушка шлюза с заранее заданными шагами; `requests.length` = число вызовов модели.
 * Каждый запрос проверяется на серии цифр (см. tests/support/setup.ts): так инвариант
 * действует во всех сценариях агентов, а не в одном отдельном тесте.
 */
export class ScriptedGateway extends MemoryModelGateway {
  constructor(
    steps: Step[] | ((request: ModelRequest, call: number) => Step),
    options: ScriptedGatewayOptions = {},
  ) {
    let call = 0;
    super((request) => {
      const index = call++;
      noteModelRequest(request, index, options.contentDigitSeries);
      if (typeof steps === 'function') return steps(request, index);
      return steps[index] ?? { content: 'сценарий закончился', stopReason: 'end_turn' };
    }, options);
  }
}

/** Шаги сценария: список по порядку либо функция от запроса и номера вызова модели. */
export type StepFn = (request: ModelRequest, call: number) => Step;

/** Необязательные части сборки: параметры заглушки и остальные опции рантайма. */
export interface ScriptedRuntimeOptions {
  gateway?: ScriptedGatewayOptions;
  runtime?: Omit<MastraAgentRuntimeOptions, 'models' | 'declarations' | 'toolDeps'>;
}

/** Рантайм одного агента на заглушке шлюза со сценарием: шлюз, рантайм и спецификация запуска. */
export function scriptedRuntime(
  declaration: AgentDeclaration,
  toolDeps: unknown,
  steps: Step[] | StepFn,
  options: ScriptedRuntimeOptions = {},
) {
  const gateway = new ScriptedGateway(steps, options.gateway);
  const runtime = new MastraAgentRuntime({
    models: gateway,
    declarations: [declaration],
    toolDeps,
    ...options.runtime,
  });
  return { gateway, runtime, spec: toRunSpec(declaration) };
}

export function say(text: string): Step {
  return { content: text, stopReason: 'end_turn' };
}

export function callTool(id: string, name: string, args: Record<string, unknown>): Step {
  const toolCall = { id, name, arguments: JSON.parse(JSON.stringify(args)) };
  return { content: '', toolCalls: [toolCall], stopReason: 'tool_use' };
}

/** Зависимости тестовых инструментов: журнал побочных эффектов. */
export interface TestDeps {
  sent: Array<{ ids: string[]; subject: string }>;
}

export const SHORT_LIST: ShortList = {
  requestId: 'req-1',
  supplierIds: ['s1', 's2'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const sendOutreach = defineTool({
  name: 'sendOutreach',
  description: 'Отправить рассылку поставщикам',
  sideEffect: true,
  inputSchema: z.object({
    recipientSupplierIds: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
  }),
  outputSchema: z.object({ sent: z.number() }),
  idempotencyKey: (input) => `req-1:${input.subject}`,
  async execute(input, deps: TestDeps) {
    deps.sent.push({ ids: input.recipientSupplierIds, subject: input.subject });
    return { sent: input.recipientSupplierIds.length };
  },
});

export const lookup = defineTool({
  name: 'lookup',
  description: 'Найти поставщика',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ found: z.string() }),
  async execute(input, _deps: TestDeps) {
    return { found: `найден ${input.query}` };
  },
});

export const askHuman = defineTool({
  name: 'askHuman',
  description: 'Спросить человека и подождать ответа',
  inputSchema: z.object({ question: z.string() }),
  outputSchema: z.object({ never: z.string() }),
  async execute(input, _deps: TestDeps) {
    throw new ToolSuspension(`ждём выбор человека: ${input.question}`);
  },
});

export const outreachValidator: AgentValidator = {
  name: 'outreach-recipients',
  appliesTo: ['sendOutreach'],
  validate: (input) => {
    const draft = input as { recipientSupplierIds: string[]; subject: string; body: string };
    return validateOutreachRecipients(draft, SHORT_LIST);
  },
};

export function buildDeclaration(id = 'buyer'): AgentDeclaration {
  return {
    id,
    prompt: 'Ты помощник закупщика.',
    model: 'test-model',
    tools: [lookup, sendOutreach, askHuman],
    validators: [outreachValidator],
  };
}

/** Разобрать текст ответа инструмента из сообщения запроса: JSON либо сам текст. */
function parseToolText(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/**
 * Шлюз по сценарию ходов (тот же `TurnScript`, что у рантайма памяти): агент определяется
 * по `model` запроса (в тестах модель = id агента), шаг - по числу ответов инструментов после
 * последней реплики человека. Так один сценарий проверяется на обоих рантаймах.
 */
export function scriptedTurnGateway(
  script: TurnScript,
  options: ScriptedGatewayOptions = {},
): ScriptedGateway {
  return new ScriptedGateway((request) => {
    const lastUser = request.messages.map((m) => m.role).lastIndexOf('user');
    const input = request.messages[lastUser]?.content ?? '';
    const plan = script(request.model, input);
    if (plan === undefined) return say(`echo: ${input}`);
    const done = request.messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
    const next = plan.calls[done.length];
    if (next !== undefined) {
      return callTool(`c${done.length + 1}`, next.tool, next.args);
    }
    return say(plan.reply(done.map((m) => parseToolText(m.content))));
  }, options);
}
