import { z } from 'zod';
import { DomainError, defineTool, extensionOf } from '@business-ai/core';
import type { ChatFile } from '@business-ai/core';
import type { DocumentsDeps } from './agents/documents/deps';
import { readAllowedTemplate } from './agents/documents/template-access';

/** Имя инструмента: сотрудник просит «выложи шаблон» - пустой шаблон уходит файлом в чат. */
export const SEND_TEMPLATE_TOOL = 'sendTemplateFile';

/** Типы файлов шаблонов (расширение -> mime); других шаблонов агент не читает. */
const TEMPLATE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const DEFAULT_MIME = 'application/octet-stream';

const inputSchema = z.object({
  /** Путь шаблона из `findTemplate` (разрешённый список файлов шаблонов). */
  templatePath: z.string().min(1),
});
type SendTemplateInput = z.infer<typeof inputSchema>;

interface SendTemplateOutput {
  delivered: boolean;
  fileName: string;
  sizeBytes: number;
}

/** Имя файла для чата: последний сегмент пути. */
function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Отправить сотруднику ПУСТОЙ шаблон файлом («выложи шаблон», «пришли шаблон договора»). Шаблон
 * берётся только из разрешённого списка (та же проверка, что у сборки документа): путь модели
 * коду не доверен. Ничего не подставляется и не меняется, документ не создаётся.
 */
export const sendTemplateFile = defineTool<SendTemplateInput, SendTemplateOutput, DocumentsDeps>({
  name: SEND_TEMPLATE_TOOL,
  description:
    'Отправить сотруднику пустой шаблон файлом, когда он просит «выложи/пришли шаблон». Путь ' +
    'шаблона бери из findTemplate (match.template.path или templates[].path); шаблон не из ' +
    'разрешённого списка не отправляется. Это сам шаблон, не готовый документ: ничего не ' +
    'заполняй и не собирай. После отправки скажи одной строкой, какой шаблон ушёл.',
  sideEffect: true,
  // Повтор в том же треде не дублирует файл: ключ канала включает тред и путь шаблона.
  replay: 'safe',
  inputSchema,
  outputSchema: z.object({
    delivered: z.boolean(),
    fileName: z.string(),
    sizeBytes: z.number().int(),
  }),
  idempotencyKey: (input) => `send-template:${input.templatePath}`,
  async execute(input, deps, context) {
    const template = await readAllowedTemplate(deps, input.templatePath);
    if (template.content.length === 0) {
      throw new DomainError('not_found', 'Файл шаблона пуст: отправлять нечего.');
    }
    const file: ChatFile = {
      name: fileNameOf(template.path),
      mimeType: TEMPLATE_MIME_BY_EXTENSION[extensionOf(template.path)] ?? DEFAULT_MIME,
      content: template.content,
    };
    await deps.chat.sendFile(
      context.threadId,
      file,
      `send-template:${template.path}:${context.threadId}`,
    );
    return { delivered: true, fileName: file.name, sizeBytes: file.content.length };
  },
});
