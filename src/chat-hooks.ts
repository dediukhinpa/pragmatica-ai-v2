import { readFile } from 'node:fs/promises';
import {
  parseBindingThread,
  recordEmployeeContact,
  type ChatFile,
  type SystemContextBlock,
  type WorkflowStateStore,
} from '@business-ai/core';
import {
  CHAT_ACCESS_CHECK_UNAVAILABLE_TEXT,
  chatButtonHandler,
  type ChatAccessCheck,
  type ChatButtonHandler,
  type ChatFileHandler,
  type ChatHookContext,
  type ChatIncomingHook,
  type ChatScenarioRule,
  type ChatStateBlock,
  type GreetingActionHandler,
} from '@business-ai/core/compose';
import {
  ACTION_CONFIRM_SELECTION,
  ACTION_CONFIRM_SUPPLIER_CARD,
  ACTION_ROUTE_MAIL,
} from './access-actions';
import { recordWebConfirmation, parseWebConfirmButton } from './agents/documents/web-confirmation';
import { DOCUMENTS_AGENT_ID } from './agents/documents/deps';
import { noteEmployeeMessage } from './agents/documents/employee-messages';
import { ORDER_CALC_AGENT_ID } from './agents/order-calc';
import { activeRequestBlocks } from './agents/order-calc/active-request';
import {
  loadChoiceSummary,
  parsePickButton,
  parsePickDoneButton,
  recordChoiceButton,
  recordChoiceDone,
  splitPickTarget,
  type ChoiceDoneOutcome,
  type ChoiceOutcome,
} from './agents/order-calc/choice-confirmation';
import {
  approveQuoteReplacement,
  parseQuoteReplaceButton,
} from './agents/order-calc/quote-replacement';
import type { QuoteReplaceOutcome } from './agents/order-calc/quote-replacement';
import { storedRequestTitle } from './agents/order-calc/request-title';
import {
  assignSupplierMail,
  parseRouteButton,
  type RouteOutcome,
} from './agents/order-calc/reply-routing';
import { PRICES_AGENT_ID } from './agents/prices/deps';
import { parseSupplierCardButton } from './agents/suppliers/card-request';
import { supplierCardOutcomeText } from './agents/suppliers/card-approval';
import {
  SUPPLIER_IMPORT_FAILED_CODE,
  SupplierImportFailedError,
  importSuppliersFile,
  isSupplierImportCandidate,
} from './agents/suppliers/import-suppliers-file';
import { openMailProposalBlock } from './agents/suppliers/mail-proposal-store';
import { SUPPLIER_HELP_TEXT } from './agents/suppliers/prompt';
import { retiredPriceJumpButton } from './kit/app/chat-pump.owned';
import { pragmatikaRuntime, type PragmatikaRuntime } from './runtime';

/** Тексты отказов и ответов на кнопки (как были в насосе чата до манифеста). */
export const CHAT_FOREIGN_SCENARIO_TEXT = (owner: string, chatAgent: string): string =>
  `Это действие относится к помощнику «${owner}», а этот чат обслуживает «${chatAgent}»: ` +
  'откройте чат нужного помощника.';
/** Кнопка без обработчика (функция выключена, устаревшая). */
export const CHAT_BUTTON_STALE_TEXT = 'Эта кнопка больше не действует.';
export const CHAT_SELECTION_DENIED_TEXT =
  'У вас нет права выбирать поставщиков для рассылки запросов.';
export const CHAT_ROUTE_DENIED_TEXT =
  'У вас нет права относить письма поставщиков к заявкам и заменять КП.';
export const CHAT_CHOICE_STALE_TEXT =
  'Эта кнопка относится к прежнему вопросу о выборе. Нажмите кнопку в последнем вопросе.';
export const CHAT_CHOICE_DONE_ALREADY_TEXT =
  'Выбор уже завершён: набор поставщиков изменить нельзя.';
export const CHAT_CHOICE_NOTHING_TEXT = 'Сначала отметьте хотя бы одного поставщика.';
const CHAT_CHOICE_NOT_IN_LIST_TEXT = 'Этого поставщика нет в списке этого вопроса.';
const CHAT_CHOICE_IDENTITY_TEXT = 'Не удалось определить, кто нажал кнопку: выбор не записан.';
export const CHAT_ROUTE_UNKNOWN_MAIL_TEXT = 'Письмо не найдено или вопрос по нему устарел.';
const CHAT_ROUTE_UNKNOWN_REQUEST_TEXT = 'Эта заявка не входит в варианты для письма.';
export const CHAT_ROUTE_THREAD_TEXT = 'Отнести письмо можно только в чате, куда пришёл вопрос.';
const CHAT_ROUTE_IDENTITY_TEXT = 'Не удалось определить, кто нажал кнопку: письмо не отнесено.';
const CHAT_QUOTE_REPLACE_UNKNOWN_TEXT = 'Предложение замены КП не найдено или устарело.';
export const CHAT_QUOTE_REPLACE_THREAD_TEXT =
  'Заменить КП можно только в чате, куда пришёл вопрос.';
const CHAT_QUOTE_REPLACE_IDENTITY_TEXT =
  'Не удалось определить, кто нажал кнопку: замена не записана.';
export const CHAT_SUPPLIER_CARD_DENIED_TEXT =
  'Подтверждать запись карточек поставщиков могут только руководители отделов.';
export const CHAT_SUPPLIER_CARD_UNKNOWN_TEXT = 'Запрос не найден или устарел.';
const CHAT_SUPPLIER_CARD_IDENTITY_TEXT =
  'Не удалось определить, кто нажал кнопку: в базу ничего не записано.';
export const CHAT_SUPPLIER_TEMPLATE_FAILED_TEXT =
  'Не удалось отправить шаблон. Попробуйте ещё раз чуть позже.';
export const CHAT_SUPPLIER_IMPORT_FAILED_TEXT =
  'Не удалось обработать файл с поставщиками, в базу ничего не записано. Пришлите файл ' +
  `ещё раз чуть позже (код: ${SUPPLIER_IMPORT_FAILED_CODE}).`;
const CHAT_SUPPLIER_TEMPLATE_TEXT =
  'Шаблон для загрузки поставщиков: заполните и пришлите файл сюда.';
const CHAT_WEB_CONFIRMED_TEXT =
  'Данные из интернета подтверждены, решение записано на вас. Напишите агенту, чтобы он ' +
  'продолжил: документ будет собран.';
const CHAT_WEB_REJECTED_TEXT =
  'Данные из интернета не подтверждены, решение записано на вас. Документ не будет ' +
  'собран с этими значениями: пришлите верные.';
const CHAT_WEB_ALREADY_TEXT = 'Решение по этим данным уже записано ранее.';
const CHAT_WEB_UNKNOWN_TEXT = 'Запрос на подтверждение данных не найден или устарел.';
const CHAT_WEB_THREAD_TEXT = 'Подтвердить можно только в чате, куда пришёл запрос.';
const CHAT_WEB_IDENTITY_TEXT = 'Не удалось определить, кто нажал кнопку: решение не записано.';

/** Префиксы кнопок проекта. */
export const PICK_PREFIX = 'pick';
export const PICK_DONE_PREFIX = 'pickdone';
export const ROUTE_PREFIX = 'rfq';
export const QUOTE_REPLACE_PREFIX = 'qrepl';
export const WEB_CONFIRM_PREFIX = 'dwebc';
export const SUPPLIER_CARD_PREFIX = 'scard';

/**
 * Правила сценариев подтверждения кнопками с правом под агентом-владельцем (R4-SEC-2): правило,
 * написанное для бота, не зависит от того, какой бот принял сообщение. Выбор поставщиков запускает
 * рассылку наружу - отдельное узкое право (R4-AGT-7). В поле манифеста `chat.scenarios` правила
 * НЕ передаются: платформа запрещает один и тот же префикс и в `scenarios`, и в `buttons`, а все
 * четыре кнопки разбирает код проекта, который сам вызывает `guardScenario` по этой таблице.
 */
export const PROJECT_SCENARIO_RULES: readonly ChatScenarioRule[] = [
  {
    buttonPrefix: PICK_PREFIX,
    action: ACTION_CONFIRM_SELECTION,
    owner: ORDER_CALC_AGENT_ID,
    deniedText: CHAT_SELECTION_DENIED_TEXT,
  },
  {
    buttonPrefix: PICK_DONE_PREFIX,
    action: ACTION_CONFIRM_SELECTION,
    owner: ORDER_CALC_AGENT_ID,
    deniedText: CHAT_SELECTION_DENIED_TEXT,
  },
  {
    buttonPrefix: ROUTE_PREFIX,
    action: ACTION_ROUTE_MAIL,
    owner: ORDER_CALC_AGENT_ID,
    deniedText: CHAT_ROUTE_DENIED_TEXT,
  },
  {
    buttonPrefix: QUOTE_REPLACE_PREFIX,
    action: ACTION_ROUTE_MAIL,
    owner: ORDER_CALC_AGENT_ID,
    deniedText: CHAT_ROUTE_DENIED_TEXT,
  },
];

/** Агент, чей чат принимает прайсовые файлы (остальным файл не нужен). */
export const FILE_OWNER_AGENT_ID = PRICES_AGENT_ID;

/** Правило сценария по префиксу кнопки; в таблице есть всегда (проверяет тест). */
function ruleOf(prefix: string): ChatScenarioRule {
  const rule = PROJECT_SCENARIO_RULES.find((item) => item.buttonPrefix === prefix);
  if (rule === undefined) throw new Error(`Нет правила сценария для кнопки «${prefix}»`);
  return rule;
}

/** Сценарий другого помощника: сотрудник получает текст, ход не запускается. */
async function rejectForeign(context: ChatHookContext, owner: string): Promise<string | null> {
  if (owner === context.agentId) return null;
  await context.say(CHAT_FOREIGN_SCENARIO_TEXT(owner, context.agentId));
  return 'foreign_scenario';
}

/** Код результата аудита для отказа: `denied` или `denied:<причина>` (как в прежнем насосе). */
function deniedCode(verdict: ChatAccessCheck): string {
  return verdict.reason === undefined ? 'denied' : `denied:${verdict.reason}`;
}

/**
 * Право на сценарий подтверждения: проверка под агентом-владельцем (нет правила или сбой
 * политики - отказ), затем отказ, если сценарий чужой для этого чата. Код результата для аудита,
 * когда событие обработано отказом (с причиной, в том числе `denied:directory_unavailable`);
 * `null` - можно продолжать.
 */
async function guardScenario(
  context: ChatHookContext,
  rule: ChatScenarioRule,
): Promise<string | null> {
  const verdict = await context.check(rule.action, rule.owner);
  if (!verdict.allowed) {
    await context.say(rule.deniedText);
    return deniedCode(verdict);
  }
  return rejectForeign(context, rule.owner);
}

/** Что сказать менеджеру после нажатия кнопки выбора. */
async function pickOutcomeText(
  state: WorkflowStateStore,
  threadId: string,
  token: string,
  outcome: ChoiceOutcome,
): Promise<string> {
  switch (outcome.kind) {
    case 'recorded':
    case 'already_recorded': {
      const summary = await loadChoiceSummary(state, threadId, token);
      const names = summary?.names.join(', ') ?? '';
      return (
        `${outcome.kind === 'recorded' ? 'Отмечено' : 'Уже отмечено'}. Выбрано: ${names}. ` +
        'Добавьте других поставщиков или нажмите «Готово»: до этого ничего не отправляется.'
      );
    }
    case 'already_done':
      return CHAT_CHOICE_DONE_ALREADY_TEXT;
    case 'not_in_shortlist':
      return CHAT_CHOICE_NOT_IN_LIST_TEXT;
    case 'no_identity':
      return CHAT_CHOICE_IDENTITY_TEXT;
    case 'stale_button':
    case 'no_open_ask':
      return CHAT_CHOICE_STALE_TEXT;
  }
}

/**
 * Отказ после «Готово»; `null` - выбор записан кодом, дальше агент (как в прежнем насосе:
 * возобновление или новый ход). Агент фиксирует выбор и рассылает запросы.
 */
const CHOICE_DONE_REFUSALS: Record<ChoiceDoneOutcome['kind'], string | null> = {
  finalized: null,
  already_done: null,
  nothing_selected: CHAT_CHOICE_NOTHING_TEXT,
  no_identity: CHAT_CHOICE_IDENTITY_TEXT,
  stale_button: CHAT_CHOICE_STALE_TEXT,
  no_open_ask: CHAT_CHOICE_STALE_TEXT,
};

/** Отказ после кнопки замены КП; `null` - решение записано. */
const QUOTE_REPLACE_REFUSALS: Record<QuoteReplaceOutcome['kind'], string | null> = {
  approved: null,
  already_approved: null,
  unknown_offer: CHAT_QUOTE_REPLACE_UNKNOWN_TEXT,
  expired: CHAT_QUOTE_REPLACE_UNKNOWN_TEXT,
  wrong_thread: CHAT_QUOTE_REPLACE_THREAD_TEXT,
  no_identity: CHAT_QUOTE_REPLACE_IDENTITY_TEXT,
};

/** Что сказать человеку после нажатия кнопки «к какой заявке отнести письмо». */
function routeOutcomeText(outcome: RouteOutcome, title: string | null): string {
  // Заявку называем по названию; id сотруднику не показывается.
  const name = title === null ? 'выбранной заявке' : `заявке «${title}»`;
  switch (outcome.kind) {
    case 'assigned':
      return `Письмо отнесено к ${name}: оно попадёт в сбор ответов по ней.`;
    case 'already_assigned':
      return `Письмо уже отнесено к ${name}, решение не меняется.`;
    case 'unknown_mail':
      return CHAT_ROUTE_UNKNOWN_MAIL_TEXT;
    case 'unknown_request':
      return CHAT_ROUTE_UNKNOWN_REQUEST_TEXT;
    case 'wrong_thread':
      return CHAT_ROUTE_THREAD_TEXT;
    case 'no_identity':
      return CHAT_ROUTE_IDENTITY_TEXT;
  }
}

/** Что сказать после нажатия кнопки подтверждения данных из интернета. */
function webOutcomeText(outcome: Awaited<ReturnType<typeof recordWebConfirmation>>): string {
  switch (outcome.kind) {
    case 'recorded':
      return outcome.decision === 'confirmed' ? CHAT_WEB_CONFIRMED_TEXT : CHAT_WEB_REJECTED_TEXT;
    case 'already_decided':
      return CHAT_WEB_ALREADY_TEXT;
    case 'unknown_request':
      return CHAT_WEB_UNKNOWN_TEXT;
    case 'wrong_thread':
      return CHAT_WEB_THREAD_TEXT;
    case 'no_identity':
      return CHAT_WEB_IDENTITY_TEXT;
  }
}

/** Кнопка выбора поставщика: подтверждение копит код, агента не запускаем (R4-AGT-1). */
const pickButton = chatButtonHandler<string>({
  prefix: PICK_PREFIX,
  replay: 'auto',
  parse: parsePickButton,
  async handle(target, context) {
    const runtime = pragmatikaRuntime();
    if (runtime === undefined) return 'project_not_ready';
    const refused = await guardScenario(context, ruleOf(PICK_PREFIX));
    if (refused !== null) return refused;
    const outcome = await recordChoiceButton(runtime.state, runtime.clock, {
      supplierId: target,
      userId: context.userId,
      threadId: context.threadId,
    });
    const token = splitPickTarget(target)?.token ?? '';
    await context.say(await pickOutcomeText(runtime.state, context.threadId, token, outcome));
    return outcome.kind === 'stale_button' ? 'choice_stale_button' : `choice_${outcome.kind}`;
  },
});

/**
 * Кнопка «Готово»: код завершает накопленный выбор и только после этого запускается агент
 * (`context.runAgent`: возобновление или новый ход) с тем же вводом, что и в прежнем насосе: он
 * фиксирует выбор (`recordSelection` берёт набор из уже завершённого выбора) и рассылает
 * запросы. Повтор «Готово» при открытом вопросе (прошлый ход не дошёл до записи) запускает
 * агента снова; внутри одного нажатия второй вызов `runAgent` платформа гасит сама.
 */
const pickDoneButton: ChatButtonHandler = {
  prefix: PICK_DONE_PREFIX,
  replay: 'auto',
  async handle(buttonId, context) {
    const token = parsePickDoneButton(buttonId);
    if (token === null) return null;
    const runtime = pragmatikaRuntime();
    if (runtime === undefined) return null;
    const refused = await guardScenario(context, ruleOf(PICK_DONE_PREFIX));
    if (refused !== null) return refused;
    const outcome = await recordChoiceDone(runtime.state, runtime.clock, {
      token,
      userId: context.userId,
      threadId: context.threadId,
    });
    const refusal = CHOICE_DONE_REFUSALS[outcome.kind];
    const code = outcome.kind === 'stale_button' ? 'choice_stale_button' : `choice_${outcome.kind}`;
    if (refusal !== null) {
      await context.say(refusal);
      return code;
    }
    await context.runAgent(`Нажата кнопка: ${buttonId}`);
    return code;
  },
};

/** Ввод агенту после разрешённой замены КП: тот же текст, что был в прежнем насосе. */
export function quoteReplaceAgentInput(
  outcome: Extract<QuoteReplaceOutcome, { kind: 'approved' | 'already_approved' }>,
): string {
  return (
    `Менеджер разрешил заменить КП поставщика ${outcome.supplierId} по заявке ` +
    `${outcome.requestId} ответом ${outcome.replyId}. Вызови readSupplierReplies, затем ` +
    `recordQuote с sourceRef=${outcome.replyId} (только данные из этого ответа), затем ` +
    'compareQuotes и sendQuoteSummary.'
  );
}

/**
 * Кнопка «заменить КП на ответ N» (старые сообщения): подтверждение пишет код (тред, срок 24 ч,
 * ответ, одноразово), затем агент записывает КП из этого ответа.
 */
const quoteReplaceButton = chatButtonHandler<string>({
  prefix: QUOTE_REPLACE_PREFIX,
  replay: 'auto',
  parse: parseQuoteReplaceButton,
  async handle(token, context) {
    const runtime = pragmatikaRuntime();
    if (runtime === undefined) return 'project_not_ready';
    const refused = await guardScenario(context, ruleOf(QUOTE_REPLACE_PREFIX));
    if (refused !== null) return refused;
    const outcome = await approveQuoteReplacement(runtime.state, runtime.clock, {
      token,
      userId: context.userId,
      threadId: context.threadId,
    });
    const code = `quote_replace_${outcome.kind}`;
    if (outcome.kind !== 'approved' && outcome.kind !== 'already_approved') {
      await context.say(QUOTE_REPLACE_REFUSALS[outcome.kind] ?? CHAT_QUOTE_REPLACE_UNKNOWN_TEXT);
      return code;
    }
    await context.runAgent(quoteReplaceAgentInput(outcome));
    return code;
  },
});

/** Кнопка «к какой заявке отнести письмо»: привязку пишет код, агента не запускаем. */
const routeButton = chatButtonHandler<NonNullable<ReturnType<typeof parseRouteButton>>>({
  prefix: ROUTE_PREFIX,
  replay: 'auto',
  parse: parseRouteButton,
  async handle(press, context) {
    const runtime = pragmatikaRuntime();
    if (runtime === undefined) return 'project_not_ready';
    const refused = await guardScenario(context, ruleOf(ROUTE_PREFIX));
    if (refused !== null) return refused;
    const outcome = await assignSupplierMail(runtime.state, runtime.clock, {
      ...press,
      userId: context.userId,
      threadId: context.threadId,
    });
    const title =
      outcome.kind === 'assigned' || outcome.kind === 'already_assigned'
        ? await storedRequestTitle(runtime.state, outcome.requestId)
        : null;
    await context.say(routeOutcomeText(outcome, title));
    return outcome.kind === 'assigned' ? 'supplier_mail_assigned' : `supplier_mail_${outcome.kind}`;
  },
});

/** Подтверждение данных из интернета для документа: сценарий только «Подготовки документов». */
const webConfirmButton = chatButtonHandler<NonNullable<ReturnType<typeof parseWebConfirmButton>>>({
  prefix: WEB_CONFIRM_PREFIX,
  replay: 'auto',
  parse: parseWebConfirmButton,
  async handle(press, context) {
    const runtime = pragmatikaRuntime();
    if (runtime === undefined) return 'project_not_ready';
    const refused = await rejectForeign(context, DOCUMENTS_AGENT_ID);
    if (refused !== null) return refused;
    const outcome = await recordWebConfirmation(runtime.state, runtime.clock, {
      ...press,
      userId: context.userId,
      threadId: context.threadId,
    });
    await context.say(webOutcomeText(outcome));
    return outcome.kind === 'recorded' ? `document_web_${outcome.decision}` : outcome.kind;
  },
});

/**
 * Кнопки карточек и пачек поставщиков. Порядок (отказ закрывает): личность -> запрос известен
 * -> право `suppliers.confirm_card` под агентом запроса -> сценарий этого помощника -> сервис
 * (тред, владелец, срок, повтор). Повтор после сбоя хода только вручную: часть действий пишет в
 * общую базу.
 */
type SupplierCardPress = NonNullable<ReturnType<typeof parseSupplierCardButton>>;
const supplierCardButton = chatButtonHandler<SupplierCardPress>({
  prefix: SUPPLIER_CARD_PREFIX,
  replay: 'manual',
  parse: parseSupplierCardButton,
  async handle(press, context) {
    const cards = pragmatikaRuntime()?.supplierCards;
    if (cards === undefined) {
      // Карточки выключены: кнопка из старого сообщения больше не действует.
      await context.say(CHAT_BUTTON_STALE_TEXT);
      return 'button_unknown';
    }
    if (context.userId === '') {
      await context.say(CHAT_SUPPLIER_CARD_IDENTITY_TEXT);
      return 'supplier_card_no_identity';
    }
    const ref = await cards.buttons.lookup(press.token);
    if (ref === null) {
      await context.say(CHAT_SUPPLIER_CARD_UNKNOWN_TEXT);
      return 'supplier_card_unknown_request';
    }
    // Личная заметка пишется только в связку нажавшего и в общую базу не попадает: право на
    // подтверждение карточек для неё не требуется.
    if (ref.kind !== 'pair_note') {
      const verdict = await context.check(ACTION_CONFIRM_SUPPLIER_CARD, ref.agentId);
      if (!verdict.allowed) {
        // Справочник руководителей недоступен: временный сбой, а не «вы не руководитель».
        const unavailable = verdict.reason === 'directory_unavailable';
        await context.say(
          unavailable ? CHAT_ACCESS_CHECK_UNAVAILABLE_TEXT : CHAT_SUPPLIER_CARD_DENIED_TEXT,
        );
        return deniedCode(verdict);
      }
    }
    const foreign = await rejectForeign(context, ref.agentId);
    if (foreign !== null) return foreign;
    // Личность и тред - из события канала, не из текста кнопки и не от модели.
    const identity = { token: press.token, userId: context.userId, threadId: context.threadId };
    const outcome =
      press.action === 'cancel'
        ? await cards.buttons.cancel(identity)
        : await cards.buttons.press({ ...identity, action: press.action });
    await context.say(supplierCardOutcomeText(outcome));
    return `supplier_card_${outcome.kind}`;
  },
});

/** Кнопки проекта в порядке разбора (префиксы не повторяются и не занимают платформенные). */
export const PROJECT_BUTTONS: readonly ChatButtonHandler[] = [
  pickDoneButton,
  pickButton,
  routeButton,
  quoteReplaceButton,
  webConfirmButton,
  supplierCardButton,
  retiredPriceJumpButton,
];

/**
 * Текст входящего сообщения сотрудника агенту «Подготовка документов» (`chat.onIncoming`).
 * Платформа зовёт хук для принятого события `message` (доступ разрешён, приветствие
 * отправлено) с реальным текстом до псевдонимизации; по записи код проверяет, что реквизит в
 * документе прислал сам сотрудник. Служебное событие без автора не пишется. Сбой записи хук
 * не ловит: платформа сама пишет `chat_hook_failed` с кодом, ход агента не ломается.
 */
export const projectOnIncoming: ChatIncomingHook = async (event, services) => {
  if (services.agentId !== DOCUMENTS_AGENT_ID || event.userId === '') return;
  await noteEmployeeMessage(services.state, event.threadId, event.text);
};

/** Содержимое файла для разбора: диск читаем целиком, только если разборщик не умеет по пути. */
async function bytesOf(file: ChatFile, runtime: PragmatikaRuntime): Promise<Uint8Array> {
  const parser = runtime.supplierCards?.deps.parser;
  if (file.disk !== undefined && parser?.parseFile !== undefined) return file.content;
  return file.disk === undefined ? file.content : readFile(file.disk.path);
}

/**
 * Загрузка поставщиков файлом-шаблоном: отчёт по строкам и запрос подтверждения пачки строит
 * `importSuppliersFile` (без модели; содержимое файла в ход агента не попадает). `null` - это не
 * шаблон (или карточки выключены, или разбор не удался до признания шаблоном): файл идёт
 * прежним путём. Сбой ПОСЛЕ признания шаблоном прежним путём не идёт: в файле ПДн контактов.
 */
export const supplierFileHandler: ChatFileHandler = {
  async handle(file, context) {
    const runtime = pragmatikaRuntime();
    const cards = runtime?.supplierCards;
    if (runtime === undefined || cards === undefined) return null;
    if (!isSupplierImportCandidate(file.name)) return null;
    if (context.userId === '') {
      await context.say(CHAT_SUPPLIER_CARD_IDENTITY_TEXT);
      return 'supplier_import_no_identity';
    }
    try {
      const outcome = await importSuppliersFile(cards.deps, {
        agentId: context.agentId,
        threadId: context.threadId,
        userId: context.userId,
        fileName: file.name,
        content: await bytesOf(file, runtime),
        disk: file.disk,
      });
      return outcome.kind === 'not_template' ? null : `supplier_import_${outcome.kind}`;
    } catch (error) {
      if (error instanceof SupplierImportFailedError) {
        // Шаблон распознан: ни приёма файлов, ни модели. В журнал - только код причины.
        context.log('supplier_import_failed', { code: error.causeCode });
        await context.say(CHAT_SUPPLIER_IMPORT_FAILED_TEXT);
        return SUPPLIER_IMPORT_FAILED_CODE;
      }
      // Разбор не удался (сервис документов недоступен, повреждённый файл): прежний путь файла.
      context.log('supplier_import_failed', { code: error instanceof Error ? error.name : 'x' });
      return null;
    }
  },
};

/** Действия кнопок приветствия: ответ без модели. */
export const PROJECT_GREETING_ACTIONS: Readonly<Record<string, GreetingActionHandler>> = {
  'supplier-help': async (context) => {
    await context.say(SUPPLIER_HELP_TEXT);
    return 'supplier_help';
  },
  'supplier-template': async (context) => {
    const cards = pragmatikaRuntime()?.supplierCards;
    if (cards === undefined) return null;
    try {
      const template = await cards.loadTemplate();
      await context.say(CHAT_SUPPLIER_TEMPLATE_TEXT);
      await context.sendFile({
        name: template.fileName,
        mimeType: template.mimeType,
        content: template.bytes,
      });
    } catch (error) {
      context.log('supplier_template_failed', { code: error instanceof Error ? error.name : 'x' });
      await context.say(CHAT_SUPPLIER_TEMPLATE_FAILED_TEXT);
      return 'supplier_template_failed';
    }
    return 'supplier_template';
  },
};

/**
 * Реестр обращений: кто из сотрудников пишет какому агенту (нужен плановому мониторингу, у
 * которого нет списка сотрудников бота). Раньше запись вёл насос чата проекта; насос платформы
 * её не ведёт, поэтому запись делается здесь, на каждом ходе агента. Только идентификаторы;
 * запись не чаще раза в сутки. Сбой реестра ход не ломает.
 */
async function noteEmployeeContact(
  runtime: PragmatikaRuntime,
  threadId: string,
  agentId: string,
): Promise<void> {
  const binding = parseBindingThread(threadId);
  if (binding === null) return;
  try {
    await recordEmployeeContact(
      runtime.state,
      runtime.clock,
      { threadId, userId: binding.userId, botId: binding.botId },
      agentId,
    );
  } catch {
    // Реестр вторичен: ход агента важнее записи о нём.
  }
}

/**
 * Блоки состояния хода агента «Поиск поставщика»: активная заявка треда и открытое предложение
 * завести карточки по письмам. Блоки независимы: сбой одного (в журнал - только код) не отнимает
 * другой. У остальных агентов блоков нет.
 */
export const projectStateBlock: ChatStateBlock = async (threadId, agentId) => {
  const runtime = pragmatikaRuntime();
  if (runtime === undefined) return null;
  await noteEmployeeContact(runtime, threadId, agentId);
  if (agentId !== ORDER_CALC_AGENT_ID) return null;
  const active = await activeRequestBlocks(runtime.orderCalc, threadId);
  const blocks: SystemContextBlock[] = [...active];
  if (runtime.mailProposals !== undefined) {
    const offer = await openMailProposalBlock(runtime.mailProposals.deps, threadId);
    if (offer !== null) blocks.push(offer);
  }
  return blocks.length === 0 ? null : blocks;
};
