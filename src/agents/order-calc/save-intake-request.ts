import { z } from 'zod';
import { CancelledError, DomainError, ExternalAccessDeniedError } from '@business-ai/core';
import {
  purchaseRequestSchema,
  type PurchaseRequest,
  type RequestItem,
} from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import { predecessorOf, recordWorkOwner, stableHash } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { setActiveRequest } from './active-request';
import { attachmentsSignal, buildAttachmentContext } from './attachment-context';
import { chooseRequestTitle, saveRequestTitle, titledRequest } from './request-title';
import { DEFAULT_ATTACHMENT_CONTEXT_MAX_CHARS, type OrderCalcDeps } from './deps';
import {
  INTAKE_COMMENT_MAX_CHARS,
  INTAKE_ITEMS_FROM,
  INTAKE_LINK_MAX_CHARS,
  INTAKE_REQUEST_ID_PREFIX,
  INTAKE_REQUEST_ID_VERSION,
  INTAKE_SOURCES,
  INTAKE_TASK_DEAL_PREFIX,
  INTAKE_TEXT_DEAL_PREFIX,
  withManagerText,
  fetchDealRequest,
  fetchTask,
  normalizeIntake,
  missingItemNumbers,
  requireItemsInTask,
  resolvePortalRef,
  type IntakeItemsFrom,
  type RawIntakeItem,
  type IntakeSource,
} from './intake';

/** Имя инструмента сохранения заявки. */
const SAVE_INTAKE_REQUEST_TOOL = 'saveIntakeRequest';

/**
 * Позиции от модели: форма проверяется тут, смысл (число, единица, предел) - кодом в
 * `normalizeIntakeItems`, чтобы отказ был понятным списком, а не общей ошибкой схемы.
 */
const itemsSchema = z.array(
  z.object({
    name: z.string(),
    // Нет количества в источнике - не передавай поле: позиция примется как «не указано».
    quantity: z.number().optional(),
    // Нет единицы - код поставит «не указана», отказа приёму нет.
    unit: z.string().optional(),
    sku: z.string().optional(),
    // Подсказка поиску по базе цен; длину и число код приводит к пределу сам (без отказа).
    searchQueries: z.array(z.string()).optional(),
    // Длину (500 знаков) код приводит к пределу сам, без отказа заявке.
    requirements: z.string().optional(),
  }),
);
/** Сколько путей полей называем в тексте ошибки сборки заявки. */
const MAX_ISSUE_FIELDS = 5;
const linkSchema = z.string().trim().min(1).max(INTAKE_LINK_MAX_CHARS);

/** Ввод по видам источника: сочетания полей проверяет код ({@link intakeInputOf}). */
const intakeInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('text'),
    items: itemsSchema,
    comment: z.string().optional(),
  }),
  z.object({
    source: z.literal('task'),
    link: linkSchema,
    items: itemsSchema,
    comment: z.string().optional(),
  }),
  z.object({ source: z.literal('deal'), link: linkSchema }),
]);
type SaveIntakeInput = z.infer<typeof intakeInputSchema>;

/**
 * Схема для модели - плоский объект. Объединение по `source` превращается в JSON Schema без
 * `type: object` на верхнем уровне, и Anthropic отклоняет весь запрос (400 «input_schema.type:
 * Field required»): каждый ход «Поиска поставщика» с включённым приёмом заявок падал (27.10.2026).
 */
const inputSchema = z.object({
  source: z.enum(INTAKE_SOURCES),
  items: itemsSchema.optional(),
  link: linkSchema.optional(),
  // Длину не проверяем схемой (этап 177): слишком длинный текст код обрежет с предупреждением.
  comment: z.string().optional(),
  // Длину не проверяем схемой: слишком длинное название код обрежет сам (`sanitizeRequestTitle`).
  title: z.string().optional(),
});
type SaveIntakeRawInput = z.infer<typeof inputSchema>;

/** Что нужно каждому источнику: подсказка модели при неверном сочетании полей. */
const INTAKE_FIELDS_HINT =
  'source=text: items (и comment по желанию, ссылка не нужна); source=task: link, items ' +
  '(и comment - текст менеджера); source=deal: только link.';

/** Проверить сочетание полей под источник; неверное - понятная ошибка для модели. */
function intakeInputOf(raw: SaveIntakeRawInput): SaveIntakeInput {
  const parsed = intakeInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('invalid_input', `Не хватает полей заявки. ${INTAKE_FIELDS_HINT}`);
  }
  return parsed.data;
}

interface SaveIntakeOutput {
  requestId: string;
  /** Название заявки, как его видит сотрудник (id ему не показывается). */
  title: string;
  dealRef: string;
  itemCount: number;
  source: IntakeSource;
  /** Откуда позиции: `deal` - код взял их из сделки CRM (даже при source=task). */
  itemsFrom: IntakeItemsFrom;
  duplicate: boolean;
  /** Одна фраза для менеджера, если задачу прочитать не удалось и заявка принята по тексту. */
  notice?: string | undefined;
  /** Предупреждения приёма: что обрезано, пропущено или не принято. Заявка при этом сохранена. */
  warnings?: string[] | undefined;
}

/** Заявка без id: id считается по источнику и позициям. */
interface DraftRequest {
  /** Что идентифицирует источник: тред, id задачи или сделки. */
  origin: string;
  /** Вид источника для отпечатка: заявка по сделке одна, хоть ссылка на сделку, хоть на задачу. */
  identity: IntakeSource;
  dealRef: string;
  items: RequestItem[];
  itemsFrom: IntakeItemsFrom;
  /** Заявка принята по тексту менеджера вместо недоступной задачи: фраза для ответа. */
  notice?: string | undefined;
  /** Предупреждения приёма позиций и текста менеджера. */
  warnings: string[];
  /** Время создания из CRM; нет - «сейчас». */
  createdAt?: string;
}

/** Канонические позиции для отпечатка: порядок строк в заявке на id не влияет. */
function canonicalItems(items: readonly RequestItem[]): RequestItem[] {
  return [...items].sort((left, right) =>
    JSON.stringify([left.name, left.unit, left.sku ?? '']).localeCompare(
      JSON.stringify([right.name, right.unit, right.sku ?? '']),
    ),
  );
}

/** Отпечаток источника заявки: что и откуда, с каноническими позициями. */
function fingerprintOf(draft: DraftRequest): unknown {
  // Короткие запросы - подсказка поиску, а не часть заявки: если модель на повторе сформулирует
  // их иначе, это не должно давать другой requestId и вторую заявку.
  // Требования - тоже формулировка модели: на повторе она перепишет их иначе, а заявка та же.
  const items = canonicalItems(draft.items).map(
    ({ searchQueries: _hint, requirements: _requirements, ...rest }): RequestItem => rest,
  );
  return {
    version: INTAKE_REQUEST_ID_VERSION,
    identity: draft.identity,
    origin: draft.origin,
    dealRef: draft.dealRef,
    itemsFrom: draft.itemsFrom,
    count: items.length,
    // Длина записи позиций: дополнительная защита 64-битного отпечатка от случайного совпадения.
    size: JSON.stringify(items).length,
    items,
  };
}

/** Собрать черновик из источника: все данные проверяет и берёт код. */
async function draftOf(
  input: SaveIntakeInput,
  deps: OrderCalcDeps,
  threadId: string,
  signal?: AbortSignal,
): Promise<DraftRequest> {
  if (input.source === 'text') {
    const manager = managerTextOf(input.comment);
    // Дубли от модели объединяем (O24), текст менеджера уходит в требования позиций.
    const taken = normalizeIntake(input.items, 'merge');
    return {
      origin: threadId,
      identity: 'text',
      dealRef: `${INTAKE_TEXT_DEAL_PREFIX}${stableHash(threadId)}`,
      items: withManagerText(taken.items, manager.text),
      itemsFrom: 'model',
      warnings: [...taken.warnings, ...manager.warnings],
    };
  }
  if (input.source === 'task') {
    const manager = managerTextOf(input.comment);
    const draft = await taskDraft(input.link, input.items, manager.text, deps, threadId, signal);
    return { ...draft, warnings: [...draft.warnings, ...manager.warnings] };
  }
  const ref = resolvePortalRef(deps, input.link, 'deal');
  const fromCrm = await fetchDealRequest(deps, ref.ref);
  if (fromCrm === null || fromCrm.items.length === 0) {
    throw new DomainError('not_found', 'В сделке нет позиций: пришлите заявку текстом.');
  }
  return dealDraft(ref.ref, fromCrm);
}

/** Черновик по заявке сделки: позиции и время создания берёт код из CRM. */
function dealDraft(dealRef: string, fromCrm: PurchaseRequest): DraftRequest {
  const taken = normalizeIntake(fromCrm.items, 'merge');
  return {
    origin: dealRef,
    identity: 'deal',
    dealRef,
    // Строки CRM: повтор складываем, спросить некого.
    items: taken.items,
    itemsFrom: 'deal',
    warnings: taken.warnings,
    createdAt: fromCrm.createdAt,
  };
}

/** Тексты вложений задачи (и привязанной сделки); сбой чтения = нет текста, не ошибка. */
async function attachmentTextsOf(
  deps: OrderCalcDeps,
  taskRef: string,
  dealRef: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (deps.attachments === undefined) return [];
  try {
    const bundle = await deps.attachments.fetchAttachments({
      taskRef,
      ...(dealRef === '' ? {} : { dealRef }),
      signal: attachmentsSignal(signal),
    });
    const context = await buildAttachmentContext(bundle, deps.parser, {
      maxChars: deps.attachmentMaxChars ?? DEFAULT_ATTACHMENT_CONTEXT_MAX_CHARS,
    });
    // Файлы чата задачи может положить любой участник: как и сообщения чата, они не
    // обосновывают позицию. Доверяем только вложениям самой задачи и сделки.
    return context.sections
      .filter((section) => section.source === 'task' || section.source === 'deal')
      .map((section) => section.text);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return [];
  }
}

/**
 * Текст менеджера: слишком длинный не отказ, а обрезка с предупреждением (этап 177). Предел
 * большой, обычный текст в него не упирается.
 */
function managerTextOf(comment: string | undefined): { text: string; warnings: string[] } {
  const text = comment ?? '';
  if (text.length <= INTAKE_COMMENT_MAX_CHARS) return { text, warnings: [] };
  return {
    text: text.slice(0, INTAKE_COMMENT_MAX_CHARS),
    warnings: [
      `текст менеджера длиннее ${INTAKE_COMMENT_MAX_CHARS} знаков, учтено начало: проверьте конец`,
    ],
  };
}

/** Фраза для менеджера, когда задача не прочиталась и заявка принята по его тексту. */
const TASK_UNREADABLE_NOTICE = 'Задачу прочитать не удалось, заявка принята по вашему тексту.';

/** Режим «только по тексту» вместо недоступной задачи: ссылка не нужна, `dealRef` = text-<id>. */
function unreadableTaskDraft(
  modelItems: readonly RawIntakeItem[],
  managerText: string,
  threadId: string,
): DraftRequest {
  const taken = normalizeIntake(modelItems, 'merge');
  return {
    origin: threadId,
    identity: 'text',
    dealRef: `${INTAKE_TEXT_DEAL_PREFIX}${stableHash(threadId)}`,
    items: withManagerText(taken.items, managerText),
    itemsFrom: 'model',
    notice: TASK_UNREADABLE_NOTICE,
    warnings: taken.warnings,
  };
}

/**
 * Заявка из задачи. Задача привязана к сделке, и CRM отдаёт по ней позиции: берутся позиции
 * СДЕЛКИ (код), позиции модели игнорируются, заявка та же, что по ссылке на сделку. Сделки в
 * CRM нет (нет прав, нет позиций, CRM не подключена): привязка не используется, `dealRef` =
 * `task-<id>` (заметки не уходят в чужую сделку), позиции от модели с опорой в тексте задачи.
 */
async function taskDraft(
  link: string,
  modelItems: readonly RawIntakeItem[],
  managerText: string,
  deps: OrderCalcDeps,
  threadId: string,
  signal?: AbortSignal,
): Promise<DraftRequest> {
  const hasManagerText = managerText.trim() !== '';
  let ref: ReturnType<typeof resolvePortalRef>;
  let task: Awaited<ReturnType<typeof fetchTask>>;
  try {
    ref = resolvePortalRef(deps, link, 'task');
    // Задачу перечитываем: ссылка должна вести на существующую задачу, а не на выдумку.
    task = await fetchTask(deps, ref.ref);
  } catch (error) {
    // Задача не читается, но менеджер дал свой текст: это режим «только по тексту», а не отказ
    // (O27). Отмену и не-доменные сбои не глотаем.
    if (hasManagerText && error instanceof DomainError) {
      return unreadableTaskDraft(modelItems, managerText, threadId);
    }
    throw error;
  }
  if (task === null) {
    if (hasManagerText) return unreadableTaskDraft(modelItems, managerText, threadId);
    throw new DomainError(
      'not_found',
      'Задача не найдена или недоступна: проверьте ссылку или пришлите заявку текстом.',
    );
  }
  const linked = task.dealRef?.trim() ?? '';
  if (linked !== '' && deps.crm !== undefined) {
    // Нет прав на crm - откат на позиции модели. Прочий сбой CRM - ошибка (повторяемая), а не
    // молчаливый откат.
    const fromCrm = await fetchDealRequest(deps, linked).catch((error: unknown) => {
      if (error instanceof ExternalAccessDeniedError) return null;
      throw error;
    });
    if (fromCrm !== null && fromCrm.items.length > 0) {
      const draft = dealDraft(linked, fromCrm);
      return { ...draft, items: withManagerText(draft.items, managerText) };
    }
  }
  const taken = normalizeIntake(modelItems, 'merge');
  const items = taken.items;
  // Вложения читаем только если по тексту задачи опоры нет: лишних скачиваний не делаем. Текст
  // берёт код заново из Битрикс24, а не модель, поэтому выдуманную позицию он не оправдает.
  const attachmentTexts =
    missingItemNumbers(items, task, [], managerText).length === 0
      ? []
      : await attachmentTextsOf(deps, ref.ref, linked, signal);
  // Название заявлено, если оно в задаче или в тексте менеджера этого хода; реплики других
  // участников чата опорой не служат (защита от инъекций).
  requireItemsInTask(items, task, attachmentTexts, managerText);
  return {
    origin: ref.ref,
    identity: 'task',
    dealRef: `${INTAKE_TASK_DEAL_PREFIX}${ref.ref}`,
    items: withManagerText(items, managerText),
    itemsFrom: 'model',
    warnings: taken.warnings,
  };
}

/**
 * Принять заявку и сохранить её в репозитории заявок. Позиции из текста и задачи проверяет
 * код; из сделки позиции берёт только код (от модели не принимаются). Идентификатор
 * детерминирован: тот же источник и те же позиции - та же заявка, второй не создаётся.
 */
export const saveIntakeRequest = defineTool<
  SaveIntakeRawInput,
  SaveIntakeOutput,
  OrderCalcDeps
>({
  name: SAVE_INTAKE_REQUEST_TOOL,
  description:
    'Сохранить заявку на расчёт. source=text: items из текста менеджера. source=task: link ' +
    'на задачу портала и items, которые ты выделил из её текста (каждое название должно ' +
    'встречаться в тексте задачи, её вложений или в comment - тексте менеджера; ' +
    'если задача привязана к сделке с позициями, код возьмёт позиции из сделки, ' +
    'itemsFrom=deal). source=deal: только link на сделку, позиции код ' +
    'возьмёт из CRM (свои не передавай). Количество не выдумывай: нет в источнике - не ' +
    'передавай quantity, заявка примется, шорт-лист строй сразу; ' +
    'единицы нет в источнике - не передавай её, будет «не указана». Ссылка на задачу не ' +
    'обязательна: без неё используй source=text. Если задача не читается, а comment есть, ' +
    'заявка примется по тексту (notice). У каждой позиции в items заполни ' +
    'searchQueries: 1-3 коротких запроса к базе цен (сам товар одной-тремя словами, без ' +
    'количества, цвета и нанесения), например «чайная пара», «флешка usb металл»; по ним ' +
    'поиск находит поставщиков, которых не видно по длинному названию. Составную позицию ' +
    '(«подарочный набор: чай, мёд, кружка») разбей на отдельные позиции по каждому товару ' +
    'набора, а сам набор целиком тоже оставь отдельной позицией (его ищут как есть); ' +
    'количество у частей набора бери из источника, не выдумывай. У каждой позиции в items ' +
    'name - короткое имя товара («шоперы»), а ВСЕ его характеристики из задачи перенеси в ' +
    'requirements (до 500 знаков): материал, размер, формат, плотность, цвет, способ и место ' +
    'нанесения, комплектация, упаковка, объём, год. Только свойства товара: без имён, ' +
    'контактов, названия заказчика, сроков и цен; не клади их в comment и не теряй. ' +
    'title - короткое название заявки по сути продукции (до 60 знаков, например «мёд с ' +
    'орехами» или «пледы»; без имён людей и номеров): по нему сотрудник ' +
    'узнаёт заявку, id ему не показывай. Вернёт requestId для ' +
    'buildShortlist; ' +
    'повтор того же ввода вернёт ту же заявку (duplicate=true).',
  sideEffect: true,
  // Для text и task перефраз позиций на повторе даёт другой requestId и вторую заявку:
  // оборванный ход повторяется только по подтверждению человека.
  replay: 'confirm',
  // Тред входит в ключ у всех источников: тот же ввод от другого сотрудника - другая операция,
  // иначе повтор вернул бы чужой закэшированный результат, `recordWorkOwner` не выполнился бы
  // и заявка в этом треде не появилась бы. Для сделки и задачи в ключ входит ещё отпечаток
  // источника (позиции, прочитанные из CRM или присланные для задачи): сделку изменили - новая
  // операция, а не старый результат. Источник читается и тут, и в `execute` (два чтения).
  idempotencyPredecessor: async (raw, deps, threadId) => {
    const input = intakeInputOf(raw);
    if (input.source === 'text') return predecessorOf(threadId);
    const draft = await draftOf(input, deps, threadId);
    return stableHash({ thread: threadId, source: fingerprintOf(draft) });
  },
  inputSchema,
  outputSchema: z.object({
    requestId: z.string().min(1),
    title: z.string().min(1),
    dealRef: z.string().min(1),
    itemCount: z.number().int().positive(),
    source: z.enum(INTAKE_SOURCES),
    itemsFrom: z.enum(INTAKE_ITEMS_FROM),
    duplicate: z.boolean(),
    notice: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  async execute(raw, deps, context) {
    const draft = await draftOf(intakeInputOf(raw), deps, context.threadId, context.signal);
    const requestId = `${INTAKE_REQUEST_ID_PREFIX}${stableHash(fingerprintOf(draft))}`;
    const now = deps.clock.now();
    // Заявка по сделке живёт по времени сделки: создание берётся из CRM, не «сейчас».
    const candidate: PurchaseRequest = {
      id: requestId,
      dealRef: draft.dealRef,
      items: draft.items,
      createdAt: draft.createdAt ?? now.toISOString(),
    };
    const parsed = purchaseRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      // Причина по полям (без значений): отказ без объяснения сотруднику не помогает.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
        .slice(0, MAX_ISSUE_FIELDS)
        .join(', ');
      throw new DomainError(
        'validation_failed',
        'Заявку собрать не удалось: проверьте позиции в сделке' +
          `${fields === '' ? '' : ` (поля: ${fields})`}.`,
      );
    }
    const existing = await deps.requests.get(requestId);
    if (existing === null) await deps.requests.save(parsed.data);
    // Название: проверенное от модели, иначе из первых позиций (код). Первое название
    // заявки сохраняется, повтор приёма его не меняет.
    const title = chooseRequestTitle(raw.title, existing?.items ?? draft.items);
    await saveRequestTitle(deps, parsed.data, title, context.threadId);
    // Кто принял заявку, тому и пишем по ней (первый владелец сохраняется).
    await recordWorkOwner(deps.state, workSubject.order(requestId), context);
    // Следующие ходы треда подставят эту заявку сами: история requestId не хранит.
    await setActiveRequest(deps, context.threadId, requestId);
    return {
      requestId,
      title: (await titledRequest(deps, requestId))?.title ?? title,
      dealRef: existing?.dealRef ?? draft.dealRef,
      itemCount: existing?.items.length ?? draft.items.length,
      source: raw.source,
      itemsFrom: draft.itemsFrom,
      duplicate: existing !== null,
      ...(draft.notice === undefined ? {} : { notice: draft.notice }),
      ...(draft.warnings.length === 0 ? {} : { warnings: draft.warnings }),
    };
  },
});
