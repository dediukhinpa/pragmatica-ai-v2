import { z } from 'zod';
import {
  ENRICH_EMAIL_REVIEW_NOTE,
  type SupplierEnrichment,
} from '../../kit/domain/supplier-enrichment';
import {
  DomainError,
  employeeOfThread,
  isMailboxNotConnectedError,
  type ValidationIssue,
} from '@business-ai/core';
import {
  REQUEST_VALUE_MAX_CHARS,
  requestFieldKeys,
  requestKindSchema,
  type RequestKind,
} from '../../kit/domain/request-forms';
import {
  knownFieldsFromCard,
  renderSupplierRequest,
  templateValuesFromForm,
  type SupplierRequestFieldRef,
  type SupplierRequestKnownId,
} from '../../kit/domain/supplier-request-template';
import { type Supplier } from '../../kit/domain/models';
import { type SupplierCard } from '../../kit/domain/supplier-card';
import type { ChatMessage } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import {
  chatThreadOf,
  isPlausibleEmailAddress,
  joinKey,
  loadWorkOwner,
  predecessorOf,
  recordWorkOwner,
  requireEmployee,
  stableHash,
} from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { nonEmptyValues, sanitizeValues } from './check-request-completeness';
import type { OrderCalcDeps } from './deps';
import {
  checkSupplierRequest,
  recordSupplierRequestsPrepared,
  withRequestTag,
} from './supplier-request-shared';
import {
  loadCompleteness,
  loadProposal,
  loadReshowCount,
  loadSelection,
  loadSent,
  saveCompleteness,
  saveReshowCount,
  sentAtFor,
} from './state';

/** Тема письма без названия продукции (название добавляется, если оно известно). */
const SUBJECT_BASE = 'Запрос на расчёт';
/** Сколько символов названия продукции кладём в тему письма. */
const SUBJECT_PRODUCT_MAX_CHARS = 80;
/** Префикс ключа сообщения чата с письмом(ами) и пометками. */
const BLOCK_KEY_PREFIX = 'order-request-text';
/** Разделитель письма и пометок к нему в одном сообщении. */
const BLOCKS_SEPARATOR = '\n\n';
/** Часть ключа повторного показа текста (дальше идёт номер показа). */
const RESHOW_KEY_PART = 'reshow';
/** Часть ключа явной просьбы собрать письма и ранее выбранным. */
const INCLUDE_PREVIOUS_KEY_PART = 'include-previous';

const inputSchema = z.object({
  requestId: z.string().min(1),
  /** Вид запроса: нужен только если значения передаются, а проверки полноты по заявке не было. */
  kind: requestKindSchema.optional(),
  /** Правки сотрудника: ключ поля формы -> значение; дополняют сохранённые, пустые не стирают. */
  values: z.record(z.string().max(REQUEST_VALUE_MAX_CHARS)).optional(),
  /** Показать готовый текст ещё раз (сотрудник просит «покажи ещё раз»). */
  reshow: z.boolean().optional(),
  /**
   * Собрать письма и ранее выбранным поставщикам, которым текст уже готовили (сотрудник просит
   * «напомни письмо для 5», «пересобери»). Без него письма идут только новым выбранным.
   */
  includePreviouslyChosen: z.boolean().optional(),
});
type TextInput = z.output<typeof inputSchema>;

/** Итог для модели: только коды и числа, без текстов писем и адресов. */
const outputSchema = z.object({
  requestId: z.string(),
  /** Поставщики, чей текст показан сотруднику (и записан как подготовленный). */
  shownSupplierIds: z.array(z.string()),
  /** Поставщики без пригодного адреса почты: текст им готов, но адрес сотрудник уточняет сам. */
  withoutContact: z.array(z.string()),
  /** Подписи полей без значения (в письмо не вошли). */
  blankFields: z.array(z.string()),
  /** Письмо НЕ отправлено: его отправляет сотрудник. Всегда true. */
  notSent: z.literal(true),
  /** Подключён ли ящик сотрудника (ответы читаются из него). */
  mailConnected: z.boolean(),
});
type TextOutput = z.output<typeof outputSchema>;

/** Один и тот же сотрудник: тот же тред либо тот же сотрудник в тредах связок ботов. */
function sameEmployeeThread(a: string, b: string): boolean {
  if (a === b) return true;
  const first = employeeOfThread(a);
  return first !== null && first === employeeOfThread(b);
}

/**
 * Правило владельца заявки: текст запроса по ней готовит сотрудник, который её ведёт: если
 * владелец ящика или работы по заявке уже есть, это должен быть он.
 * @throws DomainError('access_denied')
 */
async function assertRequestOwner(
  deps: OrderCalcDeps,
  requestId: string,
  userId: string,
  threadId: string,
): Promise<void> {
  const refusal = new DomainError(
    'access_denied',
    'Заявку ведёт другой сотрудник: запрос по ней с вашей почты не готовится.',
  );
  const sent = await loadSent(deps, requestId);
  if (sent?.mailboxOwnerId !== undefined && sent.mailboxOwnerId !== userId) throw refusal;
  const owner = await loadWorkOwner(deps.state, workSubject.order(requestId));
  if (owner !== null && !sameEmployeeThread(owner, threadId)) throw refusal;
}

function issuesToError(issues: readonly ValidationIssue[]): DomainError {
  return new DomainError('invalid_input', issues.map((issue) => issue.message).join(' '));
}

/** Исходные данные текста: всё, что код берёт сам, а не от модели. */
interface RequestSources {
  supplierIds: string[];
  templateValues: ReturnType<typeof templateValuesFromForm>;
  cards: Map<string, SupplierCard>;
  /** Записи поставщиков (адрес для письма); null - записи нет. */
  suppliers: Map<string, Supplier | null>;
  /**
   * Найденное в интернете для поставщиков из шорт-листа (почта, телефон): подставляется, когда
   * в карточке адреса нет, и всегда с пометкой «из интернета, проверьте». Карточку не меняет.
   */
  web: Map<string, SupplierEnrichment>;
}

/**
 * Дополнить характеристики заказа правками сотрудника. Пустые значения не стирают известные,
 * ключи берутся только из формы вида. Запись идёт в то же пространство, что и проверка полноты,
 * но признак отказа не меняется и «проверка пройдена» не создаётся: шлюз поиска считает
 * недостающее по значениям заново, а без флага полноты шлюза нет.
 * @throws DomainError('invalid_input') если вид неизвестен.
 */
async function mergeEmployeeValues(
  deps: OrderCalcDeps,
  input: TextInput,
): Promise<void> {
  if (Object.keys(input.values ?? {}).length === 0) return;
  const stored = await loadCompleteness(deps, input.requestId);
  const kind: RequestKind | undefined = input.kind ?? stored?.kind;
  if (kind === undefined) {
    throw new DomainError(
      'invalid_input',
      'Чтобы записать значения заказа, укажите kind: вид запроса по заявке ещё не определён.',
    );
  }
  // Лишние ключи игнорируются, кривая ссылка на задачу отбрасывается без отказа (O5, O6).
  const { values: incoming } = sanitizeValues(deps, kind, input.values ?? {});
  if (Object.keys(incoming).length === 0) return;
  // Другой вид запроса: прежние значения и отказ относились к другой форме.
  const sameKind = stored !== null && stored.kind === kind;
  const known = new Set(requestFieldKeys(kind));
  const previous = sameKind
    ? Object.fromEntries(Object.entries(stored.values).filter(([key]) => known.has(key)))
    : {};
  const values = { ...previous, ...incoming };
  if (sameKind && JSON.stringify(values) === JSON.stringify(stored.values)) return;
  await saveCompleteness(deps, {
    requestId: input.requestId,
    kind,
    values,
    declined: sameKind && stored.declined,
    // Правка сотрудника сняла отложенность у полей, которым дали значение.
    deferred: sameKind ? stored.deferred.filter((key) => (values[key] ?? '') === '') : [],
    updatedAt: deps.clock.now().toISOString(),
  });
}

/**
 * Выбор менеджера, характеристики заказа (пространство полноты; нет - пустые поля) и карточки
 * выбранных поставщиков. Выбора нет - отказ тем же замечанием, что и у проверки запроса.
 */
async function loadSources(deps: OrderCalcDeps, requestId: string): Promise<RequestSources> {
  const selection = await loadSelection(deps, requestId);
  if (selection === null) {
    throw issuesToError(await checkSupplierRequest({ requestId, subject: '', body: '' }, deps));
  }
  const supplierIds = [...new Set(selection.supplierIds)];
  const completeness = await loadCompleteness(deps, requestId);
  const templateValues =
    completeness === null
      ? {}
      : templateValuesFromForm(completeness.kind, completeness.values, completeness.deferred);
  const cards = new Map<string, SupplierCard>();
  for (const card of await deps.suppliers.getCards(supplierIds)) cards.set(card.id, card);
  const suppliers = new Map<string, Supplier | null>();
  for (const id of supplierIds) suppliers.set(id, await deps.suppliers.get(id));
  const web = new Map<string, SupplierEnrichment>();
  for (const entry of (await loadProposal(deps, requestId))?.entries ?? []) {
    if (entry.webEnrichment !== undefined && supplierIds.includes(entry.supplierId)) {
      web.set(entry.supplierId, entry.webEnrichment);
    }
  }
  return { supplierIds, templateValues, cards, suppliers, web };
}

/**
 * Кому собирать письма: новым выбранным (нет в учёте подготовленных/отправленных). Явная
 * просьба (includePreviouslyChosen, reshow) - всем выбранным. Новых нет, а текст запрошен
 * (например, правка значений) - тоже всем: пустой ответ сотруднику хуже повтора.
 */
async function supplierIdsToPrepare(
  deps: OrderCalcDeps,
  input: TextInput,
  selectedIds: readonly string[],
): Promise<string[]> {
  if (input.includePreviouslyChosen === true || input.reshow === true) return [...selectedIds];
  const sent = await loadSent(deps, input.requestId);
  const fresh = selectedIds.filter(
    (id) => sent === null || sentAtFor(sent, id) === undefined,
  );
  return fresh.length > 0 ? fresh : [...selectedIds];
}

/** Тема письма: «Запрос на расчёт» и название продукции, если оно известно. */
function subjectOf(product: string | undefined): string {
  const name = (product ?? '').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_PRODUCT_MAX_CHARS);
  return name === '' ? SUBJECT_BASE : `${SUBJECT_BASE}: ${name}`;
}

/** Подписи полей через запятую для сообщения сотруднику. */
function labelsOf(items: readonly SupplierRequestFieldRef[]): string {
  return items.map((item) => item.label).join('; ');
}

/** Предупреждение, когда в письмо не вошло ни продукция, ни тираж: оно ничего не сообщает. */
const NOTHING_SPECIFIED_WARNING =
  'Продукция не указана — письмо ничего не сообщает поставщику.';

/** Поля, без которых письмо поставщику бессодержательно. */
const ESSENTIAL_FIELD_IDS: readonly string[] = ['product', 'quantity'];

/** Строка адреса для поставщика без почты: адрес не выдумываем, телефон показываем, если есть. */
const NO_ADDRESS_LINE = 'адрес не найден, уточните контакт';

/**
 * Строка «Кому»: адрес почты (из карточки либо найденный в интернете - с пометкой) либо пометка,
 * что адреса нет (и телефон, если есть).
 */
function addressLine(
  email: string | undefined,
  phone: string | undefined,
  web: SupplierEnrichment | undefined,
): string {
  if (email !== undefined) return email;
  if (web?.email !== undefined) return `${web.email} (${ENRICH_EMAIL_REVIEW_NOTE})`;
  if (phone !== undefined) return `${NO_ADDRESS_LINE} (телефон: ${phone})`;
  if (web?.phone !== undefined) {
    return `${NO_ADDRESS_LINE} (телефон: ${web.phone}, ${ENRICH_EMAIL_REVIEW_NOTE})`;
  }
  return NO_ADDRESS_LINE;
}

/** Первый телефон карточки: основной контакт в приоритете. */
function phoneOfCard(card: SupplierCard | undefined): string | undefined {
  if (card === undefined) return undefined;
  const main = card.contacts.find((contact) => contact.isPrimary && contact.phone !== undefined);
  return (main ?? card.contacts.find((contact) => contact.phone !== undefined))?.phone;
}

/** Ограда markdown: чат Битрикс24 показывает её блоком кода (границы видны, текст копируется). */
const LETTER_FENCE = '```';
/** Невидимый символ-разделитель: тройной апостроф в письме не закроет ограду раньше времени. */
const FENCE_BREAKER = '\u2060';

/**
 * Тело письма в ограде. Зачем: сотрудник должен видеть границы письма и копировать его целиком;
 * разметку блока ставит форматтер канала (`formatReplyText`), здесь только нейтральный
 * markdown. Тройные обратные апострофы в теле разрываются невидимым символом.
 */
function fencedLetter(body: string): string {
  const safe = body
    .replace(/\r?\n$/, '')
    .replace(/`{3,}/g, (run) => run.split('').join(FENCE_BREAKER));
  return [LETTER_FENCE, safe, LETTER_FENCE].join('\n');
}

/** Блок поставщика для сотрудника: кому, тема, текст, что убрано и что не вошло в письмо. */
function supplierBlock(input: {
  name: string;
  address: string;
  subject: string;
  body: string;
  omitted: readonly SupplierRequestFieldRef[];
  blank: readonly SupplierRequestFieldRef[];
}): string {
  // Ни продукции, ни тиража: письмо готовим (решение владельца), но предупреждаем первой строкой.
  const blankIds = new Set<string>(input.blank.map((item) => item.id));
  const nothingSpecified = ESSENTIAL_FIELD_IDS.every((id) => blankIds.has(id));
  const lines = [
    ...(nothingSpecified ? [NOTHING_SPECIFIED_WARNING] : []),
    `Поставщик: ${input.name}`,
    `Кому: ${input.address}`,
    `Тема: ${input.subject}`,
    '',
    fencedLetter(input.body),
  ];
  if (input.omitted.length > 0) {
    lines.push(
      '',
      `Не спрашиваю у этого поставщика, это уже есть в его карточке: ${labelsOf(input.omitted)}.`,
    );
  }
  if (input.blank.length > 0) {
    // Пустые поля в письмо не вошли: сотруднику - что можно дописать, если сведения есть.
    lines.push(
      '',
      `В письме нет (не указано): ${labelsOf(input.blank)}. ` +
        'Допишите в текст, если эти сведения есть.',
    );
  }
  return lines.join('\n');
}

/** Итоговая заметка: письмо не отправлено, как отправить и что с меткой, без почты и контактов. */
function closingNote(input: {
  withoutContact: readonly string[];
  /** Поставщики, адрес которых найден в интернете, а не взят из карточки. */
  webEmailSuppliers: readonly string[];
  mailConnected: boolean;
}): string {
  const lines = [
    'Письма я не отправляю: скопируйте текст и отправьте поставщику сами со своей почты.',
    'Метку вида [RFQ-…] в теме не удаляйте: по ней ответ поставщика привяжется к заявке.',
  ];
  if (input.withoutContact.length > 0) {
    lines.push(
      'Нет пригодного адреса почты у поставщиков: ' +
        `${input.withoutContact.join(', ')}. Текст для них готов, адрес уточните и отправьте сами.`,
    );
  }
  if (input.webEmailSuppliers.length > 0) {
    lines.push(
      `Адрес почты найден в интернете (${ENRICH_EMAIL_REVIEW_NOTE}), в карточке его нет: ` +
        `${input.webEmailSuppliers.join(', ')}. Убедитесь, что это нужная компания.`,
    );
  }
  if (!input.mailConnected) {
    lines.push(
      'Почта не подключена: ответы поставщиков я прочитать не смогу, проверяйте статус по ' +
        'заявке вручную.',
    );
  }
  return lines.join('\n');
}

/** Подключён ли ящик сотрудника: нет порта или ящика - false, остальные сбои пробрасываются. */
async function isMailConnected(deps: OrderCalcDeps, userId: string): Promise<boolean> {
  if (deps.mailboxes === undefined) return false;
  try {
    await deps.mailboxes.forEmployee(userId);
    return true;
  } catch (error) {
    if (isMailboxNotConnectedError(error)) return false;
    throw error;
  }
}

/**
 * Отпечаток данных текста: меняются выбор, характеристики заказа, карточки или адреса -
 * текст другой. Адреса входят только в хэш, наружу не попадают.
 */
function sourcesFingerprint(sources: RequestSources): string {
  const known = sources.supplierIds.map((id) => {
    const card = sources.cards.get(id);
    return [
      id,
      card === undefined ? [] : [...knownFieldsFromCard(card)].sort(),
      sources.suppliers.get(id)?.email ?? null,
      sources.suppliers.get(id)?.name ?? null,
      sources.web.get(id)?.email ?? null,
      sources.web.get(id)?.phone ?? null,
    ];
  });
  return stableHash([[...sources.supplierIds].sort(), sources.templateValues, known]);
}

/**
 * Подготовить текст запроса выбранным поставщикам. Письмо НЕ отправляется и кнопок отправки
 * нет: код сам берёт выбор менеджера, характеристики заказа и карточки поставщиков, собирает
 * текст по шаблону ТЗ (разд. 5) без вопросов, ответы на которые уже есть в карточке, добавляет
 * метку заявки и публикует сообщение сотруднику в чате. Письмо отправляет сам сотрудник.
 * Затем код записывает учёт подготовленных запросов (`state: 'prepared'`).
 */
export const prepareSupplierRequestText = defineTool<TextInput, TextOutput, OrderCalcDeps>({
  name: 'prepareSupplierRequestText',
  description:
    'Подготовить текст запроса выбранным менеджером поставщикам по заявке requestId (после ' +
    'recordSelection). Передай только requestId: выбор, характеристики заказа и карточки ' +
    'поставщиков код берёт сам. Код сам покажет сотруднику в чате текст по шаблону с темой и ' +
    'меткой заявки (по одному блоку на поставщика); вопросы, ответы на которые есть в ' +
    'карточке поставщика, он убирает, а поля без значения в письмо не выводит. Письмо НЕ ' +
    'отправляется: его отправляет сотрудник сам. Не пересказывай и не переписывай текст, не ' +
    'сообщай «отправлено». Возвращает коды и числа: shownSupplierIds, withoutContact, ' +
    'blankFields (подписи полей, не вошедших в письмо), mailConnected. Сотрудник поправил ' +
    'значения заказа (или проверки полноты нет и значений в заявке нет): передай values ' +
    '(ключ поля формы -> значение, только сказанное им; kind - вид запроса, если он ещё не ' +
    'определён), код дополнит сохранённые ' +
    'значения. Просьба «покажи ещё раз» без правок: reshow=true. Письма готовятся только ' +
    'НОВЫМ выбранным поставщикам: тем, кому текст уже готовили, он не повторяется. Только ' +
    'если сотрудник сам просит письмо и для ранее выбранных («напомни письмо для 5», ' +
    '«пересобери»): includePreviouslyChosen=true.',
  sideEffect: true,
  // Письма, пометки и напоминание «отправляет сотрудник» показывает код: у сообщения один автор.
  // Если ни одного письма не показано (всем уже готовили), ход продолжается и модель объясняет.
  endsTurn: true,
  endsTurnWhen: (output) => output.shownSupplierIds.length > 0,
  inputSchema,
  outputSchema,
  // Правки значений и повторный показ входят в ключ: иначе повтор вернул бы прежний ответ.
  idempotencyKey: (input) => {
    const parts: string[] = [BLOCK_KEY_PREFIX, input.requestId];
    if (input.reshow === true) parts.push(RESHOW_KEY_PART);
    if (input.includePreviouslyChosen === true) parts.push(INCLUDE_PREVIOUS_KEY_PART);
    const incoming = nonEmptyValues(input.values ?? {});
    if (Object.keys(incoming).length > 0) {
      parts.push(stableHash([input.kind ?? null, incoming]));
    }
    return joinKey(...parts);
  },
  // Текст зависит от выбора, характеристик заказа и карточек: после их изменения повтор
  // готовит текст заново, а не возвращает прежний ответ.
  idempotencyPredecessor: async (input, deps) => {
    const selection = await loadSelection(deps, input.requestId);
    if (selection === null) return predecessorOf(null);
    const fingerprint = sourcesFingerprint(await loadSources(deps, input.requestId));
    // Каждый повторный показ получает новый ключ: счётчик растёт после показа.
    if (input.reshow !== true && input.includePreviouslyChosen !== true) {
      return predecessorOf(fingerprint);
    }
    return predecessorOf([fingerprint, await loadReshowCount(deps, input.requestId)]);
  },
  async execute(input, deps, context) {
    const userId = requireEmployee(context);
    // Плановый запуск и вызов агента чата не имеют: текст готовится только по просьбе человека.
    const threadId = await chatThreadOf(deps.state, context);
    if (threadId === null) {
      throw new DomainError(
        'access_denied',
        'Текст запроса показывается только в чате сотрудника: из планового запуска ' +
          'запросы не готовятся.',
      );
    }
    await assertRequestOwner(deps, input.requestId, userId, threadId);
    // Правки сотрудника записываются до сборки текста; без выбора менеджера отказ ниже.
    if ((await loadSelection(deps, input.requestId)) !== null) {
      await mergeEmployeeValues(deps, input);
    }
    const sources = await loadSources(deps, input.requestId);
    // Явная просьба повторить письмо (в т.ч. прежним) получает новые ключи сообщений, иначе чат
    // счёл бы такое же письмо повтором шага и не показал его.
    const isRepeat = input.reshow === true || input.includePreviouslyChosen === true;
    const reshowCount = isRepeat ? await loadReshowCount(deps, input.requestId) : 0;
    const reshowPart = isRepeat ? [`${RESHOW_KEY_PART}${reshowCount}`] : [];

    // Выбор копит всех (в него входят и те, кому текст уже готовили: иначе их ответы не
    // читались бы), поэтому письма собираем только новым выбранным: иначе на каждый новый
    // выбор сотрудник получал письма и прежним поставщикам.
    const targetIds = await supplierIdsToPrepare(deps, input, sources.supplierIds);

    const blocks: Array<{ supplierId: string; text: string }> = [];
    const withoutContact: string[] = [];
    // Адрес найден в интернете, а не взят из карточки: сотруднику - пометка проверить.
    const webEmailSuppliers: string[] = [];
    const blankLabels = new Set<string>();
    let omittedCount = 0;
    for (const supplierId of targetIds) {
      const supplier = sources.suppliers.get(supplierId);
      // Нет адреса или он не похож на почтовый: текст всё равно готовится (шаблон контактов не
      // требует), адрес не выдумываем, сотрудник отправит сам.
      const email =
        supplier?.email !== undefined && isPlausibleEmailAddress(supplier.email)
          ? supplier.email
          : undefined;
      const web = sources.web.get(supplierId);
      if (email === undefined && web?.email !== undefined) {
        webEmailSuppliers.push(supplier?.name ?? supplierId);
      }
      if (email === undefined && web?.email === undefined) {
        withoutContact.push(supplierId);
      }
      const card = sources.cards.get(supplierId);
      const known: ReadonlySet<SupplierRequestKnownId> =
        card === undefined ? new Set() : knownFieldsFromCard(card);
      const rendered = renderSupplierRequest({ values: sources.templateValues, known });
      const tagged = withRequestTag(
        input.requestId,
        subjectOf(sources.templateValues.product),
        rendered.text,
      );
      // Токены псевдонимизации в значениях: письмо с ними поставщику уходить не должно.
      const issues = await checkSupplierRequest(
        {
          requestId: input.requestId,
          recipientSupplierIds: [supplierId],
          subject: tagged.subject,
          body: tagged.body,
        },
        deps,
      );
      if (issues.length > 0) throw issuesToError(issues);
      for (const item of rendered.blank) blankLabels.add(item.label);
      omittedCount += rendered.omitted.length;
      blocks.push({
        supplierId,
        text: supplierBlock({
          name: supplier?.name ?? card?.name ?? supplierId,
          address: addressLine(email, phoneOfCard(card), web),
          subject: tagged.subject,
          body: tagged.body,
          omitted: rendered.omitted,
          blank: rendered.blank,
        }),
      });
    }
    // Менеджер, готовящий запрос в чате, ведёт заявку (первый владелец сохраняется).
    await recordWorkOwner(deps.state, workSubject.order(input.requestId), context);
    const mailConnected = await isMailConnected(deps, userId);
    // Пометки к письму идут в том же сообщении, что письмо (этап 173): раньше заметка была
    // отдельным сообщением, а модель повторяла её третьим. Один поставщик - одно сообщение;
    // несколько - по сообщению на письмо (каждое копируется целиком), пометки один раз в
    // последнем. Ключ - от текста: повтор шага не задваивает сообщение, правки дают новый.
    const note = closingNote({
      withoutContact,
      webEmailSuppliers,
      mailConnected,
    });
    for (const [index, block] of blocks.entries()) {
      const isLast = index === blocks.length - 1;
      const message: ChatMessage = {
        text: isLast ? `${block.text}${BLOCKS_SEPARATOR}${note}` : block.text,
      };
      await deps.chat.reply(
        threadId,
        message,
        joinKey(
          BLOCK_KEY_PREFIX,
          input.requestId,
          block.supplierId,
          stableHash(message.text),
          ...reshowPart,
        ),
      );
      // Что увидел сотрудник, то и пишется в историю хода.
      context.noteShown?.(message.text);
    }
    // Учёт подготовленного - после показа: запись не должна опережать то, что увидел человек.
    await recordSupplierRequestsPrepared(deps, {
      requestId: input.requestId,
      supplierIds: blocks.map((block) => block.supplierId),
      at: deps.clock.now().toISOString(),
      mailboxOwnerId: userId,
    });
    // Счётчик растёт после показа: следующее «покажи ещё раз» получит новые ключи.
    if (isRepeat) await saveReshowCount(deps, input.requestId, reshowCount + 1);
    // В журнал - только числа: без текстов писем, адресов и названий.
    deps.log?.('order_request_text_prepared', {
      suppliers: blocks.length,
      withoutContact: withoutContact.length,
      blankFields: blankLabels.size,
      omittedFields: omittedCount,
    });
    return {
      requestId: input.requestId,
      shownSupplierIds: blocks.map((block) => block.supplierId),
      withoutContact,
      blankFields: [...blankLabels],
      notSent: true,
      mailConnected,
    };
  },
});
