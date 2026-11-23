import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FixedClock,
  MemoryChatChannel,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryIdempotencyStore,
  MemoryWebSearch,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { REVIEW_NAMESPACE, type DocumentsDeps } from '../../src/agents/documents/deps';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { checkSupplierDocument } from '../../src/agents/documents/supplier-checks';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { getSelectedQuote } from '../../src/agents/documents/get-selected-quote';
import { getSupplierRequisites } from '../../src/agents/documents/get-supplier-requisites';
import { handoffForReview, handoffKey } from '../../src/agents/documents/handoff-for-review';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { searchInternetForDocuments } from '../../src/agents/documents/search-internet';
import { supplierDocumentViaHandoffValidator } from '../../src/agents/documents/save-document';
import { buildRenderData } from '../../src/agents/documents/render-data';
import type { DealDocument, SupplierQuote } from '../../src/kit/domain/models';
import type { ModelRequest } from '@business-ai/core';
import { ACCOUNT, CORR, FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { callTool, say, scriptedRuntime, type Step } from '../kit/adapters/mastra/support';
import {
  CREATED_AT,
  CTX,
  MODEL_ALIAS,
  OWN_COMPANY,
  pressWebConfirm,
  toolMessages,
} from './support';

const REVIEWER = 'reviewer-thread';
const REQUISITE_DIGITS = [FULL_SUPPLIER.inn ?? '', FULL_SUPPLIER.ogrn ?? '', ACCOUNT, CORR];
const TEMPLATE = 'templates/Договор поставки.docx';
const TEMPLATE_TEXT =
  'Договор {{number}}\nПоставщик {{seller}}, ИНН {{seller_inn}}, КПП {{seller_kpp}}\n' +
  'Оплата: {{paymentTerms}}. Срок: {{deliveryDays}}\n' +
  '{{items.name}} {{items.quantity}} {{items.sum}}\n' +
  'Итого {{total}} {{currency}}';

type Deps = DocumentsDeps & {
  chat: MemoryChatChannel;
  state: MemoryWorkflowStateStore;
  clock: FixedClock;
  suppliers: MemorySupplierRepository;
  files: MemoryFileSource;
};

const QUOTE: SupplierQuote = {
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
};

let deps: Deps;

async function build(supplier = FULL_SUPPLIER, quote: SupplierQuote | null = QUOTE): Promise<Deps> {
  const suppliers = new MemorySupplierRepository();
  await suppliers.upsert(supplier);
  const files = new MemoryFileSource();
  files.put(TEMPLATE, new TextEncoder().encode(TEMPLATE_TEXT), 1_000);
  const state = new MemoryWorkflowStateStore();
  const quotes = new MemorySupplierQuoteRepository();
  if (quote !== null) await quotes.save(quote);
  const result = {
    files,
    knowledge: new MemoryKnowledgeSearch(new Map()),
    renderer: new MemoryDocumentRenderer(),
    suppliers,
    chat: new MemoryChatChannel(),
    ownCompanyNames: [OWN_COMPANY],
    quotes,
    state,
    clock: new FixedClock(),
    reviewerThreadId: REVIEWER,
  };
  return result;
}

const PREPARE = {
  kind: 'contract' as const,
  requestId: 'req-1',
  supplierId: 's1',
  number: 'Д-1',
  issuedAt: '2026-01-05T00:00:00.000Z',
};

async function readyDocument(): Promise<DealDocument> {
  const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
  if (out.document === undefined) throw new Error(out.questions.join('; '));
  return out.document;
}

beforeEach(async () => {
  deps = await build();
});

describe('getSupplierRequisites / getSelectedQuote', () => {
  test('реквизиты полные; неполные — перечень недостающего, поставщик не найден', async () => {
    const full = await getSupplierRequisites.execute({ supplierId: 's1' }, deps, CTX);
    expect(full).toMatchObject({ found: true, complete: true, missing: [] });
    expect(full.requisites['inn']).toBe('7707083893');
    await deps.suppliers.upsert({ id: 's2', name: 'Без реквизитов', inn: '7707083893' });
    const partial = await getSupplierRequisites.execute({ supplierId: 's2' }, deps, CTX);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toContain('БИК');
    expect((await getSupplierRequisites.execute({ supplierId: 'нет' }, deps, CTX)).found).toBe(
      false,
    );
  });

  test('условия выбранного КП; нет КП — found=false', async () => {
    const quote = await getSelectedQuote.execute(
      { requestId: 'req-1', supplierId: 's1' },
      deps,
      CTX,
    );
    expect(quote).toMatchObject({
      found: true,
      total: 120,
      paymentTerms: '50% предоплата',
      expired: false,
    });
    const none = await getSelectedQuote.execute(
      { requestId: 'req-1', supplierId: 's9' },
      deps,
      CTX,
    );
    expect(none.found).toBe(false);
  });
});

describe('prepareSupplierDocument', () => {
  test('собирает документ из базы и КП, числа и реквизиты берёт код', async () => {
    const doc = await readyDocument();
    expect(doc).toMatchObject({
      seller: 'МеталлТорг',
      buyer: OWN_COMPANY,
      total: 120,
      currency: 'RUB',
      paymentTerms: '50% предоплата',
      supplierId: 's1',
    });
    expect(doc.requisites?.['bik']).toBe('044525225');
    const file = await fillTemplate.execute({ templatePath: TEMPLATE, document: doc }, deps, CTX);
    expect(file.sizeBytes).toBeGreaterThan(0);
  });

  test('реквизиты поставщика неполные: документ собран, вопросы в предупреждениях', async () => {
    deps = await build({ id: 's1', name: 'МеталлТорг', inn: '7707083893' });
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    expect(out.ready).toBe(true);
    expect(out.document?.seller).toBe('МеталлТорг');
    expect(out.questions.join('\n')).toContain('БИК');
  });

  test('нет заявки и КП: документ собран из имеющегося, вопросы названы', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const noRequest = await prepareSupplierDocument.execute(
      { ...PREPARE, requestId: undefined },
      deps,
      CTX,
    );
    expect(noRequest.ready).toBe(true);
    expect(noRequest.document).toMatchObject({ lines: [], total: 0, supplierId: 's1' });
    expect(noRequest.questions.join('\n')).toContain('Заявка с выбранным КП');
    const noQuote = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    expect(noQuote.ready).toBe(true);
    expect(noQuote.questions.join('\n')).toContain('не найдено');
  });

  test('КП нет, в КП нет условий оплаты или замена позиции — вопросы', async () => {
    deps = await build(FULL_SUPPLIER, null);
    expect((await prepareSupplierDocument.execute(PREPARE, deps, CTX)).questions[0]).toContain(
      'КП',
    );
    const thin: SupplierQuote = {
      ...QUOTE,
      paymentTerms: undefined,
      gaps: [{ code: 'no_payment_terms' }],
      lines: [...QUOTE.lines, { productName: 'Гайка', unitPrice: 1, isReplacement: true }],
    };
    deps = await build(FULL_SUPPLIER, thin);
    const out = await prepareSupplierDocument.execute(PREPARE, deps, CTX);
    expect(out.ready).toBe(true);
    expect(out.document?.paymentTerms).toBeUndefined();
    expect(out.questions.join('\n')).toContain('нет условий оплаты');
    expect(out.questions.join('\n')).toContain('замену');
  });
});

describe('устаревшее поле dealRef в шаблоне', () => {
  const DEAL_TEMPLATE = 'templates/Старый договор.docx';
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  beforeEach(() => {
    const text = `${TEMPLATE_TEXT}\nСделка {{dealRef}}`;
    deps.files.put(DEAL_TEMPLATE, new TextEncoder().encode(text), 1_000);
  });

  test('есть заявка: подставлен номер заявки, пометка в чек-листе без ошибки', async () => {
    const document = await readyDocument();
    const file = await deps.renderer.render({
      template: { kind: 'bytes', content: new TextEncoder().encode('{{dealRef}}|{{requestId}}') },
      data: buildRenderData(document),
      outputName: 'x.txt',
    });
    expect(decode(file.content)).toBe('req-1|req-1');
    const out = await handoffForReview.execute(
      { templatePath: DEAL_TEMPLATE, document },
      deps,
      CTX,
    );
    const note = out.checklist.find((item) => item.value.includes('dealRef'));
    expect(note?.value).toBe('в шаблоне устаревшее поле dealRef');
    expect(out.message).toContain('в шаблоне устаревшее поле dealRef');
  });

  test('заявки нет: пустая строка, не ошибка незаполненного поля', async () => {
    const document = { ...(await readyDocument()) };
    delete document.requestId;
    const data = buildRenderData(document);
    expect(data.fields['dealRef']).toBe('');
    const file = await deps.renderer.render({
      template: { kind: 'bytes', content: new TextEncoder().encode('Сделка [{{dealRef}}]') },
      data,
      outputName: 'x.txt',
    });
    expect(decode(file.content)).toBe('Сделка []');
  });

  test('шаблон без dealRef: пометки в чек-листе нет', async () => {
    const out = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: await readyDocument() },
      deps,
      CTX,
    );
    expect(out.checklist.some((item) => item.value.includes('dealRef'))).toBe(false);
  });
});

describe('handoffForReview', () => {
  test('файл, чек-лист и статус «ожидает проверки»; подписанным не помечается', async () => {
    const document = await readyDocument();
    const out = await handoffForReview.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    expect(out.status).toBe('awaiting_review');
    // В чат уходит один файл без текста; чек-лист приходит модели в message.
    expect(deps.chat.outbox).toHaveLength(1);
    expect(deps.chat.outbox.filter((o) => o.message !== undefined)).toHaveLength(0);
    const file = deps.chat.outbox.find((o) => o.file !== undefined);
    expect(file?.threadId).toBe(REVIEWER);
    expect(new TextDecoder().decode(file?.file?.content)).toContain('ИНН 7707083893');
    const text = out.message;
    expect(text).toContain('Статус: ожидает проверки');
    expect(text).toContain('не подписан и не согласован');
    for (const section of ['Реквизиты:', 'Суммы:', 'Сроки:', 'Условия оплаты:']) {
      expect(text).toContain(section);
    }
    expect(text).toContain('Итого: 120 RUB (источник: КП поставщика)');
    // Цифры реквизитов модели не отдаём: только название и пометка «из карточки».
    expect(text).toContain('ИНН: [из карточки] (источник: карточка поставщика в базе)');
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).toContain('Файл отправлен без подписи. В итоговом ответе скажи сам');
    const [saved] = await deps.state.list(REVIEW_NAMESPACE, null, 10);
    const status = saved?.value;
    expect(status).toMatchObject({ status: 'awaiting_review', requestId: 'req-1' });
    // Сделки в CRM нет: результат - файл в чат и чек-лист модели.
    expect(text).not.toContain('сделк');
  });

  test('передача на проверку один раз на один документ', async () => {
    const document = await readyDocument();
    const input = { templatePath: TEMPLATE, document };
    await handoffForReview.execute(input, deps, CTX);
    await handoffForReview.execute(input, deps, CTX);
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
    expect(deps.chat.outbox.filter((o) => o.message !== undefined)).toHaveLength(0);
    // Изменённый документ — другая операция.
    expect(handoffKey({ ...input, document: { ...document, number: 'Д-2' } })).not.toBe(
      handoffKey(input),
    );
  });

  test('R4-AGT-6: без ревьюера передача из другого треда доходит и в этот тред', async () => {
    delete deps.reviewerThreadId;
    const input = { templatePath: TEMPLATE, document: await readyDocument() };
    await handoffForReview.execute(input, deps, CTX);
    const other = { ...CTX, threadId: 'other-dialog' };
    const out = await handoffForReview.execute(input, deps, other);
    expect(out.sentToThreadId).toBe('other-dialog');
    const files = deps.chat.outbox.filter((o) => o.file !== undefined);
    expect(files.map((o) => o.threadId)).toEqual([CTX.threadId, 'other-dialog']);
  });

  test('без заданного ревьюера файл уходит в тред диалога', async () => {
    delete deps.reviewerThreadId;
    await handoffForReview.execute(
      { templatePath: TEMPLATE, document: await readyDocument() },
      deps,
      CTX,
    );
    expect(deps.chat.outbox[0]?.threadId).toBe(CTX.threadId);
  });
});

describe('валидаторы документа с поставщиком', () => {
  const issuesFor = async (document: DealDocument) =>
    (await checkSupplierDocument(document, deps)).map((i) => i.code);

  test('сумма в договоре расходится с КП', async () => {
    const document = await readyDocument();
    const wrong = {
      ...document,
      lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 15 }],
      total: 150,
    };
    expect(await issuesFor(wrong)).toEqual([
      'price_differs_from_quote',
      'total_differs_from_quote',
    ]);
  });

  test('реквизит не совпал с базой, поставщика или КП нет, заявки нет', async () => {
    const document = await readyDocument();
    expect(
      await issuesFor({ ...document, requisites: { ...document.requisites, inn: '1' } }),
    ).toEqual(['requisite_mismatch']);
    expect(await issuesFor({ ...document, supplierId: 'нет' })).toEqual(['supplier_not_found']);
    expect(await issuesFor({ ...document, requestId: 'req-9' })).toEqual(['quote_not_found']);
    // У поставщика есть КП, а заявка не названа: предупреждение о несверенных суммах.
    expect(await issuesFor({ ...document, requestId: undefined })).toEqual([
      'quote_reconcile_required',
    ]);
    // КП у поставщика нет вовсе: КП необязательно, позиции и суммы с КП не сверяются.
    deps = await build(FULL_SUPPLIER, null);
    expect(await issuesFor({ ...document, requestId: undefined })).toEqual([]);
  });

  test('saveDocument для документа с поставщиком: предупреждение, а не отказ', async () => {
    const document = await readyDocument();
    const input = { templatePath: TEMPLATE, document };
    expect(
      (await supplierDocumentViaHandoffValidator.validate(input, deps, CTX)).map((i) => i.code),
    ).toEqual(['use_handoff_for_review']);
    // Тот же договор без supplierId: вид и реквизиты определяет код, предупреждение остаётся (D-1).
    const { supplierId: _s, ...plain } = document;
    expect(
      (
        await supplierDocumentViaHandoffValidator.validate(
          { templatePath: TEMPLATE, document: plain },
          deps,
          CTX,
        )
      ).map((i) => i.code),
    ).toEqual(['use_handoff_for_review']);
  });
});

describe('агент «Подготовка документов (ИИ агент)»: договор с поставщиком', () => {
  type StepFn = (request: ModelRequest) => Step;
  function run(steps: Array<Step | StepFn>, idempotency = new MemoryIdempotencyStore()) {
    const declaration = createDocumentsAgent({ model: MODEL_ALIAS });
    return scriptedRuntime(
      declaration,
      deps,
      (request, call) => {
        const step = steps[call] ?? say('конец');
        return typeof step === 'function' ? step(request) : step;
      },
      {
        // Реквизиты поставщика - содержимое, а не идентификаторы; в бою их прячет псевдонимизация.
        gateway: { contentDigitSeries: REQUISITE_DIGITS },
        runtime: { idempotency },
      },
    );
  }
  const documentFromPrepare = (request: ModelRequest): DealDocument => {
    const last = toolMessages(request).at(-1) ?? '{}';
    return (JSON.parse(last) as { document: DealDocument }).document;
  };

  test('реквизиты неполные: документ собран, вопросы названы, ничего не выпущено', async () => {
    deps = await build({ id: 's1', name: 'МеталлТорг', inn: '7707083893' });
    const { gateway, runtime, spec } = run([
      callTool('c1', 'getSupplierRequisites', { supplierId: 's1' }),
      callTool('c2', 'prepareSupplierDocument', PREPARE),
      say('Не хватает реквизитов поставщика: уточните БИК и счета'),
    ]);
    const result = await runtime.run(spec, 't1', 'Подготовь договор с поставщиком s1');
    expect(result.status).toBe('completed');
    expect(toolMessages(gateway.requests[1]).join('')).toContain('"complete":false');
    const prepared = toolMessages(gateway.requests[2]).join('');
    expect(prepared).toContain('"ready":true');
    expect(prepared).toContain('БИК');
    expect(deps.chat.outbox).toHaveLength(0);
    expect(await deps.state.list(REVIEW_NAMESPACE, null, 10)).toEqual([]);
  });

  test('передача с неполными реквизитами: уходит, пробел виден в предупреждениях', async () => {
    const document = await readyDocument();
    deps = await build({ id: 's1', name: 'МеталлТорг', inn: '7707083893' });
    const { gateway, runtime, spec } = run([
      callTool('c1', 'handoffForReview', { templatePath: TEMPLATE, document }),
      say('передано'),
    ]);
    await runtime.run(spec, 't1', 'передай договор');
    const reply = toolMessages(gateway.requests[1]).join('');
    expect(reply).not.toContain('blocked');
    expect(reply).toContain('requisite_missing');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('сумма в договоре расходится с КП: передача идёт, расхождение в warnings', async () => {
    const document = await readyDocument();
    const wrong = { ...document, total: 999 };
    const { gateway, runtime, spec } = run([
      callTool('c1', 'handoffForReview', { templatePath: TEMPLATE, document: wrong }),
      say('сумма не сходится'),
    ]);
    await runtime.run(spec, 't1', 'передай договор');
    const reply = toolMessages(gateway.requests[1]).join('');
    expect(reply).toContain('total_differs_from_quote');
    expect(reply).not.toContain('blocked');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('полный путь и повторный запуск: на проверку уходит один раз', async () => {
    const idempotency = new MemoryIdempotencyStore();
    const script: Array<Step | StepFn> = [
      callTool('c1', 'prepareSupplierDocument', PREPARE),
      (request) =>
        callTool('c2', 'handoffForReview', {
          templatePath: TEMPLATE,
          document: documentFromPrepare(request),
        }),
      say('Передано на проверку'),
    ];
    for (const thread of ['t1', 't2']) {
      const { runtime, spec } = run(script, idempotency);
      const result = await runtime.run(spec, thread, 'договор с s1');
      expect(result.status).toBe('completed');
    }
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
    const states = await deps.state.list(REVIEW_NAMESPACE, null, 10);
    expect(states.map((s) => (s.value as { status: string }).status)).toEqual(['awaiting_review']);
  });
});

describe('источники данных документа с поставщиком (без сделки)', () => {
  /** Документ, который сотрудник продиктовал в чате: КП нет, реквизиты из карточки. */
  async function chatDocument(): Promise<DealDocument> {
    const prepared = await prepareSupplierDocument.execute(PREPARE, await build(), CTX);
    const base = prepared.document as DealDocument;
    const { requestId: _r, ...rest } = base;
    return {
      ...rest,
      lines: [{ name: 'Болт М8', quantity: 5, unitPrice: 20 }],
      total: 100,
      paymentTerms: '100% предоплата',
      deliveryDays: 3,
      fieldSources: {
        buyer: 'employee',
        seller: 'knowledge',
        requisites: 'knowledge',
        lines: 'employee',
        total: 'employee',
        paymentTerms: 'employee',
        deliveryDays: 'employee',
      },
    };
  }

  test('реквизиты из базы + позиции из КП: источники в чек-листе', async () => {
    const out = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: await readyDocument() },
      deps,
      CTX,
    );
    const sources = new Map(out.checklist.map((item) => [item.label, item.source]));
    expect(sources.get('ИНН')).toBe('карточка поставщика в базе');
    expect(sources.get('Итого')).toBe('КП поставщика');
  });

  test('всё из чата: КП нет, реквизиты по карточке - документ передаётся', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const document = await chatDocument();
    const out = await handoffForReview.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    expect(out.status).toBe('awaiting_review');
    const sources = new Map(out.checklist.map((item) => [item.label, item.source]));
    expect(sources.get('Итого')).toBe('сотрудник (чат)');
    expect(sources.get('Условия оплаты')).toBe('сотрудник (чат)');
    expect(out.checklist.some((item) => item.label === 'КП действует до')).toBe(false);
    expect(await checkSupplierDocument(document, deps)).toEqual([]);
  });

  test('данные из чата не должны расходиться с карточкой поставщика', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const document = await chatDocument();
    const wrong = { ...document, requisites: { ...document.requisites, bik: '044525000' } };
    expect((await checkSupplierDocument(wrong, deps)).map((i) => i.code)).toEqual([
      'requisite_mismatch',
    ]);
  });

  test('заявка указана, но КП не сохранено: расхождение вместо молчаливого пропуска', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const document = { ...(await chatDocument()), requestId: 'req-1' };
    expect((await checkSupplierDocument(document, deps)).map((i) => i.code)).toEqual([
      'quote_not_found',
    ]);
  });

  test('поле из интернета без кнопки: передача с предупреждением; с кнопкой - без', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const base = await chatDocument();
    const web = {
      ...base,
      paymentTerms: '30 дней по данным сайта поставщика',
      fieldSources: { ...base.fieldSources, paymentTerms: 'web' as const },
    };
    const unconfirmed = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: web },
      deps,
      CTX,
    );
    // Решение 03.11: без кнопки документ уходит, предупреждение - в чек-листе.
    expect(unconfirmed.checklist.map((item) => item.value).join('\n')).toContain(
      'не подтверждено кнопкой',
    );
    expect(deps.chat.outbox.length).toBeGreaterThan(0);
    // Канал не шлёт повтор с тем же ключом: подтверждённый вариант - на чистых зависимостях.
    deps = await build(FULL_SUPPLIER, null);
    expect(await pressWebConfirm(deps, web)).toBe('recorded');
    const out = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: web },
      deps,
      CTX,
    );
    const text = out.message;
    expect(out.status).toBe('awaiting_review');
    expect(text).toContain('Взято из интернета (подтверждено сотрудником)');
    expect(text).toContain('условия оплаты = 30 дней по данным сайта поставщика');
  });

  test('чек-лист: «подтверждено сотрудником» только после нажатия кнопки', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const base = await chatDocument();
    // Модель не может подтвердить сама: даже если поле уже не помечено как web, значение
    // из веб-поиска этого треда код считает веб-полем и просит кнопку.
    const web = {
      ...base,
      paymentTerms: '30 дней по данным сайта поставщика',
      fieldSources: { ...base.fieldSources, paymentTerms: 'employee' as const },
    };
    const page = { title: 'Условия', url: 'https://s.example', snippet: web.paymentTerms };
    const withWeb = { ...deps, web: new MemoryWebSearch([page]) };
    await searchInternetForDocuments.execute({ query: 'условия' }, withWeb, CTX);
    const before = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: web },
      withWeb,
      CTX,
    );
    // Без кнопки передача идёт, значение помечено «не подтверждено».
    const unconfirmedTerms = before.checklist.find((item) => item.label === 'Условия оплаты');
    expect(unconfirmedTerms?.source).toContain('не подтверждено');
    await pressWebConfirm(withWeb, web);
    const out = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: web },
      withWeb,
      CTX,
    );
    const terms = out.checklist.find((item) => item.label === 'Условия оплаты');
    expect(terms?.source).toBe('интернет; подтверждено сотрудником');
  });

  test('у поставщика есть КП, а у документа нет requestId: предупреждение', async () => {
    // В хранилище лежит КП поставщика (req-1); документ «из чата» заявку не называет.
    const document = await chatDocument();
    expect(document.requestId).toBeUndefined();
    const issues = await checkSupplierDocument(document, deps);
    expect(issues.map((i) => i.code)).toEqual(['quote_reconcile_required']);
    expect(issues[0]?.message).toContain('req-1');
    expect(issues[0]?.message).toContain('requestId');
    expect(issues[0]?.severity).toBe('warning');
    const out = await handoffForReview.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    const warning = out.checklist.find((item) => item.topic === 'warnings');
    expect(warning?.value).toContain('req-1');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });

  test('КП у поставщика нет вовсе: документ уходит, в чек-листе «с КП не сверялось»', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const out = await handoffForReview.execute(
      { templatePath: TEMPLATE, document: await chatDocument() },
      deps,
      CTX,
    );
    const note = out.checklist.find((item) => item.label === 'Сверка с КП');
    expect(note?.value).toBe('с КП не сверялось');
  });

  test('статус передачи: документы разных заявок не затирают друг друга', async () => {
    const first = await readyDocument();
    await deps.quotes?.save({ ...QUOTE, id: 'quote:req-2:s1', requestId: 'req-2' });
    const second = { ...first, requestId: 'req-2' };
    await handoffForReview.execute({ templatePath: TEMPLATE, document: first }, deps, CTX);
    await handoffForReview.execute({ templatePath: TEMPLATE, document: second }, deps, CTX);
    const keys = (await deps.state.list(REVIEW_NAMESPACE, null, 10)).map((entry) => entry.key);
    expect(keys).toHaveLength(2);
  });

  test('ключ передачи: id, отметки источников и порядок строк его не меняют', async () => {
    const document = await readyDocument();
    const input = { templatePath: TEMPLATE, document };
    const second = { name: 'Гайка', quantity: 1, unitPrice: 1 };
    const two = { ...document, lines: [...document.lines, second] };
    const reordered = { ...two, lines: [second, ...document.lines] };
    expect(handoffKey({ ...input, document: { ...document, id: 'doc-other' } })).toBe(
      handoffKey(input),
    );
    expect(handoffKey({ ...input, document: { ...document, fieldSources: {} } })).toBe(
      handoffKey(input),
    );
    expect(handoffKey({ ...input, document: reordered })).toBe(
      handoffKey({ ...input, document: two }),
    );
    expect(handoffKey({ ...input, document: two })).not.toBe(handoffKey(input));
  });

  test('агент: неподтверждённое веб-поле - предупреждение, передача идёт', async () => {
    deps = await build(FULL_SUPPLIER, null);
    const base = await chatDocument();
    const web = {
      ...base,
      deliveryDays: 10,
      fieldSources: { ...base.fieldSources, deliveryDays: 'web' as const },
    };
    const declaration = createDocumentsAgent({ model: MODEL_ALIAS });
    const { gateway, runtime, spec } = scriptedRuntime(
      declaration,
      deps,
      [
        callTool('c1', 'handoffForReview', { templatePath: TEMPLATE, document: web }),
        say('нужно подтверждение сотрудника'),
      ],
      {
        gateway: { contentDigitSeries: REQUISITE_DIGITS },
        runtime: { idempotency: new MemoryIdempotencyStore() },
      },
    );
    await runtime.run(spec, 't1', 'передай договор');
    const reply = toolMessages(gateway.requests[1]).join('');
    expect(reply).toContain('web_fields_unconfirmed');
    expect(reply).not.toContain('blocked');
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });
});

describe('handoffForReview: один автор итога (этап 180)', () => {
  test('договор: в чат один файл без текста; message модели с чек-листом и указанием', async () => {
    const document = await readyDocument();
    const input = { templatePath: TEMPLATE, document };
    const out = await handoffForReview.execute(input, deps, CTX);
    // Повтор не шлёт файл второй раз и текст тоже.
    await handoffForReview.execute(input, deps, CTX);
    expect(deps.chat.outbox).toHaveLength(1);
    expect(deps.chat.outbox[0]?.file).toBeDefined();
    expect(deps.chat.outbox[0]?.message).toBeUndefined();
    expect(out.message).toContain('Что проверить перед подписанием:');
    expect(out.message).toContain('не подписан и не согласован');
    expect(out.message).toContain('Файл отправлен без подписи. В итоговом ответе скажи сам');
  });
});
