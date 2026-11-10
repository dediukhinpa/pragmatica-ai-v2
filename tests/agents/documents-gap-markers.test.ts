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
import {
  GAP_MARKER_PREFIX,
  VARIANT_UNSET_VALUE,
  fillTemplateGaps,
  gapMarker,
  templateLabels,
} from '../../src/agents/documents/template-fields';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { handoffForReview } from '../../src/agents/documents/handoff-for-review';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { saveDocument } from '../../src/agents/documents/save-document';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { supplierRequisitesRecord } from '../../src/kit/domain/requisites';
import { type DealDocument } from '../../src/kit/domain/models';
import type {
  DocumentRenderer,
  RenderData,
  RenderRequest,
  RenderedDocument,
} from '@business-ai/core';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { CTX, OWN_COMPANY, buildDocument, withSources } from './support';

const REVIEWER = 'reviewer-thread';
const NDA = 'МГ Соглашение NDA.docx';
/** Метки, которые код считает сам и которых нет в списке проверяемых, но шаблоны их содержат. */
const COMPUTED_CONTRACT_LABELS = ['current_year', 'total_sum', 'vat_sum', 'vat_amount'];
const COMPUTED_NDA_LABELS = ['current_year', 'nda_penalty_thousands_words'];
/**
 * В настоящих шаблонах эти метки стоят внутри условных блоков (`{{#if payment_variant=...}}`),
 * которые заглушка-рендерер не понимает: без выбранного варианта блок скрыт, метки не нужны.
 */
const CONDITIONAL_BLOCK_LABELS = new Set([
  'prepayment_percent',
  'final_payment_percent',
  'delivery_address',
]);
const VARIANT_GAP_KEYS = ['payment_variant__gap', 'delivery_variant__gap'];
/** Строка таблицы позиций, как в шаблонах спецификации. */
const ITEM_ROW =
  '{{items._n}} {{items.name}} {{items.characteristics}} {{items.quantity}} ' +
  '{{items.unitPrice}} {{items.sum}} {{items.term}}';

/** Рендерер запоминает последний собранный файл: по нему проверяем текст договора. */
class CapturingRenderer implements DocumentRenderer {
  readonly inner = new MemoryDocumentRenderer();
  lastText = '';
  async render(request: RenderRequest): Promise<RenderedDocument> {
    const file = await this.inner.render(request);
    this.lastText = new TextDecoder().decode(file.content);
    return file;
  }
}

type Deps = DocumentsDeps & { chat: MemoryChatChannel; renderer: CapturingRenderer };

/** Шаблон со всеми метками шаблона из реестра: `{{метка}}` на каждую, плюс строка позиций. */
function templateText(templateId: string): string {
  const nda = templateId === 'mg_nda';
  const labels = [
    ...templateLabels(templateId).filter((label) => !CONDITIONAL_BLOCK_LABELS.has(label)),
    ...(nda ? COMPUTED_NDA_LABELS : COMPUTED_CONTRACT_LABELS),
  ];
  // Абзацы-маркеры вариантов настоящий сервис ставит сам; заглушке они нужны явной меткой.
  const variantGaps = nda ? [] : VARIANT_GAP_KEYS.map((key) => `${key}: {{${key}}}`);
  const lines = labels.map((label) => `${label}: {{${label}}}`);
  return [...lines, ...variantGaps, ...(nda ? [] : [ITEM_ROW])].join('\n');
}

async function build(): Promise<Deps> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert(FULL_SUPPLIER);
  const files = new MemoryFileSource();
  for (const template of CONTRACT_TEMPLATES) {
    files.put(template.fileName, new TextEncoder().encode(templateText(template.id)), 1_000);
  }
  return {
    files,
    knowledge: new MemoryKnowledgeSearch(new Map()),
    renderer: new CapturingRenderer(),
    suppliers,
    chat: new MemoryChatChannel(),
    ownCompanyNames: [OWN_COMPANY],
    quotes: new MemorySupplierQuoteRepository(),
    state: new MemoryWorkflowStateStore(),
    clock: new FixedClock(),
    contractNumbering: new MemoryContractNumbering(),
    reviewerThreadId: REVIEWER,
  };
}

/** Договор без единого ответа сотрудника; позиция без характеристик и срока. */
function bareContract(overrides: Partial<DealDocument> = {}): DealDocument {
  return withSources(
    buildDocument({
      kind: 'contract',
      number: '',
      issuedAt: '2026-10-21',
      buyer: OWN_COMPANY,
      seller: FULL_SUPPLIER.name,
      supplierId: FULL_SUPPLIER.id,
      requisites: supplierRequisitesRecord(FULL_SUPPLIER),
      lines: [{ name: 'Болт М8', quantity: 2, unitPrice: 60_000 }],
      total: 120_000,
      ...overrides,
    }),
    'knowledge',
  );
}

const countMarkers = (text: string): number => text.split(GAP_MARKER_PREFIX).length - 1;

let deps: Deps;
beforeEach(async () => {
  deps = await build();
});

describe('пропуски в договоре и NDA превращаются в маркеры', () => {
  test.each(CONTRACT_TEMPLATES.map((t) => [t.id, t.fileName] as const))(
    'шаблон %s: файл выдан, плейсхолдеров не осталось',
    async (id, fileName) => {
      const document = bareContract();
      const check = await checkTemplateFieldsTool.execute(
        { templatePath: fileName, document },
        deps,
        CTX,
      );
      expect(check.complete).toBe(false);
      const out = await fillTemplate.execute({ templatePath: fileName, document }, deps, CTX);
      const text = deps.renderer.lastText;
      expect(out.sizeBytes).toBeGreaterThan(0);
      expect(text).not.toContain('{{');
      expect(countMarkers(text)).toBeGreaterThanOrEqual(check.missingLabels.length - 1);
      expect(out.unfilled.length).toBe(check.questions.length);
      // Позиция без характеристик и срока: маркеры в ячейках, а не пустота.
      if (id !== 'mg_nda') {
        expect(text).toContain(gapMarker('характеристики позиций'));
        expect(text).toContain(gapMarker('срок по позициям'));
      }
    },
  );

  test('договор с 10 и более пропусками: N маркеров в файле, пропусков нет молча', async () => {
    const mgReady = CONTRACT_TEMPLATES.find((t) => t.id === 'mg_ready')?.fileName ?? '';
    const document = bareContract();
    const check = await checkTemplateFieldsTool.execute(
      { templatePath: mgReady, document },
      deps,
      CTX,
    );
    expect(check.missingLabels.length).toBeGreaterThanOrEqual(10);
    await fillTemplate.execute({ templatePath: mgReady, document }, deps, CTX);
    const text = deps.renderer.lastText;
    expect(countMarkers(text)).toBeGreaterThanOrEqual(10);
    // Маркер только с названием поля: ни ИНН, ни счетов, ни ФИО в нём нет.
    expect(text).toContain('payment_variant: unset');
    expect(text).toContain('payment_variant__gap: [ЗАПОЛНИТЬ: условия оплаты');
    expect(text).toContain('delivery_variant__gap: [ЗАПОЛНИТЬ: способ передачи товара');
    expect(text).toContain(gapMarker('срок поставки'));
  });

  test('NDA без данных: файл выдан, в чек-листе и сообщении «Не заполнено»', async () => {
    const document = bareContract({ lines: [], total: 0 });
    const out = await handoffForReview.execute({ templatePath: NDA, document }, deps, CTX);
    expect(out.status).toBe('awaiting_review');
    const text = deps.renderer.lastText;
    expect(text).not.toContain('{{');
    expect(text).toContain(gapMarker('размер штрафа'));
    expect(countMarkers(text)).toBeGreaterThanOrEqual(5);
    const gaps = out.checklist.find((item) => item.label === 'Не заполнено');
    expect(gaps?.value).toContain(gapMarker('размер штрафа'));
    // Текст в чат не уходит: чек-лист приходит модели в message.
    expect(deps.chat.outbox.some((o) => o.message !== undefined)).toBe(false);
    const message = out.message;
    expect(message.startsWith('В договоре остались пропуски:')).toBe(true);
    expect(message).toContain('Заполните до подписания');
    expect(message).toContain('Статус: ожидает проверки');
  });

  test('NDA заполнено полностью: маркеров и пункта «Не заполнено» нет', async () => {
    const document = bareContract({
      lines: [],
      total: 0,
      templateFields: {
        seller_representative: 'директора Иванова И. И.',
        seller_position: 'директор',
        seller_authority_basis: 'Устава',
        nda_penalty_amount: '50000',
        contract_number: '15/26',
        contract_date: '2026-10-01',
      },
    });
    const out = await handoffForReview.execute({ templatePath: NDA, document }, deps, CTX);
    expect(deps.renderer.lastText).not.toContain(GAP_MARKER_PREFIX);
    expect(out.checklist.some((item) => item.label === 'Не заполнено')).toBe(false);
  });

  test('нет позиций и суммы: вместо нуля маркеры, строка таблицы из маркеров', async () => {
    const mgReady = CONTRACT_TEMPLATES.find((t) => t.id === 'mg_ready')?.fileName ?? '';
    await fillTemplate.execute(
      { templatePath: mgReady, document: bareContract({ lines: [], total: 0 }) },
      deps,
      CTX,
    );
    const text = deps.renderer.lastText;
    expect(text).not.toContain('{{');
    expect(text).toContain(`total_rubles: ${gapMarker('общая сумма, рубли')}`);
    expect(text).toContain(gapMarker('наименование позиции'));
  });

  test('недопустимый ключ templateFields: предупреждение, договор собран', async () => {
    const mgReady = CONTRACT_TEMPLATES.find((t) => t.id === 'mg_ready')?.fileName ?? '';
    const document = bareContract({ templateFields: { seller_inn: '1' } });
    const out = await fillTemplate.execute({ templatePath: mgReady, document }, deps, CTX);
    expect(out.fileName).toContain('.docx');
    expect(out.unfilled.join(' ')).toContain('seller_inn');
    expect(out.unfilled.join(' ')).toContain('не учтены');
  });

  test('недопустимый ключ requisites: предупреждение в результате saveDocument', async () => {
    const mgReady = CONTRACT_TEMPLATES.find((t) => t.id === 'mg_ready')?.fileName ?? '';
    const document = bareContract({ requisites: { payment_terms: 'x' } });
    const out = await saveDocument.execute({ templatePath: mgReady, document }, deps, CTX);
    expect(out.delivered).toBe(true);
    expect(out.unfilled.join(' ')).toContain('payment_terms');
  });
});

describe('договор при минимуме данных: только юрлицо, вид и контрагент', () => {
  test('без заявки, КП, номера, срока, НДС и подписанта договор выдан с маркерами', async () => {
    const templatePath = CONTRACT_TEMPLATES.find((t) => t.id === 'mg_ready')?.fileName ?? '';
    const prepared = await prepareSupplierDocument.execute(
      { kind: 'contract', supplierId: FULL_SUPPLIER.id, templatePath },
      deps,
      CTX,
    );
    expect(prepared.ready).toBe(true);
    // Заявку и прочие данные у сотрудника не спрашиваем: это пропуски, а не вопросы.
    expect(prepared.questions.join(' ')).not.toContain('спросите');
    const document = withSources(prepared.document ?? bareContract(), 'knowledge');
    const out = await handoffForReview.execute({ templatePath, document }, deps, CTX);
    expect(out.status).toBe('awaiting_review');
    const text = deps.renderer.lastText;
    expect(text).not.toContain('{{');
    expect(text).toContain(gapMarker('срок поставки'));
    expect(text).toContain('payment_variant: unset');
    expect(text).toContain('payment_variant__gap: [ЗАПОЛНИТЬ: условия оплаты');
    expect(text).toContain('delivery_variant__gap: [ЗАПОЛНИТЬ: способ передачи товара');
    expect(text).toContain(gapMarker('срок изготовления'));
    expect(out.checklist.some((item) => item.label === 'Не заполнено')).toBe(true);
  });
});

describe('вариант оплаты и передачи не назван: служебное unset и абзац-маркер', () => {
  const readyFileName = CONTRACT_TEMPLATES.find((t) => t.id === 'mg_ready')?.fileName ?? '';
  const withVariants = (fields: Record<string, string>): RenderData => ({
    fields: { vat_rate: '22', ...fields },
    lists: {},
  });

  test('пропуск: unset, текст маркера в __gap, зависимые поля - маркеры, вопрос остался', () => {
    const { data, gaps } = fillTemplateGaps(readyFileName, withVariants({}), {});
    expect(data.fields['payment_variant']).toBe(VARIANT_UNSET_VALUE);
    expect(data.fields['delivery_variant']).toBe(VARIANT_UNSET_VALUE);
    expect(String(data.fields['payment_variant__gap'])).toStartWith('[ЗАПОЛНИТЬ: условия оплаты');
    expect(String(data.fields['delivery_variant__gap'])).toStartWith(
      '[ЗАПОЛНИТЬ: способ передачи товара',
    );
    for (const label of ['prepayment_percent', 'final_payment_percent', 'delivery_address']) {
      expect(String(data.fields[label])).toStartWith(GAP_MARKER_PREFIX);
    }
    const labels = gaps.map((gap) => gap.label);
    expect(labels).toContain('payment_variant');
    expect(labels).toContain('delivery_variant');
    expect(labels).not.toContain('payment_variant__gap');
  });

  test('вариант назван: значения как есть, служебных ключей нет', () => {
    const named = withVariants({
      payment_variant: 'prepay',
      prepayment_percent: '100',
      final_payment_percent: '0',
      delivery_variant: 'pickup',
      delivery_address: '—',
    });
    const { data, gaps } = fillTemplateGaps(readyFileName, named, {});
    expect(data.fields['payment_variant']).toBe('prepay');
    expect(data.fields['delivery_variant']).toBe('pickup');
    expect(data.fields['payment_variant__gap']).toBeUndefined();
    expect(data.fields['delivery_variant__gap']).toBeUndefined();
    expect(gaps.map((gap) => gap.label)).not.toContain('payment_variant');
  });
});
