import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryContractNumbering } from '../../src/kit/adapters/memory/contract-numbering';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { DOCUMENTS_PROMPT, buildDocumentsPrompt } from '../../src/agents/documents/prompt';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { findTemplate } from '../../src/agents/documents/find-template';
import { handoffForReview } from '../../src/agents/documents/handoff-for-review';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { saveDocument } from '../../src/agents/documents/save-document';
import { validateDocument } from '../../src/agents/documents/validate-document';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { DOCUMENT_KINDS, type DealDocument } from '../../src/kit/domain/models';
import { supplierRequisitesRecord } from '../../src/kit/domain/requisites';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { CTX, OWN_COMPANY, buildDocument, withSources } from './support';

const NDA = 'МГ Соглашение NDA.docx';
const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const REVIEWER = 'reviewer-thread';
const NDA_FIELDS = {
  seller_representative: 'директора Иванова И. И.',
  seller_position: 'директор',
  seller_authority_basis: 'Устава',
  nda_penalty_amount: '50000',
  contract_number: '15/26',
  contract_date: '2026-10-01',
};

type Deps = DocumentsDeps & { chat: MemoryChatChannel };

/** Базовые зависимости; `enabledKinds` не задан - все виды (поведение по умолчанию). */
async function build(enabledKinds?: DocumentsDeps['enabledKinds']): Promise<Deps> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert(FULL_SUPPLIER);
  const files = new MemoryFileSource();
  for (const template of CONTRACT_TEMPLATES) {
    files.put(template.fileName, new TextEncoder().encode('{{seller}} {{number}}'), 1_000);
  }
  return {
    files,
    knowledge: new MemoryKnowledgeSearch(new Map()),
    renderer: new MemoryDocumentRenderer(),
    suppliers,
    chat: new MemoryChatChannel(),
    ownCompanyNames: [OWN_COMPANY],
    quotes: new MemorySupplierQuoteRepository(),
    state: new MemoryWorkflowStateStore(),
    clock: new FixedClock(),
    contractNumbering: new MemoryContractNumbering(),
    reviewerThreadId: REVIEWER,
    ...(enabledKinds === undefined ? {} : { enabledKinds }),
  };
}

/** NDA с поставщиком: данные от сотрудника и из карточки, позиций и суммы нет. */
function ndaDocument(): DealDocument {
  return withSources(
    buildDocument({
      kind: 'contract',
      number: '',
      issuedAt: '2026-10-21',
      buyer: OWN_COMPANY,
      seller: FULL_SUPPLIER.name,
      supplierId: FULL_SUPPLIER.id,
      requisites: supplierRequisitesRecord(FULL_SUPPLIER),
      lines: [],
      total: 0,
      templateFields: NDA_FIELDS,
    }),
    'knowledge',
  );
}

let deps: Deps;
beforeEach(async () => {
  deps = await build(['contract']);
});

describe('DOCUMENTS_ENABLED_KINDS: по умолчанию всё как раньше', () => {
  test('без флага промпт прежний и ни один вид не отклоняется', async () => {
    const all = await build();
    expect(createDocumentsAgent({ model: 'm' }).prompt).toContain(DOCUMENTS_PROMPT);
    expect(buildDocumentsPrompt(DOCUMENT_KINDS)).toBe(DOCUMENTS_PROMPT);
    for (const kind of DOCUMENT_KINDS) {
      const out = await findTemplate.execute({ query: 'договор', kind }, all, CTX);
      expect(out.disabledReason).toBeUndefined();
    }
    const out = await prepareSupplierDocument.execute(
      { kind: 'closing', requestId: 'r', supplierId: 's1', issuedAt: '2026-10-21' },
      all,
      CTX,
    );
    expect(out.questions.join(' ')).not.toContain('Сейчас агент готовит только');
  });
});

describe('DOCUMENTS_ENABLED_KINDS=contract', () => {
  test('findTemplate: договор и NDA находятся, счёт и закрывающие отклонены', async () => {
    const nda = await findTemplate.execute({ query: 'NDA', kind: 'contract' }, deps, CTX);
    expect(nda.match).toMatchObject({ status: 'unique', template: { path: NDA } });
    expect(nda.disabledReason).toBeUndefined();
    for (const kind of ['invoice', 'closing', 'commercial_offer'] as const) {
      const out = await findTemplate.execute({ query: 'договор', kind }, deps, CTX);
      expect(out.disabledReason).toContain('Сейчас агент готовит только договоры и NDA');
      expect(out.templates).toEqual([]);
      expect(out.match.status).toBe('not_found');
    }
  });

  test('prepareSupplierDocument: закрывающие и счёт отклонены понятным сообщением', async () => {
    for (const kind of ['closing', 'invoice'] as const) {
      const out = await prepareSupplierDocument.execute(
        { kind, requestId: 'r', supplierId: 's1', number: '1', issuedAt: '2026-10-21' },
        deps,
        CTX,
      );
      expect(out.ready).toBe(false);
      expect(out.questions[0]).toContain('Сейчас агент готовит только договоры и NDA');
    }
  });

  test('схемы от флага не зависят: kind - enum всех видов', () => {
    const shape = (tool: { inputSchema: unknown }): unknown =>
      JSON.stringify((tool.inputSchema as { shape: unknown }).shape);
    expect(shape(findTemplate)).toContain('closing');
    expect(shape(prepareSupplierDocument)).toContain('invoice');
  });

  test('NDA проходит весь путь: шаблон, проверка полей, сборка, передача на проверку', async () => {
    const document = ndaDocument();
    const check = await checkTemplateFieldsTool.execute(
      { templatePath: NDA, document },
      deps,
      CTX,
    );
    expect(check).toMatchObject({ known: true, templateId: 'mg_nda', complete: true });
    const valid = await validateDocument.execute({ document }, deps, CTX);
    expect(JSON.stringify(valid)).not.toContain('kind_disabled');
    const file = await fillTemplate.execute({ templatePath: NDA, document }, deps, CTX);
    expect(file.sizeBytes).toBeGreaterThan(0);
    const handoff = await handoffForReview.execute({ templatePath: NDA, document }, deps, CTX);
    expect(handoff.status).toBe('awaiting_review');
    expect(deps.chat.outbox.some((o) => o.threadId === REVIEWER && o.file !== undefined)).toBe(
      true,
    );
  });

  test('договор на поставку (МГ, готовая продукция) тоже не отклоняется видом', async () => {
    const out = await findTemplate.execute({ query: 'МГ готовая продукция' }, deps, CTX);
    expect(out.match).toMatchObject({ status: 'unique', template: { path: MG_READY } });
  });

  test('сборка и выпуск выключенного вида отклоняются, даже если модель пропустила поиск', async () => {
    const closing = withSources(
      buildDocument({ kind: 'closing', supplierId: 's1', seller: FULL_SUPPLIER.name }),
    );
    const offer = withSources(buildDocument({ kind: 'commercial_offer' }));
    for (const document of [closing, offer]) {
      await expect(
        fillTemplate.execute({ templatePath: NDA, document }, deps, CTX),
      ).rejects.toThrow('Сейчас агент готовит только договоры и NDA');
      await expect(
        saveDocument.execute({ templatePath: NDA, document }, deps, CTX),
      ).rejects.toThrow('Сейчас агент готовит только договоры и NDA');
    }
    const valid = await validateDocument.execute({ document: offer }, deps, CTX);
    expect(JSON.stringify(valid)).toContain('kind_disabled');
  });

  test('промпт и приветствие говорят только о договорах и NDA', () => {
    const agent = createDocumentsAgent({ model: 'm', enabledKinds: ['contract'] });
    const greeting = agent.greeting;
    const text = [agent.prompt, greeting?.role, ...(greeting?.examples ?? [])]
      .join('\n')
      .toLowerCase();
    expect(text).toContain('договоры и nda');
    for (const word of ['коммерческ', 'счета', 'счёт', 'закрывающ', 'invoice', 'closing']) {
      expect(text).not.toContain(word);
    }
    // Состав инструментов не меняется: код закрывающих, счетов и КП не удалён.
    expect(agent.tools.map((t) => t.name)).toEqual(
      createDocumentsAgent({ model: 'm' }).tools.map((t) => t.name),
    );
  });
});

describe('NDA с поставщиком, у которого уже есть КП', () => {
  const NDA_PREPARE = {
    kind: 'contract' as const,
    supplierId: 's1',
    templatePath: NDA,
    issuedAt: '2026-10-21',
    templateFields: NDA_FIELDS,
  };

  beforeEach(async () => {
    await deps.quotes?.save({
      id: 'quote:req-1:s1',
      requestId: 'req-1',
      supplierId: 's1',
      currency: 'RUB',
      receivedAt: '2026-01-01T00:00:00.000Z',
      paymentTerms: '50%',
      deliveryDays: 7,
      gaps: [],
      lines: [{ productName: 'Болт М8', unitPrice: 12, quantity: 10 }],
    });
  });

  test('prepareSupplierDocument собирает NDA из карточки без КП и заявки', async () => {
    const out = await prepareSupplierDocument.execute(NDA_PREPARE, deps, CTX);
    expect(out.ready).toBe(true);
    expect(out.document).toMatchObject({
      kind: 'contract',
      seller: FULL_SUPPLIER.name,
      buyer: OWN_COMPANY,
      supplierId: 's1',
      lines: [],
      total: 0,
    });
    expect(out.document?.requestId).toBeUndefined();
  });

  test('validateDocument и handoffForReview пропускают NDA, сверки с КП нет', async () => {
    const { document } = await prepareSupplierDocument.execute(NDA_PREPARE, deps, CTX);
    if (document === undefined) throw new Error('документ не собран');
    const valid = await validateDocument.execute({ document, templatePath: NDA }, deps, CTX);
    expect(valid.issues).toEqual([]);
    const handoff = await handoffForReview.execute({ templatePath: NDA, document }, deps, CTX);
    expect(handoff.status).toBe('awaiting_review');
    // Даже со ссылкой на заявку, по которой КП есть: NDA с КП не сверяется.
    const withRequest = { ...document, requestId: 'req-1', number: 'NDA-2' };
    const again = await handoffForReview.execute(
      { templatePath: NDA, document: withRequest },
      deps,
      CTX,
    );
    expect(again.status).toBe('awaiting_review');
  });

  test('договор на поставку без заявки собирается, вопрос про заявку остаётся', async () => {
    const noRequest = await prepareSupplierDocument.execute(
      { kind: 'contract', supplierId: 's1', templatePath: MG_READY, issuedAt: '2026-10-21' },
      deps,
      CTX,
    );
    expect(noRequest.ready).toBe(true);
    expect(noRequest.questions.join(' ')).toContain('Заявка с выбранным КП');
    const blocked = await handoffForReview
      .execute({ templatePath: NDA, document: { ...ndaDocument(), kind: 'closing' } }, deps, CTX)
      .catch((error: unknown) => String(error));
    expect(String(blocked)).toContain('Сейчас агент готовит только договоры и NDA');
  });
});
