import { z } from 'zod';
import { DAY_MS } from '../../kit/domain/time';
import { PRICE_MAIL_SUPPLIER_TABLE_LABEL } from '../../kit/domain/price-mail-trigger-phrases';
import {
  PRICE_MAIL_TRIGGER_CHECK_HOUR,
  PRICE_MAIL_TRIGGER_INTERVAL_DAYS,
  PRICE_MAIL_TRIGGER_MAX_AGE_DAYS,
} from '../../kit/domain/monitoring';
import {
  daysBetween,
  bindingThreadId,
  isDomainError,
  isValidBotId,
  isMailboxNotConnectedError,
  localDateKey,
  localHour,
} from '@business-ai/core';
import {
  detectPriceMailTriggers,
  hasSupplierTableAttachment,
  type PriceMailTriggerMatch,
} from '../../kit/domain/price-mail-triggers';
import { type Supplier } from '../../kit/domain/models';
import {
  PRICE_MAIL_ASSESSMENT_REASONS,
  PRICE_MAIL_VERDICTS,
} from '../../kit/ports/price-mail-assessor';
import { type ChatMessage, type InboxMessage } from '@business-ai/core';
import {
  buildSupplierEmailIndex,
  listAllSuppliers,
  suppliersByAddress,
  type SupplierEmailIndex,
} from '../shared/supplier-email-index';
import { buildSupplierNameIndex, type SupplierNameIndex } from '../shared/supplier-name-index';
import {
  failureName,
  hasSlot,
  listEmployees,
  markSlot,
  readLast,
  readState,
  requirePort,
  stableHash,
  writeLast,
  writeState,
} from '@business-ai/core';
import {
  MAIL_TRIGGER_NAMESPACE,
  PRICES_AGENT_ID,
  TRIGGER_CURSOR_NAMESPACE,
  responsibleThread,
  type PricesDeps,
} from './deps';
import { employeeAccessVerdict } from './employee-threads';
import { nameSearchText } from './price-mail-name-text';

/** Писем за один запрос к ящику. */
const TRIGGER_INBOX_PAGE_SIZE = 50;
/**
 * Бюджет времени одного запуска просмотра (на все ящики). Предел по страницам молча обрывал
 * просмотр при потоке писем и уводил курсор за срок давности; по времени - при исчерпании
 * бюджета слот остаётся открытым и следующий тик продолжает с курсора.
 */
const TRIGGER_RUN_BUDGET_MS = 5 * 60_000;
/** Префикс ключа сообщения ответственному об отставании (ключ по суткам). */
const LAG_NOTICE_KEY_PREFIX = 'price-mail-trigger-lag:';
/** Предел длины темы в сообщении (как у темы письма). */
const TRIGGER_SUBJECT_MAX_CHARS = 200;
/** Сколько поставщиков с одним адресом перечисляется в сообщении. */
const TRIGGER_SUPPLIERS_LISTED = 5;
/** Управляющие символы и разделители строк: в тему сообщения не попадают. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** Подпись пустой темы. */
const EMPTY_SUBJECT_LABEL = '(без темы)';
/** Префикс ключа идемпотентности сообщения-уведомления. */
const NOTICE_KEY_PREFIX = 'price-mail-trigger:';

/** Предел писем поставщиков с таблицей без триггеров на оценку за прогон (если не задан). */
export const DEFAULT_SUPPLIER_ATTACHMENT_MAX_PER_RUN = 50;

/** Предел оценок моделью за запуск; остаток писем переходит на следующий тик. */
export const DEFAULT_PRICE_MAIL_ASSESS_MAX_PER_RUN = 40;
/**
 * Сколько поставщиков может совпасть по названию, чтобы письмо уведомило: больше одного -
 * слишком неоднозначно (решение владельца 30.10, тест «два поставщика»).
 */
const NAME_MATCH_MAX_SUPPLIERS = 1;
/** Пометка в уведомлении: поставщик определён не по адресу. */
const NAME_MATCH_NOTE =
  ' Поставщик определён по названию в тексте, адрес отправителя не из базы.';
/** Сколько вложений письма разбирается для оценки. */
const ASSESS_ATTACHMENTS_MAX = 3;
/** Сколько знаков текста одного вложения уходит на оценку. */
const ASSESS_ATTACHMENT_MAX_CHARS = 3_000;
/** Сколько знаков текста всех вложений уходит на оценку. */
const ASSESS_ATTACHMENTS_TOTAL_MAX_CHARS = 6_000;

/** Сколько знаков тела письма уходит на оценку (начало письма несёт суть). */
const ASSESS_BODY_MAX_CHARS = 4_000;
/** Сколько ждать ответа оценщика; позже письмо считается значимым (откат к уведомлению). */
const ASSESS_TIMEOUT_MS = 30_000;

/**
 * Запись об уведомлении. Только то, что нужно правилу «одно письмо - одно уведомление» и сроку
 * хранения: идентификаторы и даты, без темы, адреса и текста письма. Кнопок и нажатий нет:
 * агента письмо не запускает. Старые записи с лишними полями читаются (лишнее отбрасывается).
 */
const triggerRecordSchema = z.object({
  token: z.string().min(1),
  userId: z.string().min(1),
  messageId: z.string().min(1),
  createdAt: z.string(),
  /** Уведомление сотруднику отправлено. */
  notifiedAt: z.string().optional(),
  /** Оценка признала письмо незначимым: уведомление не отправлялось и не будет. */
  suppressedAt: z.string().optional(),
});
type TriggerRecord = z.infer<typeof triggerRecordSchema>;

/** Ответ оценщика извне: проверяется, прежде чем ему довериться. */
const assessmentSchema = z.object({
  verdict: z.enum(PRICE_MAIL_VERDICTS),
  reason: z.enum(PRICE_MAIL_ASSESSMENT_REASONS),
});

const cursorSchema = z.object({ cursor: z.string() });

/** Итог запуска просмотра: только счётчики (письма и адреса в итог не попадают). */
export interface PriceMailTriggerRunResult {
  /** `not_configured` - нет ящиков или состояния; `not_due` - не время; `done` - просмотр был. */
  status: 'not_configured' | 'not_due' | 'done';
  /** Сколько сотрудников просмотрено. */
  employees: number;
  /** Сколько уведомлений отправлено. */
  notified: number;
  /** Письма, о которых уже сообщали (повтор задачи). */
  duplicates: number;
  /** Сотрудники без подключённого ящика. */
  notConnected: number;
  /** Письма старше срока. */
  skippedOld: number;
  /** Письма, где поставщик не определён ни по адресу, ни по названию (не читались). */
  skippedForeign: number;
  /** Все просмотренные письма (включая старые и чужие). */
  scanned: number;
  /** Письма, оценённые моделью (вызов оценщика, включая сбои). */
  assessed: number;
  /** Письма, где по названию совпало слишком много поставщиков (не уведомляют). */
  nameAmbiguous: number;
  /** Уведомления, отправленные по совпадению названия (адрес отправителя не из базы). */
  notifiedByName: number;
  /** Письма, отложенные на следующий тик из-за предела оценок за запуск. */
  assessDeferred: number;
  /** Письма от поставщика без триггера. */
  noTrigger: number;
  /** Письма поставщика с таблицей/pdf без триггеров, пущенные на оценку (третий путь). */
  supplierAttachmentMatched: number;
  /** Такие письма, отложенные на следующий тик из-за предела за прогон. */
  supplierAttachmentDeferred: number;
  /** Письма, признанные оценкой незначимыми (уведомление не отправлено). */
  assessedNotRelevant: number;
  /** Письма, по которым оценка не получена (сбой, таймаут, неверный ответ): уведомлены. */
  assessorFailed: number;
  /** Владелец общего ящика без своего треда: просмотр пропущен (уведомлять некого). */
  skippedNoThread: number;
  /** Сотрудники, у которых просмотр завершился ошибкой. */
  failed: number;
  /** Ящики, просмотр которых оборван бюджетом времени (продолжится на следующем тике). */
  lagging: number;
  /**
   * Сотрудники с ящиком без права на агента «Актуализация прайса (ИИ агент)» по политике
   * доступа (не уведомляются).
   */
  skippedDenied: number;
  /** Сотрудники, право которых проверить не удалось (политика недоступна): ждут следующего тика. */
  accessUnavailable: number;
  /** Письма поставщика без содержимого (по ним сообщено «получено без содержимого»). */
  contentOmitted: number;
  /**
   * Ящики, где просмотр остановлен на письме с `allowlist_unavailable`: курсор не двигался,
   * слот не закрыт (список отправителей адаптера временно недоступен).
   */
  allowlistUnavailable: number;
}

/** Параметры просмотра. */
export interface PriceMailTriggerRunOptions {
  /** Пояс бизнеса (`BUSINESS_TIMEZONE`): по нему считаются «сутки» и час проверки. */
  timezone: string;
  /**
   * Предел писем поставщиков с таблицей без триггеров за прогон
   * (`PRICE_MAIL_SUPPLIER_ATTACHMENT_MAX_PER_RUN`); не задан - 50.
   */
  supplierAttachmentMaxPerRun?: number | undefined;
  /** Предел оценок моделью за прогон; не задан - `DEFAULT_PRICE_MAIL_ASSESS_MAX_PER_RUN`. */
  assessMaxPerRun?: number | undefined;
}

/** Сообщение сотруднику: письмо поставщика с таблицей, слов-триггеров в нём нет. */
function buildTableNotice(
  suppliers: readonly Supplier[],
  subject: string,
  receivedAt: Date,
  timezone: string,
): ChatMessage {
  return buildNoticeMessage(
    suppliers,
    subject,
    receivedAt,
    [PRICE_MAIL_SUPPLIER_TABLE_LABEL],
    timezone,
  );
}

/** Адресат уведомления: сотрудник и тред его диалога с ботом «Актуализация прайса (ИИ агент)». */
interface TriggerTarget {
  userId: string;
  threadId: string;
}

function emptyResult(status: PriceMailTriggerRunResult['status']): PriceMailTriggerRunResult {
  return {
    status,
    employees: 0,
    notified: 0,
    duplicates: 0,
    notConnected: 0,
    skippedOld: 0,
    skippedForeign: 0,
    scanned: 0,
    assessed: 0,
    nameAmbiguous: 0,
    notifiedByName: 0,
    assessDeferred: 0,
    noTrigger: 0,
    supplierAttachmentMatched: 0,
    supplierAttachmentDeferred: 0,
    assessedNotRelevant: 0,
    assessorFailed: 0,
    skippedNoThread: 0,
    failed: 0,
    lagging: 0,
    skippedDenied: 0,
    accessUnavailable: 0,
    contentOmitted: 0,
    allowlistUnavailable: 0,
  };
}

/** Текст без управляющих символов, одной строкой, не длиннее `maxChars`. */
function plainText(text: string, maxChars: number): string {
  return text.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** Дата и время в поясе бизнеса: `дд.мм.гггг чч:мм`. */
function formatLocalDateTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')} ${part('hour')}:${part('minute')}`;
}

/**
 * Сообщение сотруднику по шаблону кода: от кого, тема, когда получено, что найдено. Без кнопок:
 * задачу по ценам формулирует сотрудник сам.
 */
function buildNoticeMessage(
  suppliers: readonly Supplier[],
  subject: string,
  receivedAt: Date,
  labels: readonly string[],
  timezone: string,
): ChatMessage {
  const listed = suppliers.slice(0, TRIGGER_SUPPLIERS_LISTED);
  const names = listed.map((item) => `«${plainText(item.name, TRIGGER_SUBJECT_MAX_CHARS)}»`);
  const who = suppliers.length > 1 ? 'поставщиков' : 'поставщика';
  const shownSubject = plainText(subject, TRIGGER_SUBJECT_MAX_CHARS);
  const text =
    `Письмо от ${who} ${names.join(', ')}: тема «${shownSubject || EMPTY_SUBJECT_LABEL}», ` +
    `получено ${formatLocalDateTime(receivedAt, timezone)}. ` +
    `Найдено: ${labels.join(', ')}.`;
  return { text };
}

/**
 * Сообщение о письме поставщика, содержимое которого не загружено и триггеров в теме и именах
 * вложений нет: человеку надо открыть письмо самому. Без кнопок, текст письма не используется.
 */
function buildOmittedNotice(
  suppliers: readonly Supplier[],
  subject: string,
  receivedAt: Date,
  timezone: string,
): ChatMessage {
  const listed = suppliers.slice(0, TRIGGER_SUPPLIERS_LISTED);
  const names = listed.map((item) => `«${plainText(item.name, TRIGGER_SUBJECT_MAX_CHARS)}»`);
  const who = suppliers.length > 1 ? 'поставщиков' : 'поставщика';
  const shownSubject = plainText(subject, TRIGGER_SUBJECT_MAX_CHARS);
  return {
    text:
      `Получено письмо без содержимого от ${who} ${names.join(', ')}: тема ` +
      `«${shownSubject || EMPTY_SUBJECT_LABEL}», получено ` +
      `${formatLocalDateTime(receivedAt, timezone)}. Текст и вложения не загружены, ` +
      'проверьте письмо в почте: в нём может быть прайс.',
  };
}

/** Адресаты просмотра и число владельцев ящика, у которых нет своего треда. */
interface ResolvedTargets {
  targets: TriggerTarget[];
  /** Владелец общего ящика без своего треда (счётчик без текстов и идентификаторов). */
  ownerWithoutThread: number;
  /** Сотрудники с ящиком без права по политике доступа. */
  denied: number;
  /** Сотрудники, право которых проверить не удалось. */
  unavailable: number;
}

/**
 * Адресат уведомления: самый свежий тред сотрудника из реестра обращений, а если сотрудник боту
 * не писал - тред связки по его id Bitrix24 (бот может писать пользователю по id). Нет ни
 * реестра, ни ключа бота - адресата нет (null).
 */
function threadFor(
  deps: PricesDeps,
  userId: string,
  known: ReadonlyMap<string, string>,
): string | null {
  const fromRoster = known.get(userId);
  if (fromRoster !== undefined) return fromRoster;
  if (deps.botId === undefined || !isValidBotId(deps.botId)) return null;
  return bindingThreadId({ botId: deps.botId, userId });
}

/**
 * Адресаты просмотра: ВСЕ сотрудники с подключённым ящиком (список даёт каталог ящиков), у
 * которых есть право на агента по политике доступа. Реестр обращений не условие, он лишь
 * подсказывает уже известный тред. Каталог без списка ящиков (`employeeIds` не реализован) -
 * прежнее поведение: только сотрудники реестра. Владелец общего ящика без адресата
 * пропускается (тема письма не уходит в тред ответственного).
 */
async function resolveTargets(
  deps: PricesDeps,
  state: NonNullable<PricesDeps['state']>,
): Promise<ResolvedTargets> {
  const roster = new Map<string, { threadId: string; lastSeenAt: string }>();
  for (const contact of await listEmployees(state, PRICES_AGENT_ID)) {
    const known = roster.get(contact.userId);
    // Один сотрудник в нескольких тредах: уведомление идёт в самый свежий.
    if (known === undefined || known.lastSeenAt < contact.lastSeenAt) {
      roster.set(contact.userId, { threadId: contact.threadId, lastSeenAt: contact.lastSeenAt });
    }
  }
  const threads = new Map([...roster].map(([userId, { threadId }]) => [userId, threadId]));
  const listed = deps.mailboxes?.employeeIds?.();
  const userIds = listed === undefined ? [...roster.keys()] : [...listed];
  const targets: TriggerTarget[] = [];
  let ownerWithoutThread = 0;
  let denied = 0;
  let unavailable = 0;
  for (const userId of userIds) {
    const threadId = threadFor(deps, userId, threads);
    if (threadId === null) {
      if (userId === deps.mailboxOwnerUserId) ownerWithoutThread += 1;
      continue;
    }
    // Право проверяется заново на каждом просмотре (политика и каталог меняются).
    const verdict = await employeeAccessVerdict(deps, userId);
    if (verdict === 'allowed') targets.push({ userId, threadId });
    else if (verdict === 'denied') denied += 1;
    else unavailable += 1;
  }
  return { targets, ownerWithoutThread, denied, unavailable };
}

/** Контекст просмотра одного запуска. */
interface ScanContext {
  deps: PricesDeps;
  state: NonNullable<PricesDeps['state']>;
  /** Адреса текущей страницы писем -> поставщики; перестраивается на каждой странице. */
  index: SupplierEmailIndex;
  now: Date;
  timezone: string;
  stats: PriceMailTriggerRunResult;
  /** Оценщик писем (необязателен), берётся из зависимостей один раз за запуск. */
  assessor: PricesDeps['mailAssessor'];
  /** Предел писем третьего пути за прогон. */
  supplierAttachmentMax: number;
  /** Предел оценок моделью за прогон. */
  assessMax: number;
  /** Индекс названий поставщиков: строится один раз за запуск. */
  names: SupplierNameIndex;
}

/** Разобрать одно письмо ящика: решить, нужно ли уведомление, и отправить его. */
async function scanMessage(
  scan: ScanContext,
  target: TriggerTarget,
  message: InboxMessage,
): Promise<'ok' | 'hold' | 'limit'> {
  const { deps, state, stats } = scan;
  stats.scanned += 1;
  const receivedMs = Date.parse(message.receivedAt);
  const ageMs = scan.now.getTime() - receivedMs;
  if (Number.isNaN(receivedMs) || ageMs > PRICE_MAIL_TRIGGER_MAX_AGE_DAYS * DAY_MS) {
    stats.skippedOld += 1;
    return 'ok';
  }
  // Подлинность отправителя не проверяется (решение владельца 30.10): поставщик определяется по
  // адресу из базы либо по названию из базы в тексте письма.
  let suppliers = suppliersByAddress(scan.index, message.from);
  let viaName = false;
  if (suppliers.length === 0) {
    const named = scan.names.find(nameSearchText(message));
    if (named.length > NAME_MATCH_MAX_SUPPLIERS) {
      stats.nameAmbiguous += 1;
      return 'ok';
    }
    // Без оценщика совпадение названия ничем не подтверждается: по названию не уведомляем.
    if (named.length === 0 || scan.assessor === undefined) {
      stats.skippedForeign += 1;
      return 'ok';
    }
    suppliers = named;
    viaName = true;
  }
  // Список отправителей адаптера недоступен: письмо не прочитано по причине сбоя, а не потому,
  // что в нём нет триггера. Курсор за ним не двигаем (R7-05): следующий тик прочитает снова.
  if (message.contentOmitted === 'allowlist_unavailable') return 'hold';
  const omitted = message.contentOmitted !== undefined;
  // Содержимое пропущено: тема и имена вложений (из `attachmentNames` предпросмотра) всё равно
  // известны, по ним и ищем.
  const matches = detectPriceMailTriggers({
    subject: message.subject,
    body: message.body,
    attachmentNames: [
      ...message.attachments.map((file) => file.fileName),
      ...(message.attachmentNames ?? []),
    ],
  });
  // Третий путь: письмо известного поставщика с таблицей или pdf идёт на оценку и без слов.
  const tableOnly =
    matches.length === 0 &&
    !omitted &&
    hasSupplierTableAttachment([
      ...message.attachments.map((file) => file.fileName),
      ...(message.attachmentNames ?? []),
    ]);
  if (matches.length === 0 && !omitted && !tableOnly) {
    stats.noTrigger += 1;
    return 'ok';
  }
  // Письмо чужого адреса без признаков и без содержимого модели не уйдёт: уведомлять нечем.
  if (viaName && matches.length === 0 && !tableOnly) {
    stats.noTrigger += 1;
    return 'ok';
  }
  const token = stableHash([target.userId, message.id]);
  const existing = await readState(state, MAIL_TRIGGER_NAMESPACE, token, triggerRecordSchema);
  if (existing?.notifiedAt !== undefined || existing?.suppressedAt !== undefined) {
    stats.duplicates += 1;
    return 'ok';
  }
  // Предел оценок: сверх него курсор стоит, письмо ждёт следующий тик (`notifyLag` скажет).
  if (scan.assessor !== undefined && (matches.length > 0 || tableOnly)) {
    if (stats.assessed >= scan.assessMax) {
      stats.assessDeferred += 1;
      return 'limit';
    }
  }
  // Предел считается только для новых писем; сверх него курсор стоит, письмо ждёт следующий тик.
  if (tableOnly) {
    if (stats.supplierAttachmentMatched >= scan.supplierAttachmentMax) {
      stats.supplierAttachmentDeferred += 1;
      return 'limit';
    }
    stats.supplierAttachmentMatched += 1;
  }
  const nowIso = scan.now.toISOString();
  const record: TriggerRecord = existing ?? {
    token,
    userId: target.userId,
    messageId: message.id,
    createdAt: nowIso,
  };
  // Оценка только поверх кодового фильтра: отправитель подтверждён, признак найден. Письмо без
  // содержимого и без признака (omitted) модели не уходит.
  const needsAssessment = matches.length > 0 || tableOnly;
  if (needsAssessment && !(await isWorthNotifying(scan, message, matches, suppliers, viaName))) {
    // Запись гасит повторную оценку того же письма при повторе просмотра.
    await writeState(state, MAIL_TRIGGER_NAMESPACE, token, { ...record, suppressedAt: nowIso });
    stats.assessedNotRelevant += 1;
    return 'ok';
  }
  // Порядок: запись -> сообщение -> `notifiedAt`. Сбой между шагами даёт повторную отправку
  // с тем же ключом (канал её не дублирует), а не потерю уведомления.
  await writeState(state, MAIL_TRIGGER_NAMESPACE, token, record);
  const notice = tableOnly
    ? buildTableNotice(suppliers, message.subject, new Date(receivedMs), scan.timezone)
    : matches.length === 0
      ? buildOmittedNotice(suppliers, message.subject, new Date(receivedMs), scan.timezone)
      : buildNoticeMessage(
          suppliers,
          message.subject,
          new Date(receivedMs),
          matches.map((item) => item.label),
          scan.timezone,
        );
  if (omitted) stats.contentOmitted += 1;
  const sent = viaName ? { ...notice, text: notice.text + NAME_MATCH_NOTE } : notice;
  await deps.chat.reply(target.threadId, sent, `${NOTICE_KEY_PREFIX}${token}`);
  await writeState(state, MAIL_TRIGGER_NAMESPACE, token, { ...record, notifiedAt: nowIso });
  stats.notified += 1;
  if (viaName) stats.notifiedByName += 1;
  return 'ok';
}

/**
 * Текст вложений для оценки: первые `ASSESS_ATTACHMENTS_MAX` вложений разбирает парсер
 * документов, у каждого и в сумме текст обрезается по лимитам. Вложение, которое не
 * разобралось (формат, скан без текста), пропускается: оценка идёт по остальному.
 */
async function attachmentTextOf(deps: PricesDeps, message: InboxMessage): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for (const file of message.attachments.slice(0, ASSESS_ATTACHMENTS_MAX)) {
    if (total >= ASSESS_ATTACHMENTS_TOTAL_MAX_CHARS) break;
    try {
      const parsed = await deps.parser.parse(file.fileName, file.bytes);
      if (parsed.needsOcr) continue;
      const left = ASSESS_ATTACHMENTS_TOTAL_MAX_CHARS - total;
      const room = Math.min(ASSESS_ATTACHMENT_MAX_CHARS, left);
      const text = parsed.text.slice(0, room);
      parts.push(`[${file.fileName}]\n${text}`);
      total += text.length;
    } catch {
      // Вложение не разобралось: оценка по теме, тексту и именам вложений.
    }
  }
  return parts.join('\n');
}

/**
 * Оценка письма моделью поверх кодового фильтра. `false` - только вердикт `not_relevant`.
 * Нет оценщика, ошибка, таймаут и неверный ответ - `true` (безопасный откат: кодовый фильтр уже
 * сработал, письмо не скрываем). В журнал идут только код и имя класса ошибки: текст ошибки
 * мог бы нести фрагмент письма.
 */
async function isWorthNotifying(
  scan: ScanContext,
  message: InboxMessage,
  matches: readonly PriceMailTriggerMatch[],
  suppliers: readonly Supplier[],
  matchedByName: boolean,
): Promise<boolean> {
  const { assessor } = scan;
  if (assessor === undefined) return true;
  scan.stats.assessed += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Сигнал уходит оценщику: по таймауту запрос к модели отменяется, а не остаётся висеть.
  const controller = new AbortController();
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error('assessor_timeout');
        controller.abort(timeoutError);
        reject(timeoutError);
      }, ASSESS_TIMEOUT_MS);
    });
    // Разбор вложений и сама оценка идут под одним таймаутом.
    const assess = async (): Promise<unknown> =>
      assessor.assess(
        {
          subject: message.subject,
          body: message.body.slice(0, ASSESS_BODY_MAX_CHARS),
          attachmentNames: [
            ...message.attachments.map((file) => file.fileName),
            ...(message.attachmentNames ?? []),
          ],
          triggerIds: matches.map((item) => item.id),
          supplierName: suppliers.map((item) => item.name).join('; '),
          matchedByName,
          attachmentText: await attachmentTextOf(scan.deps, message),
        },
        { signal: controller.signal },
      );
    const answer = await Promise.race([assess(), timeout]);
    return assessmentSchema.parse(answer).verdict !== 'not_relevant';
  } catch (error) {
    scan.stats.assessorFailed += 1;
    scan.deps.log?.('price_mail_assess_failed', { code: failureName(error) });
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Просмотреть ящик одного сотрудника постранично; курсор сохраняется после каждой страницы.
 * Возвращает `lagging`, если бюджет времени запуска исчерпан раньше конца ящика.
 */
async function scanMailbox(
  scan: ScanContext,
  target: TriggerTarget,
  deadlineMs: number,
): Promise<'complete' | 'lagging' | 'held' | 'limited'> {
  const { deps, state } = scan;
  const mailboxes = requirePort(deps.mailboxes, 'почта сотрудников');
  const mailbox = await mailboxes.forEmployee(target.userId);
  const saved = await readState(state, TRIGGER_CURSOR_NAMESPACE, target.userId, cursorSchema);
  let cursor = saved?.cursor ?? '';
  for (;;) {
    if (deps.clock.now().getTime() >= deadlineMs) return 'lagging';
    // Без anySender адаптер не качает тело писем от адресов вне списка поставщиков, и поиск
    // поставщика по названию в тексте письма с чужого адреса не имел бы текста.
    const page = await mailbox.fetchNew(cursor, TRIGGER_INBOX_PAGE_SIZE, { anySender: true });
    // Поставщики ищутся по адресам страницы (единое правило «адрес -> поставщик»), не по
    // перечню с лимитом: поставщик из «хвоста» большой базы не теряется.
    scan.index = await buildSupplierEmailIndex(
      deps.suppliers,
      page.messages.map((message) => message.from),
    );
    for (const message of page.messages) {
      // Бюджет проверяется перед каждым письмом: оценка письма может занимать до таймаута,
      // а курсор страницы не сохранён - повтор безопасен (замеченные письма закрыты записями).
      if (deps.clock.now().getTime() >= deadlineMs) return 'lagging';
      // Письмо без списка отправителей: страница и курсор остаются как были (повтор безопасен:
      // об уже замеченных письмах закрыто записями уведомлений).
      const outcome = await scanMessage(scan, target, message);
      if (outcome === 'hold') return 'held';
      // Предел третьего пути: курсор не двигаем, остальное в следующий тик.
      if (outcome === 'limit') return 'limited';
    }
    const moved = page.nextCursor !== cursor;
    cursor = page.nextCursor;
    await writeState(state, TRIGGER_CURSOR_NAMESPACE, target.userId, { cursor });
    if (page.messages.length < TRIGGER_INBOX_PAGE_SIZE || !moved) return 'complete';
  }
}

/**
 * Сообщение ответственному: просмотр отстаёт или письма пропущены по сроку. Только счётчики,
 * без тем, адресов и имён. Ключ по суткам: при частых тиках сообщение одно. Сбой отправки
 * просмотр не роняет.
 */
async function notifyLag(
  deps: PricesDeps,
  stats: PriceMailTriggerRunResult,
  dateKey: string,
): Promise<void> {
  const parts: string[] = [];
  if (stats.lagging > 0) {
    parts.push(`ящиков, просмотр которых не успел за отведённое время: ${stats.lagging}`);
  }
  if (stats.skippedOld > 0) {
    parts.push(
      `писем старше ${PRICE_MAIL_TRIGGER_MAX_AGE_DAYS} суток пропущено без уведомления: ` +
        `${stats.skippedOld}`,
    );
  }
  if (stats.assessDeferred > 0) {
    parts.push(`писем, отложенных из-за предела оценок за проход: ${stats.assessDeferred}`);
  }
  if (parts.length === 0) return;
  const text =
    'Просмотр писем о ценах отстаёт, часть уведомлений может быть потеряна: ' +
    `${parts.join('; ')}. Просмотр продолжится на следующем проходе.`;
  try {
    await deps.chat.reply(
      responsibleThread(deps),
      { text },
      `${LAG_NOTICE_KEY_PREFIX}${dateKey}`,
    );
  } catch {
    // Сообщение вторично: итог запуска и журнал тика всё равно несут те же счётчики.
  }
}

/**
 * Просмотр ящиков сотрудников на письма о ценах (раз в `PRICE_MAIL_TRIGGER_INTERVAL_DAYS`
 * суток, не раньше `PRICE_MAIL_TRIGGER_CHECK_HOUR` по поясу бизнеса). Решает код: словарь
 * триггеров и шаблон сообщения без кнопок; агент по письму не запускается. Необязательная оценка
 * модели (`mailAssessor`) работает только поверх кодового фильтра и решает,
 * уведомлять ли о письме; при её сбое уведомление уходит. Письма не помечаются обработанными;
 * курсор свой, на каждый ящик. Подлинность отправителя не проверяется: читаются письма от
 * адресов из базы поставщиков и письма, где в тексте названа компания из базы (ровно одна, и
 * только при настроенной оценке: она подтверждает совпадение). Об одном письме - одно
 * уведомление (токен от сотрудника и письма).
 * Сбой ящика одного сотрудника не мешает остальным; после обхода первая временная
 * ошибка пробрасывается, слот дня не ставится, повтор безопасен. Непереносимая доменная ошибка
 * (отозван пароль) только считается в `failed`, слот закрывается. Запуск ограничен по времени:
 * при отставании слот остаётся открытым, ответственному уходит сообщение. Сотрудники
 * без права по политике доступа не уведомляются; ящики всех подключённых сотрудников
 * просматриваются независимо от реестра обращений.
 */
export async function runPriceMailTriggers(
  deps: PricesDeps,
  options: PriceMailTriggerRunOptions,
): Promise<PriceMailTriggerRunResult> {
  const state = deps.state;
  if (deps.mailboxes === undefined || state === undefined) return emptyResult('not_configured');
  const now = deps.clock.now();
  const today = localDateKey(now, options.timezone);
  if (localHour(now, options.timezone) < PRICE_MAIL_TRIGGER_CHECK_HOUR) {
    return emptyResult('not_due');
  }
  const last = await readLast(state, 'price-mail-triggers');
  const intervalPassed =
    last === null || daysBetween(last.dateKey, today) >= PRICE_MAIL_TRIGGER_INTERVAL_DAYS;
  if (!intervalPassed || (await hasSlot(state, 'price-mail-triggers', today))) {
    return emptyResult('not_due');
  }

  const stats = emptyResult('done');
  const { targets, ownerWithoutThread, denied, unavailable } = await resolveTargets(deps, state);
  stats.employees = targets.length;
  stats.skippedNoThread = ownerWithoutThread;
  stats.skippedDenied = denied;
  stats.accessUnavailable = unavailable;
  // Пока адресатов нет (ящики не подключены, нет права), слот не закрываем: иначе первый тик
  // отложил бы просмотр на весь интервал. Индекс поставщиков без адресатов не строим.
  if (targets.length === 0) return stats;
  const scan: ScanContext = {
    deps,
    state,
    index: new Map(),
    now,
    timezone: options.timezone,
    stats,
    assessor: deps.mailAssessor,
    supplierAttachmentMax:
      options.supplierAttachmentMaxPerRun ?? DEFAULT_SUPPLIER_ATTACHMENT_MAX_PER_RUN,
    assessMax: options.assessMaxPerRun ?? DEFAULT_PRICE_MAIL_ASSESS_MAX_PER_RUN,
    // Индекс названий один на запуск: письма сверяются с ним, база не опрашивается на каждое.
    names: buildSupplierNameIndex(await listAllSuppliers(deps.suppliers)),
  };
  const errors: unknown[] = [];
  const deadlineMs = now.getTime() + TRIGGER_RUN_BUDGET_MS;
  for (const target of targets) {
    try {
      const outcome = await scanMailbox(scan, target, deadlineMs);
      if (outcome === 'lagging') stats.lagging += 1;
      if (outcome === 'held') stats.allowlistUnavailable += 1;
    } catch (error) {
      if (isMailboxNotConnectedError(error)) {
        stats.notConnected += 1;
      } else {
        stats.failed += 1;
        // Непереносимая доменная ошибка (отозван пароль, нет папки) на повторе не пройдёт:
        // она не должна держать слот открытым и гонять обход всех ящиков каждый тик.
        // Временные и неожиданные ошибки пробрасываются - слот остаётся открытым.
        if (!isDomainError(error) || error.retryable) errors.push(error);
      }
    }
  }
  const [firstError] = errors;
  if (firstError !== undefined) throw firstError;
  await notifyLag(deps, stats, today);
  // Отставание или непроверенное право: слот не закрываем, следующий тик продолжит с курсора.
  if (
    stats.lagging > 0 ||
    stats.accessUnavailable > 0 ||
    stats.allowlistUnavailable > 0 ||
    stats.supplierAttachmentDeferred > 0 ||
    stats.assessDeferred > 0
  ) {
    return stats;
  }
  // Сначала граница интервала, затем слот: сбой между записями оставляет слот открытым, и
  // повтор безопасен (об уже замеченных письмах закрыто записями уведомлений).
  await writeLast(state, 'price-mail-triggers', { dateKey: today });
  await markSlot(state, 'price-mail-triggers', today, now);
  return stats;
}
