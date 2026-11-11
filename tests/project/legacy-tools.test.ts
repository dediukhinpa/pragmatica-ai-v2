import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MemoryChatChannel, MemoryIntakeStore, MemoryTableExporter } from '@business-ai/adapters';
import {
  createFileWarningsTool,
  createToolContext,
  withFeedbackTool,
  type AgentDeclaration,
  type AnyToolDefinition,
  type CreateFileHost,
  SCRIPT_FIX_STEPS,
  scriptTurnOf,
  type ScriptRunOutcome,
  type ScriptRunRequest,
  type ScriptSandbox,
  type ToolContext,
} from '@business-ai/core';
import { removeTempDirs } from '@business-ai/testing';
// Перевод Zod в JSON Schema берётся тем же файлом, что и в каталоге агентов этапа 0.
import { zodToJsonSchema } from '../../node_modules/@mastra/schema-compat/dist/zod-to-json.js';
import shapes from '../fixtures/legacy-tool-shapes.json';
import { restoreLegacyTools } from '../../src/legacy-tools';
import { CTX, buildDocumentsDeps, buildPricesDeps, putFile } from '../agents/support';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

/** Агенты и инструменты, чьи формы сверяются с эталоном прежней сборки. */
const AGENT_IDS = ['prices', 'documents', 'order-calc', 'site-export'] as const;
const SHAPE_TOOLS = [
  'createFile',
  'runDataScript',
  'searchConversationHistory',
  'searchInternet',
] as const;

/** Окружение: песочница скриптов включена, правило предупреждений как в боевом compat.env. */
const FULL_ENV = { AGENT_SANDBOX_ENABLED: 'true', FEEDBACK_LIMIT_WARNINGS: 'true' };

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

/** Каноническая форма JSON, как у `dump-agents.ts`: ключи по алфавиту, примитивы отсортированы. */
function canonical(value: unknown): Json {
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== undefined).map(canonical);
    const primitive = items.every((item) => item === null || typeof item !== 'object');
    const byText = (a: Json, b: Json): number => JSON.stringify(a).localeCompare(JSON.stringify(b));
    return primitive ? [...items].sort(byText) : items;
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && typeof item !== 'function') out[key] = canonical(item);
    }
    return out;
  }
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/** JSON Schema из Zod без служебного `$schema`. */
function schemaOf(schema: unknown): Json {
  const { $schema: _omit, ...rest } = zodToJsonSchema(schema) as Record<string, unknown>;
  return canonical(rest);
}

const MARKUP_BOOLEANS = [
  'sideEffect',
  'resumable',
  'budgetExempt',
  'readsFile',
  'scriptAware',
  'scriptFallbackOnError',
  'endsTurn',
  'endsTurnAfterShown',
] as const;
const MARKUP_METHODS = [
  'endsTurnWhen',
  'idempotencyKey',
  'idempotencyPredecessor',
  'resolveInput',
] as const;
const DEFAULT_REPLAY = 'safe';

/** Разметка инструмента в том же виде, что в каталоге агентов этапа 0. */
function markupOf(tool: AnyToolDefinition): Json {
  const source = tool as unknown as Record<string, unknown>;
  const replay = typeof source['replay'] === 'string' ? source['replay'] : null;
  const markup: { [key: string]: Json } = {
    replay,
    replayEffective: replay ?? DEFAULT_REPLAY,
  };
  for (const key of MARKUP_BOOLEANS) markup[key] = source[key] === true;
  for (const key of MARKUP_METHODS) markup[`has_${key}`] = typeof source[key] === 'function';
  return canonical(markup);
}

/** Статистика прогона песочницы: значения не важны. */
const STATS = {
  durationMs: 5,
  queueMs: 0,
  codeBytes: 10,
  inBytes: 20,
  fileBytes: 0,
  outBytes: 8,
  exitCode: 0,
  uidSwitched: true,
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('инструменты агентов как в прежней сборке', () => {
  const { app } = buildPragmatika(FULL_ENV);

  for (const agentId of AGENT_IDS) {
    for (const name of SHAPE_TOOLS) {
      test(`${agentId}.${name}: разметка, описание и схемы равны эталону`, () => {
        const tool = app.registry.get(agentId).tools.find((item) => item.name === name);
        expect(tool).toBeDefined();
        if (tool === undefined) return;
        const expected = shapes.agents[agentId].tools[name];
        expect(markupOf(tool)).toEqual(expected.markup as Json);
        expect(tool.description.length).toBe(expected.descriptionLength);
        expect(sha256(tool.description)).toBe(expected.descriptionSha256);
        expect(schemaOf(tool.inputSchema)).toEqual(expected.inputSchema as Json);
        expect(schemaOf(tool.outputSchema)).toEqual(expected.outputSchema as Json);
      });
    }
  }
});

/** Заголовки общих блоков промпта: по ним блок находится в собранном промпте агента. */
const BLOCK_HEADINGS = {
  FILE_TOOL_PROMPT: '\n\nФайлы для сотрудника:',
  EMPLOYEE_LANGUAGE_PROMPT: '\n\nКак писать сотруднику:',
  REPLY_FORMAT_PROMPT: '\n\nОформление ответа:',
  DATA_SCRIPT_PROMPT: '\n\nСкрипт над таблицей (runDataScript)',
} as const;

describe('общие блоки промпта как в прежней сборке', () => {
  const { app } = buildPragmatika(FULL_ENV);

  for (const agentId of AGENT_IDS) {
    for (const [block, heading] of Object.entries(BLOCK_HEADINGS)) {
      test(`${agentId}: ${block}`, () => {
        const prompt = app.registry.get(agentId).prompt;
        const expected = shapes.promptBlocks[block as keyof typeof BLOCK_HEADINGS];
        const start = prompt.indexOf(heading);
        expect(start).toBeGreaterThanOrEqual(0);
        const text = prompt.slice(start, start + expected.length);
        expect(sha256(text)).toBe(expected.sha256);
      });
    }
  }
});

describe('restoreLegacyTools: подмена не молчит', () => {
  const declaration = (prompt: string, tools: AnyToolDefinition[]): AgentDeclaration => ({
    id: 'stub',
    prompt,
    tools,
    validators: [],
    model: 'stub-alias',
  });

  test('промпт без блока файлов роняет сборку', () => {
    const stub = declaration('промпт без нужных блоков', [createFileWarningsTool]);
    expect(() => restoreLegacyTools([stub])).toThrow(/FILE_TOOL_PROMPT/);
  });

  test('декларация с оценкой уже внутри обрабатывается так же, как без неё', () => {
    const { app } = buildPragmatika(FULL_ENV);
    const registered = app.registry.get('documents');
    const again = restoreLegacyTools([registered])[0];
    expect(again?.prompt).toBe(registered.prompt);
    expect(withFeedbackTool(registered).prompt).toBe(registered.prompt);
  });
});

describe('createFile как в прежней сборке', () => {
  const THREAD = 'documents/42';
  const context = (operationId: string, threadId = THREAD) =>
    createToolContext({
      threadId,
      agentId: 'documents',
      operationId,
      initiator: { kind: 'user', userId: '42' },
    });

  const { app } = buildPragmatika(FULL_ENV);
  const createFile = app.registry.get('documents').tools.find((tool) => tool.name === 'createFile');
  const input = { kind: 'txt', fileName: 'a', text: 'привет' };

  function setup(): { chat: MemoryChatChannel; deps: CreateFileHost } {
    const chat = new MemoryChatChannel();
    return { chat, deps: { chat, tableExporter: new MemoryTableExporter() } };
  }
  const sent = (chat: MemoryChatChannel): number =>
    chat.outbox.filter((record) => record.file !== undefined).length;

  test('ход после файла не заканчивается сам, предшественника ключа нет', () => {
    expect(createFile).toBeDefined();
    expect(createFile?.endsTurn).not.toBe(true);
    expect(createFile?.endsTurnWhen).toBeUndefined();
    expect(createFile?.idempotencyPredecessor).toBeUndefined();
    expect(createFile?.sideEffect).toBe(true);
    expect(createFile?.replay).toBe('confirm');
  });

  test('повтор того же файла в том же треде не шлёт его дважды', async () => {
    const { chat, deps } = setup();
    await createFile?.execute(input, deps, context('call-1'));
    // Повтор приходит под другим идентификатором вызова: ключ отправки считается по входу и треду.
    await createFile?.execute(input, deps, context('call-2'));
    expect(sent(chat)).toBe(1);
  });

  test('тот же файл в другом треде уходит отдельно', async () => {
    const { chat, deps } = setup();
    await createFile?.execute(input, deps, context('call-1'));
    await createFile?.execute(input, deps, context('call-1', 'documents/43'));
    expect(sent(chat)).toBe(2);
  });

  test('ключ идемпотентности вызова не зависит от треда и номера реплики', async () => {
    const key = createFile?.idempotencyKey?.(input);
    expect(key).toBe(createFile?.idempotencyKey?.(structuredClone(input)));
    expect(await createFile?.idempotencyPredecessor?.(input, {}, THREAD, 2)).toBeUndefined();
  });
});

describe('runDataScript: ввод по схеме прежней сборки', () => {
  const { app } = buildPragmatika(FULL_ENV);
  const tool = app.registry.get('documents').tools.find((item) => item.name === 'runDataScript');
  const csv = 'Наименование,Цена\nБолт,10\nГайка,5';
  const items = [{ name: 'Болт', price: 10 }, { name: 'Гайка', price: 5 }];

  /** Песочница, запоминающая запросы и отвечающая заданным результатом. */
  class FakeSandbox implements ScriptSandbox {
    readonly requests: ScriptRunRequest[] = [];
    async run(request: ScriptRunRequest): Promise<ScriptRunOutcome> {
      this.requests.push(request);
      return { ok: true, result: items, stats: STATS };
    }
  }

  test('вид rows платформы модели не принимается', async () => {
    const run = tool?.execute({ code: 'x', resultKind: 'rows' }, {}, CTX);
    await expect(run).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('price_items с supplierId и onEmployeeRequest доходит до платформы сводкой', async () => {
    const deps = await buildDocumentsDeps();
    const intake = new MemoryIntakeStore();
    await intake.put(CTX.threadId, 'a.csv', new TextEncoder().encode(csv));
    const sandbox = new FakeSandbox();
    deps.intake = intake;
    deps.scriptSandbox = sandbox;
    deps.parser = (await buildPricesDeps()).parser;
    const input = {
      code: 'def run(tables, source): return 1',
      resultKind: 'price_items',
      supplierId: 's1',
      onEmployeeRequest: true,
    };
    const out = await tool?.execute(input, deps, CTX);
    expect(out).toMatchObject({ ok: true, resultKind: 'price_items', summary: { count: 2 } });
    // Песочница получает общий вид rows: форму позиции проверяет обработчик агента.
    expect(sandbox.requests[0]?.resultKind).toBe('rows');
  });
});

describe('runDataScript: подсказки в неудачном ответе прежней сборки', () => {
  const { app } = buildPragmatika(FULL_ENV);
  const tool = app.registry.get('prices').tools.find((item) => item.name === 'runDataScript');
  const path = 'Прайсы/металл.csv';
  const userError: ScriptRunOutcome = {
    ok: false,
    error: { code: 'user_exception', type: 'ValueError', line: 1, policy: null },
    stats: STATS,
  };

  /** Зависимости агента прайсов с файлом и песочницей, отвечающей заданным исходом. */
  async function setup(outcome: ScriptRunOutcome) {
    const deps = await buildPricesDeps();
    putFile(deps, path, 'Наименование,Цена\nБолт,10');
    deps.scriptSandbox = { run: async () => outcome };
    return deps;
  }
  const input = { code: 'def run(tables, source): return 1', fileRef: path };

  test('сверка не пройдена: подсказка называет список issues', async () => {
    const deps = await setup({ ok: true, result: [{ name: 'Болт', price: 10 }], stats: STATS });
    deps.priceItemsHandler = async () => ({ accepted: false, issues: [] });
    const out = await tool?.execute({ ...input, resultKind: 'price_items' }, deps, CTX);
    expect(out).toMatchObject({ ok: false, error: { code: 'reconcile_failed' } });
    expect((out as { message: string }).message).toContain('по списку issues');
  });

  test('попытки исчерпаны: подсказка просит прежний итог', async () => {
    const deps = await setup(userError);
    const counters = { steps: 1, stepLimit: 10 };
    let out: unknown;
    for (let attempt = 0; attempt < SCRIPT_FIX_STEPS; attempt += 1) {
      counters.steps = 1 + attempt;
      const context = createToolContext({
        threadId: CTX.threadId,
        agentId: CTX.agentId,
        operationId: 'op',
        scriptTurn: scriptTurnOf(counters),
      });
      out = await tool?.execute({ ...input, resultKind: 'value' }, deps, context);
    }
    expect(out).toMatchObject({ ok: false, scriptDidNotHelp: true });
    expect((out as { message: string }).message).toContain('верни прежний итог');
  });
});

describe('runDataScript: отказ для скана прежней сборки', () => {
  test('файл без текстового слоя: отказ называет сотрудника, а не пользователя', async () => {
    const { app } = buildPragmatika(FULL_ENV);
    const tool = app.registry.get('documents').tools.find((item) => item.name === 'runDataScript');
    const deps = await buildDocumentsDeps();
    const intake = new MemoryIntakeStore();
    await intake.put(CTX.threadId, 'scan.pdf', new TextEncoder().encode('%PDF'));
    deps.intake = intake;
    deps.scriptSandbox = { run: async () => ({ ok: true, result: [], stats: STATS }) };
    deps.parser = {
      parse: async () => ({
        text: '',
        tables: [],
        needsOcr: true,
        hasHiddenContent: false,
        hiddenSheets: [],
        truncated: false,
        warnings: [],
      }),
    };
    const run = tool?.execute({ code: 'x', resultKind: 'value' }, deps, CTX);
    await expect(run).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Файл без текстового слоя (скан): разобрать скриптом нельзя, сообщи сотруднику.',
    });
  });
});

describe('поиск по истории: пометка в ответе прежней сборки', () => {
  test('notice называет КП и сделки', async () => {
    const { app } = buildPragmatika(FULL_ENV);
    const tool = app.registry
      .get('prices')
      .tools.find((item) => item.name === 'searchConversationHistory');
    const deps = { conversationHistory: { search: async () => [] } };
    const out = await tool?.execute({ query: 'КП' }, deps, CTX);
    expect(out).toMatchObject({ notice: expect.stringContaining('по базе, КП или сделке') });
  });
});

describe('обязательная попытка скрипта: замечание с прежним текстом', () => {
  test('валидатор прайсов отдаёт прежнюю подсказку', async () => {
    const { app } = buildPragmatika(FULL_ENV);
    const validator = app.registry
      .get('prices')
      .validators.find((item) => item.name === 'script-attempt-required');
    expect(validator).toBeDefined();
    const scriptTurn = { demandAttempt: () => true } as unknown as NonNullable<
      ToolContext['scriptTurn']
    >;
    const issues = await validator?.validate(
      { kind: 'needs_review' },
      { scriptSandbox: {} },
      { ...CTX, scriptTurn },
    );
    expect(issues?.[0]?.message).toContain('resultKind=price_items, supplierId');
  });
});
