import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { TEMPLATE_DEFAULT_HEADER_ROW } from '../../kit/ports/template-workbook.owned';
import { defineTool } from '@business-ai/core';
import { listChatFiles, readChatFileBytes } from '../order-calc/chat-file-bytes';
import { recordWorkOwner } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import type { SiteExportDeps } from './deps';
import {
  newWorkbookId,
  requireWorkbook,
  saveWorkbook,
  TEMPLATE_WORKBOOK_MAX_BYTES,
} from './template-store';
import { summarizeStructure, workbookSummarySchema } from './template-summary';

const XLSX_EXTENSION = '.xlsx';

const inputSchema = z.object({
  /** Имя файла из чата; можно не задавать, если в чате один файл xlsx. */
  name: z.string().min(1).optional(),
  /** Номер файла в списке чата (с 1), если по имени не выбрать. */
  index: z.number().int().min(1).optional(),
  /** Строка с заголовками колонок; по умолчанию 11, как в шаблоне сайта. */
  headerRow: z.number().int().min(1).optional(),
});

const outputSchema = z.object({
  status: z.enum(['ok', 'not_configured', 'not_found', 'ambiguous', 'failed', 'not_xlsx']),
  /** Для не-ok: что сказать сотруднику. */
  message: z.string().optional(),
  /** Файлы чата (not_found) или подходящие файлы (ambiguous). */
  files: z.array(z.string()).optional(),
  workbookId: z.string().optional(),
  fileName: z.string().optional(),
  summary: workbookSummarySchema.optional(),
  /** Предупреждения к результату (например, из нескольких xlsx взят последний). */
  warnings: z.array(z.string()).optional(),
});

/**
 * Открыть xlsx, присланный сотрудником в чат, как рабочую книгу: БЕЗ очистки. Агент дополняет
 * файл с первой свободной строки и не затирает чужие значения.
 */
export const openChatTemplate = defineTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'openChatTemplate',
  description:
    'Открыть xlsx, который сотрудник прислал в чат (шаблон сайта или частично заполненный ' +
    'файл), как рабочую книгу. Файл НЕ очищается: пиши с первой свободной строки, чужие ' +
    'значения не затирай. Вернёт workbookId для readTemplateStructure, fillTemplateRows и ' +
    'sendTemplateFile. name или index выбирают файл, если их в чате несколько; не заданы - ' +
    'берётся последний присланный xlsx и в warnings идёт предупреждение (не спрашивай до ' +
    'выдачи, вынеси его в итог). Другие форматы (pdf, docx, фото) читай ' +
    'readChatAttachments: это материал по позициям, а не шаблон.',
  inputSchema,
  outputSchema,
  async execute(input, deps, context) {
    const workbook = requireWorkbook(deps);
    const selector = { name: input.name, index: input.index, extension: XLSX_EXTENSION };
    let file = await readChatFileBytes(deps, context, selector);
    const warnings: string[] = [];
    if (file.status === 'ambiguous') {
      // Вопрос «какой файл» задерживал бы результат: берём последний присланный и предупреждаем.
      const wanted = input.name?.trim().toLowerCase();
      const suitable = listChatFiles(deps, context.threadId).filter((item) =>
        wanted !== undefined && wanted !== ''
          ? item.name.toLowerCase() === wanted
          : item.name.toLowerCase().endsWith(XLSX_EXTENSION),
      );
      const latest = suitable[suitable.length - 1];
      if (latest !== undefined) {
        file = await readChatFileBytes(deps, context, { index: latest.index });
        warnings.push(
          `В чате было несколько xlsx (${suitable.length}), взят последний: ${latest.name}.`,
        );
      }
    }
    switch (file.status) {
      case 'not_configured':
        return {
          status: 'not_configured',
          message: 'Чтение файлов чата не подключено: попроси сотрудника вставить данные текстом.',
        };
      case 'not_found':
        return {
          status: 'not_found',
          message: 'В чате нет подходящего файла xlsx. Попроси сотрудника прислать файл.',
          files: file.available,
        };
      case 'ambiguous':
        return {
          status: 'ambiguous',
          message: 'В чате несколько файлов xlsx: спроси, какой взять.',
          files: file.candidates,
        };
      case 'failed':
        return { status: 'failed', fileName: file.name, message: file.message };
      case 'ok':
        break;
    }
    if (file.bytes.length > TEMPLATE_WORKBOOK_MAX_BYTES) {
      return {
        status: 'failed',
        fileName: file.name,
        message: 'Файл слишком велик для обработки (около 6 МБ). Попроси файл поменьше.',
      };
    }
    const headerRow = input.headerRow ?? TEMPLATE_DEFAULT_HEADER_ROW;
    let structure;
    try {
      structure = await workbook.inspect({ bytes: file.bytes, headerRow, signal: context.signal });
    } catch (error) {
      // Повреждённый или не xlsx файл - обычная ситуация, а не сбой сервиса.
      if (error instanceof DomainError && error.code === 'invalid_input') {
        return {
          status: 'not_xlsx',
          fileName: file.name,
          message: 'Файл не читается как xlsx (повреждён или другой формат).',
        };
      }
      throw error;
    }
    const workbookId = newWorkbookId(context.threadId, context.operationId);
    await saveWorkbook(deps, workbookId, {
      bytes: file.bytes,
      fileName: file.name,
      source: 'chat_file',
      headerRow,
      revision: 0,
      written: [],
    });
    await recordWorkOwner(deps.state, workSubject.export(workbookId), context);
    return {
      status: 'ok',
      workbookId,
      fileName: file.name,
      summary: summarizeStructure(structure),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  },
});
