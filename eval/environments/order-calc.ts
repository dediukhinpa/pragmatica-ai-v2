import {
  FixedClock,
  MemoryAccessPolicy,
  MemoryAuditRepository,
  MemoryBotFileRegistry,
  MemoryChatChannel,
  MemoryDocumentParser,
  MemoryPairNoteStore,
  MemoryScheduler,
  MemoryTableExporter,
  MemoryWorkflowStateStore,
  SequentialIdGenerator,
} from '@business-ai/adapters';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import {
  MemoryPriceRepository,
  MemoryPurchaseRequestRepository,
  MemorySupplierRepository,
} from '../../src/kit/adapters/memory/repositories.owned';
import {
  MemorySupplierQuoteRepository,
} from '../../src/kit/adapters/memory/supplier-quote-repository';
import {
  MemoryWebCandidateEnricher,
  MemoryWebQueryPlanner,
} from '../../src/kit/adapters/memory/web-candidate-model';
import { HANDOFF_ACCESS_ACTION, listThreadHandoffs } from '@business-ai/core';
import {
  loadCompleteness,
  loadProposal,
  loadSelection,
  loadSent,
} from '../../src/agents/order-calc/state';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { ORDER_CALC_AGENT_ID, type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { loadReplies } from '../../src/agents/order-calc/reply-store';
import {
  loadChoiceAsk,
  loadChoiceConfirmation,
  parsePickButton,
  parsePickDoneButton,
  pickButtonId,
  pickDoneButtonId,
  recordChoiceButton,
  recordChoiceDone,
  splitPickTarget,
} from '../../src/agents/order-calc/choice-confirmation';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { UNREADABLE_PHOTO_LINE } from '@business-ai/core';
import type {
  BitrixAttachmentReader,
  ImageAttachment,
  ImageReader,
  ImageReadItem,
} from '@business-ai/core';
import type { OrderCalcCase } from '../cases';
import { MANAGER_THREAD } from '../constants';
import {
  buildMailboxes,
  chatTextContainsCount,
  RecordingWebSearch,
  draftsShownCount,
  mailSentCount,
  requestTextsShownCount,
  seedPrices,
  seedSuppliers,
} from './common';
import { chatMessageCount } from '@business-ai/eval';
import { runProbe, splitArg, type ProbeFn } from '@business-ai/eval';
import { ProbeError, type EvalEnvironment, type FollowUpHandling } from '@business-ai/eval';
import { type ProposalView } from '../cases';

/** Далёкое «будущее» для выборки всех отложенных задач планировщика. */
const FAR_FUTURE = new Date('2100-01-01T00:00:00.000Z');

/** Кто «нажимает» кнопки в прогоне: личность берётся из канала, а не из ответа модели. */
const EVAL_MANAGER_USER = 'eval-manager';
/**
 * Метка кнопки в тексте кейса: `{pick:<supplierId>}`. Настоящий id кнопки зависит от версии
 * шорт-листа, которой кейс не знает, поэтому окружение подставляет его само через
 * `pickButtonId` ядра (а не пишет формат руками).
 */
const PICK_PLACEHOLDER = /\{pick:([^\s{}]+)\}/g;
/** Метка кнопки «Готово» в тексте кейса: подставляется id из `pickDoneButtonId` ядра. */
const DONE_PLACEHOLDER = '{done}';
/** Кнопка «Готово» в тексте: `pickdone:<отпечаток вопроса>`. */
const DONE_BUTTON = /pickdone:[^\s,.;{}]+/g;
/** Кнопка выбора в тексте: `pick:<отпечаток>:<supplierId>`; старый `pick:<id>` не подходит. */
const PICK_BUTTON = /pick:[^\s,.;{}]+/g;

/**
 * Подключение передачи агенту «Актуализация прайса (ИИ агент)» в окружении (набор `cases/handoff`).
 * Без неё агент собирается
 * как в бою без флага: инструментов передачи нет в декларации.
 */
export interface HandoffEnvOptions {
  /**
   * У сотрудника есть доступ к боту «Актуализация прайса (ИИ агент)»; иначе передача блокируется
   * политикой доступа.
   */
  allowPrices: boolean;
}

/** Нажатие кнопки выбора: отпечаток вопроса и поставщик. */
export interface PickPress {
  token: string;
  supplierId: string;
}

/** Заменить метки `{pick:<id>}` и `{done}` на id кнопок вопроса (функции ядра). */
export function renderPickPlaceholders(text: string, requestId: string, version: string): string {
  return text
    .replace(PICK_PLACEHOLDER, (_whole, supplierId: string) =>
      pickButtonId(requestId, version, supplierId),
    )
    .replaceAll(DONE_PLACEHOLDER, pickDoneButtonId(requestId, version));
}

/** Отпечатки вопросов из нажатых в реплике кнопок «Готово» по порядку. */
export function parseDoneTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const button of text.match(DONE_BUTTON) ?? []) {
    const token = parsePickDoneButton(button);
    if (token !== null) tokens.push(token);
  }
  return tokens;
}

/**
 * Нажатые в реплике кнопки выбора по порядку. Кнопка без отпечатка вопроса (старый формат
 * `pick:<id>`) ничего не подтверждает, как в чате.
 */
export function parsePickPresses(text: string): PickPress[] {
  const presses: PickPress[] = [];
  for (const button of text.match(PICK_BUTTON) ?? []) {
    const target = parsePickButton(button);
    const split = target === null ? null : splitPickTarget(target);
    if (split !== null) presses.push(split);
  }
  return presses;
}

/** Обязательный аргумент замера. */
function needleOf(probe: string, arg: string | undefined): string {
  if (arg === undefined || arg === '') throw new ProbeError(`замер «${probe}» требует аргумент`);
  return arg;
}

/** Сколько карточек просматривает замер кейса. */
const CARD_SCAN_LIMIT = 1000;
/** Первые байты jpeg: содержимое фото в кейсе не нужно, ридер подменён. */
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
/** Тип файла фото кейса. */
const PHOTO_MIME = 'image/jpeg';

/** Поле карточки заполнено: непустая строка или непустой список. */
function cardFieldFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return !Array.isArray(value) || value.length > 0;
}

type ChatPhoto = OrderCalcCase['state']['chatPhotos'][number];

/**
 * Чтение фото чата без сети: возвращает то, что задал кейс. Нормальное фото - как в режиме
 * tokens («Текст с фото: ...», status=ok); нечитаемое - фиксированная пометка кода
 * (status=rejected, unreadable), без текста.
 */
function stubImageReader(photos: readonly ChatPhoto[]): ImageReader {
  return {
    async describe(images: readonly ImageAttachment[]) {
      const items = images.map((image): ImageReadItem => {
        const photo = photos.find((item) => item.name === image.name);
        if (photo === undefined || photo.unreadable) {
          return {
            name: image.name,
            source: image.source,
            status: 'rejected',
            text: '',
            note: UNREADABLE_PHOTO_LINE,
            unreadable: true,
          };
        }
        return { name: image.name, source: image.source, status: 'ok', text: photo.text };
      });
      return { items, usage: { inputTokens: 0, outputTokens: 0, images: 0 } };
    },
  };
}

/** Скачивание вложений чата без портала: отдаёт фото кейса как пришедшие от бота. */
function stubAttachments(photos: readonly ChatPhoto[]): BitrixAttachmentReader {
  return {
    async fetchAttachments() {
      return {
        attachments: photos.map((photo) => ({
          name: photo.name,
          mime: PHOTO_MIME,
          bytes: PHOTO_BYTES,
          source: 'bot' as const,
        })),
        errors: [],
      };
    },
  };
}

/** Окружение агента «Поиск поставщика (ИИ агент)» из начального состояния кейса. */
export async function buildOrderCalcEnvironment(
  testCase: OrderCalcCase,
  model: string,
  handoff?: HandoffEnvOptions,
): Promise<EvalEnvironment> {
  const suppliers = new MemorySupplierRepository();
  const prices = new MemoryPriceRepository();
  const requests = new MemoryPurchaseRequestRepository();
  const chat = new MemoryChatChannel();
  // Режим почты сотрудников (как в проде при `EMPLOYEE_MAILBOX_ENABLED`): ответы читаются из
  // ящика. Письма агент не отправляет в любом режиме: текст запроса показывается в чате.
  const mailboxes = buildMailboxes(testCase.state.mailboxes);
  const mailboxOwners = testCase.state.mailboxes.map((item) => item.userId);
  const scheduler = new MemoryScheduler(new SequentialIdGenerator());
  await seedSuppliers(suppliers, testCase.state.suppliers);
  await seedPrices(prices, testCase.state.prices);
  for (const request of testCase.state.requests) await requests.save(request);
  const web = new RecordingWebSearch(testCase.state.web);
  // «Модели» веб-поиска: ответы заданы кейсом, настоящей модели нет (как и в проде, только
  // при заданном ответе подключаются составитель запросов и обогатитель кандидатов).
  const webPlan = testCase.state.webPlan;
  const webFacts = testCase.state.webFacts;
  const planner = webPlan === undefined ? undefined : new MemoryWebQueryPlanner(() => webPlan);
  const enricher =
    webFacts === undefined
      ? undefined
      : new MemoryWebCandidateEnricher((page) => webFacts[page.url] ?? {});
  const deps: OrderCalcDeps = {
    requests,
    suppliers,
    prices,
    knowledge: new MemoryKnowledgeSearch(new Map(Object.entries(testCase.state.knowledge))),
    web,
    scheduler,
    chat,
    clock: new FixedClock(),
    state: new MemoryWorkflowStateStore(),
    quotes: new MemorySupplierQuoteRepository(),
    managerThreadId: MANAGER_THREAD,
    tableExporter: new MemoryTableExporter(),
    parser: new MemoryDocumentParser(),
    ...(mailboxes === undefined ? {} : { mailboxes }),
    ...(planner === undefined ? {} : { webQueryPlanner: planner }),
    ...(enricher === undefined ? {} : { webEnricher: enricher }),
  };
  const access = new MemoryAccessPolicy();
  // Карточки поставщиков (этап 224): те же заглушки, что у агента документов; запись карточек
  // разрешена условному сотруднику кейса, ограничивает не право, а код инструмента.
  const cards = testCase.state.supplierCards;
  const photos = testCase.state.chatPhotos;
  if (cards) {
    access.allow({
      userId: EVAL_MANAGER_USER,
      botId: ORDER_CALC_AGENT_ID,
      action: ACTION_CONFIRM_SUPPLIER_CARD,
    });
    deps.supplierCards = {
      suppliers,
      chat,
      clock: deps.clock,
      state: deps.state,
      pairNotes: new MemoryPairNoteStore(),
      audit: new MemoryAuditRepository(),
      access,
    };
  }
  // Фото в чате сотрудника: ссылка в реестре под тредом прогона, скачивание и чтение подменены.
  if (photos.length > 0) {
    const registry = new MemoryBotFileRegistry({ clock: deps.clock });
    photos.forEach((photo, index) => {
      registry.remember(`eval-${testCase.id}`, { botId: 1, fileId: index + 1, name: photo.name });
    });
    deps.botFiles = registry;
    deps.attachments = stubAttachments(photos);
    deps.imageReader = stubImageReader(photos);
  }
  if (handoff?.allowPrices === true) {
    access.allow({
      userId: EVAL_MANAGER_USER,
      botId: PRICES_AGENT_ID,
      action: HANDOFF_ACCESS_ACTION,
    });
  }
  if (handoff !== undefined) {
    // Состояние и планировщик общие с агентом: передача пишет туда же, что и в бою
    deps.handoff = {
      state: deps.state,
      scheduler,
      clock: deps.clock,
      access,
      audit: new MemoryAuditRepository(),
    };
  }
  const requestId = testCase.state.requests[0]?.id ?? '';
  const proposal = async (): Promise<ProposalView | null> => {
    const saved = await loadProposal(deps, requestId);
    return saved === null ? null : { supplierIds: saved.entries.map((e) => e.supplierId) };
  };
  // Тред прогона задаёт прогонщик (`eval-<id кейса>`): по нему читаются передачи
  const threadId = `eval-${testCase.id}`;
  const probes: Record<string, ProbeFn> = {
    chatMessages: () => chatMessageCount(chat),
    // Замер забирает задачи из планировщика: вызывать после прогона, один раз.
    scheduledTasks: async () => (await scheduler.claimDue(FAR_FUTURE)).length,
    proposedSupplierCount: async () => (await proposal())?.supplierIds.length ?? 0,
    selectedSupplierCount: async () =>
      (await loadSelection(deps, requestId))?.supplierIds.length ?? 0,
    // Накопленное подтверждение менеджера (его пишет только код по нажатию кнопки)
    confirmedSupplierCount: async () =>
      (await loadChoiceConfirmation(deps.state, requestId))?.supplierIds.length ?? 0,
    // Итоговый выбор агента равен накопленному подтверждению: 1 — да, 0 — нет
    selectionMatchesConfirmation: async () => {
      const confirmed = await loadChoiceConfirmation(deps.state, requestId);
      const selected = await loadSelection(deps, requestId);
      if (confirmed === null || selected === null) return null;
      // Выбор действует только после «Готово»: без него сравнение не засчитывается
      const same =
        confirmed.done &&
        confirmed.supplierIds.length === selected.supplierIds.length &&
        selected.supplierIds.every((id) => confirmed.supplierIds.includes(id));
      return same ? 1 : 0;
    },
    // Передачи, поставленные в треде кейса (отклонённые политикой в счёт не идут)
    handoffsQueued: async () => (await listThreadHandoffs(deps.state, threadId)).length,
    // Черновики писем с кнопкой «Отправить»: у агента их нет, ожидается 0
    draftsShown: () => draftsShownCount(chat),
    // Письма, ушедшие из ящиков сотрудников: агент не отправляет, ожидается 0
    mailSent: () => mailSentCount(mailboxes, mailboxOwners),
    // Тексты запроса поставщикам, показанные сотруднику в чате (по одному на поставщика)
    requestTextsShown: () => requestTextsShownCount(chat),
    // Поставщики, чей запрос записан как подготовленный (письмо отправляет сотрудник)
    preparedSupplierCount: async () =>
      Object.keys((await loadSent(deps, requestId))?.sentBySupplier ?? {}).length,
    // Сообщений менеджеру с подстрокой `arg` (две средние, «нет данных» и т. п.)
    chatTextContains: (arg) => chatTextContainsCount(chat, needleOf('chatTextContains', arg)),
    // Обращений во внешний веб-поиск (запросы модели и обогащение кандидатов)
    webSearchCount: () => web.queries.length,
    // Веб-запросов с подстрокой `arg` (без учёта регистра): что именно искали
    webSearchContains: (arg) => {
      const wanted = needleOf('webSearchContains', arg).toLowerCase();
      return web.queries.filter((query) => query.toLowerCase().includes(wanted)).length;
    },
    // Сколько раз составитель запросов получил заявку и сколько полей формы ему передали
    webPlannerCalls: () => planner?.seen.length ?? 0,
    webPlannerFieldCount: () =>
      Object.keys(planner?.seen[planner.seen.length - 1]?.fields ?? {}).length,
    // Вид запроса, записанный проверкой полноты, равен `arg`: 1 - да, 0 - нет, null - не проверяли
    completenessKindIs: async (arg) => {
      const stored = await loadCompleteness(deps, requestId);
      return stored === null ? null : Number(stored.kind === needleOf('completenessKindIs', arg));
    },
    // Ответы поставщиков в хранилище заявки; `arg` - канал (email, phone, messenger, other)
    storedReplyCount: async (arg) =>
      (await loadReplies(deps.state, requestId)).filter(
        (reply) => arg === undefined || reply.channel === arg,
      ).length,
    // Записанные КП по заявке
    storedQuoteCount: async () => (await deps.quotes.listByRequest(requestId)).length,
    // Карточки поставщиков в базе: рост = карточка заведена
    supplierCardCount: async () => (await suppliers.listPage(null, CARD_SCAN_LIMIT)).length,
    // Заполнено ли поле у карточки, в названии которой есть подстрока: аргумент `название:поле`
    supplierCardNamedFieldFilled: async (arg) => {
      const [name, field] = splitArg('supplierCardNamedFieldFilled', arg);
      const wanted = name.toLowerCase();
      const found = await suppliers.searchCards({ limit: CARD_SCAN_LIMIT });
      const card = found.find((item) => item.name.toLowerCase().includes(wanted));
      return card !== undefined && cardFieldFilled(Reflect.get(card, field)) ? 1 : 0;
    },
  };
  return {
    declaration: createOrderCalcAgent({
      model,
      handoffToPrices: handoff !== undefined,
      mailbox: mailboxes !== undefined,
      completeness: testCase.state.completeness,
      // Чтение вложений чата есть у агента заявок только с приёмом (как в бою); правило про
      // фото визитки - когда фото читаются как текст (режим tokens, этап 224).
      ...(photos.length > 0 ? { intake: true } : {}),
      ...(cards ? { supplierCards: photos.length > 0 ? { businessCardPhoto: true } : {} } : {}),
    }),
    toolDeps: deps,
    // Инициатор хода берётся из канала, а не из ответа модели; без него передачи и текст
    // запроса поставщикам (он готовится только по ходу сотрудника) закрыты
    runContext: { initiator: { kind: 'user' as const, userId: EVAL_MANAGER_USER } },
    probe: (name, arg) => runProbe('order-calc', probes, name, arg),
    // Как насос чата: текст сообщения сотрудника запоминается для сверки реквизитов карточки.
    ...(cards
      ? {
          beforeRun: (threadId: string, request: string) =>
            noteEmployeeMessage(deps.state, threadId, request),
        }
      : {}),
    // Выбор менеджер пишет текстом в новом ходе (кнопок и приостановки нет).
    followUpsAfterCompletedTurn: true,
    // Как насос чата: каждое нажатие (прежние кнопки) - отдельный ход. Код копит подтверждение
    // и сам отвечает человеку, агент в этот ход не запускается; текст запроса готовится после
    // кнопки «Готово».
    // Кнопка несёт отпечаток своего вопроса, как в настоящем чате.
    beforeFollowUp: async (threadId, followUp): Promise<FollowUpHandling | void> => {
      const ask = await loadChoiceAsk(deps.state, threadId);
      if (ask === null) return;
      const text = renderPickPlaceholders(followUp, ask.requestId, ask.version);
      const presses = parsePickPresses(text);
      for (const press of presses) {
        const target = `${press.token}:${press.supplierId}`;
        await recordChoiceButton(deps.state, deps.clock, {
          supplierId: target,
          userId: EVAL_MANAGER_USER,
          threadId,
        });
      }
      // «Готово» завершает накопление (пишет код), после чего агент возобновляется
      for (const token of parseDoneTokens(text)) {
        const done = { token, userId: EVAL_MANAGER_USER, threadId };
        await recordChoiceDone(deps.state, deps.clock, done);
      }
      return presses.length > 0 ? { skipAgent: true } : { text };
    },
  };
}
