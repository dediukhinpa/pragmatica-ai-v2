import { DomainError } from '@business-ai/core';
import {
  createRunDataScriptTool,
  openIntakeDataSource,
  parseReplyRef,
  type DataScriptSource,
} from '@business-ai/core';
import { requirePort } from '@business-ai/core';
import { LEGACY_RUN_DATA_SCRIPT_PRESENTATION } from '../shared/common-tools.owned';
import { priceItemsSummaryKind } from '../shared/price-items-kind.owned';
import type { OrderCalcDeps } from './deps';
import { loadReplyAttachment } from './reply-reading';
import type { ToolContext } from '@business-ai/core';

/**
 * Источник данных скрипта у агента заказов: вложение ответа поставщика
 * (`reply:<requestId>/<attachmentId>`, доступ проверяет та же функция, что у
 * `readReplyAttachment`) либо вложение текущего диалога.
 */
async function openOrderCalcDataSource(
  deps: OrderCalcDeps,
  ref: string | undefined,
  context: ToolContext,
): Promise<DataScriptSource> {
  const reply = ref === undefined ? null : parseReplyRef(ref);
  if (reply === null) return openIntakeDataSource(deps, ref, context);
  const parser = requirePort(deps.parser, 'разбор документов');
  const attachment = await loadReplyAttachment(deps, reply.requestId, reply.attachmentId, context);
  const name = attachment.file.fileName;
  if (name === '') throw new DomainError('not_found', 'У вложения нет имени файла.');
  return {
    name,
    read: async () => attachment.bytes,
    parse: () => parser.parse(name, attachment.bytes),
  };
}

/** `runDataScript` агента заказов. */
export const runDataScript = createRunDataScriptTool<OrderCalcDeps>(openOrderCalcDataSource, {
  resultKinds: [priceItemsSummaryKind<OrderCalcDeps>()],
  presentation: LEGACY_RUN_DATA_SCRIPT_PRESENTATION,
});
