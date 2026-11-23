/**
 * Единицы измерения: небольшой словарь синонимов. Нужен, чтобы «шт», «штука» и «pcs» считались
 * одной единицей, а «упак» и «шт» - разными. Цены между единицами не пересчитываются.
 */
const UNIT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  шт: ['шт', 'штука', 'штуки', 'штук', 'pcs', 'pc', 'piece', 'ед', 'единица'],
  т: ['т', 'тн', 'тонна', 'тонны', 'тонн', 'ton', 'tn'],
  кг: ['кг', 'килограмм', 'килограмма', 'килограммов', 'kg'],
  г: ['г', 'гр', 'грамм', 'граммов'],
  м: ['м', 'метр', 'метра', 'метров', 'пм', 'погм', 'погонныйметр', 'm'],
  м2: ['м2', 'м²', 'квм', 'кв м', 'квадратныйметр', 'm2'],
  м3: ['м3', 'м³', 'кубм', 'куб м', 'кубическийметр', 'm3'],
  л: ['л', 'литр', 'литра', 'литров', 'l'],
  упак: ['упак', 'уп', 'упаковка', 'упаковки', 'упаковок', 'pack'],
  компл: ['компл', 'комплект', 'комплекта', 'комплектов', 'set'],
  рул: ['рул', 'рулон', 'рулона', 'рулонов'],
  пач: ['пач', 'пачка', 'пачки', 'пачек'],
  кор: ['кор', 'коробка', 'коробки', 'коробок', 'box'],
  меш: ['меш', 'мешок', 'мешка', 'мешков'],
  лист: ['лист', 'листа', 'листов'],
  банка: ['банка', 'банку', 'банки', 'банок'],
  пара: ['пара', 'пары', 'пар'],
  бухта: ['бухта', 'бухты', 'бухт'],
};

const ALIAS_TO_UNIT: ReadonlyMap<string, string> = new Map(
  Object.entries(UNIT_ALIASES).flatMap(([unit, aliases]) =>
    aliases.map((alias): [string, string] => [alias, unit]),
  ),
);

/** Убрать точки, пробелы и дефисы: «п.м.», «пог. м», «кв-м» сводятся к одной записи. */
function squeeze(unit: string): string {
  return unit
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.\s\-_/]+/g, '');
}

/** Длина единицы в показе, выше которой остаток уходит в пометку к цене. */
const UNIT_TEXT_MAX_CHARS = 24;
/** Единицы меры: в показе приводятся к краткой форме («гр» -> «г»), остальные слова - как есть. */
const MEASURE_UNITS: ReadonlySet<string> = new Set(['шт', 'т', 'кг', 'г', 'м', 'м2', 'м3', 'л']);
/** Начало условий после единицы: скобка, запятая, «при заказе», «мин.», «от N». */
const UNIT_TAIL_START = /[([,;]|\s(?:при|мин|минимальн|от\s*\d)/iu;
const CURRENCY_PREFIX = /^(?:₽|руб\.?|rub)?\s*\/\s*/iu;
const LETTER_DIGIT_GLUE = /(\p{L})(\d)/gu;
const DIGIT_LETTER_GLUE = /(\d)(\p{L})/gu;
const NOTE_FRAME = /^[\s([,;:-]+|[\s)\],;:-]+$/gu;

/** Пробелы между числом и словом: «70гр» -> «70 гр», «банка70» -> «банка 70». */
function spaceDigits(text: string): string {
  return text.replace(LETTER_DIGIT_GLUE, '$1 $2').replace(DIGIT_LETTER_GLUE, '$1 $2');
}

/** Пометка из условий: склеенные слова и числа разделены, скобки и знаки по краям убраны. */
function cleanNote(tail: string): string {
  const spaced = spaceDigits(tail.replace(NOTE_FRAME, ''));
  const glued = spaced.replace(/(минимальный)(заказ)/giu, '$1 $2');
  return glued.replace(/\s+/g, ' ').trim();
}

/** Слово с известным значением единицы («кг», «банку», «гр»): после «за» вместо него идёт оно. */
function isKnownUnitWord(word: string): boolean {
  return ALIAS_TO_UNIT.has(squeeze(word));
}

/** Убрать ведущее «за» у «за кг», «за100г», «забанку70гр»; слова вроде «заготовка» не трогает. */
function stripLeadingZa(text: string): string {
  if (!text.startsWith('за')) return text;
  const rest = text.slice('за'.length);
  if (rest.startsWith(' ') || /^\d/.test(rest)) return rest.trim();
  const firstWord = spaceDigits(rest).split(' ')[0] ?? '';
  return isKnownUnitWord(firstWord) ? rest : text;
}

/** Слово единицы в показе: меры - краткой формой, остальные слова - как есть. */
function displayWord(word: string): string {
  const canonical = ALIAS_TO_UNIT.get(squeeze(word));
  return canonical !== undefined && MEASURE_UNITS.has(canonical) ? canonical : word;
}

/**
 * Единица цены для показа и условия отдельно. Из сырой строки сайта или модели («за100г»,
 * «забанку70гр», «закг(минимальныйзаказ32кг)», «руб/кг при заказе от 15 кг») убирает «за» в
 * начале и валюту, ставит пробелы между числом и единицей, а условия и слишком длинный хвост
 * выносит в `note` (их место - пометка к цене, а не единица). Ключ сравнения - `normalizeUnit`.
 */
export function splitUnitText(raw: string): { unit?: string; note?: string } {
  const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(CURRENCY_PREFIX, '');
  // «м2», «м3»: цифра - часть единицы, склеивать с ней пробелом нельзя.
  if (ALIAS_TO_UNIT.has(squeeze(text))) return { unit: displayWord(text.toLowerCase()) };
  const tailAt = text.search(UNIT_TAIL_START);
  const head = tailAt < 0 ? text : text.slice(0, tailAt);
  const tail = tailAt < 0 ? '' : cleanNote(text.slice(tailAt));
  const words = spaceDigits(stripLeadingZa(head.trim().toLowerCase()))
    .split(' ')
    .filter((word) => word !== '')
    .map(displayWord);
  const unit = words.join(' ');
  if (unit === '') return tail === '' ? {} : { note: tail };
  if (unit.length > UNIT_TEXT_MAX_CHARS) return { note: cleanNote(text) };
  return { unit, ...(tail === '' ? {} : { note: tail }) };
}

/** Винительный падеж первого слова: «банка 70 г» -> «банку 70 г» (после «за»). */
function accusative(unit: string): string {
  const [first = '', ...rest] = unit.split(' ');
  const word = first.length > 2 && first.endsWith('а') ? `${first.slice(0, -1)}у` : first;
  return [word, ...rest].join(' ');
}

/**
 * Единица в цене для человека: «/кг» для простой единицы, « за 100 г» и « за банку 70 г» для
 * фасовки. Принимает и сырую запись (в сохранённых шорт-листах единица могла быть склеена).
 */
export function unitSuffix(rawUnit: string | undefined): string {
  const unit = rawUnit === undefined ? undefined : splitUnitText(rawUnit).unit;
  if (unit === undefined) return '';
  return /^\d|\s/u.test(unit) ? ` за ${accusative(unit)}` : `/${unit}`;
}

/**
 * Ключ единицы для сравнения и группировки (не для показа): «кг», «килограмм», «за кг»
 * дают «кг»; «банка 70 г» и «за банку 70гр» - одну и ту же запись.
 */
export function normalizeUnit(unit: string): string {
  const whole = ALIAS_TO_UNIT.get(squeeze(unit));
  if (whole !== undefined) return whole;
  const shown = splitUnitText(unit).unit ?? unit;
  const parts = spaceDigits(shown.normalize('NFKC').toLowerCase().replace(/ё/g, 'е'))
    .split(/[\s.\-_/]+/)
    .filter((part) => part !== '')
    .map((part) => ALIAS_TO_UNIT.get(part) ?? part);
  // «банка 250 г» и «250 г» - одна фасовка: слово тары перед количеством с мерой не различает
  // цены (бой 29.10: два сайта с банкой 250 г попали в разные группы средней).
  const [first, amount, measure, ...rest] = parts;
  if (
    first !== undefined &&
    CONTAINER_UNITS.has(first) &&
    amount !== undefined &&
    /^\d+(?:[.,]\d+)?$/u.test(amount) &&
    measure !== undefined &&
    MEASURE_UNITS.has(measure) &&
    rest.length === 0
  ) {
    return `${amount}${measure}`;
  }
  return parts.join('');
}

/** Слова тары: перед количеством с мерой («банка 250 г», «упаковка 16 шт») не меняют фасовку. */
const CONTAINER_UNITS: ReadonlySet<string> = new Set(['банка', 'упак', 'пач', 'кор', 'меш']);

/** Число штук в фасовке «16 шт» / «упаковка 16 шт» (больше одной), иначе undefined. */
export function piecesInUnit(unit: string): number | undefined {
  const match = /^(\d+)шт$/u.exec(normalizeUnit(unit));
  const count = match === null ? Number.NaN : Number(match[1]);
  return Number.isInteger(count) && count > 1 ? count : undefined;
}

/** Совпадают ли единицы после нормализации. */
export function sameUnit(a: string, b: string): boolean {
  return normalizeUnit(a) === normalizeUnit(b);
}
