import { z } from 'zod';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../kit/domain/access.owned';
import { DomainError } from '@business-ai/core';
import {
  DUPLICATE_REASON_LABELS,
  MAX_EMAIL_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SUPPLY_ITEM_LENGTH,
  SUPPLIER_STATUS_LABELS,
  normalizeInn,
  normalizeSupplierCard,
  primaryContact,
  validateSupplierCard,
  type DuplicateMatch,
  type SupplierCard,
  type SupplierContact,
} from '../../kit/domain/supplier-card';
import { defineTool } from '@business-ai/core';
import {
  chatThreadOf,
  requireEmployee,
  requirePort,
  stableHash,
  toStoredJson,
} from '@business-ai/core';
import {
  MAX_INN_INPUT_LENGTH,
  applyFieldsToCard,
  innWouldChange,
  cardFromFields,
  hasAnyField,
  newCardId,
  supplierCardFieldsSchema,
  toolSourceSchema,
  type CardBuildContext,
  type SupplierCardFields,
} from './card-fields';
import {
  describeCardForModel,
  describeDuplicates,
  describeSupplierCard,
  innLast4,
  maskDigitSeries,
  maskEmail,
  maskPhone,
} from './card-view';
import {
  SUPPLIER_DECISION_HINTS,
  YES_NO_HINTS,
  decisionHintLine,
  notePendingSupplierRequest,
  type SupplierCardAction,
  type SupplierCardRequest,
} from './card-request';
import {
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  SUPPLIER_SEARCH_LIMIT,
  type SupplierCardsDeps,
  type SupplierCardsHost,
} from './deps';
import { extractSupplierFromText, mergeExtracted } from './extract-supplier';
import { sanitizeSupplierCard } from './card-sanitize';
import { enforceSourceProvenance, rejectedNotice } from './source-provenance';

/**
 * Инструменты подготовки карточек. Ни один из них не пишет в базу: «подготовить» только создаёт
 * запрос и показывает карточку с подсказкой ответа жирным; запись выполняет
 * `SupplierCardService.press` - по ответу сотрудника текстом (`confirmSupplierRequest`, только в
 * его ходе в чате) или по старой кнопке. Модели возвращается статус и замечания без значений:
 * ИНН, телефоны и адреса маскируются (никаких серий из 10 и более цифр).
 */

const MODULE_NAME = 'карточки поставщиков';
/** Предел текста пересланного письма во входе инструмента. */
const MAX_SOURCE_TEXT_LENGTH = 8000;
/** Сколько заметок карточки показывает поиск модели (последние). */
const NOTES_IN_RESULT = 3;
/** Знаки текста источника, после которых он обрезается. */
const SOURCE_CUT_NOTE = 'остальное не разобрано, пришлите его отдельно';

/** Обрезать текст источника до предела; предупреждение, если обрезан. */
function cutSourceText(text: string | undefined): { text: string | undefined; warnings: string[] } {
  if (text === undefined || text.length <= MAX_SOURCE_TEXT_LENGTH) return { text, warnings: [] };
  return {
    text: text.slice(0, MAX_SOURCE_TEXT_LENGTH),
    warnings: [`Текст источника обрезан до ${MAX_SOURCE_TEXT_LENGTH} знаков: ${SOURCE_CUT_NOTE}.`],
  };
}

/** Поля без ИНН, если проверка карточки его очистила (неверный ИНН в сравнении не участвует). */
function withoutClearedInn(fields: SupplierCardFields, card: SupplierCard): SupplierCardFields {
  if (fields.inn === undefined || card.inn !== undefined) return fields;
  const { inn: _inn, ...rest } = fields;
  return rest;
}
export const INN_QUERY = /^\d{10}$|^\d{12}$/;
/** Предел текста условия поиска по названию во входе инструмента. */
const MAX_SEARCH_QUERY_LENGTH = 200;

/** Зависимости, тред чата и сотрудник текущего хода. */
export interface TurnScope {
  deps: SupplierCardsDeps;
  userId: string;
  chatThreadId: string;
}

export async function turnScope(host: SupplierCardsHost, context: Parameters<typeof requireEmployee>[0] & {
  threadId: string;
}): Promise<TurnScope> {
  const deps = requirePort(host.supplierCards, MODULE_NAME);
  const userId = requireEmployee(context);
  const chatThreadId = await chatThreadOf(deps.state, {
    threadId: context.threadId,
    initiator: context.initiator,
  });
  if (chatThreadId === null) {
    throw new DomainError(
      'access_denied',
      'Карточка показывается только в чате сотрудника: из этого запуска показать некому.',
    );
  }
  return { deps, userId, chatThreadId };
}

/** Карточка в виде для модели: маскированные контакты, без полного ИНН. */
const maskedContactSchema = z.object({
  fullName: z.string().optional(),
  position: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  isPrimary: z.boolean(),
});
export const cardViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  hasInn: z.boolean(),
  innLast4: z.string().optional(),
  website: z.string().optional(),
  contacts: z.array(maskedContactSchema),
  categories: z.array(z.string()),
  brands: z.array(z.string()),
  regions: z.array(z.string()),
  terms: z.record(z.string()),
  recentNotes: z.array(z.string()),
  /** Поля разд. 10 ТЗ по разделам, пустые не печатаются; без логотипа и файлов. */
  details: z.string().optional(),
  source: z.string().optional(),
  updatedAt: z.string().optional(),
  /** Что неверно в записанных данных (без значений): такую карточку правят с исправлением. */
  dataIssues: z.array(z.string()).optional(),
});
export type CardView = z.infer<typeof cardViewSchema>;

function maskedContact(contact: SupplierContact): z.infer<typeof maskedContactSchema> {
  return {
    ...(contact.fullName === undefined ? {} : { fullName: maskDigitSeries(contact.fullName) }),
    ...(contact.position === undefined ? {} : { position: maskDigitSeries(contact.position) }),
    ...(contact.email === undefined ? {} : { email: maskEmail(contact.email) }),
    ...(contact.phone === undefined ? {} : { phone: maskPhone(contact.phone) }),
    isPrimary: contact.isPrimary,
  };
}

/** Карточка для модели: контакты маскированы, ИНН только последние четыре цифры. */
export function cardViewForModel(card: SupplierCard): CardView {
  const dataIssues = validateSupplierCard(normalizeSupplierCard(card)).map((item) => item.message);
  const terms: Record<string, string> = {};
  for (const [key, value] of Object.entries(card.terms)) {
    if (value !== undefined) terms[key] = maskDigitSeries(value);
  }
  const details = describeCardForModel(card);
  const main = primaryContact(card.contacts);
  const others = card.contacts.filter((contact) => contact !== main);
  const ordered = main === undefined ? card.contacts : [main, ...others];
  return {
    id: card.id,
    name: maskDigitSeries(card.name),
    status: SUPPLIER_STATUS_LABELS[card.status],
    hasInn: card.inn !== undefined,
    ...(card.inn === undefined ? {} : { innLast4: innLast4(card.inn) }),
    ...(card.website === undefined ? {} : { website: maskDigitSeries(card.website) }),
    contacts: ordered.map(maskedContact),
    categories: card.supplies.categories.map(maskDigitSeries),
    brands: card.supplies.brands.map(maskDigitSeries),
    regions: card.supplies.regions.map(maskDigitSeries),
    terms,
    recentNotes: card.notes.slice(-NOTES_IN_RESULT).map((note) => maskDigitSeries(note.text)),
    ...(details === '' ? {} : { details }),
    ...(card.source === undefined ? {} : { source: card.source }),
    ...(card.updatedAt === undefined ? {} : { updatedAt: card.updatedAt }),
    ...(dataIssues.length === 0 ? {} : { dataIssues }),
  };
}

/** Поиск карточек: условия действуют вместе; ИНН и адрес в выдаче маскированы. */
export const findSupplierCard = defineTool<
  {
    id?: string | undefined;
    query?: string | undefined;
    inn?: string | undefined;
    email?: string | undefined;
    category?: string | undefined;
    brand?: string | undefined;
  },
  { count: number; cards: CardView[] },
  SupplierCardsHost
>({
  name: 'findSupplierCard',
  description:
    'Найти карточку поставщика в общей базе: по id, названию, ИНН, email, категории или ' +
    'бренду (условия действуют вместе). В ответе ИНН и телефоны маскированы: покажите ' +
    'сотруднику только то, что вернул инструмент, и не пытайтесь восстановить номера. ' +
    'Поле details - условия, доставка, документы, продукция, сервис и оценка по разделам ТЗ ' +
    '(без логотипа и файлов).',
  inputSchema: z
    .object({
      id: z.string().min(1).optional(),
      query: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH).optional(),
      inn: z.string().trim().min(1).max(MAX_INN_INPUT_LENGTH).optional(),
      email: z.string().trim().min(1).max(MAX_EMAIL_LENGTH).optional(),
      category: z.string().trim().min(1).max(MAX_SUPPLY_ITEM_LENGTH).optional(),
      brand: z.string().trim().min(1).max(MAX_SUPPLY_ITEM_LENGTH).optional(),
    }),
  outputSchema: z.object({ count: z.number().int(), cards: z.array(cardViewSchema) }),
  async execute(input, host) {
    const deps = requirePort(host.supplierCards, MODULE_NAME);
    // Сочетание полей проверяет код (схема остаётся плоской).
    const hasCondition = [
      input.id,
      input.query,
      input.inn,
      input.email,
      input.category,
      input.brand,
    ].some((item) => item !== undefined);
    if (!hasCondition) {
      throw new DomainError('invalid_input', 'Нужно хотя бы одно условие поиска.');
    }
    if (input.id !== undefined) {
      const card = await deps.suppliers.getCard(input.id);
      return card === null
        ? { count: 0, cards: [] }
        : { count: 1, cards: [cardViewForModel(card)] };
    }
    // Запрос из одних цифр нужной длины - это ИНН: ищем по нему, а не по подстроке названия.
    const queryDigits = input.query === undefined ? '' : normalizeInn(input.query);
    const byInn = input.inn ?? (INN_QUERY.test(queryDigits) ? queryDigits : undefined);
    const byName = byInn !== undefined && input.inn === undefined ? undefined : input.query;
    const cards = await deps.suppliers.searchCards({
      ...(byName === undefined ? {} : { query: byName }),
      ...(byInn === undefined ? {} : { inn: byInn }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.brand === undefined ? {} : { brand: input.brand }),
      limit: SUPPLIER_SEARCH_LIMIT,
    });
    return { count: cards.length, cards: cards.map(cardViewForModel) };
  },
});

/** Итог подготовки: статус, замечания, найденные дубли (названия и причины). */
const prepareOutputSchema = z.object({
  status: z.enum(['shown', 'invalid', 'no_changes']),
  /** `shown`: карточка показана сотруднику, ждём его ответа; в базе пока ничего нет. */
  message: z.string(),
  /** Id показанного запроса: его передают в confirmSupplierRequest. */
  requestId: z.string().optional(),
  issues: z.array(z.string()),
  warnings: z.array(z.string()),
  duplicates: z.array(z.object({ name: z.string(), reasons: z.array(z.string()) })),
});
type PrepareOutput = z.infer<typeof prepareOutputSchema>;

/** Остаток отказа правки: после очистки замечание всё ещё есть (сюда не должны попадать). */
const EDIT_INVALID_MESSAGE = 'Правка не показана: исправьте замечания и подготовьте её заново.';

const SHOWN_MESSAGE =
  'Карточка показана сотруднику с подсказкой ответа. В базе пока ничего не записано: закончи ' +
  'ход и дождись ответа, затем вызови confirmSupplierRequest с его решением.';

/** Подсказка ответа для показа карточки: примеры ответа, для «сохранить» - и поправка. */
function cardHint(actions: readonly SupplierCardAction[]): string {
  const labels = actions.map((action) => SUPPLIER_DECISION_HINTS[action]);
  const correction = actions.includes('save')
    ? 'Можно сразу с поправкой: «сохрани, но телефон другой: …».'
    : undefined;
  return decisionHintLine(labels, correction);
}

function duplicatesForModel(matches: readonly DuplicateMatch[]): PrepareOutput['duplicates'] {
  return matches.map((match) => ({
    name: maskDigitSeries(match.name),
    reasons: match.reasons.map((reason) => DUPLICATE_REASON_LABELS[reason]),
  }));
}

function warningsFor(card: SupplierCard): string[] {
  const warnings: string[] = [];
  if (card.inn === undefined) warnings.push('ИНН не указан: дубли ищутся по почте и названию.');
  if (card.contacts.length === 0) warnings.push('Нет ни одного контакта.');
  return warnings;
}

function candidateOf(card: SupplierCard, withId: boolean): Parameters<
  SupplierCardsDeps['suppliers']['findDuplicates']
>[0] {
  return {
    ...(withId ? { id: card.id } : {}),
    name: card.name,
    ...(card.inn === undefined ? {} : { inn: card.inn }),
    contacts: card.contacts,
  };
}

async function assertMayConfirmCard(scope: TurnScope, agentId: string): Promise<void> {
  const { access } = scope.deps;
  if (access === undefined) return;
  const request = { userId: scope.userId, botId: agentId, action: ACTION_CONFIRM_SUPPLIER_CARD };
  let decision: { allowed: boolean; reason?: string | undefined };
  try {
    decision =
      access.decide === undefined
        ? { allowed: await access.isAllowed(request) }
        : await access.decide(request);
  } catch {
    throw new DomainError('access_denied', SHOW_UNAVAILABLE_TEXT);
  }
  if (decision.allowed) return;
  throw new DomainError(
    'access_denied',
    decision.reason === 'directory_unavailable' ? SHOW_UNAVAILABLE_TEXT : SHOW_DENIED_TEXT,
  );
}

/** Показ записи в общую базу тому, кто не вправе её подтвердить, бессмыслен. */
const SHOW_DENIED_TEXT =
  'Записывать карточки поставщиков в общую базу могут только руководители отделов: ' +
  'карточка не показана и не записана. Личную заметку (запомни ...) можно сохранить и вам.';
/** Справочник руководителей недоступен: временный сбой. */
const SHOW_UNAVAILABLE_TEXT =
  'Не удалось проверить, что сотрудник руководитель отдела, поэтому карточка не показана. ' +
  'Это временный сбой: повторите запрос чуть позже.';

/**
 * Записать запрос, показать текст с подсказкой ответа и запомнить показ как ждущий ответа
 * (общий конец «подготовить»). Возвращает токен запроса. Запись в общую базу (всё, кроме личной
 * заметки) показывается только тому, кто вправе её подтвердить (`suppliers.confirm_card`,
 * руководитель отдела): иначе ответ «да» всё равно закончился бы отказом, а карточка и подсказка
 * ответа только вводили бы в заблуждение. Нет политики прав - показ как раньше (запись всё
 * равно проверяет подтверждение).
 */
export async function showRequest(
  scope: TurnScope,
  agentId: string,
  parts: Pick<
    SupplierCardRequest,
    | 'kind'
    | 'mode'
    | 'targetId'
    | 'baseUpdatedAt'
    | 'duplicateIds'
    | 'fields'
    | 'noteText'
    | 'pairNoteKind'
    | 'source'
  >,
  shown: { text: string; actions: SupplierCardAction[] },
): Promise<string> {
  if (parts.kind !== 'pair_note') await assertMayConfirmCard(scope, agentId);
  const requestedAt = scope.deps.clock.now().toISOString();
  const token = stableHash(['scard', scope.userId, scope.chatThreadId, parts, requestedAt]);
  const request: SupplierCardRequest = {
    ...parts,
    token,
    agentId,
    ownerUserId: scope.userId,
    threadId: scope.chatThreadId,
    requestedAt,
    status: 'shown',
  };
  await scope.deps.state.put(SUPPLIER_CARD_REQUEST_NAMESPACE, token, toStoredJson(request));
  await scope.deps.chat.reply(scope.chatThreadId, { text: shown.text }, `scard:${token}`);
  await notePendingSupplierRequest(scope.deps.state, scope.chatThreadId, {
    token,
    actions: shown.actions,
  });
  return token;
}

/** Поля инструмента подготовки новой карточки: без полей «убрать» (они для правки). */
export const prepareFieldsSchema = supplierCardFieldsSchema.omit({
  removeContacts: true,
  clear: true,
  removeCategories: true,
  removeBrands: true,
  removeRegions: true,
});

const prepareInputSchema = prepareFieldsSchema.extend({
  /** Откуда данные: чат (по умолчанию) или пересланное письмо. */
  source: toolSourceSchema.default('chat'),
  /**
   * Текст пересланного письма или визитки дословно: из него код сам возьмёт почту, телефон,
   * ИНН, сайт, ФИО и должность, не выдумывая недостающее.
   */
  sourceText: z.string().optional(),
  /** Слова сотрудника дословно: вместе с sourceText служат источником для проверки реквизитов. */
  messageText: z.string().optional(),
});
type PrepareInput = z.infer<typeof prepareInputSchema>;

/** Варианты ответа: без дублей - «сохранить», с дублями - выбор (без «обновить» при другом ИНН). */
function duplicateActions(hasDuplicates: boolean, innDiffers: boolean): SupplierCardAction[] {
  if (!hasDuplicates) return ['save', 'cancel'];
  return innDiffers ? ['create', 'cancel'] : ['update', 'create', 'cancel'];
}

/**
 * Текст показа новой карточки. Без дублей - «как будет сохранена». С дублем и совпадающим
 * ИНН - итог «Обновить существующую» (целевая карточка названа) и новая для «Создать новую».
 * С другим ИНН у дубля - только новая карточка и пояснение, почему обновления нет.
 */
function duplicateAwareText(
  card: SupplierCard,
  matches: readonly DuplicateMatch[],
  target: SupplierCard | null,
  updated: SupplierCard | null,
  innDiffers: boolean,
): string {
  if (matches.length === 0) {
    return [
      describeSupplierCard(card, 'Карточка поставщика (как будет сохранена):'),
      '',
      'Сохранить карточку в общую базу?',
    ].join('\n');
  }
  const created = describeSupplierCard(card, 'Создать новую (как будет сохранена):');
  if (target !== null && innDiffers) {
    return [
      created,
      '',
      describeDuplicates(matches),
      `Обновить нельзя: у «${target.name}» ИНН ${target.inn ?? 'не указан'}, ` +
        `а в новых данных ИНН ${card.inn ?? 'не указан'}.`,
      'Что сделать: создать новую или отменить?',
    ].join('\n');
  }
  if (target !== null && updated !== null) {
    return [
      describeSupplierCard(updated, `Обновить существующую: «${target.name}» - станет так:`),
      '',
      created,
      '',
      describeDuplicates(matches),
      'Что сделать: обновить существующую, создать новую или отменить?',
    ].join('\n');
  }
  return [
    created,
    '',
    describeDuplicates(matches),
    'Что сделать: обновить существующую, создать новую или отменить?',
  ].join('\n');
}

/** Подготовить новую карточку: проверка, поиск дублей, показ сотруднику с кнопками. */
export const prepareSupplierCard = defineTool<PrepareInput, PrepareOutput, SupplierCardsHost>({
  name: 'prepareSupplierCard',
  description:
    'Подготовить НОВУЮ карточку поставщика: система проверит данные, найдёт похожих в базе ' +
    'и сама покажет сотруднику карточку «как будет сохранена» с подсказкой ответа. Записать ' +
    'её можно только по ответу сотрудника: закончи ход, дождись его ответа и вызови ' +
    'confirmSupplierRequest. Передайте ' +
    'только то, что сообщил сотрудник; не выдумывайте ИНН, адреса и телефоны. Для ' +
    'пересланного письма или визитки положите текст в sourceText и укажите source=email. ' +
    'После вызова не пересказывайте карточку: она уже показана.',
  inputSchema: prepareInputSchema,
  outputSchema: prepareOutputSchema,
  async execute(input, host, context) {
    const scope = await turnScope(host, context);
    const { source, ...rawGiven } = input;
    const { sourceText: rawSource, messageText: rawMessage, ...given } = rawGiven;
    // Этап 177: длинный текст источника не отказ, а обрезка с предупреждением.
    const sourceCut = cutSourceText(rawSource);
    const messageCut = cutSourceText(rawMessage);
    const sourceText = sourceCut.text;
    const messageText = messageCut.text;
    const cutWarnings = [...sourceCut.warnings, ...messageCut.warnings];
    // Проверка по тексту только когда он передан: без него данные названы в чате сотрудником
    // и карточка всё равно показывается ему на подтверждение.
    const sources = [sourceText, messageText].filter((text) => text !== undefined);
    const checked = sources.length === 0 ? null : enforceSourceProvenance(given, sources);
    const extracted = sourceText === undefined ? {} : extractSupplierFromText(sourceText).fields;
    const fields: SupplierCardFields = mergeExtracted(checked?.fields ?? given, extracted);
    const build: CardBuildContext = {
      userId: scope.userId,
      nowIso: scope.deps.clock.now().toISOString(),
      source,
    };
    // Этап 177: значения, не прошедшие проверку, очищаются с предупреждением, карточка
    // показывается. Отказ остаётся только без названия: нет ключа записи.
    const sanitized = sanitizeSupplierCard(cardFromFields(fields, build, newCardId(fields)));
    const card = sanitized.card;
    const issues = validateSupplierCard(card);
    if (issues.length > 0) {
      return {
        status: 'invalid',
        message: 'Карточка не показана: укажите название поставщика и подготовьте её заново.',
        issues: issues.map((issue) => issue.message),
        warnings: sanitized.warnings,
        duplicates: [],
      };
    }
    const matches = await scope.deps.suppliers.findDuplicates(candidateOf(card, false));
    const hasDuplicates = matches.length > 0;
    // Версия цели «Обновить существующую» на момент показа: на нажатии она должна совпасть.
    const target =
      matches[0] === undefined ? null : await scope.deps.suppliers.getCard(matches[0].supplierId);
    // Другой ИНН у найденного: «Обновить» подменила бы поставщика, предлагаем только создание.
    // Неверный ИНН уже очищен в карточке: сравнивать с целью его не нужно.
    const effective = withoutClearedInn(fields, card);
    const innDiffers = target !== null && innWouldChange(target, effective);
    // Показ обновления - результат наложения полей на целевую карточку, а не новая карточка.
    const updated =
      target === null || innDiffers
        ? null
        : sanitizeSupplierCard(applyFieldsToCard(target, effective, build)).card;
    const actions = duplicateActions(hasDuplicates, innDiffers);
    const requestId = await showRequest(
      scope,
      context.agentId,
      {
        kind: 'card',
        mode: 'create',
        ...(matches[0] === undefined ? {} : { targetId: matches[0].supplierId }),
        ...(target?.updatedAt === undefined ? {} : { baseUpdatedAt: target.updatedAt }),
        duplicateIds: matches.map((match) => match.supplierId),
        fields,
        source,
      },
      {
        text: [
          duplicateAwareText(card, matches, target, updated, innDiffers),
          cardHint(actions),
        ].join('\n'),
        actions,
      },
    );
    return {
      status: 'shown',
      message: SHOWN_MESSAGE,
      requestId,
      issues: [],
      warnings: [
        ...sanitized.warnings,
        ...cutWarnings,
        ...warningsFor(card),
        ...(checked === null || checked.rejected.length === 0
          ? []
          : [rejectedNotice(checked.rejected).trim()]),
      ],
      duplicates: duplicatesForModel(matches),
    };
  },
});

/** Сравнимое содержимое карточки: без служебных отметок изменения. */
function contentHash(card: SupplierCard): string {
  const { updatedAt: _at, updatedBy: _by, ...rest } = normalizeSupplierCard(card);
  return stableHash(rest);
}

const editInputSchema = z.object({
  supplierId: z.string().min(1),
  /** Только изменяемые поля: остальные в карточке сохраняются. */
  changes: supplierCardFieldsSchema,
});

/** Подготовить правку существующей карточки: меняются только переданные поля. */
export const prepareSupplierCardEdit = defineTool<
  z.infer<typeof editInputSchema>,
  PrepareOutput,
  SupplierCardsHost
>({
  name: 'prepareSupplierCardEdit',
  description:
    'Подготовить правку СУЩЕСТВУЮЩЕЙ карточки поставщика по id (его даёт findSupplierCard): ' +
    'меняются только переданные поля, контакты дополняются (совпавшие по почте или ФИО ' +
    'обновляются), списки категорий, брендов и регионов дополняются, убрать позиции можно ' +
    'через remove*. Контакт убирают через removeContacts (по почте или ФИО), заменяют парой ' +
    'removeContacts + contacts; неверные ИНН или сайт очищают через clear. Если в ответе ' +
    'findSupplierCard у карточки есть dataIssues, исправьте или уберите эти данные в той же ' +
    'правке: заведомо неверное система не запишет. Система покажет сотруднику итоговую ' +
    'карточку с подсказкой ответа; записать правку можно только по его ответу - закончи ход, ' +
    'дождись ответа и вызови confirmSupplierRequest. Не пересказывайте карточку.',
  inputSchema: editInputSchema,
  outputSchema: prepareOutputSchema,
  async execute(input, host, context) {
    const scope = await turnScope(host, context);
    return prepareEditRequest(scope, context.agentId, input);
  },
});

/**
 * Показать сотруднику правку существующей карточки и запомнить запрос на подтверждение. Общий
 * шаг `prepareSupplierCardEdit` и ответа на предложение по почте (222): реквизиты письма
 * применяются только этим путём, после ответа сотрудника.
 */
export async function prepareEditRequest(
  scope: TurnScope,
  agentId: string,
  input: z.infer<typeof editInputSchema>,
): Promise<PrepareOutput> {
  const existing = await scope.deps.suppliers.getCard(input.supplierId);
  if (existing === null) {
    throw new DomainError('not_found', 'Карточка поставщика с таким id не найдена.');
  }
  if (!hasAnyField(input.changes)) {
    return {
      status: 'no_changes',
      message: 'Не переданы поля для изменения: карточка не меняется.',
      issues: [],
      warnings: [],
      duplicates: [],
    };
  }
  const build: CardBuildContext = {
    userId: scope.userId,
    nowIso: scope.deps.clock.now().toISOString(),
    source: existing.source ?? 'chat',
  };
  // Этап 177: неверное (и в правке, и в прежних данных карточки) очищается с
  // предупреждением, правка показывается. Название у существующей карточки есть всегда.
  const sanitized = sanitizeSupplierCard(applyFieldsToCard(existing, input.changes, build));
  const card = sanitized.card;
  const issues = validateSupplierCard(card);
  if (issues.length > 0) {
    return {
      status: 'invalid',
      message: EDIT_INVALID_MESSAGE,
      issues: issues.map((issue) => issue.message),
      warnings: sanitized.warnings,
      duplicates: [],
    };
  }
  if (contentHash(card) === contentHash(existing)) {
    return {
      status: 'no_changes',
      message: 'Переданные значения совпадают с карточкой: менять нечего.',
      issues: [],
      warnings: [],
      duplicates: [],
    };
  }
  const matches = await scope.deps.suppliers.findDuplicates(candidateOf(card, true));
  const editActions: SupplierCardAction[] = ['save', 'cancel'];
  const requestId = await showRequest(
    scope,
    agentId,
    {
      kind: 'card',
      mode: 'edit',
      targetId: existing.id,
      ...(existing.updatedAt === undefined ? {} : { baseUpdatedAt: existing.updatedAt }),
      duplicateIds: matches.map((match) => match.supplierId),
      fields: input.changes,
      source: build.source,
    },
    {
      text: [
        describeSupplierCard(
          card,
          `Карточка «${existing.name}» после правки (как будет сохранена):`,
        ),
        ...(matches.length > 0 ? ['', describeDuplicates(matches)] : []),
        '',
        'Сохранить изменения?',
        cardHint(editActions),
      ].join('\n'),
      actions: editActions,
    },
  );
  return {
    status: 'shown',
    message: SHOWN_MESSAGE,
    requestId,
    issues: [],
    warnings: sanitized.warnings,
    duplicates: duplicatesForModel(matches),
  };
}

const noteInputSchema = z.object({
  supplierId: z.string().min(1),
  text: z.string().trim().min(1),
});

/** Подготовить заметку к общей карточке: добавляется после подтверждения сотрудника. */
export const addSupplierNote = defineTool<
  z.infer<typeof noteInputSchema>,
  PrepareOutput,
  SupplierCardsHost
>({
  name: 'addSupplierNote',
  description:
    'Подготовить заметку к общей карточке поставщика (по id из findSupplierCard). Заметка ' +
    'видна всем сотрудникам, поэтому добавляется только после его ответа «да» ' +
    '(confirmSupplierRequest в следующем ходе); автором будет он. Личные заметки сотрудника - ' +
    'rememberForMe.',
  // Каждый вызов выдаёт новый токен и новую карточку: повтор даст две одинаковые общие заметки.
  replay: 'confirm',
  inputSchema: noteInputSchema,
  outputSchema: prepareOutputSchema,
  async execute(input, host, context) {
    const scope = await turnScope(host, context);
    const existing = await scope.deps.suppliers.getCard(input.supplierId);
    if (existing === null) {
      throw new DomainError('not_found', 'Карточка поставщика с таким id не найдена.');
    }
    // Этап 177: длинная заметка обрезается с предупреждением, а не отклоняется.
    const noteText = input.text.slice(0, MAX_NOTE_LENGTH);
    const noteWarnings =
      noteText.length < input.text.length
        ? [`Заметка длиннее ${MAX_NOTE_LENGTH} знаков: обрезана, проверьте конец.`]
        : [];
    const requestId = await showRequest(
      scope,
      context.agentId,
      {
        kind: 'note',
        mode: 'edit',
        targetId: existing.id,
        duplicateIds: [],
        noteText,
        source: 'chat',
      },
      {
        text: [
          `Добавить заметку к карточке «${existing.name}»:`,
          noteText,
          decisionHintLine([YES_NO_HINTS.save, YES_NO_HINTS.cancel]),
        ].join('\n'),
        actions: ['save', 'cancel'],
      },
    );
    return {
      status: 'shown',
      message: SHOWN_MESSAGE,
      requestId,
      issues: [],
      warnings: noteWarnings,
      duplicates: [],
    };
  },
});
