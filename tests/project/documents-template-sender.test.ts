import { beforeEach, describe, expect, test } from 'bun:test';
import { createToolContext } from '@business-ai/core';
import { MemoryChatChannel, MemoryFileSource } from '@business-ai/adapters';
import { SEND_TEMPLATE_TOOL, sendTemplateFile } from '../../src/documents-template-sender';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { buildDocumentsDeps } from '../agents/support';

/** «Выложи шаблон» (этап 8y): пустой шаблон из разрешённого списка уходит файлом в чат. */

const THREAD = 'documents/u-template';
const TEMPLATE = 'Шаблоны/Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';
const CONTENT = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
const ctx = () =>
  createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: 'op-template',
    initiator: { kind: 'user', userId: 'u-template' },
  });

let deps: DocumentsDeps & { chat: MemoryChatChannel; files: MemoryFileSource };

beforeEach(async () => {
  const base = await buildDocumentsDeps();
  (base.files as unknown as { put(p: string, c: Uint8Array, m: number): void }).put(
    TEMPLATE,
    CONTENT,
    1,
  );
  deps = { ...base, templateAllowlist: [TEMPLATE] };
});

describe('sendTemplateFile', () => {
  test('шаблон из разрешённого списка уходит файлом без изменений', async () => {
    const result = await sendTemplateFile.execute({ templatePath: TEMPLATE }, deps, ctx());
    expect(result).toEqual({
      delivered: true,
      fileName: 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx',
      sizeBytes: CONTENT.length,
    });
    const [sent] = deps.chat.outboxOf(THREAD);
    expect(sent?.file?.mimeType).toContain('wordprocessingml.document');
    expect(Array.from(sent?.file?.content ?? [])).toEqual(Array.from(CONTENT));
  });

  test('повтор в том же треде не дублирует файл', async () => {
    await sendTemplateFile.execute({ templatePath: TEMPLATE }, deps, ctx());
    await sendTemplateFile.execute({ templatePath: TEMPLATE }, deps, ctx());
    expect(deps.chat.outboxOf(THREAD)).toHaveLength(1);
  });

  test('шаблон вне разрешённого списка и путь с .. отклоняются, файл не уходит', async () => {
    await expect(
      sendTemplateFile.execute({ templatePath: 'Шаблоны/Чужой.docx' }, deps, ctx()),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      sendTemplateFile.execute({ templatePath: '../Секрет.docx' }, deps, ctx()),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(deps.chat.outboxOf(THREAD)).toHaveLength(0);
  });

  test('имя инструмента и побочный эффект объявлены', () => {
    expect(sendTemplateFile.name).toBe(SEND_TEMPLATE_TOOL);
    expect(sendTemplateFile.sideEffect).toBe(true);
  });
});
