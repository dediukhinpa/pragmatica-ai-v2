import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryIdempotencyStore,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { checkDocument } from '../../src/agents/documents/checks';
import { classifySupplierDocument } from '../../src/agents/documents/supplier-checks';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { handoffForReview } from '../../src/agents/documents/handoff-for-review';
import { saveDocument } from '../../src/agents/documents/save-document';
import { validateDocument } from '../../src/agents/documents/validate-document';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import {
  dealDocumentSchema,
  type DealDocument,
  type SupplierQuote,
} from '../../src/kit/domain/models';
import { supplierDocumentSigns } from '../../src/kit/domain/supplier-document';
import { ACCOUNT, CORR, FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { CREATED_AT, CTX, MODEL_ALIAS, OWN_COMPANY, toolMessages, withSources } from './support';

/** Чужой расчётный счёт, который инъекция в письме поставщика просит вписать в договор. */
const FOREIGN_ACCOUNT = '40702810900000000099';
/** ИНН с неверной контрольной суммой из теста «неверная контрольная сумма реквизита». */
const INVALID_CHECKSUM_INN = '1234567890';
// В исходном репозитории (коммит 3cebe14) перечень этого ИНН не содержал, и тест падал на
// инварианте серий цифр (support/setup.ts): серия здесь - содержимое документа, не идентификатор.
const DIGITS = [
  FULL_SUPPLIER.inn ?? '',
  FULL_SUPPLIER.ogrn ?? '',
  ACCOUNT,
  CORR,
  FOREIGN_ACCOUNT,
  INVALID_CHECKSUM_INN,
];
const TEMPLATE = 'templates/Договор поставки.docx';
const TEMPLATE_TEXT = 'Договор {{number}}\nПоставщик {{seller}}\nИтого {{total}} {{currency}}';

type Deps = DocumentsDeps & { chat: MemoryChatChannel };

const QUOTE: SupplierQuote = {
  id: 'quote:req-1:s1',
  requestId: 'req-1',
  supplierId: 's1',
  currency: 'RUB',
  receivedAt: CREATED_AT,
  paymentTerms: '50% предоплата',
  deliveryDays: 7,
  gaps: [],
  lines: [{ productName: 'Болт М8', unitPrice: 12, quantity: 10 }],
};

/** Документ «под влиянием инъекции»: цена не из КП, чужой счёт, поставщик не указан. */
const INJECTED: DealDocument = withSources({
  id: 'doc-x',
  kind: 'contract',
  number: 'Д-1',
  buyer: 'ООО Кто угодно',
  seller: FULL_SUPPLIER.name,
  lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 99 }],
  total: 990,
  currency: 'RUB',
  issuedAt: '2026-01-05T00:00:00.000Z',
  requisites: { settlementAccount: FOREIGN_ACCOUNT },
});

let deps: Deps;

beforeEach(async () => {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert(FULL_SUPPLIER);
  const files = new MemoryFileSource();
  files.put(TEMPLATE, new TextEncoder().encode(TEMPLATE_TEXT), 1_000);
  const quotes = new MemorySupplierQuoteRepository();
  await quotes.save(QUOTE);
  deps = {
    files,
    knowledge: new MemoryKnowledgeSearch(new Map()),
    renderer: new MemoryDocumentRenderer(),
    suppliers,
    chat: new MemoryChatChannel(),
    ownCompanyNames: [OWN_COMPANY],
    quotes,
    state: new MemoryWorkflowStateStore(),
    clock: new FixedClock(),
  };
});

/** Прогон агента: модель сразу зовёт инструмент выпуска с подготовленным документом. */
async function runTool(tool: string, document: DealDocument): Promise<string> {
  const declaration = createDocumentsAgent({ model: MODEL_ALIAS });
  const { gateway, runtime, spec } = scriptedRuntime(
    declaration,
    deps,
    [callTool('c1', tool, { templatePath: TEMPLATE, document }), say('готово')],
    {
      gateway: { contentDigitSeries: DIGITS },
      runtime: { idempotency: new MemoryIdempotencyStore() },
    },
  );
  await runtime.run(spec, 't1', 'выпусти документ');
  return toolMessages(gateway.requests[1]).join('');
}

/** Варианты обхода при тех же данных в теле документа (продавец-поставщик, цена не из КП). */
const BYPASS_VARIANTS: Array<[string, DealDocument]> = [
  ['договор без supplierId (D-1)', INJECTED],
  ['смена вида на счёт', { ...INJECTED, kind: 'invoice' }],
  [
    'смена вида на КП и пустые реквизиты',
    { ...INJECTED, kind: 'commercial_offer', requisites: {} },
  ],
  ['без реквизитов вовсе', { ...INJECTED, kind: 'invoice', requisites: undefined }],
  ['закрывающий документ', { ...INJECTED, kind: 'closing', requisites: undefined }],
  [
    'договор «от своего юрлица», реквизиты чужие',
    { ...INJECTED, seller: OWN_COMPANY, buyer: 'ООО Кто угодно' },
  ],
  [
    'поставщик записан покупателем',
    {
      ...INJECTED,
      kind: 'invoice',
      requisites: undefined,
      seller: OWN_COMPANY,
      buyer: 'МеталлТорг',
    },
  ],
  [
    'продавец с другим регистром и пробелами',
    { ...INJECTED, kind: 'invoice', requisites: undefined, seller: '  металлторг ' },
  ],
];

describe('D-1: документ с поставщиком выдаётся с предупреждениями', () => {
  for (const [title, document] of BYPASS_VARIANTS) {
    test(`${title}: saveDocument выдаёт файл и предупреждает use_handoff_for_review`, async () => {
      const reply = await runTool('saveDocument', document);
      expect(reply).toContain('use_handoff_for_review');
      expect(reply).not.toContain('blocked');
      expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
    });

    test(`${title}: handoffForReview выдаёт чек-лист с предупреждениями`, async () => {
      const reply = await runTool('handoffForReview', document);
      expect(reply).not.toContain('blocked');
      expect(reply).toContain('not_supplier_document');
      expect(reply).toContain('"topic":"warnings"');
      expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
    });
  }

  test('прямой вызов saveDocument без валидаторов выдаёт файл', async () => {
    const input = { templatePath: TEMPLATE, document: INJECTED };
    const out = await saveDocument.execute(input, deps, CTX);
    expect(out.delivered).toBe(true);
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('арифметика не блокирует: итог не равен сумме строк - выдача и предупреждение', async () => {
    const wrong = { ...INJECTED, total: 1 };
    const saved = await runTool('saveDocument', wrong);
    expect(saved).toContain('total_mismatch');
    expect(saved).not.toContain('blocked');
    const handoff = await runTool('handoffForReview', wrong);
    expect(handoff).not.toContain('blocked');
    expect(handoff).toContain('total_mismatch');
    // В чек-листе передачи расхождение суммы тоже есть.
    expect(handoff).toContain('"topic":"warnings"');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(2);
  });

  test('прямой вызов handoffForReview с расхождениями: чек-лист несёт предупреждения', async () => {
    const document = { ...INJECTED, supplierId: 's1', requestId: 'req-1' };
    const out = await handoffForReview.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    const warnings = out.checklist.filter((item) => item.topic === 'warnings');
    const text = warnings.map((item) => item.value).join('\n');
    // Расхождение с КП видно в чек-листе: «в документе 99, в КП 12».
    expect(text).toContain('цена в документе 99, в КП 12');
    expect(text).toContain('Покупатель в документе с поставщиком - не наше юрлицо');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('чужой счёт вносится с предупреждением, значение карточки в чек-листе', async () => {
    const document = { ...INJECTED, supplierId: 's1', requestId: 'req-1' };
    const out = await handoffForReview.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    const note = 'внесено со слов сотрудника, отличается от карточки поставщика';
    const account = out.checklist.find(
      (item) => item.topic === 'requisites' && item.value.includes(FOREIGN_ACCOUNT),
    );
    // Источник пункта подменяет код и называет значение карточки.
    expect(account?.source).toBe(`${note} (в карточке: ${ACCOUNT})`);
    const warnings = out.checklist.filter((item) => item.topic === 'warnings');
    expect(warnings.map((item) => item.value).join('\n')).toContain(note);
    // Цифры реквизитов модели не отдаём: в message только пометка «из карточки».
    const text = out.message;
    expect(text).toContain('(в карточке: [из карточки])');
    expect(text).toContain('сверьте с первичными документами');
    expect(text).not.toMatch(/\d{10,}/);
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('с supplierId, но чужим счётом, ценой не из КП и чужим покупателем: замечания', async () => {
    const codes = (
      await checkDocument({ ...INJECTED, supplierId: 's1', requestId: 'req-1' }, deps)
    ).map((issue) => issue.code);
    expect(codes).toContain('requisite_mismatch');
    expect(codes).toContain('price_differs_from_quote');
    expect(codes).toContain('buyer_not_own_company');
  });

  test('реквизит, которого нет в базе, идёт с предупреждением; чужое поле не подставляется', async () => {
    await deps.suppliers.upsert({ ...FULL_SUPPLIER, settlementAccount: undefined });
    const codes = (
      await checkDocument({ ...INJECTED, supplierId: 's1', requestId: 'req-1' }, deps)
    ).map((issue) => issue.code);
    expect(codes).toContain('requisite_not_in_base');
    const unknownField = { ...INJECTED, supplierId: 's1', requisites: { secondAccount: '1' } };
    expect((await checkDocument(unknownField, deps)).map((issue) => issue.code)).toContain(
      'requisite_not_in_base',
    );
  });

  test('validateDocument-проверки требуют supplierId, если признаки определил код', async () => {
    const codes = (await checkDocument(INJECTED, deps)).map((issue) => issue.code);
    expect(codes).toContain('supplier_id_required');
  });

  test('КП клиенту от своего юрлица по-прежнему выпускается', async () => {
    const offer: DealDocument = {
      ...INJECTED,
      kind: 'commercial_offer',
      seller: `  ${OWN_COMPANY.toUpperCase()} `,
      buyer: 'ООО Заказчик',
      requisites: undefined,
    };
    expect(await classifySupplierDocument(offer, deps)).toEqual([]);
    await runTool('saveDocument', offer);
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });
});

describe('supplierDocumentSigns', () => {
  const own = [OWN_COMPANY];
  const base: DealDocument = { ...INJECTED, kind: 'invoice', seller: OWN_COMPANY, requisites: {} };

  test('признаки определяет код: вид, поставщик, реквизиты, чужой продавец', () => {
    expect(supplierDocumentSigns(base, own)).toEqual([]);
    expect(supplierDocumentSigns({ ...base, kind: 'contract' }, own)).toEqual(['kind']);
    expect(supplierDocumentSigns({ ...base, kind: 'closing' }, own)).toEqual(['kind']);
    expect(supplierDocumentSigns({ ...base, supplierId: 's1' }, own)).toEqual(['supplier_id']);
    expect(supplierDocumentSigns({ ...base, requisites: { inn: '1' } }, own)).toEqual([
      'requisites',
    ]);
    expect(supplierDocumentSigns({ ...base, seller: 'ООО Другое' }, own)).toEqual([
      'seller_not_own',
    ]);
  });

  test('пустые значения реквизитов не считаются, похожее латиницей название - чужое', () => {
    expect(supplierDocumentSigns({ ...base, requisites: { inn: '  ' } }, own)).toEqual([]);
    // «OOO» латиницей: не наше юрлицо, документ идёт по строгому пути.
    expect(supplierDocumentSigns({ ...base, seller: 'OOO Прагматика' }, own)).toEqual([
      'seller_not_own',
    ]);
    expect(supplierDocumentSigns({ ...base, seller: 'ООО  прагматика' }, own)).toEqual([]);
  });
});

describe('Решение 03.11: пропуски, расхождения, суммы и веб-данные - предупреждения', () => {
  /** Договор без поставщика из базы и без КП: сторон в базе нет, заявки нет. */
  const BARE: DealDocument = withSources({
    id: 'doc-bare',
    kind: 'contract',
    number: '',
    buyer: OWN_COMPANY,
    seller: 'ООО Новый контрагент',
    lines: [],
    total: 0,
    currency: 'RUB',
    issuedAt: '2026-01-05',
  });

  test('договор без поставщика из базы и без КП выдан с предупреждениями', async () => {
    const reply = await runTool('handoffForReview', BARE);
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('"topic":"warnings"');
    expect(reply).toContain('supplier_id_required');
    expect(reply).toContain('no_lines');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('расхождение сумм: выдача и предупреждение в чек-листе', async () => {
    const reply = await runTool('handoffForReview', { ...BARE, lines: INJECTED.lines, total: 1 });
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('total_mismatch');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('расхождение НДС: выдача и предупреждение', async () => {
    const wrongVat = { ...INJECTED, vatRate: 20, vatAmount: 1 };
    const reply = await runTool('saveDocument', wrongVat);
    expect(reply).toContain('vat_mismatch');
    expect(reply).not.toContain('blocked');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('неверная контрольная сумма реквизита: выдача и предупреждение в чек-листе', async () => {
    const reply = await runTool('handoffForReview', { ...BARE, requisites: { inn: '1234567890' } });
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('requisite_invalid');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('supplierId не найден в базе: выдача и предупреждение supplier_not_found', async () => {
    const reply = await runTool('handoffForReview', { ...BARE, supplierId: 'нет-такого' });
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('supplier_not_found');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('значение из интернета без подтверждения: выдача и предупреждение', async () => {
    const web: DealDocument = {
      ...BARE,
      paymentTerms: '30 дней',
      fieldSources: { ...BARE.fieldSources, paymentTerms: 'web' },
    };
    const reply = await runTool('handoffForReview', web);
    expect(reply).toContain('web_fields_unconfirmed');
    expect(reply).not.toContain('blocked');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('без отметок источника: выдан с предупреждением field_source_missing', async () => {
    const reply = await runTool('handoffForReview', { ...BARE, fieldSources: undefined });
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('field_source_missing');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('пустые номер, стороны, позиции и дата получают значения по умолчанию', () => {
    const parsed = dealDocumentSchema.parse({ id: 'x', kind: 'contract' });
    expect(parsed).toMatchObject({
      number: '',
      buyer: '',
      seller: '',
      lines: [],
      total: 0,
      currency: '',
      issuedAt: '',
    });
  });

  test('документ почти без полей и без валюты выдан, id не нужен', async () => {
    const minimal = { kind: 'contract' as const, supplierId: 's1' };
    const reply = await runTool('handoffForReview', minimal as DealDocument);
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('missing_field');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('validateDocument: предупреждения не мешают ok, дата по умолчанию - сегодня', async () => {
    const out = await validateDocument.execute(
      { document: dealDocumentSchema.parse({ id: 'x', kind: 'contract', currency: 'RUB' }) },
      deps,
      CTX,
    );
    expect(out.ok).toBe(true);
    const severities = Object.fromEntries(out.issues.map((i) => [i.code, i.severity]));
    expect(severities['missing_field']).toBe('warning');
    expect(severities['no_lines']).toBe('warning');
    // Дату не назвали: bad_date нет, берётся «сегодня» по часам зависимостей.
    expect(out.issues.map((i) => i.code)).not.toContain('bad_date');
    // Пустая валюта - тоже предупреждение, а не блокировка; значение не подставляется.
    const noCurrency = await validateDocument.execute(
      { document: dealDocumentSchema.parse({ id: 'x', kind: 'contract' }) },
      deps,
      CTX,
    );
    expect(noCurrency.ok).toBe(true);
    const missing = noCurrency.issues.filter((i) => i.code === 'missing_field');
    expect(missing.map((i) => i.message).join(' ')).toContain('currency');
  });
});
