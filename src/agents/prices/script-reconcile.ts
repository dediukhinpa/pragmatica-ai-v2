import { priceItemKey } from '../../kit/domain/price-diff';
import { type PriceItem } from '../../kit/domain/models';
import { type ValidationIssue } from '@business-ai/core';
import type { ParsedScriptItems, ScriptPriceItem } from './script-price-items';

/**
 * Сверка результата скрипта до записи в staging (этап 111, тема 3) и разница «было/стало» при
 * правке по просьбе сотрудника. Чистые функции: данных в сообщениях нет, только счётчики и
 * номера позиций.
 */

/** Доля строк исходника, ниже которой результат считается потерявшим позиции. */
const MIN_COVERAGE = 0.8;
/** Во сколько раз позиций может быть больше строк исходника (варианты раскрывают строку). */
const MAX_EXPANSION = 3;
/** Сколько номеров позиций называем в одном замечании. */
const LISTED_INDEXES = 5;
/** Сколько изменённых позиций показываем в разнице «было/стало». */
export const DIFF_SAMPLE_SIZE = 5;
const NUMBER_CELL = /^[-+]?\d[\d\s .,]*$/u;
const LETTER = /\p{L}/u;

/**
 * Шкала тиражей блока: «Тираж | мин.72 | 100 | 200», «Количество | 50 | 100 | 500». Это шапка
 * блока, а не позиция: иначе у листа из нескольких товарных блоков каждая шапка раздувает
 * число строк данных и сверка видит «потерянные» позиции (этап 116, раскладка «блоки»).
 */
const SCALE_TITLE = /^(?:тираж|тиражи|количество|кол-во|кол\.?|тир\.?)(?![\p{L}])/iu;
const SCALE_STEP = /^(?:мин\.?\s*)?\d[\d\s]*(?:\s*шт\.?)?\+?$/iu;

function isTierScaleRow(cells: readonly string[]): boolean {
  const filled = cells.filter((cell) => cell !== '');
  const [title, ...steps] = filled;
  if (title === undefined || !SCALE_TITLE.test(title) || steps.length < 2) return false;
  return steps.every((cell) => SCALE_STEP.test(cell));
}

/** Строка исходника - строка данных, если в ней есть и число, и текст. */
function isDataRow(row: readonly string[]): boolean {
  const cells = row.map((cell) => cell.trim());
  if (isTierScaleRow(cells)) return false;
  return cells.some((cell) => NUMBER_CELL.test(cell)) && cells.some((cell) => LETTER.test(cell));
}

/** Приблизительное число строк данных во всех таблицах исходника (число и текст в строке). */
export function countSourceDataRows(tables: readonly (readonly (readonly string[])[])[]): number {
  return tables.reduce((sum, table) => sum + table.filter(isDataRow).length, 0);
}

/**
 * Ячейка-тираж: «от 50», «от 101-250», «500 шт», «500-900 шт». Голое число не тираж (это может
 * быть цена), поэтому нужно «от» либо «шт».
 */
const TIER_LABEL =
  /^(?:(?:от|до)\s*\d[\d\s]*(?:(?:[-\u2013]|\s+до\s+)\s*\d[\d\s]*)?(?:\s*шт\.?)?|\d[\d\s]*(?:[-\u2013]\s*\d[\d\s]*)?\s*шт\.?)$/iu;
/** Сколько строк подряд с тиражами считается матрицей «тиражи строками, позиции столбцами». */
const MIN_TIER_BLOCK_ROWS = 2;

/** Сколько числовых ячеек цены в строке-тираже; 0 - строка не тираж (нет подписи или цен). */
function tierRowPrices(row: readonly string[]): number {
  const cells = row.map((cell) => cell.trim());
  if (!cells.some((cell) => TIER_LABEL.test(cell))) return 0;
  return cells.filter((cell) => !TIER_LABEL.test(cell) && NUMBER_CELL.test(cell)).length;
}

/**
 * Нижняя оценка числа позиций исходника для таблиц-матриц: подряд идущие строки тиражей
 * («100 шт | 30 | 34 | 38») дают позиций столько, сколько в них столбцов с ценами, а не строк
 * (тиражи - это уровни цены позиции, а не отдельные позиции). Остальные строки данных считаются
 * как в {@link countSourceDataRows}. Нужна только нижней границе сверки: верхняя берёт число
 * строк, чтобы список со столбцом «10 шт» не стал ложным «повторами».
 */
export function countSourceItemUnits(
  tables: readonly (readonly (readonly string[])[])[],
): number {
  let units = 0;
  for (const table of tables) {
    let block: number[] = [];
    const closeBlock = (): void => {
      if (block.length >= MIN_TIER_BLOCK_ROWS) units += Math.max(...block);
      else units += block.length;
      block = [];
    };
    for (const row of table) {
      const prices = tierRowPrices(row);
      if (prices > 0) {
        block.push(prices);
        continue;
      }
      closeBlock();
      if (isDataRow(row)) units += 1;
    }
    closeBlock();
  }
  return units;
}

/** Таблицы исходника: таблица -> строки -> ячейки. */
type SourceTables = readonly (readonly (readonly string[])[])[];

/** Доля строк с ценами в исходнике, использованных позициями; ниже - скрипт потерял цены.
 * 0.8, а не 0.6: потеря трети прайса не должна проходить молча (решение владельца 28.10). */
const MIN_PRICE_ROWS_USED = 0.8;
/** Доля позиций, чьи цены не нашлись рядом с их названием; выше - цены перепутаны. */
const MAX_UNATTACHED_ITEMS = 0.2;
/** Какая доля значимых слов названия позиции должна найтись в исходнике (скрипт может добавить слово). */
const MIN_NAME_WORDS_FOUND = 0.5;
/** Слово короче - не значимое (предлоги, единицы). */
const MIN_WORD_CHARS = 3;
/** Слова сравниваем по основе: падежи и числа («полотенце/полотенца»). */
const WORD_STEM_CHARS = 5;
/** Гласные, которые выпадают в падежах и числах («значок» - «значки»). */
const FLEETING_VOWELS = 'ое';
/** Строк шапки таблицы, слова которых относятся ко всем её блокам (название таблицы). */
const TITLE_ROWS = 2;
const PRICE_ROUND_DIGITS = 2;
/** Подряд идущих чисел 1..n в столбце хватает, чтобы признать его нумерацией строк. */
const MIN_INDEX_COLUMN_ROWS = 3;

const NUMBER_TOKEN = /\d{1,3}(?:[\s ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;
/** Ячейка с ценой: «5700», «1 200,50», «от 5700», «120 руб.». Тираж «100 шт» сюда не входит. */
const PRICE_CELL =
  /^(?:от\s*)?\d[\d\s ]*(?:[.,]\d+)?\s*(?:₽|руб\.?|р\.?|rub|usd|eur|\$|€)?$/iu;
const FROM_CELL = /^от\s*\d/iu;
const TOTAL_CELL = /^(?:итого|всего|сумма|total)(?![\p{L}])/iu;

function numberKey(value: number): string {
  return value.toFixed(PRICE_ROUND_DIGITS);
}

/** Все числа ячейки (с учётом пробелов-разделителей тысяч и запятой). */
function numbersOf(cell: string): string[] {
  const out: string[] = [];
  for (const match of cell.matchAll(NUMBER_TOKEN)) {
    const raw = match[0];
    const whole = Number(raw.replace(/[\s ]/gu, '').replace(',', '.'));
    if (Number.isFinite(whole)) out.push(numberKey(whole));
    // «100 200» может быть двумя числами: берём и части.
    if (/[\s ]/u.test(raw)) {
      for (const part of raw.split(/[\s ]+/u)) {
        const value = Number(part.replace(',', '.'));
        if (Number.isFinite(value)) out.push(numberKey(value));
      }
    }
  }
  return out;
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/x/gu, 'х')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_CHARS)
    .map(stemOf);
}

/**
 * Основа слова: первые `WORD_STEM_CHARS` букв. Беглую гласную пятой буквы («значок/значки»)
 * убираем, иначе единственное и множественное число дают разные основы: название товара в
 * имени файла стоит во множественном числе, а в позиции - в единственном.
 */
function stemOf(word: string): string {
  const fifth = word.charAt(WORD_STEM_CHARS - 1);
  const fleeting = word.length > WORD_STEM_CHARS && FLEETING_VOWELS.includes(fifth);
  if (!fleeting) return word.slice(0, WORD_STEM_CHARS);
  return word.slice(0, WORD_STEM_CHARS - 1) + word.charAt(WORD_STEM_CHARS);
}

/** Слова, по которым позицию ищем в исходнике: название и вариант. */
function itemWords(item: PriceItem): string[] {
  return [...new Set(wordsOf(item.productName))];
}

/** Слова из `words` не меньше доли `MIN_NAME_WORDS_FOUND` найдены в `has`. */
function mostlyFound(words: readonly string[], has: (word: string) => boolean): boolean {
  if (words.length === 0) return true;
  return words.filter(has).length >= words.length * MIN_NAME_WORDS_FOUND;
}

/** Где в исходнике стоит число: слова строки, ближайшего блока заголовков и названия таблицы. */
interface NumberContext {
  row: ReadonlySet<string>;
  block: ReadonlySet<string>;
  title: ReadonlySet<string>;
}

interface SourceIndex {
  /** Число (округлённое) -> контексты всех его вхождений. */
  numbers: Map<string, NumberContext[]>;
  /** Все слова исходника (ячейки и названия листов). */
  words: Set<string>;
  /** Строки с ценами (без повторов): число строк и их числа-цены. */
  priceRows: string[][];
}

function indexColumns(table: readonly (readonly string[])[]): Set<number> {
  const columns = new Map<number, number[]>();
  for (const row of table) {
    row.forEach((cell, col) => {
      const value = cell.trim();
      if (/^\d+$/u.test(value)) columns.set(col, [...(columns.get(col) ?? []), Number(value)]);
    });
  }
  const out = new Set<number>();
  for (const [col, values] of columns) {
    const sequential = values.every((value, i) => value === i + 1);
    if (sequential && values.length >= MIN_INDEX_COLUMN_ROWS) out.add(col);
  }
  return out;
}

/** Строка - не цены: итоги, шкала «от 50 | от 100», тиражи «50 шт». */
function isServiceRow(cells: readonly string[], priceCells: readonly string[]): boolean {
  if (isTierScaleRow(cells) || cells.some((cell) => TOTAL_CELL.test(cell))) return true;
  return priceCells.length >= 2 && priceCells.every((cell) => FROM_CELL.test(cell));
}

/**
 * Имя файла без каталога и расширения: у части прайсов название товара стоит только в нём
 * («Прайс шары с печатью.xlsx»), а в таблицах его нет.
 */
export function fileTitle(fileName: string | undefined): string {
  const base = (fileName ?? '').split(/[\\/]/u).pop() ?? '';
  return base.replace(/\.[^.]*$/u, '');
}

/** Ячейка с собственным текстом строки: буквы есть, но это не подпись тиража и не цена. */
function isOwnText(cell: string): boolean {
  return LETTER.test(cell) && !TIER_LABEL.test(cell) && !PRICE_CELL.test(cell);
}

function buildSourceIndex(
  tables: SourceTables,
  names: readonly string[] | undefined,
  fileName: string | undefined,
): SourceIndex {
  const index: SourceIndex = { numbers: new Map(), words: new Set(), priceRows: [] };
  const seenRows = new Set<string>();
  tables.forEach((table, t) => {
    const title = new Set<string>(wordsOf(names?.[t] ?? ''));
    wordsOf(fileTitle(fileName)).forEach((w) => title.add(w));
    for (const row of table.slice(0, TITLE_ROWS)) wordsOf(row.join(' ')).forEach((w) => title.add(w));
    const skipColumns = indexColumns(table);
    let block = new Set<string>();
    let inBlock = false;
    // Слова строки-владельца группы: объединённые (или пустые) ячейки названия в следующих
    // строках группы дают только тиражи и цены, и без переноса цены выглядят «чужими».
    let owner: ReadonlySet<string> | null = null;
    for (const raw of table) {
      const cells = raw.map((cell) => cell.trim());
      const rowWords = new Set(wordsOf(cells.join(' ')));
      rowWords.forEach((w) => index.words.add(w));
      title.forEach((w) => index.words.add(w));
      const priceCells = cells.filter((cell) => PRICE_CELL.test(cell));
      // Строка без ячеек-цен - заголовок блока; подряд идущие заголовки образуют один блок.
      const isHeader = priceCells.length === 0;
      if (isHeader) {
        if (!inBlock) block = new Set();
        rowWords.forEach((w) => block.add(w));
      }
      inBlock = isHeader;
      if (isHeader) owner = null;
      else if (cells.some(isOwnText)) owner = new Set(rowWords);
      else owner?.forEach((w) => rowWords.add(w));
      const context: NumberContext = { row: rowWords, block, title };
      for (const cell of cells) {
        for (const key of numbersOf(cell)) {
          index.numbers.set(key, [...(index.numbers.get(key) ?? []), context]);
        }
      }
      if (isHeader) continue;
      const signature = cells.join('\u0001');
      if (seenRows.has(signature)) continue;
      seenRows.add(signature);
      const prices = cells.flatMap((cell, col) =>
        PRICE_CELL.test(cell) && !skipColumns.has(col) ? numbersOf(cell).slice(0, 1) : []);
      if (prices.length > 0 && LETTER.test(cells.join(' ')) && !isServiceRow(cells, priceCells)) {
        index.priceRows.push(prices);
      }
    }
  });
  return index;
}

/** Числа позиции: цены (должны быть в исходнике) и пороги (только отмечают использованное). */
function itemPrices(item: PriceItem): number[] {
  const tiers = item.priceTiers ?? [];
  return [
    item.price,
    ...(item.priceMax === undefined ? [] : [item.priceMax]),
    ...tiers.flatMap((tier) => [tier.price, ...(tier.max === undefined ? [] : [tier.max])]),
  ];
}

/**
 * Сверка по покрытию, не зависящая от раскладки (этап 117): плоский список, матрица без столбца
 * названия, блоки на нескольких листах, шкала тиражей в шапке группы дают разное число строк,
 * но одно и то же должно выполняться всегда: (а) каждая цена позиции есть в числах исходника;
 * (б) слова названия есть в исходнике; (в) цены позиции стоят рядом с её названием (строка или
 * блок), иначе цены перепутаны; (г) большинство строк с ценами исходника использовано.
 */
function coverageIssues(
  items: readonly PriceItem[],
  tables: SourceTables,
  names: readonly string[] | undefined,
  fileName: string | undefined,
): ValidationIssue[] | null {
  const index = buildSourceIndex(tables, names, fileName);
  if (index.numbers.size === 0 || index.priceRows.length === 0) return null;
  const issues: ValidationIssue[] = [];
  const unknownPrice = indexesOf2(items, (item) =>
    itemPrices(item).some((price) => !index.numbers.has(numberKey(price))));
  if (unknownPrice.length > 0) {
    issues.push({
      code: 'price_not_in_source',
      message: 'Цены позиций, которых нет среди чисел исходника (выдуманы или посчитаны): ' +
        `${unknownPrice.length}; номера ${listed(unknownPrice)}.`,
    });
  }
  const unknownName = indexesOf2(items, (item) =>
    !mostlyFound(itemWords(item), (word) => index.words.has(word)));
  if (unknownName.length > 0) {
    issues.push({
      code: 'name_not_in_source',
      message: `Названий позиций, слов которых нет в исходнике: ${unknownName.length}; ` +
        `номера ${listed(unknownName)}.`,
    });
  }
  const detached = indexesOf2(items, (item) => {
    const words = itemWords(item);
    return itemPrices(item).some((price) => {
      const contexts = index.numbers.get(numberKey(price));
      if (contexts === undefined) return false; // уже названо как price_not_in_source
      return !contexts.some((ctx) =>
        mostlyFound(words, (w) => ctx.row.has(w) || ctx.block.has(w) || ctx.title.has(w)));
    });
  });
  if (detached.length > items.length * MAX_UNATTACHED_ITEMS) {
    issues.push({
      code: 'price_context_mismatch',
      message: 'Цены позиций стоят в исходнике рядом с другими названиями (цены перепутаны): ' +
        `${detached.length} из ${items.length}; номера ${listed(detached)}.`,
    });
  }
  const used = new Set<string>();
  for (const item of items) {
    for (const price of itemPrices(item)) used.add(numberKey(price));
    for (const tier of item.priceTiers ?? []) used.add(numberKey(tier.minQuantity));
  }
  const usedRows = index.priceRows.filter((prices) => prices.some((key) => used.has(key)));
  if (usedRows.length < index.priceRows.length * MIN_PRICE_ROWS_USED) {
    issues.push({
      code: 'source_prices_unused',
      message: `Использовано строк с ценами ${usedRows.length} из ${index.priceRows.length} ` +
        'в исходнике: часть цен потеряна.',
    });
  }
  return issues;
}

/** Номера (с 1) позиций прайса, для которых `bad` истинно. */
function indexesOf2(items: readonly PriceItem[], bad: (item: PriceItem) => boolean): number[] {
  return items.flatMap((item, position) => (bad(item) ? [position + 1] : []));
}

/** Подпись позиции целиком: два одинаковых экземпляра - не конфликт, а повтор строки. */
function itemSignature(item: PriceItem): string {
  const tiers = tiersText(item);
  return [
    priceItemKey(item), item.productName.trim().toLowerCase(), item.price, item.currency, tiers,
    qualifierText(item),
  ].join('|');
}

/**
 * Точные повторы позиций скрипта (то же название, вариант, артикул, цены, тиражи) схлопываются:
 * лист «Упаковка» с повторами банок не должен валить сверку. Разные цены у одного названия
 * остаются и ловятся как `duplicate_keys`.
 */
export function collapseExactDuplicates(items: readonly ScriptPriceItem[]): ScriptPriceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const signature = JSON.stringify([
      item.name.trim().toLowerCase(),
      (item.variant ?? '').trim().toLowerCase(),
      item.sku ?? '',
      item.price,
      item.currency ?? '',
      item.tiers ?? [],
      item.tier_basis ?? '',
      item.price_qualifier ?? '',
      item.price_max ?? '',
    ]);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function listed(indexes: readonly number[]): string {
  const shown = indexes.slice(0, LISTED_INDEXES).join(', ');
  return indexes.length > LISTED_INDEXES ? `${shown} и др.` : shown;
}

function monotonic(item: ScriptPriceItem): boolean {
  const tiers = item.tiers ?? [];
  return tiers.every((tier, i) => {
    const prev = tiers[i - 1];
    if (prev === undefined) return true;
    return tier.min_quantity > prev.min_quantity && tier.price <= prev.price;
  });
}

/** Номера (с 1) позиций, для которых `bad` истинно. */
function indexesOf(items: readonly ScriptPriceItem[], bad: (item: ScriptPriceItem) => boolean) {
  return items.flatMap((item, position) => (bad(item) ? [position + 1] : []));
}

/** Данные для сверки. */
export interface ScriptReconcileInput {
  /** Позиции, как вернул скрипт (до контракта). */
  rawCount: number;
  parsed: ParsedScriptItems;
  /** Позиции прайса после превращения. */
  items: readonly PriceItem[];
  /** Число строк данных исходника (`countSourceDataRows`). */
  sourceRows: number;
  /**
   * Нижняя оценка числа позиций (`countSourceItemUnits`): у матриц тиражей позиций меньше, чем
   * строк. Нет - берётся `sourceRows`.
   */
  sourceUnits?: number | undefined;
  /**
   * Таблицы исходника. Заданы - сверка по покрытию (цены, названия, использование строк), а не
   * по числу строк: она не зависит от раскладки (матрицы, блоки, шкалы тиражей в шапке).
   */
  sourceTables?: SourceTables | undefined;
  /** Названия листов для `sourceTables` (если известны). */
  sourceTableNames?: readonly string[] | undefined;
  /** Имя файла исходника: источник названия товара наравне с названиями листов. */
  sourceFileName?: string | undefined;
}

const INVALID_FIELD_CODES: Readonly<Record<string, string>> = {
  price: 'non_numeric_price',
  name: 'empty_name',
};

/**
 * Сверка до записи: число позиций против строк исходника, пустые названия, нечисловые цены,
 * дубли ключей, немонотонные тиражи. Любое замечание блокирует запись в staging: скрипт надо
 * исправить. Замечания идут без значений данных.
 */
export function reconcileScriptItems(input: ScriptReconcileInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { parsed, items } = input;
  if (input.rawCount === 0) {
    return [{ code: 'no_items', message: 'Скрипт вернул пустой список позиций.' }];
  }
  const byCode = new Map<string, number[]>();
  for (const bad of parsed.invalid) {
    const code = INVALID_FIELD_CODES[bad.field] ?? 'invalid_item';
    byCode.set(code, [...(byCode.get(code) ?? []), bad.index]);
  }
  for (const [code, indexes] of byCode) {
    issues.push({
      code,
      message: `Позиций не по контракту (${code}): ${indexes.length}; номера ${listed(indexes)}.`,
    });
  }
  const coverage = input.sourceTables === undefined
    ? null
    : coverageIssues(items, input.sourceTables, input.sourceTableNames, input.sourceFileName);
  if (coverage !== null) issues.push(...coverage);
  // Число строк как мерило годится только плоскому списку; при сверке по покрытию не берём.
  // Нижняя граница: у матрицы тиражей позиций меньше строк, берём меньшую из двух оценок.
  const lowerBasis = Math.min(input.sourceRows, input.sourceUnits ?? input.sourceRows);
  const allowedMissing = Math.max(1, Math.floor(lowerBasis * (1 - MIN_COVERAGE)));
  if (coverage === null && items.length < lowerBasis - allowedMissing) {
    issues.push({
      code: 'items_fewer_than_rows',
      message: `Позиций ${items.length}, строк данных в исходнике около ${lowerBasis}: ` +
        'часть строк потеряна.',
    });
  }
  if (coverage === null && input.sourceRows > 0 && items.length > input.sourceRows * MAX_EXPANSION) {
    issues.push({
      code: 'items_more_than_rows',
      message: `Позиций ${items.length}, строк данных в исходнике около ${input.sourceRows}: ` +
        'похоже на повторы.',
    });
  }
  const seen = new Map<string, string>();
  const duplicates: number[] = [];
  items.forEach((item, position) => {
    const key = priceItemKey(item);
    const signature = itemSignature(item);
    const prior = seen.get(key);
    // Точный повтор строки (тот же ключ и те же цены) не конфликт; разные цены - конфликт.
    if (prior !== undefined && prior !== signature) duplicates.push(position + 1);
    if (prior === undefined) seen.set(key, signature);
  });
  if (duplicates.length > 0) {
    issues.push({
      code: 'duplicate_keys',
      message: `Дублей ключа позиции (артикул или название с вариантом): ${duplicates.length}; ` +
        `номера ${listed(duplicates)}.`,
    });
  }
  const valid = parsed.items;
  const notMonotonic = indexesOf(valid, (item) => !monotonic(item));
  if (notMonotonic.length > 0) {
    issues.push({
      code: 'tiers_not_monotonic',
      message: 'Тиражи должны идти по возрастанию порога, цена не растёт с тиражом; ' +
        `нарушено у позиций ${listed(notMonotonic)} (всего ${notMonotonic.length}).`,
    });
  }
  const priceMismatch = indexesOf(
    valid,
    (item) => item.tiers?.[0] !== undefined && item.tiers[0].price !== item.price,
  );
  if (priceMismatch.length > 0) {
    issues.push({
      code: 'tier_price_mismatch',
      message: 'Цена позиции с тиражами должна равняться цене первого тиража; ' +
        `не так у позиций ${listed(priceMismatch)} (всего ${priceMismatch.length}).`,
    });
  }
  const basisWithoutTiers = indexesOf(
    valid,
    (item) => item.tier_basis === 'order_sum' && (item.tiers?.length ?? 0) === 0,
  );
  if (basisWithoutTiers.length > 0) {
    issues.push({
      code: 'tier_basis_without_tiers',
      message: `Основание order_sum без тиражей у позиций ${listed(basisWithoutTiers)}.`,
    });
  }
  return issues;
}

/** Что изменилось в позиции: поле и значения «было/стало» (цены и признаки, не названия). */
interface ItemChange {
  /** Название позиции (маскируется шлюзом). */
  name: string;
  field: 'price' | 'currency' | 'tiers' | 'qualifier';
  was: string;
  now: string;
}

/** Разница между прежним и новым набором позиций одного прайса. */
export interface ItemsDiff {
  before: number;
  after: number;
  added: number;
  removed: number;
  /** Позиций, у которых изменилась цена, валюта, тиражи или признак цены. */
  changed: number;
  sample: ItemChange[];
}

function tiersText(item: PriceItem): string {
  const basis = item.priceTierBasis === 'order_sum' ? 'сумма:' : '';
  return (item.priceTiers ?? []).map((t) => `${basis}${t.minQuantity}=${t.price}`).join(';');
}

function qualifierText(item: PriceItem): string {
  return `${item.priceQualifier ?? ''}${item.priceMax === undefined ? '' : `-${item.priceMax}`}`;
}

function changesOf(was: PriceItem, now: PriceItem): ItemChange[] {
  const name = now.productName;
  const out: ItemChange[] = [];
  if (was.price !== now.price) {
    out.push({ name, field: 'price', was: String(was.price), now: String(now.price) });
  }
  if (was.currency !== now.currency) {
    out.push({ name, field: 'currency', was: was.currency, now: now.currency });
  }
  if (tiersText(was) !== tiersText(now)) {
    out.push({ name, field: 'tiers', was: tiersText(was), now: tiersText(now) });
  }
  if (qualifierText(was) !== qualifierText(now)) {
    out.push({ name, field: 'qualifier', was: qualifierText(was), now: qualifierText(now) });
  }
  return out;
}

/** Разница «было/стало» по ключам позиций (артикул, иначе название). */
export function diffItems(before: readonly PriceItem[], after: readonly PriceItem[]): ItemsDiff {
  const old = new Map(before.map((item) => [priceItemKey(item), item]));
  const sample: ItemChange[] = [];
  let changed = 0;
  let added = 0;
  const kept = new Set<string>();
  for (const item of after) {
    const key = priceItemKey(item);
    const was = old.get(key);
    if (was === undefined) {
      added += 1;
      continue;
    }
    kept.add(key);
    const changes = changesOf(was, item);
    if (changes.length === 0) continue;
    changed += 1;
    for (const change of changes) {
      if (sample.length < DIFF_SAMPLE_SIZE) sample.push(change);
    }
  }
  return {
    before: before.length,
    after: after.length,
    added,
    removed: [...old.keys()].filter((key) => !kept.has(key)).length,
    changed,
    sample,
  };
}
