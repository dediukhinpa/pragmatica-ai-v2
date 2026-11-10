import {
  FixedClock,
  MemoryAccessPolicy,
  MemoryAuditRepository,
  MemoryChatChannel,
  MemoryMailboxDirectory,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import {
  MemorySupplierMailClassifier,
} from '../../src/kit/adapters/memory/supplier-mail-classifier';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { type SupplierMailProposalsDeps } from '../../src/agents/suppliers/mail-proposal-store';
import { type SupplierMailProposalsOptions } from '../../src/agents/suppliers/mail-proposals';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { MailboxNotConnectedError } from '@business-ai/core';
import type { EmployeeMailbox, InboxMessage, MailboxDirectory } from '@business-ai/core';
import type {
  SupplierMailClassification,
  SupplierMailClassificationInput,
} from '../../src/kit/ports/supplier-mail-classifier';
import { validInn } from './suppliers-support';

/** Общая сборка для тестов обзора почты сотрудников (этап 222); данные синтетические. */

export const ZONE = 'Asia/Yekaterinburg';
/** Понедельник 10:00 по Екатеринбургу (UTC+5): ровно час проверки. */
export const DUE = new Date('2026-10-12T05:00:00.000Z');
export const RECEIVED_AT = '2026-10-11T10:00:00.000Z';
export const ADDRESSEE_AGENT = 'order-calc';
export const BOT_ID = 'orders';
export const EMPLOYEE_A = 'u-100';
export const EMPLOYEE_B = 'u-200';
/** Сотрудник из каталога без подключённого ящика. */
export const EMPLOYEE_NO_BOX = 'u-300';
export const OPTIONS: SupplierMailProposalsOptions = { timezone: ZONE };
export const OUR_INN = '7701234567';
export const threadOf = (userId: string): string => `${BOT_ID}/${userId}`;

export const SUPPLIER_VERDICT: SupplierMailClassification = {
  kind: 'supplier',
  hasSupplierInfo: true,
  categories: [],
};

/** Слова для названий синтетических поставщиков (без цифр: название не должно их содержать). */
const WORDS = [
  'Альфа', 'Бета', 'Гамма', 'Дельта', 'Эпсилон', 'Зета', 'Эта', 'Тета', 'Йота', 'Каппа',
  'Лямбда', 'Мю', 'Ню', 'Кси',
] as const;
const INN_BASE = 770_700_000;

/** Данные n-го синтетического поставщика: название, домен, ИНН. */
export function supplierOf(n: number): { name: string; domain: string; inn: string } {
  const word = WORDS[n % WORDS.length] ?? 'Омега';
  return {
    name: `ООО «${word} Трейд»`,
    domain: `${word.toLowerCase().replace(/[^a-z]/g, '')}${n}-trade.test`,
    inn: validInn(String(INN_BASE + n * 7)),
  };
}

/** Письмо n-го поставщика; домен латиницей, название и ИНН в тексте. */
export function letter(
  id: string,
  n = 0,
  overrides: Partial<InboxMessage> = {},
): InboxMessage {
  const supplier = supplierOf(n);
  return {
    id,
    from: `sales@${supplier.domain}`,
    subject: `Предложение ${n}`,
    body: [
      'Добрый день!',
      `${supplier.name} предлагает картонную упаковку.`,
      `ИНН ${supplier.inn}`,
      `Сайт: https://${supplier.domain}`,
      'С уважением,',
      'Менеджер по продажам',
    ].join('\n'),
    receivedAt: RECEIVED_AT,
    attachments: [],
    senderAuth: 'verified',
    ...overrides,
  };
}

export interface ProposalWorld {
  deps: SupplierMailProposalsDeps;
  clock: FixedClock;
  state: MemoryWorkflowStateStore;
  suppliers: MemorySupplierRepository;
  mailboxes: MemoryMailboxDirectory;
  chat: MemoryChatChannel;
  access: MemoryAccessPolicy;
  audit: MemoryAuditRepository;
  classifier: MemorySupplierMailClassifier;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  setVerdict(decide: (input: SupplierMailClassificationInput) => SupplierMailClassification): void;
  /** Тексты исходящих сообщений сотруднику в его треде. */
  sentTo(userId: string): string[];
}

/** Каталог, где часть сотрудников значится, но ящика у них нет. */
class DirectoryWithGaps implements MailboxDirectory {
  constructor(
    private readonly inner: MemoryMailboxDirectory,
    private readonly ghosts: readonly string[],
  ) {}

  async forEmployee(userId: string): Promise<EmployeeMailbox> {
    if (this.ghosts.includes(userId)) throw new MailboxNotConnectedError();
    return this.inner.forEmployee(userId);
  }

  employeeIds(): readonly string[] {
    return [...this.inner.employeeIds(), ...this.ghosts].sort();
  }
}

export function build(
  overrides: Partial<SupplierMailProposalsDeps> = {},
  start: Date = DUE,
): ProposalWorld {
  const clock = new FixedClock(start);
  const state = new MemoryWorkflowStateStore(() => clock.now().getTime());
  const suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  const inner = new MemoryMailboxDirectory();
  inner.connect(EMPLOYEE_A, 'anna@company.test');
  inner.connect(EMPLOYEE_B, 'boris@company.test');
  const mailboxes = inner;
  const chat = new MemoryChatChannel();
  const access = new MemoryAccessPolicy();
  for (const userId of [EMPLOYEE_A, EMPLOYEE_B, EMPLOYEE_NO_BOX]) {
    access.allow({ userId, botId: ADDRESSEE_AGENT, action: 'chat.message' });
    access.allow({ userId, botId: ADDRESSEE_AGENT, action: ACTION_CONFIRM_SUPPLIER_CARD });
  }
  const audit = new MemoryAuditRepository();
  let decide: (input: SupplierMailClassificationInput) => SupplierMailClassification = () =>
    SUPPLIER_VERDICT;
  const classifier = new MemorySupplierMailClassifier((input) => decide(input));
  const logs: ProposalWorld['logs'] = [];
  const deps: SupplierMailProposalsDeps = {
    suppliers,
    state,
    clock,
    classifier,
    mailboxes: new DirectoryWithGaps(inner, [EMPLOYEE_NO_BOX]),
    chat,
    access,
    addresseeAgentId: ADDRESSEE_AGENT,
    botId: BOT_ID,
    ownCompanyNames: ['ООО «Наша Компания»'],
    ownCompanyRequisites: [`ИНН ${OUR_INN}`, 'zakupki@company.test'],
    audit,
    log: (event, fields = {}) => logs.push({ event, fields }),
    ...overrides,
  };
  return {
    deps,
    clock,
    state,
    suppliers,
    mailboxes,
    chat,
    access,
    audit,
    classifier,
    logs,
    setVerdict: (next) => {
      decide = next;
    },
    sentTo: (userId) =>
      chat.outbox
        .filter((record) => record.threadId === threadOf(userId))
        .map((record) => record.message?.text ?? ''),
  };
}

/** Хозяин зависимостей инструмента решения. */
export function hostOf(world: ProposalWorld): OrderCalcDeps {
  return { mailProposals: world.deps } as unknown as OrderCalcDeps;
}

/** Ход сотрудника в его треде с ботом-адресатом. */
export function turnOf(userId: string, threadId = threadOf(userId)): ToolContext {
  return createToolContext({
    threadId,
    agentId: ADDRESSEE_AGENT,
    operationId: `op-${userId}`,
    initiator: { kind: 'user', userId },
  });
}
