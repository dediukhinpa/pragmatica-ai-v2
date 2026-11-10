import { DomainError } from '@business-ai/core';
import {
  MAX_PRICE_TIERS,
  type PriceItem,
  type PriceQualifier,
  type PriceTier,
  type PriceTierBasis,
} from '../../kit/domain/models';
import { parseNumberText } from '../../kit/domain/number-text';
import { priceItemKey } from '../../kit/domain/price-diff';
import {
  PRICE_CELL_MAX_CHARS,
  PRICE_WITH_PREFIX,
  PRICE_WITH_SUFFIX,
  currenciesInHeader,
  currencyOfMark,
  normalizePriceCell,
} from './currencies';
import { DEFAULT_PRICE_CURRENCY } from './deps';

const PRICE_CURRENCY_FALLBACK = DEFAULT_PRICE_CURRENCY;
/** Сколько символов названия показываем в списке пропущенных строк. */
const SKIPPED_TEXT_MAX = 60;
/** Итоговые и пояснительные строки: не позиции, даже если в цене стоит число. */
const TOTAL_ROW = /^(?:итого|итог|всего|примечани[ея]|примеч\.?|в том числе)(?![\p{L}])/iu;
/** «Цены нет» словами: такая строка - не позиция, а справка. */
const NO_PRICE_TEXT = new RegExp(
  [
    '^(?:по запросу|под заказ|по договор[её]нности|договорная|уточняйте|уточнять',
    'звоните|нет в наличии|н/д|нет|[-–—−.…_*]+)$',
  ].join('|'),
  'iu',
);
/** Ячейка названия повторной шапки таблицы («Наименование», «Артикул»). */
const HEADER_NAME_CELL = new RegExp(
  '^(?:наименование|название|товар|номенклатура|продукция|позиция|описание|артикул|' +
    'name|product|item|sku)(?![\\p{L}])',
  'iu',
);
/** Ячейка цены повторной шапки («Цена, руб.», «Стоимость», «Price»). */
const HEADER_PRICE_CELL =
  /^(?:цена|стоимость|прайс|price|cost|розн\p{L}*|опт\p{L}*|руб\.?)(?![\p{L}])/iu;
/**
 * Строка шапки без цены целиком («Наименование», «Название товара»): ячейка названия -
 * только слово шапки. «Товары для дома» сюда не попадает и остаётся заголовком группы.
 */
const HEADER_NAME_ONLY = new RegExp(
  '^(?:наименование|название|товар|номенклатура|продукция|позиция|описание|артикул|' +
    'name|product|item|sku)(?:\\s+(?:товара|позиции|продукции|изделия))?[\\s,.:]*$',
  'iu',
);

/** Номера столбцов (с нуля, как в markdown из readPriceFile). */
export interface PriceColumns {
  name: number;
  /** Столбец единственной цены. Либо он, либо `priceTiers` (цены по тиражам). */
  price?: number | undefined;
  /**
   * Столбцы цен по тиражам: «от 50 шт» - один столбец, «от 100 шт» - другой. Основная цена
   * позиции - цена минимального тиража.
   */
  priceTiers?: readonly PriceTierColumn[] | undefined;
  /**
   * Основание порогов `priceTiers`: 'quantity' (штуки, по умолчанию) или 'order_sum' (шапка
   * «Цена от 62 000», где число - сумма заказа в рублях). Только вместе с `priceTiers`.
   */
  tierBasis?: PriceTierBasis | undefined;
  sku?: number | undefined;
  currency?: number | undefined;
  /** Столбцы варианта (размер, цвет, вес, фасовка), все указанные. */
  variantColumns?: readonly number[] | undefined;
  /** Столбец группы (категория, модель): название строк без названия берётся из него. */
  group?: number | undefined;
  /** Название строки без названия берётся из ближайшей выше строки-заголовка группы. */
  groupHeaderRows?: boolean | undefined;
}

/** Столбец цены одного тиража. */
export interface PriceTierColumn {
  column: number;
  minQuantity: number;
}

/**
 * Предупреждения о тиражах сверх `MAX_PRICE_TIERS`, которые `priceColumnsOf` отбросил; пусто, если
 * все тиражи уместились. Вызывающий кладёт его в `warnings` ответа, чтобы потеря не была тихой.
 */
export function tierWarnings(columns: PriceColumns): string[] {
  const dropped = (columns.priceTiers?.length ?? 0) - MAX_PRICE_TIERS;
  if (dropped <= 0) return [];
  return [
    `Тиражей в файле больше ${MAX_PRICE_TIERS}: взяты первые ${MAX_PRICE_TIERS} по возрастанию ` +
      `тиража, отброшено: ${dropped}.`,
  ];
}

/**
 * Столбцы цен в порядке возрастания тиража (для одной цены - один элемент без тиража).
 * Бросает `invalid_input`, если не указан ни `price`, ни `priceTiers`, указаны оба или тиражи
 * повторяются. Тиражей сверх `MAX_PRICE_TIERS` берутся первые (по возрастанию тиража), остальные
 * отбрасываются: о числе отброшенных сообщает `tierWarnings` (решение владельца, этап 181).
 */
export function priceColumnsOf(
  columns: PriceColumns,
): Array<{ column: number; minQuantity?: number }> {
  const tiers = columns.priceTiers ?? [];
  if (columns.tierBasis === 'order_sum' && tiers.length === 0) {
    throw new DomainError(
      'invalid_input',
      'tierBasis=order_sum задаётся только вместе с priceTiers.',
    );
  }
  if (columns.price !== undefined && tiers.length > 0) {
    throw new DomainError(
      'invalid_input',
      'Укажите либо price (одна цена), либо priceTiers (цены по тиражам), не оба сразу.',
    );
  }
  if (tiers.length === 0) {
    if (columns.price === undefined) {
      throw new DomainError('invalid_input', 'Не указан столбец цены: price или priceTiers.');
    }
    return [{ column: columns.price }];
  }
  // Лишние тиражи не отказ: в позицию помещается не больше MAX_PRICE_TIERS, берём первые.
  const sorted = [...tiers]
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .slice(0, MAX_PRICE_TIERS);
  for (const [index, tier] of sorted.entries()) {
    const previous = sorted[index - 1];
    if (previous !== undefined && previous.minQuantity === tier.minQuantity) {
      throw new DomainError('invalid_input', `Тираж ${tier.minQuantity} указан дважды.`);
    }
    if (sorted.some((other, at) => at !== index && other.column === tier.column)) {
      throw new DomainError('invalid_input', `Столбец ${tier.column} указан для двух тиражей.`);
    }
  }
  return sorted;
}

/**
 * Единица измерения после цены: «100 руб./шт», «1 200 ₽/м», «1200 р/кг», «50/м2». Срезается до
 * поиска валюты (R9-A1-09: такие ячейки отклонялись, и одна строка блокировала импорт).
 * Единица - одно-два слова из букв и точек, допустим хвост 2/3 (м2, м³). Цифры в начале
 * единицы («/1000 шт», «/100 м») - это цена за несколько единиц: такая ячейка не срезается.
 */
const UNIT_TAIL = /\s?\/\s?(\p{L}[\p{L}.]*(?: \p{L}[\p{L}.]*)?[23²³]?)$/u;
/**
 * Единицы-множители («/тыс. шт», «/млн», «/сотня», «/дюжина»): цена указана не за одну
 * единицу, срезать нельзя - ячейка остаётся нераспознанной и уходит человеку. «Пара»,
 * «упаковка», «комплект» - сами единицы товара (ОКЕИ), они срезаются.
 */
const MULTIPLIER_UNIT = /^(?:тыс|млн|млрд|сот|дюж|десят|thousand|hundred|dozen|k(?!\p{L}))/iu;

/** Ячейка без хвоста «/единица»; ячейка без такого хвоста или с множителем - как есть. */
function withoutUnitTail(text: string): string {
  const tail = UNIT_TAIL.exec(text);
  if (tail === null || MULTIPLIER_UNIT.test(tail[1] ?? '')) return text;
  return text.slice(0, tail.index).trimEnd();
}

/** Строка, которую не удалось разобрать (номер строки как в markdown). */
interface RejectedRow {
  row: number;
  reason: string;
}

/** Параметры разбора строк таблицы. */
export interface TableRowParams {
  supplierId: string;
  headerRows: number;
  columns: PriceColumns;
  defaultCurrency: string;
  /** Дата цен (ISO), одна на весь импорт. */
  date: string;
}

/** Строка, которая не позиция прайса (группа, «по запросу», итог, шапка): только показать. */
interface SkippedRow {
  row: number;
  reason: string;
  /** Начало текста строки, чтобы человек узнал её в файле. */
  text: string;
}

/**
 * Где в таблице файла лежит цена позиции: строка и столбцы цены (с нуля, как в markdown из
 * readPriceFile). Ключ - `priceItemKey` позиции. Нужен правке цен в исходном файле.
 */
export interface PriceCellRef {
  key: string;
  row: number;
  cols: number[];
}

/** Результат разбора диапазона строк. */
export interface ParsedRows {
  items: PriceItem[];
  /** Координаты цен принятых позиций (по одной записи на позицию в `items`). */
  cells: PriceCellRef[];
  rejected: RejectedRow[];
  /** Строки «не позиция»: не входят ни в позиции, ни в число строк исходника. */
  skipped: SkippedRow[];
  /** Строк данных-позиций в диапазоне (без пропущенных). */
  sourceRowCount: number;
}

/**
 * Разбор ячейки цены: число, валюта из самой ячейки (если есть) или причина отказа.
 * `qualifier`: «от 500» - 'from', «500-700» - 'range' (тогда `max` - верхняя граница, `value` -
 * нижняя). `minQuantity`: тираж из той же ячейки («от 100 шт 45 руб»), `value` - цена тиража.
 */
export type PriceCell =
  | {
      kind: 'ok';
      value: number;
      currency?: string | undefined;
      qualifier?: PriceQualifier | undefined;
      max?: number | undefined;
      minQuantity?: number | undefined;
    }
  | { kind: 'zero' }
  | { kind: 'ambiguous' }
  | { kind: 'invalid' };

/** «от» в начале ячейки: минимальная цена. */
const FROM_PREFIX = /^от\s+(.+)$/iu;
/**
 * Диапазон «500-700», «1 000 - 1 500»: два числа через дефис, en dash или em dash (в том числе
 * с пробелами). Минус U+2212 не берём: это знак отрицательного числа. Хвост-валюта срезан до
 * проверки, поэтому «10-15 см», «100-200 шт» сюда не попадают - в них остаётся слово-единица.
 */
const RANGE_TEXT = /^(\d[\d\s.,]*?)\s*[-\u2013\u2014]\s*(\d[\d\s.,]*)$/u;
/** Часть числа с начальным нулём («01», «05»): так пишутся дни и месяцы, не цены. */
const LEADING_ZERO = /^0\d/;
/** Часть, похожая на день.месяц («15.02», «01.02»): две такие части - это даты, не цены. */
const DAY_MONTH = /^(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])$/;
/**
 * Тираж и цена в одной ячейке: «от 100 шт 45 руб», «100 шт. - 45 р.». Слово-единица стоит сразу
 * после числа, а после него - не буква и не цифра: «50шт45р» (слитная неизвестная форма)
 * не распознаётся и уходит человеку.
 */
const QUANTITY_AND_PRICE =
  /^(?:от\s+)?(\d[\d\s]*?)\s?(?:шт|штук|pcs|pc)\.?(?![\p{L}\p{N}])\s*[-\u2013\u2014:]?\s*(\S.*)$/iu;

/** Ячейка «тираж + цена»; null, если ячейка не такой формы (идём обычным разбором). */
function parseQuantityCell(text: string): PriceCell | null {
  const match = QUANTITY_AND_PRICE.exec(text);
  if (match === null) return null;
  const quantity = parseNumberText(match[1] ?? '');
  if (
    quantity.kind !== 'ok' ||
    !Number.isInteger(quantity.value) ||
    quantity.value <= 0 ||
    LEADING_ZERO.test(match[1] ?? '')
  ) {
    return { kind: 'invalid' };
  }
  const priced = parsePriceCell(match[2] ?? '');
  // Цена тиража - обычная точная цена: «от 100 шт от 45 руб» и вложенные тиражи не угадываем.
  if (priced.kind !== 'ok' || priced.qualifier !== undefined || priced.minQuantity !== undefined) {
    return priced.kind === 'ambiguous' ? priced : { kind: 'invalid' };
  }
  const minQuantity = quantity.value;
  return { kind: 'ok', value: priced.value, currency: priced.currency, minQuantity };
}

/** Границы правдоподобных календарных годов для отсечения «2024-2025». */
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;

/** Диапазон «N-M» (текст уже без валюты); null, если текст не похож на диапазон. */
function parseRangeText(
  text: string,
): PriceCell | { kind: 'range'; low: number; high: number } | null {
  const match = RANGE_TEXT.exec(text);
  if (match === null) return null;
  const parts = [(match[1] ?? '').trim(), (match[2] ?? '').trim()];
  // Даты «01-02», «01.02-05.02» и номера «01-05» (начальный ноль) - не цены.
  if (parts.some((part) => LEADING_ZERO.test(part))) return { kind: 'invalid' };
  if (parts.every((part) => DAY_MONTH.test(part))) return { kind: 'invalid' };
  const [low, high] = parts.map((part) => parseNumberText(part));
  if (low?.kind === 'ambiguous' || high?.kind === 'ambiguous') return { kind: 'ambiguous' };
  if (low?.kind !== 'ok' || high?.kind !== 'ok') return { kind: 'invalid' };
  // Верхняя граница строго больше нижней: «12-01», «5-5» - не диапазон цен (скорее дата).
  if (!(roundPrice(low.value) > 0) || !(roundPrice(high.value) > roundPrice(low.value))) {
    return { kind: 'invalid' };
  }
  // «2024-2025» - годы, а не цена: обе границы целые в пределах календарных лет.
  const bothYears = [low.value, high.value].every(
    (value) => Number.isInteger(value) && value >= YEAR_MIN && value <= YEAR_MAX,
  );
  if (bothYears) return { kind: 'invalid' };
  return { kind: 'range', low: roundPrice(low.value), high: roundPrice(high.value) };
}

/**
 * Ячейка цены целиком: число (единый разбор `parseNumberText`) и валюта, если она записана
 * в самой ячейке («100 руб.» - RUB, а не валюта по умолчанию). Неоднозначное «1,234» не
 * угадывается.
 *
 * Цена словами (разбирается только в ячейках столбца цены, который выбрала модель):
 * - «от 500», «от 500 руб» - минимальная цена: `qualifier: 'from'`;
 * - «500-700», «500 - 700 руб.» - диапазон: `qualifier: 'range'`, `max` (> нижней границы);
 * - «от 100 шт 45 руб» - тираж из ячейки: `minQuantity` и цена тиража.
 * Правила узкие намеренно: ячейка, которую не удалось разобрать однозначно (даты, размеры,
 * количества «100-200 шт», «от 500 шт» без цены, слитное «50шт45р»), остаётся `invalid` и уходит
 * в отклонённые, а не превращается в угаданную цену.
 */
export function parsePriceCell(raw: string): PriceCell {
  // Схлопываем пробелы и отсекаем длинное до regex: иначе ячейка в 32 767 знаков стоит секунд.
  const normalized = normalizePriceCell(raw);
  if (normalized.length > PRICE_CELL_MAX_CHARS) return { kind: 'invalid' };
  let text = withoutUnitTail(normalized);
  const quantityCell = parseQuantityCell(text);
  if (quantityCell !== null) return quantityCell;
  let qualifier: PriceQualifier | undefined;
  const from = FROM_PREFIX.exec(text);
  if (from !== null) {
    qualifier = 'from';
    text = from[1] ?? '';
  }
  let currency: string | undefined;
  const prefix = PRICE_WITH_PREFIX.exec(text);
  const suffix = prefix === null ? PRICE_WITH_SUFFIX.exec(text) : null;
  if (prefix !== null) {
    currency = currencyOfMark(prefix[1] ?? '') ?? undefined;
    text = prefix[2] ?? '';
  } else if (suffix !== null) {
    currency = currencyOfMark(suffix[2] ?? '') ?? undefined;
    text = suffix[1] ?? '';
  }
  const range = qualifier === undefined ? parseRangeText(text) : null;
  if (range !== null) {
    if (range.kind !== 'range') return range;
    return { kind: 'ok', value: range.low, currency, qualifier: 'range', max: range.high };
  }
  const parsed = parseNumberText(text);
  if (parsed.kind !== 'ok') return parsed;
  const value = roundPrice(parsed.value);
  if (value === 0) return { kind: 'zero' };
  if (!(value > 0)) return { kind: 'invalid' };
  return { kind: 'ok', value, currency, ...(qualifier === undefined ? {} : { qualifier }) };
}

/**
 * Сколько знаков после запятой оставляем в цене: доли копейки (цена за грамм) сохраняются,
 * а хвост плавающей точки из формулы Excel («266.66666666666666») - нет. Такой хвост из 10
 * или 12 цифр проверка ПДн принимает за ИНН (контрольная сумма сходится примерно у одного
 * из 11), и ход импорта отклонялся целиком («Медовый дом», 27.10).
 */
export const PRICE_FRACTION_DIGITS = 4;
const PRICE_ROUNDING = 10 ** PRICE_FRACTION_DIGITS;

/** Округлить цену до {@link PRICE_FRACTION_DIGITS} знаков после запятой. */
export function roundPrice(value: number): number {
  return Math.round(value * PRICE_ROUNDING) / PRICE_ROUNDING;
}

/**
 * Точная цена из ячейки: «1 234,50», «10 руб.», «15.5»; null, если не число, неоднозначно или
 * <= 0. «От 500», диапазон и тираж в ячейке - не точная цена: null, чтобы признак не терялся
 * молча (им пользуется `parsePriceCell`).
 */
export function parsePrice(raw: string): number | null {
  const cell = parsePriceCell(raw);
  if (cell.kind !== 'ok' || cell.qualifier !== undefined || cell.minQuantity !== undefined) {
    return null;
  }
  return cell.value;
}

/** Код валюты из ячейки; null, если не распознан. */
export function parseCurrency(raw: string): string | null {
  return currencyOfMark(raw);
}

function cellOf(row: string[], column: number | undefined): string {
  return column === undefined ? '' : (row[column] ?? '').trim();
}

/** Ячейки цен строки по столбцам (для одной цены - одна) и их склейка для сверки с шапкой. */
function priceTextsOf(row: string[], priceColumns: ReturnType<typeof priceColumnsOf>): string[] {
  return priceColumns.map((entry) => cellOf(row, entry.column));
}

/** Ячейки названия и цены строки заголовка: по ним узнаётся повтор шапки внутри листа. */
interface HeaderCells {
  name: string;
  price: string;
}

/** Причина пропуска строки-заголовка группы (название без цены). */
const GROUP_HEADER_REASON = 'название без цены (заголовок группы), не позиция';
/** Причина пропуска повторной шапки таблицы. */
const REPEATED_HEADER_REASON = 'повторная шапка таблицы';

/**
 * Что это за строка таблицы: пустая, позиция (годная или битая) или «не позиция». У позиции -
 * уже разобранная ячейка цены: разбор не повторяется (R9-A1-03).
 */
type RowClass =
  | { kind: 'empty' }
  | { kind: 'data'; price: PriceCell; tiers: PriceTier[] }
  | { kind: 'skip'; reason: string; group: boolean };

function skipRow(reason: string, group = false): RowClass {
  return { kind: 'skip', reason, group };
}

/** Строка повторяет шапку таблицы дословно (название и цена как в одной из строк заголовка). */
function repeatsHeader(name: string, priceText: string, headers: readonly HeaderCells[]): boolean {
  const lowerName = name.toLowerCase();
  const lowerPrice = priceText.toLowerCase();
  return headers.some(
    (header) => header.name !== '' && header.name === lowerName && header.price === lowerPrice,
  );
}

/**
 * Класс строки зависит только от названия и ячейки цены, поэтому счёт строк исходника и
 * разбор позиций согласованы. «Не позиция» - заголовок группы (название без цены), «по
 * запросу», итог и примечание, повторная шапка, нулевая цена, ноль без названия. Строка с
 * названием и нечисловой ценой вроде «abc» остаётся позицией и уходит в отклонённые.
 */
function classifyRow(
  row: string[],
  columns: PriceColumns,
  headers: readonly HeaderCells[] = [],
): RowClass {
  const priceColumns = priceColumnsOf(columns);
  const name = cellOf(row, columns.name);
  const texts = priceTextsOf(row, priceColumns);
  // Основная цена - в столбце минимального тиража; без неё остальные тиражи цену не заменяют.
  const priceText = texts[0] ?? '';
  const tierTexts = texts.slice(1);
  if (priceText === '' && tierTexts.some((text) => text !== '')) {
    if (name === '') return skipRow('нет ни названия, ни цены');
    return { kind: 'data', price: { kind: 'invalid' }, tiers: [] };
  }
  if (name === '' && priceText === '') return { kind: 'empty' };
  if (name !== '' && TOTAL_ROW.test(name)) return skipRow('итог или примечание, не позиция');
  if (repeatsHeader(name, texts.join('|'), headers)) return skipRow(REPEATED_HEADER_REASON);
  if (priceText === '') {
    if (HEADER_NAME_ONLY.test(name)) return skipRow(REPEATED_HEADER_REASON);
    return skipRow(GROUP_HEADER_REASON, true);
  }
  const cell = parsePriceCell(priceText);
  if (cell.kind === 'ok' || cell.kind === 'ambiguous') {
    return tiersOfRow(cell, priceColumns, tierTexts);
  }
  if (cell.kind === 'zero') return skipRow('цена равна нулю, не позиция');
  if (name === '') {
    return skipRow(
      HEADER_PRICE_CELL.test(priceText) ? REPEATED_HEADER_REASON : 'нет ни названия, ни цены',
    );
  }
  if (NO_PRICE_TEXT.test(priceText)) return skipRow('цена не указана («по запросу»), не позиция');
  if (HEADER_NAME_CELL.test(name) || HEADER_PRICE_CELL.test(priceText)) {
    return skipRow(REPEATED_HEADER_REASON);
  }
  return { kind: 'data', price: cell, tiers: [] };
}

/** Тираж из разобранной ячейки: «от»/диапазон переносятся в сам тираж. */
function tierOf(minQuantity: number, cell: Extract<PriceCell, { kind: 'ok' }>): PriceTier {
  return {
    minQuantity,
    price: cell.value,
    ...(cell.qualifier === undefined ? {} : { qualifier: cell.qualifier }),
    ...(cell.max === undefined ? {} : { max: cell.max }),
  };
}

/**
 * Данные строки с ценами по тиражам. Цена минимального тиража (`cell`) - основная; пустой
 * тираж, «по запросу» и ноль в остальных столбцах просто не попадают в список, а
 * неоднозначная или нечитаемая цена тиража, как и другая валюта в ней, отклоняет строку.
 */
function tiersOfRow(
  cell: PriceCell,
  priceColumns: ReturnType<typeof priceColumnsOf>,
  tierTexts: readonly string[],
): RowClass {
  if (cell.kind !== 'ok') return { kind: 'data', price: cell, tiers: [] };
  const invalidRow: RowClass = { kind: 'data', price: { kind: 'invalid' }, tiers: [] };
  if (priceColumns.length > 1) {
    // Несколько столбцов тиражей: «от N шт P руб» в ячейке - две разные записи тиража на одну
    // цену, какая верна - не угадываем, строка уходит человеку. Диапазон и «от» в ячейке
    // тиража допустимы: признак хранится в самом тираже (матрица «размер × тираж»).
    if (cell.minQuantity !== undefined) return invalidRow;
  } else if (cell.minQuantity !== undefined) {
    // Тираж из самой ячейки: массив из одного элемента, иначе потеряется «от 100 шт».
    return {
      kind: 'data',
      price: cell,
      tiers: [{ minQuantity: cell.minQuantity, price: cell.value }],
    };
  }
  if (tierTexts.length === 0) return { kind: 'data', price: cell, tiers: [] };
  const tiers: PriceTier[] = [];
  const first = priceColumns[0]?.minQuantity;
  if (first !== undefined) tiers.push(tierOf(first, cell));
  for (const [index, text] of tierTexts.entries()) {
    if (text === '') continue;
    const tierCell = parsePriceCell(text);
    if (tierCell.kind === 'ambiguous') return { kind: 'data', price: tierCell, tiers: [] };
    if (tierCell.kind === 'zero' || NO_PRICE_TEXT.test(text)) continue;
    if (
      tierCell.kind !== 'ok' ||
      tierCell.currency !== cell.currency ||
      tierCell.minQuantity !== undefined
    ) {
      return invalidRow;
    }
    const minQuantity = priceColumns[index + 1]?.minQuantity;
    if (minQuantity !== undefined) tiers.push(tierOf(minQuantity, tierCell));
  }
  // В режиме столбцов один заполненный тираж - это просто цена, массив нужен от двух.
  return { kind: 'data', price: cell, tiers: tiers.length >= 2 ? tiers : [] };
}

/** Строки заголовка таблицы в виде, удобном для сравнения (нижний регистр). */
function headerCellsOf(
  table: readonly string[][],
  headerRows: number,
  columns: PriceColumns,
): HeaderCells[] {
  const result: HeaderCells[] = [];
  const priceColumns = priceColumnsOf(columns);
  for (let index = 0; index < Math.min(headerRows, table.length); index += 1) {
    const row = table[index] ?? [];
    result.push({
      name: cellOf(row, columns.name).toLowerCase(),
      price: priceTextsOf(row, priceColumns).join('|').toLowerCase(),
    });
  }
  return result;
}

/** Разобранная строка-позиция: название и артикул уже собраны кодом из столбцов и групп. */
interface PlannedItem {
  kind: 'data';
  price: PriceCell;
  /** Цены по тиражам (от двух) или пусто; основная цена `price` - первого тиража. */
  tiers: PriceTier[];
  /** Итоговое название: «<название> <вариант1> <вариант2>»; пусто, если названия нет нигде. */
  name: string;
  sku: string;
}

/** План разбора строки таблицы (одинаков для счёта строк и для разбора позиций). */
type PlannedRow =
  | { kind: 'empty' }
  | PlannedItem
  | { kind: 'skip'; reason: string; text: string };

/** Экранирование текста для вставки в RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Слово или фраза `part` входит в `text` целым словом (без учёта регистра). */
function containsWhole(text: string, part: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

/** Значения столбцов варианта строки: непустые, без повторов, в порядке столбцов. */
function variantsOf(row: string[], columns: PriceColumns, withoutName = false): string[] {
  const result: string[] = [];
  for (const column of (columns.variantColumns ?? [])) {
    if (withoutName && column === columns.name) continue;
    const value = cellOf(row, column).replace(/\s+/g, ' ');
    if (value !== '' && !result.some((item) => item.toLowerCase() === value.toLowerCase())) {
      result.push(value);
    }
  }
  return result;
}

/** Название с вариантами; вариант, уже названный в названии, второй раз не добавляется. */
function composeName(base: string, variants: readonly string[]): string {
  if (base === '') return '';
  const parts = [base];
  for (const variant of variants) {
    if (!containsWhole(base, variant)) parts.push(variant);
  }
  return parts.join(' ');
}

/**
 * Артикул с вариантом: у одной модели в разных размерах артикул часто общий, а ключ позиции
 * строится по артикулу. Без варианта (или если артикул его уже содержит) артикул как есть.
 */
function composeSku(sku: string, variants: readonly string[]): string {
  if (sku === '') return '';
  const extra = variants.filter((variant) => !containsWhole(sku, variant));
  return extra.length === 0 ? sku : `${sku} / ${extra.join(' ')}`;
}

/** Ключ полного дубля: название с вариантами, артикул, цена и валюта строки. */
function duplicateKey(item: PlannedItem, row: string[], columns: PriceColumns): string {
  const price =
    item.price.kind === 'ok'
      ? [
          item.price.value,
          item.price.currency ?? '',
          item.price.qualifier ?? '',
          item.price.max ?? '',
        ].join('|')
      : '';
  // Те же название и цена, но другие тиражи - не дубль.
  const tiers = item.tiers
    .map((tier) => `${tier.minQuantity}:${tier.price}:${tier.qualifier ?? ''}:${tier.max ?? ''}`)
    .join(',');
  return [
    item.name.toLowerCase().replace(/\s+/g, ' '),
    item.sku.toLowerCase(),
    price,
    tiers,
    cellOf(row, columns.currency).toLowerCase(),
  ].join('\u0000');
}

/**
 * План разбора всей таблицы. Здесь строится название позиции (группы, объединённые ячейки,
 * варианты), пропускаются повторные шапки и схлопываются полные дубли: счёт строк исходника
 * и разбор кусков staging идут по одному плану, поэтому число строк сходится при любом
 * разбиении на куски.
 */
function planTable(
  table: readonly string[][],
  headerRows: number,
  columns: PriceColumns,
): PlannedRow[] {
  const headers = headerCellsOf(table, headerRows, columns);
  const priceColumns = priceColumnsOf(columns);
  const plan: PlannedRow[] = [];
  const groupMode = columns.groupHeaderRows === true || columns.group !== undefined;
  const nameIsVariant = (columns.variantColumns ?? []).includes(columns.name);
  const firstSeen = new Map<string, number>();
  let groupName = '';
  let lastName = '';
  for (let index = 0; index < table.length; index += 1) {
    if (index < headerRows) {
      plan.push({ kind: 'empty' });
      continue;
    }
    const row = table[index] ?? [];
    const rowClass = classifyRow(row, columns, headers);
    if (rowClass.kind === 'empty') {
      plan.push(rowClass);
      continue;
    }
    // Столбец группы: значение пустое в нижних строках объединённой ячейки - держим прежнее.
    const groupCell = cellOf(row, columns.group);
    if (groupCell !== '' && groupCell !== groupName) {
      groupName = groupCell;
      lastName = '';
    }
    const variants = variantsOf(row, columns);
    if (rowClass.kind === 'skip') {
      // Столбец названия одновременно и вариант (матрица «размер × тираж»): в строке без цены
      // его значение - название группы, а не вариант.
      const headerVariants = variantsOf(row, columns, true);
      const text = cellOf(row, columns.name) || (priceTextsOf(row, priceColumns)[0] ?? '');
      // Заголовок группы: название без цены и без варианта (иначе это строка варианта без цены).
      if (rowClass.group && columns.groupHeaderRows === true && headerVariants.length === 0) {
        groupName = cellOf(row, columns.name);
        lastName = '';
      }
      plan.push({ kind: 'skip', reason: rowClass.reason, text: text.slice(0, SKIPPED_TEXT_MAX) });
      continue;
    }
    // Столбец названия - тоже столбец варианта (в строке позиции там размер, название товара
    // только в заголовке группы): собственного названия у строки нет.
    const own = nameIsVariant && groupMode ? '' : cellOf(row, columns.name);
    let base = own;
    if (own !== '') lastName = own;
    // Пустое название: объединённая ячейка (значение сверху в той же группе) или имя группы.
    else if (groupMode || variants.length > 0) {
      if (variants.length > 0 && lastName !== '') base = lastName;
      else if (groupName !== '') base = groupName;
    }
    const item: PlannedItem = {
      kind: 'data',
      price: rowClass.price,
      tiers: rowClass.tiers,
      name: composeName(base, variants),
      sku: composeSku(cellOf(row, columns.sku), variants),
    };
    if (item.name !== '' && item.price.kind === 'ok') {
      const key = duplicateKey(item, row, columns);
      const first = firstSeen.get(key);
      if (first !== undefined) {
        plan.push({
          kind: 'skip',
          reason: `полный дубль строки ${first} (те же название, варианты и цена), схлопнут`,
          text: item.name.slice(0, SKIPPED_TEXT_MAX),
        });
        continue;
      }
      firstSeen.set(key, index);
    }
    plan.push(item);
  }
  return plan;
}

/**
 * Планы таблиц в кэше: ключ - заголовок и все столбцы, влияющие на разбор. Таблица из кэша
 * разбора общая и не меняется, поэтому `stagePriceRows` не пересчитывает всю таблицу на
 * каждом куске: при пяти кусках прайса в 50 тыс. строк это было 5 полных проходов, около 4 с
 * (R9-A1-03).
 */
const tablePlans = new WeakMap<readonly string[][], Map<string, PlannedRow[]>>();

function planOf(
  table: readonly string[][],
  headerRows: number,
  columns: PriceColumns,
): PlannedRow[] {
  const key = JSON.stringify([
    headerRows,
    columns.name,
    columns.price ?? null,
    columns.priceTiers ?? [],
    columns.tierBasis ?? 'quantity',
    columns.sku ?? null,
    columns.currency ?? null,
    columns.variantColumns ?? [],
    columns.group ?? null,
    columns.groupHeaderRows === true,
  ]);
  let plans = tablePlans.get(table);
  const cached = plans?.get(key);
  if (cached !== undefined) return cached;
  const plan = planTable(table, headerRows, columns);
  if (plans === undefined) {
    plans = new Map();
    tablePlans.set(table, plans);
  }
  plans.set(key, plan);
  return plan;
}

/** Сколько позиций-строк данных в таблице после заголовка (пропущенные и дубли не считаются). */
export function countDataRows(
  table: readonly string[][],
  headerRows: number,
  columns: PriceColumns,
): number {
  return planOf(table, headerRows, columns).filter((row) => row.kind === 'data').length;
}

/** Результат выбора валюты прайса. */
export type TableCurrency =
  | { kind: 'ok'; currency: string }
  | { kind: 'mismatch'; header: string; explicit: string };

/** Валюта из заголовка столбца цены; null, если её нет или названо несколько. */
function detectHeaderCurrency(
  table: string[][],
  headerRows: number,
  columns: PriceColumns,
): string | null {
  const found = new Set<string>();
  for (let index = 0; index < Math.min(headerRows, table.length); index += 1) {
    for (const text of priceTextsOf(table[index] ?? [], priceColumnsOf(columns))) {
      for (const code of currenciesInHeader(text)) found.add(code);
    }
  }
  const [only] = [...found];
  return found.size === 1 && only !== undefined ? only : null;
}

/**
 * Валюта прайса: из заголовка столбца цены, иначе из аргумента, иначе RUB. Если заголовок
 * называет одну валюту, а аргумент другую - расхождение: берётся валюта заголовка с
 * предупреждением. Со столбцом
 * валюты у каждой строки своя валюта, заголовок не применяется.
 */
export function resolveTableCurrency(
  table: string[][],
  headerRows: number,
  columns: PriceColumns,
  explicit: string | undefined,
): TableCurrency {
  const given = explicit?.toUpperCase();
  if (columns.currency !== undefined) {
    return { kind: 'ok', currency: given ?? PRICE_CURRENCY_FALLBACK };
  }
  const header = detectHeaderCurrency(table, headerRows, columns);
  if (header !== null && given !== undefined && header !== given) {
    return { kind: 'mismatch', header, explicit: given };
  }
  return { kind: 'ok', currency: header ?? given ?? PRICE_CURRENCY_FALLBACK };
}

/**
 * Предупреждение при расхождении валюты заголовка и аргумента (этап 177): берётся валюта
 * заголовка (она в файле, не выдумана), аргумент игнорируется, сотрудник видит подмену.
 */
export function currencyMismatchWarning(header: string, explicit: string): string {
  return (
    `Валюта: в заголовке столбца цены ${header}, а defaultCurrency ${explicit}; взята ` +
    `${header} из файла, defaultCurrency проигнорирована. Проверьте валюту.`
  );
}

/**
 * Разбор строк таблицы в позиции. Строки берутся из диапазона [from, to) (по умолчанию вся
 * таблица), заголовок пропускается. Модель только указывает столбцы; строки разбирает код.
 */
export function parseTableRows(
  table: string[][],
  params: TableRowParams,
  from = 0,
  to: number = table.length,
): ParsedRows {
  const items: PriceItem[] = [];
  const cells: PriceCellRef[] = [];
  const rejected: RejectedRow[] = [];
  const skipped: SkippedRow[] = [];
  let sourceRowCount = 0;
  const priceCols = priceColumnsOf(params.columns).map((item) => item.column);
  const plan = planOf(table, params.headerRows, params.columns);
  const last = Math.min(to, table.length);
  for (let rowIndex = Math.max(from, params.headerRows); rowIndex < last; rowIndex += 1) {
    const row = table[rowIndex] ?? [];
    const planned = plan[rowIndex];
    if (planned === undefined || planned.kind === 'empty') continue;
    if (planned.kind === 'skip') {
      skipped.push({ row: rowIndex, reason: planned.reason, text: planned.text });
      continue;
    }
    sourceRowCount += 1;
    const name = planned.name;
    const { price } = planned;
    const rawCurrency = cellOf(row, params.columns.currency);
    const columnCurrency = rawCurrency === '' ? null : parseCurrency(rawCurrency);
    const cellCurrency = price.kind === 'ok' ? price.currency : undefined;
    const conflict =
      cellCurrency !== undefined && columnCurrency !== null && cellCurrency !== columnCurrency;
    const currency =
      rawCurrency === ''
        ? (cellCurrency ?? params.defaultCurrency)
        : (columnCurrency ?? null);
    const sku = planned.sku;
    if (name === '') rejected.push({ row: rowIndex, reason: 'пустое название' });
    else if (price.kind === 'ambiguous') {
      rejected.push({ row: rowIndex, reason: 'цена неоднозначна (запятая или точка), уточните' });
    } else if (price.kind !== 'ok') {
      rejected.push({ row: rowIndex, reason: 'цена не распознана' });
    } else if (conflict) {
      rejected.push({ row: rowIndex, reason: 'валюта в цене и в столбце различаются' });
    } else if (currency === null) rejected.push({ row: rowIndex, reason: 'валюта не распознана' });
    else {
      const item: PriceItem = {
        supplierId: params.supplierId,
        productName: name,
        ...(sku === '' ? {} : { sku }),
        price: price.value,
        currency,
        date: params.date,
        ...(planned.tiers.length === 0 ? {} : { priceTiers: planned.tiers }),
        ...(planned.tiers.length > 0 && params.columns.tierBasis === 'order_sum'
          ? { priceTierBasis: 'order_sum' as const }
          : {}),
        ...(price.qualifier === undefined ? {} : { priceQualifier: price.qualifier }),
        ...(price.max === undefined ? {} : { priceMax: price.max }),
      };
      items.push(item);
      cells.push({ key: priceItemKey(item), row: rowIndex, cols: priceCols });
    }
  }
  return { items, cells, rejected, skipped, sourceRowCount };
}
