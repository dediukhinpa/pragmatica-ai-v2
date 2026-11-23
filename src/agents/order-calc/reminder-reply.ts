import { z } from 'zod';
import {
  DomainError,
  addDays,
  daysBetween,
  employeeOfThread,
  isWorkingDay,
  localDateKey,
  localWeekday,
} from '@business-ai/core';
import { hoursToMs } from '../../kit/domain/time';
import { defineTool, type ToolContext } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { predecessorOf, readState, stableHash, writeState } from '@business-ai/core';
import {
  ORDER_DIGEST_SHOWN_NAMESPACE,
  ORDER_REMINDER_SNOOZE_NAMESPACE,
  type OrderCalcDeps,
} from './deps';
import { assertOrderOwner, type OrderCallerContext } from './order-access';
import { isOrderClosed } from './order-progress';
import { closeOrder, closePendingAt } from './order-status';

/**
 * Ответ сотрудника на утреннее напоминание (этап 226, `ORDER_REMINDER_REPLY_ENABLED`).
 *
 * Почему это нужно: сводку «План на день» отправляет код мимо истории агента, и на ответ
 * «да, ответили» агент относил реплику к последней заявке чата, а не к заявкам напоминания
 * (бой 05.11.2026). Теперь сводка запоминает показанные заявки, агент перед ходом получает
 * справку (список заявок напоминания), а решение «что делать с заказом» принимает
 * МОДЕЛЬ: она вызывает инструмент с действием из закрытого списка. Сопоставления фраз кодом
 * нет; код проверяет допустимость (заявка из напоминания, владелец, даты) и исполняет.
 */

/** Стабильное имя блока хода, когда активной заявки нет (для журнала счётчиков). */
export const REMINDER_BLOCK_ID = 'order_reminder';
/**
 * Сколько часов после сводки ответ ещё считается ответом на неё. Четверо суток: сводка в
 * пятницу утром, ответ в понедельник утром (выходные), плюс запас на раннее утро.
 */
const REMINDER_REPLY_WINDOW_HOURS = 96;
/** Сколько дней вперёд можно попросить «напомнить позже». */
const REMINDER_LATER_MAX_DAYS = 14;
/** Дальше скольки дней откладывать нельзя: заказ не должен выпасть из сводки навсегда. */
const REMINDER_SNOOZE_MAX_DAYS = 60;
/**
 * Сколько заявок сводки хранится в справке. Хранится только список заявок с названием и датой,
 * без текста сообщения: текст сводки живёт в чате, а в хранилище он только раздувал запись.
 */
const REMINDER_SHOWN_MAX_ORDERS = 40;
/** Название дня недели по номеру `localWeekday` (0 - воскресенье). */
const WEEKDAY_NAMES = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
] as const;

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const shownSchema = z.object({
  /** Локальная дата сводки. */
  dateKey: z.string(),
  /** Момент отправки, ISO. */
  at: z.string(),
  /**
   * Открытые заявки сводки: перечисленные строками (`listed`) и упомянутые только числом
   * («и ещё N заявок», «старше N дней»): на такие тоже могут ответить.
   */
  orders: z.array(
    z.object({
      requestId: z.string().min(1),
      label: z.string(),
      listed: z.boolean().default(true),
    }),
  ),
});
export type DigestShown = z.infer<typeof shownSchema>;

const snoozeSchema = z.object({
  /** Заявка скрыта из сводки, пока локальная дата меньше этой. */
  untilDate: dateKeySchema,
  setAt: z.string(),
  by: z.string(),
  action: z.enum(['snooze', 'remind_later']),
});

/**
 * Запомнить, что сводка показала в треде (сводка следующего дня заменяет прежнюю). Повторный
 * прогон сводки в тот же день запись не трогает: сотрудник видел сообщение первого прогона
 * (ключ сообщения не даёт отправить второе), а новое время продлило бы окно ответа.
 */
export async function recordDigestShown(
  deps: Pick<OrderCalcDeps, 'state'>,
  threadId: string,
  shown: DigestShown,
): Promise<void> {
  const previous = await readState(deps.state, ORDER_DIGEST_SHOWN_NAMESPACE, threadId, shownSchema);
  if (previous !== null && previous.dateKey === shown.dateKey) return;
  await writeState(deps.state, ORDER_DIGEST_SHOWN_NAMESPACE, threadId, {
    ...shown,
    orders: shown.orders.slice(0, REMINDER_SHOWN_MAX_ORDERS),
  });
}

/** Последняя сводка треда, если она в пределах окна ответа; иначе null. */
async function loadFreshDigest(
  deps: Pick<OrderCalcDeps, 'state' | 'clock'>,
  threadId: string,
): Promise<DigestShown | null> {
  const shown = await readState(deps.state, ORDER_DIGEST_SHOWN_NAMESPACE, threadId, shownSchema);
  if (shown === null) return null;
  const age = deps.clock.now().getTime() - Date.parse(shown.at);
  return age >= 0 && age <= hoursToMs(REMINDER_REPLY_WINDOW_HOURS) ? shown : null;
}

/** Заявка отложена: сегодняшняя локальная дата раньше даты напоминания. */
export async function isSnoozed(
  deps: Pick<OrderCalcDeps, 'state'>,
  requestId: string,
  todayKey: string,
): Promise<boolean> {
  const snooze = await readState(
    deps.state,
    ORDER_REMINDER_SNOOZE_NAMESPACE,
    requestId,
    snoozeSchema,
  );
  return snooze !== null && todayKey < snooze.untilDate;
}

/** `дд.мм` из ключа даты. */
function shortDate(dateKey: string): string {
  const [, month = '', day = ''] = dateKey.split('-');
  return `${day}.${month}`;
}

/**
 * Заявки сводки, по которым этот вызывающий может что-то сделать: заявка его (проверка
 * владельца та же, что у инструмента) и заказ не закрыт. Иначе справка предлагала бы действия,
 * которые инструмент всё равно откажет (тред менеджера, чужая заявка).
 */
async function actionableOrders(
  deps: OrderCalcDeps,
  shown: DigestShown,
  caller: OrderCallerContext,
): Promise<DigestShown['orders']> {
  const result: DigestShown['orders'] = [];
  for (const order of shown.orders) {
    try {
      await assertOrderOwner(deps, order.requestId, caller);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'access_denied') continue;
      throw error;
    }
    if (!(await isOrderClosed(deps, order.requestId))) result.push(order);
  }
  return result;
}

/**
 * Строки справки о недавнем напоминании для системного блока хода; null - напоминания в окне
 * нет (или флаг выключен, или по нему нечего делать этому сотруднику). Справка идёт вне
 * истории: устаревшая исчезает со следующего хода.
 */
export async function reminderContextLines(
  deps: OrderCalcDeps,
  threadId: string,
): Promise<string[] | null> {
  const settings = deps.reminderReply;
  if (settings === undefined) return null;
  const shown = await loadFreshDigest(deps, threadId);
  if (shown === null) return null;
  // Ход чата ведёт сотрудник треда связки; тред другого формата - инициатор неизвестен, и
  // решающей остаётся проверка владельца в самом инструменте.
  const employee = employeeOfThread(threadId);
  const orders = await actionableOrders(deps, shown, {
    threadId,
    initiator: employee === null ? { kind: 'unknown' } : { kind: 'user', userId: employee },
  });
  if (orders.length === 0) return null;
  const now = deps.clock.now();
  const today = localDateKey(now, settings.timezone);
  const weekday = WEEKDAY_NAMES[localWeekday(now, settings.timezone)] ?? '';
  return [
    '[Справка системы: сотруднику недавно пришло утреннее напоминание (сводка «План на день»); ' +
      'оно отправлено кодом, не тобой, и это не просьба сотрудника.]',
    `Сегодня: ${today}, ${weekday}. Напоминание отправлено ${shortDate(shown.dateKey)}.`,
    'Заявки из напоминания (answerOrderReminder принимает только их):',
    ...orders.map(
      (order, index) =>
        `${index + 1}. «${order.label}» - requestId: ${order.requestId}` +
        (order.listed ? '' : ' (в напоминании упомянута только числом)'),
    ),
    'Если реплика сотрудника - ответ на это напоминание («да, ответили», «заказ не нужен», ' +
      '«подождём до пятницы»), выбери действие инструментом answerOrderReminder. Не относи ' +
      'такой ответ к активной заявке диалога только потому, что она последняя в чате.',
  ];
}

const inputSchema = z.object({
  action: z
    .enum(['close', 'snooze', 'remind_later', 'clarify'])
    .describe(
      'close - сотрудник сказал, что заказ закрыт или больше не нужен; snooze - не напоминать ' +
        'до названной даты (untilDate); remind_later - напомнить через days дней (поставщик ' +
        'ответил, ждём КП, срок не назван); clarify - непонятно, по какой заявке ответ',
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe('requestId заявки из справки о напоминании; нужен для close, snooze, remind_later'),
  untilDate: dateKeySchema
    .optional()
    .describe('Для snooze: дата YYYY-MM-DD, с которой напоминать снова (после сегодняшней)'),
  days: z
    .number()
    .int()
    .min(1)
    .max(REMINDER_LATER_MAX_DAYS)
    .optional()
    .describe(`Для remind_later: через сколько дней напомнить (1-${REMINDER_LATER_MAX_DAYS})`),
  confirmed: z
    .boolean()
    .optional()
    .describe(
      'Для close: не передавай при первом вызове (код покажет сотруднику вопрос); true - только ' +
        'после явного «да» сотрудника отдельной репликой в ответ на показанный вопрос',
    ),
});
type ReminderInput = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  status: z.enum([
    'needs_confirmation',
    'closed',
    'already_closed',
    'snoozed',
    'clarify_shown',
  ]),
  /** Дата, с которой заявка вернётся в сводку (snooze, remind_later). */
  untilDate: z.string().optional(),
  message: z.string(),
});
type ReminderOutput = z.infer<typeof outputSchema>;

/** Заявка из последней сводки треда; иначе отказ с понятным текстом. */
function pickShown(shown: DigestShown, requestId: string | undefined): string {
  if (requestId === undefined) {
    throw new DomainError('invalid_input', 'Для этого действия нужен requestId заявки из сводки.');
  }
  if (!shown.orders.some((order) => order.requestId === requestId)) {
    throw new DomainError(
      'access_denied',
      'Этой заявки нет в последней сводке этого чата: ответ на напоминание к ней не относится. ' +
        'Используй requestId из справки о напоминании или действие clarify.',
    );
  }
  return requestId;
}

/**
 * Ближайший рабочий день не раньше `dateKey`: сводка уходит только по рабочим дням, и заявка,
 * отложенная на выходной, иначе вернулась бы в понедельник, а сотруднику назвали субботу.
 */
function workingDayFrom(dateKey: string): string {
  let candidate = dateKey;
  while (!isWorkingDay(candidate)) candidate = addDays(candidate, 1);
  return candidate;
}

/** Дата возврата заявки в сводку по действию; отказ, если дата не подходит. */
function untilDateFor(input: ReminderInput, today: string): string {
  if (input.action === 'remind_later') {
    if (input.days === undefined) {
      throw new DomainError('invalid_input', 'Для remind_later нужно число дней (days).');
    }
    return workingDayFrom(addDays(today, input.days));
  }
  if (input.untilDate === undefined) {
    throw new DomainError('invalid_input', 'Для snooze нужна дата untilDate (YYYY-MM-DD).');
  }
  // Некорректная календарная дата даёт DomainError из daysBetween.
  const ahead = daysBetween(today, input.untilDate);
  if (ahead < 1 || ahead > REMINDER_SNOOZE_MAX_DAYS) {
    throw new DomainError(
      'invalid_input',
      `Дата должна быть позже сегодняшней (${today}) и не дальше чем через ` +
        `${REMINDER_SNOOZE_MAX_DAYS} дней.`,
    );
  }
  return workingDayFrom(input.untilDate);
}

/**
 * Ответить на утреннее напоминание по решению модели: закрыть заказ, отложить до даты,
 * напомнить позже или уточнить, по какой заявке ответ. Модель выбирает действие по реплике
 * сотрудника, код проверяет, что заявка есть в сводке этого чата, и исполняет. Закрытие идёт
 * двухшаговым протоколом `closeOrder` (вопрос, затем «да» отдельной репликой).
 */
export const answerOrderReminder = defineTool<ReminderInput, ReminderOutput, OrderCalcDeps>({
  name: 'answerOrderReminder',
  description:
    'Ответ сотрудника на утреннее напоминание («План на день»): справка о нём стоит в начале ' +
    'хода. Выбери действие: close (заказ закрыт или не нужен: первый вызов показывает ' +
    'сотруднику вопрос, закончи ход и жди его «да»; тогда вызови снова с confirmed=true), ' +
    'snooze (не напоминать до названной даты), remind_later (поставщик ответил, ждём КП: ' +
    'напомнить через days дней), clarify (непонятно, о какой заявке речь: код сам спросит ' +
    'сотрудника списком). requestId - только из справки. Фразы кодом не сопоставляются: ' +
    'решаешь ты по смыслу реплики.',
  sideEffect: true,
  inputSchema,
  outputSchema,
  idempotencyKey: (input) =>
    `order-reminder:${input.action}:${input.requestId ?? '-'}:` +
    `${input.untilDate ?? input.days ?? '-'}:${input.confirmed === true ? 'confirm' : 'show'}`,
  // Повтор после изменения состояния (закрыли, отложили на другой срок) - новое действие. Тред
  // входит всегда (справка и вопросы у каждого треда свои), номер реплики - у clarify: второй
  // уточняющий вопрос в другой реплике того же треда - новый показ, а не повтор первого.
  idempotencyPredecessor: async (input, deps, threadId, turn) => {
    // Платформа передаёт номер реплики числом (объекта хода с исполнителем она не даёт).
    const turnNumber: number | undefined = typeof turn === 'number' ? turn : undefined;
    const requestId = input.requestId;
    const snooze =
      requestId === undefined
        ? null
        : await readState(deps.state, ORDER_REMINDER_SNOOZE_NAMESPACE, requestId, snoozeSchema);
    return predecessorOf({
      thread: stableHash(threadId),
      closed: requestId === undefined ? null : await isOrderClosed(deps, requestId),
      pending:
        input.action === 'close' && requestId !== undefined
          ? await closePendingAt(deps, requestId)
          : null,
      until: snooze?.untilDate ?? null,
      shown: (await loadFreshDigest(deps, threadId))?.at ?? null,
      turn: input.action === 'clarify' ? (turnNumber ?? null) : null,
    });
  },
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    const settings = deps.reminderReply;
    if (settings === undefined) {
      throw new DomainError('not_configured', 'Ответ на напоминание не включён.');
    }
    const shown = await loadFreshDigest(deps, context.threadId);
    if (shown === null) {
      throw new DomainError(
        'conflict',
        'Напоминание в этом чате отсутствует или устарело (сводка была давно). Ничего не ' +
          'изменено: уточни у сотрудника, о какой заявке речь, и используй прежние инструменты.',
      );
    }
    const now = deps.clock.now();
    if (input.action === 'clarify') return clarify(deps, shown, context);
    const requestId = pickShown(shown, input.requestId);
    // Заявку могли удалить после сводки: действие над несуществующей не выполняем.
    if ((await deps.requests.get(requestId)) === null) {
      throw new DomainError('not_found', `Заявка ${requestId} не найдена.`);
    }
    await assertOrderOwner(deps, requestId, context);
    if (input.action === 'close') {
      // Закрытие необратимо: тот же двухшаговый протокол, что у closeOrder (вопрос сотруднику,
      // «да» отдельной репликой). Ответ на напоминание «заказ не нужен» не заменяет согласия.
      const closed = await closeOrder.execute(
        { requestId, ...(input.confirmed === true ? { confirmed: true } : {}) },
        deps,
        context,
      );
      return { status: closed.status, message: closed.message };
    }
    const today = localDateKey(now, settings.timezone);
    const untilDate = untilDateFor(input, today);
    await writeState(deps.state, ORDER_REMINDER_SNOOZE_NAMESPACE, requestId, {
      untilDate,
      setAt: now.toISOString(),
      by: userId,
      action: input.action,
    });
    return {
      status: 'snoozed',
      untilDate,
      message:
        `Хорошо: в утренней сводке заявки не будет до ${shortDate(untilDate)} ` +
        '(рабочий день, сводка вернёт её сама). Пришлёт КП - запиши его как обычно.',
    };
  },
});

/** Показать сотруднику вопрос со списком заявок, по которым ему доступны действия. */
async function clarify(
  deps: OrderCalcDeps,
  shown: DigestShown,
  context: ToolContext,
): Promise<ReminderOutput> {
  const orders = await actionableOrders(deps, shown, context);
  if (orders.length === 0) {
    throw new DomainError(
      'conflict',
      'В напоминании нет заявок, по которым этому сотруднику можно что-то сделать.',
    );
  }
  const lines = orders.map((order, index) => `${index + 1}. ${order.label}`);
  // Ключ сообщения: тред и номер реплики, иначе вопрос другого треда или повторный вопрос в
  // следующей реплике чат принял бы за дубль уже отправленного.
  await deps.chat.reply(
    context.threadId,
    {
      text:
        'Уточните, пожалуйста, по какой заявке из утреннего напоминания ответ ' +
        `(можно номером):\n${lines.join('\n')}`,
    },
    `order-reminder-clarify:${stableHash(context.threadId)}:${shown.at}:${context.turnNumber}`,
  );
  return {
    status: 'clarify_shown',
    message: 'Вопрос со списком заявок показан сотруднику. Закончи ход и жди ответа.',
  };
}
