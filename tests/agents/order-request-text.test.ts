import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryMailboxDirectory, MemoryPortalLinks } from '@business-ai/adapters';
import { ORDER_CALC_MAIL_PROMPT, ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createToolContext, type ToolContext } from '@business-ai/core';
import {
  loadCompleteness,
  loadSent,
  saveCompleteness,
  saveSelection,
  saveSent,
} from '../../src/agents/order-calc/state';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import {
  recordSupplierRequestsPrepared,
} from '../../src/agents/order-calc/supplier-request-shared';
import { remindManager } from '../../src/agents/order-calc/remind-manager';
import { requestTag } from '../../src/agents/order-calc/reply-routing';
import { runOrdersDigest } from '../../src/agents/order-calc/orders-digest';
import { scheduleReminder, reminderValidator } from '../../src/agents/order-calc/schedule-reminder';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { DomainError } from '@business-ai/core';
import { SUPPLIER_REQUEST_REST_LINE } from '../../src/kit/domain/supplier-request-template';
import { hoursToMs } from '../../src/kit/domain/time';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import { MAIL_OWNER, REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';
import { MODEL_ALIAS } from './support';

const OTHER_USER = 'u2';
const S1_EMAIL = 'sales@metall.test';
const S2_EMAIL = 'info@boltik.test';
const CHAT = 'order-calc/u1';

const threadOf = (userId: string): string => `order-calc/${userId}`;

function contextOf(userId: string): ToolContext {
  return createToolContext({
    threadId: threadOf(userId),
    agentId: 'order-calc',
    operationId: `op-${userId}`,
    initiator: { kind: 'user', userId },
  });
}

/** Вызов инструмента с ожиданием отказа: возвращает пойманную ошибку. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

interface Harness {
  deps: OrderTestDeps;
  mailboxes: MemoryMailboxDirectory;
  logged: Array<{ event: string; fields?: Record<string, string | number | boolean> }>;
}

async function harness(): Promise<Harness> {
  const mailboxes = new MemoryMailboxDirectory();
  mailboxes.connect(MAIL_OWNER, 'ivanov@company.test');
  mailboxes.connect(OTHER_USER, 'petrov@company.test');
  const deps = await buildOrderDeps({ mailboxes });
  const logged: Harness['logged'] = [];
  deps.log = (event, fields) => {
    logged.push({ event, ...(fields === undefined ? {} : { fields }) });
  };
  await saveSelection(deps, {
    requestId: REQUEST_ID,
    supplierIds: ['s1', 's2'],
    createdAt: deps.clock.now().toISOString(),
  });
  return { deps, mailboxes, logged };
}

/** Сообщения, показанные сотруднику в его чате. */
function shownTexts(deps: OrderTestDeps, thread = CHAT): string[] {
  return deps.chat.outbox
    .filter((record) => record.threadId === thread)
    .map((record) => record.message?.text ?? '');
}

/** Само письмо в блоке: без пояснений сотруднику (что убрано и что не вошло). */
function letterOf(block: string | undefined): string {
  return (block ?? '').split('\n\nНе спрашиваю')[0]?.split('\n\nВ письме нет')[0] ?? '';
}

/** Характеристики заказа по форме 11.1, как их сохраняет проверка полноты. */
async function saveOrderValues(
  deps: OrderCalcDeps,
  values: Record<string, string>,
  requestId = REQUEST_ID,
): Promise<void> {
  await saveCompleteness(deps, {
    requestId,
    kind: 'custom_product',
    values,
    declined: false,
    updatedAt: deps.clock.now().toISOString(),
  });
}

function cardOf(id: string, email: string, overrides: Partial<SupplierCard> = {}): SupplierCard {
  return {
    id,
    name: id === 's1' ? 'МеталлТорг' : 'Болтик',
    status: 'active',
    contacts: [{ email, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...overrides,
  };
}

describe('prepareSupplierRequestText: текст в чате, письмо не отправляется', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  test('по блоку на поставщика: кому, тема с меткой, текст по шаблону ТЗ', async () => {
    await saveOrderValues(h.deps, { product: 'Ручка металлическая', quantity: '500' });
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    expect(out.shownSupplierIds).toEqual(['s1', 's2']);
    expect(out.notSent).toBe(true);
    const texts = shownTexts(h.deps);
    // Два письма; итоговые пометки - в сообщении последнего письма (этап 173).
    expect(texts).toHaveLength(2);
    const [first, second] = texts;
    expect(first).toContain('Поставщик: МеталлТорг');
    expect(first).toContain(`Кому: ${S1_EMAIL}`);
    expect(first).toContain(
      `Тема: Запрос на расчёт: Ручка металлическая ${requestTag(REQUEST_ID)}`,
    );
    expect(first).toContain('Добрый день.\n\nПрошу рассчитать:\n');
    expect(first).toContain('Продукция: Ручка металлическая');
    expect(first).toContain('Тираж, шт: 500');
    // Поле без значения в письмо не входит, вместо него одна общая фраза.
    expect(letterOf(first)).not.toContain('Материал изделия');
    expect(first).not.toContain('_____');
    expect(letterOf(first)).toContain(SUPPLIER_REQUEST_REST_LINE);
    expect(first).toContain(
      'Интересует ваша цена за штуку и за весь тираж (уточните сразу с НДС / без НДС / УСН)',
    );
    expect(first).toContain('Сроки с учетом ориентиров по запуску заказа');
    // Метка заявки и в теме, и в тексте.
    expect(first?.split(requestTag(REQUEST_ID))).toHaveLength(3);
    expect(second).toContain(`Кому: ${S2_EMAIL}`);
    // Итог: письмо не отправлено, метку в теме сохранить; пометки один раз, не в первом письме.
    expect(first).not.toContain('Письма я не отправляю');
    expect(texts[1]).toContain('Письма я не отправляю');
    expect(texts[1]).toContain('Метку');
  });

  test('этап 175: тело письма в ограде, заголовки и пометки вне неё', async () => {
    await saveOrderValues(h.deps, { product: 'Ручка металлическая', quantity: '500' });
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const texts = shownTexts(h.deps);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      const parts = text.split('```\n');
      expect(parts).toHaveLength(3);
      const [head = '', letter = '', tail = ''] = parts;
      expect(head).toMatch(/Поставщик: [^\n]+\nКому: [^\n]+\nТема: [^\n]+\n\n$/);
      expect(letter.startsWith('Добрый день.')).toBe(true);
      expect(letter).toContain('[RFQ-');
      expect(letter).not.toContain('Поставщик:');
      expect(letter).not.toContain('Кому:');
      expect(tail).not.toContain('Добрый день.');
    }
    // Пометки к письму - после ограды последнего письма.
    const last = texts[1] ?? '';
    expect(last.indexOf('Письма я не отправляю')).toBeGreaterThan(last.lastIndexOf('```'));
  });

  test('этап 175: тройные апострофы в поле не закрывают ограду', async () => {
    await saveOrderValues(h.deps, { product: 'Ручка ```металлическая```', quantity: '500' });
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    for (const text of shownTexts(h.deps)) expect(text.split('```\n')).toHaveLength(3);
  });

  test('этап 173: один поставщик - ОДНО сообщение, каждая пометка по разу', async () => {
    await saveSelection(h.deps, {
      requestId: REQUEST_ID,
      supplierIds: ['s1'],
      createdAt: h.deps.clock.now().toISOString(),
    });
    await saveOrderValues(h.deps, { product: 'Ручка металлическая' });
    const noted: string[] = [];
    const run = (): Promise<unknown> =>
      prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, h.deps, {
        ...contextOf(MAIL_OWNER),
        noteShown: (text) => noted.push(text),
      });
    await run();
    const texts = shownTexts(h.deps);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('Поставщик: МеталлТорг');
    for (const note of ['В письме нет', 'Письма я не отправляю', 'Метку вида [RFQ-']) {
      expect(text.split(note)).toHaveLength(2);
    }
    // Письмо идёт раньше пометок.
    expect(text.indexOf('Тема:')).toBeLessThan(text.indexOf('Письма я не отправляю'));
    // Ход заканчивается инструментом, а в историю идёт показанный сотруднику текст.
    expect(prepareSupplierRequestText.endsTurn).toBe(true);
    expect(noted).toEqual(texts);
    // Повтор шага с теми же данными сообщение не задваивает.
    await run();
    expect(shownTexts(h.deps)).toHaveLength(1);
  });

  test('ни одного письма: ящики пусты до, после и при повторе; кнопок отправки нет', async () => {
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    for (const user of [MAIL_OWNER, OTHER_USER]) {
      expect(h.mailboxes.sentBy(user)).toHaveLength(0);
      expect(h.mailboxes.sentCopies(user)).toHaveLength(0);
    }
    const messages = h.deps.chat.outbox.flatMap((record) => record.message ?? []);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.buttons).toBeUndefined();
      expect(message.text).not.toContain('Отправить');
    }
    expect(JSON.stringify(h.deps.chat.outbox)).not.toContain('edraft');
  });

  test('известное по карточке (НДС) убирается у этого поставщика, у другого остаётся', async () => {
    await h.deps.suppliers.saveCard(
      cardOf('s1', S1_EMAIL, {
        terms: { leadTime: '10 рабочих дней' },
        vatMode: 'no_vat',
      }),
    );
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const [first, second] = shownTexts(h.deps);
    // Письмо - до пояснения сотруднику; пояснение называет убранное.
    const [letter, explanation] = (first ?? '').split('\n\nНе спрашиваю');
    // Срок производства поставщика в карточке: вопрос о его сроках убран, наш желаемый срок нет.
    expect(letter).not.toContain('Сроки с учетом ориентиров по запуску заказа');
    expect(explanation).toContain('Сроки с учетом ориентиров по запуску заказа');
    expect(letter).not.toContain('Желаемый срок изготовления');
    expect(letter).not.toContain('_____');
    expect(letter).not.toContain('уточните сразу');
    expect(letter).toContain('Интересует ваша цена за штуку и за весь тираж');
    expect(explanation).toContain('это уже есть в его карточке');
    expect(explanation).toContain('Уточнение НДС / без НДС / УСН');
    expect(second).toContain('(уточните сразу с НДС / без НДС / УСН)');
    expect(second).not.toContain('уже есть в его карточке');
    expect(letterOf(second)).not.toContain('Желаемый срок изготовления');
    expect(second).not.toContain('_____');
    expect(out.blankFields).toContain('Желаемый срок изготовления');
  });

  test('значения из пространства полноты; без них - пустые места и список', async () => {
    const empty = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    expect(empty.blankFields).toContain('Продукция');
    expect(empty.blankFields).toContain('Тираж, шт');
    const shown = shownTexts(h.deps)[0] ?? '';
    // Ничего не указано: предупреждение первой строкой, письмо всё равно готово.
    expect(shown.split('\n')[0]).toBe(
      'Продукция не указана — письмо ничего не сообщает поставщику.',
    );
    expect(shown).toContain('В письме нет (не указано): Продукция;');
    expect(shown).toContain('Допишите в текст, если эти сведения есть.');
    expect(shown).not.toContain('Заполните перед отправкой');
    expect(shown).not.toContain('_____');

    const second = await harness();
    await saveOrderValues(second.deps, {
      product: 'Кружка',
      quantity: '100',
      production_date: '01.12.2026',
      budget: '90',
      dimensions: '9 х 9 х 10',
      material_color: 'керамика, белая',
      personalization_tech: 'деколь, 1 цвет',
      personalization_size: '5 х 5',
      sample: 'нет',
    });
    const full = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      second.deps,
      contextOf(MAIL_OWNER),
    );
    // Не хватает только даты запуска и дополнительных характеристик (в форме 11.1 их нет).
    expect(full.blankFields).toEqual(['Дата запуска в работу', expect.stringContaining('Дополни')]);
    const filled = shownTexts(second.deps)[0] ?? '';
    expect(filled).toContain('Желаемый срок изготовления: 01.12.2026');
    // Предупреждения о пустом письме нет: продукция и тираж указаны.
    expect(filled).not.toContain('Продукция не указана');
  });

  test('письмо с пропусками без подчёркиваний; при полном заполнении общей фразы нет', async () => {
    await saveOrderValues(h.deps, { product: 'Кружка', quantity: '300' });
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const partial = shownTexts(h.deps)[0] ?? '';
    expect(partial).not.toContain('_____');
    expect(letterOf(partial)).toContain(SUPPLIER_REQUEST_REST_LINE);
    expect(partial).not.toContain('Продукция не указана');
    // Общая фраза у полного шаблона отсутствует: это проверяет тест шаблона (core/tests/domain).
  });

  test('учёт: prepared, время подготовки, владелец ящика - сотрудник', async () => {
    expect(await loadSent(h.deps, REQUEST_ID)).toBeNull();
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const now = h.deps.clock.now().toISOString();
    const sent = await loadSent(h.deps, REQUEST_ID);
    expect(sent).toMatchObject({
      requestId: REQUEST_ID,
      state: 'prepared',
      mailboxOwnerId: MAIL_OWNER,
      sentAt: now,
      messageIds: {},
    });
    expect(sent?.sentBySupplier).toEqual({ s1: now, s2: now });
    expect([...(sent?.supplierIds ?? [])].sort()).toEqual(['s1', 's2']);
  });

  test('повтор идемпотентен: время не сдвигается, сообщения не дублируются', async () => {
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const first = await loadSent(h.deps, REQUEST_ID);
    const outboxSize = h.deps.chat.outbox.length;
    (h.deps.clock as { advance(ms: number): void }).advance(hoursToMs(5));
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    expect(await loadSent(h.deps, REQUEST_ID)).toEqual(first);
    expect(h.deps.chat.outbox).toHaveLength(outboxSize);
  });

  test('запись нового формата не затирает прежнюю: sent остаётся sent', async () => {
    await recordSupplierRequestsPrepared(h.deps, {
      requestId: REQUEST_ID,
      supplierIds: ['s1'],
      at: '2026-01-01T00:00:00.000Z',
      mailboxOwnerId: MAIL_OWNER,
    });
    const record = await loadSent(h.deps, REQUEST_ID);
    if (record === null) throw new Error('учёт не записан');
    expect(record.state).toBe('prepared');
    await saveSent(h.deps, { ...record, state: 'sent' });
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const merged = await loadSent(h.deps, REQUEST_ID);
    expect(merged?.state).toBe('sent');
    expect(merged?.sentBySupplier['s1']).toBe('2026-01-01T00:00:00.000Z');
    expect(Object.keys(merged?.sentBySupplier ?? {}).sort()).toEqual(['s1', 's2']);
  });

  test('ключ повтора меняется при смене характеристик заказа, карточки и адреса', async () => {
    const key = prepareSupplierRequestText.idempotencyKey?.({ requestId: REQUEST_ID });
    expect(key).toBeDefined();
    const predecessor = async (): Promise<string> =>
      (await prepareSupplierRequestText.idempotencyPredecessor?.(
        { requestId: REQUEST_ID },
        h.deps,
        CHAT,
      )) ?? '';
    const base = await predecessor();
    expect(await predecessor()).toBe(base);
    await saveOrderValues(h.deps, { product: 'Кружка' });
    const withValues = await predecessor();
    expect(withValues).not.toBe(base);
    await h.deps.suppliers.saveCard(
      cardOf('s1', S1_EMAIL, { vatMode: 'with_vat', vatRatePercent: 22 }),
    );
    const withCard = await predecessor();
    expect(withCard).not.toBe(withValues);
    await h.deps.suppliers.upsert({ id: 's2', name: 'Болтик', email: 'new@boltik.test' });
    expect(await predecessor()).not.toBe(withCard);
  });
});

describe('prepareSupplierRequestText: отказы и особые случаи', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  test('выбора менеджера нет: понятный отказ, ни сообщений, ни учёта', async () => {
    const fresh = await buildOrderDeps();
    const error = await failure(
      prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, fresh, contextOf(MAIL_OWNER)),
    );
    expect((error as DomainError).code).toBe('invalid_input');
    expect((error as DomainError).message).toContain('Менеджер ещё не выбрал');
    expect(fresh.chat.outbox).toHaveLength(0);
    expect(await loadSent(fresh, REQUEST_ID)).toBeNull();
  });

  test('плановый запуск и неизвестный инициатор текст не готовят', async () => {
    for (const initiator of [{ kind: 'scheduler' }, { kind: 'unknown' }] as const) {
      const context = createToolContext({
        threadId: 'order-calc-reminder:req-1',
        agentId: 'order-calc',
        operationId: 'op',
        initiator,
      });
      const error = await failure(
        prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, h.deps, context),
      );
      expect((error as DomainError).code).toBe('access_denied');
    }
    expect(h.deps.chat.outbox).toHaveLength(0);
    expect(await loadSent(h.deps, REQUEST_ID)).toBeNull();
  });

  test('смесь с почтой и без: текст готов всем, адрес не выдуман', async () => {
    await saveSelection(h.deps, {
      requestId: 'req-3',
      supplierIds: ['s1', 's3'],
      createdAt: h.deps.clock.now().toISOString(),
    });
    const out = await prepareSupplierRequestText.execute(
      { requestId: 'req-3' },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    expect(out.shownSupplierIds).toEqual(['s1', 's3']);
    expect(out.withoutContact).toEqual(['s3']);
    const [first, second] = shownTexts(h.deps);
    expect(first).toContain(`Кому: ${S1_EMAIL}`);
    expect(second).toContain('Кому: адрес не найден, уточните контакт');
    expect(second).not.toContain('@');
    expect(shownTexts(h.deps).at(-1)).toContain('Нет пригодного адреса почты у поставщиков: s3');
    expect(Object.keys((await loadSent(h.deps, 'req-3'))?.sentBySupplier ?? {})).toEqual([
      's1',
      's3',
    ]);
  });

  test('две карточки без почты: два текста, withoutContact, телефон рядом', async () => {
    const draft = (id: string, phone?: string): SupplierCard => ({
      id,
      name: `Черновик-${id}`,
      status: 'active',
      contacts: phone === undefined ? [] : [{ phone, isPrimary: true }],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    await h.deps.suppliers.upsert({ id: 'd1', name: 'Черновик-d1' });
    await h.deps.suppliers.upsert({ id: 'd2', name: 'Черновик-d2' });
    await h.deps.suppliers.saveCard(draft('d1', '+7 495 000-00-01'));
    await h.deps.suppliers.saveCard(draft('d2'));
    await saveSelection(h.deps, {
      requestId: 'req-4',
      supplierIds: ['d1', 'd2'],
      createdAt: h.deps.clock.now().toISOString(),
    });
    const out = await prepareSupplierRequestText.execute(
      { requestId: 'req-4' },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    expect(out.shownSupplierIds).toEqual(['d1', 'd2']);
    expect(out.withoutContact).toEqual(['d1', 'd2']);
    // Пометки (этап 173) - в том же сообщении, что последнее письмо, а не отдельным.
    const [first, second] = shownTexts(h.deps);
    const note = second;
    expect(first).toContain('адрес не найден, уточните контакт (телефон: ');
    expect(second).toContain('Кому: адрес не найден, уточните контакт');
    expect(second).not.toContain('телефон:');
    expect(note).toContain('Нет пригодного адреса почты у поставщиков');
    expect(note).not.toContain('не проверено');
    expect(note).not.toContain('Запрос не подготовлен');
    expect(Object.keys((await loadSent(h.deps, 'req-4'))?.sentBySupplier ?? {})).toEqual([
      'd1',
      'd2',
    ]);
  });

  test('токен псевдонимизации в значениях: текст не показывается и не записывается', async () => {
    await saveOrderValues(h.deps, { product: 'Заказ для [ORG_1]' });
    const error = await failure(
      prepareSupplierRequestText.execute(
        { requestId: REQUEST_ID },
        h.deps,
        contextOf(MAIL_OWNER),
      ),
    );
    expect((error as DomainError).code).toBe('invalid_input');
    expect((error as DomainError).message).toContain('[ORG_1]');
    expect(h.deps.chat.outbox).toHaveLength(0);
    expect(await loadSent(h.deps, REQUEST_ID)).toBeNull();
  });

  test('заявку ведёт другой сотрудник: второй текст не готовит', async () => {
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    const error = await failure(
      prepareSupplierRequestText.execute(
        { requestId: REQUEST_ID },
        h.deps,
        contextOf(OTHER_USER),
      ),
    );
    expect((error as DomainError).code).toBe('access_denied');
    expect(shownTexts(h.deps, threadOf(OTHER_USER))).toEqual([]);
    expect((await loadSent(h.deps, REQUEST_ID))?.mailboxOwnerId).toBe(MAIL_OWNER);
  });

  test('два сотрудника ведут разные заявки: у каждого свой владелец ящика', async () => {
    await saveSelection(h.deps, {
      requestId: 'req-2',
      supplierIds: ['s1'],
      createdAt: h.deps.clock.now().toISOString(),
    });
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    await prepareSupplierRequestText.execute({ requestId: 'req-2' }, h.deps, contextOf(OTHER_USER));
    expect((await loadSent(h.deps, REQUEST_ID))?.mailboxOwnerId).toBe(MAIL_OWNER);
    expect((await loadSent(h.deps, 'req-2'))?.mailboxOwnerId).toBe(OTHER_USER);
  });

  test('без почты (нет порта mailboxes): текст готов, сказано «почта не подключена»', async () => {
    const plain: OrderCalcDeps = { ...h.deps };
    delete plain.mailboxes;
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      plain,
      contextOf(MAIL_OWNER),
    );
    expect(out.mailConnected).toBe(false);
    expect(shownTexts(h.deps).at(-1)).toContain('Почта не подключена');
    expect(shownTexts(h.deps).at(-1)).toContain('вручную');
    // Учёт нужен и без ящика: владелец известен из хода сотрудника.
    expect(await loadSent(h.deps, REQUEST_ID)).toMatchObject({
      state: 'prepared',
      mailboxOwnerId: MAIL_OWNER,
    });
  });

  test('ящик у сотрудника не подключён: тот же исход, не сбой', async () => {
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf('u7'),
    );
    expect(out.mailConnected).toBe(false);
    expect(shownTexts(h.deps, threadOf('u7')).at(-1)).toContain('Почта не подключена');
  });
});

describe('prepareSupplierRequestText: значения сотрудника и повторный показ', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  const run = (input: Parameters<typeof prepareSupplierRequestText.execute>[0], deps = h.deps) =>
    prepareSupplierRequestText.execute(input, deps, contextOf(MAIL_OWNER));

  test('значения без проверки полноты попадают в текст и в пространство полноты', async () => {
    await run({
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: 'Кружка', quantity: '300', budget: '  ' },
    });
    const first = shownTexts(h.deps)[0];
    expect(first).toContain('Продукция: Кружка');
    expect(first).toContain('Тираж, шт: 300');
    // Пустое значение ничего не записывает.
    expect(letterOf(first)).not.toContain('Бюджет, руб');
    expect(first).not.toContain('_____');
    const stored = await loadCompleteness(h.deps, REQUEST_ID);
    expect(stored).toMatchObject({ kind: 'custom_product', declined: false });
    expect(stored?.values).toEqual({ product: 'Кружка', quantity: '300' });
  });

  test('значения дополняют сохранённые, пустые не затирают, вид берётся из записи', async () => {
    await saveOrderValues(h.deps, { product: 'Кружка', quantity: '100' });
    await run({ requestId: REQUEST_ID, values: { quantity: '250', product: '' } });
    const stored = await loadCompleteness(h.deps, REQUEST_ID);
    expect(stored?.values).toEqual({ product: 'Кружка', quantity: '250' });
    expect(stored?.kind).toBe('custom_product');
  });

  test('правка не снимает и не ставит отказ дополнять', async () => {
    await saveCompleteness(h.deps, {
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: 'Кружка' },
      declined: true,
      updatedAt: h.deps.clock.now().toISOString(),
    });
    await run({ requestId: REQUEST_ID, values: { quantity: '5' } });
    expect((await loadCompleteness(h.deps, REQUEST_ID))?.declined).toBe(true);
  });

  test('нет вида запроса и записи: отказ с просьбой указать kind, ничего не показано', async () => {
    const error = await failure(run({ requestId: REQUEST_ID, values: { product: 'Кружка' } }));
    expect((error as DomainError).code).toBe('invalid_input');
    expect((error as DomainError).message).toContain('kind');
    expect(h.deps.chat.outbox).toHaveLength(0);
    expect(await loadCompleteness(h.deps, REQUEST_ID)).toBeNull();
  });

  test('ключ не из формы вида игнорируется: ошибки нет, запись не создаётся', async () => {
    await run({ requestId: REQUEST_ID, kind: 'custom_product', values: { выдумка: 'x' } });
    expect(await loadCompleteness(h.deps, REQUEST_ID)).toBeNull();
  });

  test('кривая ссылка на задачу не мешает сохранить остальные значения', async () => {
    h.deps.links = new MemoryPortalLinks('portal.example.test');
    await run({
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: 'Кружка', task_link: 'нет' },
    });
    expect((await loadCompleteness(h.deps, REQUEST_ID))?.values).toEqual({ product: 'Кружка' });
  });

  test('правка меняет ключ идемпотентности и текст при повторе', async () => {
    const keyA = prepareSupplierRequestText.idempotencyKey?.({ requestId: REQUEST_ID });
    const keyB = prepareSupplierRequestText.idempotencyKey?.({
      requestId: REQUEST_ID,
      kind: 'custom_product',
      values: { product: 'Кружка' },
    });
    expect(keyB).not.toBe(keyA);
    await run({ requestId: REQUEST_ID, kind: 'custom_product', values: { product: 'Кружка' } });
    const before = h.deps.chat.outbox.length;
    await run({ requestId: REQUEST_ID, values: { product: 'Чашка' } });
    expect(h.deps.chat.outbox.length).toBeGreaterThan(before);
    expect(shownTexts(h.deps).join('\n')).toContain('Продукция: Чашка');
  });

  test('reshow: текст показывается снова, учёт и время подготовки не меняются', async () => {
    await run({ requestId: REQUEST_ID });
    const sentBefore = await loadSent(h.deps, REQUEST_ID);
    const shown = h.deps.chat.outbox.length;
    (h.deps.clock as { advance(ms: number): void }).advance(hoursToMs(5));
    await run({ requestId: REQUEST_ID, reshow: true });
    // Два блока поставщиков и заметка показаны ещё раз.
    expect(h.deps.chat.outbox).toHaveLength(shown * 2);
    expect(await loadSent(h.deps, REQUEST_ID)).toEqual(sentBefore);
    const texts = shownTexts(h.deps);
    expect(texts.slice(shown)).toEqual(texts.slice(0, shown));
  });

  test('reshow повторно: каждый новый показ имеет свой ключ, без reshow дублей нет', async () => {
    await run({ requestId: REQUEST_ID });
    const keyOf = async (): Promise<string> => {
      const input = { requestId: REQUEST_ID, reshow: true };
      const base = prepareSupplierRequestText.idempotencyKey?.(input) ?? '';
      const pred = (await prepareSupplierRequestText.idempotencyPredecessor?.(
        input,
        h.deps,
        CHAT,
      )) ?? '';
      return `${base}@${pred}`;
    };
    const first = await keyOf();
    await run({ requestId: REQUEST_ID, reshow: true });
    const second = await keyOf();
    expect(second).not.toBe(first);
    const shown = h.deps.chat.outbox.length;
    await run({ requestId: REQUEST_ID, reshow: true });
    expect(h.deps.chat.outbox).toHaveLength(shown + shown / 2);
    // Обычный повтор по-прежнему не дублирует сообщения.
    const plain = h.deps.chat.outbox.length;
    await run({ requestId: REQUEST_ID });
    expect(h.deps.chat.outbox).toHaveLength(plain);
  });
});

describe('prepareSupplierRequestText: персональные данные не уходят в журналы и задачи', () => {
  test('журнал, результат инструмента и задачи планировщика без текстов и адресов', async () => {
    const h = await harness();
    await saveOrderValues(h.deps, { product: 'Ручка секретная', budget: '777' });
    const out = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    await scheduleReminder.execute({ requestId: REQUEST_ID }, h.deps, contextOf(MAIL_OWNER));
    const tasks = await h.deps.scheduler.claimDue(new Date('2026-01-05T00:00:00.000Z'));
    expect(tasks.length).toBeGreaterThan(0);
    const dump = JSON.stringify([h.logged, out, tasks]);
    const secrets = ['Ручка секретная', '777', S1_EMAIL, S2_EMAIL, 'Добрый день', 'МеталлТорг'];
    for (const secret of secrets) {
      expect(dump).not.toContain(secret);
    }
    expect(h.logged.map((entry) => entry.event)).toContain('order_request_text_prepared');
  });
});

describe('prepared-запись работает у напоминаний, сводки и чтения ответов', () => {
  test('scheduleReminder и remindManager видят подготовленный запрос', async () => {
    const h = await harness();
    const ctx = contextOf(MAIL_OWNER);
    // До подготовки напоминать не о чем.
    expect((await reminderValidator.validate({ requestId: REQUEST_ID }, h.deps, ctx)).length).toBe(
      1,
    );
    await prepareSupplierRequestText.execute({ requestId: REQUEST_ID }, h.deps, ctx);
    expect(await reminderValidator.validate({ requestId: REQUEST_ID }, h.deps, ctx)).toEqual([]);
    const first = await scheduleReminder.execute({ requestId: REQUEST_ID }, h.deps, ctx);
    expect((await scheduleReminder.execute({ requestId: REQUEST_ID }, h.deps, ctx)).taskId).toBe(
      first.taskId,
    );
    expect((await remindManager.execute({ requestId: REQUEST_ID }, h.deps, ctx)).delivered).toBe(
      true,
    );
  });

  test('ответ поставщика после подготовки читается из ящика сотрудника', async () => {
    const h = await harness();
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    h.mailboxes.deliver(MAIL_OWNER, {
      id: 'r1',
      from: S1_EMAIL,
      subject: `Re: Запрос на расчёт ${requestTag(REQUEST_ID)}`,
      body: 'Цена 50 руб.',
      receivedAt: new Date(h.deps.clock.now().getTime() + hoursToMs(1)).toISOString(),
      attachments: [],
    });
    const replies = await readSupplierReplies.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    expect(replies.replies.map((reply) => reply.supplierId)).toEqual(['s1']);
    expect(replies.notRepliedSupplierIds).toEqual(['s2']);
  });

  test('утренняя сводка включает заявку с подготовленным запросом', async () => {
    const h = await harness();
    const sentDay = '2026-10-09T08:00:00.000Z';
    h.deps.clock = new FixedClock(new Date(sentDay));
    await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      h.deps,
      contextOf(MAIL_OWNER),
    );
    h.deps.clock = new FixedClock(new Date('2026-10-12T06:30:00.000Z'));
    const result = await runOrdersDigest(h.deps, { timezone: 'Europe/Moscow' });
    expect(result).toEqual({ status: 'sent', messages: 1, orders: 1 });
    const last = h.deps.chat.outbox.at(-1)?.message?.text ?? '';
    expect(last).toContain('Арматура');
    expect(last).not.toContain(REQUEST_ID);
  });
});

describe('агент «Поиск поставщика» письма не отправляет', () => {
  /**
   * Разрешённый перечень инструментов агента при всех сочетаниях опций. Ни один не отправляет
   * письмо: `sendQuoteSummary` отправляет менеджеру в чат файл-таблицу сравнения, не почту;
   * `prepareSupplierRequestText` только показывает текст в чате и пишет учёт.
   */
  const ALLOWED_TOOLS = new Set([
    'searchKnowledgeSuppliers',
    'searchWeb',
    'searchInternet',
    'searchConversationHistory',
    'buildShortlist',
    'askManagerToChoose',
    'recordManagerChoice',
    'recordSupplierCardDecision',
    'recordSelection',
    'prepareSupplierRequestText',
    'scheduleReminder',
    'remindManager',
    'readSupplierReplies',
    'readReplyAttachment',
    'routeSupplierMail',
    'recordQuote',
    'confirmQuoteReplacement',
    'compareQuotes',
    'sendQuoteSummary',
    'recordSupplierReply',
    'orderStatus',
    'closeOrder',
    'handoffToPrices',
    'getHandoffResult',
    'readIntakeSource',
    // Только чтение файлов, присланных боту в чат; ничего не отправляет.
    'readChatAttachments',
    // Общий инструмент файлов (этап 146): отправляет файл в чат, не письмо.
    'createFile',
    'saveIntakeRequest',
    'checkRequestCompleteness',
  ]);
  /**
   * Инструменты модуля карточек поставщиков (опция `supplierCards`): запись в общую базу после
   * кнопки сотрудника, почты не касаются. Берутся как разница деклараций с опцией и без неё.
   */
  const CARD_TOOLS = new Set(
    createOrderCalcAgent({ model: MODEL_ALIAS, supplierCards: {} })
      .tools.map((tool) => tool.name)
      .filter(
        (name) =>
          !createOrderCalcAgent({ model: MODEL_ALIAS })
            .tools.map((tool) => tool.name)
            .includes(name),
      ),
  );

  function allDeclarations() {
    const flags = [false, true];
    const out = [];
    for (const mailbox of flags) {
      for (const dailyDigest of flags) {
        for (const completeness of flags) {
          out.push(
            createOrderCalcAgent({
              model: MODEL_ALIAS,
              mailbox,
              dailyDigest,
              completeness,
              intake: true,
              handoffToPrices: true,
              supplierCards: {},
            }),
          );
        }
      }
    }
    return out;
  }

  test('инструменты всех деклараций - из разрешённого перечня, отправки нет', () => {
    const unknown: string[] = [];
    for (const declaration of allDeclarations()) {
      for (const tool of declaration.tools) {
        if (!ALLOWED_TOOLS.has(tool.name) && !CARD_TOOLS.has(tool.name)) unknown.push(tool.name);
        // Ни одного инструмента с именами черновика и отправки письма.
        expect(tool.name).not.toMatch(/Draft|SupplierRequests|sendEmail|sendMail/i);
      }
    }
    expect(unknown).toEqual([]);
  });

  test('prepareSupplierRequestDraft нет ни в одной декларации, в том числе с почтой', () => {
    for (const declaration of allDeclarations()) {
      const names = declaration.tools.map((tool) => tool.name);
      expect(names).not.toContain('prepareSupplierRequestDraft');
      expect(names).toContain('prepareSupplierRequestText');
      expect(declaration.validators?.map((validator) => validator.name)).not.toContain(
        'outreach-recipients',
      );
    }
  });

  test('промпт: текст готовит код, письмо отправляет сотрудник, «отправлено» писать нельзя', () => {
    for (const prompt of [ORDER_CALC_PROMPT, ORDER_CALC_MAIL_PROMPT]) {
      expect(prompt).toContain('prepareSupplierRequestText');
      expect(prompt).not.toContain('prepareSupplierRequestDraft');
      expect(prompt).not.toContain('«Отправить»');
      expect(prompt).toMatch(/отправляет\s+сотрудник/);
      expect(prompt).toContain('метк');
    }
    expect(ORDER_CALC_PROMPT).toContain('почта не подключена');
    expect(ORDER_CALC_MAIL_PROMPT).toContain('scheduleReminder');
    expect(ORDER_CALC_MAIL_PROMPT).toContain('почта не подключена');
  });
});
