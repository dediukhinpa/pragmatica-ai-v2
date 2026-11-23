import {
  FixedClock,
  MemoryChatChannel,
  MemoryTableExporter,
  MemoryWebSearch,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import { MemoryPriceRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { PLACEHOLDER_EXPORT_TEMPLATE } from '../../src/agents/site-export/default-template';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { type SiteExportDeps } from '../../src/agents/site-export/deps';
import type { SiteExportCase } from '../cases';
import { MANAGER_THREAD } from '../constants';
import { buildMailboxes, draftsShownCount, mailSentCount, seedPrices } from './common';
import { chatFileCount, chatMessageCount } from '@business-ai/eval';
import { runProbe, type ProbeFn } from '@business-ai/eval';
import type { EvalEnvironment } from '@business-ai/eval';

/** Условный сотрудник, ведущий ход (нужен выбору ящика сотрудника). */
const EVAL_RESPONSIBLE_USER = 'eval-responsible';

/** Окружение агента «Актуализация сайта (ИИ агент)» из начального состояния кейса. */
export async function buildSiteExportEnvironment(
  testCase: SiteExportCase,
  model: string,
): Promise<EvalEnvironment> {
  const prices = new MemoryPriceRepository();
  const chat = new MemoryChatChannel();
  const clock = new FixedClock();
  // Режим почты сотрудников: сбор данных читает ящик сотрудника хода, писем выгрузка не шлёт
  const mailboxes = buildMailboxes(testCase.state.mailboxes);
  const mailboxOwners = testCase.state.mailboxes.map((item) => item.userId);
  await seedPrices(prices, testCase.state.prices);
  const deps: SiteExportDeps = {
    prices,
    knowledge: new MemoryKnowledgeSearch(new Map(Object.entries(testCase.state.knowledge))),
    state: new MemoryWorkflowStateStore(),
    template: PLACEHOLDER_EXPORT_TEMPLATE,
    chat,
    managerThreadId: MANAGER_THREAD,
    web: new MemoryWebSearch(testCase.state.web),
    tableExporter: new MemoryTableExporter(),
    clock,
    ...(mailboxes === undefined ? {} : { mailboxes }),
  };
  const probes: Record<string, ProbeFn> = {
    chatMessages: () => chatMessageCount(chat),
    chatFiles: () => chatFileCount(chat),
    // Выгрузка писем не готовит и не отправляет: оба замера нужны как отрицательная проверка
    draftsShown: () => draftsShownCount(chat),
    mailSent: () => mailSentCount(mailboxes, mailboxOwners),
  };
  return {
    declaration: createSiteExportAgent({ model }),
    toolDeps: deps,
    // Инициатор хода нужен выбору ящика сотрудника; без ящиков окружение прежнее
    ...(mailboxes === undefined
      ? {}
      : { runContext: { initiator: { kind: 'user' as const, userId: EVAL_RESPONSIBLE_USER } } }),
    probe: (name, arg) => runProbe('site-export', probes, name, arg),
  };
}
