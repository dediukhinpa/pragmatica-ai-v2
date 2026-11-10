import { describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import { MemorySiteTextEditor } from '../../../src/kit/adapters/memory/site-text-editor';
import {
  ModelSiteTextEditor,
  SITE_TEXT_EDIT_INVALID_ANSWER,
} from '../../../src/kit/adapters/litellm/site-text-model-editor';
import type { ModelRequest } from '@business-ai/core';
import type { SiteTextEditRequest } from '../../../src/kit/ports/site-text-editor';

const MODEL = 'site-export-alias';
const SIGNAL = new AbortController().signal;
const THREAD = 'orders/2002';
const OPTIONS = { signal: SIGNAL, threadId: THREAD };
const REQUESTS: SiteTextEditRequest[] = [
  { id: '0:1', text: 'Кружа 300 мл', maxChars: 1500, compress: false },
  { id: '1:1', text: 'Длинный текст', maxChars: 1500, compress: true, problem: 'длина 1600' },
];

function adapter(answer: string) {
  const gateway = new MemoryModelGateway(() => answer);
  return { editor: new ModelSiteTextEditor(gateway, MODEL), gateway };
}

describe('ModelSiteTextEditor', () => {
  test('ответ JSON разбирается, запрос идёт с алиасом и тредом агента', async () => {
    const { editor, gateway } = adapter(
      '```json\n{"items":[{"id":"0:1","text":"Кружка 300 мл"},{"id":"1:1","text":"Текст"}]}\n```',
    );
    const result = await editor.edit(REQUESTS, OPTIONS);
    expect(result).toEqual([
      { id: '0:1', text: 'Кружка 300 мл' },
      { id: '1:1', text: 'Текст' },
    ]);
    const request = gateway.requests[0] as ModelRequest;
    expect(request.model).toBe(MODEL);
    expect(request.threadId).toBe(THREAD);
    expect(request.tools).toBeUndefined();
    const sent = JSON.parse(request.messages[1]?.content ?? '[]') as SiteTextEditRequest[];
    expect(sent.map((item) => item.id)).toEqual(['0:1', '1:1']);
    expect(sent[1]?.problem).toBe('длина 1600');
    expect(request.messages[0]?.content).toContain('НЕЛЬЗЯ менять');
  });

  test('пустой пакет модель не вызывает', async () => {
    const { editor, gateway } = adapter('{"items":[]}');
    expect(await editor.edit([], OPTIONS)).toEqual([]);
    expect(gateway.requests.length).toBe(0);
  });

  test('неразборчивый ответ - исключение без текста ответа', async () => {
    const { editor } = adapter('секретный ответ без json');
    const error = await editor.edit(REQUESTS, OPTIONS).catch((e: unknown) => e);
    expect((error as Error).message).toBe(SITE_TEXT_EDIT_INVALID_ANSWER);
  });

  test('ответ не по схеме - исключение', async () => {
    const { editor } = adapter('{"items":[{"id":1,"text":"x"}]}');
    await expect(editor.edit(REQUESTS, OPTIONS)).rejects.toThrow(
      SITE_TEXT_EDIT_INVALID_ANSWER,
    );
  });

  test('отмена хода прерывает вызов до обращения к модели', async () => {
    const { editor, gateway } = adapter('{"items":[]}');
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal, threadId: THREAD };
    await expect(editor.edit(REQUESTS, options)).rejects.toThrow();
    expect(gateway.requests.length).toBe(0);
  });
});

describe('ModelSiteTextEditor: тред', () => {
  test('у разных тредов агента разные треды запросов', async () => {
    const { editor, gateway } = adapter('{"items":[]}');
    await editor.edit(REQUESTS, { signal: SIGNAL, threadId: 'a' });
    await editor.edit(REQUESTS, { signal: SIGNAL, threadId: 'b' });
    expect(gateway.requests.map((request) => request.threadId)).toEqual(['a', 'b']);
  });

  test('пустой тред - исключение до обращения к модели', async () => {
    const { editor, gateway } = adapter('{"items":[]}');
    await expect(editor.edit(REQUESTS, { signal: SIGNAL, threadId: ' ' })).rejects.toThrow();
    expect(gateway.requests.length).toBe(0);
  });
});

describe('MemorySiteTextEditor', () => {
  test('по умолчанию возвращает тексты как есть и запоминает пакеты', async () => {
    const editor = new MemorySiteTextEditor();
    const result = await editor.edit(REQUESTS, OPTIONS);
    expect(result.map((item) => item.text)).toEqual(['Кружа 300 мл', 'Длинный текст']);
    expect(editor.batches.length).toBe(1);
  });
});
