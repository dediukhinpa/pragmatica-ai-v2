/**
 * Подписи осей в значении столбца «Размер упаковки» (решение владельца 14): порядок измерений
 * берётся из подписей («ш», «в», «г», «ширина», «высота», «глубина», «длина», «шир.», «выс.»,
 * «Ш×В×Г», W/H/D), а не из порядка чисел. Чистые функции без ввода-вывода: разбор текста на
 * числа, единицы и подписи.
 */

/** Единица длины, которую понимаем в шапке и в значении. */
export type LengthUnit = 'мм' | 'см' | 'дм' | 'м';

/** Написания единиц (нижний регистр) -> единица. Латиница на случай «10 cm». */
export const UNIT_SPELLINGS: Readonly<Record<string, LengthUnit>> = {
  мм: 'мм',
  см: 'см',
  дм: 'дм',
  м: 'м',
  mm: 'мм',
  cm: 'см',
  dm: 'дм',
  m: 'м',
};

/** Ось размера. «Длина» отдельно: она может оказаться и шириной, и глубиной. */
export type SizeAxis = 'width' | 'height' | 'depth' | 'length';

/** Разделитель измерений в записи столбца: знак умножения U+00D7 (решение владельца 14). */
export const SIZE_SEPARATOR = '×';
/** Дефис между числами: возможный диапазон, размером не считается. */
export const HYPHEN = '-';

/** Измерение как оно разобрано из источника, в порядке источника. */
export interface RawDimension {
  amount: number;
  /** Число так, как оно записано в источнике («1,200»): нужно, чтобы заметить неясную запятую. */
  text: string;
  unit: LengthUnit | null;
  /** Ось по подписи; без подписи - null. */
  axis: SizeAxis | null;
}

/** Почему значение не принято: не разобрано либо порядок измерений неясен. */
export interface SizeProblem {
  kind: 'unparsable' | 'order_unclear';
  reason: string;
}

/** Результат разбора подписей: подписей нет (разбирает обычный путь), разобрано, проблема. */
export type AxisScan =
  | { status: 'none' }
  | { status: 'ok'; dimensions: RawDimension[] }
  | { status: 'problem'; problem: SizeProblem };

type Token =
  | { kind: 'number'; amount: number; text: string }
  | { kind: 'unit'; unit: LengthUnit }
  | { kind: 'label'; axis: SizeAxis }
  | { kind: 'sep'; char: string };

const NUMBER_AT = /\d+(?:[.,]\d+)?/y;
const UNIT_AT = /(мм|см|дм|м|mm|cm|dm|m)(?![A-Za-zА-Яа-яЁё])\.?/y;
/** Подписи словами, с любым окончанием: «высота», «высотой», «глубина». */
const WORD_LABEL_AT =
  /(длин|ширин|высот|глубин|толщин|length|width|height|depth|thickness)[а-яёa-z]*/y;
/**
 * Подпись буквой: «Д», «Ш», «В», «Г» и латинские L, W, H, D (после буквы - не буква, но цифра
 * можно: «Д30»). Латинская «d» отдельно от «dm»: единица разбирается раньше подписи.
 */
const LETTER_LABEL_AT = /[дшвгwhdl](?![a-zа-яё])/y;
/** Сокращения с точкой: «дл.», «шир.», «выс.», «гл.», «глуб.», «толщ.». */
const ABBREVIATION_LABEL_AT = /(дл|шир|выс|глуб|гл|толщ)\./y;
/** Год «2023 г»: буква «г» после него - не подпись глубины. */
const YEAR = /^(?:19|20)\d{2}$/;
const FILLER_AT = /[\s,;:=()[\]/.]+/y;
const SEPARATOR_AT = /[×-]/y;

const WORD_AXES: Readonly<Record<string, SizeAxis>> = {
  длин: 'length',
  ширин: 'width',
  высот: 'height',
  глубин: 'depth',
  толщин: 'depth',
  length: 'length',
  width: 'width',
  height: 'height',
  depth: 'depth',
  thickness: 'depth',
};
const ABBREVIATION_AXES: Readonly<Record<string, SizeAxis>> = {
  дл: 'length',
  шир: 'width',
  выс: 'height',
  глуб: 'depth',
  гл: 'depth',
  толщ: 'depth',
};
const LETTER_AXES: Readonly<Record<string, SizeAxis>> = {
  д: 'length',
  ш: 'width',
  в: 'height',
  г: 'depth',
  l: 'length',
  w: 'width',
  h: 'height',
  d: 'depth',
};

function matchAt(pattern: RegExp, text: string, position: number): RegExpExecArray | null {
  pattern.lastIndex = position;
  return pattern.exec(text);
}

/** Разбить текст на токены; null - есть лишнее (не число, единица, подпись и не разделитель). */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let position = 0;
  while (position < text.length) {
    const number = matchAt(NUMBER_AT, text, position);
    const unit = number === null ? matchAt(UNIT_AT, text, position) : null;
    const word = number === null && unit === null ? matchAt(WORD_LABEL_AT, text, position) : null;
    const abbreviation =
      number === null && unit === null && word === null
        ? matchAt(ABBREVIATION_LABEL_AT, text, position)
        : null;
    const letter =
      number === null && unit === null && word === null && abbreviation === null
        ? matchAt(LETTER_LABEL_AT, text, position)
        : null;
    const filler = matchAt(FILLER_AT, text, position);
    const separator = matchAt(SEPARATOR_AT, text, position);
    if (number !== null) {
      tokens.push({
        kind: 'number',
        amount: Number(number[0].replace(',', '.')),
        text: number[0],
      });
      position += number[0].length;
    } else if (unit !== null) {
      // Таблица единиц и регулярка согласованы; расхождение - ошибка кода, а не «мм» молча.
      const known = UNIT_SPELLINGS[unit[1] ?? ''];
      if (known === undefined) return null;
      tokens.push({ kind: 'unit', unit: known });
      position += unit[0].length;
    } else if (word !== null) {
      const axis = WORD_AXES[word[1] ?? ''];
      if (axis === undefined) return null;
      tokens.push({ kind: 'label', axis });
      position += word[0].length;
    } else if (abbreviation !== null) {
      const axis = ABBREVIATION_AXES[abbreviation[1] ?? ''];
      if (axis === undefined) return null;
      tokens.push({ kind: 'label', axis });
      position += abbreviation[0].length;
    } else if (letter !== null) {
      const axis = LETTER_AXES[letter[0]];
      const previous = tokens[tokens.length - 1];
      // «2023 г»: год - не подпись; текст уйдёт в обычный разбор и получит понятный отказ.
      if (axis === undefined || (previous?.kind === 'number' && YEAR.test(previous.text))) {
        return null;
      }
      tokens.push({ kind: 'label', axis });
      position += letter[0].length;
    } else if (separator !== null) {
      tokens.push({ kind: 'sep', char: separator[0] });
      position += 1;
    } else if (filler !== null) {
      position += filler[0].length;
    } else {
      return null;
    }
  }
  return tokens;
}

function problem(kind: SizeProblem['kind'], reason: string): AxisScan {
  return { status: 'problem', problem: { kind, reason } };
}

/**
 * Единицы привязываются к ближайшему числу слева. Единица ДО первого числа («Ш×В×Г, мм: 260×...»)
 * - общая для чисел без своей единицы. `null` - единица без числа и без общей роли невозможна.
 */
function bindUnits(tokens: readonly Token[], numbersCount: number): (LengthUnit | null)[] {
  const units: (LengthUnit | null)[] = Array.from({ length: numbersCount }, () => null);
  let current = -1;
  let shared: LengthUnit | null = null;
  for (const token of tokens) {
    if (token.kind === 'number') current += 1;
    else if (token.kind === 'unit') {
      if (current < 0) shared = token.unit;
      else units[current] = token.unit;
    }
  }
  return units.map((unit) => unit ?? shared);
}

/** Подписи списком («Ш×В×Г 260×220×110», «260×220×110 (Ш×В×Г)»): метки по порядку чисел. */
function scanList(tokens: readonly Token[]): AxisScan {
  const labels = tokens.filter((token) => token.kind === 'label');
  const numberIndexes = tokens.flatMap((token, index) => (token.kind === 'number' ? [index] : []));
  if (labels.length !== numberIndexes.length) {
    return problem(
      'unparsable',
      `подписей осей ${labels.length}, а чисел ${numberIndexes.length}: ` +
        'у каждого числа нужна своя подпись',
    );
  }
  const first = numberIndexes[0] ?? 0;
  const last = numberIndexes[numberIndexes.length - 1] ?? 0;
  const separators = new Set(
    tokens.slice(first, last + 1).flatMap((token) => (token.kind === 'sep' ? [token.char] : [])),
  );
  if (separators.size > 1) return problem('unparsable', 'разные разделители в одном значении');
  if (separators.has(HYPHEN) && numberIndexes.length !== 3) {
    return problem('order_unclear', 'дефис между двумя числами может быть диапазоном');
  }
  const units = bindUnits(tokens, numberIndexes.length);
  const axes = labels.flatMap((token) => (token.kind === 'label' ? [token.axis] : []));
  const dimensions = numberIndexes.map((tokenIndex, position): RawDimension => {
    const token = tokens[tokenIndex];
    return {
      amount: token?.kind === 'number' ? token.amount : 0,
      text: token?.kind === 'number' ? token.text : '',
      unit: units[position] ?? null,
      axis: axes[position] ?? null,
    };
  });
  return { status: 'ok', dimensions };
}

/**
 * Подписи рядом с числами: «ш 260, в 220, г 110 мм» (подпись перед числом) либо
 * «260 (Ш) × 220 (В)» (подпись после числа). Режим задаёт первый токен; шаблон строгий: подпись
 * и число идут парами, иначе неясно, чьё число.
 */
function scanPairs(tokens: readonly Token[]): AxisScan {
  const body = tokens.filter((token) => token.kind !== 'sep');
  const prefix = body[0]?.kind === 'label';
  const dimensions: RawDimension[] = [];
  let index = 0;
  const bad = (): AxisScan =>
    problem('unparsable', 'подписи осей расставлены неоднозначно: у каждого числа своя подпись');
  while (index < body.length) {
    const head = body[index];
    if (prefix) {
      const number = body[index + 1];
      if (head?.kind !== 'label' || number?.kind !== 'number') return bad();
      index += 2;
      const unit = body[index];
      let unitValue: LengthUnit | null = null;
      if (unit?.kind === 'unit') {
        unitValue = unit.unit;
        index += 1;
      }
      dimensions.push({
        amount: number.amount,
        text: number.text,
        unit: unitValue,
        axis: head.axis,
      });
    } else {
      if (head?.kind !== 'number') return bad();
      index += 1;
      let unitValue: LengthUnit | null = null;
      const unit = body[index];
      if (unit?.kind === 'unit') {
        unitValue = unit.unit;
        index += 1;
      }
      const label = body[index];
      if (label?.kind !== 'label') return bad();
      index += 1;
      dimensions.push({
        amount: head.amount,
        text: head.text,
        unit: unitValue,
        axis: label.axis,
      });
      // Единица после последней подписи («260 ш 220 в 110 г мм») - у последнего числа.
      const trailing = body[index];
      if (trailing?.kind === 'unit' && index === body.length - 1) {
        const lastDimension = dimensions[dimensions.length - 1];
        if (lastDimension !== undefined && lastDimension.unit === null) {
          lastDimension.unit = trailing.unit;
        }
        index += 1;
      }
    }
  }
  return { status: 'ok', dimensions };
}

/**
 * Разобрать текст с подписями осей. Текст уже в нижнем регистре, разделители приведены к «×».
 * Подписей нет или текст не разбирается токенами - `none` (дальше работает обычный разбор).
 */
export function scanAxisLabels(text: string): AxisScan {
  const tokens = tokenize(text);
  if (tokens === null || !tokens.some((token) => token.kind === 'label')) {
    return { status: 'none' };
  }
  const indexes = tokens.flatMap((token, index) => (token.kind === 'number' ? [index] : []));
  if (indexes.length === 0) return problem('unparsable', 'есть подписи осей, но нет чисел');
  const firstNumber = indexes[0] ?? 0;
  const lastNumber = indexes[indexes.length - 1] ?? 0;
  const labelIndexes = tokens.flatMap((token, index) => (token.kind === 'label' ? [index] : []));
  const listed =
    labelIndexes.every((index) => index < firstNumber) ||
    labelIndexes.every((index) => index > lastNumber);
  return listed ? scanList(tokens) : scanPairs(tokens);
}

/** Один размер с осью: поле `width`/`height`/`depth`/`length` структурного ввода. */
export function scanSingleDimension(text: string, axis: SizeAxis): AxisScan {
  const tokens = tokenize(text);
  const numbers = tokens?.filter((token) => token.kind === 'number') ?? [];
  const foreign = tokens?.some((token) => token.kind === 'label' || token.kind === 'sep') ?? true;
  const [number] = numbers;
  if (tokens === null || foreign || numbers.length !== 1 || number?.kind !== 'number') {
    return problem('unparsable', `в поле ${axis} должно быть одно число с единицей или без`);
  }
  const unit = tokens.find((token) => token.kind === 'unit');
  return {
    status: 'ok',
    dimensions: [
      {
        amount: number.amount,
        text: number.text,
        unit: unit?.kind === 'unit' ? unit.unit : null,
        axis,
      },
    ],
  };
}

/** Порядок шаблона: ширина, высота, глубина. */
const TEMPLATE_AXES: readonly SizeAxis[] = ['width', 'height', 'depth'];

/**
 * Расставить измерения строго в порядке Ш×В×Г. Допустимы префиксы порядка: Ш, Ш×В, Ш×В×Г.
 * «Длина» однозначна только в тройке «длина, высота, глубина» (она занимает свободное место
 * ширины); вместе с «шириной» или без глубины соответствие осей неясно.
 */
export function orderByAxes<T>(
  items: ReadonlyArray<{ axis: SizeAxis; value: T }>,
): { ok: true; ordered: T[] } | { ok: false; problem: SizeProblem } {
  const byAxis = new Map<SizeAxis, T>();
  for (const item of items) {
    if (byAxis.has(item.axis)) {
      return {
        ok: false,
        problem: { kind: 'unparsable', reason: `ось «${item.axis}» указана дважды` },
      };
    }
    byAxis.set(item.axis, item.value);
  }
  const length = byAxis.get('length');
  if (length !== undefined) {
    const height = byAxis.get('height');
    const depth = byAxis.get('depth');
    if (byAxis.size === 3 && height !== undefined && depth !== undefined) {
      return { ok: true, ordered: [length, height, depth] };
    }
    return {
      ok: false,
      problem: {
        kind: 'order_unclear',
        reason:
          '«длина» может быть и шириной, и глубиной упаковки: однозначно только в тройке ' +
          '«длина, высота, глубина»',
      },
    };
  }
  const ordered: T[] = [];
  for (const axis of TEMPLATE_AXES) {
    const value = byAxis.get(axis);
    if (value === undefined) break;
    ordered.push(value);
  }
  if (ordered.length === 0 || ordered.length !== byAxis.size) {
    return {
      ok: false,
      problem: {
        kind: 'unparsable',
        reason:
          'по подписям нельзя собрать Ш×В×Г: измерения должны идти от ширины без пропусков ' +
          '(ширина; ширина и высота; ширина, высота и глубина), недостающее не выдумывай',
      },
    };
  }
  return { ok: true, ordered };
}
