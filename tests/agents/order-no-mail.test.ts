import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryIntakeStore } from '@business-ai/adapters';
import { closeOrder, orderStatus } from '../../src/agents/order-calc/order-status';
import { compareQuotesTool } from '../../src/agents/order-calc/compare-quotes';
import { confirmQuoteReplacement } from '../../src/agents/order-calc/confirm-quote-replacement';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { loadReplies } from '../../src/agents/order-calc/reply-store';
import { ORDER_CALC_NO_MAIL_REPLY_PROMPT } from '../../src/agents/order-calc/prompt';
import {
  quoteSummaryValidator,
  sendQuoteSummary,
} from '../../src/agents/order-calc/send-quote-summary';
import { quoteValidator, recordQuote } from '../../src/agents/order-calc/record-quote';
import { recordSupplierReply } from '../../src/agents/order-calc/record-supplier-reply';
import { saveSelection, saveSent } from '../../src/agents/order-calc/state';
import { DomainError } from '@business-ai/core';
import { CREATED_AT } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const USER = 'u1';
const THREAD = 'order-calc/u1';
const SENT_AT = '2025-12-31T09:00:00.000Z';

/** Реплика сотрудника с номером хода: показ и подтверждение - разные реплики. */
function turn(turnNumber: number, userId = USER, threadId = THREAD): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'order-calc',
    operationId: `op-${turnNumber}`,
    initiator: { kind: 'user', userId },
    turnNumber,
  });
}

const PHONE = {
  requestId: REQUEST_ID,
  supplierId: 's1',
  channel: 'phone' as const,
  summary: 'Арматура 12 мм по 48 рублей за метр, срок 3 дня',
};

let deps: OrderTestDeps;

/** Выбор менеджера и подготовленные запросы s1, s2; почты у сборки нет. */
async function prepareOrder(): Promise<void> {
  deps = await buildOrderDeps();
  (deps as { mailboxes?: unknown }).mailboxes = undefined;
  await saveSelection(deps, {
    requestId: REQUEST_ID,
    supplierIds: ['s1', 's2'],
    createdAt: CREATED_AT,
  });
  await saveSent(deps, {
    requestId: REQUEST_ID,
    supplierIds: ['s1', 's2'],
    sentAt: SENT_AT,
    sentBySupplier: { s1: SENT_AT, s2: SENT_AT },
    state: 'prepared',
  });
}

/** Показ и подтверждение записи ответа двумя разными репликами. */
async function recordPhoneReply(input = PHONE): Promise<string> {
  const shown = await recordSupplierReply.execute(input, deps, turn(1));
  expect(shown.status).toBe('needs_confirmation');
  const done = await recordSupplierReply.execute({ ...input, confirmed: true }, deps, turn(2));
  expect(done.status).toBe('recorded');
  return done.replyId ?? '';
}

beforeEach(prepareOrder);

describe('Статус заказа без почты: сценарий целиком', () => {
  test('выбор -> ответ по телефону -> КП -> сравнение -> сводка', async () => {
    const replyId = await recordPhoneReply();
    const quote = {
      requestId: REQUEST_ID,
      supplierId: 's1',
      sourceRef: replyId,
      currency: 'RUB',
      lines: [{ productName: 'Арматура', unitPrice: 48, quantity: 100, unit: 'м' }],
    };
    expect(await quoteValidator.validate(quote, deps, turn(3))).toEqual([]);
    await recordQuote.execute(quote, deps, turn(3));
    const compared = await compareQuotesTool.execute({ requestId: REQUEST_ID }, deps, turn(3));
    expect(compared.notRepliedSupplierIds).toEqual(['s2']);
    const args = { requestId: REQUEST_ID, quotesHash: compared.quotesHash };
    expect(await quoteSummaryValidator.validate(args, deps, turn(3))).toEqual([]);
    const sent = await sendQuoteSummary.execute(args, deps, turn(3));
    expect(sent).toMatchObject({ delivered: true, answered: 1, notAnswered: 1 });
    // В сводке КП неответивший поставщик назван, ответивший по телефону учтён.
    const texts = deps.chat.outbox.map((record) => record.message?.text ?? '').join('\n');
    expect(texts).toContain('Ответили (1 из 2): МеталлТорг');
    expect(texts).toContain('Не ответили: Болтик');
  });

  test('ответ из recordSupplierReply хранится с почтовыми, с каналом и автором', async () => {
    const replyId = await recordPhoneReply();
    const stored = (await loadReplies(deps.state, REQUEST_ID)).find((r) => r.id === replyId);
    expect(stored).toMatchObject({ channel: 'phone', supplierId: 's1', recordedBy: USER });
    expect(stored?.text).toBe(PHONE.summary);
  });

  test('КП из чужого ответа отклоняется: ответ s1 не годится для s2', async () => {
    const replyId = await recordPhoneReply();
    const issues = await quoteValidator.validate(
      {
        requestId: REQUEST_ID,
        supplierId: 's2',
        sourceRef: replyId,
        currency: 'RUB',
        lines: [{ productName: 'Арматура', unitPrice: 48, quantity: 100, unit: 'м' }],
      },
      deps,
      turn(3),
    );
    expect(issues.map((issue) => issue.code)).toContain('source_supplier_mismatch');
  });
});

describe('recordSupplierReply: подтверждение сотрудника', () => {
  test('первый вызов ничего не пишет, а показывает запись в чате', async () => {
    const shown = await recordSupplierReply.execute(PHONE, deps, turn(1));
    expect(shown.status).toBe('needs_confirmation');
    expect(await loadReplies(deps.state, REQUEST_ID)).toEqual([]);
    const text = deps.chat.outboxOf(THREAD)[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг');
    expect(text).toContain('по телефону');
    expect(text).toContain(PHONE.summary);
  });

  test('подтверждение без показа отклоняется', async () => {
    await expect(
      recordSupplierReply.execute({ ...PHONE, confirmed: true }, deps, turn(2)),
    ).rejects.toThrow(DomainError);
    expect(await loadReplies(deps.state, REQUEST_ID)).toEqual([]);
  });

  test('показ и подтверждение в одной реплике: отказ', async () => {
    await recordSupplierReply.execute(PHONE, deps, turn(1));
    await expect(
      recordSupplierReply.execute({ ...PHONE, confirmed: true }, deps, turn(1)),
    ).rejects.toThrow(/отдельным сообщением/);
    expect(await loadReplies(deps.state, REQUEST_ID)).toEqual([]);
  });

  test('подтверждение с другим текстом, чем показан: отказ', async () => {
    await recordSupplierReply.execute(PHONE, deps, turn(1));
    await expect(
      recordSupplierReply.execute(
        { ...PHONE, summary: 'Арматура по 10 рублей', confirmed: true },
        deps,
        turn(2),
      ),
    ).rejects.toThrow(/отличаются/);
  });

  test('чужой сотрудник не подтверждает показанное другому', async () => {
    await recordSupplierReply.execute(PHONE, deps, turn(1));
    await expect(
      recordSupplierReply.execute(
        { ...PHONE, confirmed: true },
        deps,
        turn(2, 'u2', 'order-calc/u2'),
      ),
    ).rejects.toThrow(DomainError);
  });

  test('запись только в ходе сотрудника: плановый ход отклоняется', async () => {
    const scheduler = createToolContext({
      threadId: THREAD,
      agentId: 'order-calc',
      operationId: 'op-sch',
      initiator: { kind: 'scheduler' },
    });
    await expect(recordSupplierReply.execute(PHONE, deps, scheduler)).rejects.toThrow(DomainError);
  });

  test('показ устарел через сутки', async () => {
    await recordSupplierReply.execute(PHONE, deps, turn(1));
    deps.clock.advance(25 * 60 * 60 * 1000);
    await expect(
      recordSupplierReply.execute({ ...PHONE, confirmed: true }, deps, turn(2)),
    ).rejects.toThrow(/устарел/);
  });

  test('поставщик вне выбора менеджера отклоняется', async () => {
    await expect(
      recordSupplierReply.execute({ ...PHONE, supplierId: 's3' }, deps, turn(1)),
    ).rejects.toThrow(/не входит в выбор/);
  });

  test('повтор подтверждения не дублирует ответ', async () => {
    await recordPhoneReply();
    const again = await recordSupplierReply.execute({ ...PHONE, confirmed: true }, deps, turn(3));
    expect(again.status).toBe('already_recorded');
    expect(await loadReplies(deps.state, REQUEST_ID)).toHaveLength(1);
  });

  test('файл из чата сохраняется вложением ответа', async () => {
    const intake = new MemoryIntakeStore();
    deps.intake = intake;
    const put = await intake.put(THREAD, 'kp.xlsx', new Uint8Array([80, 75, 3, 4, 1]));
    const withFile = { ...PHONE, filePath: put.path };
    const replyId = await (async () => {
      await recordSupplierReply.execute(withFile, deps, turn(1));
      const done = await recordSupplierReply.execute(
        { ...withFile, confirmed: true },
        deps,
        turn(2),
      );
      return done.replyId ?? '';
    })();
    const stored = (await loadReplies(deps.state, REQUEST_ID)).find((r) => r.id === replyId);
    expect(stored?.attachments[0]).toMatchObject({ fileName: 'kp.xlsx', stored: true });
  });

  test('отказ поставщика записывается как declined', async () => {
    const replyId = await recordPhoneReply({
      ...PHONE,
      summary: 'Не работаем с таким',
      declined: true,
    } as typeof PHONE);
    const stored = (await loadReplies(deps.state, REQUEST_ID)).find((r) => r.id === replyId);
    expect(stored?.declined).toBe(true);
  });
});

describe('orderStatus', () => {
  test('поставщик без ответа виден, чего не хватает названо', async () => {
    const out = await orderStatus.execute({ requestId: REQUEST_ID }, deps, turn(1));
    const s1 = out.suppliers.find((s) => s.supplierId === 's1');
    expect(s1).toMatchObject({ requestState: 'prepared', answered: false, quoteRecorded: false });
    expect(s1?.missing).toEqual(['no_reply', 'no_quote']);
    const text = deps.chat.outboxOf(THREAD)[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг: запрос подготовлен');
    expect(text).toContain('Болтик: запрос подготовлен 31.12; ответа нет');
    // Срока ответа менеджеру по продажам в статусе нет совсем (этап 141).
    expect(text).not.toMatch(/срок|24 ч|SLA/i);
    expect(out).not.toHaveProperty('sla');
  });

  test('ответ по телефону меняет статус и называет канал', async () => {
    await recordPhoneReply();
    deps.clock.advance(60_000 * 2);
    const out = await orderStatus.execute({ requestId: REQUEST_ID }, deps, turn(3));
    const s1 = out.suppliers.find((s) => s.supplierId === 's1');
    expect(s1).toMatchObject({ answered: true, replyChannels: ['phone'] });
    expect(s1?.missing).toEqual(['no_quote']);
    const texts = deps.chat.outboxOf(THREAD).map((m) => m.message?.text ?? '');
    expect(texts.at(-1)).toContain('МеталлТорг: запрос подготовлен 31.12; ответил (телефон,');
  });

  test('названия поставщиков в ответ модели не попадают', async () => {
    const out = await orderStatus.execute({ requestId: REQUEST_ID }, deps, turn(1));
    expect(JSON.stringify(out)).not.toContain('МеталлТорг');
  });

  test('без выбора менеджера - статус «поставщики не выбраны», а не ошибка', async () => {
    const empty = await buildOrderDeps();
    const out = await orderStatus.execute({ requestId: REQUEST_ID }, empty, turn(1));
    expect(out.suppliers).toEqual([]);
    const texts = empty.chat.outbox.map((o) => o.message?.text ?? '');
    expect(texts.at(-1)).toContain('Поставщики по заявке ещё не выбраны.');
  });
});

describe('closeOrder', () => {
  test('закрытие требует показа и подтверждения в следующей реплике', async () => {
    const shown = await closeOrder.execute({ requestId: REQUEST_ID }, deps, turn(1));
    expect(shown.status).toBe('needs_confirmation');
    await expect(
      closeOrder.execute({ requestId: REQUEST_ID, confirmed: true }, deps, turn(1)),
    ).rejects.toThrow(/отдельным сообщением/);
    const closed = await closeOrder.execute(
      { requestId: REQUEST_ID, confirmed: true },
      deps,
      turn(2),
    );
    expect(closed.status).toBe('closed');
    const again = await closeOrder.execute({ requestId: REQUEST_ID }, deps, turn(3));
    expect(again.status).toBe('already_closed');
  });

  test('без показа закрыть нельзя', async () => {
    await expect(
      closeOrder.execute({ requestId: REQUEST_ID, confirmed: true }, deps, turn(2)),
    ).rejects.toThrow(DomainError);
  });
});

describe('этап 164: свободные ответы на подтверждение закрытия и записи ответа', () => {
  test('тексты вопросов дают примеры, а не единственно допустимые слова', async () => {
    await closeOrder.execute({ requestId: REQUEST_ID }, deps, turn(1));
    await recordSupplierReply.execute(PHONE, deps, turn(1));
    const texts = deps.chat.outboxOf(THREAD).map((record) => record.message?.text ?? '');
    expect(texts.join('\n')).toContain('Например: «да, закрывай»');
    expect(texts.join('\n')).toContain('Например: «да, записывай»');
    expect(texts.join('\n')).not.toContain('Напишите');
  });

  test('без confirmed (отказ, неясный ответ, «ок» вне вопроса) ничего не закрыто ' +
    'и не записано', async () => {
    await closeOrder.execute({ requestId: REQUEST_ID }, deps, turn(1));
    // Модель не ставит confirmed на «не надо»/«нет»/«пока не нужно»: заказ остаётся открытым.
    const again = await closeOrder.execute({ requestId: REQUEST_ID }, deps, turn(2));
    expect(again.status).toBe('needs_confirmation');
    await recordSupplierReply.execute(PHONE, deps, turn(1));
    expect(await loadReplies(deps.state, REQUEST_ID)).toEqual([]);
  });

  test('«хорошо»/«давай»/«ок» как ответ на вопрос = confirmed: ' +
    'закрытие и запись проходят', async () => {
    await closeOrder.execute({ requestId: REQUEST_ID }, deps, turn(1));
    const closed = await closeOrder.execute(
      { requestId: REQUEST_ID, confirmed: true },
      deps,
      turn(2),
    );
    expect(closed.status).toBe('closed');
    // «ок» вне контекста вопроса: показа нет - confirmed код не принимает.
    await expect(
      recordSupplierReply.execute({ ...PHONE, confirmed: true }, deps, turn(5)),
    ).rejects.toThrow(DomainError);
  });

  test('описания инструментов и промпт содержат правило свободного согласия', () => {
    for (const text of [closeOrder.description, recordSupplierReply.description]) {
      for (const word of ['«хорошо»', '«давай»', '«ок»', '«не надо»', 'вне этого вопроса']) {
        expect(text).toContain(word);
      }
    }
    for (const word of ['«хорошо»', '«давай»', '«ок»', '«не надо»', 'вне ответа на этот вопрос']) {
      expect(ORDER_CALC_NO_MAIL_REPLY_PROMPT).toContain(word);
    }
  });
});

describe('Второй ответ по телефону после записанного КП (без почты)', () => {
  test('код спрашивает о замене КП, после согласия recordQuote проходит', async () => {
    const firstId = await recordPhoneReply();
    const draft = (sourceRef: string, unitPrice: number) => ({
      requestId: REQUEST_ID,
      supplierId: 's1',
      sourceRef,
      currency: 'RUB',
      lines: [{ productName: 'Арматура', unitPrice, quantity: 100, unit: 'м' }],
    });
    await recordQuote.execute(draft(firstId, 48), deps, turn(3));
    deps.clock.advance(60_000);
    const second = { ...PHONE, summary: 'Передумали: арматура по 50 рублей за метр' };
    await recordSupplierReply.execute(second, deps, turn(4));
    const done = await recordSupplierReply.execute({ ...second, confirmed: true }, deps, turn(5));
    expect(done.status).toBe('recorded');
    const texts = deps.chat.outbox.map((record) => record.message?.text ?? '').join('\n');
    expect(texts).toContain('замени КП МеталлТорг');
    const secondId = done.replyId ?? '';
    const blocked = await quoteValidator.validate(draft(secondId, 50), deps, turn(6));
    expect(blocked.map((issue) => issue.code)).toContain('quote_source_conflict');
    const approved = await confirmQuoteReplacement.execute(
      { requestId: REQUEST_ID, supplierId: 's1' },
      deps,
      turn(6, USER, deps.managerThreadId),
    );
    expect(approved).toMatchObject({ status: 'approved', replyId: secondId });
    expect(await quoteValidator.validate(draft(secondId, 50), deps, turn(6))).toEqual([]);
  });
});
