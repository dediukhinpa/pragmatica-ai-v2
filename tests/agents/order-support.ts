import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentParser,
  MemoryIntakeStore,
  MemoryMailboxDirectory,
  MemoryScheduler,
  MemoryTableExporter,
  MemoryWebSearch,
  MemoryWorkflowStateStore,
  SequentialIdGenerator,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemoryPriceRepository,
  MemoryPurchaseRequestRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import { MemoryWebHitClassifier } from '../../src/kit/adapters/memory/web-candidate-model';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import {
  choiceToken,
  loadChoiceAsk,
  recordChoiceDone,
} from '../../src/agents/order-calc/choice-confirmation';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { listUnassignedMail, routeButtonIds } from '../../src/agents/order-calc/reply-routing';
import { loadSent, saveSent } from '../../src/agents/order-calc/state';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import type { InboxMessage, WorkflowStateStore } from '@business-ai/core';
import type { PurchaseRequest } from '../../src/kit/domain/models';
import { CREATED_AT, MANAGER_THREAD } from './support';
import { SwitchableAccess } from './suppliers-support';

/**
 * Плановый ход (без сотрудника): ответы читаются из ящика владельца заявки. Контекст без
 * инициатора в этом режиме закрыт, поэтому тесты чтения используют именно этот.
 */
export const READER_CTX: ToolContext = createToolContext({
  threadId: MANAGER_THREAD,
  agentId: 'test-agent',
  operationId: 'op-reader',
  initiator: { kind: 'scheduler' },
});

export const REQUEST_ID = 'req-1';
/** Сотрудник - владелец ящика по умолчанию: с него «уходят» письма, в него приходят ответы. */
export const MAIL_OWNER = 'u1';
export const MAIL_OWNER_ADDRESS = 'owner@company.test';

export const ORDER_REQUEST: PurchaseRequest = {
  id: REQUEST_ID,
  dealRef: 'D-1',
  items: [{ name: 'Арматура', quantity: 100, unit: 'м' }],
  createdAt: CREATED_AT,
};

/** Заглушки в памяти с типами, у которых видны журналы (для проверок). */
export interface OrderTestDeps extends OrderCalcDeps {
  chat: MemoryChatChannel;
  scheduler: MemoryScheduler;
  clock: FixedClock;
  web: MemoryWebSearch;
  state: MemoryWorkflowStateStore;
  quotes: MemorySupplierQuoteRepository;
  tableExporter: MemoryTableExporter;
  parser: MemoryDocumentParser;
  /** Ящики сотрудников: у `MAIL_OWNER` ящик подключён, другие - по аргументу сборки. */
  mailboxes: MemoryMailboxDirectory;
  intake?: MemoryIntakeStore | undefined;
  access: SwitchableAccess;
}

/** Поставщики: s1 и s2 с контактом и прайсом на арматуру, s3 без контакта и без прайса. */
export async function buildOrderDeps(
  options: {
    request?: PurchaseRequest | null;
    /** Свои ящики сотрудников; по умолчанию подключён ящик `MAIL_OWNER`. */
    mailboxes?: MemoryMailboxDirectory;
    intake?: MemoryIntakeStore;
  } = {},
): Promise<OrderTestDeps> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert({ id: 's1', name: 'МеталлТорг', email: 'sales@metall.test' });
  await suppliers.upsert({ id: 's2', name: 'Болтик', email: 'info@boltik.test' });
  await suppliers.upsert({ id: 's3', name: 'БезКонтакта' });
  const prices = new MemoryPriceRepository();
  for (const supplierId of ['s1', 's2']) {
    await prices.saveImport(
      supplierId,
      [{ supplierId, productName: 'Арматура 12 мм', price: 50, currency: 'RUB', date: CREATED_AT }],
      `seed-${supplierId}`,
    );
  }
  const mailboxes = options.mailboxes ?? new MemoryMailboxDirectory();
  if (options.mailboxes === undefined) mailboxes.connect(MAIL_OWNER, MAIL_OWNER_ADDRESS);
  const requests = new MemoryPurchaseRequestRepository();
  const request = options.request === undefined ? ORDER_REQUEST : options.request;
  if (request !== null) await requests.save(request);
  return {
    requests,
    suppliers,
    prices,
    knowledge: new MemoryKnowledgeSearch(new Map([['kb-1', 'Арматура: условия поставки']])),
    web: new MemoryWebSearch([
      { title: 'МеталлТорг', url: 'https://metall.test', snippet: 'Арматура от склада' },
      { title: 'Арматура-Центр', url: 'https://armatura.test', snippet: 'Арматура и сетка' },
    ]),
    scheduler: new MemoryScheduler(new SequentialIdGenerator()),
    chat: new MemoryChatChannel(),
    clock: new FixedClock(),
    state: new MemoryWorkflowStateStore(),
    quotes: new MemorySupplierQuoteRepository(),
    managerThreadId: MANAGER_THREAD,
    tableExporter: new MemoryTableExporter(),
    parser: new MemoryDocumentParser(),
    mailboxes,
    // Право заводить карточки (этап 234): по умолчанию допущен, тесты переключают режим.
    access: new SwitchableAccess(),
    // Классификатор хитов по умолчанию называет компанию заголовком хита: тесты шорт-листа
    // сравнивают кандидатов по названию; отдельные тесты подменяют его своим ответом.
    webClassifier: new MemoryWebHitClassifier((input) => ({
      results: input.hits.map((hit) => ({
        domain: hit.domain,
        relevant: true,
        type: 'оптовик',
        company: hit.title,
      })),
    })),
    ...(options.intake === undefined ? {} : { intake: options.intake }),
  };
}

/** «Цель» нажатия кнопки выбора для открытого в треде вопроса (как её отдаёт parsePickButton). */
export async function pickTarget(
  state: WorkflowStateStore,
  threadId: string,
  supplierId: string,
): Promise<string> {
  const ask = await loadChoiceAsk(state, threadId);
  if (ask === null) throw new Error('в треде нет открытого вопроса');
  return `${choiceToken(ask.requestId, ask.version)}:${supplierId}`;
}

/** Менеджер нажимает «Готово» в открытом вопросе треда: набор можно фиксировать. */
export async function pressDone(
  deps: Pick<OrderCalcDeps, 'state' | 'clock'>,
  threadId: string,
  userId = 'manager',
): Promise<void> {
  const ask = await loadChoiceAsk(deps.state, threadId);
  if (ask === null) throw new Error('в треде нет открытого вопроса');
  const token = choiceToken(ask.requestId, ask.version);
  const outcome = await recordChoiceDone(deps.state, deps.clock, { token, userId, threadId });
  // Повторный запуск по той же заявке: выбор уже завершён в прошлый раз.
  if (outcome.kind !== 'finalized' && outcome.kind !== 'already_done') {
    throw new Error(`«Готово» не принято: ${outcome.kind}`);
  }
}

/**
 * Запись прежнего формата: запросы «отправлены» с ящика `owner` (`state: 'sent'`, есть id
 * сообщений). Такие записи остались от прежней отправки из системы и читаются как раньше.
 * Письмо в ящик отправителя не кладётся: тесты задают его сами. Повтор ничего не сдвигает.
 */
export async function markRequestsSent(
  deps: OrderCalcDeps,
  supplierIds: readonly string[],
  options: { requestId?: string; owner?: string; at?: string } = {},
): Promise<void> {
  const requestId = options.requestId ?? REQUEST_ID;
  const at = options.at ?? deps.clock.now().toISOString();
  const previous = await loadSent(deps, requestId);
  const sentBySupplier = { ...(previous?.sentBySupplier ?? {}) };
  const messageIds = { ...(previous?.messageIds ?? {}) };
  for (const id of supplierIds) {
    sentBySupplier[id] ??= at;
    messageIds[id] = `sent-${id}`;
  }
  await saveSent(deps, {
    requestId,
    supplierIds: [...new Set([...(previous?.supplierIds ?? []), ...supplierIds])],
    sentAt: at,
    sentBySupplier,
    messageIds,
    state: 'sent',
    mailboxOwnerId: previous?.mailboxOwnerId ?? options.owner ?? MAIL_OWNER,
  });
}

/** Положить в ящик сотрудника письмо поставщика (по умолчанию - владельца ящика). */
export function deliverReply(
  deps: Pick<OrderTestDeps, 'mailboxes'>,
  message: InboxMessage,
  owner: string = MAIL_OWNER,
): void {
  deps.mailboxes.deliver(owner, message);
}

/** Контекст хода сотрудника в его чате (черновик письма готовится только по просьбе человека). */
export function employeeToolContext(
  userId: string = MAIL_OWNER,
  threadId: string = `order-calc/${userId}`,
): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'order-calc',
    operationId: `op-${userId}`,
    initiator: { kind: 'user', userId },
  });
}

/**
 * Сотрудник просит текст запроса поставщикам: код показывает его в чате и записывает учёт
 * «подготовлено». Письмо не отправляется (заменяет прежний путь «черновик и кнопка»).
 */
export async function prepareRequestsText(
  deps: OrderTestDeps,
  input: { requestId?: string } = {},
  userId: string = MAIL_OWNER,
  threadId?: string,
): Promise<void> {
  await prepareSupplierRequestText.execute(
    { requestId: input.requestId ?? REQUEST_ID },
    deps,
    employeeToolContext(userId, threadId),
  );
}

/**
 * id прежней кнопки разнесения единственного письма на разнесении (вариант `index`): вопрос
 * теперь без кнопок, но уже отправленные кнопки обрабатываются как раньше.
 */
export async function routeButtonAt(state: WorkflowStateStore, index: number): Promise<string> {
  const [pending] = await listUnassignedMail(state);
  return pending === undefined ? '' : (routeButtonIds(pending)[index] ?? '');
}
