import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryIdempotencyStore } from '@business-ai/adapters';
import { compareQuotesTool } from '../../src/agents/order-calc/compare-quotes';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import {
  quoteSummaryValidator,
  sendQuoteSummary,
} from '../../src/agents/order-calc/send-quote-summary';
import { repliesNamespace, replyKey, storeReply } from '../../src/agents/order-calc/reply-store';
import { quoteValidator, recordQuote } from '../../src/agents/order-calc/record-quote';
import {
  readReplyAttachment,
  readSupplierReplies,
} from '../../src/agents/order-calc/reply-reading';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { DomainError } from '@business-ai/core';
import { type PurchaseRequest } from '../../src/kit/domain/models';
import type { InboxMessage, ModelRequest } from '@business-ai/core';
import {
  callTool,
  say,
  scriptedRuntime,
  type Step,
  type StepFn,
} from '../kit/adapters/mastra/support';
import { CREATED_AT, MODEL_ALIAS, lastToolResult, toolMessages } from './support';
import {
  MAIL_OWNER,
  READER_CTX as CTX,
  REQUEST_ID,
  buildOrderDeps,
  deliverReply,
  type OrderTestDeps,
} from './order-support';

const SELECTED = ['s1', 's2', 's3'];
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
/** Адреса поставщиков из базы тестовой сборки. */
const SUPPLIER_ADDRESS: Record<string, string> = {
  s1: 'sales@metall.test',
  s2: 'info@boltik.test',
};
/** Письмо поставщика в ящик владельца заявки: id стабилен для одного письма. */
const reply = (id: string, supplierId: string, body: string): InboxMessage => ({
  id,
  from: SUPPLIER_ADDRESS[supplierId] ?? 'unknown@x.test',
  subject: 'Re: запрос',
  body,
  receivedAt: CREATED_AT,
  attachments: [],
});

const TWO_ITEMS: PurchaseRequest = {
  id: REQUEST_ID,
  dealRef: 'D-1',
  items: [
    { name: 'Арматура', quantity: 100, unit: 'м' },
    { name: 'Сетка', quantity: 10, unit: 'шт' },
  ],
  createdAt: CREATED_AT,
};

let deps: OrderTestDeps;

async function select(ids: string[] = SELECTED): Promise<void> {
  await saveSelection(deps, { requestId: REQUEST_ID, supplierIds: ids, createdAt: CREATED_AT });
}

function quoteArgs(supplierId: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    supplierId,
    sourceRef: `out:r-${supplierId}`,
    currency: 'RUB',
    lines: [
      { productName: 'Арматура', unitPrice: 50, quantity: 100, deliveryDays: 5 },
      { productName: 'Сетка', unitPrice: 200, quantity: 10, deliveryDays: 7 },
    ],
    paymentTerms: '50% предоплата',
    validUntil: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

async function record(args: Record<string, unknown>): Promise<unknown> {
  const issues = await quoteValidator.validate(args, deps, CTX);
  if (issues.length > 0) throw new DomainError('validation_failed', JSON.stringify(issues));
  return recordQuote.execute(args, deps, CTX);
}

/** R3-SEC-2: КП принимается только из сохранённого ответа этого же поставщика. */
async function seedQuoteReplies(): Promise<void> {
  for (const supplierId of SELECTED) {
    await storeReply(deps.state, REQUEST_ID, {
      id: `out:r-${supplierId}`,
      channel: 'email',
      supplierId,
      text: 'КП',
      receivedAt: CREATED_AT,
      attachments: [],
    });
  }
}

/** Убрать засеянный ответ поставщика: он по-настоящему «не ответил». */
async function dropReply(supplierId: string): Promise<void> {
  await deps.state.delete(repliesNamespace(REQUEST_ID), replyKey(`out:r-${supplierId}`));
}

beforeEach(async () => {
  deps = await buildOrderDeps({ request: TWO_ITEMS });
  await select();
  // Ответом считается только письмо, полученное после отправки запроса по этой заявке.
  await saveSent(deps, {
    requestId: REQUEST_ID,
    supplierIds: SELECTED,
    sentAt: CREATED_AT,
    mailboxOwnerId: MAIL_OWNER,
  });
});

describe('readSupplierReplies', () => {
  test('без выбора менеджера читать рано', async () => {
    deps = await buildOrderDeps({ request: TWO_ITEMS });
    await expect(readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX)).rejects.toThrow(
      'ещё не выбрал',
    );
  });

  test('письма выбранных поставщиков; чужие письма не трогаются', async () => {
    deliverReply(deps, reply('r1', 's1', 'Арматура 50 руб.'));
    deps.mailboxes.deliver(MAIL_OWNER, {
      id: 'm1',
      from: 'info@boltik.test',
      subject: 'КП',
      body: 'Цены во вложении',
      receivedAt: CREATED_AT,
      attachments: [{ fileName: 'kp.csv', mimeType: 'text/csv', bytes: encode('Поз,Цена\nA,5') }],
    });
    deps.mailboxes.deliver(MAIL_OWNER, {
      id: 'm2',
      from: 'stranger@x.test',
      subject: 'реклама',
      body: 'спам',
      receivedAt: CREATED_AT,
      attachments: [],
    });
    const out = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.replies.map((r) => r.supplierId).sort()).toEqual(['s1', 's2']);
    expect(out.newCount).toBe(2);
    expect(out.notRepliedSupplierIds).toEqual(['s3']);
    expect(out.replies.find((r) => r.supplierId === 's2')?.attachments[0]?.fileName).toBe('kp.csv');
    // Отмечено обработанным только письмо поставщика; чужое осталось для других сценариев.
    expect(deps.mailboxes.processedIds(MAIL_OWNER).sort()).toEqual(['m1', 'r1']);
    const again = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(again.newCount).toBe(0);
    expect(again.replies).toHaveLength(2);
  });

  test('два одинаковых текста от разных писем не склеиваются, повтор не дублирует', async () => {
    deliverReply(deps, reply('r1', 's1', 'Цена 50'));
    deliverReply(deps, reply('r2', 's1', 'Цена 50'));
    const first = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(first.newCount).toBe(2);
    expect(first.replies.map((r) => r.replyId).sort()).toEqual(['in:r1', 'in:r2']);
    expect(first.replies.every((r) => r.receivedAt === CREATED_AT)).toBe(true);
    const again = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(again.newCount).toBe(0);
    expect(again.replies).toHaveLength(2);
  });

  test('пометка «обработано» после сохранения: сбой пометки не теряет письмо', async () => {
    // Сбой пометки в ящике владельца: письмо уже сохранено, повторное чтение его не теряет.
    const box = await deps.mailboxes.forEmployee(MAIL_OWNER);
    const markProcessed = box.markProcessed.bind(box);
    let fail = true;
    box.markProcessed = async (id: string): Promise<void> => {
      if (fail) throw new DomainError('external_failure', 'сбой ящика', { retryable: true });
      await markProcessed(id);
    };
    deliverReply(deps, {
      id: 'm1',
      from: 'sales@metall.test',
      subject: 'КП',
      body: 'Цена 50',
      receivedAt: CREATED_AT,
      attachments: [],
    });
    await expect(readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX)).rejects.toThrow(
      'сбой ящика',
    );
    fail = false;
    const out = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.replies).toHaveLength(1);
    expect(deps.mailboxes.processedIds(MAIL_OWNER)).toEqual(['m1']);
  });

  test('вложение читается через разбор документов; нет парсера — not_configured', async () => {
    deps.mailboxes.deliver(MAIL_OWNER, {
      id: 'm1',
      from: 'sales@metall.test',
      subject: 'КП',
      body: 'см. файл',
      receivedAt: CREATED_AT,
      attachments: [{ fileName: 'kp.csv', mimeType: 'text/csv', bytes: encode('Поз,Цена\nA,5') }],
    });
    const read = await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    const attachmentId = read.replies[0]?.attachments[0]?.attachmentId ?? '';
    const file = await readReplyAttachment.execute(
      { requestId: REQUEST_ID, attachmentId },
      deps,
      CTX,
    );
    expect(file.fileName).toBe('kp.csv');
    expect(file.tables).toContain('Цена');
    await expect(
      readReplyAttachment.execute({ requestId: REQUEST_ID, attachmentId: 'нет#0' }, deps, CTX),
    ).rejects.toThrow('не найдено');
    const withoutParser: OrderCalcDeps = { ...deps, parser: undefined };
    await expect(
      readReplyAttachment.execute({ requestId: REQUEST_ID, attachmentId }, withoutParser, CTX),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('recordQuote', () => {
  beforeEach(seedQuoteReplies);

  test('сохраняет КП и пометки «чего не хватает», пропущенное не выдумывает', async () => {
    const out = await record(
      quoteArgs('s1', {
        paymentTerms: undefined,
        validUntil: undefined,
        lines: [
          { productName: 'Арматура 12 мм', unitPrice: 50, quantity: 100 },
          { productName: 'Сетка', quantity: 10 },
        ],
      }),
    );
    expect(out).toMatchObject({ quoteId: `quote:${REQUEST_ID}:s1`, lines: 2 });
    const [quote] = await deps.quotes.listByRequest(REQUEST_ID);
    const codes = quote?.gaps.map((gap) => `${gap.code}:${gap.productName ?? ''}`);
    expect(codes).toEqual(['no_price:Сетка', 'no_delivery:', 'no_payment_terms:', 'no_validity:']);
    expect(quote?.paymentTerms).toBeUndefined();
  });

  test('позиция вне заявки не блокирует валидатор (запись с предупреждением)', async () => {
    const outside = quoteArgs('s1', {
      lines: [
        { productName: 'Арматура', unitPrice: 50, quantity: 100 },
        { productName: 'Труба стальная', unitPrice: 70, quantity: 5 },
      ],
    });
    expect(await quoteValidator.validate(outside, deps, CTX)).toEqual([]);
    const replaced = quoteArgs('s1', {
      lines: [
        { productName: 'Арматура', unitPrice: 50, quantity: 100 },
        { productName: 'Труба стальная', unitPrice: 70, quantity: 5, isReplacement: true },
      ],
    });
    expect(await quoteValidator.validate(replaced, deps, CTX)).toEqual([]);
  });

  test('поставщик не из выбора и неположительная цена — отказ; валюта — не отказ', async () => {
    await select(['s1']);
    const codes = async (args: Record<string, unknown>) =>
      (await quoteValidator.validate(args, deps, CTX)).map((i) => i.code);
    expect(await codes(quoteArgs('s2'))).toEqual(['supplier_not_in_selection']);
    expect(await codes(quoteArgs('s1', { currency: 'XYZ' }))).toEqual([]);
    expect(
      await codes(quoteArgs('s1', { lines: [{ productName: 'Арматура', unitPrice: -1 }] })),
    ).toEqual(['invalid_input']);
  });

  test('новое КП поставщика заменяет прежнее', async () => {
    await record(quoteArgs('s1'));
    await record(quoteArgs('s1', { paymentTerms: 'постоплата' }));
    const quotes = await deps.quotes.listByRequest(REQUEST_ID);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.paymentTerms).toBe('постоплата');
  });
});

describe('compareQuotes и sendQuoteSummary', () => {
  beforeEach(seedQuoteReplies);

  test('сравнение не отдаёт модели названия поставщиков и не выбирает победителя', async () => {
    await record(quoteArgs('s1'));
    await record(
      quoteArgs('s2', { lines: [{ productName: 'Арматура', unitPrice: 48, quantity: 100 }] }),
    );
    const out = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(JSON.stringify(out)).not.toContain('МеталлТорг');
    expect(JSON.stringify(out).toLowerCase()).not.toContain('recommend');
    expect(out.rows[0]?.minSupplierIds).toEqual(['s2']);
    expect(out.notRepliedSupplierIds).toEqual(['s3']);
    expect(out.flags.map((f) => f.code)).toContain('no_reply');
  });

  test('ответ без КП (телефон, мессенджер): не «не ответил», а «КП не записано»', async () => {
    await dropReply('s3');
    await storeReply(deps.state, REQUEST_ID, {
      id: 'manual:phone-s3',
      channel: 'phone',
      supplierId: 's3',
      text: 'Позвонили, пришлют завтра',
      receivedAt: CREATED_AT,
      attachments: [],
      recordedBy: 'u1',
    });
    await record(quoteArgs('s1'));
    await record(quoteArgs('s2'));
    const both = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(both.notRepliedSupplierIds).toEqual(['s3']);
    expect(both.answeredWithoutQuoteIds).toEqual(['s3']);
    const sent = await sendQuoteSummary.execute(
      { requestId: REQUEST_ID, quotesHash: both.quotesHash },
      deps,
      CTX,
    );
    expect(sent.notAnswered).toBe(0);
    const text = deps.chat.outbox.find((o) => o.message !== undefined)?.message?.text ?? '';
    expect(text).not.toContain('Не ответили:');
    expect(text).not.toContain('ответа на запрос нет');
    expect(text).toContain('Ответили, но КП ещё не записано: БезКонтакта (телефон).');
  });

  test('ответ без КП (отказ, без цены) меняет отпечаток: сводка пересылается заново', async () => {
    await dropReply('s3');
    await record(quoteArgs('s1'));
    await record(quoteArgs('s2'));
    const before = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    await sendQuoteSummary.execute(
      { requestId: REQUEST_ID, quotesHash: before.quotesHash },
      deps,
      CTX,
    );
    const sentBefore = deps.chat.outbox.length;
    // Поставщик ответил без цены: «нет в наличии».
    await storeReply(deps.state, REQUEST_ID, {
      id: 'manual:no-stock-s3',
      channel: 'phone',
      supplierId: 's3',
      text: 'Нет в наличии',
      receivedAt: CREATED_AT,
      attachments: [],
      recordedBy: 'u1',
    });
    const answered = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(answered.quotesHash).not.toBe(before.quotesHash);
    await sendQuoteSummary.execute(
      { requestId: REQUEST_ID, quotesHash: answered.quotesHash },
      deps,
      CTX,
    );
    expect(deps.chat.outbox.length).toBeGreaterThan(sentBefore);
    // Явный отказ после ответа без цены - снова другой набор.
    await storeReply(deps.state, REQUEST_ID, {
      id: 'manual:decline-s3',
      channel: 'phone',
      supplierId: 's3',
      text: 'Отказ',
      receivedAt: CREATED_AT,
      attachments: [],
      recordedBy: 'u1',
      declined: true,
    });
    const declined = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(declined.quotesHash).not.toBe(answered.quotesHash);
    // Без новых ответов отпечаток стабилен.
    const again = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(again.quotesHash).toBe(declined.quotesHash);
  });

  test('отказ поставщика: в сводке «отказались давать КП»', async () => {
    await dropReply('s3');
    await storeReply(deps.state, REQUEST_ID, {
      id: 'manual:decline-s3',
      channel: 'messenger',
      supplierId: 's3',
      text: 'Не работаем',
      receivedAt: CREATED_AT,
      attachments: [],
      recordedBy: 'u1',
      declined: true,
    });
    await record(quoteArgs('s1'));
    await record(quoteArgs('s2'));
    const out = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    const args = { requestId: REQUEST_ID, quotesHash: out.quotesHash };
    await sendQuoteSummary.execute(args, deps, CTX);
    const text = deps.chat.outbox.find((o) => o.message !== undefined)?.message?.text ?? '';
    expect(text).toContain('Отказались давать КП: БезКонтакта.');
    expect(text).not.toContain('Не ответили:');
  });

  test('сводка: текст, файл с тремя листами, неответивший; повтор не дублируется', async () => {
    await dropReply('s3');
    await record(quoteArgs('s1'));
    await record(
      quoteArgs('s2', { lines: [{ productName: 'Арматура', unitPrice: 48, quantity: 100 }] }),
    );
    const { quotesHash } = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    const input = { requestId: REQUEST_ID, quotesHash };
    expect(await quoteSummaryValidator.validate(input, deps, CTX)).toEqual([]);
    await sendQuoteSummary.execute(input, deps, CTX);
    await sendQuoteSummary.execute(input, deps, CTX);
    const texts = deps.chat.outbox.filter((o) => o.message !== undefined);
    const files = deps.chat.outbox.filter((o) => o.file !== undefined);
    expect(texts).toHaveLength(1);
    expect(files).toHaveLength(1);
    const text = texts[0]?.message?.text ?? '';
    expect(text).toContain('Ответили (2 из 3)');
    expect(text).toContain('Не ответили: БезКонтакта');
    expect(text).toContain('Выбор поставщика за вами');
    const csv = new TextDecoder().decode(files[0]?.file?.content);
    for (const sheet of ['# Сравнение', '# Условия', '# Не ответили']) expect(csv).toContain(sheet);
  });

  test('после нового КП старый отпечаток отклоняется, новый набор даёт новую сводку', async () => {
    await record(quoteArgs('s1'));
    const first = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    await sendQuoteSummary.execute(
      { requestId: REQUEST_ID, quotesHash: first.quotesHash },
      deps,
      CTX,
    );
    await record(quoteArgs('s2'));
    const stale = { requestId: REQUEST_ID, quotesHash: first.quotesHash };
    expect((await quoteSummaryValidator.validate(stale, deps, CTX)).map((i) => i.code)).toEqual([
      'quotes_changed',
    ]);
    const second = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(second.quotesHash).not.toBe(first.quotesHash);
    await sendQuoteSummary.execute(
      { requestId: REQUEST_ID, quotesHash: second.quotesHash },
      deps,
      CTX,
    );
    expect(deps.chat.outbox.filter((o) => o.message !== undefined)).toHaveLength(2);
  });

  test('без КП сводить нечего; без выгрузки таблиц — not_configured', async () => {
    const issues = await quoteSummaryValidator.validate(
      { requestId: REQUEST_ID, quotesHash: 'x' },
      deps,
      CTX,
    );
    expect(issues.map((i) => i.code)).toEqual(['no_quotes']);
    await record(quoteArgs('s1'));
    const { quotesHash } = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, CTX);
    const withoutExporter: OrderCalcDeps = { ...deps, tableExporter: undefined };
    await expect(
      sendQuoteSummary.execute({ requestId: REQUEST_ID, quotesHash }, withoutExporter, CTX),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('сценарии агента «Поиск поставщика (ИИ агент)»: КП', () => {
  beforeEach(seedQuoteReplies);

  function run(steps: StepFn) {
    const declaration = createOrderCalcAgent({ model: MODEL_ALIAS, mailbox: true });
    return scriptedRuntime(declaration, deps, steps, {
      runtime: { idempotency: new MemoryIdempotencyStore() },
    });
  }
  const summaryFrom = (request: ModelRequest): Step =>
    callTool('c-sum', 'sendQuoteSummary', {
      requestId: REQUEST_ID,
      quotesHash: lastToolResult(request)['quotesHash'],
    });

  test('ответили двое из трёх: сводка с флагом о неответившем и напоминание', async () => {
    await dropReply('s3');
    deliverReply(deps, reply('r1', 's1', 'Арматура 50, сетка 200'));
    deliverReply(deps, reply('r2', 's2', 'Арматура 48, сетка 210'));
    const steps: Array<Step | StepFn> = [
      callTool('c-read', 'readSupplierReplies', { requestId: REQUEST_ID }),
      callTool('c-q1', 'recordQuote', quoteArgs('s1')),
      callTool('c-q2', 'recordQuote', quoteArgs('s2')),
      callTool('c-cmp', 'compareQuotes', { requestId: REQUEST_ID }),
      summaryFrom,
      callTool('c-rem', 'scheduleReminder', { requestId: REQUEST_ID }),
      say('Сводка отправлена, один поставщик не ответил'),
    ];
    const { runtime, spec } = run((request, call) => {
      const step = steps[call] ?? say('конец');
      return typeof step === 'function' ? step(request, call) : step;
    });
    const result = await runtime.run(spec, 't1', 'Проверь ответы');
    expect(result.status).toBe('completed');
    const summary = deps.chat.outbox.find((o) => o.message !== undefined)?.message?.text ?? '';
    expect(summary).toContain('Не ответили: БезКонтакта');
    expect(summary).toContain('БезКонтакта: ответа на запрос нет');
    expect(deps.chat.outbox.some((o) => o.file !== undefined)).toBe(true);
    const tasks = await deps.scheduler.claimDue(new Date('2026-01-03T00:00:00.000Z'));
    // Только суточное напоминание: проверок срока ответа больше не ставят.
    expect(tasks.map((task) => task.name)).toEqual(['agent.run']);
  });

  test('КП в другой валюте: флаг, цены не конвертируются, в минимумах не участвует', async () => {
    const steps: Array<Step | StepFn> = [
      callTool('c-q1', 'recordQuote', quoteArgs('s1')),
      callTool('c-q2', 'recordQuote', quoteArgs('s2', { currency: 'USD' })),
      callTool('c-cmp', 'compareQuotes', { requestId: REQUEST_ID }),
      summaryFrom,
      say('готово'),
    ];
    const { runtime, spec } = run((request, call) => {
      const step = steps[call] ?? say('конец');
      return typeof step === 'function' ? step(request, call) : step;
    });
    await runtime.run(spec, 't1', 'сравни');
    const summary = deps.chat.outbox.find((o) => o.message !== undefined)?.message?.text ?? '';
    expect(summary).toContain('валюта КП USD, заявка в RUB; пересчёта нет');
    expect(summary).toContain('КП в разных валютах');
    // Минимум по арматуре остаётся рублёвым (50), а не «дешёвым» долларовым.
    expect(summary).toContain('Арматура: 50 (МеталлТорг)');
    const quotes = await deps.quotes.listByRequest(REQUEST_ID);
    expect(quotes.find((q) => q.supplierId === 's2')?.lines[0]?.unitPrice).toBe(50);
  });

  test('позиция вне заявки без «замены»: recordQuote записывает КП с предупреждением', async () => {
    const extra = quoteArgs('s1', {
      lines: [{ productName: 'Труба стальная', unitPrice: 70, quantity: 5 }],
    });
    const { gateway, runtime, spec } = run((request, call) =>
      call === 0 ? callTool('c-q', 'recordQuote', extra) : say('записано'),
    );
    await runtime.run(spec, 't1', 'сохрани КП');
    expect(toolMessages(gateway.requests[1]).join('\n')).toContain('нет в заявке');
    expect(await deps.quotes.listByRequest(REQUEST_ID)).toHaveLength(1);
  });

  test('повторная сводка того же набора не дублируется (в том числе через рантайм)', async () => {
    await record(quoteArgs('s1'));
    const steps: Array<Step | StepFn> = [
      callTool('c-cmp', 'compareQuotes', { requestId: REQUEST_ID }),
      summaryFrom,
      callTool('c-cmp2', 'compareQuotes', { requestId: REQUEST_ID }),
      (request) =>
        callTool('c-sum2', 'sendQuoteSummary', {
          requestId: REQUEST_ID,
          quotesHash: lastToolResult(request)['quotesHash'],
        }),
      say('готово'),
    ];
    const { runtime, spec } = run((request, call) => {
      const step = steps[call] ?? say('конец');
      return typeof step === 'function' ? step(request, call) : step;
    });
    await runtime.run(spec, 't1', 'сводка');
    expect(deps.chat.outbox.filter((o) => o.message !== undefined)).toHaveLength(1);
    expect(deps.chat.outbox.filter((o) => o.file !== undefined)).toHaveLength(1);
  });
});
