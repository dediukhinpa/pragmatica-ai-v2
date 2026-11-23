import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  defineTool,
  type AgentDeclaration,
  type AgentEvent,
  type AgentRunOptions,
  type ChatChannel,
  type ChatFile,
  type ChatMessage,
} from '@business-ai/core';
import { callTool, say, scriptedRuntime, type Step } from '@business-ai/testing';
import {
  STEP_TEXT_DROPPED_EVENT,
  STEP_TEXT_SEPARATOR,
  configureTurnRuntimeWrap,
  createSegmentTracker,
  trackEvent,
  withLastSegmentOnly,
} from '../../src/assembly/turn-runtime-wrap';
import {
  TURN_FAILED_NOTE_TEXT,
  configureTurnFileBuffer,
  resetTurnFileBufferForTests,
  turnFileChat,
} from '../../src/turn-file-buffer';

const THREAD = 'thread-wrap-1';
const PRICES_ID = 'prices-agent';
const OTHER_ID = 'other-agent';
const FILE_NAME = 'price.xlsx';

/** Хронология: отправки файлов и события потока в порядке прихода. */
let timeline: string[] = [];
let replies: string[] = [];
let log: Array<{ event: string; fields: Record<string, unknown> }> = [];

/** Подменный канал: пишет хронологию. */
class FakeChat implements ChatChannel {
  onEvent(): void {}
  async reply(_threadId: string, message: ChatMessage): Promise<void> {
    replies.push(message.text);
  }
  async sendFile(_threadId: string, file: ChatFile): Promise<void> {
    timeline.push(`file:${new TextDecoder().decode(file.content)}`);
  }
}

interface ToolDeps {
  chat: ChatChannel;
}

/** Инструмент «правка прайса»: как реальные пути, зовёт `chat.sendFile` через обёртку канала. */
const sendEdit = defineTool({
  name: 'sendEdit',
  description: 'Отправить файл правки',
  inputSchema: z.object({ name: z.string(), text: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  async execute(input, deps: ToolDeps) {
    const file: ChatFile = {
      name: input.name,
      mimeType: 'application/vnd.ms-excel',
      content: new TextEncoder().encode(input.text),
    };
    await deps.chat.sendFile(THREAD, file, `key-${input.text}`);
    return { ok: true };
  },
});

/** Рантайм со сценарием; агент и канал настраиваются. */
function build(steps: Step[] | ((n: number) => Step), agentId = PRICES_ID) {
  const chat = turnFileChat(new FakeChat());
  const declaration: AgentDeclaration = {
    id: agentId,
    prompt: 'Ты тест.',
    model: agentId,
    tools: [sendEdit],
    validators: [],
  };
  const fn = typeof steps === 'function' ? steps : undefined;
  return scriptedRuntime(
    declaration,
    { chat },
    fn === undefined ? (steps as Step[]) : (_request, call) => fn(call),
  );
}

const twoEdits = (): Step[] => [
  callTool('1', 'sendEdit', { name: FILE_NAME, text: 'неполный' }),
  callTool('2', 'sendEdit', { name: FILE_NAME, text: 'полный' }),
  say('итог'),
];

/** Прочитать поток до конца, пишет хронологию; `done` помечается в ней. */
async function drain(
  events: AsyncIterable<AgentEvent>,
  collected: AgentEvent[] = [],
): Promise<AgentEvent[]> {
  for await (const event of events) {
    collected.push(event);
    if (event.type === 'done') timeline.push('done');
  }
  return collected;
}

const files = (): string[] => timeline.filter((e) => e.startsWith('file:'));
const SCHEDULER: AgentRunOptions = { context: { initiator: { kind: 'scheduler' } } };

function configure(enabled: boolean, stepTextEnabled = false): void {
  configureTurnRuntimeWrap({
    enabled,
    stepTextEnabled,
    pricesAgentId: PRICES_ID,
    log: (event, fields = {}) => log.push({ event, fields }),
  });
  configureTurnFileBuffer({
    enabled,
    log: (event, fields = {}) => log.push({ event, fields }),
    retryDelayMs: 1,
  });
}

beforeEach(() => {
  timeline = [];
  replies = [];
  log = [];
  configure(true);
});
afterAll(() => {
  configureTurnRuntimeWrap({ enabled: false, stepTextEnabled: false, pricesAgentId: '' });
  resetTurnFileBufferForTests();
});

describe('файлы хода: отправка один раз', () => {
  test('красный-до: выключено, два файла уходят сразу (как на бою)', async () => {
    configure(false);
    const { runtime, spec } = build(twoEdits());
    await runtime.run(spec, THREAD, 'правь');
    expect(files()).toEqual(['file:неполный', 'file:полный']);
  });

  test('run: один файл с содержимым второй правки', async () => {
    const { runtime, spec } = build(twoEdits());
    const result = await runtime.run(spec, THREAD, 'правь');
    expect(result.output).toBe('итог');
    expect(files()).toEqual(['file:полный']);
  });

  test('stream: один файл, и он ДО события done', async () => {
    const { runtime, spec } = build(twoEdits());
    await drain(runtime.stream(spec, THREAD, 'правь'));
    expect(timeline).toEqual(['file:полный', 'done']);
  });

  test('stream: файлы с разными именами уходят оба', async () => {
    const { runtime, spec } = build([
      callTool('1', 'sendEdit', { name: 'a.xlsx', text: 'а' }),
      callTool('2', 'sendEdit', { name: 'b.xlsx', text: 'б' }),
      say('итог'),
    ]);
    await drain(runtime.stream(spec, THREAD, 'правь'));
    expect(timeline).toEqual(['file:а', 'file:б', 'done']);
  });

  test('ход бросил исключение: файл ушёл, пометка отправлена, исключение проброшено', async () => {
    const make = () =>
      build((call) => {
        if (call === 0) return callTool('1', 'sendEdit', { name: FILE_NAME, text: 'собранное' });
        throw new Error('сбой модели');
      });
    const viaRun = make();
    await expect(viaRun.runtime.run(viaRun.spec, THREAD, 'правь')).rejects.toThrow();
    expect(files()).toEqual(['file:собранное']);
    expect(replies).toEqual([TURN_FAILED_NOTE_TEXT]);
    timeline = [];
    replies = [];
    const viaStream = make();
    const streamed = viaStream.runtime.stream(viaStream.spec, THREAD, 'правь');
    await expect(drain(streamed)).rejects.toThrow();
    expect(files()).toEqual(['file:собранное']);
    expect(replies).toEqual([TURN_FAILED_NOTE_TEXT]);
  });

  test('поток закрыт досрочно: файл ушёл', async () => {
    const { runtime, spec } = build(twoEdits());
    for await (const event of runtime.stream(spec, THREAD, 'правь')) {
      if (event.type === 'tool_end') break;
    }
    expect(files().length).toBe(1);
    expect(replies).toEqual([TURN_FAILED_NOTE_TEXT]);
  });

  test('плановый запуск: файлы уходят сразу, без ожидания конца хода', async () => {
    const { runtime, spec } = build(twoEdits());
    await runtime.run(spec, THREAD, 'правь', SCHEDULER);
    expect(files()).toEqual(['file:неполный', 'file:полный']);
  });

  test('вложенный ход (глубина > 0, режим вызова): файлы уходят сразу', async () => {
    const nested = build(twoEdits());
    await nested.runtime.run(nested.spec, THREAD, 'правь', { context: { depth: 1 } });
    expect(files()).toHaveLength(2);
    timeline = [];
    const called = build(twoEdits());
    await called.runtime.run(called.spec, THREAD, 'правь', { context: { mode: 'call' } });
    expect(files()).toHaveLength(2);
  });

  test('повторная настройка не удваивает обёртку', async () => {
    configure(true);
    configure(true);
    const { runtime, spec } = build(twoEdits());
    await drain(runtime.stream(spec, THREAD, 'правь'));
    expect(timeline).toEqual(['file:полный', 'done']);
  });
});

/** Сценарий с промежуточным текстом: «A» перед инструментом, «B» после. */
const stepTextScript = (finalText: string): Step[] => [
  {
    content: 'A',
    toolCalls: [{ id: '1', name: 'sendEdit', arguments: { name: FILE_NAME, text: 'x' } }],
    stopReason: 'tool_use',
  },
  say(finalText),
];

/** Тексты потока одной строкой для сравнения. */
function deltasOf(events: AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'text_delta' ? [event.text] : []));
}

/** Итог события `done`. */
function outputOf(events: AgentEvent[]): string {
  for (const event of events) if (event.type === 'done') return event.result.output;
  return '';
}

/** Прогнать события через отслеживание сегментов; вернуть отданные события и итог. */
function replay(events: AgentEvent[]): { emitted: AgentEvent[]; output: string } {
  const tracker = createSegmentTracker();
  const emitted: AgentEvent[] = [];
  let output = '';
  for (const event of events) {
    if (event.type === 'done') {
      output = withLastSegmentOnly(event.result, tracker).output;
      continue;
    }
    const separator = trackEvent(tracker, event);
    if (separator !== undefined) emitted.push(separator);
    emitted.push(event);
  }
  return { emitted, output };
}

const doneEvent = (output: string, extra: object = {}): AgentEvent => ({
  type: 'done',
  result: { threadId: THREAD, status: 'completed', output, ...extra },
});
const toolStart: AgentEvent = { type: 'tool_start', toolCallId: '1', name: 'x', summary: '' };
const toolEnd: AgentEvent = { type: 'tool_end', toolCallId: '1', name: 'x', ok: true, summary: '' };

describe('промежуточный текст шагов агента прайсов (потоком рантайма)', () => {
  test('красный-до: выключено, разделителя между шагами нет (шаги склеены)', async () => {
    configure(true, false);
    const { runtime, spec } = build(stepTextScript('B'));
    const deltas = deltasOf(await drain(runtime.stream(spec, THREAD, 'правь')));
    expect(deltas.join('')).toBe('AB');
    expect(deltas).not.toContain(STEP_TEXT_SEPARATOR);
  });

  test('включено: между шагами отдан разделитель, итог - текст после инструмента', async () => {
    configure(true, true);
    const { runtime, spec } = build(stepTextScript('B'));
    const events = await drain(runtime.stream(spec, THREAD, 'правь'));
    expect(deltasOf(events).join('')).toBe(`A${STEP_TEXT_SEPARATOR}B`);
    expect(outputOf(events)).toBe('B');
    expect(log.find((e) => e.event === STEP_TEXT_DROPPED_EVENT)?.fields).toEqual({ segments: 1 });
  });

  test('агент не прайсов: поток не меняется', async () => {
    configure(true, true);
    const { runtime, spec } = build(stepTextScript('B'), OTHER_ID);
    const deltas = deltasOf(await drain(runtime.stream(spec, THREAD, 'правь')));
    expect(deltas.join('')).toBe('AB');
  });

  test('плановый запуск агента прайсов: поток не меняется', async () => {
    configure(true, true);
    const { runtime, spec } = build(stepTextScript('B'));
    const deltas = deltasOf(await drain(runtime.stream(spec, THREAD, 'правь', SCHEDULER)));
    expect(deltas.join('')).toBe('AB');
  });

  test('разделитель работает и при выключенном буфере файлов', async () => {
    configure(false, true);
    const { runtime, spec } = build(stepTextScript('B'));
    const deltas = deltasOf(await drain(runtime.stream(spec, THREAD, 'правь')));
    expect(deltas.join('')).toBe(`A${STEP_TEXT_SEPARATOR}B`);
  });
});

describe('склейка шагов: чистая логика сегментов', () => {
  test('A, инструмент, B, done(AB): между A и B разделитель, итог B', () => {
    const { emitted, output } = replay([
      { type: 'text_delta', text: 'A' },
      toolStart,
      toolEnd,
      { type: 'text_delta', text: 'B' },
      doneEvent('AB'),
    ]);
    expect(deltasOf(emitted)).toEqual(['A', STEP_TEXT_SEPARATOR, 'B']);
    expect(output).toBe('B');
  });

  test('последний сегмент пуст (после инструмента текста нет): итог не меняется', () => {
    const tracker = createSegmentTracker();
    for (const event of [{ type: 'text_delta', text: 'A' }, toolStart, toolEnd] as AgentEvent[]) {
      trackEvent(tracker, event);
    }
    const result = { threadId: THREAD, status: 'completed' as const, output: 'A' };
    expect(withLastSegmentOnly(result, tracker)).toBe(result);
    const blank = replay([
      { type: 'text_delta', text: 'A' },
      toolEnd,
      { type: 'text_delta', text: '  ' },
      doneEvent('A  '),
    ]);
    expect(blank.output).toBe('A  ');
  });

  test('одиночный сегмент, ход закончен инструментом, не completed: итог не меняется', () => {
    expect(replay([{ type: 'text_delta', text: 'A' }, doneEvent('A')]).output).toBe('A');
    const ended = replay([
      { type: 'text_delta', text: 'A' },
      toolEnd,
      { type: 'text_delta', text: 'B' },
      doneEvent('AB', { turnEndedByTool: true }),
    ]);
    expect(ended.output).toBe('AB');
    const suspended = replay([
      { type: 'text_delta', text: 'A' },
      toolEnd,
      { type: 'text_delta', text: 'B' },
      { type: 'done', result: { threadId: THREAD, status: 'suspended', output: 'AB' } },
    ]);
    expect(suspended.output).toBe('AB');
  });

  test('прочие поля результата сохраняются, текст до первого сегмента без разделителя', () => {
    const tracker = createSegmentTracker();
    expect(trackEvent(tracker, toolStart)).toBeUndefined();
    expect(trackEvent(tracker, { type: 'text_delta', text: 'A' })).toBeUndefined();
    trackEvent(tracker, toolEnd);
    trackEvent(tracker, { type: 'text_delta', text: ' B ' });
    const result = withLastSegmentOnly(
      {
        threadId: THREAD,
        status: 'completed',
        output: 'A B ',
        contextHigh: true,
        operationId: 'op',
      },
      tracker,
    );
    expect(result).toEqual({
      threadId: THREAD,
      status: 'completed',
      output: 'B',
      contextHigh: true,
      operationId: 'op',
    });
  });
});
