import { describe, expect, test } from 'bun:test';
import type { ChatChannel, ChatMessage } from '@business-ai/core';
import {
  FORBIDDEN_REPLY_STEMS,
  findForbiddenReplyWords,
  guardReplyLanguage,
  REPLY_LANGUAGE_PROMPT_RULE,
  rewriteForbiddenReplyWords,
} from '../../src/reply-language';

const THREAD = 'thread-1';
const KEY = 'key-1';
const DRAFT = 'draft-1';
const LINK = 'https://example.test/x';

describe('findForbiddenReplyWords', () => {
  test('ловит токен, метку и условное обозначение в разных формах и регистрах', () => {
    const text =
      'Токен, метка, Метки, МЕТКОЙ, токеном, условное обозначение, Условные обозначения';
    expect(findForbiddenReplyWords(text)).toEqual([
      'Токен',
      'метка',
      'Метки',
      'МЕТКОЙ',
      'токеном',
      'условное обозначение',
      'Условные обозначения',
    ]);
  });

  test('«пометка», «отметка», «маркер» и «ответ» разрешены', () => {
    const text = 'Пометка в письме, отметка о получении, маркер [ЗАПОЛНИТЬ: дата], метрика';
    expect(findForbiddenReplyWords(text)).toEqual([]);
  });

  test('слово должно начинаться на основу: части других слов не ловятся', () => {
    expect(findForbiddenReplyWords('подметка, лжетокен, ретокенизация, токенизация')).toEqual([]);
  });

  test('основы перечислены', () => {
    expect(FORBIDDEN_REPLY_STEMS).toEqual(['токен', 'метк', 'условное обозначение']);
  });
});

describe('rewriteForbiddenReplyWords', () => {
  const CASES: Array<[string, string]> = [
    ['токен', 'значение'],
    ['токена', 'значения'],
    ['токену', 'значению'],
    ['токеном', 'значением'],
    ['в токене', 'в значении'],
    ['токены', 'значения'],
    ['токенов', 'значений'],
    ['токенам', 'значениям'],
    ['токенами', 'значениями'],
    ['о токенах', 'о значениях'],
    ['метка', 'значение'],
    ['метки', 'значения'],
    ['меткой', 'значением'],
    ['метку', 'значение'],
    ['меток', 'значений'],
    ['меткам', 'значениям'],
    ['метками', 'значениями'],
    ['на метках', 'на значениях'],
    ['к метке', 'к значению'],
    ['в метке', 'в значении'],
    ['условное обозначение', 'значение'],
    ['условного обозначения', 'значения'],
    ['условным обозначением', 'значением'],
    ['условные обозначения', 'значения'],
    ['условных обозначений', 'значений'],
    ['об условном обозначении', 'об значении'],
  ];

  for (const [source, expected] of CASES) {
    test(`«${source}» -> «${expected}»`, () => {
      expect(rewriteForbiddenReplyWords(source)).toBe(expected);
    });
  }

  test('регистр сохраняется', () => {
    expect(rewriteForbiddenReplyWords('Метка не найдена')).toBe('Значение не найдена');
    expect(rewriteForbiddenReplyWords('ТОКЕН')).toBe('ЗНАЧЕНИЕ');
    expect(rewriteForbiddenReplyWords('Условное обозначение')).toBe('Значение');
  });

  test('целое предложение остаётся читаемым', () => {
    const source = 'Нужно название юрлица, а не токен. Пришлите значение вместо метки.';
    expect(rewriteForbiddenReplyWords(source)).toBe(
      'Нужно название юрлица, а не значение. Пришлите значение вместо значения.',
    );
  });

  test('идемпотентна', () => {
    const once = rewriteForbiddenReplyWords('Токеном и метками, условное обозначение');
    expect(rewriteForbiddenReplyWords(once)).toBe(once);
    expect(findForbiddenReplyWords(once)).toEqual([]);
  });

  test('текст без запрещённых слов возвращается без изменений', () => {
    const text = 'Пометка и отметка, маркер [ЗАПОЛНИТЬ: дата]';
    expect(rewriteForbiddenReplyWords(text)).toBe(text);
    expect(rewriteForbiddenReplyWords('')).toBe('');
  });
});

describe('REPLY_LANGUAGE_PROMPT_RULE', () => {
  test('короткий абзац с запретом слов и примером служебного знака', () => {
    expect(REPLY_LANGUAGE_PROMPT_RULE).toContain('токеном');
    expect(REPLY_LANGUAGE_PROMPT_RULE).toContain('[ORG_1]');
    expect(REPLY_LANGUAGE_PROMPT_RULE).toContain('нужно название организации');
    expect(REPLY_LANGUAGE_PROMPT_RULE.split('\n')).toHaveLength(1);
  });
});

/** Канал, который запоминает, что ему передали. */
class RecordingChat implements ChatChannel {
  replies: ChatMessage[] = [];
  updates: Array<{ draftId: string; message: ChatMessage; options?: { final?: boolean } }> = [];
  calls: string[] = [];
  updateMessage = async (
    _threadId: string,
    draftId: string,
    message: ChatMessage,
    options?: { final?: boolean },
  ): Promise<void> => {
    this.updates.push(options === undefined ? { draftId, message } : { draftId, message, options });
  };

  onEvent(): void {
    this.calls.push('onEvent');
  }

  async reply(_threadId: string, message: ChatMessage): Promise<void> {
    this.calls.push('reply');
    this.replies.push(message);
  }

  async sendFile(): Promise<void> {
    this.calls.push('sendFile');
  }

  async typing(): Promise<void> {
    this.calls.push('typing');
  }
}

describe('guardReplyLanguage', () => {
  test('reply переписывает text, blocksLead и тексты блоков, кнопки не трогает', async () => {
    const inner = new RecordingChat();
    const counts: number[] = [];
    const chat = guardReplyLanguage(inner, (n) => counts.push(n));
    const message: ChatMessage = {
      text: 'Не нашёл метку',
      blocksLead: 'Токен ниже',
      blocks: [
        { kind: 'message', text: 'Условное обозначение клиента' },
        {
          kind: 'grid',
          rows: [{ name: 'Метка', value: 'токен', link: LINK, tone: 'alert' }],
        },
        { kind: 'link', name: 'Все метки', url: 'https://example.test/токен' },
        { kind: 'delimiter' },
      ],
      buttons: [{ id: 'b1', label: 'Метка' }],
      suggestedActions: ['new_dialog'],
    };
    await chat.reply(THREAD, message, KEY);
    const sent = inner.replies[0];
    expect(sent).toEqual({
      text: 'Не нашёл значение',
      blocksLead: 'Значение ниже',
      blocks: [
        { kind: 'message', text: 'Значение клиента' },
        {
          kind: 'grid',
          rows: [{ name: 'Значение', value: 'значение', link: LINK, tone: 'alert' }],
        },
        { kind: 'link', name: 'Все значения', url: 'https://example.test/токен' },
        { kind: 'delimiter' },
      ],
      buttons: [{ id: 'b1', label: 'Метка' }],
      suggestedActions: ['new_dialog'],
    });
    expect(message.text).toBe('Не нашёл метку');
    expect(counts).toEqual([6]);
  });

  test('updateMessage переписывает текст и передаёт draftId и options как есть', async () => {
    const inner = new RecordingChat();
    const chat = guardReplyLanguage(inner);
    await chat.updateMessage?.(THREAD, DRAFT, { text: 'Готовлю токен' }, { final: true });
    await chat.updateMessage?.(THREAD, DRAFT, { text: 'Готовлю' });
    expect(inner.updates).toEqual([
      { draftId: DRAFT, message: { text: 'Готовлю значение' }, options: { final: true } },
      { draftId: DRAFT, message: { text: 'Готовлю' } },
    ]);
  });

  test('текст без запрещённых слов уходит тем же объектом, без вызова журнала', async () => {
    const inner = new RecordingChat();
    let called = false;
    const chat = guardReplyLanguage(inner, () => {
      called = true;
    });
    const message: ChatMessage = { text: 'Пометка и маркер', blocks: [{ kind: 'delimiter' }] };
    await chat.reply(THREAD, message, KEY);
    expect(inner.replies[0]).toBe(message);
    expect(called).toBe(false);
  });

  test('сбой обратного вызова не мешает ответу', async () => {
    const inner = new RecordingChat();
    const chat = guardReplyLanguage(inner, () => {
      throw new Error('журнал недоступен');
    });
    await chat.reply(THREAD, { text: 'токен' }, KEY);
    expect(inner.replies[0]?.text).toBe('значение');
  });

  test('остальные методы делегируются с сохранением this', async () => {
    const inner = new RecordingChat();
    const chat = guardReplyLanguage(inner);
    chat.onEvent(async () => undefined);
    await chat.typing?.(THREAD);
    const file = { name: 'a', mimeType: 'text/plain', content: new Uint8Array() };
    await chat.sendFile(THREAD, file, KEY);
    expect(inner.calls).toEqual(['onEvent', 'typing', 'sendFile']);
  });

  test('необязательные методы, которых нет у исходного канала, в обёртке не появляются', () => {
    const minimal: ChatChannel = {
      onEvent: () => undefined,
      reply: async () => undefined,
      sendFile: async () => undefined,
    };
    const chat = guardReplyLanguage(minimal);
    expect('typing' in chat).toBe(false);
    expect('updateMessage' in chat).toBe(false);
    expect(chat.typing).toBeUndefined();
    expect(chat.updateMessage).toBeUndefined();
  });
});

describe('guardReplyLanguage: режим наблюдения (этап 8y)', () => {
  test('observeOnly: текст не меняется, число слов уходит в журнал', async () => {
    const sent: ChatMessage[] = [];
    const chat = {
      onEvent: () => undefined,
      reply: async (_t: string, message: ChatMessage) => void sent.push(message),
      sendFile: async () => undefined,
    } as unknown as ChatChannel;
    const counts: number[] = [];
    const guarded = guardReplyLanguage(chat, (n) => void counts.push(n), { observeOnly: true });
    const message: ChatMessage = { text: 'Нужна метка и токен' };
    await guarded.reply('t', message, 'k');
    expect(sent[0]).toBe(message);
    expect(counts).toEqual([2]);
  });
});
