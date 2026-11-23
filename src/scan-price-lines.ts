/**
 * Разбор распознанного текста скана-счёта или скан-прайса в позиции (этап 9v).
 *
 * Скан читает модель зрения, поэтому текст приходит как есть: строки «1 Кружка керамическая
 * 10 шт 250,00 2 500,00» или markdown-таблица. Здесь код выделяет позиции (название, количество,
 * цена, сумма) и сверяет арифметику «цена x количество = сумма». Всё сомнительное (нечитаемая
 * цифра, не сошлась сумма) НЕ правится, а помечается причиной сомнения: решает человек.
 */

/** Копеек в рубле: суммы считаются целыми копейками, без накопления ошибки плавающей точки. */
const KOPECKS = 100;
/** Допуск сверки «цена x количество = сумма», рубли: округление до копейки. */
const SUM_TOLERANCE = 0.011;
/** Сколько вариантов группировки разрядов перебираем для одной строки. */
const MAX_READINGS = 64;
/** Ожидаемое число чисел в хвосте строки без единицы измерения: количество, цена, сумма. */
const TRIPLE_SIZE = 3;
/** Ожидаемое число чисел после единицы измерения: цена и сумма. */
const PAIR_SIZE = 2;
/** Сколько букв подряд должно быть в названии позиции. */
const MIN_NAME_LETTERS = 2;
/** Минимальная длина слова для сравнения по общему началу (корню). */
const MIN_STEM_WORD = 3;
/** Сколько букв окончания слово может отличаться при сравнении по корню. */
const STEM_TAIL_LETTERS = 2;

/** Причина сомнения в строке: такая строка не правится кодом и уходит человеку на проверку. */
export const SCAN_DOUBTS = [
  'price_unreadable',
  'qty_unreadable',
  'sum_unreadable',
  'sum_mismatch',
  'row_unclear',
] as const;
export type ScanDoubt = (typeof SCAN_DOUBTS)[number];

/** Подписи причин сомнения для сотрудника. */
export const DOUBT_LABELS: Readonly<Record<ScanDoubt, string>> = {
  price_unreadable: 'цена не читается или неоднозначна',
  qty_unreadable: 'количество не читается или не указано',
  sum_unreadable: 'сумма не читается',
  sum_mismatch: 'цена x количество не равны сумме',
  row_unclear: 'строка разобрана неуверенно',
};

/** Позиция скана, как её прочитал код. */
export interface ScanLine {
  /** Номер позиции в распознанном тексте, с 1 (в порядке чтения). */
  index: number;
  name: string;
  qty: number | null;
  /** Единица измерения как в скане («шт», «кг»); пусто, если не указана. */
  unit: string;
  price: number | null;
  sum: number | null;
  /** Причины сомнения; пусто - строка читается уверенно. */
  doubts: ScanDoubt[];
  /** Исходная строка текста (для показа сотруднику). */
  raw: string;
}

/** Всё, что код прочитал из скана. */
export interface ScanReading {
  lines: ScanLine[];
  /** «Итого» из самого скана, если оно прочитано; нет - null. */
  statedTotal: number | null;
}

const PLAIN_NUMBER = /^\d+(?:[.,]\d+)?$/u;
/** «1.200»: точка может быть и разделителем разрядов, и десятичной - не угадываем. */
const AMBIGUOUS_DOT_GROUP = /^\d{1,3}\.\d{3}$/u;
const PLACEHOLDER = /^(?:[?#]+|нрзб\.?|нечитаемо|х{2,})$/iu;
const CURRENCY_TOKEN = /^(?:руб\.?|₽|р\.?|rub)$/iu;
const UNIT_TOKEN = /^(?:шт|штук|кг|г|л|м|м2|м²|уп|упак|компл|пар|рул|набор)\.?$/iu;
/** Начало группы разрядов: «2», «10», «250». */
const GROUP_HEAD = /^\d{1,3}$/u;
/** Продолжение группы разрядов: «500» или «500,00». */
const GROUP_TAIL = /^\d{3}(?:[.,]\d+)?$/u;
/** Группа разрядов без дробной части: за ней число может продолжаться. */
const GROUP_FULL = /^\d{3}$/u;
const NAME_LETTERS = new RegExp(`\\p{L}{${MIN_NAME_LETTERS}}`, 'u');
const INDEX_TOKEN = /^\d{1,3}[.)]?$/u;
const LEADING_LETTER = /^\p{L}/u;
const TOTAL_LINE = /^(?:итого|всего|к оплате)(?:\s+к оплате)?\s*[:\-–]?\s*([\d\s.,]*\d)/iu;
const NOT_ITEM_LINE = /^(?:итого|всего|к оплате|в т\.?\s?ч|ндс|без ндс|налог|скидка)/iu;
const SCAN_TEXT_PREFIX = /^\s*текст с фото\s*:\s*/iu;
const HEADER_NAME = /наимен|товар|номенкл|описан|услуг|позици/iu;
const HEADER_QTY = /кол-?во|колич/iu;
const HEADER_PRICE = /цен/iu;
const HEADER_SUM = /сумм|стоим/iu;
const HEADER_UNIT = /^ед|изм/iu;
const PIPE_SEPARATOR_ROW = /^[\s|:-]+$/u;
const THOUSANDS_GROUPED = /^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/u;
const CELL_NOISE = /(?:руб(?:\.|лей|ля)?|₽|\bр\b\.?|\bшт\b\.?)/giu;

/** Число из токена: «250,00» -> 250; неоднозначное или нечисло -> null. */
export function parseNumberToken(token: string): number | null {
  const text = token.replace(/\s+/gu, '');
  if (!PLAIN_NUMBER.test(text) || AMBIGUOUS_DOT_GROUP.test(text)) return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** Число из ячейки таблицы: «2 500,00 руб.» -> 2500; не число -> null. */
export function parseNumberCell(cell: string): number | null {
  const text = cell
    .replace(/[  ]/gu, ' ')
    .replace(CELL_NOISE, '')
    .trim();
  return parseNumberToken(THOUSANDS_GROUPED.test(text) ? text.replace(/ /gu, '') : text);
}

/** Сумма в рублях из целых копеек. */
function rubles(kopecks: number): number {
  return kopecks / KOPECKS;
}

/** Цена x количество, округлённая до копейки. */
export function lineSum(price: number, qty: number): number {
  return rubles(Math.round(Math.round(price * KOPECKS) * qty));
}

/** Сумма чисел без накопления ошибки: считается в целых копейках. */
export function sumMoney(values: readonly number[]): number {
  return rubles(values.reduce((total, value) => total + Math.round(value * KOPECKS), 0));
}

/** Совпадает ли сумма с произведением цены на количество в пределах копейки. */
export function sumMatches(price: number, qty: number, sum: number): boolean {
  return Math.abs(lineSum(price, qty) - sum) <= SUM_TOLERANCE;
}

/** Результат чтения хвоста строки: числа или null (нечитаемое место). */
type NumberList = Array<number | null>;

/**
 * Варианты чтения цепочки токенов-чисел: «2 500,00» бывает числом 2500 или двумя числами 2 и
 * 500. Перебираются все группировки разрядов; выбирает подходящую арифметика, а не угадывание.
 */
function readings(tokens: readonly string[]): Array<{ numbers: NumberList; merges: number }> {
  const results: Array<{ numbers: NumberList; merges: number }> = [];
  const walk = (position: number, numbers: NumberList, merges: number): void => {
    if (results.length >= MAX_READINGS) return;
    if (position >= tokens.length) {
      results.push({ numbers, merges });
      return;
    }
    const token = tokens[position] ?? '';
    walk(position + 1, [...numbers, parseNumberToken(token)], merges);
    if (!GROUP_HEAD.test(token)) return;
    // Разряды тысяч: «2» + «500,00»; цепочка «1» «000» «000» склеивается дальше.
    let merged = token;
    let next = position + 1;
    let count = merges;
    for (;;) {
      const part = tokens[next];
      if (part === undefined || !GROUP_TAIL.test(part)) break;
      merged += part;
      next += 1;
      count += 1;
      walk(next, [...numbers, parseNumberToken(merged)], count);
      // Дробная часть замыкает число: дальше разряды не продолжаются.
      if (!GROUP_FULL.test(part)) break;
    }
  };
  walk(0, [], 0);
  return results;
}

/** Хвост строки: токены-числа, единица измерения и валюта в конце строки. */
interface RowTail {
  head: string[];
  /** Токены чисел (с нечитаемыми местами) в порядке чтения, единица и валюта убраны. */
  numbers: string[];
  unit: string;
  /** Токены числовой области до единицы измерения (количество и всё, что перед ним). */
  beforeUnit: string[];
  /** Токены чисел после единицы измерения: цена и сумма. */
  afterUnit: string[];
}

function isNumberLike(token: string): boolean {
  return PLAIN_NUMBER.test(token) || PLACEHOLDER.test(token);
}

/** Разделить строку на название и хвост из чисел. */
function splitTail(tokens: readonly string[]): RowTail {
  let start = tokens.length;
  while (start > 0) {
    const token = tokens[start - 1] ?? '';
    const tail = isNumberLike(token) || CURRENCY_TOKEN.test(token) || UNIT_TOKEN.test(token);
    if (!tail) break;
    start -= 1;
  }
  const region = tokens.slice(start).filter((token) => !CURRENCY_TOKEN.test(token));
  const unitAt = region.findIndex((token) => UNIT_TOKEN.test(token));
  if (unitAt < 0) {
    return {
      head: tokens.slice(0, start) as string[],
      numbers: region,
      unit: '',
      beforeUnit: [],
      afterUnit: [],
    };
  }
  return {
    head: tokens.slice(0, start) as string[],
    numbers: [],
    unit: (region[unitAt] ?? '').replace(/\.$/u, ''),
    beforeUnit: region.slice(0, unitAt),
    afterUnit: region.slice(unitAt + 1),
  };
}

/** Прочитанные числа позиции до сверки. */
interface Figures {
  qty: number | null;
  price: number | null;
  sum: number | null;
  doubts: ScanDoubt[];
}

/** Лучшее чтение пары «цена, сумма» после количества: арифметика решает, где граница чисел. */
function readPair(tokens: readonly string[], qty: number | null): Figures | null {
  const all = readings(tokens);
  const consistent = all
    .filter((item) => item.numbers.length === PAIR_SIZE)
    .filter((item) => {
      const [price, sum] = item.numbers;
      return (
        qty !== null &&
        typeof price === 'number' &&
        typeof sum === 'number' &&
        sumMatches(price, qty, sum)
      );
    })
    .sort((a, b) => a.merges - b.merges)[0];
  if (consistent !== undefined) {
    const [price = null, sum = null] = consistent.numbers;
    return { qty, price, sum, doubts: [] };
  }
  const fewest = [...all].sort((a, b) => a.merges - b.merges);
  const pair = fewest.find((item) => item.numbers.length === PAIR_SIZE);
  if (pair !== undefined) {
    const [price = null, sum = null] = pair.numbers;
    return { qty, price, sum, doubts: doubtsOf(qty, price, sum) };
  }
  const single = fewest.find((item) => item.numbers.length === 1);
  if (single !== undefined) {
    const price = single.numbers[0] ?? null;
    return { qty, price, sum: null, doubts: doubtsOf(qty, price, null) };
  }
  return null;
}

/** Сомнения по прочитанным числам: нечитаемое и несошедшаяся арифметика. */
function doubtsOf(qty: number | null, price: number | null, sum: number | null): ScanDoubt[] {
  const doubts: ScanDoubt[] = [];
  if (price === null) doubts.push('price_unreadable');
  if (qty === null) doubts.push('qty_unreadable');
  if (price !== null && qty !== null && sum !== null && !sumMatches(price, qty, sum)) {
    doubts.push('sum_mismatch');
  }
  return doubts;
}

/** Числа позиции без единицы измерения: количество, цена, сумма. */
function readTriple(tokens: readonly string[], hasIndex: boolean): Figures | null {
  const all = readings(tokens);
  const triples = all.filter((item) => item.numbers.length === TRIPLE_SIZE);
  const consistent = triples
    .filter((item) => {
      const [qty, price, sum] = item.numbers;
      return (
        typeof qty === 'number' &&
        typeof price === 'number' &&
        typeof sum === 'number' &&
        sumMatches(price, qty, sum)
      );
    })
    .sort((a, b) => a.merges - b.merges)[0];
  if (consistent !== undefined) {
    const [qty = null, price = null, sum = null] = consistent.numbers;
    return { qty, price, sum, doubts: [] };
  }
  // Без номера строки неуверенный хвост - не позиция (телефон, реквизиты): пропускаем.
  if (!hasIndex) return null;
  const fewest = [...all].sort((a, b) => a.merges - b.merges);
  const triple = fewest.find((item) => item.numbers.length === TRIPLE_SIZE);
  if (triple !== undefined) {
    const [qty = null, price = null, sum = null] = triple.numbers;
    return { qty, price, sum, doubts: doubtsOf(qty, price, sum) };
  }
  const pair = fewest.find((item) => item.numbers.length === PAIR_SIZE);
  if (pair !== undefined) {
    const [qty = null, price = null] = pair.numbers;
    return { qty, price, sum: null, doubts: doubtsOf(qty, price, null) };
  }
  const single = fewest.find((item) => item.numbers.length === 1);
  if (single !== undefined) {
    const price = single.numbers[0] ?? null;
    return { qty: null, price, sum: null, doubts: doubtsOf(null, price, null) };
  }
  return { qty: null, price: null, sum: null, doubts: ['row_unclear'] };
}

/** Позиция из строки свободного текста; null - строка не позиция. */
function readTextRow(row: string, index: number): ScanLine | null {
  const tokens = row.replace(/[  ]/gu, ' ').trim().split(/\s+/u);
  const first = tokens[0] ?? '';
  const second = tokens[1] ?? '';
  const hasIndex = INDEX_TOKEN.test(first) && LEADING_LETTER.test(second);
  const body = hasIndex ? tokens.slice(1) : tokens;
  const tail = splitTail(body);
  let figures: Figures | null;
  let nameTokens = tail.head;
  if (tail.unit === '') {
    figures = readTriple(tail.numbers, hasIndex);
  } else {
    const qtyToken = tail.beforeUnit[tail.beforeUnit.length - 1];
    const qty = qtyToken === undefined ? null : parseNumberToken(qtyToken);
    nameTokens = [...tail.head, ...tail.beforeUnit.slice(0, -1)];
    figures = readPair(tail.afterUnit, qty);
  }
  const name = nameTokens.join(' ').replace(/[\s:;,.-]+$/u, '').trim();
  if (figures === null || !NAME_LETTERS.test(name)) return null;
  return {
    index,
    name,
    qty: figures.qty,
    unit: tail.unit,
    price: figures.price,
    sum: figures.sum,
    doubts: figures.doubts,
    raw: row.trim(),
  };
}

/** Столбцы таблицы по шапке; -1 - столбца нет. */
interface PipeColumns {
  name: number;
  qty: number;
  unit: number;
  price: number;
  sum: number;
}

function pipeCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

function columnsOf(cells: readonly string[]): PipeColumns | null {
  const find = (pattern: RegExp): number => cells.findIndex((cell) => pattern.test(cell));
  const columns: PipeColumns = {
    name: find(HEADER_NAME),
    qty: find(HEADER_QTY),
    unit: find(HEADER_UNIT),
    price: find(HEADER_PRICE),
    sum: find(HEADER_SUM),
  };
  return columns.name >= 0 && (columns.price >= 0 || columns.sum >= 0) ? columns : null;
}

/** Позиция из строки markdown-таблицы по найденной шапке. */
function readPipeRow(
  cells: readonly string[],
  columns: PipeColumns,
  index: number,
): ScanLine | null {
  const at = (column: number): string => (column < 0 ? '' : (cells[column] ?? '').trim());
  const name = at(columns.name);
  if (!NAME_LETTERS.test(name)) return null;
  const read = (column: number): number | null =>
    column < 0 || at(column) === '' ? null : parseNumberCell(at(column));
  const qty = read(columns.qty);
  const price = read(columns.price);
  const sum = read(columns.sum);
  const doubts = doubtsOf(qty, price, sum);
  if (columns.sum >= 0 && at(columns.sum) !== '' && sum === null) doubts.push('sum_unreadable');
  return {
    index,
    name,
    qty,
    unit: at(columns.unit),
    price,
    sum,
    doubts,
    raw: cells.join(' | '),
  };
}

/** Разобрать распознанный текст скана в позиции и «Итого» из самого скана. */
export function readScanText(text: string): ScanReading {
  const lines: ScanLine[] = [];
  let statedTotal: number | null = null;
  let columns: PipeColumns | null = null;
  const rows = text.replace(SCAN_TEXT_PREFIX, '').split(/\r?\n/u);
  for (const row of rows) {
    const trimmed = row.trim();
    if (trimmed === '') continue;
    if (trimmed.includes('|')) {
      if (PIPE_SEPARATOR_ROW.test(trimmed)) continue;
      const cells = pipeCells(trimmed);
      const header = columnsOf(cells);
      if (header !== null) {
        columns = header;
        continue;
      }
      const joined = cells.join(' ');
      const total = TOTAL_LINE.exec(joined);
      if (total !== null) {
        statedTotal = parseNumberCell(total[1] ?? '') ?? statedTotal;
        continue;
      }
      if (NOT_ITEM_LINE.test(joined)) continue;
      const item =
        columns === null
          ? readTextRow(joined, lines.length + 1)
          : readPipeRow(cells, columns, lines.length + 1);
      if (item !== null) lines.push(item);
      continue;
    }
    const total = TOTAL_LINE.exec(trimmed);
    if (total !== null) {
      statedTotal = parseNumberCell(total[1] ?? '') ?? statedTotal;
      continue;
    }
    if (NOT_ITEM_LINE.test(trimmed)) continue;
    const item = readTextRow(trimmed, lines.length + 1);
    if (item !== null) lines.push(item);
  }
  return { lines, statedTotal };
}

/** Слова для сравнения названий: нижний регистр, «ё» как «е», без знаков. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** Слова одного корня: «кружек» и «кружка» (общее начало, отличается окончание). */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  if (shortest < MIN_STEM_WORD) return false;
  let common = 0;
  while (common < shortest && a[common] === b[common]) common += 1;
  return common >= Math.max(MIN_STEM_WORD, shortest - STEM_TAIL_LETTERS);
}

/** Подходит ли название позиции под слова сотрудника (каждое слово запроса найдено). */
export function nameMatches(name: string, query: string): boolean {
  const wanted = wordsOf(query);
  const have = wordsOf(name);
  return wanted.length > 0 && wanted.every((word) => have.some((item) => sameStem(item, word)));
}
