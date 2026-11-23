import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildDeclaration, callTool, say, scriptedRuntime, type Step } from '@business-ai/testing';
import {
  EMPTY_REPLY_EVENT,
  EMPTY_REPLY_TEXT,
  configureEmptyReplyGuard,
} from '../../src/assembly/empty-reply-guard';

/** Запись журнала: имя события и поля. */
interface LogEntry {
  event: string;
  fields: Record<string, unknown>;
}

const THREAD = 'thread-secret-42';
const MAX_TOKENS_STEP: Step = { content: '', stopReason: 'max_tokens' };

let entries: LogEntry[] = [];
const log = (event: string, fields: Record<string, unknown> = {}): void => {
  entries.push({ event, fields });
};

/** Рантайм, у которого модель после инструмента дважды отвечает пусто (как на бою). */
function emptyTurn() {
  return scriptedRuntime(buildDeclaration(), { sent: [] }, [
    callTool('1', 'lookup', { query: 'a' }),
    say(''),
    say(''),
  ]);
}

const guarded = (): LogEntry[] => entries.filter((e) => e.event === EMPTY_REPLY_EVENT);

beforeEach(() => {
  entries = [];
  configureEmptyReplyGuard({ enabled: true, log });
});
afterAll(() => configureEmptyReplyGuard({ enabled: false }));

describe('защита от пустого ответа сотруднику', () => {
  test('выключатель: без защиты платформа отдаёт пустой итог (как на бою)', async () => {
    configureEmptyReplyGuard({ enabled: false, log });
    const { runtime, spec } = emptyTurn();
    const result = await runtime.run(spec, THREAD, 'сделай');
    expect(result.status).toBe('completed');
    expect(result.output.trim()).toBe('');
    expect(guarded()).toHaveLength(0);
  });

  test('run: пустой итог после повтора заменяется сообщением и пишется в журнал', async () => {
    const { runtime, spec } = emptyTurn();
    const result = await runtime.run(spec, THREAD, 'сделай');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(EMPTY_REPLY_TEXT);
    expect(guarded()).toHaveLength(1);
    expect(guarded()[0]?.fields).toMatchObject({ agent: spec.id, operation: 'run' });
    // ПДн и идентификатор треда в журнал не попадают
    expect(JSON.stringify(entries)).not.toContain(THREAD);
  });

  test('stream: событие done несёт то же сообщение', async () => {
    const { runtime, spec } = emptyTurn();
    let output: string | undefined;
    for await (const event of runtime.stream(spec, THREAD, 'сделай')) {
      if (event.type === 'done') output = event.result.output;
    }
    expect(output).toBe(EMPTY_REPLY_TEXT);
    expect(guarded()[0]?.fields).toMatchObject({ operation: 'stream' });
  });

  test('max_tokens без текста после инструмента: тоже сообщение, а не пусто', async () => {
    const { runtime, spec } = scriptedRuntime(buildDeclaration(), { sent: [] }, [
      callTool('1', 'lookup', { query: 'a' }),
      MAX_TOKENS_STEP,
      MAX_TOKENS_STEP,
    ]);
    const result = await runtime.run(spec, THREAD, 'сделай');
    expect(result.output).toBe(EMPTY_REPLY_TEXT);
  });

  test('обычный ответ не трогается и в журнал не пишется', async () => {
    const { runtime, spec } = scriptedRuntime(buildDeclaration(), { sent: [] }, [
      callTool('1', 'lookup', { query: 'a' }),
      say('итог'),
    ]);
    const result = await runtime.run(spec, THREAD, 'сделай');
    expect(result.output).toBe('итог');
    expect(guarded()).toHaveLength(0);
  });

  test('удачный повтор после пустого: итог повтора, защита не срабатывает', async () => {
    const { runtime, spec } = scriptedRuntime(buildDeclaration(), { sent: [] }, [
      callTool('1', 'lookup', { query: 'a' }),
      say(''),
      say('итог после повтора'),
    ]);
    const result = await runtime.run(spec, THREAD, 'сделай');
    expect(result.output).toBe('итог после повтора');
    expect(guarded()).toHaveLength(0);
  });

  test('дочерний ход (режим вызова или глубина больше нуля) не трогается', async () => {
    const child = emptyTurn();
    const byMode = await child.runtime.run(child.spec, THREAD, 'сделай', {
      context: { mode: 'call' },
    });
    expect(byMode.output.trim()).toBe('');
    const nested = emptyTurn();
    const byDepth = await nested.runtime.run(nested.spec, THREAD, 'сделай', {
      context: { depth: 1 },
    });
    expect(byDepth.output.trim()).toBe('');
    expect(guarded()).toHaveLength(0);
  });

  test('плановый запуск не трогается: его итог не уходит сотруднику', async () => {
    const { runtime, spec } = emptyTurn();
    const result = await runtime.run(spec, THREAD, 'сделай', {
      context: { initiator: { kind: 'scheduler' } },
    });
    expect(result.output.trim()).toBe('');
    expect(guarded()).toHaveLength(0);
  });

  test('ход сотрудника с инициатором user защищается', async () => {
    const { runtime, spec } = emptyTurn();
    const result = await runtime.run(spec, THREAD, 'сделай', {
      context: { initiator: { kind: 'user', userId: '7' } },
    });
    expect(result.output).toBe(EMPTY_REPLY_TEXT);
  });

  test('текст сообщения: по-русски, без служебных деталей', () => {
    expect(EMPTY_REPLY_TEXT).toContain('Исходный файл не менялся');
    expect(EMPTY_REPLY_TEXT).toContain('руководител');
    expect(EMPTY_REPLY_TEXT).not.toMatch(/agent|token|retry|runtime|no_result/i);
    expect(EMPTY_REPLY_TEXT.length).toBeLessThan(400);
  });

  test('повторная настройка не удваивает обёртку', async () => {
    configureEmptyReplyGuard({ enabled: true, log });
    configureEmptyReplyGuard({ enabled: true, log });
    const { runtime, spec } = emptyTurn();
    await runtime.run(spec, THREAD, 'сделай');
    expect(guarded()).toHaveLength(1);
  });
});
