import {
  FixedClock,
  MemoryChatChannel,
  MemoryMailboxDirectory,
  MemoryTableExporter,
  MemoryWebSearch,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemoryPriceRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import { PLACEHOLDER_EXPORT_TEMPLATE } from '../../src/agents/site-export/default-template';
import { SITE_EXPORT_AGENT_ID, type SiteExportDeps } from '../../src/agents/site-export/deps';
import { ToolSuspension, createToolContext, type ToolContext } from '@business-ai/core';
import { loadAllCards, setHashOf } from '../../src/agents/site-export/cards';
import { CREATED_AT, CTX, MANAGER_THREAD } from './support';

export const EXPORT_ID = 'exp-1';

/** Заглушки в памяти с видимыми журналами. */
export interface SiteTestDeps extends SiteExportDeps {
  chat: MemoryChatChannel;
  state: MemoryWorkflowStateStore;
  clock: FixedClock;
  prices: MemoryPriceRepository;
  web: MemoryWebSearch;
  tableExporter: MemoryTableExporter;
  /** Ящики сотрудников: у `MAIL_USER_1` и `MAIL_USER_2` ящики подключены. */
  mailboxes: MemoryMailboxDirectory;
}

/** Описание, проходящее проверку длины и фраз. */
export const GOOD_DESCRIPTION =
  'Болт М8 из оцинкованной стали, длина 40 мм, поставляется в упаковке по 100 штук.';

/** База из `count` товаров с артикулами ART-001... и ценой 10. */
export async function buildSiteDeps(
  count = 3,
  rejectedKeys: ReadonlySet<string> = new Set(),
): Promise<SiteTestDeps> {
  const prices = new MemoryPriceRepository();
  const items = Array.from({ length: count }, (_, index) => ({
    supplierId: 's1',
    productName: `Болт ${index + 1}`,
    sku: `ART-${String(index + 1).padStart(3, '0')}`,
    price: 10,
    currency: 'RUB',
    date: CREATED_AT,
  }));
  await prices.saveImport('s1', items, 'seed');
  // Справочник: письма читаются только от известных адресов поставщиков.
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert({ id: 's1', name: 'МеталлТорг', email: 'sales@s1.test' });
  return {
    prices,
    suppliers,
    clock: new FixedClock(),
    knowledge: new MemoryKnowledgeSearch(new Map([['kb-1', 'Болт: общее описание крепежа']])),
    state: new MemoryWorkflowStateStore(),
    template: PLACEHOLDER_EXPORT_TEMPLATE,
    chat: new MemoryChatChannel(),
    managerThreadId: MANAGER_THREAD,
    web: new MemoryWebSearch([]),
    tableExporter: new MemoryTableExporter(),
    mailboxes: buildMailboxes(),
  };
}

/** Сотрудники и их ящики для проверок чтения почты по сотруднику. */
export const MAIL_USER_1 = 'u1';
export const MAIL_USER_2 = 'u2';
export const MAIL_USER_NO_MAILBOX = 'u3';

/** Каталог ящиков двух сотрудников (третий без ящика). */
export function buildMailboxes(): MemoryMailboxDirectory {
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(MAIL_USER_1, 'ivanov@company.test');
  mailboxes.connect(MAIL_USER_2, 'petrov@company.test');
  return mailboxes;
}

/** Контекст хода сотрудника. */
export function employeeContext(userId: string): ToolContext {
  return createToolContext({
    threadId: `thread-${userId}`,
    agentId: SITE_EXPORT_AGENT_ID,
    operationId: `op-${userId}`,
    initiator: { kind: 'user', userId },
  });
}

/** Контекст планового запуска (сотрудника нет). */
export function schedulerContext(): ToolContext {
  return createToolContext({
    threadId: 'site-export-scheduled',
    agentId: SITE_EXPORT_AGENT_ID,
    operationId: 'op-scheduler',
    initiator: { kind: 'scheduler' },
  });
}
