import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryChatChannel } from '@business-ai/adapters';
import {
  ToolSuspension,
  createToolContext,
  loadWorkOwner,
  recordWorkOwner,
  type ToolContext,
} from '@business-ai/core';
import { applyExportTemplate } from '../../src/agents/site-export/apply-export-template';
import { askManagerToChoose } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { compareQuotesTool } from '../../src/agents/order-calc/compare-quotes';
import { loadProposal, saveSelection, saveSent } from '../../src/agents/order-calc/state';
import { offerQuoteReplacements } from '../../src/agents/order-calc/quote-replacement';
import { previewPriceChanges, sendPriceChangeFile } from '../../src/agents/prices/price-changes';
import { recordQuote } from '../../src/agents/order-calc/record-quote';
import { remindManager } from '../../src/agents/order-calc/remind-manager';
import { reportExportToManager } from '../../src/agents/site-export/report-to-manager';
import { reportToManager } from '../../src/agents/prices/report-to-manager';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { sendQuoteSummary } from '../../src/agents/order-calc/send-quote-summary';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import { storeReply } from '../../src/agents/order-calc/reply-store';
import { validateCards } from '../../src/agents/site-export/validate-cards';
import { workSubject } from '../../src/agents/shared/work-owner.owned';
import { readSupplierReplies } from '../../src/agents/order-calc/reply-reading';
import { type PricesDeps } from '../../src/agents/prices/deps';
import { bindingThreadId, isDomainError } from '@business-ai/core';
import { hoursToMs } from '../../src/kit/domain/time';
import { CREATED_AT, MANAGER_THREAD, SUPPLIER_ID, putFile } from './support';
import {
  COLUMNS,
  buildFullPricesDeps,
  skuCsv,
  skuItem,
  type FullPricesDeps,
} from './prices-support';
import { EXPORT_ID, buildSiteDeps, type SiteTestDeps } from './site-support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps, MAIL_OWNER } from './order-support';

/** Два бота и два сотрудника: треды связки не совпадают ни по боту, ни по сотруднику. */
const THREAD_A = bindingThreadId({ botId: 'bot-a', userId: 'ivanov' });
const THREAD_B = bindingThreadId({ botId: 'bot-b', userId: 'petrov' });

/** Ход сотрудника в его треде связки. */
function chatCtx(threadId: string, operationId = 'op-chat'): ToolContext {
  return createToolContext({
    threadId,
    agentId: 'test-agent',
    operationId,
    initiator: { kind: 'user', userId: threadId },
  });
}

/** Плановый ход: человека нет, треда чата тоже. */
function scheduledCtx(operationId = 'op-sched'): ToolContext {
  return createToolContext({
    threadId: 'scheduled-run-thread',
    agentId: 'test-agent',
    operationId,
    initiator: { kind: 'scheduler' },
  });
}

const sentTo = (outbox: ReadonlyArray<{ threadId: string }>): string[] =>
  outbox.map((item) => item.threadId);

describe('«Актуализация прайса (ИИ агент)»: адресат по владельцу импорта', () => {
  let deps: FullPricesDeps;
  beforeEach(async () => {
    deps = await buildFullPricesDeps();
    await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', 10, 'B1')], 'seed');
  });

  /** Положить файл и сложить его в staging от имени хода; возвращает хэш файла. */
  async function stageAs(
    ctx: ToolContext,
    path: string,
    price: number,
    target: PricesDeps = deps,
  ): Promise<string> {
    putFile(target, path, skuCsv([['Болт', price, 'B1']]));
    const out = await stagePriceRows.execute(
      { path, supplierId: SUPPLIER_ID, columns: COLUMNS, reset: true },
      target,
      ctx,
    );
    return out.fileHash;
  }

  const report = (fileHash: string, ctx: ToolContext, target: PricesDeps = deps) =>
    reportToManager.execute(
      {
        kind: 'import_done',
        path: 'price.csv',
        fileHash,
        updated: 1,
        needsReview: 0,
        issueCodes: [],
      },
      target,
      ctx,
    );

  test('итог импорта: владельцу в тред его бота; два бота не смешиваются', async () => {
    const hashA = await stageAs(chatCtx(THREAD_A), 'a.csv', 11);
    const hashB = await stageAs(chatCtx(THREAD_B), 'b.csv', 12);
    await report(hashA, scheduledCtx());
    await report(hashB, scheduledCtx('op-2'));
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A, THREAD_B]);
  });

  test('итог импорта без владельца (плановый запуск) - менеджеру', async () => {
    const hash = await stageAs(scheduledCtx(), 'a.csv', 11);
    await report(hash, scheduledCtx());
    expect(sentTo(deps.chat.outbox)).toEqual([MANAGER_THREAD]);
    expect(await loadWorkOwner(deps.state, workSubject.import(hash))).toBeNull();
  });

  test('итог о файле, не дошедшем до staging, фиксирует владельца в ходе отчёта', async () => {
    await reportToManager.execute(
      {
        kind: 'scan_skipped',
        path: 'scan.pdf',
        fileHash: 'h-scan',
        updated: 0,
        needsReview: 0,
        issueCodes: [],
      },
      deps,
      chatCtx(THREAD_B),
    );
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_B]);
  });

  test('повтор: второй сотрудник тот же импорт не забирает, отчёт идёт первому', async () => {
    const hash = await stageAs(chatCtx(THREAD_A), 'a.csv', 11);
    await stageAs(chatCtx(THREAD_B, 'op-b'), 'a.csv', 11);
    await report(hash, chatCtx(THREAD_B, 'op-b2'));
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A]);
  });

  test('без хранилища состояния адресат прежний - менеджер', async () => {
    const stateless: PricesDeps = { ...deps, state: undefined };
    await report('h-1', chatCtx(THREAD_A), stateless);
    expect(sentTo(deps.chat.outbox)).toEqual([MANAGER_THREAD]);
  });

  test('скачки цен из файла: вопроса с кнопкой нет, решения человека не нужно', async () => {
    const fileHash = await stageAs(chatCtx(THREAD_A), 'jump.csv', 40);
    const input = { supplierId: SUPPLIER_ID, fileHash };
    const preview = await previewPriceChanges.execute(input, deps, chatCtx(THREAD_A));
    expect(preview.counts.jumps).toBe(1);
    expect(preview).not.toHaveProperty('approvalStatus');
    expect(deps.chat.outbox).toHaveLength(0);
  });

  /** Цена разная у каждого вызова: иначе канал отбросит повторное сообщение по ключу. */
  async function sendChanges(
    ctx: ToolContext,
    target: PricesDeps,
    price: number,
  ): Promise<void> {
    const fileHash = await stageAs(ctx, 'chg.csv', price, target);
    const input = { supplierId: SUPPLIER_ID, fileHash };
    const { diffHash } = await previewPriceChanges.execute(input, target, ctx);
    await sendPriceChangeFile.execute({ ...input, diffHash }, target, ctx);
  }

  test('файл изменений: владельцу, без владельца - ответственный, иначе менеджер', async () => {
    const noRole: PricesDeps = { ...deps, responsibleThreadId: undefined };
    // Ответственный задан, но файл получает тот, кто поручил работу.
    await sendChanges(chatCtx(THREAD_A), deps, 12);
    await sendChanges(chatCtx(THREAD_B), noRole, 13);
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A, THREAD_A, THREAD_B, THREAD_B]);
    deps.chat.outbox.length = 0;
    await sendChanges(scheduledCtx(), deps, 14);
    await sendChanges(scheduledCtx('op-2'), noRole, 15);
    expect(new Set(sentTo(deps.chat.outbox))).toEqual(
      new Set([deps.responsibleThreadId, MANAGER_THREAD]),
    );
  });
});

describe('«Актуализация сайта (ИИ агент)»: адресат по владельцу набора', () => {
  let deps: SiteTestDeps;
  beforeEach(async () => {
    deps = await buildSiteDeps(2);
  });

  const cards = [
    { sku: 'ART-001', name: 'Болт 1', price: 10, currency: 'RUB' },
    { sku: 'ART-002', name: 'Болт 2', price: 10, currency: 'RUB' },
  ];

  async function store(ctx: ToolContext, exportId = EXPORT_ID): Promise<string> {
    await applyExportTemplate.execute({ exportId, part: 0, reset: true, cards }, deps, ctx);
    return (await validateCards.execute({ exportId }, deps, ctx)).setHash;
  }

  const report = (ctx: ToolContext, exportId = EXPORT_ID) =>
    reportExportToManager.execute(
      { kind: 'needs_review', exportId, total: 2, issueCodes: ['empty_price'] },
      deps,
      ctx,
    );

  test('итог выгрузки: владельцу в тред его бота; две выгрузки не смешиваются', async () => {
    await store(chatCtx(THREAD_A), 'exp-a');
    await store(chatCtx(THREAD_B, 'op-b'), 'exp-b');
    await report(scheduledCtx(), 'exp-a');
    await report(scheduledCtx('op-2'), 'exp-b');
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A, THREAD_B]);
  });

  test('итог выгрузки без владельца - менеджеру', async () => {
    await store(scheduledCtx());
    await report(scheduledCtx());
    expect(sentTo(deps.chat.outbox)).toEqual([MANAGER_THREAD]);
  });

  test('повтор: другой сотрудник набор не забирает', async () => {
    await store(chatCtx(THREAD_A));
    await store(chatCtx(THREAD_B, 'op-b'));
    await report(chatCtx(THREAD_B, 'op-b2'));
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A]);
  });
});

describe('«Поиск поставщика (ИИ агент)»: адресат по владельцу заявки', () => {
  let deps: OrderTestDeps;
  const ownerOf = (): Promise<string | null> =>
    loadWorkOwner(deps.state, workSubject.order(REQUEST_ID));

  beforeEach(async () => {
    deps = await buildOrderDeps();
  });

  async function searchAll(ctx: ToolContext): Promise<void> {
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, ctx);
    await searchWeb.execute(input, deps, ctx);
  }

  async function startBy(threadId: string): Promise<void> {
    await recordWorkOwner(deps.state, workSubject.order(REQUEST_ID), chatCtx(threadId));
  }

  async function seedQuote(): Promise<void> {
    const selection = { requestId: REQUEST_ID, supplierIds: ['s1'], createdAt: CREATED_AT };
    await saveSelection(deps, selection);
    await saveSent(deps, {
      requestId: REQUEST_ID,
      supplierIds: ['s1'],
      sentAt: CREATED_AT,
      mailboxOwnerId: MAIL_OWNER,
    });
    await storeReply(deps.state, REQUEST_ID, {
      id: 'out:r-s1',
      channel: 'email',
      supplierId: 's1',
      text: 'КП',
      receivedAt: CREATED_AT,
      attachments: [],
    });
    await recordQuote.execute(
      {
        requestId: REQUEST_ID,
        supplierId: 's1',
        sourceRef: 'out:r-s1',
        currency: 'RUB',
        lines: [{ productName: 'Арматура', unitPrice: 50, quantity: 100, deliveryDays: 5 }],
        paymentTerms: '50% предоплата',
        validUntil: '2026-02-01T00:00:00.000Z',
      },
      deps,
      // Запись КП из служебного хода: ящик заявки у MAIL_OWNER, а не у тестового сотрудника.
      scheduledCtx(),
    );
  }

  test('шорт-лист из чата: тред связки сохраняется как владелец и адресат шорт-листа', async () => {
    await searchAll(chatCtx(THREAD_A));
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, chatCtx(THREAD_A));
    expect(await ownerOf()).toBe(THREAD_A);
    expect((await loadProposal(deps, REQUEST_ID))?.managerThreadId).toBe(THREAD_A);
    // Пересборка другим сотрудником отклонена: владелец и адресат прежние.
    const foreign = await buildShortlist
      .execute({ requestId: REQUEST_ID }, deps, chatCtx(THREAD_B, 'op-b'))
      .catch((e: unknown) => e);
    expect(isDomainError(foreign) && foreign.code).toBe('access_denied');
    expect(await ownerOf()).toBe(THREAD_A);
    expect((await loadProposal(deps, REQUEST_ID))?.managerThreadId).toBe(THREAD_A);
  });

  test('шорт-лист из планового хода: адресат - менеджер, а не служебный тред запуска', async () => {
    await searchAll(scheduledCtx());
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, scheduledCtx());
    expect(await ownerOf()).toBeNull();
    expect((await loadProposal(deps, REQUEST_ID))?.managerThreadId).toBe(MANAGER_THREAD);
  });

  test('вопрос выбора менеджеру остаётся в треде хода и фиксирует владельца', async () => {
    await searchAll(chatCtx(THREAD_B));
    const built = await buildShortlist.execute({ requestId: REQUEST_ID }, deps, scheduledCtx());
    const ask = await askManagerToChoose.execute(
      { requestId: REQUEST_ID, version: built.version },
      deps,
      chatCtx(THREAD_B),
    );
    expect(ask).toEqual({ asked: true });
    // Карточки, вопрос выбора и файл Excel: все в тред хода.
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_B, THREAD_B, THREAD_B]);
    expect(await ownerOf()).toBe(THREAD_B);
  });

  test('напоминание: владельцу, в тред его бота; без владельца - менеджеру', async () => {
    await startBy(THREAD_A);
    await remindManager.execute({ requestId: REQUEST_ID }, deps, scheduledCtx());
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A]);
    const fresh = await buildOrderDeps();
    await remindManager.execute({ requestId: REQUEST_ID }, fresh, scheduledCtx());
    expect(sentTo(fresh.chat.outbox)).toEqual([MANAGER_THREAD]);
  });

  test('сводка по КП: владельцу заявки', async () => {
    await seedQuote();
    await startBy(THREAD_A);
    const { quotesHash } = await compareQuotesTool.execute(
      { requestId: REQUEST_ID },
      deps,
      scheduledCtx(),
    );
    await sendQuoteSummary.execute({ requestId: REQUEST_ID, quotesHash }, deps, scheduledCtx());
    expect(new Set(sentTo(deps.chat.outbox))).toEqual(new Set([THREAD_A]));
  });

  test('замена КП: предложение уходит владельцу и в запись предложения', async () => {
    const selection = { requestId: REQUEST_ID, supplierIds: ['s1'], createdAt: CREATED_AT };
    await saveSelection(deps, selection);
    for (const [id, at] of [
      ['out:old', '2026-01-01T10:00:00.000Z'],
      ['out:new', '2026-01-01T12:00:00.000Z'],
    ] as const) {
      await storeReply(deps.state, REQUEST_ID, {
        id,
        channel: 'email',
        supplierId: 's1',
        text: 'Арматура',
        receivedAt: at,
        attachments: [],
      });
    }
    await recordQuote.execute(
      {
        requestId: REQUEST_ID,
        supplierId: 's1',
        currency: 'RUB',
        lines: [{ productName: 'Арматура', unitPrice: 50, quantity: 100 }],
        sourceRef: 'out:old',
      },
      deps,
      chatCtx(THREAD_A),
    );
    await startBy(THREAD_B);
    expect(await offerQuoteReplacements(deps, REQUEST_ID)).toBe(1);
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_B]);
  });

  test('письмо без привязки: вопрос владельцам заявок-кандидатов, без смешения', async () => {
    const open = async (requestId: string, owner: string | null): Promise<void> => {
      const createdAt = '2026-03-01T00:00:00.000Z';
      await saveSelection(deps, { requestId, supplierIds: ['s1'], createdAt });
      await saveSent(deps, {
        requestId,
        supplierIds: ['s1'],
        sentAt: '2026-03-01T00:00:00.000Z',
        mailboxOwnerId: MAIL_OWNER,
      });
      if (owner !== null) {
        await recordWorkOwner(deps.state, workSubject.order(requestId), chatCtx(owner));
      }
    };
    await open('req-1', THREAD_A);
    await open('req-2', THREAD_B);
    deps.mailboxes.deliver(MAIL_OWNER, {
      id: 'm1',
      from: 'sales@metall.test',
      subject: 'КП',
      body: 'Арматура 50 руб.',
      receivedAt: '2026-03-02T00:00:00.000Z',
      attachments: [],
    });
    await readSupplierReplies.execute({ requestId: 'req-1' }, deps, scheduledCtx());
    expect(new Set(sentTo(deps.chat.outbox))).toEqual(new Set([THREAD_A, THREAD_B]));
  });

  test('письмо без привязки и без владельцев: менеджеру', async () => {
    for (const requestId of ['req-1', 'req-2']) {
      const createdAt = '2026-03-01T00:00:00.000Z';
      await saveSelection(deps, { requestId, supplierIds: ['s1'], createdAt });
      await saveSent(deps, {
        requestId,
        supplierIds: ['s1'],
        sentAt: '2026-03-01T00:00:00.000Z',
        mailboxOwnerId: MAIL_OWNER,
      });
    }
    deps.mailboxes.deliver(MAIL_OWNER, {
      id: 'm1',
      from: 'sales@metall.test',
      subject: 'КП',
      body: 'Арматура 50 руб.',
      receivedAt: '2026-03-02T00:00:00.000Z',
      attachments: [],
    });
    await readSupplierReplies.execute({ requestId: 'req-1' }, deps, scheduledCtx());
    expect(new Set(sentTo(deps.chat.outbox))).toEqual(new Set([MANAGER_THREAD]));
  });

  test('предпочтение: владелец важнее треда шорт-листа, шорт-лист важнее менеджера', async () => {
    // Шорт-лист собран плановым ходом (адресат - менеджер), затем заявку начал сотрудник.
    await searchAll(scheduledCtx());
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, scheduledCtx());
    await remindManager.execute({ requestId: REQUEST_ID }, deps, scheduledCtx());
    expect(sentTo(deps.chat.outbox)).toEqual([MANAGER_THREAD]);
    // Канал отбрасывает повтор по ключу: берём чистый журнал для второго напоминания.
    deps.chat = new MemoryChatChannel();
    await startBy(THREAD_A);
    await remindManager.execute({ requestId: REQUEST_ID }, deps, scheduledCtx('op-2'));
    expect(sentTo(deps.chat.outbox)).toEqual([THREAD_A]);
  });
});
