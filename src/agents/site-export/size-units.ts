import {
  HYPHEN,
  orderByAxes,
  scanAxisLabels,
  scanSingleDimension,
  SIZE_SEPARATOR,
  UNIT_SPELLINGS,
  type LengthUnit,
  type RawDimension,
  type SizeAxis,
  type SizeProblem,
} from './size-axes';

/**
 * Столбец «Размер упаковки» шаблона сайта (этап 225): единица измерения берётся из шапки
 * столбца, а не из константы; значение размера «ш×в×г» переводится в эту единицу. Чистые
 * функции без ввода-вывода.
 *
 * Формат записи (решение владельца 14, отменяет решение 12): `260×220×110` - знак умножения
 * «×» (U+00D7) без пробелов, порядок строго ширина×высота×глубина, два измерения - `260×220`.
 */

export { SIZE_SEPARATOR };
export type { LengthUnit };

/** Единица по умолчанию, когда в шапке единицы нет: размер упаковки в шаблоне ведётся в мм. */
export const DEFAULT_SIZE_UNIT: LengthUnit = 'мм';
/**
 * Точность размера: 0,1 мм. Знаков после запятой зависит от единицы шапки (в метрах - 4, в
 * сантиметрах - 2): иначе округление «до десятых» в большой единице превращало 1 мм в 0 м.
 */
const SIZE_PRECISION_MM = 0.1;
const DECIMALS_BY_UNIT: Readonly<Record<LengthUnit, number>> = { мм: 1, см: 2, дм: 3, м: 4 };
/** Больше измерений в размере упаковки не бывает: ширина, высота, глубина. */
const SIZE_DIMENSIONS_MAX = 3;
/** Запятая «1,200» неоднозначна только среди нескольких измерений. */
const SEVERAL_DIMENSIONS = 2;
/** Измерение от этого значения (в единице записи) считается «целым» для проверки запятой. */
const SEPARATOR_CHECK_FROM = 100;

/** Миллиметров в единице: общая шкала, чтобы переводить без дробных множителей. */
const MM_PER_UNIT: Readonly<Record<LengthUnit, number>> = { мм: 1, см: 10, дм: 100, м: 1000 };

/** Единица в шапке: после начала строки, пробела, запятой или скобки и до разделителя. */
const HEADER_UNIT = /(?:^|[\s,(])(мм|см|дм|м|mm|cm|dm|m)(?=[\s,).;]|$)/i;
/**
 * Разряды через пробел: «1 200» -> «1200». Склеиваем только однозначный случай: РОВНО одна цифра,
 * пробел и группа из трёх цифр, за которой нет ни цифры, ни ещё одного пробела с цифрой, а перед
 * цифрой нет цифры или запятой. Одна цифра - не размер упаковки («1 мм»), поэтому «1 200» - это
 * 1200. Любое другое «число пробел число» («260 220», «260 220 110», «12 500») нельзя отличить от
 * списка измерений без разделителя: пробел остаётся пробелом, и такая запись - порядок неясен
 * (раньше «260 220 110» молча склеивалось в 260220110 и писалось в ячейку).
 */
const THOUSANDS = /(?<![\d.,])(\d)[   ](\d{3})(?!\d)(?![   ]\d)/g;
/** Все записи разделителя (×, ✕, *, а также отдельно стоящие «x»/«х») -> «×». */
const SEPARATOR_VARIANTS = /[×✕*]|(?<![a-zа-яё])[xх](?![a-zа-яё])/g;
/**
 * Подписи осей, склеенные буквой «x»/«х»: «ДхШхВ», «LxWxH», «ШхВхГ». Такая «х» стоит между
 * буквами, поэтому SEPARATOR_VARIANTS её не видит, а без замены подписи не распознаются и агент
 * получает отказ, после которого переписывает числа в порядке источника.
 */
const LABEL_LIST_WITH_X = /(?<![a-zа-яё])[дшвгwhdl](?:\s*[xх]\s*[дшвгwhdl])+(?![a-zа-яё])/g;
/** Ведущее слово без смысла для разбора: «Габариты 260×220×110», «Размеры упаковки: ...». */
const LEADING_WORD = /^\s*(?:габарит|размер)[а-яё]*(?:\s+упаковк[а-яё]*)?[\s:,-]*/;
/** Число с запятой и ровно тремя знаками после неё: «1,200» - тысяча или 1,2? */
const THREE_DECIMALS = /^\d+[.,]\d{3}$/;

/** Единица длины из текста шапки столбца; нет — null (вызывающий берёт мм и предупреждает). */
export function headerUnit(headerText: string): LengthUnit | null {
  const found = HEADER_UNIT.exec(headerText)?.[1];
  return found === undefined ? null : (UNIT_SPELLINGS[found.toLowerCase()] ?? null);
}

/** Результат перевода размера. */
export type SizeConversion =
  | { ok: true; value: string }
  | { ok: false; kind: SizeProblem['kind']; message: string };

/**
 * Структурный ввод с подписями осей: агент раскладывает измерения источника по смыслу, а код
 * собирает запись строго в порядке ширина×высота×глубина. `unlabeled` - числа без подписей,
 * порядок которых неизвестен: код не гадает и ничего не пишет, позиция уходит в предупреждение.
 */
export interface SizeParts {
  width?: string | number | undefined;
  height?: string | number | undefined;
  depth?: string | number | undefined;
  length?: string | number | undefined;
  unlabeled?: string | undefined;
}

const NUMBER_AT = /\d+(?:[.,]\d+)?/y;
const UNIT_AT = /(мм|см|дм|м|mm|cm|dm|m)(?![A-Za-zА-Яа-яЁё])\.?/y;
const SEPARATOR_AT = /[×-]/y;
const SPACES_AT = /\s*/y;

function matchAt(pattern: RegExp, text: string, position: number): RegExpExecArray | null {
  pattern.lastIndex = position;
  return pattern.exec(text);
}

/** Позиция после пробелов, начиная с `position`. */
function skipSpaces(text: string, position: number): number {
  return position + (matchAt(SPACES_AT, text, position)?.[0].length ?? 0);
}

function refuse(reason: string, target: LengthUnit): SizeConversion {
  return {
    ok: false,
    kind: 'unparsable',
    message:
      `Размер «ш×в×г» не разобран: ${reason}. Передай измерения в dimensions ` +
      `{width, height, depth}: в каждом поле число и единица («26 см»; единица шапки: ` +
      `${target}), либо в value с подписями осей и единицей («ш 26, в 22, г 11 см»). ` +
      'Порядок чисел источника не переставляй, подписи не отбрасывай: порядок по ним ' +
      'собирает код.',
  };
}

/**
 * Порядок измерений неясен (решение владельца 15): сотруднику вопросов не задаём, ячейка
 * остаётся пустой, позиция уходит в предупреждение итога, задача доводится до конца.
 */
function orderUnclear(reason: string): SizeConversion {
  return {
    ok: false,
    kind: 'order_unclear',
    message:
      `Размер Ш×В×Г определить нельзя: ${reason}. Сотруднику вопросов не задавай: ` +
      'ячейка размера остаётся пустой, позиция попадает в предупреждение «Размеры не удалось ' +
      'определить для: ...», задачу доводи до конца. Если порядок ясен из материала (подписи ' +
      'осей, шапка), передай измерения с подписями (dimensions: width, height, depth).',
  };
}

/** Число с запятой и тремя знаками рядом с «целыми» измерениями: тысячи или десятичная дробь. */
function separatorAmbiguity(dimensions: readonly RawDimension[]): string | null {
  const suspicious = dimensions.filter((item) => THREE_DECIMALS.test(item.text));
  if (suspicious.length === 0 || dimensions.length < SEVERAL_DIMENSIONS) return null;
  const others = dimensions.filter((item) => !THREE_DECIMALS.test(item.text));
  if (!others.every((item) => item.amount >= SEPARATOR_CHECK_FROM)) return null;
  return (
    `число «${suspicious[0]?.text ?? ''}»: запятая может отделять тысячи, а может быть ` +
    'десятичной дробью - запись неоднозначна. Передай «1200» (без запятой) либо «1,2»'
  );
}

/** Одно число без подписи: ширина это, высота или глубина - неизвестно (решение владельца 15). */
const SINGLE_UNLABELED =
  'одно число без подписи: неизвестно, ширина это, высота или глубина (передай его в ' +
  'dimensions.width, если это точно ширина)';

function fromProblem(found: SizeProblem, target: LengthUnit): SizeConversion {
  return found.kind === 'order_unclear'
    ? orderUnclear(found.reason)
    : refuse(found.reason, target);
}

/** Число в единице шапки: точность 0,1 мм, десятичная запятая. */
function formatInUnit(millimetres: number, target: LengthUnit): string {
  const inUnit = millimetres / MM_PER_UNIT[target];
  return String(Number(inUnit.toFixed(DECIMALS_BY_UNIT[target]))).replace('.', ',');
}

/** Привести запись к виду для разбора: нижний регистр, разряды, единый разделитель «×». */
function normalizeText(value: string | number): string {
  const raw = typeof value === 'number' ? String(value) : value.toLowerCase();
  return raw
    .replace(LEADING_WORD, '')
    .replace(LABEL_LIST_WITH_X, (list) => list.replace(/[xх]/g, SIZE_SEPARATOR))
    .replace(THOUSANDS, '$1$2')
    .replace(SEPARATOR_VARIANTS, SIZE_SEPARATOR)
    .replace(/[–—−]/g, HYPHEN)
    .trim();
}

type Plain = { ok: true; dimensions: RawDimension[] } | { ok: false; problem: SizeProblem };

/** Разбор записи без подписей осей: числа через «×»/дефис, единицы, правила разделителей. */
function parsePlain(text: string): Plain {
  const bad = (reason: string): Plain => ({ ok: false, problem: { kind: 'unparsable', reason } });
  if (text === '') return bad('значение пустое');
  const dimensions: RawDimension[] = [];
  const separators: string[] = [];
  let position = 0;
  for (;;) {
    const number = matchAt(NUMBER_AT, text, position);
    if (number === null) return bad('ожидалось число');
    position += number[0].length;
    position = skipSpaces(text, position);
    const unit = matchAt(UNIT_AT, text, position);
    if (unit !== null) position += unit[0].length;
    position = skipSpaces(text, position);
    dimensions.push({
      amount: Number(number[0].replace(',', '.')),
      text: number[0],
      unit: unit === null ? null : (UNIT_SPELLINGS[unit[1] ?? ''] ?? null),
      axis: null,
    });
    if (position >= text.length) break;
    const separatorMatch = matchAt(SEPARATOR_AT, text, position);
    if (separatorMatch === null) {
      // Следующее число без «×»: «260 220 110». Склеить в одно число нельзя, а читать как три
      // измерения - значит угадывать порядок и границы: размер не определён, ячейка пуста.
      if (matchAt(NUMBER_AT, text, position) !== null) {
        return {
          ok: false,
          problem: {
            kind: 'order_unclear',
            reason:
              'числа идут через пробел без разделителя «×»: неясно, это разряды одного ' +
              'числа или отдельные измерения и в каком порядке',
          },
        };
      }
      return bad('в значении есть лишний текст');
    }
    separators.push(separatorMatch[0]);
    position += 1;
    position = skipSpaces(text, position);
  }
  if (dimensions.length > SIZE_DIMENSIONS_MAX) return bad('больше трёх измерений');
  if (separators.length > 0 && new Set(separators).size > 1) {
    return bad('разные разделители в одном значении');
  }
  // «5-10 см» может быть диапазоном, а не размером: молча записать его как 50×100 нельзя.
  // Ровно три числа через дефис оставлены («ш-в-г» из шапки): диапазон из трёх чисел не бывает,
  // а отказ законной записи заставил бы сотрудника перепечатывать размер.
  // Решение владельца 15: вопросов не задаём, поэтому это не «unparsable» с просьбой
  // переспросить, а «размер не определён» - ячейка пуста, позиция уходит в предупреждение.
  if (separators[0] === HYPHEN && dimensions.length !== SIZE_DIMENSIONS_MAX) {
    return {
      ok: false,
      problem: {
        kind: 'order_unclear',
        reason: 'дефис между двумя числами может быть диапазоном, а не размером',
      },
    };
  }
  return { ok: true, dimensions };
}

/**
 * Общая часть: единицы, перевод в единицу шапки, порядок по подписям, запись.
 * Измерения приходят в порядке источника; при подписях запись собирается в порядке Ш×В×Г.
 */
function finish(dimensions: readonly RawDimension[], target: LengthUnit): SizeConversion {
  if (dimensions.length > SIZE_DIMENSIONS_MAX) return refuse('больше трёх измерений', target);
  const ambiguous = separatorAmbiguity(dimensions);
  if (ambiguous !== null) return refuse(ambiguous, target);
  if (dimensions.some((item) => !(item.amount > 0))) {
    return refuse('размер должен быть больше 0', target);
  }
  const unitless = dimensions.every((item) => item.unit === null);
  if (unitless && target !== DEFAULT_SIZE_UNIT) {
    return refuse(`в значении нет единицы измерения, а в шапке столбца ${target}`, target);
  }
  // Число без единицы берёт ближайшую единицу справа («10 × 2 дм × 5 см»); без единицы в конце -
  // отказ: единицу последнего числа угадать нельзя. Совсем без единиц - мм (проверено выше).
  const millimetres: number[] = [];
  let nextUnit: LengthUnit | null = unitless ? DEFAULT_SIZE_UNIT : null;
  for (const item of [...dimensions].reverse()) {
    nextUnit = item.unit ?? nextUnit;
    if (nextUnit === null) return refuse('у числа справа нет единицы измерения', target);
    const rounded = Math.round((item.amount * MM_PER_UNIT[nextUnit]) / SIZE_PRECISION_MM);
    if (rounded <= 0) {
      return refuse('после округления до 0,1 мм размер стал равен нулю', target);
    }
    millimetres.unshift(rounded * SIZE_PRECISION_MM);
  }
  let ordered = millimetres;
  if (dimensions.some((item) => item.axis !== null)) {
    const axes = dimensions.map((item, index) => ({
      axis: item.axis,
      value: millimetres[index] ?? 0,
    }));
    if (axes.some((item) => item.axis === null)) {
      return refuse('подписаны не все измерения: у каждого числа нужна подпись', target);
    }
    const placed = orderByAxes(
      axes.flatMap((item) => (item.axis === null ? [] : [{ axis: item.axis, value: item.value }])),
    );
    if (!placed.ok) return fromProblem(placed.problem, target);
    ordered = placed.ordered;
  }
  return { ok: true, value: ordered.map((mm) => formatInUnit(mm, target)).join(SIZE_SEPARATOR) };
}

/**
 * Перевести размер в единицу шапки и записать как `Ш×В×Г`.
 * Разделители `×`/`x`/`X`/`х`/`Х`/`*` (с пробелами или без, до трёх измерений) приводятся к «×»;
 * ровно три числа через дефис («10-20-30», как «ш-в-г» в шапке) тоже; два числа через дефис
 * («5-10») - возможный диапазон: размер не определён (`order_unclear`), ячейка пуста.
 * Подписи осей («ш 260 в 220 г 110», «260 (Ш) × 220 (В)», «Ш×В×Г 260×220×110», «ширина»,
 * «высота», «глубина», «длина») задают порядок по смыслу: запись собирается в порядке Ш×В×Г
 * независимо от порядка чисел в источнике; неоднозначная «длина» - `order_unclear`.
 * Подписи могут быть склеены буквой «х»/«x» («ДхШхВ», «LxWxH»), сокращены с точкой («шир.»,
 * «выс.», «гл.»), единица может стоять сразу после списка подписей («Ш×В×Г, мм: 260×220×110»).
 * Без подписей 2-3 числа через «×» записываются в том порядке, в каком переданы: порядок по
 * смыслу определил вызывающий (агент). Одно число без подписи и числа через пробел без «×»
 * («260 220 110») - `order_unclear`; сомневающийся агент передаёт числа через `unlabeled`.
 * Единица: у каждого числа или общая в конце; число без единицы берёт ближайшую единицу
 * справа. Совсем без единиц значение принимается только при шапке в мм (число считается в мм),
 * иначе отказ: единицу шапки угадывать нельзя. Число (не строка) трактуется так же.
 * Разряды разбираются только однозначные («1 200», одна цифра перед группой), запятая с тремя
 * знаками рядом с целыми измерениями («1,200×800») - отказ. Вывод: числа в единице шапки
 * через `SIZE_SEPARATOR`, точность 0,1 мм, десятичная запятая.
 */
export function convertSize(value: string | number, target: LengthUnit): SizeConversion {
  const text = normalizeText(value);
  const labelled = scanAxisLabels(text);
  if (labelled.status === 'problem') return fromProblem(labelled.problem, target);
  if (labelled.status === 'ok') return finish(labelled.dimensions, target);
  const plain = parsePlain(text);
  if (!plain.ok) return fromProblem(plain.problem, target);
  if (plain.dimensions.length === 1) return orderUnclear(SINGLE_UNLABELED);
  return finish(plain.dimensions, target);
}

const PART_AXES: ReadonlyArray<readonly [keyof SizeParts, SizeAxis]> = [
  ['width', 'width'],
  ['height', 'height'],
  ['depth', 'depth'],
  ['length', 'length'],
];

/**
 * Перевести измерения с подписями (поля `width`/`height`/`depth`/`length`) в запись `Ш×В×Г`.
 * `unlabeled` - порядок неизвестен всегда: `order_unclear`, ячейка пуста (что бы там ни лежало).
 * Единицы полей независимы: либо у каждого поля, либо ни у одного (тогда шапка обязана быть в мм).
 * Сочетать `unlabeled` с полями осей нельзя.
 */
export function convertSizeParts(parts: SizeParts, target: LengthUnit): SizeConversion {
  const given = PART_AXES.flatMap(([key, axis]) => {
    const raw = parts[key];
    return raw === undefined ? [] : [{ axis, raw }];
  });
  if (parts.unlabeled !== undefined) {
    if (given.length > 0) {
      return refuse('unlabeled нельзя сочетать с width/height/depth/length', target);
    }
    // Решение владельца 15: числа без подписей НИКОГДА не попадают в ячейку, сколько бы их ни
    // было (даже одно: ширина это или высота - неизвестно). Текст не разбираем: позиция всё равно
    // уходит в предупреждение, а разобранное «260 220» не должно ничего записать.
    return orderUnclear(
      'числа переданы без подписей, а какое из них ширина, высота и глубина неизвестно',
    );
  }
  if (given.length === 0) return refuse('не передано ни одного измерения', target);
  const dimensions: RawDimension[] = [];
  for (const { axis, raw } of given) {
    const scanned = scanSingleDimension(normalizeText(raw), axis);
    if (scanned.status === 'problem') return fromProblem(scanned.problem, target);
    dimensions.push(...(scanned.status === 'ok' ? scanned.dimensions : []));
  }
  // Поля независимы: единица одного не относится к другому («ближайшая справа» здесь значила бы
  // порядок полей в коде, а не смысл). Без единиц - только все вместе и только при шапке в мм.
  const withUnit = dimensions.filter((item) => item.unit !== null).length;
  if (withUnit > 0 && withUnit < dimensions.length) {
    return refuse('единица указана не у всех полей: укажи её у каждого («26 см»)', target);
  }
  return finish(dimensions, target);
}
