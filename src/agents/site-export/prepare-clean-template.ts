import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { TEMPLATE_DEFAULT_HEADER_ROW } from '../../kit/ports/template-workbook.owned';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { recordWorkOwner } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import type { SiteExportDeps } from './deps';
import { readSiteTemplate, TEMPLATE_NOT_FOUND } from './template-source';
import {
  newWorkbookId,
  requireWorkbook,
  saveWorkbook,
  TEMPLATE_WORKBOOK_MAX_BYTES,
} from './template-store';
import { summarizeStructure, workbookSummarySchema } from './template-summary';

const outputSchema = z.object({
  status: z.enum(['ok', 'template_not_found']),
  /** Для `template_not_found`: что сказать сотруднику. */
  message: z.string().optional(),
  workbookId: z.string().optional(),
  fileName: z.string().optional(),
  /** Сколько ячеек с примерами очищено ниже шапки. */
  clearedCells: z.number().int().optional(),
  /** Ячейки, которые очистка не тронула (формулы, объединения): список ссылок. */
  clearSkipped: z.array(z.string()).optional(),
  summary: workbookSummarySchema.optional(),
});

/**
 * Рабочая копия чистого шаблона сайта с диска. Шаблон на диске содержит примеры под шапкой;
 * копия очищается от значений ниже шапки (стили, списки и другие листы не трогаются), и агент
 * пишет с первой строки под шапкой. Диск только читается, исходный файл не меняется.
 */
export const prepareCleanTemplate = defineTool<
  Record<string, never>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'prepareCleanTemplate',
  description:
    'Взять чистый шаблон сайта с диска и сделать рабочую копию: значения ниже шапки (строка ' +
    '11) очищены от примеров, шапка, строки 1-10, стили, выпадающие списки и листы целы. ' +
    'Вызывай, когда сотрудник не прислал свой файл шаблона. Вернёт workbookId: с ним работают ' +
    'readTemplateStructure, fillTemplateRows и sendTemplateFile (байты файла в контекст не ' +
    'попадают). status template_not_found: шаблона на диске нет, попроси сотрудника прислать ' +
    'файл шаблона в чат, затем openChatTemplate. Если сотрудник прислал свой файл, дополняй ' +
    'его через openChatTemplate, а не этот инструмент.',
  inputSchema: z.object({}),
  outputSchema,
  async execute(_input, deps, context) {
    assertEmployeeChatTurn(context);
    const workbook = requireWorkbook(deps);
    const template = await readSiteTemplate(deps);
    if (template.status === TEMPLATE_NOT_FOUND) {
      return { status: 'template_not_found', message: template.message };
    }
    if (template.bytes.length > TEMPLATE_WORKBOOK_MAX_BYTES) {
      throw new DomainError(
        'invalid_input',
        'Шаблон на диске слишком велик для обработки. Сообщи об этом ответственному.',
      );
    }
    const headerRow = TEMPLATE_DEFAULT_HEADER_ROW;
    const cleared = await workbook.clearBelowHeader({
      bytes: template.bytes,
      headerRow,
      signal: context.signal,
    });
    const structure = await workbook.inspect({ bytes: cleared.bytes, headerRow });
    const workbookId = newWorkbookId(context.threadId, context.operationId);
    const baseName = template.path.split('/').pop() ?? 'template.xlsx';
    await saveWorkbook(deps, workbookId, {
      bytes: cleared.bytes,
      fileName: baseName,
      source: 'disk_template',
      headerRow,
      revision: 0,
      written: [],
    });
    await recordWorkOwner(deps.state, workSubject.export(workbookId), context);
    return {
      status: 'ok',
      workbookId,
      fileName: baseName,
      clearedCells: cleared.cleared,
      clearSkipped: cleared.skipped.map((item) => `${item.ref}: ${item.reason}`),
      summary: summarizeStructure(structure),
    };
  },
});
