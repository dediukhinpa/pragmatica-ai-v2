import { afterEach, describe, expect, test } from 'bun:test';
import type { ConversationHistoryQuery, HistoryMessage } from '@business-ai/core';
import { MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  noteEmployeeMessage,
  readEmployeeText,
  readRecentEmployeeMessages,
} from '../../src/agents/documents/employee-messages';
import { clearPragmatikaRuntime, setPragmatikaRuntime } from '../../src/runtime';
import type { PragmatikaRuntime } from '../../src/runtime';
import { FILE_NOTICE_QUERY, captionOf } from '../../src/turn-captions';

/**
 * Подпись к файлу попадает в текст сообщений сотрудника (этап 9q): сверка номера договора и
 * юрлица «по словам сотрудника» видит текст, пришедший вместе с файлом.
 */

const THREAD = 'bot/u-1';
const NOW = new Date('2026-11-23T08:00:00Z');
const FILE_LINE = 'Сотрудник прислал файл «договор.docx», путь intake/договор.docx';

function message(text: string, role: 'user' | 'agent' = 'user', minutesAgo = 1): HistoryMessage {
  return { role, text, at: new Date(NOW.getTime() - minutesAgo * 60_000) };
}

/** Рантайм с подменой истории; запросы поиска запоминаются. */
function installRuntime(
  messages: HistoryMessage[],
  queries: ConversationHistoryQuery[] = [],
): void {
  const runtime = {
    clock: { now: () => NOW },
    conversationHistory: {
      async search(query: ConversationHistoryQuery) {
        queries.push(query);
        return messages.map((found) => ({ message: found, before: [], after: [], score: 1 }));
      },
    },
  } as unknown as PragmatikaRuntime;
  setPragmatikaRuntime(runtime);
}

afterEach(() => clearPragmatikaRuntime());

describe('captionOf', () => {
  test('текст до служебной строки о файле', () => {
    expect(captionOf(`Добавь 17/10 к номеру договора\n\n${FILE_LINE}`)).toBe(
      'Добавь 17/10 к номеру договора',
    );
  });

  test('файл портала: служебная строка в начале строки', () => {
    expect(captionOf('Номер 5/1\n\nСотрудник прислал в чат файл «а.docx». Содержимое…')).toBe(
      'Номер 5/1',
    );
  });

  test('файл без подписи и обычное сообщение дают пустую строку', () => {
    expect(captionOf(FILE_LINE)).toBe('');
    expect(captionOf('Добавь 17/10 к номеру договора')).toBe('');
  });
});

describe('подпись к файлу в тексте сообщений сотрудника', () => {
  test('сообщение + файл: номер 17/10 виден в тексте треда', async () => {
    const state = new MemoryWorkflowStateStore();
    installRuntime([message(`Добавь 17/10 к номеру договора\n\n${FILE_LINE}`)]);
    const text = await readEmployeeText(state, THREAD);
    expect(text).toContain('17/10');
    expect(text).not.toContain('прислал файл');
  });

  test('читается и через последние сообщения', async () => {
    const state = new MemoryWorkflowStateStore();
    installRuntime([message(`Добавь 17/10\n\n${FILE_LINE}`)]);
    expect(await readRecentEmployeeMessages(state, THREAD, 3)).toEqual(['добавь 17/10']);
  });

  test('повторное чтение не дублирует подпись', async () => {
    const state = new MemoryWorkflowStateStore();
    installRuntime([message(`Добавь 17/10\n\n${FILE_LINE}`)]);
    await readEmployeeText(state, THREAD);
    const again = await readEmployeeText(state, THREAD);
    expect(again.split('\n')).toEqual(['добавь 17/10']);
  });

  test('сообщение, уже записанное хуком, не дублируется', async () => {
    const state = new MemoryWorkflowStateStore();
    await noteEmployeeMessage(state, THREAD, 'Добавь 17/10');
    installRuntime([message(`Добавь 17/10\n\n${FILE_LINE}`)]);
    expect((await readEmployeeText(state, THREAD)).split('\n')).toEqual(['добавь 17/10']);
  });

  test('ответы агента, файл без подписи и чужие реплики в запись не идут', async () => {
    const state = new MemoryWorkflowStateStore();
    installRuntime([
      message(`Номер 99/9 готов\n\n${FILE_LINE}`, 'agent'),
      message(FILE_LINE),
      message('Просто сообщение без файла 77/7'),
    ]);
    expect(await readEmployeeText(state, THREAD)).toBe('');
  });

  test('запрос к истории: тот же тред и служебные слова, окно по времени', async () => {
    const state = new MemoryWorkflowStateStore();
    const queries: ConversationHistoryQuery[] = [];
    installRuntime([], queries);
    await readEmployeeText(state, THREAD);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.threadId).toBe(THREAD);
    expect(queries[0]?.query).toBe(FILE_NOTICE_QUERY);
    expect(queries[0]?.since?.getTime()).toBeLessThan(NOW.getTime());
  });

  test('без истории (не собрано) чтение работает как раньше', async () => {
    const state = new MemoryWorkflowStateStore();
    await noteEmployeeMessage(state, THREAD, 'Обычное сообщение');
    expect(await readEmployeeText(state, THREAD)).toBe('обычное сообщение');
  });

  test('сбой поиска по истории чтение не ломает', async () => {
    const state = new MemoryWorkflowStateStore();
    setPragmatikaRuntime({
      clock: { now: () => NOW },
      conversationHistory: {
        async search() {
          throw new Error('нет базы');
        },
      },
    } as unknown as PragmatikaRuntime);
    await noteEmployeeMessage(state, THREAD, 'Раньше');
    expect(await readEmployeeText(state, THREAD)).toBe('раньше');
  });
});
