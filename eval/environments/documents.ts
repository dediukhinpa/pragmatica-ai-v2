import {
  FixedClock,
  MemoryAccessPolicy,
  MemoryChatChannel,
  MemoryAuditRepository,
  MemoryDocumentRenderer,
  MemoryFileSource,
  MemoryPairNoteStore,
  MemoryWorkflowStateStore,
} from '@business-ai/adapters';
import { MemoryContractAmender } from '../../src/kit/adapters/memory/contract-amender';
import { MemoryKnowledgeSearch } from '../../src/kit/adapters/memory/knowledge-search.owned';
import { MemorySupplierRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { SUPPLIER_LOOKUP_OFFER_NAMESPACE } from '../../src/agents/suppliers/deps';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import {
  WEB_REQUEST_NAMESPACE,
  recordWebConfirmation,
} from '../../src/agents/documents/web-confirmation';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import {
  clearPragmatikaRuntime,
  pragmatikaRuntime,
  setPragmatikaRuntime,
  type PragmatikaRuntime,
} from '../../src/runtime';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import type { DocumentsCase } from '../cases';
import { chatFileContainsCount, seedFiles, seedSuppliers } from './common';
import { chatFileCount, chatMessageCount } from '@business-ai/eval';
import { runProbe, splitArg, type ProbeFn } from '@business-ai/eval';
import type { EvalEnvironment } from '@business-ai/eval';
import type { ConversationHistoryQuery, HistoryMessage } from '@business-ai/core';

/** Условный сотрудник, «нажавший» кнопку подтверждения данных из интернета. */
const EVAL_EMPLOYEE_USER = 'eval-employee';

/** Окружение агента «Подготовка документов (ИИ агент)» из начального состояния кейса. */
export async function buildDocumentsEnvironment(
  testCase: DocumentsCase,
  model: string,
): Promise<EvalEnvironment> {
  // Кейсы идут параллельно: подмену рантайма снимает только окружение, которое её поставило.
  const owner: CaptionRuntimeOwner = {};
  const suppliers = new MemorySupplierRepository();
  const files = new MemoryFileSource();
  const chat = new MemoryChatChannel();
  await seedSuppliers(suppliers, testCase.state.suppliers);
  seedFiles(files, testCase.state.files);
  const state = new MemoryWorkflowStateStore();
  const clock = new FixedClock();
  const chatFiles = testCase.state.chatFiles;
  const deps: DocumentsDeps = {
    files,
    knowledge: new MemoryKnowledgeSearch(new Map(Object.entries(testCase.state.knowledge))),
    renderer: new MemoryDocumentRenderer(),
    suppliers,
    chat,
    ownCompanyNames: testCase.state.ownCompanyNames,
    ownCompanyRequisites: testCase.state.ownCompanyRequisites,
    // Состояние и часы нужны подтверждению данных из интернета кнопкой.
    state,
    clock,
    // Режим дополнения присланного договора (этап 227): заглушка сервиса и файлы чата.
    ...(testCase.state.counterpartyAmend
      ? {
          contractAmender: new MemoryContractAmender(),
          botFiles: {
            recent: () => chatFiles.map((_file, index) => ({ botId: 1, fileId: index + 1 })),
            remember: () => undefined,
          },
          attachments: {
            fetchAttachments: async () => ({
              attachments: chatFiles.map((file) => ({
                name: file.path,
                mime: 'application/octet-stream',
                bytes: new TextEncoder().encode(file.text),
                source: 'bot' as const,
              })),
              errors: [],
            }),
          },
        }
      : {}),
    // Карточки поставщиков включаются кейсом: без флага deps и инструменты прежние.
    ...(testCase.state.supplierCards
      ? {
          supplierCards: {
            suppliers,
            chat,
            clock,
            state,
            pairNotes: new MemoryPairNoteStore(),
            audit: new MemoryAuditRepository(),
            // Запись карточек разрешена условному сотруднику: ограничивает не право, а код.
            access: allowCardWrites(),
          },
        }
      : {}),
  };
  const probes: Record<string, ProbeFn> = {
    chatMessages: () => chatMessageCount(chat),
    chatFiles: () => chatFileCount(chat),
    // Файлов в чате с подстрокой `arg`: сохранён ли текст исполнителя и добавлено ли наше.
    chatFileContains: (arg) => chatFileContainsCount(chat, arg ?? ''),
    // Открытые предложения «Добавить в базу?»: 1 - вопрос зарегистрирован, 0 - не предлагали.
    openSupplierOffers: async () => {
      const entries = await state.list(SUPPLIER_LOOKUP_OFFER_NAMESPACE, null, SCAN_LIMIT);
      return entries.filter((entry) => isOpenOffer(entry.value)).length;
    },
    // Сколько поставщиков и карточек в базе: рост = карточка заведена.
    supplierCardCount: async () => (await suppliers.listPage(null, SCAN_LIMIT)).length,
    // Заполнено ли поле карточки: аргумент `supplierId:поле`; 1 - есть значение, 0 - пусто.
    supplierCardFieldFilled: async (arg) => {
      const [supplierId, field] = splitArg('supplierCardFieldFilled', arg);
      const card = await suppliers.getCard(supplierId);
      return card !== null && hasValue(Reflect.get(card, field)) ? 1 : 0;
    },
  };
  return {
    declaration: createDocumentsAgent({
      model,
      ...(testCase.state.supplierCards ? { supplierCards: {} } : {}),
      ...(testCase.state.counterpartyAmend
        ? { chatAttachments: true, counterpartyAmend: true }
        : {}),
    }),
    toolDeps: deps,
    probe: (name, arg) => {
      // Замеры снимаются после прогона: подмену рантайма подписи возвращаем здесь.
      releaseCaptionRuntime(owner);
      return runProbe('documents', probes, name, arg);
    },
    // Ход начат сотрудником в чате: ответ «подтверждаю» модель записывает
    // recordWebFieldsDecision (только в таком ходе), реплика - новый ход после вопроса.
    runContext: { initiator: { kind: 'user' as const, userId: EVAL_EMPLOYEE_USER } },
    followUpsAfterCompletedTurn: true,
    // Как обработчик прежних кнопок чата: уже отправленная кнопка по-прежнему записывает
    // подтверждение кодом до запуска агента.
    // Как обработчик входящих сообщений чата: текст сотрудника запоминается для сверки
    // реквизитов (отметка источника от модели доверия не имеет).
    // Запрос-подпись к файлу (этап 9q) хук не получает: его видит только история треда.
    beforeRun: (threadId, request) =>
      testCase.state.captionWithFile
        ? installCaptionRuntime(
            owner,
            threadId,
            request,
            chatFiles[0]?.path ?? DEFAULT_CAPTION_FILE,
            clock,
          )
        : noteEmployeeMessage(state, threadId, request),
    beforeFollowUp: async (threadId, followUp) => {
      await noteEmployeeMessage(state, threadId, followUp);
      // Вопрос этого треда: запрос подтверждения записан под токеном (тред + отпечаток).
      const requests = await state.list(WEB_REQUEST_NAMESPACE, null, WEB_REQUESTS_SCAN_LIMIT);
      const asked = requests.find((entry) => requestThreadOf(entry.value) === threadId);
      if (asked === undefined) return;
      await recordWebConfirmation(state, clock, {
        token: asked.key,
        decision: 'confirmed',
        userId: EVAL_EMPLOYEE_USER,
        threadId,
      });
    },
  };
}

/** Имя файла в служебной строке, если у кейса нет файлов чата. */
const DEFAULT_CAPTION_FILE = 'Договор.docx';

/** Рантайм приложения до подмены кейсом «подпись к файлу»; нет подмены - `undefined`. */
let captionRuntimeSwap:
  | { owner: CaptionRuntimeOwner; previous: PragmatikaRuntime | undefined }
  | undefined;

/** Владелец подмены рантайма: окружение одного кейса. */
type CaptionRuntimeOwner = Record<string, never>;

/**
 * Поставить в рантайм проекта историю треда с запросом сотрудника как репликой хода с файлом
 * (так запрос формирует насос чата: подпись, пустая строка, служебная строка о файле) и часы
 * кейса. Хук входящих сообщений для такого запроса не вызывается, текст сверки берётся из истории.
 */
async function installCaptionRuntime(
  owner: CaptionRuntimeOwner,
  threadId: string,
  caption: string,
  fileName: string,
  clock: FixedClock,
): Promise<void> {
  const message: HistoryMessage = {
    role: 'user',
    text: `${caption}\n\nСотрудник прислал файл «${fileName}», путь intake/${fileName}`,
    at: clock.now(),
  };
  const history = {
    async search(query: ConversationHistoryQuery) {
      if (query.threadId !== threadId) return [];
      return [{ message, before: [], after: [], score: 1 }];
    },
  };
  captionRuntimeSwap = { owner, previous: pragmatikaRuntime() };
  setPragmatikaRuntime({ clock, conversationHistory: history } as unknown as PragmatikaRuntime);
}

/** Вернуть рантайм, каким он был до подмены кейса «подпись к файлу». */
function releaseCaptionRuntime(owner: CaptionRuntimeOwner): void {
  const swap = captionRuntimeSwap;
  if (swap === undefined || swap.owner !== owner) return;
  captionRuntimeSwap = undefined;
  if (swap.previous === undefined) clearPragmatikaRuntime();
  else setPragmatikaRuntime(swap.previous);
}

/** Сколько запросов подтверждения просматриваем в поисках вопроса треда. */
const WEB_REQUESTS_SCAN_LIMIT = 100;

/** Сколько записей состояния и поставщиков просматривают замеры кейса. */
const SCAN_LIMIT = 1000;

/** Право записи карточек у условного сотрудника кейса. */
function allowCardWrites(): MemoryAccessPolicy {
  const access = new MemoryAccessPolicy();
  access.allow({
    userId: EVAL_EMPLOYEE_USER,
    botId: 'documents',
    action: ACTION_CONFIRM_SUPPLIER_CARD,
  });
  return access;
}

/** Предложение завести карточку открыто (запись предложения, не указатель на последнее). */
function isOpenOffer(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false;
  return value.status === 'open';
}

/** Поле карточки заполнено: непустая строка или список. */
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return !Array.isArray(value) || value.length > 0;
}

/** Тред запроса подтверждения веб-полей; null - не запрос. */
function requestThreadOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('threadId' in value)) return null;
  const { threadId } = value;
  return typeof threadId === 'string' ? threadId : null;
}
