import { z } from 'zod';
import {
  DOCUMENT_KINDS,
  dealDocumentSchema,
  type DealDocument,
  type DocumentLine,
  type Supplier,
  type SupplierQuote,
} from '../../kit/domain/models';
import { describeQuoteGap } from '../../kit/domain/quotes';
import { parseIsoDeadline } from '../../kit/domain/iso-datetime';
import { quoteTotal } from '../../kit/domain/supplier-document';
import { supplierRequisitesRecord, validateSupplierRequisites } from '../../kit/domain/requisites';
import { defineTool, type ToolDefinition } from '@business-ai/core';
import { requirePort, stableHash } from '@business-ai/core';
import { disabledKindMessage } from './enabled-kinds';
import { resolveRenderContext } from './contract-number';
import { todayIso } from './issue-date';
import { isNdaTemplatePath } from './template-registry';
import { requestLabel } from '../order-calc/request-title';
import { notePreparedContract } from './prepared-contract';
import type { DocumentsDeps } from './deps';

/** Название заявки для сообщения сотруднику; без хранилищ - нейтральная подпись, не id. */
async function requestName(deps: DocumentsDeps, requestId: string): Promise<string> {
  if (deps.state === undefined || deps.requests === undefined) return 'без названия';
  return requestLabel({ state: deps.state, requests: deps.requests }, requestId);
}

const inputSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  /** Заявка с выбранным КП; для NDA не нужна. */
  requestId: z.string().min(1).optional(),
  supplierId: z.string().min(1),
  /** Номер документа, кроме договора на поставку: номер договора присваивает система. */
  number: z.string().min(1).optional(),
  /** Шаблон договора (путь из findTemplate): по нему система выдаёт номер юрлица. */
  templatePath: z.string().min(1).optional(),
  /** Дата документа; не названа - сегодня. */
  issuedAt: z.string().min(1).optional(),
  dueDate: z.string().min(1).optional(),
  /** Наше юрлицо; без него берётся первое из настроенных. */
  buyer: z.string().min(1).optional(),
  /**
   * Поля шаблона договора, которые назвал сотрудник (номер спецификации, гарантия, контакты):
   * ключ - метка шаблона. Допустимые метки и вопросы: checkTemplateFields.
   */
  templateFields: z.record(z.string()).optional(),
});
type PrepareInput = z.infer<typeof inputSchema>;

/** Валюта документа без КП (NDA): сумм в нём нет, поле обязательно по схеме. */
const DEFAULT_CURRENCY = 'RUB';

interface PrepareOutput {
  /**
   * Документ собран из имеющегося (true почти всегда). false - только если собирать не из чего:
   * вид документа выключен или поставщика нет в базе.
   */
  ready: boolean;
  document?: DealDocument | undefined;
  /** Вопросы и предупреждения: чего не хватило; в документе это места с маркерами. */
  questions: string[];
}

/** Коды пометок КП, о которых предупреждаем (цена, условия оплаты, срок поставки). */
const BLOCKING_GAPS: ReadonlySet<string> = new Set(['no_price', 'no_payment_terms', 'no_delivery']);

/**
 * Соглашение о неразглашении (шаблон NDA): документ из карточки поставщика, без КП, позиций и
 * сумм. Номер NDA система не присваивает. Не хватает данных - документ собирается из
 * имеющегося, вопросы уходят в `questions`.
 */
function prepareNda(
  input: PrepareInput,
  supplier: Supplier,
  questions: string[],
  deps: DocumentsDeps,
  issuedAt: string,
): PrepareOutput {
  const buyer = input.buyer ?? deps.ownCompanyNames[0];
  if (buyer === undefined) questions.push('Не задано наше юрлицо (buyer).');
  const number = input.number ?? '';
  const document: DealDocument = {
    id: 'doc-' + stableHash([input.supplierId, 'nda', number, issuedAt]),
    kind: input.kind,
    number,
    // Нет юрлица - пустое значение: в договоре будет маркер, а не отказ в сборке.
    buyer: buyer ?? '',
    seller: supplier.name,
    lines: [],
    total: 0,
    currency: DEFAULT_CURRENCY,
    issuedAt,
    dueDate: input.dueDate,
    supplierId: input.supplierId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    requisites: supplierRequisitesRecord(supplier),
    ...(input.templateFields === undefined ? {} : { templateFields: input.templateFields }),
    // Всё собрано кодом из карточки поставщика; дату и поля шаблона назвал сотрудник.
    fieldSources: {
      buyer: input.buyer === undefined ? 'knowledge' : 'employee',
      seller: 'knowledge',
      requisites: 'knowledge',
      total: 'knowledge',
      ...(input.dueDate === undefined ? {} : { dueDate: 'employee' as const }),
      ...(input.templateFields === undefined ? {} : { templateFields: 'employee' as const }),
    },
  };
  return { ready: true, document, questions };
}

/**
 * Собрать документ с поставщиком кодом: реквизиты из базы, позиции, цены и условия из КП.
 * Модель не набирает числа и реквизиты руками. Не хватает данных (заявки, КП, цены, условий) -
 * документ собирается из имеющегося, а вопросы уходят в `questions` как предупреждения.
 */
const assembleSupplierDocument = defineTool<PrepareInput, PrepareOutput, DocumentsDeps>({
  name: 'prepareSupplierDocument',
  description:
    'Собрать документ с поставщиком (договор, закрывающие) из базы и КП: реквизиты поставщика, ' +
    'позиции, цены, количества, итог, условия оплаты и срок поставки подставляет код. ' +
    'Параметры: kind, requestId, supplierId, issuedAt (нет - сегодня), templatePath (для ' +
    'договора: номер присвоит система), number (только не для договора), при необходимости ' +
    'dueDate, buyer и templateFields (поля шаблона договора от сотрудника). Нет заявки, КП, ' +
    'цены или условий - документ всё равно собирается из имеющегося, а questions содержит ' +
    'чего не хватило: это пропуски (в файле маркеры), а не вопросы; сотруднику их не задавай, ' +
    'перечисли в итоге, ничего не выдумывай. Спрашивать можно только юрлицо, вид договора и ' +
    'контрагента. ready=false ' +
    'только если поставщика нет в базе или вид документа выключен. Готовый document передай ' +
    'в validateDocument и handoffForReview. NDA (templatePath шаблона NDA, kind=contract): КП ' +
    'и requestId не нужны, документ собирается из карточки поставщика.',
  inputSchema,
  outputSchema: z.object({
    ready: z.boolean(),
    document: dealDocumentSchema.optional(),
    questions: z.array(z.string()),
  }),
  async execute(input, deps) {
    // Выключенный вид отклоняется кодом (`DOCUMENTS_ENABLED_KINDS`), схема от флага не зависит.
    const disabled = disabledKindMessage(deps, input.kind);
    if (disabled !== undefined) return { ready: false, questions: [disabled] };
    const supplier = await deps.suppliers.get(input.supplierId);
    if (supplier === null) {
      return {
        ready: false,
        // Собирать не из чего (реквизитов и КП нет): это техническая причина, а не запрет.
        // Дальше можно собрать документ вручную из слов сотрудника (предупреждение
        // supplier_not_found придёт от проверок), значения выдумывать нельзя.
        questions: [
          `Поставщик ${input.supplierId} не найден в базе: собрать документ из карточки и КП ` +
            'нельзя. Соберите его из данных сотрудника, реквизиты без источника - маркеры.',
        ],
      };
    }
    // Дату сотрудник мог не назвать: тогда это сегодня по часам зависимостей.
    const issuedAt = input.issuedAt ?? todayIso(deps);
    const questions = validateSupplierRequisites(supplier).map((issue) => issue.message);
    // NDA не привязано к КП: позиций, цен и сумм в нём нет, собирается из карточки поставщика.
    if (input.kind === 'contract' && isNdaTemplatePath(input.templatePath, deps.templatesPrefix)) {
      return prepareNda(input, supplier, questions, deps, issuedAt);
    }
    const requestId = input.requestId;
    let quote: SupplierQuote | null = null;
    if (requestId === undefined) {
      questions.push(
        'Заявка с выбранным КП поставщика не указана: документ собран без позиций, цен и ' +
          'условий из КП, на их месте маркеры.',
      );
    } else {
      quote = await requirePort(deps.quotes, 'хранилище КП').get(requestId, input.supplierId);
      if (quote === null) {
        questions.push(
          // Сотруднику показываем название заявки, а не внутренний id (этап 152).
          `КП поставщика по заявке «${await requestName(deps, requestId)}» не найдено. ` +
            'Документ собран без позиций, цен и условий из КП, на их месте маркеры.',
        );
      }
    }

    const lines: DocumentLine[] = [];
    if (quote !== null) {
      for (const gap of quote.gaps) {
        if (BLOCKING_GAPS.has(gap.code)) questions.push(`В КП ${describeQuoteGap(gap)}.`);
      }
      if (quote.lines.some((line) => line.isReplacement === true)) {
        questions.push(
          'Поставщик предложил замену позиции: решение за менеджером, в документ не включена.',
        );
      }
      const now = deps.clock?.now();
      if (
        now !== undefined &&
        quote.validUntil !== undefined &&
        (parseIsoDeadline(quote.validUntil) ?? Date.parse(quote.validUntil)) < now.getTime()
      ) {
        questions.push(`КП действовало до ${quote.validUntil}: подтвердите условия у поставщика.`);
      }
      for (const line of quote.lines) {
        if (line.isReplacement === true) continue;
        if (line.unitPrice === undefined) {
          questions.push(`Позиция «${line.productName}» не вошла в документ: в КП нет цены.`);
          continue;
        }
        // Количество берётся только из КП; нет его - спросим сотрудника, а не выдумаем.
        const quantity = line.quantity;
        if (quantity === undefined) {
          questions.push(
            `Позиция «${line.productName}» не вошла в документ: в КП нет количества.`,
          );
        } else {
          lines.push({
            name: line.productName,
            quantity,
            unitPrice: line.unitPrice,
            // Единица и срок строки из КП переносятся как есть: их сверяет код (сверка с КП).
            ...(line.unit === undefined ? {} : { unit: line.unit }),
            ...(line.deliveryDays === undefined ? {} : { deliveryDays: line.deliveryDays }),
            // Характеристики и срок из КП; нет их - спросит checkTemplateFields.
            ...(line.notes === undefined || line.notes.trim() === ''
              ? {}
              : { characteristics: line.notes.trim() }),
            ...(line.deliveryDays === undefined ? {} : { term: `${line.deliveryDays} дн.` }),
          });
        }
      }
    }
    const buyer = input.buyer ?? deps.ownCompanyNames[0];
    if (buyer === undefined) questions.push('Не задано наше юрлицо (buyer).');
    const currency = quote?.currency ?? DEFAULT_CURRENCY;
    // Валюта не из КП - не молчаливая подстановка: сотрудник получает предупреждение.
    if (quote?.currency === undefined) {
      questions.push(`Валюта не взята из КП: указана ${DEFAULT_CURRENCY}, проверьте.`);
    }
    // Номер договора присваивает система по шаблону; остальным документам его называет сотрудник.
    let number = input.number ?? '';
    if (input.kind === 'contract' && input.templatePath !== undefined) {
      // Номер выдаётся и черновику с пропусками (решение владельца); повтор той же операции
      // номер не тратит: ключ выдачи не зависит от полноты данных.
      const draft: DealDocument = {
        id: '',
        kind: input.kind,
        number,
        buyer: buyer ?? '',
        seller: supplier.name,
        lines: [],
        total: 0,
        currency,
        issuedAt,
        supplierId: input.supplierId,
        ...(requestId === undefined ? {} : { requestId }),
      };
      number = (await resolveRenderContext(draft, deps, input.templatePath, 'issue')).document
        .number;
    } else if (number === '') {
      questions.push(
        input.kind === 'contract'
          ? 'Какой шаблон договора брать (юрлицо и вид продукции)? Номер присвоит система.'
          : 'Какой номер у документа?',
      );
    }

    const document: DealDocument = {
      id:
        'doc-' +
        stableHash([input.supplierId, input.kind, number, issuedAt, requestId ?? '']),
      kind: input.kind,
      number,
      buyer: buyer ?? '',
      seller: supplier.name,
      lines,
      total:
        quote === null
          ? 0
          : quoteTotal(quote, (name) => lines.find((l) => l.name === name)?.quantity),
      currency,
      issuedAt,
      dueDate: input.dueDate,
      supplierId: input.supplierId,
      ...(requestId === undefined ? {} : { requestId }),
      paymentTerms: quote?.paymentTerms,
      deliveryDays: quote?.deliveryDays,
      requisites: supplierRequisitesRecord(supplier),
      ...(input.templateFields === undefined ? {} : { templateFields: input.templateFields }),
      // Всё собрано кодом из карточки поставщика и КП; номер и даты назвал сотрудник.
      fieldSources: {
        buyer: input.buyer === undefined ? 'knowledge' : 'employee',
        seller: 'knowledge',
        requisites: 'knowledge',
        ...(quote === null
          ? {}
          : {
              lines: 'knowledge' as const,
              total: 'knowledge' as const,
              paymentTerms: 'knowledge' as const,
              deliveryDays: 'knowledge' as const,
            }),
        ...(input.dueDate === undefined ? {} : { dueDate: 'employee' as const }),
        ...(input.templateFields === undefined ? {} : { templateFields: 'employee' as const }),
      },
    };
    return { ready: true, document, questions };
  },
});

/**
 * Сборка документа с поставщиком; для договора код запоминает в треде, по какому поставщику он
 * собран: по этой записи (а не по виду документа со слов модели) разрешено дополнение карточки
 * из договора (этап 219). Запись только при `ready` и только для вида `contract`.
 */
export const prepareSupplierDocument: ToolDefinition<unknown, PrepareOutput, DocumentsDeps> = {
  ...assembleSupplierDocument,
  async execute(rawInput, deps, context) {
    // Вход уже проверен схемой внутри сборки; здесь только читаем вид и поставщика.
    const output = await assembleSupplierDocument.execute(rawInput, deps, context);
    const input = inputSchema.parse(rawInput);
    if (output.ready && input.kind === 'contract') {
      await notePreparedContract(deps.state, context.threadId, input.supplierId);
    }
    return output;
  },
};
