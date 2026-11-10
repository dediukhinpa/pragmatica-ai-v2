import {
  DomainError,
  formatDays,
  formatDaysGenitive,
  isMailboxNotConnectedError,
  isWorkingDay,
  localDateKey,
  pluralRu,
  localHour,
  startOfLocalDay,
} from '@business-ai/core';
import {
  ORDER_DIGEST_HOUR,
  ORDER_DIGEST_MAX_ORDERS_LISTED,
  ORDER_DIGEST_OPEN_MAX_DAYS,
} from '../../kit/domain/monitoring';
import type { InboxSource } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { hasSlot, markSlot, stableHash } from '@business-ai/core';
import { SENT_NAMESPACE, STATE_SCAN_MAX_PAGES, STATE_SCAN_PAGE, type OrderCalcDeps } from './deps';
import {
  CHANNEL_NAMES,
  daysSince,
  isOrderOpen,
  loadOrderProgress,
  sentSupplierIds,
  type OrderProgress,
  type SupplierProgress,
} from './order-progress';
import { ingestInbox } from './reply-ingest';
import { isSnoozed, recordDigestShown } from './reminder-reply';
import { labelsOf, requestLabel, titledRequest, type TitledRequest } from './request-title';
import { loadProposal, orderRecipient, sentAtFor, sentSchema, type SentRecord } from './state';

/** Обязанность мониторинга, под которой хранится слот сводки. */
const DIGEST_DUTY = 'orders-digest';
/** Префикс ключа сообщения чата: `order-digest:<локальная дата>:<отпечаток треда>`. */
const DIGEST_KEY_PREFIX = 'order-digest';
/** Пометка к поставщику без названия в справочнике (идентификатор не показываем). */
const UNKNOWN_SUPPLIER_NAME = 'поставщик без названия';
/**
 * Первая строка сообщения: утро сотрудника начинается с плана на день (пожелание клиента,
 * этап 125), а не с выгрузки по заявкам.
 */
const HEADLINE = 'План на день:';
/** Первый пункт плана: за этим сотрудник и открывает сводку. */
const CHECK_REPLIES_ITEM = '1. Проверьте, ответили ли поставщики по вашим запросам цен:';
/** Второй пункт плана: коротко, что уже известно по каждой заявке. */
const DETAILS_ITEM = '2. Что известно по этим заявкам:';

/** Просьба сотруднику уточнить статус (ТЗ, разд. 6): ответ мог прийти не только по почте. */
const STATUS_CHECK_FOOTER =
  'Проверьте, пожалуйста, статус по этим заявкам: ответ мог прийти в мессенджере или по телефону.';

/** Статус ящика владельца заявки: нет подключения либо чтение не удалось. */
type MailboxIssue = 'not_connected' | 'unreadable';

/** Итог запуска сводки. */
export interface DigestRunResult {
  /**
   * `not_due` - выходной или раньше 9:00 локально; `already_done` - за сегодня уже выполнено;
   * `sent` - сообщения отправлены; `nothing_to_report` - открытых заказов нет.
   */
  status: 'not_due' | 'already_done' | 'sent' | 'nothing_to_report';
  /** Сколько сообщений (по одному на тред владельца) отправлено. */
  messages: number;
  /** Сколько открытых заказов попало в сводку (вместе со старыми, названными числом). */
  orders: number;
}

/** Параметры запуска: часовой пояс бизнеса и предел возраста открытого заказа. */
export interface OrdersDigestOptions {
  timezone: string;
  /**
   * Сколько дней с отправки запроса заказ показывается отдельной строкой
   * (`ORDER_DIGEST_OPEN_MAX_DAYS`); старше - одной строкой «и N заказов старше N дней».
   * По умолчанию `ORDER_DIGEST_OPEN_MAX_DAYS` (14).
   */
  openMaxDays?: number;
}

/** Открытый заказ сводки. */
interface DigestOrder {
  progress: OrderProgress;
  threadId: string;
  /** Дней с первой подготовки/отправки запроса. */
  ageDays: number;
  /** Старше предела: в сводке только числом. */
  stale: boolean;
  /** Ящик владельца недоступен: письма могли не прочитаться. */
  mailboxIssue?: MailboxIssue;
}

/** Код ошибки для журнала: код доменной ошибки или `unexpected` (без текста и адресов). */
function errorCodeOf(error: unknown): string {
  return error instanceof DomainError ? error.code : 'unexpected';
}

/** `дд.мм` из ключа даты `YYYY-MM-DD`. */
function shortDate(dateKey: string): string {
  const [, month = '', day = ''] = dateKey.split('-');
  return `${day}.${month}`;
}

/**
 * Записи «запросы подготовлены/отправлены», где хотя бы одному поставщику запрос был до
 * границы.
 */
async function sentBefore(
  deps: OrderCalcDeps,
  before: Date,
): Promise<Array<{ record: SentRecord; supplierIds: string[] }>> {
  const found: Array<{ record: SentRecord; supplierIds: string[] }> = [];
  const entries = stateEntries(deps.state, SENT_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    maxPages: STATE_SCAN_MAX_PAGES,
  });
  for await (const entry of entries) {
    const parsed = sentSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    const record = parsed.data;
    const supplierIds = sentSupplierIds(record).filter((supplierId) => {
      const at = Date.parse(sentAtFor(record, supplierId) ?? '');
      return at < before.getTime();
    });
    if (supplierIds.length > 0) found.push({ record, supplierIds });
  }
  return found.sort((a, b) => a.record.requestId.localeCompare(b.record.requestId));
}

/**
 * Подтянуть свежие письма перед сводкой тем же кодом, что у readSupplierReplies. Возвращает
 * владельцев, чей ящик прочитать не удалось. Сбой чтения не останавливает сводку: сообщение
 * честно говорит, что почту прочитать не удалось.
 */
async function refreshReplies(
  deps: OrderCalcDeps,
  records: ReadonlyArray<SentRecord>,
): Promise<Map<string | undefined, MailboxIssue>> {
  const unreadable = new Map<string | undefined, MailboxIssue>();
  const { mailboxes } = deps;
  if (mailboxes === undefined) {
    // Ящиков сотрудников нет: почта не подключена, сводка честно это сообщает.
    for (const record of records) unreadable.set(record.mailboxOwnerId, 'not_connected');
    return unreadable;
  }
  const owners = new Set(records.map((record) => record.mailboxOwnerId));
  for (const owner of owners) {
    // Запись старого формата: чей ящик читать, неизвестно.
    if (owner === undefined) {
      unreadable.set(owner, 'not_connected');
      continue;
    }
    try {
      const inbox: InboxSource = await mailboxes.forEmployee(owner);
      await ingestInbox(deps, { inbox, cursorKey: owner, ownerUserId: owner });
    } catch (error) {
      // Причина в журнал кодом, без адресов и текстов. Ящик, которого у сотрудника нет по
      // замыслу (не в общем доступе ящика агента), - штатный случай (этап 217): отдельное
      // info-событие, иначе каждая такая сводка попадала бы на дашборд «Ошибки». Реальный сбой
      // чтения подключённого ящика остаётся ошибкой.
      if (isMailboxNotConnectedError(error)) {
        deps.log?.('order_digest_mailbox_not_connected', {});
        unreadable.set(owner, 'not_connected');
      } else {
        deps.log?.('order_digest_mailbox_unreadable', { code: errorCodeOf(error) });
        unreadable.set(owner, 'unreadable');
      }
    }
  }
  return unreadable;
}

/**
 * Открытые заказы: запросы подготовлены/отправлены до сегодняшнего дня, заказ не закрыт, и есть
 * поставщик без КП и без отказа. Ответ из любого канала (почта, телефон, мессенджер) не закрывает
 * заказ: закрывает его КП, отказ или решение сотрудника.
 */
async function buildOrders(
  deps: OrderCalcDeps,
  items: ReadonlyArray<{ record: SentRecord; supplierIds: string[] }>,
  options: Required<OrdersDigestOptions>,
): Promise<DigestOrder[]> {
  const now = deps.clock.now();
  // Один поставщик встречается в нескольких заявках: имя читаем один раз за прогон (кэш
  // живёт только в этом вызове, поэтому переименование поставщика между сводками видно сразу).
  const names = new Map<string, string>();
  const open: Array<{ record: SentRecord; supplierIds: string[] }> = [];
  const snoozed = new Set<string>();
  const todayKey = localDateKey(now, options.timezone);
  for (const item of items) {
    try {
      // Заявка, отложенная сотрудником в ответ на напоминание (этап 226), в сводку до даты не
      // попадает, но почту по ней читаем: ответ поставщика нужно записать, а не потерять до
      // даты напоминания. Поэтому отложенность смотрим при выводе, а не до чтения ящиков.
      // Без включённого ответа на напоминание отметок нет и проверка не нужна.
      if (
        deps.reminderReply !== undefined &&
        (await isSnoozed(deps, item.record.requestId, todayKey))
      ) {
        snoozed.add(item.record.requestId);
      }
      const progress = await loadOrderProgress(
        deps,
        item.record.requestId,
        item.record,
        item.supplierIds,
        names,
        UNKNOWN_SUPPLIER_NAME,
      );
      if (isOrderOpen(progress)) open.push(item);
    } catch (error) {
      // Повреждённая запись одной заявки не останавливает сводку по остальным.
      deps.log?.('order_digest_order_failed', { code: errorCodeOf(error) });
    }
  }
  const unreadable =
    open.length === 0 ? new Map() : await refreshReplies(deps, open.map((i) => i.record));
  const orders: DigestOrder[] = [];
  for (const { record, supplierIds } of open) {
    if (snoozed.has(record.requestId)) continue;
    // Письма могли прийти при чтении ящика: ход пересобирается после него.
    const progress = await loadOrderProgress(
      deps,
      record.requestId,
      record,
      supplierIds,
      names,
      UNKNOWN_SUPPLIER_NAME,
    );
    const proposal = await loadProposal(deps, record.requestId);
    const mailboxIssue = unreadable.get(record.mailboxOwnerId);
    const ageDays =
      progress.firstSentAt === undefined
        ? 0
        : daysSince(progress.firstSentAt, now, options.timezone);
    orders.push({
      progress,
      threadId: await orderRecipient(deps, record.requestId, proposal),
      ageDays,
      stale: ageDays > options.openMaxDays,
      ...(mailboxIssue === undefined ? {} : { mailboxIssue }),
    });
  }
  return orders.sort(
    (a, b) =>
      (a.progress.firstSentAt ?? '').localeCompare(b.progress.firstSentAt ?? '') ||
      a.progress.requestId.localeCompare(b.progress.requestId),
  );
}

/** Пометка про ящик: почты нет или она не читается, статус проверяется вручную. */
const MAILBOX_NOTES: Record<MailboxIssue, string> = {
  not_connected: 'Почта не подключена: проверьте статус вручную.',
  unreadable: 'Не удалось прочитать почту: проверьте статус вручную.',
};

/** Статус одного поставщика: ответил (канал, дата), КП, либо «нет ответа N дней». */
function supplierStatus(supplier: SupplierProgress, today: Date, timezone: string): string {
  const parts: string[] = [];
  if (supplier.declined) parts.push('отказался давать КП');
  else if (supplier.replies.length > 0) {
    const channels = [...new Set(supplier.replies.map((reply) => CHANNEL_NAMES[reply.channel]))];
    const last = supplier.replies[supplier.replies.length - 1]?.at;
    const date = last === undefined ? '' : `, ${shortDate(localDateKey(new Date(last), timezone))}`;
    parts.push(`ответил (${channels.join(', ')}${date})`);
  }
  if (supplier.quoteRecorded) parts.push('КП записано');
  else if (supplier.replies.length > 0 && !supplier.declined) parts.push('КП ещё не записано');
  if (parts.length === 0 && supplier.requestAt !== undefined) {
    const days = daysSince(supplier.requestAt, today, timezone);
    parts.push(
      days > 0
        ? `нет ответа ${formatDays(days)}`
        : 'запрос подготовлен сегодня',
    );
  }
  return `${supplier.name}: ${parts.join(', ')}.`;
}

/** Подписи заявок треда: название, а при одинаковых названиях - с датой («от 28.10»). */
async function labelsFor(
  deps: OrderCalcDeps,
  orders: readonly DigestOrder[],
): Promise<Map<string, string>> {
  const titled: TitledRequest[] = [];
  for (const order of orders) {
    const entry = await titledRequest(deps, order.progress.requestId);
    if (entry !== null) titled.push(entry);
  }
  const labels = labelsOf(titled);
  for (const order of orders) {
    const { requestId } = order.progress;
    const entry = titled.find((candidate) => candidate.requestId === requestId);
    // Одинаковых среди открытых нет: дату может требовать закрытая или новая заявка сотрудника.
    if (!labels.has(requestId) || labels.get(requestId) === entry?.title) {
      labels.set(requestId, await requestLabel(deps, requestId));
    }
  }
  return labels;
}

/** Строка сводки по одной заявке: что подготовили и статус каждого поставщика, коротко. */
function orderLine(order: DigestOrder, label: string, today: Date, timezone: string): string {
  const { progress } = order;
  const suppliers = progress.suppliers.filter((supplier) => supplier.requestAt !== undefined);
  const verb = progress.legacySent ? 'отправили запросы' : 'подготовили запросы';
  const since =
    progress.firstSentAt === undefined
      ? ''
      : ` с ${shortDate(localDateKey(new Date(progress.firstSentAt), timezone))}`;
  const parts = [`${label}: ${verb}${since}.`];
  for (const supplier of suppliers) parts.push(supplierStatus(supplier, today, timezone));
  return `• ${parts.join(' ')}`;
}

/** Заявки, которые сводка перечисляет отдельными строками (остальные - числом). */
function listedOrders(orders: readonly DigestOrder[]): DigestOrder[] {
  return orders.filter((order) => !order.stale).slice(0, ORDER_DIGEST_MAX_ORDERS_LISTED);
}

/**
 * Текст сообщения по шаблону кода: план на день. Пункт 1 - названия заявок, по которым ждём
 * поставщиков; пункт 2 - статус по каждой. Названия поставщиков и заявок, без адресов, ФИО и
 * внутренних идентификаторов.
 */
function digestText(
  orders: readonly DigestOrder[],
  labels: ReadonlyMap<string, string>,
  today: Date,
  options: Required<OrdersDigestOptions>,
): string {
  const fresh = orders.filter((order) => !order.stale);
  const stale = orders.length - fresh.length;
  const shown = listedOrders(orders);
  const labelOf = (order: DigestOrder): string =>
    labels.get(order.progress.requestId) ?? 'заявка без названия';
  const rest = fresh.length - shown.length;
  const tail: string[] = [];
  if (rest > 0) tail.push(`• и ещё ${rest} заявок`);
  if (stale > 0) {
    tail.push(
      `• и ${stale} ${pluralRu(stale, ['заказ', 'заказа', 'заказов'])} старше ` +
        formatDaysGenitive(options.openMaxDays),
    );
  }
  const issues = new Set(orders.map((order) => order.mailboxIssue).filter((i) => i !== undefined));
  // Почта недоступна: «нет ответа» относится к данным системы, письма могли не прочитаться.
  const notes = [...issues].map((issue) => MAILBOX_NOTES[issue]);
  const plan =
    shown.length === 0
      ? []
      : [
          CHECK_REPLIES_ITEM,
          ...shown.map((order) => `- ${labelOf(order)}`),
          DETAILS_ITEM,
          ...shown.map((order) => orderLine(order, labelOf(order), today, options.timezone)),
        ];
  // Просьба проверить статус стоит всегда: ответ мог прийти не только по почте.
  return [HEADLINE, ...plan, ...tail, ...notes, STATUS_CHECK_FOOTER].join('\n');
}

/**
 * Запомнить, что сводка показала в треде, чтобы ответ «да, ответили» связался с этими заявками
 * (этап 226). Сбой записи не ломает сводку: сообщение уже ушло, теряется только справка.
 */
async function rememberShown(
  deps: OrderCalcDeps,
  threadId: string,
  shown: {
    orders: readonly DigestOrder[];
    labels: ReadonlyMap<string, string>;
    now: Date;
    today: string;
  },
): Promise<void> {
  if (deps.reminderReply === undefined) return;
  const listed = new Set(listedOrders(shown.orders));
  try {
    await recordDigestShown(deps, threadId, {
      dateKey: shown.today,
      at: shown.now.toISOString(),
      // Все открытые заявки сводки: на строки с числом («и ещё N», «старше N дней») тоже
      // могут ответить; перечисленные идут первыми и помечены.
      orders: shown.orders
        .map((order) => ({ order, listed: listed.has(order) }))
        .sort((a, b) => Number(b.listed) - Number(a.listed))
        .map(({ order, listed: isListed }) => ({
          requestId: order.progress.requestId,
          label: shown.labels.get(order.progress.requestId) ?? 'заявка без названия',
          listed: isListed,
        })),
    });
  } catch (error) {
    deps.log?.('order_digest_shown_failed', { code: errorCodeOf(error) });
  }
}

/**
 * Утренняя сводка по заказам (ТЗ, разд. 6; решение владельца 27.10.2026): каждый рабочий день в
 * 9:00 по часовому поясу бизнеса сотруднику приходят ВСЕ открытые заказы: запросы подготовлены
 * или отправлены, а у выбранного поставщика нет ни КП, ни отказа, и заказ не закрыт. По каждому
 * поставщику: ответил (почта, телефон, мессенджер, дата), КП записано, либо «нет ответа N дней».
 * Работает без почты: ответ мог быть устным; почта читается, только если подключена. Заказы
 * старше `openMaxDays` с отправки перечисляются одной строкой с числом. Просьба проверить статус
 * стоит всегда. Один заказ - одна строка (названием заявки, не её id), одно сообщение на тред владельца заявки в день; ключ
 * сообщения содержит локальную дату, поэтому повтор задачи не дублирует его. Модель не
 * участвует.
 *
 * Праздничного календаря нет: в праздничный будний день сводка тоже уходит.
 * @throws Error если отправка хотя бы в один тред не удалась (после попытки во все; слот при
 *   этом не ставится, повтор закрыт ключами сообщений).
 */
export async function runOrdersDigest(
  deps: OrderCalcDeps,
  options: OrdersDigestOptions,
): Promise<DigestRunResult> {
  const { timezone } = options;
  const resolved: Required<OrdersDigestOptions> = {
    timezone,
    openMaxDays: options.openMaxDays ?? ORDER_DIGEST_OPEN_MAX_DAYS,
  };
  const now = deps.clock.now();
  const today = localDateKey(now, timezone);
  const done = (status: DigestRunResult['status'], messages = 0, orders = 0): DigestRunResult => ({
    status,
    messages,
    orders,
  });
  if (!isWorkingDay(today) || localHour(now, timezone) < ORDER_DIGEST_HOUR) return done('not_due');
  if (await hasSlot(deps.state, DIGEST_DUTY, today)) return done('already_done');

  // Запросы, подготовленные сегодня, в сводку попадут завтра: сегодня сотрудник их ещё видел.
  const items = await sentBefore(deps, startOfLocalDay(today, timezone));
  const orders = items.length === 0 ? [] : await buildOrders(deps, items, resolved);

  let messages = 0;
  const failures: unknown[] = [];
  const byThread = new Map<string, DigestOrder[]>();
  for (const order of orders) {
    byThread.set(order.threadId, [...(byThread.get(order.threadId) ?? []), order]);
  }
  for (const [threadId, threadOrders] of [...byThread].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const labels = await labelsFor(deps, threadOrders);
      const text = digestText(threadOrders, labels, now, resolved);
      await deps.chat.reply(
        threadId,
        { text },
        `${DIGEST_KEY_PREFIX}:${today}:${stableHash(threadId)}`,
      );
      messages += 1;
      await rememberShown(deps, threadId, { orders: threadOrders, labels, now, today });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    deps.log?.('order_digest_send_failed', { failed: failures.length, sent: messages });
    throw failures[0];
  }
  // Слот ставится после отправки: сбой оставляет слот открытым, повтор закрыт ключами сообщений.
  await markSlot(deps.state, DIGEST_DUTY, today, now);
  if (orders.length === 0) return done('nothing_to_report');
  deps.log?.('order_digest_sent', {
    messages,
    orders: orders.length,
    stale: orders.filter((order) => order.stale).length,
  });
  return done('sent', messages, orders.length);
}
