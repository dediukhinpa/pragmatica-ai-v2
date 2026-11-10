import type { Supplier } from '../../kit/domain/models';

/** Меньше стольких значимых знаков в «ядре» названия - по названию не ищем (только по адресу). */
export const SUPPLIER_NAME_MIN_CHARS = 4;
/** Сколько знаков добавляет окончание у названия из одного слова («Ромашка» -> «ромашками»). */
export const SUPPLIER_NAME_ENDING_MAX_CHARS = 3;
/** Запас слов сверх длины названия, в пределах которого должны найтись все слова названия. */
const NAME_WINDOW_EXTRA_WORDS = 2;

/**
 * Организационные формы: отбрасываются и в названии из базы, и в тексте письма. Только целые
 * слова после нормализации (кавычки и регистр уже сняты).
 */
const ORG_FORM_WORDS: ReadonlySet<string> = new Set([
  'ооо',
  'ип',
  'ао',
  'зао',
  'пао',
  'оао',
  'нко',
  'ано',
  'тоо',
  'чп',
  'гк',
  'llc',
  'ltd',
  'inc',
  'gmbh',
]);

/**
 * Слова, по которым название не ищется в тексте: сами по себе они не отличают поставщика
 * (общие слова торговых названий). Название из одних таких слов в поиск не попадает.
 */
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
  'торг',
  'опт',
  'снаб',
  'сбыт',
  'трейд',
  'групп',
  'группа',
  'компания',
  'комп',
  'фирма',
  'сервис',
  'центр',
  'холдинг',
  'база',
  'склад',
  'маркет',
  'проф',
  'трейдинг',
  'логистик',
  'логистика',
  'поставка',
  'поставки',
  'торговый',
  'дом',
  'мир',
  'плюс',
  'пром',
]);

/** Окончания падежей, допустимые у названия из одного слова (после основы без гласной). */
const NAME_ENDINGS: ReadonlySet<string> = new Set([
  '',
  'а',
  'я',
  'у',
  'ю',
  'е',
  'и',
  'ы',
  'о',
  'ой',
  'ей',
  'ом',
  'ем',
  'ам',
  'ям',
  'ах',
  'ях',
  'ами',
  'ями',
  'ов',
  'ев',
  'ью',
  'ь',
  'й',
]);

/** Последняя гласная или мягкий знак названия отбрасывается при сравнении основ. */
const TRAILING_VOWEL_RE = /[аяуюоеыиьй]$/;
/** Кириллица: склонение учитывается только у русских названий. */
const CYRILLIC_RE = /[а-я]/;
/** Всё, кроме букв и цифр, - разделитель слов (кавычки, скобки, дефисы, тире, знаки). */
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;

/** Слова текста в нижнем регистре, `ё` -> `е`, без разделителей и организационных форм. */
export function nameTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(NON_WORD_RE)
    .filter((word) => word !== '' && !ORG_FORM_WORDS.has(word));
}

/** Запись индекса: поставщик и слова его названия. */
interface NameEntry {
  supplier: Supplier;
  words: readonly string[];
}

/** Индекс названий поставщиков, строится один раз за запуск слота. */
export interface SupplierNameIndex {
  /** Поставщики, чьё название встречается в тексте (без повторов, порядок индекса). */
  find(text: string): readonly Supplier[];
  /** Сколько поставщиков попало в индекс (остальные ищутся только по адресу). */
  readonly size: number;
}

/** Основа названия из одного слова: без последней гласной у русских слов. */
function stemOf(word: string): string {
  return CYRILLIC_RE.test(word) && TRAILING_VOWEL_RE.test(word) ? word.slice(0, -1) : word;
}

/** Пригодно ли название для поиска по тексту (достаточно длинное и не общее). */
function isSearchable(words: readonly string[]): boolean {
  if (words.join('').length < SUPPLIER_NAME_MIN_CHARS) return false;
  return words.some((word) => !GENERIC_NAME_WORDS.has(word));
}

/** Все слова названия лежат в окне текста, порядок слов не важен. */
function hasAllWordsNear(words: readonly string[], text: readonly string[], at: number): boolean {
  const span = words.length + NAME_WINDOW_EXTRA_WORDS;
  const from = Math.max(0, at - span + 1);
  const window = text.slice(from, at + span);
  return words.every((word) => window.includes(word));
}

/**
 * Построить индекс названий. Название из одного слова ищется по основе с допустимым окончанием
 * (до `SUPPLIER_NAME_ENDING_MAX_CHARS` знаков), из нескольких слов - по точным словам в любом
 * порядке в пределах окна. Короткие и общие названия в индекс не входят.
 */
export function buildSupplierNameIndex(suppliers: readonly Supplier[]): SupplierNameIndex {
  const single = new Map<string, NameEntry[]>();
  const multi = new Map<string, NameEntry[]>();
  let size = 0;
  for (const supplier of suppliers) {
    const words = nameTokens(supplier.name);
    if (words.length === 0 || !isSearchable(words)) continue;
    const [first] = words;
    if (first === undefined) continue;
    size += 1;
    const entry: NameEntry = { supplier, words };
    const bucket = words.length === 1 ? single : multi;
    const key = words.length === 1 ? stemOf(first) : first;
    const list = bucket.get(key);
    if (list === undefined) bucket.set(key, [entry]);
    else list.push(entry);
  }
  return {
    size,
    find(text: string): readonly Supplier[] {
      const tokens = nameTokens(text);
      const found = new Map<string, Supplier>();
      tokens.forEach((token, at) => {
        for (const entry of multi.get(token) ?? []) {
          if (!hasAllWordsNear(entry.words, tokens, at)) continue;
          found.set(entry.supplier.id, entry.supplier);
        }
        // Слово текста может быть названием с окончанием: ищем основы, отрезая хвост.
        for (let cut = 0; cut <= SUPPLIER_NAME_ENDING_MAX_CHARS; cut += 1) {
          const stem = token.slice(0, token.length - cut);
          for (const entry of single.get(stem) ?? []) {
            const [word] = entry.words;
            if (word === undefined) continue;
            const ending = token.slice(stemOf(word).length);
            const exact = token === word;
            const declined = CYRILLIC_RE.test(word) && NAME_ENDINGS.has(ending);
            if (exact || declined) found.set(entry.supplier.id, entry.supplier);
          }
        }
      });
      return [...found.values()];
    },
  };
}
