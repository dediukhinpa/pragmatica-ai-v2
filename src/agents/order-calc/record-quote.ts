import { z } from 'zod';
import { allowedVatRatesText } from '../../kit/domain/vat';
import { DomainError, type ValidationIssue } from '@business-ai/core';
import {
  findQuoteGaps,
  findRequestItemMatch,
  quoteDraftSchema,
  validateQuoteDraft,
  type QuoteDraft,
} from '../../kit/domain/quotes';
import { parseIsoDeadline } from '../../kit/domain/iso-datetime';
import {
  quoteGapSchema,
  type PurchaseRequest,
  type QuoteGap,
  type SupplierQuote,
} from '../../kit/domain/models';
import { schemaValidator, type AgentValidator } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { joinKey, predecessorOf, stableHash } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import { consumeQuoteReplacement, loadQuoteReplacement } from './quote-replacement';
import { loadReplies } from './reply-store';
import { loadSelection } from './state';

interface RecordQuoteInput extends QuoteDraft {
  requestId: string;
  supplierId: string;
  /** Идентификатор ответа (письма или записи сотрудника, replyId), из которого разобрано КП. */
  sourceRef: string;
}
interface RecordQuoteOutput {
  quoteId: string;
  /** Чего не хватает у этого поставщика: пропущенные поля не выдумываются. */
  gaps: QuoteGap[];
  lines: number;
  /** Что записано не по заявке или с допущением: проверить; запись при этом выполнена. */
  warnings?: string[] | undefined;
}

/** Код блокирующего замечания: КП чужого поставщика не пишем (чужие данные). */
const BLOCKING_QUOTE_ISSUES: readonly string[] = ['supplier_not_in_selection'];
/** Сколько знаков названия строки КП цитируем в предупреждении. */
const WARNING_NAME_MAX_CHARS = 80;
/** Дата «день.месяц.год» (точки): порядок однозначен, в отличие от «01/02/2026». */
const RU_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const DATE_PART_WIDTH = 2;

const inputSchema = quoteDraftSchema.extend({
  // Срок действия разбирает код (`softValidUntil`): кривая дата не повод отказать записи КП.
  validUntil: z.string().optional(),
  requestId: z.string().min(1),
  supplierId: z.string().min(1),
  sourceRef: z.string().min(1),
});

/** Ключ: заявка + поставщик + содержимое КП (изменённое КП — новая операция). */
export function recordQuoteKey(input: RecordQuoteInput): string {
  const { requestId, supplierId, ...content } = input;
  return joinKey('order-quote', requestId, supplierId, stableHash(content));
}

/** Содержимое КП без служебных полей: по нему различаются версии одного КП. */
function quoteContent(quote: QuoteDraft & { sourceRef?: string | undefined }): unknown {
  return {
    lines: quote.lines,
    currency: quote.currency,
    deliveryDays: quote.deliveryDays,
    paymentTerms: quote.paymentTerms,
    validUntil: quote.validUntil,
    notes: quote.notes,
    sourceRef: quote.sourceRef,
  };
}

/**
 * НДС, указанный для всего КП, переносится в позиции без собственного признака: КП хранится
 * позиционно, а сравнение смотрит на позиции (R4-ALG-4). Свои значения позиции не затираются.
 */
function withQuoteVat(input: QuoteDraft): QuoteDraft['lines'] {
  const { vatIncluded, vatRate } = input;
  if (vatIncluded === undefined && vatRate === undefined) return input.lines;
  return input.lines.map((line) => ({
    ...line,
    ...(line.vatIncluded === undefined && vatIncluded !== undefined ? { vatIncluded } : {}),
    ...(line.vatRate === undefined && vatRate !== undefined ? { vatRate } : {}),
  }));
}

/**
 * Срок действия КП: ISO как есть, «дд.мм.гггг» переводится в ISO, остальное - пусто и
 * предупреждение (в «чего не хватает» попадёт `no_validity`). Ничего не угадываем.
 */
export function softValidUntil(raw: string | undefined): {
  value?: string;
  warning?: string;
} {
  const text = raw?.trim() ?? '';
  if (text === '') return {};
  if (parseIsoDeadline(text) !== undefined) return { value: text };
  const match = RU_DATE.exec(text);
  if (match !== null) {
    const [, day = '', month = '', year = ''] = match;
    const pad = (part: string): string => part.padStart(DATE_PART_WIDTH, '0');
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    if (parseIsoDeadline(iso) !== undefined) return { value: iso };
  }
  return { warning: 'срок действия КП не распознан, оставлен пустым: уточните его у поставщика' };
}

/** Название строки для предупреждения: одной строкой и не длиннее предела. */
function shortName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, WARNING_NAME_MAX_CHARS);
}

/**
 * Строки КП вне заявки или неоднозначные записываются как дополнительные (`isReplacement`):
 * привязку к позиции не выдумываем, сравнение их не учитывает как ответ по позиции. Предупреждения
 * (этап 177) вместо прежнего отказа: валюта нестандартная, дубль позиции, строка не из заявки.
 */
function classifyQuoteLines(
  input: RecordQuoteInput,
  request: PurchaseRequest,
  lines: QuoteDraft['lines'],
): { lines: QuoteDraft['lines']; warnings: string[] } {
  const warnings: string[] = [];
  const checked = lines.map((line) => {
    if (line.isReplacement === true) return line;
    const match = findRequestItemMatch(line.productName, request.items);
    if (match.kind === 'match') return line;
    const name = shortName(line.productName);
    warnings.push(
      match.kind === 'ambiguous'
        ? `«${name}» подходит нескольким позициям заявки: привязка не выбрана, проверьте`
        : `«${name}» нет в заявке: записано как дополнительная позиция, проверьте`,
    );
    return { ...line, isReplacement: true };
  });
  const issues = validateQuoteDraft(input, {
    request,
    allowedSupplierIds: [input.supplierId],
    supplierId: input.supplierId,
  });
  for (const issue of issues) {
    if (issue.code === 'unknown_currency') {
      warnings.push(`валюта ${input.currency} нестандартная: сравнение без пересчёта, проверьте`);
    } else if (issue.code === 'duplicate_line') {
      warnings.push(`${issue.message.replace(/\.$/, '')}: проверьте, какая цена верна`);
    }
  }
  return { lines: checked, warnings };
}

/** Идентификатор КП: одно актуальное КП поставщика по заявке. */
export function quoteIdOf(requestId: string, supplierId: string): string {
  return joinKey('quote', requestId, supplierId);
}

/**
 * R3-SEC-2: источник КП проверяет код, а не модель. Ответ с таким `sourceRef` должен быть
 * сохранён по этой заявке и принадлежать этому же поставщику (иначе письмо одного поставщика
 * записалось бы КП другого). Уже записанное КП из ДРУГОГО источника не перезаписывается
 * без решения менеджера («заменить КП» в чате, R4-AGT-5): подтверждение пишет код чата,
 * относится к этому ответу, действует 24 часа и расходуется одним сохранением. Уточнение
 * разбора того же источника допускается.
 */
async function checkQuoteSource(
  input: RecordQuoteInput,
  deps: OrderCalcDeps,
): Promise<ValidationIssue[]> {
  const replies = await loadReplies(deps.state, input.requestId);
  const source = replies.find((reply) => reply.id === input.sourceRef);
  if (source === undefined) {
    return [
      {
        code: 'source_not_found',
        message:
          `Ответ ${input.sourceRef} по заявке ${input.requestId} не найден: передай replyId ` +
          'из readSupplierReplies.',
      },
    ];
  }
  if (source.supplierId !== input.supplierId) {
    return [
      {
        code: 'source_supplier_mismatch',
        message: `Ответ ${input.sourceRef} получен не от поставщика ${input.supplierId}.`,
      },
    ];
  }
  const current = await deps.quotes.get(input.requestId, input.supplierId);
  if (current !== null && current.sourceRef !== input.sourceRef) {
    const approval = await loadQuoteReplacement(
      deps.state,
      deps.clock,
      input.requestId,
      input.supplierId,
      input.sourceRef,
    );
    if (approval !== null) return [];
    return [
      {
        code: 'quote_source_conflict',
        message:
          `КП поставщика ${input.supplierId} уже записано из другого источника. ` +
          'Перезапись только по решению менеджера: код спросит его о замене при чтении ' +
          'ответов; после его согласия вызови confirmQuoteReplacement, до этого не повторяй ' +
          'запись.',
      },
    ];
  }
  return [];
}

/**
 * Проверка КП перед сохранением: поставщик из выбора менеджера, позиции из заявки или явно
 * «замена», валюта известна. Цены положительные проверяет схема.
 */
export const quoteValidator: AgentValidator<OrderCalcDeps> = schemaValidator({
  name: 'supplier-quote',
  tool: 'recordQuote',
  schema: inputSchema,
  withSchemaError: true,
  async check(input, deps) {
    const request = await deps.requests.get(input.requestId);
    if (request === null) {
      return [
        { code: 'request_not_found', message: `Заявка ${input.requestId} не найдена.` },
      ];
    }
    const selection = await loadSelection(deps, input.requestId);
    if (selection === null) {
      return [{ code: 'no_selection', message: 'Менеджер ещё не выбрал поставщиков по заявке.' }];
    }
    const sourceIssues = await checkQuoteSource(input, deps);
    if (sourceIssues.length > 0) return sourceIssues;
    // Блокирует только чужой поставщик; остальное (вне заявки, дубль, валюта) - предупреждения
    // при записи (этап 177), а не отказ.
    return validateQuoteDraft(input, {
      request,
      allowedSupplierIds: selection.supplierIds,
      supplierId: input.supplierId,
    }).filter((issue) => BLOCKING_QUOTE_ISSUES.includes(issue.code));
  },
});

/** Сохранить разобранное КП поставщика и пометки «чего не хватает». */
export const recordQuote = defineTool<RecordQuoteInput, RecordQuoteOutput, OrderCalcDeps>({
  name: 'recordQuote',
  description:
    'Сохранить КП поставщика, разобранное из его ответа: requestId, supplierId, currency, ' +
    'lines (productName, unitPrice, quantity, unit, deliveryDays, isReplacement, notes, ' +
    'vatIncluded, vatRate, packSize, minOrder), vatIncluded и vatRate для всего КП ' +
    `(ставка ровно как в ответе, действующие: ${allowedVatRatesText()}; не заменяй), ` +
    'deliveryDays, paymentTerms, validUntil (ISO 8601: дата или дата-время с поясом; ' +
    '«дд.мм.гггг» код переведёт сам, нечитаемое оставит пустым с предупреждением), notes, ' +
    'sourceRef. Передавай только то, ' +
    'что есть в ответе: чего нет, оставь пустым, это попадёт в «чего не хватает». Позиция вне ' +
    'заявки, неоднозначная или нестандартная валюта не блокируют запись: КП сохраняется, а ' +
    'причина приходит в warnings. Поставщик только из выбора менеджера.',
  sideEffect: true,
  inputSchema,
  outputSchema: z.object({
    quoteId: z.string(),
    gaps: z.array(quoteGapSchema),
    lines: z.number().int(),
    warnings: z.array(z.string()).optional(),
  }),
  idempotencyKey: recordQuoteKey,
  // Состояние до записи: возврат КП A -> B -> A - новая операция, а не повтор первой.
  idempotencyPredecessor: async (input, deps) => {
    const current = await deps.quotes.get(input.requestId, input.supplierId);
    return predecessorOf(current === null ? null : quoteContent(current));
  },
  async execute(input, deps, context) {
    await assertOrderOwner(deps, input.requestId, context);
    // Заявку, выбор и состав КП уже проверил валидатор декларации.
    const request = await deps.requests.get(input.requestId);
    if (request === null) {
      throw new DomainError('not_found', `Заявка ${input.requestId} не найдена.`);
    }
    const classified = classifyQuoteLines(input, request, withQuoteVat(input));
    const until = softValidUntil(input.validUntil);
    const warnings = [
      ...classified.warnings,
      ...(until.warning === undefined ? [] : [until.warning]),
    ];
    const withWarnings = warnings.length === 0 ? {} : { warnings };
    const quote: SupplierQuote = {
      id: quoteIdOf(input.requestId, input.supplierId),
      requestId: input.requestId,
      supplierId: input.supplierId,
      lines: classified.lines,
      currency: input.currency,
      receivedAt: deps.clock.now().toISOString(),
      validUntil: until.value,
      deliveryDays: input.deliveryDays,
      paymentTerms: input.paymentTerms,
      notes: input.notes,
      sourceRef: input.sourceRef,
      gaps: [],
    };
    quote.gaps = findQuoteGaps(quote, request);
    const current = await deps.quotes.get(input.requestId, input.supplierId);
    // Повтор того же КП поверх такого же не переписывает запись (не сдвигает receivedAt).
    if (current !== null && stableHash(quoteContent(current)) === stableHash(quoteContent(quote))) {
      return {
        quoteId: current.id,
        gaps: current.gaps,
        lines: current.lines.length,
        ...withWarnings,
      };
    }
    await deps.quotes.save(quote);
    // Решение менеджера о замене расходуется этим сохранением (одноразово).
    if (current !== null && current.sourceRef !== input.sourceRef) {
      await consumeQuoteReplacement(deps.state, deps.clock, input.requestId, input.supplierId);
    }
    return {
      quoteId: quote.id,
      gaps: quote.gaps,
      lines: quote.lines.length,
      ...withWarnings,
    };
  },
});
