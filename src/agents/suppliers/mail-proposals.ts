import { z } from 'zod';
import { DAY_MS } from '../../kit/domain/time';
import {
  PRICE_MAIL_TRIGGER_CHECK_HOUR,
  PRICE_MAIL_TRIGGER_INTERVAL_DAYS,
} from '../../kit/domain/monitoring';
import {
  bindingThreadId,
  CancelledError,
  daysBetween,
  isDomainError,
  isMailboxNotConnectedError,
  isValidBotId,
  localDateKey,
  localHour,
} from '@business-ai/core';
import { type InboxMessage, type MailboxDirectory } from '@business-ai/core';
import { type SupplierMailClassification } from '../../kit/ports/supplier-mail-classifier';
import {
  failureName,
  hasSlot,
  listEmployees,
  markSlot,
  readLast,
  readState,
  stableHash,
  writeLast,
  writeState,
} from '@business-ai/core';
import { DomainIndex, findMatch, validInn } from './card-enrichment';
import { extractSupplierFromText } from './extract-supplier';
import { autoEnrichExisting } from './mail-proposal-auto-enrich';
import {
  BODY_MAX_CHARS,
  SYSTEM_SENDERS,
  SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS,
  classifyWithTimeout,
  domainOf,
  fieldsOf,
  isCorporateDomain,
  isOwnAddress,
  ownAddressesOf,
  retryLimitOf,
  stripQuotedReply,
  type OwnAddresses,
} from './mail-enrich';
import {
  SUPPLIER_MAIL_PROPOSAL_CURSOR_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_DRAFT_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS,
  SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_QUOTA_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_ROTATION_NAMESPACE,
  ROTATION_KEY,
  closeSupersededProposal,
  displayLabel,
  displaySubject,
  draftSchema,
  lastProposal,
  markSupplierKeys,
  msgSchema,
  pointerKey,
  proposalKey,
  proposalSchema,
  proposalText,
  readSeenSupplier,
  rotationSchema,
  supplierKeysOf,
  type Candidate,
  type Draft,
  type Proposal,
  type ProposalItem,
  type SupplierMailProposalsDeps,
} from './mail-proposal-store';
import { OwnCompanyFilter } from './own-company-filter';

/**
 * Обзор почты сотрудников раз в трое суток (этап 222, пункт 10 списка заказчика от 08.11).
 * Плановая задача (отдельный тип `suppliers.mail-proposals`) читает ящик каждого сотрудника,
 * отбирает кодом письма не от нас и не от известных поставщиков, оценивает их классификатором
 * (порт этапа 220, модель только через псевдонимизацию) и пишет сотруднику ОДНО сообщение:
 * «увидел письма от таких-то компаний, завести карточки?». Карточки здесь не создаются: «да»,
 * «нет» или «только 1 и 3» записывает инструмент `recordMailSupplierProposalDecision` в ходе
 * сотрудника, и только он заводит карточки (код, без вопросов по форме).
 *
 * Без повторов: поставщик (ИНН, домен или нормализованное название) предлагается сотруднику не
 * больше одного раза за всё время, отклонённый - никогда; письмо разбирается один раз.
 *
 * Раз в трое суток - на КАЖДОГО сотрудника: общий слот может оставаться открытым днями (сбой у
 * одного, предел оценок), и без личной границы остальные получали бы предложения ежедневно.
 */

/** Периодичность и час проверки - как у просмотра писем о ценах (раз в 3 суток после 10:00). */
export const SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS = PRICE_MAIL_TRIGGER_INTERVAL_DAYS;
export const SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR = PRICE_MAIL_TRIGGER_CHECK_HOUR;
/** Окно писем: старше письма не разбираются (с запасом над интервалом в три суток). */
export const SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS = 7;
/** Оценок моделью за сутки (как у просмотра писем о ценах). */
export const SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN = 40;
/** Бюджет времени одного тика: при исчерпании слот остаётся открытым. */
const RUN_BUDGET_MS = 5 * 60_000;
/** Писем за один запрос к ящику. */
const MAIL_PAGE_SIZE = 50;
/** Кандидатов в черновике сотрудника: сверх этого письма не разбираются до следующего прохода. */
export const SUPPLIER_MAIL_PROPOSAL_DRAFT_MAX_ITEMS = 100;
/** Автор записей в аудите. */
const AUTHOR = 'supplier-mail-proposals';
/** Ключ слота и границы интервала в состоянии мониторинга. */
const DUTY = 'supplier-mail-proposals';
/** Действие политики доступа «писать боту-адресату». */
const CHAT_ACCESS_ACTION = 'chat.message';
/** Префикс ключа идемпотентности сообщения сотруднику. */
const SEND_KEY_PREFIX = 'supplier-mail-proposal:';

const cursorSchema = z.object({ cursor: z.string() });
const quotaSchema = z.object({ used: z.number().int().min(0) });

/** Параметры прохода. */
export interface SupplierMailProposalsOptions {
  /** Пояс бизнеса (`BUSINESS_TIMEZONE`): по нему считаются «сутки» и час проверки. */
  timezone: string;
  /** Раз в сколько суток; не задано - `SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS`. */
  intervalDays?: number | undefined;
  /** Не раньше какого часа по поясу бизнеса; не задано - `SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR`. */
  checkHour?: number | undefined;
  /** Окно писем, суток; не задано - `SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS`. */
  windowDays?: number | undefined;
  /** Оценок моделью за сутки; не задано - `SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN`. */
  maxClassifyPerRun?: number | undefined;
}

/** Почему проход остановился раньше конца ящиков. Слот остаётся открытым при любой причине. */
type ProposalsStop = 'none' | 'limit' | 'lagging' | 'classifier_outage';

/** Итог прохода: только счётчики (письма, адреса и названия в итог не попадают). */
export interface SupplierMailProposalsResult {
  /** `not_configured` - нет адресатов; `not_due` - не время; `done` - проход был. */
  status: 'not_configured' | 'not_due' | 'done';
  stoppedBy: ProposalsStop;
  /** Сотрудники с ящиком и правом, которых обошёл проход. */
  employees: number;
  /** Сотрудники без подключённого ящика (не ошибка). */
  notConnected: number;
  /** Сотрудники без права на агента-адресата или на карточки. */
  skippedDenied: number;
  /** Сотрудники, право которых проверить не удалось: ждут следующего тика. */
  accessUnavailable: number;
  /** Сотрудники без треда для сообщения (не писали боту, ключа бота нет). */
  skippedNoThread: number;
  /** Сотрудники, которым предложение уходило меньше интервала назад: ящик в этот раз не читался. */
  skippedNotDue: number;
  /** Кандидаты, оказавшиеся в базе к моменту отправки (остаток черновика сверен повторно). */
  knownBeforeSend: number;
  /** Открытые пункты прежнего предложения, перенесённые в новое. */
  carriedOver: number;
  /** Сотрудники, у которых проход завершился ошибкой. */
  failed: number;
  scanned: number;
  skippedOld: number;
  skippedOmitted: number;
  skippedSystem: number;
  /** Отправитель - наша компания (в том числе коллеги). */
  skippedOwn: number;
  skippedBulk: number;
  /** Бесплатная почта без ИНН в тексте: организацию не назвать. */
  skippedFreeMail: number;
  /** Письма, разобранные раньше (повторное чтение). */
  duplicates: number;
  /** Поставщик уже предлагался этому сотруднику (отклонённый - тоже). */
  duplicateSuppliers: number;
  /** Поставщик уже есть в базе. */
  known: number;
  classified: number;
  classifierFailed: number;
  /** Письма, закрытые после предела повторов оценки. */
  abandoned: number;
  notSupplier: number;
  /** Письмо поставщика, но названия нет ни у кода, ни (проверенного) у модели. */
  noName: number;
  candidates: number;
  /** Сообщений-предложений отправлено. */
  proposed: number;
  /** Пунктов в отправленных предложениях. */
  proposedItems: number;
  /** Автообогащение существующих карточек (флаг выключен - все нули); только числа. */
  /** Писем поставщиков из базы, отправленных на оценку модели. */
  autoClassified: number;
  /** Карточки, в которые записаны поля. */
  autoEnriched: number;
  /** Записанных полей всего. */
  autoFields: number;
  /** Письма, где нового нет. */
  autoUnchanged: number;
  /** Расхождения с заполненными полями (не записаны). */
  autoConflicts: number;
  /** Отброшено полей вне белого списка (реквизиты, директор, условия оплаты). */
  autoWithheld: number;
  /** Отправитель не доверенный: карточка не менялась. */
  autoUntrusted: number;
  /** Карточка не определена однозначно или не совпала. */
  autoUnmatched: number;
  /** Письмо исчезло или недоступно, предел оценок исчерпан, сбой записи. */
  autoSkipped: number;
}

function emptyResult(status: SupplierMailProposalsResult['status']): SupplierMailProposalsResult {
  return {
    status,
    stoppedBy: 'none',
    employees: 0,
    notConnected: 0,
    skippedDenied: 0,
    accessUnavailable: 0,
    skippedNoThread: 0,
    skippedNotDue: 0,
    knownBeforeSend: 0,
    carriedOver: 0,
    failed: 0,
    scanned: 0,
    skippedOld: 0,
    skippedOmitted: 0,
    skippedSystem: 0,
    skippedOwn: 0,
    skippedBulk: 0,
    skippedFreeMail: 0,
    duplicates: 0,
    duplicateSuppliers: 0,
    known: 0,
    classified: 0,
    classifierFailed: 0,
    abandoned: 0,
    notSupplier: 0,
    noName: 0,
    candidates: 0,
    proposed: 0,
    proposedItems: 0,
    autoClassified: 0,
    autoEnriched: 0,
    autoFields: 0,
    autoUnchanged: 0,
    autoConflicts: 0,
    autoWithheld: 0,
    autoUntrusted: 0,
    autoUnmatched: 0,
    autoSkipped: 0,
  };
}

/** Адресат обзора: сотрудник и тред его диалога с ботом-адресатом. */
interface Target {
  userId: string;
  threadId: string;
}

/** Сотрудник в проходе: адресат, ящик, наши адреса и накопленный черновик. */
interface Employee extends Target {
  mailbox: Awaited<ReturnType<MailboxDirectory['forEmployee']>>;
  own: OwnAddresses;
  draft: Draft;
}

/** Контекст одного прохода. */
interface RunContext {
  deps: SupplierMailProposalsDeps;
  options: SupplierMailProposalsOptions;
  now: Date;
  today: string;
  result: SupplierMailProposalsResult;
  filter: OwnCompanyFilter;
  domains: DomainIndex;
  /** Раз в сколько суток предложение одному сотруднику. */
  intervalDays: number;
  /** Сколько оценок осталось на сегодня к началу тика (0 - квота исчерпана). */
  maxClassify: number;
  classifiedBefore: number;
  /** Сколько раз вызван классификатор в этом тике (успешно или нет). */
  classifyCalls: number;
  /** Оценок письмам известных поставщиков в этом тике (автообогащение; своя граница). */
  autoClassifyCalls: number;
  receivedSince: string;
  windowMs: number;
  deadlineMs: number;
}

/** Как закончился обзор одного ящика. */
type EmployeeOutcome = 'complete' | 'lagging' | 'limit' | 'outage';
/** Что делать после письма; `draft_full` - черновик полон, пора отправлять предложение. */
type MessageStep = 'ok' | 'limit' | 'lagging' | 'outage' | 'draft_full';

/** Бюджет времени тика исчерпан. */
function overBudget(ctx: RunContext): boolean {
  return ctx.deps.clock.now().getTime() >= ctx.deadlineMs;
}

/**
 * Вердикт доступа сотрудника: чат с агентом-адресатом. Права `suppliers.confirm_card` не требуется:
 * предложение получает и подтверждает сам сотрудник, с чьей почты найдены письма (решение
 * владельца 10.11.2026).
 */
async function accessVerdict(
  deps: SupplierMailProposalsDeps,
  userId: string,
): Promise<'allowed' | 'denied' | 'unavailable'> {
  const { access } = deps;
  if (access === undefined) return 'allowed';
  for (const action of [CHAT_ACCESS_ACTION]) {
    const request = { userId, botId: deps.addresseeAgentId, action };
    try {
      if (access.decide === undefined) {
        if (!(await access.isAllowed(request))) return 'denied';
        continue;
      }
      const decision = await access.decide(request);
      if (decision.allowed) continue;
      return decision.reason === 'directory_unavailable' ? 'unavailable' : 'denied';
    } catch {
      return 'unavailable';
    }
  }
  return 'allowed';
}

/**
 * Адресаты обзора: сотрудники с подключённым ящиком (список даёт каталог; нет списка - реестр
 * обращений к агенту-адресату), без списка исключений (решение владельца 09.11). Тред - самый
 * свежий из реестра, а сотруднику, не писавшему боту, - тред связки по ключу бота. Права
 * проверяются заново на каждом проходе.
 */
async function resolveTargets(
  ctx: RunContext,
): Promise<{ targets: Target[]; unavailable: number }> {
  const { deps, result } = ctx;
  const roster = new Map<string, { threadId: string; lastSeenAt: string }>();
  for (const contact of await listEmployees(deps.state, deps.addresseeAgentId)) {
    const known = roster.get(contact.userId);
    if (known === undefined || known.lastSeenAt < contact.lastSeenAt) {
      roster.set(contact.userId, { threadId: contact.threadId, lastSeenAt: contact.lastSeenAt });
    }
  }
  const listed = deps.mailboxes.employeeIds?.();
  // Все ящики из каталога: ящики-источники (info@) каталог в список не отдаёт.
  const userIds = listed === undefined ? [...roster.keys()] : [...listed];
  const targets: Target[] = [];
  let unavailable = 0;
  for (const userId of userIds) {
    const fromRoster = roster.get(userId)?.threadId;
    const threadId =
      fromRoster ??
      (deps.botId !== undefined && isValidBotId(deps.botId)
        ? bindingThreadId({ botId: deps.botId, userId })
        : null);
    if (threadId === null) {
      result.skippedNoThread += 1;
      continue;
    }
    const verdict = await accessVerdict(deps, userId);
    if (verdict === 'allowed') targets.push({ userId, threadId });
    else if (verdict === 'denied') result.skippedDenied += 1;
    else unavailable += 1;
  }
  return { targets, unavailable };
}

/** Записать, сколько оценок потрачено сегодня (до обращения к модели: сбой тоже считается). */
async function countClassification(ctx: RunContext): Promise<void> {
  ctx.classifyCalls += 1;
  await writeState(ctx.deps.state, SUPPLIER_MAIL_PROPOSAL_QUOTA_NAMESPACE, ctx.today, {
    used: ctx.classifiedBefore + ctx.classifyCalls,
  });
}

/** Отметить письмо разобранным. */
function markMessage(
  ctx: RunContext,
  userId: string,
  messageId: string,
  outcome: z.infer<typeof msgSchema>['outcome'],
): Promise<void> {
  return writeState(
    ctx.deps.state,
    SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE,
    stableHash([userId, messageId]),
    { at: ctx.now.toISOString(), outcome },
  );
}

/**
 * Письмо не оценено из-за сбоя, который может пройти: курсор не двигаем, оно разбирается в
 * следующий тик. После предела попыток письмо закрывается (модель сбоит именно на нём).
 */
async function deferLetter(
  ctx: RunContext,
  userId: string,
  messageId: string,
  maxAttempts: number,
): Promise<MessageStep> {
  const key = stableHash([userId, messageId]);
  const known = await readState(
    ctx.deps.state,
    SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE,
    key,
    msgSchema,
  );
  const attempts = (known?.attempts ?? 0) + 1;
  if (attempts >= maxAttempts) {
    ctx.result.abandoned += 1;
    ctx.deps.log?.('supplier_mail_proposals_abandoned', { attempts });
    await markMessage(ctx, userId, messageId, 'skipped');
    return 'ok';
  }
  await writeState(ctx.deps.state, SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE, key, {
    at: ctx.now.toISOString(),
    outcome: 'retry',
    attempts,
  });
  return 'outage';
}

/** Хоть один признак поставщика уже отмечен (предлагался, отклонён, заведён или уже в базе). */
async function anySupplierKeySeen(
  ctx: RunContext,
  emp: Employee,
  keys: readonly string[],
): Promise<boolean> {
  const inDraft = emp.draft.items.some((item) => item.keys.some((key) => keys.includes(key)));
  if (inDraft) return true;
  for (const key of keys) {
    const seen = await readSeenSupplier(ctx.deps.state, key);
    // Автообогащение: отметка «уже в базе» не глушит следующие письма того же поставщика, иначе
    // обогатилась бы только первая переписка. Предлагавшиеся, отклонённые и заведённые - как раньше.
    if (seen !== null && !(ctx.deps.autoEnrich === true && seen.status === 'known')) return true;
  }
  return false;
}

/** Сохранить черновик сотрудника. */
function saveDraft(ctx: RunContext, emp: Employee): Promise<void> {
  return writeState(
    ctx.deps.state,
    SUPPLIER_MAIL_PROPOSAL_DRAFT_NAMESPACE,
    emp.userId,
    emp.draft,
  );
}

/**
 * Поставщик уже в базе: письмо закрыто. Отметка `known` пишется только по ключам отправителя
 * (корпоративный домен): ИНН и названия из текста письма могут принадлежать кому угодно (наша
 * компания, третья фирма в договоре), и отметка по ним глушила бы настоящих поставщиков навсегда.
 */
async function closeKnown(
  ctx: RunContext,
  emp: Employee,
  messageId: string,
  keys: readonly string[],
): Promise<MessageStep> {
  ctx.result.known += 1;
  await markSupplierKeys(ctx.deps.state, keys, 'known', ctx.now);
  await markMessage(ctx, emp.userId, messageId, 'known');
  return 'ok';
}

/** Результат оценки письма: вердикт либо шаг, которым закончилась обработка письма. */
type LetterVerdict = { verdict: SupplierMailClassification } | { step: MessageStep };

/** Оценить письмо моделью: учёт квоты, сбои и противоречивый ответ - как раньше. */
async function classifyLetter(
  ctx: RunContext,
  emp: Employee,
  message: InboxMessage,
  body: string,
  countsAgainstQuota = true,
): Promise<LetterVerdict> {
  const { deps } = ctx;
  const { result } = ctx;
  let verdict: SupplierMailClassification;
  // Оценки писем известных поставщиков (автообогащение) не отнимают квоту поиска новых.
  if (countsAgainstQuota) await countClassification(ctx);
  try {
    verdict = await classifyWithTimeout(deps.classifier, message, body);
  } catch (error) {
    // В журнале только имя ошибки: текст ошибки мог бы нести фрагмент письма.
    result.classifierFailed += 1;
    deps.log?.('supplier_mail_proposals_classify_failed', { code: failureName(error) });
    const limit = retryLimitOf(error);
    if (limit === null) return { step: await skipAfterFailure(ctx, emp, message.id) };
    return { step: await deferLetter(ctx, emp.userId, message.id, limit) };
  }
  // Сведения о поставщике у письма не-поставщика - противоречие, а не вердикт: как сбой.
  if (verdict.hasSupplierInfo && verdict.kind !== 'supplier') {
    result.classifierFailed += 1;
    deps.log?.('supplier_mail_proposals_classify_failed', { code: 'contradictory_answer' });
    return {
      step: await deferLetter(
        ctx,
        emp.userId,
        message.id,
        SUPPLIER_MAIL_INVALID_ANSWER_MAX_ATTEMPTS,
      ),
    };
  }
  return { verdict };
}

/** Предел оценок писем известных поставщиков (автообогащение) за один тик. */
const AUTO_ENRICH_MAX_CLASSIFY_PER_TICK = 20;

/** Параметры закрытия письма известного поставщика. */
interface KnownLetter {
  keys: readonly string[];
  body: string;
  text: string;
  sender: string;
  /** Единственная найденная карточка; нет - сопоставление делает общий узел. */
  supplierId: string | undefined;
  /** Вердикт модели, если письмо уже оценено. */
  verdict?: SupplierMailClassification;
}

/**
 * Письмо известного поставщика. Автообогащение выключено - письмо закрыто как раньше. Включено
 * (решение владельца 10.11.2026) - письмо оценивает модель (в пределах своей границы за тик), а
 * сведения дописывает код в пустые поля карточки без вопросов сотруднику; реквизиты и прочее
 * вне белого списка не пишутся никогда (`mail-proposal-auto-enrich.ts`).
 */
async function closeKnownEnriching(
  ctx: RunContext,
  emp: Employee,
  message: InboxMessage,
  letter: KnownLetter,
): Promise<MessageStep> {
  if (ctx.deps.autoEnrich !== true) return closeKnown(ctx, emp, message.id, letter.keys);
  let verdict = letter.verdict;
  if (verdict === undefined) {
    if (ctx.autoClassifyCalls >= AUTO_ENRICH_MAX_CLASSIFY_PER_TICK || overBudget(ctx)) {
      ctx.result.autoSkipped += 1;
      return closeKnown(ctx, emp, message.id, letter.keys);
    }
    ctx.autoClassifyCalls += 1;
    ctx.result.autoClassified += 1;
    const classified = await classifyLetter(ctx, emp, message, letter.body, false);
    if ('step' in classified) return classified.step;
    ctx.result.classified += 1;
    verdict = classified.verdict;
  }
  if (verdict.kind === 'supplier' && verdict.hasSupplierInfo) {
    await autoEnrichLetter(ctx, emp, message, verdict, letter.supplierId);
  }
  return closeKnown(ctx, emp, message.id, letter.keys);
}

/** Дописать сведения письма в существующую карточку; сбой не роняет обзор ящика. */
async function autoEnrichLetter(
  ctx: RunContext,
  emp: Employee,
  message: InboxMessage,
  verdict: SupplierMailClassification,
  supplierId: string | undefined,
): Promise<void> {
  const { result, deps } = ctx;
  try {
    // Предпросмотр не несёт подписи DKIM и полного текста: для доверия и значений письмо
    // перечитывается целиком, как при ответе сотрудника на предложение.
    const full = await emp.mailbox.getMessage(message.id);
    if (full === null || full.contentOmitted !== undefined) {
      result.autoSkipped += 1;
      return;
    }
    const sender = full.from.toLowerCase();
    const text = [
      `От: ${sender}`,
      `Тема: ${full.subject}`,
      '',
      stripQuotedReply(full.body).slice(0, BODY_MAX_CHARS),
    ].join('\n');
    const fields = fieldsOf({ own: emp.own, filter: ctx.filter }, full, verdict, text);
    const done = await autoEnrichExisting(deps, emp.userId, full, fields, supplierId);
    result.autoConflicts += done.conflicts;
    result.autoWithheld += done.withheld;
    if (done.untrusted) result.autoUntrusted += 1;
    else if (done.kind === 'enriched') {
      result.autoEnriched += 1;
      result.autoFields += done.added;
    } else if (done.kind === 'unchanged') result.autoUnchanged += 1;
    else result.autoUnmatched += 1;
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    result.autoSkipped += 1;
    // В журнале только код ошибки: текст мог бы нести фрагмент письма.
    deps.log?.('supplier_mail_auto_enrich_failed', { code: failureName(error) });
  }
}

/** Разобрать одно письмо ящика: отобрать кодом, оценить моделью, занести в черновик. */
async function scanLetter(
  ctx: RunContext,
  emp: Employee,
  message: InboxMessage,
): Promise<MessageStep> {
  const { result, deps } = ctx;
  if (overBudget(ctx)) return 'lagging';
  result.scanned += 1;
  const receivedMs = Date.parse(message.receivedAt);
  if (Number.isNaN(receivedMs) || ctx.now.getTime() - receivedMs > ctx.windowMs) {
    result.skippedOld += 1;
    return 'ok';
  }
  const known = await readState(
    deps.state,
    SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE,
    stableHash([emp.userId, message.id]),
    msgSchema,
  );
  if ((known !== null && known.outcome !== 'retry') || emp.draft.items.some(
    (item) => item.messageId === message.id,
  )) {
    result.duplicates += 1;
    return 'ok';
  }
  const skip = async (counter: 'skippedOmitted' | 'skippedSystem' | 'skippedOwn' | 'skippedBulk'
    | 'skippedFreeMail'): Promise<MessageStep> => {
    result[counter] += 1;
    await markMessage(ctx, emp.userId, message.id, 'skipped');
    return 'ok';
  };
  // Ящик читается предпросмотром: пометка `preview_only` при заполненном теле - обычное письмо.
  if (message.contentOmitted !== undefined && message.contentOmitted !== 'preview_only') {
    return skip('skippedOmitted');
  }
  const sender = message.from.toLowerCase();
  if (SYSTEM_SENDERS.has(sender.split('@')[0] ?? '')) return skip('skippedSystem');
  if (isOwnAddress(emp.own, sender) || ctx.filter.isOwnText(sender)) return skip('skippedOwn');
  if (message.bulk === true) return skip('skippedBulk');
  const domain = domainOf(sender);
  const corporate = isCorporateDomain(domain);
  const body = stripQuotedReply(message.body).slice(0, BODY_MAX_CHARS);
  const text = [`От: ${sender}`, `Тема: ${message.subject}`, '', body].join('\n');
  const extracted = extractSupplierFromText(text).fields;
  const found = validInn(extracted.inn);
  // ИНН нашей компании в тексте (счёт на нас) отправителя не называет.
  const inn = found !== undefined && ctx.filter.isOwnCode(found) ? undefined : found;
  // Бесплатная почта не называет организацию: нужен хотя бы чужой ИНН в тексте.
  if (!corporate && inn === undefined) return skip('skippedFreeMail');
  // Ранние ключи - только то, что называет отправителя: его корпоративный домен, а у бесплатной
  // почты (домена нет) - очищенный от нашего ИНН. Название из текста письма тут не берётся: оно
  // могло быть чьим угодно, и совпадение с ним закрыло бы настоящего поставщика.
  const early = supplierKeysOf(emp.userId, corporate ? { domain } : { inn });
  if (await anySupplierKeySeen(ctx, emp, early)) {
    result.duplicateSuppliers += 1;
    await markMessage(ctx, emp.userId, message.id, 'duplicate_supplier');
    return 'ok';
  }
  // Поставщик с таким адресом или корпоративным доменом уже в базе: предложение не нужно. Без
  // автообогащения модель не вызывается; с ним письмо оценивается и дополняет карточку.
  const byAddress = await deps.suppliers.findByAddresses([sender]);
  const byDomain = corporate ? await ctx.domains.lookup([domain]) : [];
  if (byAddress.length > 0 || byDomain.length > 0) {
    const foundIds = new Set([...byAddress.map((hit) => hit.supplier.id), ...byDomain]);
    return closeKnownEnriching(ctx, emp, message, {
      keys: corporate ? early : [],
      body,
      text,
      sender,
      // Одна карточка - сопоставление не нужно; несколько - решает общий узел (или ничего не пишет).
      supplierId: foundIds.size === 1 ? [...foundIds][0] : undefined,
    });
  }
  // Черновик полон: сначала уходит предложение (иначе сотрудник застрял бы навсегда).
  if (emp.draft.items.length >= SUPPLIER_MAIL_PROPOSAL_DRAFT_MAX_ITEMS) return 'draft_full';
  if (ctx.classifyCalls >= ctx.maxClassify) return 'limit';
  const classified = await classifyLetter(ctx, emp, message, body);
  if ('step' in classified) return classified.step;
  const { verdict } = classified;
  result.classified += 1;
  if (verdict.kind !== 'supplier' || !verdict.hasSupplierInfo) {
    result.notSupplier += 1;
    await markMessage(ctx, emp.userId, message.id, 'not_supplier');
    return 'ok';
  }
  return addCandidate(ctx, emp, message, verdict, text, { corporate, domain, sender });
}

/** Постоянный отказ оценки (защита ПДн и подобное): письмо пропускается без записи. */
async function skipAfterFailure(
  ctx: RunContext,
  emp: Employee,
  messageId: string,
): Promise<MessageStep> {
  await markMessage(ctx, emp.userId, messageId, 'skipped');
  return 'ok';
}

/** Письмо поставщика: поля кодом, проверка по базе, запись кандидата в черновик. */
async function addCandidate(
  ctx: RunContext,
  emp: Employee,
  message: InboxMessage,
  verdict: SupplierMailClassification,
  text: string,
  origin: { corporate: boolean; domain: string; sender: string },
): Promise<MessageStep> {
  const { result, deps } = ctx;
  const fields = fieldsOf({ own: emp.own, filter: ctx.filter }, message, verdict, text);
  if (fields.name === undefined) {
    result.noName += 1;
    await markMessage(ctx, emp.userId, message.id, 'skipped');
    return 'ok';
  }
  const keys = supplierKeysOf(emp.userId, {
    inn: validInn(fields.inn),
    domain: origin.corporate ? origin.domain : undefined,
    name: fields.name,
  });
  const match = await findMatch(
    {
      name: fields.name,
      inn: validInn(fields.inn),
      emails: (fields.contacts ?? []).flatMap((c) => (c.email === undefined ? [] : [c.email])),
      senderKeys: [origin.sender],
      existingIds: [],
    },
    deps.suppliers,
    ctx.domains,
    { enrichment: true },
  );
  if (match.kind !== 'none') {
    const domainKeys = origin.corporate
      ? supplierKeysOf(emp.userId, { domain: origin.domain })
      : [];
    // Оценка модели уже есть: второй раз не спрашиваем, дополняем найденную карточку.
    return closeKnownEnriching(ctx, emp, message, {
      keys: domainKeys,
      body: '',
      text,
      sender: origin.sender,
      supplierId: match.kind === 'found' ? match.supplierId : undefined,
      verdict,
    });
  }
  if (await anySupplierKeySeen(ctx, emp, keys)) {
    result.duplicateSuppliers += 1;
    await markMessage(ctx, emp.userId, message.id, 'duplicate_supplier');
    return 'ok';
  }
  const checkedInn = validInn(fields.inn);
  const candidate: Candidate = {
    messageId: message.id,
    label: displayLabel(fields.name),
    subject: displaySubject(message.subject),
    receivedAt: message.receivedAt,
    categories: fields.categories ?? [],
    keys,
    sender: origin.sender,
    ...(origin.corporate ? { domain: origin.domain } : {}),
    ...(checkedInn === undefined ? {} : { inn: checkedInn }),
  };
  emp.draft = { ...emp.draft, items: [...emp.draft.items, candidate] };
  // Черновик пишется раньше отметки письма: сбой между ними даёт повтор оценки, а не потерю.
  await saveDraft(ctx, emp);
  await markMessage(ctx, emp.userId, message.id, 'candidate');
  result.candidates += 1;
  return 'ok';
}

/**
 * Ввести записанное предложение в действие: указатель треда, отметки поставщиков «предлагался»
 * и закрытие прежнего неотвеченного предложения (его открытые пункты уже внутри этого). Все шаги
 * идемпотентны: повтор после сбоя безопасен.
 */
async function activateProposal(
  ctx: RunContext,
  proposal: Proposal,
  supersedes: string | undefined,
): Promise<void> {
  const { deps } = ctx;
  await writeState(deps.state, SUPPLIER_MAIL_PROPOSAL_NAMESPACE, pointerKey(proposal.threadId), {
    id: proposal.id,
  });
  for (const item of proposal.items) {
    await markSupplierKeys(deps.state, item.keys, 'proposed', ctx.now, proposal.id);
  }
  if (supersedes !== undefined) {
    await closeSupersededProposal(deps.state, proposal.threadId, supersedes);
  }
}

/**
 * Доставить записанное предложение: ввод в действие, сообщение с ключом по id (канал не
 * дублирует), затем отметка `sentAt` и очистка метки в черновике. Повтор после сбоя шлёт то же
 * предложение.
 */
async function deliverProposal(
  ctx: RunContext,
  emp: Employee,
  taken: NonNullable<Draft['taken']>,
): Promise<void> {
  const { deps } = ctx;
  const key = proposalKey(taken.threadId, taken.id);
  const proposal = await readState(
    deps.state,
    SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
    key,
    proposalSchema,
  );
  if (proposal !== null && proposal.sentAt === undefined) {
    await activateProposal(ctx, proposal, taken.supersedes);
    await deps.chat.reply(
      taken.threadId,
      { text: proposalText(proposal, ctx.options.timezone) },
      `${SEND_KEY_PREFIX}${taken.id}`,
    );
    await writeState(deps.state, SUPPLIER_MAIL_PROPOSAL_NAMESPACE, key, {
      ...proposal,
      sentAt: ctx.now.toISOString(),
    });
    ctx.result.proposed += 1;
    ctx.result.proposedItems += proposal.items.length;
  }
  emp.draft = { items: emp.draft.items, lastProposedOn: ctx.today };
  await saveDraft(ctx, emp);
}

/** Кандидат из пункта прежнего предложения (без номера и статуса). */
function candidateOf(item: ProposalItem): Candidate {
  return {
    messageId: item.messageId,
    label: item.label,
    subject: item.subject,
    receivedAt: item.receivedAt,
    categories: item.categories,
    keys: item.keys,
    ...(item.sender === undefined ? {} : { sender: item.sender }),
    ...(item.domain === undefined ? {} : { domain: item.domain }),
    ...(item.inn === undefined ? {} : { inn: item.inn }),
  };
}

/** Поставщик кандидата уже есть в базе (появился после отбора письма). */
async function knownNow(ctx: RunContext, candidate: Candidate): Promise<boolean> {
  const { suppliers } = ctx.deps;
  if (candidate.sender !== undefined) {
    if ((await suppliers.findByAddresses([candidate.sender])).length > 0) return true;
  }
  if (candidate.domain !== undefined) {
    if ((await ctx.domains.lookup([candidate.domain])).length > 0) return true;
  }
  if (candidate.label === '') return false;
  const match = await findMatch(
    {
      name: candidate.label,
      inn: candidate.inn,
      emails: [],
      senderKeys: candidate.sender === undefined ? [] : [candidate.sender],
      existingIds: [],
    },
    suppliers,
    ctx.domains,
    { enrichment: true },
  );
  return match.kind !== 'none';
}

/** Прежнее доставленное предложение сотрудника, если у него остались открытые пункты. */
async function unansweredProposal(ctx: RunContext, emp: Employee): Promise<Proposal | null> {
  const previous = await lastProposal(ctx.deps.state, emp.threadId);
  if (previous?.sentAt === undefined || previous.userId !== emp.userId) return null;
  return previous.items.some((item) => item.status === 'open') ? previous : null;
}

/**
 * Оформить предложение из черновика: первые `SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS` кандидатов
 * уходят сотруднику, остаток ждёт следующего прохода. Открытые пункты прежнего неотвеченного
 * предложения переносятся в очередь за новыми (свежие письма не вытесняются старым молчанием, а
 * старое не теряется): указатель треда переходит к новому, и без переноса «да» их больше не
 * касалось бы. Перед отправкой каждый кандидат ещё раз сверяется с базой (поставщик мог
 * появиться за время ожидания). Порядок: предложение -> метка в черновике -> (ввод в действие,
 * сообщение). Сбой на любом шаге оставляет метку, и повтор доставляет то же предложение, не
 * создавая второго; прежнее предложение остаётся указателем, пока новое не введено в действие.
 */
async function finalize(ctx: RunContext, emp: Employee): Promise<void> {
  const { deps } = ctx;
  const previous = await unansweredProposal(ctx, emp);
  const carried = (previous?.items ?? [])
    .filter((item) => item.status === 'open')
    .map(candidateOf);
  const take: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const candidate of [...emp.draft.items, ...carried]) {
    if (take.length >= SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS) {
      rest.push(candidate);
    } else if (await knownNow(ctx, candidate)) {
      ctx.result.knownBeforeSend += 1;
      await markSupplierKeys(deps.state, candidate.keys, 'known', ctx.now);
    } else {
      take.push(candidate);
    }
  }
  const keepDate = emp.draft.lastProposedOn === undefined
    ? {}
    : { lastProposedOn: emp.draft.lastProposedOn };
  if (take.length === 0) {
    // Все кандидаты уже в базе: предлагать нечего, прежнее предложение (если было) закрывается.
    emp.draft = { items: rest, ...keepDate };
    await saveDraft(ctx, emp);
    if (previous !== null) await closeSupersededProposal(deps.state, emp.threadId, previous.id);
    return;
  }
  ctx.result.carriedOver += carried.filter((item) => take.includes(item)).length;
  const id = stableHash([emp.userId, ctx.now.toISOString()]);
  const proposal: Proposal = {
    id,
    userId: emp.userId,
    threadId: emp.threadId,
    createdAt: ctx.now.toISOString(),
    unclear: 0,
    unavailable: 0,
    more: rest.length,
    items: take.map((item, index) => ({ ...item, number: index + 1, status: 'open' as const })),
  };
  await writeState(
    deps.state,
    SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
    proposalKey(emp.threadId, id),
    proposal,
  );
  const taken = {
    id,
    threadId: emp.threadId,
    ...(previous === null ? {} : { supersedes: previous.id }),
  };
  emp.draft = { items: rest, taken, ...keepDate };
  await saveDraft(ctx, emp);
  await deliverProposal(ctx, emp, taken);
}

/** Просмотреть ящик сотрудника постранично; курсор сохраняется после каждой страницы. */
async function scanMailbox(
  ctx: RunContext,
  emp: Employee,
): Promise<EmployeeOutcome | 'draft_full'> {
  const { deps } = ctx;
  const saved = await readState(
    deps.state,
    SUPPLIER_MAIL_PROPOSAL_CURSOR_NAMESPACE,
    emp.userId,
    cursorSchema,
  );
  let cursor = saved?.cursor ?? '';
  for (;;) {
    if (overBudget(ctx)) return 'lagging';
    // Предпросмотр (тема и начало текста, без вложений); письма старше окна приходят без текста.
    const page = await emp.mailbox.fetchNew(cursor, MAIL_PAGE_SIZE, {
      anySender: true,
      preview: true,
      receivedSince: ctx.receivedSince,
    });
    for (const message of page.messages) {
      const step = await scanLetter(ctx, emp, message);
      if (step === 'lagging') return 'lagging';
      if (step === 'limit') return 'limit';
      if (step === 'outage') return 'outage';
      if (step === 'draft_full') return 'draft_full';
    }
    const moved = page.nextCursor !== cursor;
    cursor = page.nextCursor;
    await writeState(deps.state, SUPPLIER_MAIL_PROPOSAL_CURSOR_NAMESPACE, emp.userId, { cursor });
    if (page.messages.length === 0 || !moved) return 'complete';
  }
}

/** Подошло ли сотруднику время: предложение ему уходило не меньше интервала суток назад. */
function employeeDue(ctx: RunContext, emp: Employee): boolean {
  const last = emp.draft.lastProposedOn;
  return last === undefined || daysBetween(last, ctx.today) >= ctx.intervalDays;
}

/**
 * Обойти одного сотрудника: недоставленное предложение, новые письма, новое предложение. Раз в
 * интервал - на каждого отдельно: слот прохода общий и может держаться открытым днями (сбой у
 * другого сотрудника, предел оценок), а личная граница не даёт слать предложения ежедневно.
 */
async function processEmployee(ctx: RunContext, target: Target): Promise<EmployeeOutcome> {
  const { deps } = ctx;
  const mailbox = await deps.mailboxes.forEmployee(target.userId);
  const stored = await readState(
    deps.state,
    SUPPLIER_MAIL_PROPOSAL_DRAFT_NAMESPACE,
    target.userId,
    draftSchema,
  );
  const emp: Employee = {
    ...target,
    mailbox,
    own: ownAddressesOf(deps.ownCompanyRequisites, mailbox.address),
    draft: stored ?? { items: [] },
  };
  // Предложение, записанное в прошлый раз, но не доставленное: сначала оно (и при исчерпанной
  // квоте оценок: доставка модель не вызывает).
  if (emp.draft.taken !== undefined) await deliverProposal(ctx, emp, emp.draft.taken);
  if (!employeeDue(ctx, emp)) {
    ctx.result.skippedNotDue += 1;
    return 'complete';
  }
  const outcome = await scanMailbox(ctx, emp);
  ctx.result.employees += 1;
  // Черновик полон: отправляем первые пункты, остальное и непрочитанные письма - в следующий раз.
  if (outcome === 'draft_full') {
    await finalize(ctx, emp);
    return 'complete';
  }
  if (outcome !== 'complete') return outcome;
  if (emp.draft.items.length > 0) await finalize(ctx, emp);
  return 'complete';
}

/**
 * Порядок обхода: начиная с сотрудника, записанного в ротации. Суточная квота оценок общая, и с
 * фиксированным порядком её каждый день выбирали бы первые по списку, а письма остальных
 * старели бы за окном и пропадали.
 */
async function rotated(ctx: RunContext, targets: readonly Target[]): Promise<Target[]> {
  const saved = await readState(
    ctx.deps.state,
    SUPPLIER_MAIL_PROPOSAL_ROTATION_NAMESPACE,
    ROTATION_KEY,
    rotationSchema,
  );
  const start = saved === null ? -1 : targets.findIndex((t) => t.userId === saved.userId);
  return start <= 0 ? [...targets] : [...targets.slice(start), ...targets.slice(0, start)];
}

/**
 * Следующий обход начнётся с сотрудника после того, кто первым упёрся в предел оценок, если
 * в этот тик квота действительно тратилась (иначе ежечасные тики при исчерпанной квоте
 * гоняли бы начало по кругу).
 */
async function advanceRotation(
  ctx: RunContext,
  targets: readonly Target[],
  limited: string | undefined,
): Promise<void> {
  if (limited === undefined || ctx.classifyCalls === 0) return;
  const index = targets.findIndex((t) => t.userId === limited);
  const next = targets[(index + 1) % targets.length];
  if (index < 0 || next === undefined) return;
  await writeState(ctx.deps.state, SUPPLIER_MAIL_PROPOSAL_ROTATION_NAMESPACE, ROTATION_KEY, {
    userId: next.userId,
  });
}

/**
 * Один проход обзора почты сотрудников: раз в `SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS` суток, не
 * раньше `SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR` по поясу бизнеса. Слот дня и граница интервала
 * лежат в состоянии мониторинга. Слот закрывается, когда все ящики прочитаны до конца и
 * предложения доставлены; предел оценок, бюджет времени и сбой модели оставляют его открытым, и
 * следующий тик продолжает с курсора (разобранные письма закрыты отметками, кандидаты лежат в
 * черновике). Сотрудник без ящика - не ошибка. Сбой доставки или записи пробрасывается после
 * обхода остальных (слот не ставится, повтор безопасен).
 */
export async function runSupplierMailProposals(
  deps: SupplierMailProposalsDeps,
  options: SupplierMailProposalsOptions,
): Promise<SupplierMailProposalsResult> {
  const now = deps.clock.now();
  const today = localDateKey(now, options.timezone);
  const checkHour = options.checkHour ?? SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR;
  if (localHour(now, options.timezone) < checkHour) return emptyResult('not_due');
  const last = await readLast(deps.state, DUTY);
  const interval = options.intervalDays ?? SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS;
  const intervalPassed = last === null || daysBetween(last.dateKey, today) >= interval;
  if (!intervalPassed || (await hasSlot(deps.state, DUTY, today))) return emptyResult('not_due');
  // Суточный предел оценок: тик идёт раз в час, пока слот открыт, и без счётчика в состоянии
  // каждый тик получал бы свой предел.
  const dailyLimit = options.maxClassifyPerRun ?? SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN;
  const quota = await readState(
    deps.state,
    SUPPLIER_MAIL_PROPOSAL_QUOTA_NAMESPACE,
    today,
    quotaSchema,
  );
  const classifiedBefore = quota?.used ?? 0;
  // Квота исчерпана - проход всё равно идёт: сорвавшееся предложение доставляется, а сотрудники с
  // дочитанным ящиком получают своё. Оценки при этом не тратятся (`maxClassify` равен нулю).
  const windowMs = (options.windowDays ?? SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS) * DAY_MS;
  const result = emptyResult('done');
  const ctx: RunContext = {
    deps,
    options,
    now,
    today,
    result,
    filter: new OwnCompanyFilter(deps.ownCompanyNames, deps.ownCompanyRequisites),
    domains: new DomainIndex(deps.suppliers),
    intervalDays: interval,
    maxClassify: Math.max(0, dailyLimit - classifiedBefore),
    classifiedBefore,
    classifyCalls: 0,
    autoClassifyCalls: 0,
    receivedSince: new Date(now.getTime() - windowMs).toISOString(),
    windowMs,
    deadlineMs: now.getTime() + RUN_BUDGET_MS,
  };
  const { targets, unavailable } = await resolveTargets(ctx);
  result.accessUnavailable = unavailable;
  // Пока адресатов нет (ящики не подключены, нет права), слот не закрываем: иначе первый тик
  // отложил бы обзор на весь интервал.
  if (targets.length === 0) return result;
  const errors: unknown[] = [];
  let complete = unavailable === 0;
  let limited: string | undefined;
  for (const target of await rotated(ctx, targets)) {
    try {
      const outcome = await processEmployee(ctx, target);
      if (outcome === 'limit') limited ??= target.userId;
      if (outcome !== 'complete') {
        complete = false;
        result.stoppedBy = outcome === 'outage' ? 'classifier_outage' : outcome;
        // Сбой модели касается всех: остальных сотрудников не мучаем до следующего тика.
        if (outcome === 'outage' || outcome === 'lagging') break;
      }
    } catch (error) {
      if (isMailboxNotConnectedError(error)) {
        result.notConnected += 1;
        continue;
      }
      result.failed += 1;
      deps.log?.('supplier_mail_proposals_employee_failed', { code: failureName(error) });
      // Непереносимая доменная ошибка (отозван пароль) на повторе не пройдёт и слот не держит;
      // временные и неожиданные пробрасываются после обхода остальных.
      if (!isDomainError(error) || error.retryable) errors.push(error);
    }
  }
  await advanceRotation(ctx, targets, limited);
  const [firstError] = errors;
  if (firstError !== undefined) throw firstError;
  if (!complete) return result;
  // Сначала граница интервала, затем слот: сбой между записями оставляет слот открытым, и
  // повтор безопасен (письма закрыты отметками, предложения доставляются по метке).
  await writeLast(deps.state, DUTY, { dateKey: today });
  await markSlot(deps.state, DUTY, today, now);
  return result;
}
