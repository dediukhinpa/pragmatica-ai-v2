import {
  FixedClock,
  MemoryAuditRepository,
  MemoryIdempotencyStore,
  MemoryIntakeStore,
  MemoryMailboxDirectory,
  MemoryTableExporter,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryPriceFileEditor } from '../../src/kit/adapters/memory/price-file-editor';
import { PRICES_AGENT_ID, type PricesDeps } from '../../src/agents/prices/deps';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { stagingImportId } from '../../src/agents/prices/staging-source';
import type { PriceItem } from '../../src/kit/domain/models';
import type { InboxMessage } from '@business-ai/core';
import { CTX, SUPPLIER_ID, buildPricesDeps, existingPrice, putFile } from './support';

/** Тред ответственного за прайсы в тестах (отличается от треда менеджера). */
export const RESPONSIBLE_THREAD = 'responsible-thread';
/** Тред сотрудника, приславшего файл или сообщение. */
export const EMPLOYEE_THREAD = 'employee-thread';
/** Адрес поставщика s1 в базе. */
export const SUPPLIER_EMAIL = 'sales@metalltorg.example';

export const COLUMNS = { name: 0, price: 1, sku: 2 };

export type FullPricesDeps = Awaited<ReturnType<typeof buildFullPricesDeps>>;

/**
 * Зависимости агента «Актуализация прайса (ИИ агент)» со всеми новыми источниками и получателями.
 */
export async function buildFullPricesDeps() {
  const base = await buildPricesDeps();
  await base.suppliers.upsert({ id: SUPPLIER_ID, name: 'МеталлТорг', email: SUPPLIER_EMAIL });
  const clock = new FixedClock();
  // Ящик сотрудника USER_1: плановый разбор почты и вызовы без сотрудника читают его.
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(USER_1, MAILBOX_ADDRESS_1);
  return {
    ...base,
    clock,
    state: new MemoryWorkflowStateStore(),
    intake: new MemoryIntakeStore(clock),
    tableExporter: new MemoryTableExporter(),
    priceFileEditor: new MemoryPriceFileEditor(),
    mailboxes,
    mailboxOwnerUserId: USER_1,
    responsibleThreadId: RESPONSIBLE_THREAD,
  } satisfies PricesDeps;
}

/** Прайс с артикулом: «Наименование,Цена,Артикул». */
export function skuCsv(rows: Array<[string, number, string]>): string {
  return ['Наименование,Цена,Артикул', ...rows.map(([n, p, s]) => `${n},${p},${s}`)].join('\n');
}

export function skuItem(name: string, price: number, sku: string): PriceItem {
  return { ...existingPrice(name, price), sku };
}

export function mailMessage(overrides: Partial<InboxMessage> & { id: string }): InboxMessage {
  return {
    from: SUPPLIER_EMAIL,
    subject: 'Прайс',
    body: 'Во вложении актуальный прайс',
    receivedAt: '2026-01-01T00:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Положить csv на диск и целиком добавить в staging; возвращает hash и importId. */
export async function stageDiskCsv(
  deps: FullPricesDeps,
  rows: Array<[string, number, string]>,
  path = 'price.csv',
): Promise<{ fileHash: string; importId: string }> {
  putFile(deps, path, skuCsv(rows));
  const out = await stagePriceRows.execute(
    { path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
    deps,
    CTX,
  );
  return { fileHash: out.fileHash, importId: stagingImportId(SUPPLIER_ID, out.fileHash) };
}

/** Сотрудники и их треды для проверок почты сотрудников. */
export const USER_1 = 'u1';
export const USER_2 = 'u2';
export const USER_NO_MAILBOX = 'u3';
export const USER_THREAD_1 = 'thread-u1';
export const USER_THREAD_2 = 'thread-u2';
export const USER_THREAD_3 = 'thread-u3';
export const MAILBOX_ADDRESS_1 = 'ivanov@company.test';
export const MAILBOX_ADDRESS_2 = 'petrov@company.test';
/** Второй поставщик с адресом (для проверки «два сотрудника - два разных письма»). */
export const SECOND_SUPPLIER_ID = 's2';
export const SECOND_SUPPLIER_EMAIL = 'info@boltik.example';

/** Контекст хода сотрудника в его треде. */
export function employeeContext(userId: string, threadId: string): ToolContext {
  return createToolContext({
    threadId,
    agentId: PRICES_AGENT_ID,
    operationId: `op-${userId}`,
    initiator: { kind: 'user', userId },
  });
}

/** Контекст планового запуска (не сотрудник). */
export const SCHEDULER_CTX: ToolContext = createToolContext({
  threadId: 'prices-weekly-update',
  agentId: PRICES_AGENT_ID,
  operationId: 'op-scheduler',
  initiator: { kind: 'scheduler' },
});

export type MailboxPricesDeps = Awaited<ReturnType<typeof buildMailboxPricesDeps>>;

/**
 * Зависимости агента «Актуализация прайса (ИИ агент)» с ящиками двух сотрудников (USER_1 уже
 * подключён базовой сборкой).
 */
export async function buildMailboxPricesDeps() {
  const base = await buildFullPricesDeps();
  await base.suppliers.upsert({
    id: SECOND_SUPPLIER_ID,
    name: 'Болтик',
    email: SECOND_SUPPLIER_EMAIL,
  });
  base.mailboxes.connect(USER_2, MAILBOX_ADDRESS_2);
  return base satisfies PricesDeps;
}
