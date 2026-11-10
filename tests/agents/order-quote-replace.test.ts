import { beforeEach, describe, expect, test } from 'bun:test';
import { hoursToMs } from '../../src/kit/domain/time';
import { isDomainError } from '@business-ai/core';
import { QUOTE_REPLACE_TTL_HOURS } from '../../src/agents/order-calc/deps';
import {
  approveQuoteReplacement,
  approveQuoteReplacementByAnswer,
  loadQuoteReplacement,
  offerQuoteReplacements,
  parseQuoteReplaceButton,
  quoteReplaceButtonId,
  quoteReplaceToken,
} from '../../src/agents/order-calc/quote-replacement';
import { confirmQuoteReplacement } from '../../src/agents/order-calc/confirm-quote-replacement';
import { quoteValidator, recordQuote } from '../../src/agents/order-calc/record-quote';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { saveSelection } from '../../src/agents/order-calc/state';
import { storeReply } from '../../src/agents/order-calc/reply-store';
import { CREATED_AT, CTX, MANAGER_THREAD } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const MANAGER = 'manager-1';
const OLD_AT = '2026-01-01T10:00:00.000Z';
const NEW_AT = '2026-01-01T12:00:00.000Z';

let deps: OrderTestDeps;

async function seedReply(id: string, receivedAt: string, supplierId = 's1'): Promise<void> {
  await storeReply(deps.state, REQUEST_ID, {
    id,
    channel: 'email',
    supplierId,
    text: 'Арматура',
    receivedAt,
    attachments: [],
  });
}

const quote = (sourceRef: string, price: number) => ({
  requestId: REQUEST_ID,
  supplierId: 's1',
  currency: 'RUB',
  lines: [{ productName: 'Арматура', unitPrice: price, quantity: 100 }],
  sourceRef,
});

const codes = async (input: unknown): Promise<string[]> =>
  (await quoteValidator.validate(input, deps, CTX)).map((issue) => issue.code);

const token = quoteReplaceToken(REQUEST_ID, 's1', 'out:new');
const MANAGER_USER = { kind: 'user' as const, userId: MANAGER };
/** Вопросы о замене КП в чате менеджера. */
const offers = () =>
  deps.chat.outbox.filter((m) => m.message?.text.includes('Заменить КП') === true);
const press = (overrides: { userId?: string; threadId?: string } = {}) =>
  approveQuoteReplacement(deps.state, deps.clock, {
    token,
    userId: MANAGER,
    threadId: MANAGER_THREAD,
    ...overrides,
  });

beforeEach(async () => {
  deps = await buildOrderDeps();
  await saveSelection(deps, { requestId: REQUEST_ID, supplierIds: ['s1'], createdAt: CREATED_AT });
  await seedReply('out:old', OLD_AT);
  await recordQuote.execute(quote('out:old', 50), deps, CTX);
  await seedReply('out:new', NEW_AT);
});

describe('R4-AGT-5: замена КП по решению менеджера', () => {
  test('без решения менеджера другой источник отклоняется', async () => {
    expect(await codes(quote('out:new', 47))).toEqual(['quote_source_conflict']);
  });

  test('менеджеру уходит вопрос о замене текстом, один раз', async () => {
    expect(await offerQuoteReplacements(deps, REQUEST_ID)).toBe(1);
    await offerQuoteReplacements(deps, REQUEST_ID);
    const sent = offers();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe(MANAGER_THREAD);
    expect(sent[0]?.message?.buttons).toBeUndefined();
    expect(sent[0]?.message?.text).toContain('**замени КП МеталлТорг**');
    // Прежние кнопки разбираются как раньше (уже отправленные сообщения).
    const buttonId = quoteReplaceButtonId(token);
    expect(buttonId.length).toBeLessThan(64);
    expect(parseQuoteReplaceButton(buttonId)).toBe(token);
  });

  test('чтение ответов само предлагает замену', async () => {
    await readSupplierReplies.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(offers()).toHaveLength(1);
  });

  test('ответ менеджера текстом: confirmQuoteReplacement только в его ходе', async () => {
    const input = { requestId: REQUEST_ID, supplierId: 's1' };
    const employee = { ...CTX, threadId: MANAGER_THREAD, initiator: MANAGER_USER };
    expect(await confirmQuoteReplacement.execute(input, deps, employee)).toEqual({
      status: 'not_offered',
    });
    await offerQuoteReplacements(deps, REQUEST_ID);
    const scheduled = { ...employee, initiator: { kind: 'scheduler' as const } };
    const denied = await confirmQuoteReplacement
      .execute(input, deps, scheduled)
      .catch((e: unknown) => e);
    expect(isDomainError(denied) && denied.code).toBe('access_denied');
    const elsewhere = { ...employee, threadId: 'чужой' };
    expect((await confirmQuoteReplacement.execute(input, deps, elsewhere)).status).toBe(
      'not_offered',
    );
    expect(await confirmQuoteReplacement.execute(input, deps, employee)).toEqual({
      status: 'approved',
      replyId: 'out:new',
    });
    expect(await codes(quote('out:new', 47))).toEqual([]);
    deps.clock.advance(hoursToMs(QUOTE_REPLACE_TTL_HOURS) + 1);
    expect((await confirmQuoteReplacement.execute(input, deps, employee)).status).toBe(
      'expired',
    );
  });

  test('после решения КП заменяется один раз, потом снова нужен менеджер', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    expect(await press()).toMatchObject({ kind: 'approved', replyId: 'out:new' });
    expect(await codes(quote('out:new', 47))).toEqual([]);
    // Подтверждение действует только на этот ответ.
    await seedReply('out:newer', '2026-01-01T13:00:00.000Z');
    expect(await codes(quote('out:newer', 40))).toEqual(['quote_source_conflict']);

    await recordQuote.execute(quote('out:new', 47), deps, CTX);
    expect((await deps.quotes.get(REQUEST_ID, 's1'))?.sourceRef).toBe('out:new');
    // Одноразово: подтверждение израсходовано, возврат на старый ответ снова блокируется.
    const left = await loadQuoteReplacement(deps.state, deps.clock, REQUEST_ID, 's1', 'out:new');
    expect(left).toBeNull();
    expect(await codes(quote('out:old', 50))).toEqual(['quote_source_conflict']);
  });

  test('повторное нажатие решения не меняет', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    await press();
    expect(await press()).toMatchObject({ kind: 'already_approved' });
  });

  test('чужой тред, неизвестное предложение, без личности, срок: решение не пишется', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    expect(await press({ threadId: 'чужой' })).toEqual({ kind: 'wrong_thread' });
    expect(await press({ userId: ' ' })).toEqual({ kind: 'no_identity' });
    expect(
      await approveQuoteReplacement(deps.state, deps.clock, {
        token: 'нет',
        userId: MANAGER,
        threadId: MANAGER_THREAD,
      }),
    ).toEqual({ kind: 'unknown_offer' });
    expect(await codes(quote('out:new', 47))).toEqual(['quote_source_conflict']);
    deps.clock.advance(hoursToMs(QUOTE_REPLACE_TTL_HOURS) + 1);
    expect(await press()).toEqual({ kind: 'expired' });
  });

  test('решение просрочивается через 24 часа', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    await press();
    deps.clock.advance(hoursToMs(QUOTE_REPLACE_TTL_HOURS) + 1);
    expect(await codes(quote('out:new', 47))).toEqual(['quote_source_conflict']);
  });
});

describe('R6-02-06: предложение замены с истёкшим сроком переоформляется', () => {
  test('без ответа за сутки новый вопрос уходит с новым токеном и принимается', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    deps.clock.advance(hoursToMs(QUOTE_REPLACE_TTL_HOURS) + 1);
    expect(await offerQuoteReplacements(deps, REQUEST_ID)).toBe(1);
    expect(offers()).toHaveLength(2);
    expect(await press()).toEqual({ kind: 'expired' });
    // Текстовый ответ находит живое (новое) предложение, а не просроченное.
    const outcome = await approveQuoteReplacementByAnswer(deps, {
      requestId: REQUEST_ID,
      supplierId: 's1',
      userId: MANAGER,
      threadId: MANAGER_THREAD,
    });
    expect(outcome).toMatchObject({ kind: 'approved', replyId: 'out:new' });
    // Повторное чтение ответов при живом предложении нового вопроса не плодит.
    await offerQuoteReplacements(deps, REQUEST_ID);
    expect(offers()).toHaveLength(2);
  });

  test('в вопросе есть пометка, что отправитель не подтверждён', async () => {
    await storeReply(deps.state, REQUEST_ID, {
      id: 'out:unverified',
      channel: 'email',
      supplierId: 's1',
      text: 'Арматура 40',
      receivedAt: '2026-01-01T14:00:00.000Z',
      attachments: [],
      senderUnverified: true,
    });
    await offerQuoteReplacements(deps, REQUEST_ID);
    expect(offers()[0]?.message?.text).toContain('не подтверждён');
  });
});

describe('R6-10-03: решение привязано к своему предложению', () => {
  const pressToken = (replyToken: string) =>
    approveQuoteReplacement(deps.state, deps.clock, {
      token: replyToken,
      userId: MANAGER,
      threadId: MANAGER_THREAD,
    });

  test('устаревшая кнопка по прежнему ответу не отменяет более позднее решение', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    await seedReply('out:newer', '2026-01-01T13:00:00.000Z');
    await offerQuoteReplacements(deps, REQUEST_ID);
    const newerToken = quoteReplaceToken(REQUEST_ID, 's1', 'out:newer');
    expect(await pressToken(token)).toMatchObject({ kind: 'approved', replyId: 'out:new' });
    expect(await pressToken(newerToken)).toMatchObject({ kind: 'approved', replyId: 'out:newer' });
    // Старая кнопка нажата снова: решение по №2 не возвращается.
    expect(await pressToken(token)).toEqual({ kind: 'expired' });
    const load = (replyId: string) =>
      loadQuoteReplacement(deps.state, deps.clock, REQUEST_ID, 's1', replyId);
    expect(await load('out:newer')).not.toBeNull();
    expect(await load('out:new')).toBeNull();
  });

  test('после расхода подтверждения повторное нажатие его не возвращает', async () => {
    await offerQuoteReplacements(deps, REQUEST_ID);
    await press();
    await recordQuote.execute(quote('out:new', 47), deps, CTX);
    expect(await press()).toMatchObject({ kind: 'already_approved' });
    const left = await loadQuoteReplacement(deps.state, deps.clock, REQUEST_ID, 's1', 'out:new');
    expect(left).toBeNull();
  });
});

