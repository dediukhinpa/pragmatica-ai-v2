import { z } from 'zod';
import { isoDeadlineSchema, parseIsoDeadline } from './iso-datetime';
import { fromMinorUnits, lineCents, toMinorUnits } from './money';
import { CURRENCY_CODE_LENGTH, MAX_VAT_RATE_PERCENT, quoteLineSchema } from './models';
import type { PurchaseRequest, QuoteGap, QuoteLine, RequestItem, SupplierQuote } from './models';
import { normalizeProductName } from './price-diff';
import { sameUnit } from './units';
import type { ValidationIssue } from '@business-ai/core';

/** Валюта сравнения по умолчанию: допущение, что заявки в рублях (в заявке валюты нет). */
const DEFAULT_COMPARISON_CURRENCY = 'RUB';
/** Валюты, которые принимаем в КП. Список — допущение до ответа заказчика. */
const KNOWN_CURRENCIES: readonly string[] = ['RUB', 'USD', 'EUR', 'CNY', 'KZT', 'BYN'];

/**
 * Разобранное КП (поля, которые достала модель); проверяется `validateQuoteDraft`.
 * Позиции — та же схема, что у `quoteLineSchema`: пропущенное остаётся пустым.
 */
export const quoteDraftSchema = z.object({
  lines: z.array(quoteLineSchema).min(1),
  currency: z.string().trim().toUpperCase().length(CURRENCY_CODE_LENGTH),
  deliveryDays: z.number().int().nonnegative().optional(),
  paymentTerms: z.string().min(1).optional(),
  validUntil: isoDeadlineSchema.optional(),
  notes: z.string().min(1).optional(),
  /** НДС для всех позиций, где он не указан отдельно (при записи переносится в позиции). */
  vatIncluded: z.boolean().optional(),
  vatRate: z.number().min(0).max(MAX_VAT_RATE_PERCENT).optional(),
});
export type QuoteDraft = z.infer<typeof quoteDraftSchema>;

/**
 * Название для сопоставления: то же правило, что у позиций прайса (`normalizeProductName`):
 * NFKC, любые тире как дефис, регистр, пробелы и «ё» не важны.
 */
export function normalizeItemName(name: string): string {
  return normalizeProductName(name);
}

function startsAtWord(longer: string, shorter: string): boolean {
  return longer.startsWith(shorter) && (longer[shorter.length] ?? ' ') === ' ';
}

/** Результат сопоставления названия из КП с позициями заявки. */
export type RequestItemMatch =
  | { kind: 'match'; index: number }
  | { kind: 'ambiguous'; indexes: number[] }
  | { kind: 'none' };

/**
 * Позиции заявки, подготовленные к сопоставлению: названия нормализуются один раз. Строится на
 * заявку и переиспользуется для всех строк КП (иначе каждая строка заново нормализует заявку).
 */
export interface RequestItemIndex {
  /** Нормализованные названия, по порядку позиций заявки. */
  names: string[];
  /** Индексы позиций по точному нормализованному названию (по возрастанию). */
  exact: Map<string, number[]>;
}

function buildRequestItemIndex(items: readonly RequestItem[]): RequestItemIndex {
  const names: string[] = [];
  const exact = new Map<string, number[]>();
  items.forEach((item, index) => {
    const own = normalizeItemName(item.name);
    names.push(own);
    const group = exact.get(own);
    if (group === undefined) exact.set(own, [index]);
    else group.push(index);
  });
  return { names, exact };
}

function singleMatch(indexes: number[]): RequestItemMatch {
  return indexes.length === 1 && indexes[0] !== undefined
    ? { kind: 'match', index: indexes[0] }
    : { kind: 'ambiguous', indexes };
}

/**
 * Позиция заявки, которой соответствует название из КП. Точное совпадение (после
 * нормализации) однозначно, если оно одно. Иначе берутся позиции, чьё название является началом
 * названия КП по границе слова («Болт М8» для «Болт М8 оцинк 40»): побеждает самое длинное.
 * Если же название КП короче названий позиций («Болт» для «Болт М8» и «Болт М10») или
 * кандидаты встречаются в обоих направлениях, или несколько позиций заявки одинаково подходят,
 * это `ambiguous`: молча выбрать первую нельзя (R3-ALG-6).
 *
 * `index` - готовый индекс заявки; для многих строк КП его строят один раз.
 */
export function findRequestItemMatch(
  name: string,
  items: readonly RequestItem[],
  index: RequestItemIndex = buildRequestItemIndex(items),
): RequestItemMatch {
  const wanted = normalizeItemName(name);
  // Точное совпадение решает всё остальное: частичные кандидаты тогда не нужны.
  const exactIndexes = index.exact.get(wanted);
  if (exactIndexes !== undefined) return singleMatch([...exactIndexes]);
  const longer: number[] = [];
  const shorter: number[] = [];
  index.names.forEach((own, position) => {
    if (startsAtWord(wanted, own)) shorter.push(position);
    else if (startsAtWord(own, wanted)) longer.push(position);
  });
  if (shorter.length > 0 && longer.length > 0) {
    return { kind: 'ambiguous', indexes: [...shorter, ...longer].sort((a, b) => a - b) };
  }
  if (longer.length > 0) return singleMatch(longer);
  if (shorter.length === 0) return { kind: 'none' };
  const lengthOf = (position: number): number => index.names[position]?.length ?? 0;
  const maxLength = Math.max(...shorter.map(lengthOf));
  return singleMatch(shorter.filter((position) => lengthOf(position) === maxLength));
}

/**
 * Индекс позиции заявки, которой соответствует название из КП; -1, если соответствия нет или
 * оно неоднозначно (различить причины - `findRequestItemMatch`).
 */
export function findRequestItemIndex(
  name: string,
  items: readonly RequestItem[],
  index?: RequestItemIndex,
): number {
  const match = findRequestItemMatch(name, items, index);
  return match.kind === 'match' ? match.index : -1;
}

/** Контекст проверки КП. */
export interface QuoteDraftContext {
  request: PurchaseRequest;
  /** Выбранные менеджером поставщики: только от них принимаем КП. */
  allowedSupplierIds: readonly string[];
  supplierId: string;
}

/**
 * Бизнес-правила КП: поставщик из выбранного шорт-листа, позиции соответствуют заявке либо явно
 * помечены «заменой», валюта известна, позиция заявки не повторяется.
 */
export function validateQuoteDraft(
  draft: QuoteDraft,
  context: QuoteDraftContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!context.allowedSupplierIds.includes(context.supplierId)) {
    issues.push({
      code: 'supplier_not_in_selection',
      message: `Поставщик ${context.supplierId} не входит в выбор менеджера по заявке.`,
    });
  }
  if (!KNOWN_CURRENCIES.includes(draft.currency)) {
    issues.push({
      code: 'unknown_currency',
      message: `Валюта ${draft.currency} неизвестна; допустимы ${KNOWN_CURRENCIES.join(', ')}.`,
    });
  }
  const covered = new Set<number>();
  const requestIndex = buildRequestItemIndex(context.request.items);
  for (const line of draft.lines) {
    if (line.isReplacement === true) continue;
    const match = findRequestItemMatch(line.productName, context.request.items, requestIndex);
    const index = match.kind === 'match' ? match.index : -1;
    if (match.kind === 'ambiguous') {
      issues.push({
        code: 'ambiguous_line',
        message:
          `Название «${line.productName}» подходит нескольким позициям заявки: ` +
          'уточните, к какой относится цена.',
      });
    } else if (index < 0) {
      issues.push({
        code: 'line_not_in_request',
        message:
          `«${line.productName}» нет в заявке. Если поставщик предлагает замену, ` +
          'передайте позицию с isReplacement=true.',
      });
    } else if (covered.has(index)) {
      issues.push({
        code: 'duplicate_line',
        message: `Позиция заявки «${line.productName}» указана в КП больше одного раза.`,
      });
    } else {
      covered.add(index);
    }
  }
  return issues;
}

/** Чего не хватает в КП (пропущенное поле не выдумывается, а попадает сюда). */
export function findQuoteGaps(
  quote: Pick<SupplierQuote, 'lines' | 'deliveryDays' | 'paymentTerms' | 'validUntil'>,
  request: PurchaseRequest,
): QuoteGap[] {
  const gaps: QuoteGap[] = [];
  const covered = new Set<number>();
  let someLineDelivery = false;
  const requestIndex = buildRequestItemIndex(request.items);
  for (const line of quote.lines) {
    if (line.deliveryDays !== undefined) someLineDelivery = true;
    if (line.isReplacement === true) continue;
    const index = findRequestItemIndex(line.productName, request.items, requestIndex);
    if (index >= 0) covered.add(index);
    if (line.unitPrice === undefined)
      gaps.push({ code: 'no_price', productName: line.productName });
    if (line.quantity === undefined) {
      gaps.push({ code: 'no_quantity', productName: line.productName });
    }
  }
  request.items.forEach((item, index) => {
    if (!covered.has(index)) gaps.push({ code: 'item_not_covered', productName: item.name });
  });
  if (quote.deliveryDays === undefined && !someLineDelivery) gaps.push({ code: 'no_delivery' });
  if (quote.paymentTerms === undefined) gaps.push({ code: 'no_payment_terms' });
  if (quote.validUntil === undefined) gaps.push({ code: 'no_validity' });
  return gaps;
}

/** Текст пометки для людей. */
export function describeQuoteGap(gap: QuoteGap): string {
  const item = gap.productName === undefined ? '' : ` по «${gap.productName}»`;
  switch (gap.code) {
    case 'no_price':
      return `нет цены${item}`;
    case 'no_quantity':
      return `не указано количество${item}`;
    case 'item_not_covered':
      return `нет ответа${item}`;
    case 'no_delivery':
      return 'нет срока поставки';
    case 'no_payment_terms':
      return 'нет условий оплаты';
    case 'no_validity':
      return 'нет срока действия КП';
  }
}

/** Коды предупреждений сравнения. */
type ComparisonFlagCode =
  | 'no_reply'
  | 'no_price'
  | 'quote_expired'
  | 'currency_differs'
  | 'mixed_currencies'
  | 'partial_answer'
  | 'has_replacement'
  | 'quantity_differs'
  | 'unit_differs'
  | 'vat_differs'
  | 'pack_size_mismatch'
  | 'min_order_exceeds';

/** Причина, по которой цены поставщика несопоставимы с остальными. */
export type IncomparableReason = 'vat_mixed' | 'pack_size' | 'min_order';

/** Предупреждение сравнения; `supplierId` — если относится к одному поставщику. */
interface ComparisonFlag {
  code: ComparisonFlagCode;
  supplierId?: string | undefined;
  productName?: string | undefined;
  message: string;
}

/** Поставщик из выбранного шорт-листа. */
export interface ComparisonSupplier {
  id: string;
  name: string;
}

/** Вход сравнения. */
export interface CompareInput {
  request: PurchaseRequest;
  suppliers: readonly ComparisonSupplier[];
  quotes: readonly SupplierQuote[];
  now: Date;
  /** Валюта заявки; в других валютах цены не пересчитываются. */
  baseCurrency?: string | undefined;
}

/** Ячейка «позиция × поставщик». */
interface ComparisonCell {
  supplierId: string;
  state: 'priced' | 'no_price' | 'not_covered';
  /** Единица в КП не совпадает с единицей заявки: цена несопоставима, пересчёта нет. */
  unitDiffers?: boolean | undefined;
  /** Фасовка не делит запрошенное количество или минимальная партия его превышает. */
  packIssue?: 'pack_size' | 'min_order' | undefined;
  unitPrice?: number | undefined;
  quantity?: number | undefined;
  lineTotal?: number | undefined;
  deliveryDays?: number | undefined;
}

/** Строка таблицы: позиция заявки, ячейки по поставщикам, минимум и максимум цены за единицу. */
interface ComparisonRow {
  itemName: string;
  unit: string;
  /** Нет количества в заявке - поля нет, суммы по позиции не считаются. */
  requestQuantity?: number | undefined;
  cells: ComparisonCell[];
  minUnitPrice?: number | undefined;
  minSupplierIds: string[];
  maxUnitPrice?: number | undefined;
  maxSupplierIds: string[];
  /** Цены в строке несопоставимы (условия цены, фасовка, партия): минимум и максимум не названы. */
  incomparable?: boolean | undefined;
}

/** Условия и итог по одному поставщику. */
interface SupplierSummary {
  supplierId: string;
  name: string;
  replied: boolean;
  currency?: string | undefined;
  /**
   * Сумма по позициям заявки с ценой в единице заявки (количество КП, иначе заявки). Позиции с
   * ценой в другой единице не входят: пересчёта нет, а сумма была бы несопоставимой.
   */
  orderTotal?: number | undefined;
  /** Позиций с ценой в единице заявки (цены в другой единице сюда не входят). */
  pricedItems: number;
  totalItems: number;
  /** Позиций, где цена дана в другой единице: в итог не входят, итог неполный. */
  unitMismatchItems: number;
  deliveryDays?: number | undefined;
  paymentTerms?: string | undefined;
  validUntil?: string | undefined;
  expired: boolean;
  /**
   * Участвует ли в минимумах и максимумах и сопоставим ли итог с другими: та же валюта, не
   * просрочено, нет цен в другой единице.
   */
  comparable: boolean;
  /** Почему цены несопоставимы с другими (пусто, если причин нет). */
  incomparableReasons: IncomparableReason[];
  replacements: QuoteLine[];
  notes?: string | undefined;
  gaps: QuoteGap[];
}

/** Результат сравнения. Победителя и рекомендаций в нём нет: выбирает менеджер. */
export interface QuoteComparison {
  requestId: string;
  baseCurrency: string;
  rows: ComparisonRow[];
  suppliers: SupplierSummary[];
  notRepliedSupplierIds: string[];
  flags: ComparisonFlag[];
}

function isExpired(quote: SupplierQuote, now: Date): boolean {
  if (quote.validUntil === undefined) return false;
  // Дата без времени (старые записи) - конец суток по МСК (D-14); нечитаемое - как истёкшее.
  const until = parseIsoDeadline(quote.validUntil);
  return until === undefined || until < now.getTime();
}

/** Первая не замена строка КП по индексу позиции заявки, к которой она относится. */
type QuoteLineIndex = ReadonlyMap<number, QuoteLine>;

function indexQuoteLines(
  quote: SupplierQuote,
  items: readonly RequestItem[],
  requestIndex: RequestItemIndex,
): QuoteLineIndex {
  const byItem = new Map<number, QuoteLine>();
  for (const line of quote.lines) {
    if (line.isReplacement === true) continue;
    const itemIndex = findRequestItemIndex(line.productName, items, requestIndex);
    if (itemIndex >= 0 && !byItem.has(itemIndex)) byItem.set(itemIndex, line);
  }
  return byItem;
}

function lineDelivery(quote: SupplierQuote): number | undefined {
  const days = quote.lines.map((line) => line.deliveryDays).filter((d) => d !== undefined);
  if (quote.deliveryDays !== undefined) return quote.deliveryDays;
  return days.length === 0 ? undefined : Math.max(...days);
}

/** Единица в КП указана и не совпадает с единицей позиции заявки (после нормализации). */
function unitDiffers(line: QuoteLine, item: RequestItem): boolean {
  return line.unit !== undefined && !sameUnit(line.unit, item.unit);
}

/** Допуск при проверке «количество кратно фасовке» (дробные количества). */
const PACK_EPSILON = 1e-9;

/** Фасовка не делит запрошенное количество или минимальная партия его превышает. */
function packIssueOf(line: QuoteLine, item: RequestItem): 'pack_size' | 'min_order' | undefined {
  // Количество в заявке не указано: кратность фасовке и партию проверить не с чем.
  if (item.quantity === undefined) return undefined;
  if (line.packSize !== undefined) {
    const ratio = item.quantity / line.packSize;
    if (Math.abs(ratio - Math.round(ratio)) > PACK_EPSILON * Math.max(1, ratio)) {
      return 'pack_size';
    }
  }
  if (line.minOrder !== undefined && line.minOrder > item.quantity) return 'min_order';
  return undefined;
}

/**
 * Включён ли НДС в цену позиции. Ставка 0 (поставщик без НДС) означает, что цена итоговая, как
 * «с НДС»; иначе берётся признак из ответа, а непустого признака нет - `undefined`.
 */
function effectiveVatIncluded(line: QuoteLine): boolean | undefined {
  return line.vatRate === 0 ? true : line.vatIncluded;
}

/** Состояние НДС в КП по позициям с ценой; `undefined`, если цен нет. */
type VatState = 'included' | 'excluded' | 'unknown' | 'mixed';

function vatStateOf(quote: SupplierQuote): VatState | undefined {
  const values = quote.lines
    .filter((line) => line.isReplacement !== true && line.unitPrice !== undefined)
    .map(effectiveVatIncluded);
  if (values.length === 0) return undefined;
  const known = values.filter((value) => value !== undefined);
  if (known.length === 0) return 'unknown';
  // Часть позиций без признака при наличии указанных - такое же смешение, как с/без НДС.
  if (known.length < values.length) return 'mixed';
  if (known.every((value) => value)) return 'included';
  return known.every((value) => !value) ? 'excluded' : 'mixed';
}

function buildCell(
  quote: SupplierQuote | undefined,
  lineIndex: QuoteLineIndex | undefined,
  supplierId: string,
  item: RequestItem,
  itemIndex: number,
): ComparisonCell {
  if (quote === undefined) return { supplierId, state: 'not_covered' };
  const line = lineIndex?.get(itemIndex);
  if (line === undefined) return { supplierId, state: 'not_covered' };
  const deliveryDays = line.deliveryDays ?? quote.deliveryDays;
  if (line.unitPrice === undefined) {
    return { supplierId, state: 'no_price', quantity: line.quantity, deliveryDays };
  }
  const quantity = line.quantity ?? item.quantity;
  const differs = unitDiffers(line, item);
  return {
    supplierId,
    state: 'priced',
    unitDiffers: differs ? true : undefined,
    packIssue: differs ? undefined : packIssueOf(line, item),
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    // Цена в другой единице не пересчитана: суммы по ней нет, иначе итог станет ложно малым.
    lineTotal:
      differs || quantity === undefined
        ? undefined
        : fromMinorUnits(lineCents(quantity, line.unitPrice)),
    deliveryDays,
  };
}

function extremes(
  cells: readonly ComparisonCell[],
  eligible: ReadonlySet<string>,
  vatIncomparable: boolean,
): Pick<
  ComparisonRow,
  'minUnitPrice' | 'minSupplierIds' | 'maxUnitPrice' | 'maxSupplierIds' | 'incomparable'
> {
  const priced = cells.filter(
    (cell) =>
      cell.unitPrice !== undefined && cell.unitDiffers !== true && eligible.has(cell.supplierId),
  );
  if (priced.length === 0) return { minSupplierIds: [], maxSupplierIds: [] };
  // НДС, фасовка и партия делают цены несопоставимыми: минимум не называется (R4-ALG-4).
  if (vatIncomparable || priced.some((cell) => cell.packIssue !== undefined)) {
    return { minSupplierIds: [], maxSupplierIds: [], incomparable: true };
  }
  const prices = priced.map((cell) => cell.unitPrice ?? 0);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    minUnitPrice: min,
    minSupplierIds: priced.filter((c) => c.unitPrice === min).map((c) => c.supplierId),
    maxUnitPrice: max,
    maxSupplierIds: priced.filter((c) => c.unitPrice === max).map((c) => c.supplierId),
  };
}

function summarize(
  supplier: ComparisonSupplier,
  quote: SupplierQuote | undefined,
  input: CompareInput,
  baseCurrency: string,
  rows: readonly ComparisonRow[],
  vatAffected: ReadonlySet<string>,
): SupplierSummary {
  const totalItems = input.request.items.length;
  if (quote === undefined) {
    return {
      supplierId: supplier.id,
      name: supplier.name,
      replied: false,
      pricedItems: 0,
      totalItems,
      unitMismatchItems: 0,
      expired: false,
      comparable: false,
      incomparableReasons: [],
      replacements: [],
      gaps: [],
    };
  }
  const cells = rows.map((row) => row.cells.find((cell) => cell.supplierId === supplier.id));
  const priced = cells.filter((cell) => cell?.lineTotal !== undefined);
  const unitMismatchItems = cells.filter((cell) => cell?.unitDiffers === true).length;
  const expired = isExpired(quote, input.now);
  const incomparableReasons: IncomparableReason[] = [];
  if (vatAffected.has(supplier.id)) incomparableReasons.push('vat_mixed');
  if (cells.some((cell) => cell?.packIssue === 'pack_size')) incomparableReasons.push('pack_size');
  if (cells.some((cell) => cell?.packIssue === 'min_order')) incomparableReasons.push('min_order');
  return {
    supplierId: supplier.id,
    name: supplier.name,
    replied: true,
    currency: quote.currency,
    orderTotal:
      priced.length === 0
        ? undefined
        : fromMinorUnits(
            priced.reduce((sum, cell) => sum + toMinorUnits(cell?.lineTotal ?? 0), 0),
          ),
    pricedItems: priced.length,
    totalItems,
    unitMismatchItems,
    deliveryDays: lineDelivery(quote),
    paymentTerms: quote.paymentTerms,
    validUntil: quote.validUntil,
    expired,
    comparable:
      quote.currency === baseCurrency &&
      !expired &&
      unitMismatchItems === 0 &&
      incomparableReasons.length === 0,
    incomparableReasons,
    replacements: quote.lines.filter((line) => line.isReplacement === true),
    notes: quote.notes,
    gaps: quote.gaps,
  };
}

function supplierFlags(
  summary: SupplierSummary,
  quote: SupplierQuote,
  input: CompareInput,
  baseCurrency: string,
  requestIndex: RequestItemIndex,
): ComparisonFlag[] {
  const flags: ComparisonFlag[] = [];
  const { supplierId, name } = summary;
  // Флаг по строке КП; порядок ключей фиксирован (код, поставщик, позиция, текст).
  const lineFlag = (
    code: ComparisonFlagCode,
    line: QuoteLine,
    message: string,
  ): ComparisonFlag => ({ code, supplierId, productName: line.productName, message });
  for (const line of quote.lines) {
    if (line.isReplacement !== true && line.unitPrice === undefined) {
      flags.push(lineFlag('no_price', line, `${name}: нет цены по «${line.productName}».`));
    }
    const index = findRequestItemIndex(line.productName, input.request.items, requestIndex);
    const requested = input.request.items[index];
    const wanted = requested?.quantity;
    if (line.isReplacement !== true && requested !== undefined && unitDiffers(line, requested)) {
      const message =
        `${name}: по «${line.productName}» цена за ${line.unit}, в заявке ${requested.unit}; ` +
        'цена не пересчитана, в минимумах и в итоге по заказу не участвует.';
      flags.push(lineFlag('unit_differs', line, message));
    }
    const pack =
      line.isReplacement !== true && requested !== undefined && !unitDiffers(line, requested)
        ? packIssueOf(line, requested)
        : undefined;
    if (pack === 'pack_size') {
      const message =
        `${name}: по «${line.productName}» фасовка ${line.packSize}, запрошено ` +
        `${wanted}: количество не кратно фасовке; цена несопоставима, итог по запрошенному ` +
        'количеству.';
      flags.push(lineFlag('pack_size_mismatch', line, message));
    } else if (pack === 'min_order') {
      const message =
        `${name}: по «${line.productName}» минимальная партия ${line.minOrder}, запрошено ` +
        `${wanted}; цена несопоставима, итог по запрошенному количеству.`;
      flags.push(lineFlag('min_order_exceeds', line, message));
    }
    if (line.isReplacement !== true && line.quantity !== undefined && line.quantity !== wanted) {
      const message =
        `${name}: по «${line.productName}» количество ${line.quantity}, в заявке ${wanted}.`;
      flags.push(lineFlag('quantity_differs', line, message));
    }
  }
  if (summary.expired) {
    flags.push({
      code: 'quote_expired',
      supplierId,
      message:
        `${name}: КП действовало до ${quote.validUntil}, срок истёк; ` +
        'в минимумах не участвует.',
    });
  }
  if (quote.currency !== baseCurrency) {
    flags.push({
      code: 'currency_differs',
      supplierId,
      message:
        `${name}: валюта КП ${quote.currency}, заявка в ${baseCurrency}; пересчёта нет, ` +
        'в минимумах не участвует.',
    });
  }
  const notAnswered = summary.totalItems - summary.pricedItems;
  if (notAnswered > 0) {
    flags.push({
      code: 'partial_answer',
      supplierId,
      message: `${name}: цена указана по ${summary.pricedItems} из ${summary.totalItems} позиций.`,
    });
  }
  if (summary.replacements.length > 0) {
    flags.push({
      code: 'has_replacement',
      supplierId,
      message:
        `${name}: предложены замены (${summary.replacements.length}); ` + 'в сравнение не входят.',
    });
  }
  return flags;
}

/**
 * Сравнить КП без LLM: таблица «позиция × поставщик», минимум и максимум по позиции, итог по
 * заказу для каждого поставщика, предупреждения. Цены в разных валютах не пересчитываются.
 * Функция ничего не рекомендует: поставщика выбирает менеджер.
 */
export function compareQuotes(input: CompareInput): QuoteComparison {
  const baseCurrency = input.baseCurrency ?? DEFAULT_COMPARISON_CURRENCY;
  const bySupplier = new Map(input.quotes.map((quote) => [quote.supplierId, quote]));
  const eligible = new Set(
    input.quotes
      .filter((quote) => quote.currency === baseCurrency && !isExpired(quote, input.now))
      .map((quote) => quote.supplierId),
  );
  // НДС сопоставляется только среди КП, которые участвуют в минимумах (валюта, срок).
  const vatStates = new Map<string, VatState>();
  for (const quote of input.quotes) {
    const state = eligible.has(quote.supplierId) ? vatStateOf(quote) : undefined;
    if (state !== undefined) vatStates.set(quote.supplierId, state);
  }
  const stateValues = new Set(vatStates.values());
  const vatIncomparable =
    stateValues.has('mixed') ||
    (stateValues.has('included') && stateValues.has('excluded')) ||
    (stateValues.has('unknown') && stateValues.size > 1);
  const vatAffected: ReadonlySet<string> = new Set(vatIncomparable ? vatStates.keys() : []);
  // Названия заявки и строки КП нормализуются один раз: строка КП ищется по индексу позиции.
  const items = input.request.items;
  const requestIndex = buildRequestItemIndex(items);
  const lineIndexes = new Map<string, QuoteLineIndex>();
  for (const [supplierId, quote] of bySupplier) {
    lineIndexes.set(supplierId, indexQuoteLines(quote, items, requestIndex));
  }
  // Повторяющаяся ссылка на позицию в заявке считается её первым вхождением (как indexOf).
  const firstIndexOf = new Map<RequestItem, number>();
  items.forEach((item, position) => {
    if (!firstIndexOf.has(item)) firstIndexOf.set(item, position);
  });
  const rows: ComparisonRow[] = items.map((item) => {
    const itemIndex = firstIndexOf.get(item) ?? -1;
    const cells = input.suppliers.map((supplier) =>
      buildCell(
        bySupplier.get(supplier.id),
        lineIndexes.get(supplier.id),
        supplier.id,
        item,
        itemIndex,
      ),
    );
    return {
      itemName: item.name,
      unit: item.unit,
      requestQuantity: item.quantity,
      cells,
      ...extremes(cells, eligible, vatIncomparable),
    };
  });
  const suppliers = input.suppliers.map((supplier) =>
    summarize(supplier, bySupplier.get(supplier.id), input, baseCurrency, rows, vatAffected),
  );
  const flags: ComparisonFlag[] = [];
  const notRepliedSupplierIds: string[] = [];
  for (const summary of suppliers) {
    const quote = bySupplier.get(summary.supplierId);
    if (quote === undefined) {
      notRepliedSupplierIds.push(summary.supplierId);
      flags.push({
        code: 'no_reply',
        supplierId: summary.supplierId,
        message: `${summary.name}: ответа на запрос нет.`,
      });
    } else {
      flags.push(...supplierFlags(summary, quote, input, baseCurrency, requestIndex));
    }
  }
  if (vatIncomparable) {
    // Решение владельца 09.11 (п.2): в сводке КП слов про НДС и состояния НДС по поставщикам нет;
    // отсылки к шорт-листу и карточке тоже нет: там НДС прайса, а не этого КП. Код по-прежнему
    // не называет минимум.
    const names = [...vatStates.keys()].map(
      (id) => suppliers.find((summary) => summary.supplierId === id)?.name ?? id,
    );
    flags.push({
      code: 'vat_differs',
      message:
        `Минимум не назван: условия ответов поставщиков (${names.join('; ')}) несопоставимы, ` +
        'сверьте их ответы на запрос.',
    });
  }
  const currencies = new Set(input.quotes.map((quote) => quote.currency));
  if (currencies.size > 1) {
    flags.push({
      code: 'mixed_currencies',
      message: `КП в разных валютах (${[...currencies].sort().join(', ')}); пересчёта нет.`,
    });
  }
  return {
    requestId: input.request.id,
    baseCurrency,
    rows,
    suppliers,
    notRepliedSupplierIds,
    flags,
  };
}
