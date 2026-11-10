/**
 * Сверка значений документа с текстом сообщений сотрудника. Происхождение значения решает код:
 * отметка источника в документе ставится моделью и доверия не заслуживает.
 */

/** Реквизиты, которые сравниваются по цифрам (пробелы и дефисы внутри значения не важны). */
const DIGIT_FIELDS: ReadonlySet<string> = new Set([
  'inn',
  'kpp',
  'ogrn',
  'bik',
  'settlementAccount',
  'correspondentAccount',
]);

/** Минимум значимых знаков значения для сверки: короткое совпадение случайно. */
const MIN_MATCH_CHARS = 5;

/** Разделитель групп цифр одного числа: один-два пробела или дефиса («7707 083893»). */
const GROUP_SEPARATOR = /^[ \-‐-―]{1,2}$/u;

/** Только цифры после удаления пробелов и дефисов. */
const DIGITS_ONLY = /^\d+$/u;

/**
 * Текст для хранения и сверки: NFKC, нижний регистр, «ё» = «е», пробелы схлопнуты. Цифры и
 * разделители между ними сохраняются: границы чисел проверяются при поиске.
 */
export function normalizeEmployeeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

/** Дописать сообщение к накопленному тексту треда; хвост до `maxChars` знаков самый свежий. */
export function appendEmployeeText(known: string, added: string, maxChars: number): string {
  const next = normalizeEmployeeText(added);
  // Повтор последнего сообщения (повтор хода) текст не раздувает.
  if (next === '' || known.endsWith(next)) return known;
  return [known, next].filter((part) => part !== '').join('\n').slice(-maxChars);
}

/** Без знаков препинания: слова через один пробел. */
function wordsOf(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Значение, которое сравнивается только по цифрам; иначе null. */
function digitsOf(field: string, value: string): string | null {
  if (!DIGIT_FIELDS.has(field)) return null;
  const compact = normalizeEmployeeText(value).replace(/[ \-‐-―]/gu, '');
  return DIGITS_ONLY.test(compact) ? compact : null;
}

/** Правая граница числа: дальше не пробел/дефис с цифрой и не точка/запятая с цифрой. */
function boundaryAfter(text: string, end: number): boolean {
  return !/^(?:[ \-‐-―]{1,2}\d|[.,]\d)/u.test(text.slice(end, end + 3));
}

/**
 * Число целиком есть в тексте: группы цифр, разделённые только пробелом или дефисом, дают
 * ровно искомое число, а границы совпадают с границами групп. Поэтому 10-значный ИНН не
 * находится внутри 20-значного счёта или длинного номера.
 */
function containsNumber(text: string, digits: string): boolean {
  const runs = [...text.matchAll(/\d+/gu)];
  for (let start = 0; start < runs.length; start += 1) {
    let acc = '';
    for (let index = start; index < runs.length; index += 1) {
      const run = runs[index];
      const previous = runs[index - 1];
      if (run === undefined) break;
      if (index > start && previous !== undefined) {
        const gap = text.slice(previous.index + previous[0].length, run.index);
        if (!GROUP_SEPARATOR.test(gap)) break;
      }
      acc += run[0];
      if (acc.length >= digits.length) {
        if (acc === digits && boundaryAfter(text, run.index + run[0].length)) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Значение поля встречается в нормализованном тексте сообщений сотрудника. Числовые реквизиты -
 * по цифрам с границами числа, остальные - по словам с границами слов.
 */
export function valueInEmployeeText(field: string, value: string, text: string): boolean {
  if (text === '' || value.trim() === '') return false;
  const digits = digitsOf(field, value);
  if (digits !== null) return digits.length >= MIN_MATCH_CHARS && containsNumber(text, digits);
  const needle = wordsOf(normalizeEmployeeText(value));
  if (needle.replace(/ /gu, '').length < MIN_MATCH_CHARS) return false;
  return ` ${wordsOf(text)} `.includes(` ${needle} `);
}

/** Каноническая форма значения поля: для сравнения написаний одного и того же значения. */
export function canonicalFieldValue(field: string, value: string): string {
  return digitsOf(field, value) ?? wordsOf(normalizeEmployeeText(value));
}
