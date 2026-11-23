import { parsePriceCell } from '../agents/prices/table-rows';

/**
 * Масштабирование цены, записанной текстом («140р», «190 р.», «800 рублей», «1 200,50 руб.»),
 * для копии прайса: меняется только число внутри ячейки, остальной текст (знак валюты, точка,
 * слово «рублей») сохраняется как был. Разбор цены - тот же `parsePriceCell`, что у импорта
 * прайсов, поэтому «от 100», диапазон, тираж и неоднозначное «1.200» не правятся, а
 * возвращаются как пропущенные.
 */

/** Предел знаков после запятой в новой цене. */
export const SCALE_MAX_DECIMALS = 4;
/** Число внутри текста: с пробелами-разделителями тысяч и десятичной частью. */
const NUMBER_TOKEN = /\d+(?:[   ]\d{3})*(?:[.,]\d+)?/gu;
/** Разделители разрядов, которые встречаются в числе. */
const GROUP_SEPARATOR = /[   ]/u;
/** Группа разрядов: три цифры. */
const GROUP_SIZE = 3;
/** Десятичный разделитель по умолчанию, когда в исходной ячейке целое число. */
const DEFAULT_DECIMAL_SEPARATOR = ',';
/** Причины пропуска (для сотрудника и журнала: без значений ячеек). */
const REASON_QUALIFIED = 'цена «от», диапазон или тираж';
const REASON_AMBIGUOUS = 'запись числа неоднозначна';
const REASON_FORMAT = 'формат записи не поддержан';

/** Параметры масштабирования. */
export interface PriceScaleOptions {
  /** Во сколько раз меняется цена (2,074 - наценка в 2,074 раза). */
  factor: number;
  /** Знаков после запятой в новой цене; не задано - как в исходной ячейке. */
  decimals?: number | undefined;
  /**
   * Правятся ли ячейки без знака валюты («140»). Выключено - только ячейки с валютой
   * («140р»): так находятся цены текстом в столбцах без «цены» в шапке.
   */
  allowBare: boolean;
}

/** Итог по одной ячейке. */
export type PriceScaleOutcome =
  | {
      kind: 'scaled';
      /** Новое значение ячейки: число, если исходная ячейка - голое число, иначе текст. */
      cell: string | number;
      before: number;
      after: number;
    }
  | { kind: 'skipped'; reason: string }
  | { kind: 'ignored' };

/** Сколько знаков после запятой в числе из текста (разделитель - точка или запятая). */
function fractionDigits(token: string): number {
  const match = /[.,](\d+)$/u.exec(token);
  return match?.[1]?.length ?? 0;
}

/** Округление до `digits` знаков без «хвоста» плавающей точки. */
function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

/** Целая часть с группами разрядов заданным разделителем. */
function groupDigits(integer: string, separator: string): string {
  let out = '';
  for (let index = 0; index < integer.length; index += 1) {
    const left = integer.length - index;
    if (index > 0 && left % GROUP_SIZE === 0) out += separator;
    out += integer[index] ?? '';
  }
  return out;
}

/** Число в записи исходной ячейки: те же разделители разрядов и дробной части. */
function formatLike(token: string, value: number, digits: number): string {
  const separator = /([.,])\d+$/u.exec(token)?.[1] ?? DEFAULT_DECIMAL_SEPARATOR;
  const group = GROUP_SEPARATOR.exec(token)?.[0];
  const fixed = value.toFixed(digits);
  const [integer = '', fraction] = fixed.split('.');
  const body = group === undefined ? integer : groupDigits(integer, group);
  if (fraction === undefined) return body;
  return `${body}${separator}${fraction}`;
}

/**
 * Изменить цену в тексте ячейки.
 *
 * @param raw Текст ячейки как в файле.
 * @param options Коэффициент, число знаков и режим голых чисел.
 * @returns Новая ячейка, пропуск с причиной или «не цена».
 */
export function scalePriceText(raw: string, options: PriceScaleOptions): PriceScaleOutcome {
  if (raw.trim() === '') return { kind: 'ignored' };
  const parsed = parsePriceCell(raw);
  if (parsed.kind === 'ambiguous') {
    // Неоднозначное «1.200» правится только там, где сотрудник назвал столбец цен
    return options.allowBare ? { kind: 'skipped', reason: REASON_AMBIGUOUS } : { kind: 'ignored' };
  }
  if (parsed.kind !== 'ok') return { kind: 'ignored' };
  const hasCurrency = parsed.currency !== undefined;
  if (!hasCurrency && !options.allowBare) return { kind: 'ignored' };
  if (parsed.qualifier !== undefined || parsed.minQuantity !== undefined) {
    return { kind: 'skipped', reason: REASON_QUALIFIED };
  }
  const tokens = raw.match(NUMBER_TOKEN) ?? [];
  const token = tokens[0];
  if (tokens.length !== 1 || token === undefined) {
    return { kind: 'skipped', reason: REASON_FORMAT };
  }
  const requested = options.decimals;
  const digits = Math.min(requested ?? fractionDigits(token), SCALE_MAX_DECIMALS);
  const after = roundTo(parsed.value * options.factor, digits);
  const bare = raw.trim() === token;
  // Голое число без разрядов остаётся числом Excel, остальное - текст в записи исходной ячейки
  const asNumber = bare && !GROUP_SEPARATOR.test(token);
  const cell = asNumber ? after : raw.replace(token, formatLike(token, after, digits));
  return { kind: 'scaled', cell, before: parsed.value, after };
}
