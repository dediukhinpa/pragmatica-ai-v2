import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentParser,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryContractNumbering } from '../../src/kit/adapters/memory/contract-numbering';
import { MemoryImportStaging } from '../../src/kit/adapters/memory/import-staging';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemoryPriceRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import {
  askToConfirmWebFields,
  webFieldsStatus,
  webRequestToken,
  recordWebConfirmation,
} from '../../src/agents/documents/web-confirmation';
import { createToolContext } from '@business-ai/core';
import type { DocumentsDeps } from '../../src/agents/documents/deps';
import type { PricesDeps } from '../../src/agents/prices/deps';
import type { ToolContext } from '@business-ai/core';
import { documentFieldPaths } from '../../src/kit/domain/document-sources';
import { type DealDocument, type PriceItem } from '../../src/kit/domain/models';
import type { Clock, ModelRequest, WorkflowStateStore } from '@business-ai/core';

export const SUPPLIER_ID = 's1';
export const MANAGER_THREAD = 'manager-thread';
/** Контекст исполнения инструмента для прямых вызовов в тестах. */
export const CTX: ToolContext = createToolContext({
  threadId: MANAGER_THREAD,
  agentId: 'test-agent',
  operationId: 'op-1',
});
export const MODEL_ALIAS = 'test-model';
const FILE_MTIME = 1_000;
/** Секрет идентификаторов файлов в тестах. */
export const FILE_REF_SECRET = 'test-file-ref-secret';
export const CREATED_AT = '2026-01-01T00:00:00.000Z';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Прайс в csv: заголовок + позиции. */
export function priceCsv(rows: Array<[string, number]>): string {
  return ['Наименование,Цена', ...rows.map(([name, price]) => `${name},${price}`)].join('\n');
}

export async function buildPricesDeps(): Promise<PricesDeps & { chat: MemoryChatChannel }> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert({ id: SUPPLIER_ID, name: 'МеталлТорг' });
  return {
    files: new MemoryFileSource(),
    fileRefSecret: FILE_REF_SECRET,
    parser: new MemoryDocumentParser(),
    prices: new MemoryPriceRepository(),
    staging: new MemoryImportStaging(),
    suppliers,
    chat: new MemoryChatChannel(),
    clock: new FixedClock(),
    managerThreadId: MANAGER_THREAD,
  };
}

export function putFile(deps: PricesDeps | DocumentsDeps, path: string, text: string): void {
  (deps.files as MemoryFileSource).put(path, encode(text), FILE_MTIME);
}

export function existingPrice(name: string, price: number): PriceItem {
  return { supplierId: SUPPLIER_ID, productName: name, price, currency: 'RUB', date: CREATED_AT };
}

export const OWN_COMPANY = 'ООО Прагматика';

export async function buildDocumentsDeps(): Promise<
  DocumentsDeps & {
    chat: MemoryChatChannel;
    files: MemoryFileSource;
    state: MemoryWorkflowStateStore;
    clock: FixedClock;
  }
> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert({ id: SUPPLIER_ID, name: 'МеталлТорг' });
  const files = new MemoryFileSource();
  return {
    files,
    knowledge: new MemoryKnowledgeSearch(new Map([['kb-1', 'Шаблон договора поставки']])),
    renderer: new MemoryDocumentRenderer(),
    suppliers,
    chat: new MemoryChatChannel(),
    ownCompanyNames: [OWN_COMPANY],
    state: new MemoryWorkflowStateStore(),
    clock: new FixedClock(),
    contractNumbering: new MemoryContractNumbering(),
  };
}

/** Все существенные поля документа помечены одним источником (по умолчанию - сотрудник). */
export function withSources(
  doc: DealDocument,
  source: 'employee' | 'knowledge' | 'web' = 'employee',
): DealDocument {
  const entries = documentFieldPaths(doc).map((path) => [path, source] as const);
  return { ...doc, fieldSources: Object.fromEntries(entries) };
}

/** Документ «всё из чата»: источники всех полей - сотрудник, если не заданы явно. */
export function buildDocument(overrides: Partial<DealDocument> = {}): DealDocument {
  const doc: DealDocument = {
    id: 'doc-1',
    kind: 'commercial_offer',
    number: 'КП-1',
    buyer: 'ООО Заказчик',
    seller: OWN_COMPANY,
    lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12 }],
    total: 120,
    currency: 'RUB',
    issuedAt: CREATED_AT,
    ...overrides,
  };
  return overrides.fieldSources === undefined ? withSources(doc) : doc;
}

/** Результат последнего инструмента в запросе к модели (JSON). */
export function lastToolResult(request: ModelRequest): Record<string, unknown> {
  const message = [...request.messages].reverse().find((m) => m.role === 'tool');
  const parsed: unknown = JSON.parse(message?.content ?? '{}');
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** Текст всех сообщений инструментов в запросе. */
export function toolMessages(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content);
}

/**
 * Сотрудник подтверждает веб-поля документа: агент спрашивает текстом (`asked`), затем решение
 * записывается тем же кодом, что вызывают обработчик старой кнопки и `recordWebFieldsDecision`.
 */
export async function pressWebConfirm(
  deps: DocumentsDeps & { chat: MemoryChatChannel; state: WorkflowStateStore; clock: Clock },
  document: DealDocument,
  options: { threadId?: string; userId?: string; decision?: 'confirmed' | 'rejected' } = {},
): Promise<string> {
  const threadId = options.threadId ?? CTX.threadId;
  const asked = await askToConfirmWebFields.execute({ document }, deps, { ...CTX, threadId });
  if (asked.status !== 'asked') {
    throw new Error('ожидался вопрос сотруднику о полях из интернета');
  }
  // Запрос записан под токеном (тред + отпечаток значений): по нему и пишется решение.
  const status = await webFieldsStatus(document, deps, threadId);
  if (status.status !== 'unconfirmed') throw new Error('подтверждение уже не требуется');
  const outcome = await recordWebConfirmation(deps.state, deps.clock, {
    token: webRequestToken(threadId, status.valuesHash),
    decision: options.decision ?? 'confirmed',
    userId: options.userId ?? 'employee-1',
    threadId,
  });
  return outcome.kind;
}
