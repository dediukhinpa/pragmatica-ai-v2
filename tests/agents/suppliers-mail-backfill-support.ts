import {
  FixedClock,
  MemoryAuditRepository,
  MemoryMailboxDirectory,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import {
  MemorySupplierMailClassifier,
} from '../../src/kit/adapters/memory/supplier-mail-classifier';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import {
  runSupplierMailBackfill,
  type SupplierMailBackfillOptions,
  type SupplierMailBackfillResult,
  type SupplierMailEnrichDeps,
} from '../../src/agents/suppliers/mail-enrich';
import { type BackfillReport } from '../../src/agents/suppliers/mail-backfill-report';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import type { InboxMessage } from '@business-ai/core';
import type {
  SupplierMailClassification,
  SupplierMailClassificationInput,
} from '../../src/kit/ports/supplier-mail-classifier';
import { INN_ALPHA } from './suppliers-support';

/** Общая сборка для тестов разового прохода по общему ящику (этап 220b); данные синтетические. */

export const NOW = new Date('2026-11-08T09:00:00.000Z');
export const SOURCE_ID = 'info-source';
export const SOURCE_ADDRESS = 'Info@Company.Test';
/** Письмо двухлетней давности: окна по дате у разового прохода нет. */
export const RECEIVED_AT = '2024-11-11T10:00:00.000Z';
export const OUR_INN = '7701234567';
export const OUR_PHONE = '+7 (900) 123-45-67';

export const SUPPLIER_VERDICT: SupplierMailClassification = {
  kind: 'supplier',
  hasSupplierInfo: true,
  categories: [],
};

export interface World {
  deps: SupplierMailEnrichDeps;
  clock: FixedClock;
  state: MemoryWorkflowStateStore;
  suppliers: MemorySupplierRepository;
  mailboxes: MemoryMailboxDirectory;
  audit: MemoryAuditRepository;
  classifier: MemorySupplierMailClassifier;
  inputs: SupplierMailClassificationInput[];
  setVerdict(decide: (input: SupplierMailClassificationInput) => SupplierMailClassification): void;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  /** «Файл» отчёта: то, что сохранил `onReport`; следующий запуск читает его как с диска. */
  file: { report: BackfillReport | null; saves: number };
}

export function build(overrides: Partial<SupplierMailEnrichDeps> = {}): World {
  const clock = new FixedClock(NOW);
  const state = new MemoryWorkflowStateStore();
  const suppliers = new MemorySupplierRepository(() => clock.now().toISOString());
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connectSource(SOURCE_ID, SOURCE_ADDRESS.toLowerCase());
  const audit = new MemoryAuditRepository();
  const inputs: SupplierMailClassificationInput[] = [];
  let decide: (input: SupplierMailClassificationInput) => SupplierMailClassification = () =>
    SUPPLIER_VERDICT;
  const classifier = new MemorySupplierMailClassifier((input) => {
    inputs.push(input);
    return decide(input);
  });
  const logs: World['logs'] = [];
  const deps: SupplierMailEnrichDeps = {
    suppliers,
    state,
    clock,
    classifier,
    mailboxes,
    sourceAddress: SOURCE_ADDRESS,
    ownCompanyNames: ['ООО «Наша Компания»'],
    ownCompanyRequisites: [`ИНН ${OUR_INN}`, OUR_PHONE, 'zakupki@company.test'],
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
    audit,
    classifier,
    inputs,
    setVerdict: (next) => {
      decide = next;
    },
    logs,
    file: { report: null, saves: 0 },
  };
}

/** Запуск прохода: отчёт читается из «файла» и сохраняется в него, как это делает команда. */
export async function run(
  world: World,
  options: Partial<SupplierMailBackfillOptions> = {},
): Promise<SupplierMailBackfillResult> {
  return runSupplierMailBackfill(world.deps, {
    dryRun: false,
    report: world.file.report === null ? null : structuredClone(world.file.report),
    onReport: async (report) => {
      world.file.report = structuredClone(report);
      world.file.saves += 1;
    },
    ...options,
  });
}

export function letter(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id,
    from: 'sales@vega-trade.test',
    subject: 'Коммерческое предложение на упаковку',
    body: [
      'Добрый день!',
      'ООО «Вега Трейд» предлагает картонную упаковку.',
      `ИНН ${INN_ALPHA}`,
      'Сайт: https://vega-trade.test',
      'С уважением,',
      'Петров Пётр Петрович',
      'Менеджер по продажам',
      '+7 (495) 111-22-33',
    ].join('\n'),
    receivedAt: RECEIVED_AT,
    attachments: [],
    // Отправитель общего ящика не подтверждён (SPF на почтовом сервере сломан): так и есть.
    senderAuth: 'unverified',
    ...overrides,
  };
}

/** Письмо другого поставщика: уникальные домен и ИНН-подпись не нужны, достаточно сайта. */
export function otherLetter(id: string, host: string, name: string): InboxMessage {
  return letter(id, {
    from: `sales@${host}`,
    body: `ООО «${name}» предлагает упаковку. Сайт: https://${host}`,
  });
}

export async function allCards(world: World): Promise<SupplierCard[]> {
  return world.suppliers.searchCards({ limit: 500 });
}

export async function seed(world: World, fields: SupplierCardFields): Promise<SupplierCard> {
  const base = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-10-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return world.suppliers.saveCard(base, { createOnly: true });
}
