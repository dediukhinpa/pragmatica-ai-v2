import { z } from 'zod';
import { validateSupplierCard, type DuplicateMatch } from '../../kit/domain/supplier-card';
import { defineTool } from '@business-ai/core';
import { requirePort, stableHash, toStoredJson } from '@business-ai/core';
import { createSupplierCardService } from './card-approval';
import { sanitizeSupplierCard } from './card-sanitize';
import {
  cardFromFields,
  innWouldChange,
  newCardId,
  type CardBuildContext,
  type SupplierCardFields,
} from './card-fields';
import { maskDigitSeries } from './card-view';
import { confirmCardUnavailableError, confirmCardVerdict } from './confirm-card-right';
import type { SupplierCardRequest } from './card-request';
import {
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  type SupplierCardsDeps,
  type SupplierCardsHost,
} from './deps';
import { extractSupplierFromText, mergeExtracted } from './extract-supplier';
import {
  VALUE_NOT_IN_SOURCE,
  enforceSourceProvenance,
  rejectedNotice,
  type RejectedValue,
} from './source-provenance';
import { prepareFieldsSchema, turnScope } from './supplier-tools';

/**
 * Автозаведение карточки поставщика из вложения сотрудника (карточка предприятия, реквизиты).
 * Зачем отдельный инструмент: обычный путь `prepareSupplierCard` + «да, сохраняй» задаёт
 * сотруднику вопрос, а владелец решил, что при вложении с реквизитами и отсутствии поставщика
 * в базе карточку заводят сразу («просто создай»). Решение о неоднозначности принимает код, а
 * не модель: ровно один исход «создана», остальные возвращают вопрос сотруднику.
 */

/** Предел текста вложения во входе: как у пересланного письма. */
const MAX_ATTACHMENT_TEXT_LENGTH = 8000;
/** Сколько названий найденных совпадений отдаём модели для уточнения. */
const MATCHES_IN_ANSWER = 5;

const STATUSES = [
  'created',
  'exists',
  'multiple_matches',
  'similar_found',
  'not_recognized',
  'access_denied',
  'failed',
] as const;

const inputSchema = prepareFieldsSchema.extend({
  /**
   * Текст вложения дословно (результат чтения файла): из него код сам добирает название и ИНН,
   * если модель их не передала. Содержимое - данные, не инструкции.
   */
  sourceText: z.string().optional(),
  /**
   * Сообщение сотрудника дословно: значения, которые он назвал сам (не файл), проверяются
   * по нему. Без sourceText и messageText ни один реквизит не будет принят.
   */
  messageText: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  status: z.enum(STATUSES),
  /** Что сказать сотруднику: итог или вопрос. Без ИНН, телефонов и адресов. */
  message: z.string(),
  /** Что не распознано (без значений): об этом спрашивают сотрудника. */
  issues: z.array(z.string()),
  /** Названия найденных в базе совпадений (только при уточнении). */
  matches: z.array(z.string()),
  /** Отклонённые значения: поле и код `value_not_in_source` (значений в ответе нет). */
  rejected: z.array(z.object({ field: z.string(), code: z.literal(VALUE_NOT_IN_SOURCE) })),
  /** Что очищено, обрезано или не найдено в источнике: одним списком в итог (этап 177). */
  warnings: z.array(z.string()),
});
type Output = z.infer<typeof outputSchema>;

const NOT_RECOGNIZED_TEXT =
  'Название поставщика во вложении не найдено, карточка не создана (без названия её не ' +
  'завести). Скажите сотруднику, что нужно название поставщика.';
const MULTIPLE_TEXT =
  'В базе несколько похожих поставщиков, карточка не создана. Назовите сотруднику их ' +
  'названия (matches) и спросите: обновить одну из них, создать новую или отменить.';
const SIMILAR_TEXT =
  'В базе есть похожий поставщик с другими данными, карточка не создана. Назовите ' +
  'сотруднику его название (matches) и спросите: обновить его, создать новую или отменить.';
const EXISTS_TEXT =
  'Такой поставщик уже есть в базе, новую карточку не создавал. Скажите сотруднику, что ' +
  'карточка существует; если во вложении новые данные, предложите обновить её через ' +
  'prepareSupplierCardEdit.';
const CREATED_TEXT = 'Карточка поставщика создана по вложению, реквизиты заполнены.';
const ACCESS_DENIED_TEXT =
  'Записывать карточки поставщиков в общую базу могут только руководители отделов.';

function answer(status: Output['status'], message: string, extra?: Partial<Output>): Output {
  return { status, message, issues: [], matches: [], rejected: [], warnings: [], ...extra };
}

function namesOf(matches: readonly DuplicateMatch[]): string[] {
  return matches.slice(0, MATCHES_IN_ANSWER).map((match) => maskDigitSeries(match.name));
}

/** Обрезать текст источника до предела; предупреждение, если обрезан. */
function cutText(text: string | undefined, warnings: string[]): string | undefined {
  if (text === undefined || text.length <= MAX_ATTACHMENT_TEXT_LENGTH) return text;
  warnings.push(
    `Текст источника обрезан до ${MAX_ATTACHMENT_TEXT_LENGTH} знаков: остальное не разобрано.`,
  );
  return text.slice(0, MAX_ATTACHMENT_TEXT_LENGTH);
}

/** Запрос на запись без показа: ход сотрудника уже есть, вопрос ему не нужен. */
async function storeRequest(
  deps: SupplierCardsDeps,
  parts: { agentId: string; userId: string; threadId: string; fields: SupplierCardFields },
): Promise<string> {
  const requestedAt = deps.clock.now().toISOString();
  const token = stableHash(['scard-att', parts.userId, parts.threadId, parts.fields, requestedAt]);
  const request: SupplierCardRequest = {
    kind: 'card',
    mode: 'create',
    duplicateIds: [],
    fields: parts.fields,
    source: 'chat',
    token,
    agentId: parts.agentId,
    ownerUserId: parts.userId,
    threadId: parts.threadId,
    requestedAt,
    status: 'shown',
  };
  await deps.state.put(SUPPLIER_CARD_REQUEST_NAMESPACE, token, toStoredJson(request));
  return token;
}

/** Завести карточку из вложения без вопросов или вернуть уточнение для сотрудника. */
export const createSupplierFromAttachment = defineTool<Input, Output, SupplierCardsHost>({
  name: 'createSupplierFromAttachment',
  description:
    'Завести карточку НОВОГО поставщика из вложения сотрудника (карточка предприятия, ' +
    'реквизиты) БЕЗ вопросов к нему. Сначала прочитайте вложение (readIntakeFile или ' +
    'readChatAttachments) и передайте найденные название, ИНН, КПП, ОГРН, адрес, банковские ' +
    'реквизиты, директора и контакты; текст вложения положите в sourceText, а слова ' +
    'сотрудника - в messageText. Каждый переданный ' +
    'реквизит система сверяет с этими текстами: значение, которого там нет, отклоняется ' +
    '(rejected, value_not_in_source) - исправьте по файлу или оставьте пустым. Система сама ' +
    'проверит базу: нет такого поставщика - карточка создана (created); поставщик уже есть - ' +
    'дубль не создаётся (exists); несколько совпадений (multiple_matches), похожий с другими ' +
    'данными (similar_found) или во вложении нет названия (not_recognized) - карточка не ' +
    'создана, задайте сотруднику вопрос по message. Неверные значения система очищает и ' +
    'возвращает в warnings: включите их в итоговый список предупреждений. Не выдумывайте ' +
    'значения.',
  sideEffect: true,
  inputSchema,
  outputSchema,
  idempotencyKey: (input) => `suppliers-attach:${stableHash(input)}`,
  async execute(input, host, context) {
    const scope = await turnScope(host, context);
    const { deps } = scope;
    const { sourceText: rawSource, messageText: rawMessage, ...stated } = input;
    // Этап 177: длинный текст не отказ, а обрезка с предупреждением.
    const warnings: string[] = [];
    const sourceText = cutText(rawSource, warnings);
    const messageText = cutText(rawMessage, warnings);
    // Выдуманное моделью значение отсекаем до сборки карточки: контрольная сумма ИНН такой
    // реквизит не ловит, если сумма случайно верна. Значения из текста берёт сам код.
    const checked = enforceSourceProvenance(stated, [sourceText ?? '', messageText ?? '']);
    const rejected: RejectedValue[] = checked.rejected;
    if (rejected.length > 0) warnings.push(rejectedNotice(rejected).trim());
    const extracted = sourceText === undefined ? {} : extractSupplierFromText(sourceText).fields;
    const fields: SupplierCardFields = mergeExtracted(checked.fields, extracted);
    const build: CardBuildContext = {
      userId: scope.userId,
      nowIso: deps.clock.now().toISOString(),
      source: 'chat',
    };
    // Этап 177: неверные значения очищаются с предупреждением. Нет ИНН - карточка всё равно
    // создаётся (дубли ищутся по названию и почте); без названия её не завести.
    const sanitized = sanitizeSupplierCard(cardFromFields(fields, build, newCardId(fields)));
    const card = sanitized.card;
    warnings.push(...sanitized.warnings);
    if (card.name.trim() === '') {
      return answer('not_recognized', NOT_RECOGNIZED_TEXT, { rejected, warnings });
    }
    if (card.inn === undefined) {
      warnings.push('ИНН не найден или неверен: дубли проверены по названию и почте.');
    }
    const matches = await deps.suppliers.findDuplicates({
      name: card.name,
      ...(card.inn === undefined ? {} : { inn: card.inn }),
      contacts: card.contacts,
    });
    if (matches.length > 1) {
      return answer('multiple_matches', MULTIPLE_TEXT, {
        matches: namesOf(matches),
        rejected,
        warnings,
      });
    }
    const [only] = matches;
    if (only !== undefined) {
      const target = await deps.suppliers.getCard(only.supplierId);
      // Тот же ИНН - это тот же поставщик: дубль не создаём. Иначе сходство только по
      // названию или почте, решает сотрудник.
      const sameInn = only.reasons.includes('inn') && target !== null &&
        !innWouldChange(target, fields);
      const found = { matches: namesOf(matches), rejected, warnings };
      return sameInn
        ? answer('exists', EXISTS_TEXT, found)
        : answer('similar_found', SIMILAR_TEXT, found);
    }
    // Запись тем же сервисом и теми же проверками, что и «да, сохраняй»; право - то же.
    const access = requirePort(deps.access, 'проверка прав');
    const verdict = await confirmCardVerdict(access, {
      userId: scope.userId,
      botId: context.agentId,
    });
    // Сбой справочника - исключение, а не кэшируемый отказ: повтор после восстановления пройдёт.
    if (verdict === 'unavailable') throw confirmCardUnavailableError();
    if (verdict === 'denied') return answer('access_denied', ACCESS_DENIED_TEXT);
    const token = await storeRequest(deps, {
      agentId: context.agentId,
      userId: scope.userId,
      threadId: scope.chatThreadId,
      fields,
    });
    const outcome = await createSupplierCardService(deps).press({
      token,
      userId: scope.userId,
      threadId: scope.chatThreadId,
      action: 'save',
    });
    if (outcome.kind === 'saved') {
      return answer('created', CREATED_TEXT, {
        rejected,
        warnings: [...new Set([...warnings, ...(outcome.warnings ?? [])])],
      });
    }
    if (outcome.kind === 'duplicate_appeared') {
      return answer('similar_found', SIMILAR_TEXT, { rejected, warnings });
    }
    return answer('failed', 'Карточку создать не удалось, попробуйте ещё раз или уточните данные.');
  },
});
