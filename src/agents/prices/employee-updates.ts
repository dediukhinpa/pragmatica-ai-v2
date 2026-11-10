import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { KNOWN_PRICE_CURRENCIES } from '../../kit/domain/price-schedule';
import { PRICE_QUALIFIERS, type PriceItem } from '../../kit/domain/models';
import {
  buildPriceMatchIndex,
  matchPriceItem,
  type PriceMatchIndex,
} from '../../kit/domain/price-match';
import { latestPrices, priceItemKey } from '../../kit/domain/price-diff';
import { defineTool } from '@business-ai/core';
import { requireEmployee, stableHash } from '@business-ai/core';
import { DEFAULT_PRICE_CURRENCY, type PricesDeps } from './deps';
import { saveImportMeta } from './price-state';
import { yieldToEventLoop } from './price-steps';
import { stagingImportId } from './staging-source';

/** Отказ планового и неопознанного хода: слова сотрудника записывает только сотрудник. */
const EMPLOYEE_ONLY_TEXT =
  'Правки цен со слов сотрудника записываются только по его просьбе в чате: инициатор неизвестен.';
/**
 * Длина пометки сотрудника к правке, хранимая в импорте. Длиннее - пометка обрезается с
 * предупреждением, а не отклоняет вызов (этап 177). Число правок за вызов не ограничено:
 * просьба сотрудника не режется лимитом, правки идут пачками с уступками циклу событий.
 */
const EMPLOYEE_NOTE_MAX_CHARS = 200;
/** Префикс «хэша файла» импорта, собранного из слов сотрудника. */
const EMPLOYEE_HASH_PREFIX = 'emp-';
/** Ключ единственного куска такого импорта. */
const EMPLOYEE_CHUNK_KEY = 'employee-all';
const EMPLOYEE_TABLE = 'employee';
/**
 * Правок между уступками циклу событий: поиск похожих позиций в прайсе 100 тыс. строк - единицы
 * мс на правку, и 200 правок подряд держали процесс ядра секунды (R9-A1-10).
 */
const UPDATES_PER_YIELD = 10;

const updateSchema = z.object({
  sku: z.string().min(1).optional(),
  productName: z.string().min(1).optional(),
  price: z.number().positive(),
  currency: z.string().length(3).optional(),
  /** Позиции нет в прайсе, сотрудник сообщает о новой: true добавит её (если нет похожих). */
  addIfMissing: z.boolean().default(false),
  note: z.string().optional(),
});
type EmployeeUpdate = z.infer<typeof updateSchema>;

const inputSchema = z.object({
  supplierId: z.string().min(1),
  updates: z.array(updateSchema).min(1),
});
interface EmployeeInput {
  supplierId: string;
  updates: EmployeeUpdate[];
}

const candidateSchema = z.object({
  sku: z.string().optional(),
  productName: z.string(),
  price: z.number(),
  /** Прежняя цена позиции была «от»/диапазоном: price - нижняя граница. */
  priceQualifier: z.enum(PRICE_QUALIFIERS).optional(),
  priceMax: z.number().optional(),
  currency: z.string(),
});
const questionSchema = z.object({
  /** Номер правки во вводе (с нуля). */
  index: z.number().int(),
  code: z.string(),
  text: z.string(),
  candidates: z.array(candidateSchema),
});
type Question = z.infer<typeof questionSchema>;

const appliedSchema = z.object({
  index: z.number().int(),
  sku: z.string().optional(),
  productName: z.string(),
  oldPrice: z.number().optional(),
  newPrice: z.number(),
  currency: z.string(),
  isNew: z.boolean(),
});
type Applied = z.infer<typeof appliedSchema>;

interface EmployeeOutput {
  importId: string | null;
  supplierId: string;
  fileHash: string | null;
  applied: Applied[];
  questions: Question[];
  totalItems: number;
  /** Предупреждения (этап 177): обрезанные пометки и т. п. */
  warnings?: string[] | undefined;
}

/** Отпечаток прайса: по нему видно, что база изменилась после сборки импорта сотрудника. */
export function priceListHash(items: readonly PriceItem[]): string {
  const rows = latestPricesRows(items);
  return stableHash(rows);
}

function latestPricesRows(items: readonly PriceItem[]): Array<[string, ...Array<string | number>]> {
  return [...latestPrices(items).values()]
    // Признак цены входит в отпечаток, только если он есть: прежние отпечатки не меняются.
    .map((item): [string, ...Array<string | number>] => [
      priceItemKey(item),
      item.price,
      item.currency,
      ...(item.priceQualifier === undefined ? [] : [item.priceQualifier, item.priceMax ?? 0]),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function toCandidate(item: PriceItem): z.infer<typeof candidateSchema> {
  return {
    ...(item.sku === undefined ? {} : { sku: item.sku }),
    productName: item.productName,
    price: item.price,
    ...(item.priceQualifier === undefined ? {} : { priceQualifier: item.priceQualifier }),
    ...(item.priceMax === undefined ? {} : { priceMax: item.priceMax }),
    currency: item.currency,
  };
}

function question(
  index: number,
  code: string,
  text: string,
  candidates: readonly PriceItem[] = [],
): Question {
  return { index, code, text, candidates: candidates.map(toCandidate) };
}

/** Преобладающая валюта прайса поставщика; при равенстве - первая по алфавиту; null без цен. */
function dominantCurrency(items: readonly PriceItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.currency, (counts.get(item.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [code, count] of counts) {
    const bestCount = best === null ? 0 : (counts.get(best) ?? 0);
    if (count > bestCount || (count === bestCount && best !== null && code < best)) best = code;
  }
  return best;
}

/** Что делать с одной правкой: применить (новая версия позиции) или спросить человека. */
function planUpdate(
  update: EmployeeUpdate,
  index: number,
  base: readonly PriceItem[],
  baseIndex: PriceMatchIndex,
  baseCurrency: () => string | null,
  supplierId: string,
  now: string,
): { item: PriceItem; old?: PriceItem } | Question {
  if (update.sku === undefined && update.productName === undefined) {
    return question(index, 'no_item', 'Не указана позиция: нужен артикул или название.');
  }
  if (update.currency !== undefined && !KNOWN_PRICE_CURRENCIES.includes(update.currency)) {
    return question(
      index,
      'unknown_currency',
      `Валюта ${update.currency} не из списка (${KNOWN_PRICE_CURRENCIES.join(', ')}). ` +
        'Уточните валюту.',
    );
  }
  const found = matchPriceItem(
    base,
    { sku: update.sku, productName: update.productName },
    baseIndex,
  );
  const label = update.sku ?? update.productName ?? '';
  if (found.kind === 'ambiguous') {
    return question(
      index,
      'ambiguous_match',
      `По «${label}» найдено несколько позиций: уточните артикул или полное название.`,
      found.candidates,
    );
  }
  if (found.kind === 'match') {
    const old = found.item;
    if (update.currency !== undefined && update.currency !== old.currency) {
      return question(
        index,
        'currency_mismatch',
        `У «${old.productName}» в базе валюта ${old.currency}, указана ${update.currency}: ` +
          'уточните, меняется ли валюта прайса.',
        [old],
      );
    }
    // Сотрудник называет точную цену: «от 500» -> 500 это изменение (признак снимается).
    if (old.price === update.price && old.priceQualifier === undefined) {
      return question(index, 'same_price', `Цена «${old.productName}» уже ${old.price}.`, [old]);
    }
    // Признак («от», диапазон) и его верхняя граница относились к прежней цене - снимаются.
    const { priceQualifier: _q, priceMax: _m, ...exact } = old;
    return { item: { ...exact, price: update.price, date: now }, old };
  }
  const canAdd = update.addIfMissing && update.productName !== undefined;
  if (canAdd && found.candidates.length === 0) {
    return {
      item: {
        supplierId,
        productName: update.productName ?? '',
        ...(update.sku === undefined ? {} : { sku: update.sku }),
        price: update.price,
        // Новая позиция берёт валюту прайса поставщика, а не RUB «по умолчанию».
        currency: update.currency ?? baseCurrency() ?? DEFAULT_PRICE_CURRENCY,
        date: now,
      },
    };
  }
  const similar = found.candidates.length > 0 ? ' Есть похожие позиции: сверьте.' : '';
  return question(
    index,
    'not_found',
    `Позиция «${label}» не найдена в прайсе поставщика.${similar}` +
      (canAdd ? '' : ' Если это новая позиция, повторите с addIfMissing=true.'),
    found.candidates,
  );
}

/**
 * Применить слова сотрудника к текущему прайсу: однозначные правки попадают в staging новым
 * полным прайсом (фиксация заменяет прайс целиком, поэтому неизменные позиции переносятся),
 * сомнительные возвращаются вопросами и НЕ применяются.
 */
export const recordEmployeePriceUpdates = defineTool<EmployeeInput, EmployeeOutput, PricesDeps>({
  name: 'recordEmployeePriceUpdates',
  description:
    'Записать в staging обновления цен, которые сотрудник сообщил текстом («у поставщика X ' +
    'позиция Y теперь стоит Z»). Передайте supplierId (из searchSuppliers) и updates: sku ' +
    'и/или productName, price, при необходимости currency, addIfMissing (новая позиция), ' +
    'note. Код сам найдёт позицию в базе: однозначные правки применяет, остальные (нет ' +
    'позиции, несколько совпадений, другая валюта) возвращает в questions: задайте эти ' +
    'вопросы сотруднику, не угадывайте. Автора запишет код. Затем previewPriceChanges.',
  sideEffect: true,
  inputSchema,
  outputSchema: z.object({
    importId: z.string().nullable(),
    supplierId: z.string(),
    fileHash: z.string().nullable(),
    applied: z.array(appliedSchema),
    questions: z.array(questionSchema),
    totalItems: z.number().int(),
    warnings: z.array(z.string()).optional(),
  }),
  idempotencyKey: (input) =>
    `prices-employee:${input.supplierId}:${stableHash(input.updates)}`,
  // Те же слова сотрудника поверх другого прайса (после A -> B -> A) - новая операция.
  idempotencyPredecessor: async (input, deps) =>
    priceListHash(await deps.prices.listBySupplier(input.supplierId)),
  async execute(input, deps, context) {
    // Правки цен «со слов сотрудника» только по просьбе человека в чате: плановый ход их не
    // записывает (иначе текст письма подменил бы слова сотрудника, R7-07).
    requireEmployee(context, EMPLOYEE_ONLY_TEXT);
    if ((await deps.suppliers.get(input.supplierId)) === null) {
      throw new DomainError('not_found', `Поставщик ${input.supplierId} не найден в базе.`);
    }
    const base = [...latestPrices(await deps.prices.listBySupplier(input.supplierId)).values()];
    const now = deps.clock.now().toISOString();
    // Индекс прайса и преобладающая валюта считаются один раз на вызов, а не на каждую правку.
    const baseIndex = buildPriceMatchIndex(base);
    let currencyCache: { value: string | null } | undefined;
    const baseCurrency = (): string | null => {
      currencyCache ??= { value: dominantCurrency(base) };
      return currencyCache.value;
    };
    const replaced = new Map<string, PriceItem>();
    const added: PriceItem[] = [];
    const applied: Applied[] = [];
    const questions: Question[] = [];
    const notes: string[] = [];
    const trimmedNotes: number[] = [];
    for (const [index, update] of input.updates.entries()) {
      if (index > 0 && index % UPDATES_PER_YIELD === 0) await yieldToEventLoop();
      const plan = planUpdate(update, index, base, baseIndex, baseCurrency, input.supplierId, now);
      if ('code' in plan) {
        questions.push(plan);
        continue;
      }
      const key = priceItemKey(plan.item);
      if (replaced.has(key) || added.some((item) => priceItemKey(item) === key)) {
        questions.push(
          question(index, 'duplicate_update', `Позиция «${plan.item.productName}» указана дважды.`),
        );
        continue;
      }
      if (plan.old === undefined) added.push(plan.item);
      else replaced.set(key, plan.item);
      if (update.note !== undefined) {
        // Длинная пометка обрезается, правка применяется (лимит символов не отказ).
        if (update.note.length > EMPLOYEE_NOTE_MAX_CHARS) trimmedNotes.push(index);
        notes.push(update.note.slice(0, EMPLOYEE_NOTE_MAX_CHARS));
      }
      applied.push({
        index,
        ...(plan.item.sku === undefined ? {} : { sku: plan.item.sku }),
        productName: plan.item.productName,
        ...(plan.old === undefined ? {} : { oldPrice: plan.old.price }),
        newPrice: plan.item.price,
        currency: plan.item.currency,
        isNew: plan.old === undefined,
      });
    }
    const warnings =
      trimmedNotes.length === 0
        ? {}
        : {
            warnings: [
              `Пометка длиннее ${EMPLOYEE_NOTE_MAX_CHARS} знаков обрезана у правок: ` +
                `${trimmedNotes.join(', ')}.`,
            ],
          };
    if (applied.length === 0) {
      return {
        importId: null,
        supplierId: input.supplierId,
        fileHash: null,
        applied,
        questions,
        totalItems: 0,
        ...warnings,
      };
    }
    const items = [...base.map((item) => replaced.get(priceItemKey(item)) ?? item), ...added];
    const fileHash = `${EMPLOYEE_HASH_PREFIX}${stableHash({ supplier: input.supplierId, items })}`;
    const importId = stagingImportId(input.supplierId, fileHash);
    await deps.staging.append(
      importId,
      { supplierId: input.supplierId, fileHash },
      { key: EMPLOYEE_CHUNK_KEY, table: EMPLOYEE_TABLE, tableRows: items.length, items },
      deps.clock.now(),
    );
    // Автор берётся из контекста запуска (тред), а не из аргументов: модель его не задаёт.
    await saveImportMeta(deps, importId, {
      source: 'employee',
      author: context.threadId,
      baseHash: priceListHash(base),
      notes,
    });
    return {
      importId,
      supplierId: input.supplierId,
      fileHash,
      applied,
      questions,
      totalItems: items.length,
      ...warnings,
    };
  },
});
