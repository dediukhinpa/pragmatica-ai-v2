import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { buildChoiceMessage } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { compareQuotesTool } from '../../src/agents/order-calc/compare-quotes';
import { findSupplierCard } from '../../src/agents/suppliers/supplier-tools';
import { getSupplierRequisites } from '../../src/agents/documents/get-supplier-requisites';
import { handoffForReview } from '../../src/agents/documents/handoff-for-review';
import { loadProposal, saveSelection } from '../../src/agents/order-calc/state';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { buildInitialImportSummary } from '../../src/agents/prices/initial-import-summary';
import { buildQuoteSummaryText, loadComparison } from '../../src/agents/order-calc/quote-summary';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { CREATED_AT, CTX, OWN_COMPANY } from './support';
import {
  REQUEST_ID,
  buildOrderDeps,
  employeeToolContext,
  MAIL_OWNER,
  type OrderTestDeps,
} from './order-support';
import { THREAD_A, buildSupplierWorld, turnContext, USER_A } from './suppliers-support';

// Этап 240: черновиков нет, поэтому ни одна выдача не должна нести пометку «не проверено».
const OLD_MARK = 'не проверено, создана автоматически';
const NO_CONTACTS = 'нет контактов: дополните карточку, чтобы отправить запрос';

function autoCard(id: string, name: string, withEmail: boolean): SupplierCard {
  return {
    id,
    name,
    status: 'active',
    contacts: withEmail ? [{ email: `${id}@draft.test`, isPrimary: true }] : [],
    supplies: { categories: ['арматура'], brands: [], regions: [] },
    terms: {},
    notes: [],
  };
}

describe('автоматические карточки в шорт-листе и запросе поставщику', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
    await deps.suppliers.saveCard(autoCard('d1', 'Черновик-Один', false));
    await deps.suppliers.saveCard(autoCard('d2', 'Черновик-Два', true));
  });

  async function shortlistText(): Promise<string> {
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    await buildShortlist.execute(input, deps, CTX);
    const proposal = await loadProposal(deps, REQUEST_ID);
    if (proposal === null) throw new Error('шорт-лист не собран');
    return buildChoiceMessage(proposal).text;
  }

  test('в шорт-листе нет ни пометки «не проверено», ни «нет контактов»', async () => {
    const text = await shortlistText();
    // Пометки черновика стоят после реквизитов, поэтому блок - до следующего номера в списке.
    const block = (name: string): string => {
      const rows = text.split('\n');
      const from = rows.findIndex((l) => l.includes(name));
      const rest = rows.slice(from + 1);
      const next = rest.findIndex((l) => /^\d+\. Поставщик:/u.test(l));
      return rows.slice(from, next === -1 ? undefined : from + 1 + next).join('\n');
    };
    expect(block('Черновик-Один')).not.toContain(OLD_MARK);
    expect(block('Черновик-Один')).not.toContain(NO_CONTACTS);
    expect(block('Черновик-Два')).not.toContain(OLD_MARK);
    expect(block('МеталлТорг')).not.toContain(OLD_MARK);
  });

  test('запрос к карточке без контактов: текст готов, адреса нет, пометки нет', async () => {
    await saveSelection(deps, {
      requestId: REQUEST_ID,
      supplierIds: ['d1'],
      createdAt: deps.clock.now().toISOString(),
    });
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      employeeToolContext(MAIL_OWNER),
    );
    expect(out.shownSupplierIds).toEqual(['d1']);
    expect(out.withoutContact).toEqual(['d1']);
    const texts = deps.chat.outbox.map((record) => record.message?.text ?? '');
    const block = texts.find((t) => t.includes('Поставщик: Черновик-Один')) ?? '';
    expect(block).not.toContain(OLD_MARK);
    expect(block).toContain('Кому: адрес не найден, уточните контакт');
  });

  test('карточка с адресом: текст готовится без пометки; без контактов - заметка в итоге', async () => {
    await saveSelection(deps, {
      requestId: REQUEST_ID,
      supplierIds: ['s1', 'd1', 'd2'],
      createdAt: deps.clock.now().toISOString(),
    });
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      employeeToolContext(MAIL_OWNER),
    );
    const texts = deps.chat.outbox.map((record) => record.message?.text ?? '');
    const two = texts.find((t) => t.includes('Поставщик: Черновик-Два')) ?? '';
    expect(two).not.toContain(OLD_MARK);
    const one = texts.find((t) => t.includes('Поставщик: МеталлТорг')) ?? '';
    expect(one).not.toContain(OLD_MARK);
    expect(texts.some((t) => t.includes('Нет пригодного адреса почты у поставщиков: d1'))).toBe(true);
  });
});

describe('автоматические карточки в КП и сравнении', () => {
  test('compareQuotes не отдаёт список черновиков, сводка без пометки', async () => {
    const deps = await buildOrderDeps();
    await deps.suppliers.saveCard(autoCard('d1', 'Черновик-Один', true));
    await saveSelection(deps, {
      requestId: REQUEST_ID,
      supplierIds: ['s1', 'd1'],
      createdAt: deps.clock.now().toISOString(),
    });
    const out = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out).not.toHaveProperty('draftSupplierIds');
    const loaded = await loadComparison(deps, REQUEST_ID);
    expect(loaded).not.toHaveProperty('draftSupplierIds');
    expect(buildQuoteSummaryText(loaded.comparison).text).not.toContain(OLD_MARK);
  });
});

describe('сводка импорта', () => {
  test('созданные карточки названы без пометки «не проверено»', () => {
    const text = buildInitialImportSummary(
      [
        {
          run: 'r',
          file: 'a.xlsx',
          status: 'written',
          rows: 3,
          draft: { supplierId: 'd1', name: 'Черновик-Один' },
          at: CREATED_AT,
        },
      ],
      false,
    );
    expect(text).not.toContain(OLD_MARK);
    expect(text).toContain('«Черновик-Один»');
  });
});

describe('findSupplierCard: без черновиков', () => {
  test('в выдаче нет пометки draft и нет фильтра draftsOnly', async () => {
    const world = buildSupplierWorld();
    await world.suppliers.saveCard(autoCard('d1', 'Черновик-Один', true));
    const host = { supplierCards: world.deps };
    const ctx = turnContext(THREAD_A, USER_A);
    const byName = await findSupplierCard.execute({ query: 'Черновик' }, host, ctx);
    expect(byName.cards[0]).not.toHaveProperty('draft');
    expect(byName.cards[0]).not.toHaveProperty('priceCount');
    // Условий нет вовсе: фильтр draftsOnly убран, пустой запрос по-прежнему отклоняется.
    await expect(findSupplierCard.execute({}, host, ctx)).rejects.toThrow();
  });
});

describe('реквизиты автоматической карточки в «Документах»', () => {
  const TEMPLATE = 'templates/Договор поставки.docx';
  async function build(): Promise<DocumentsDeps & { chat: MemoryChatChannel }> {
    const suppliers = new MemorySupplierRepository();
    await suppliers.upsert(FULL_SUPPLIER);
    const card = await suppliers.getCard('s1');
    if (card === null) throw new Error('нет карточки');
    await suppliers.saveCard(card);
    const files = new MemoryFileSource();
    files.put(TEMPLATE, new TextEncoder().encode('Договор {{number}} {{seller}}'), 1_000);
    const chat = new MemoryChatChannel();
    const quotes = new MemorySupplierQuoteRepository();
    await quotes.save({
      id: 'quote:req-1:s1',
      requestId: 'req-1',
      supplierId: 's1',
      currency: 'RUB',
      receivedAt: CREATED_AT,
      validUntil: '2026-03-01T00:00:00.000Z',
      paymentTerms: '50% предоплата',
      deliveryDays: 7,
      gaps: [],
      lines: [{ productName: 'Болт М8', unitPrice: 12, quantity: 10 }],
    });
    return {
      files,
      knowledge: new MemoryKnowledgeSearch(new Map()),
      renderer: new MemoryDocumentRenderer(),
      suppliers,
      chat,
      ownCompanyNames: [OWN_COMPANY],
      quotes,
      state: new MemoryWorkflowStateStore(),
      clock: new FixedClock(),
      reviewerThreadId: 'reviewer',
    };
  }

  test('getSupplierRequisites: предупреждения «реквизиты не проверены» нет', async () => {
    const deps = await build();
    const out = await getSupplierRequisites.execute({ supplierId: 's1' }, deps, CTX);
    expect(out).not.toHaveProperty('unverified');
    expect(out).not.toHaveProperty('warning');
  });

  test('handoffForReview: предупреждения о непроверенной карточке нет', async () => {
    const deps = await build();
    const prepared = await prepareSupplierDocument.execute(
      {
        kind: 'contract',
        requestId: 'req-1',
        supplierId: 's1',
        number: 'Д-1',
        issuedAt: '2026-01-05T00:00:00.000Z',
      },
      deps,
      CTX,
    );
    if (prepared.document === undefined) throw new Error(prepared.questions.join('; '));
    const out = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: prepared.document },
      deps,
      CTX,
    );
    expect(out.checklist.some((item) => item.value.includes('реквизиты не проверены'))).toBe(false);
    expect(out.message).not.toContain('реквизиты не проверены');
  });
});
