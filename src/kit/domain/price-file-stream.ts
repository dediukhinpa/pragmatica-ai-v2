import { maskFullPriceFileDates, type PriceFileDate } from './price-file-date';
import { priceItemKey } from './price-diff';
import type { PriceItem } from './models';

/**
 * «Поток» прайса: файлы одной папки с одним и тем же именем без даты (`Значки_05_05_2026.xlsx` и
 * `Значки_01.10.2026.xlsx`) - версии одного прайса. У поставщика может быть несколько потоков
 * (значки, медали), а версия внутри потока одна: новая заменяет старую.
 */
export interface PriceFileStream {
  /** Папка + имя без даты и расширения, в нормальной форме (регистр, «ё», разделители). */
  key: string;
  /** Дата версии из имени; null - в имени даты нет. */
  date: PriceFileDate | null;
}

/** Что делать с уже лежащими строками поставщика при записи файла `incoming`. */
export interface SourceReplacement {
  /** Файлы, чьи строки заменяются (тот же файл и более старые версии потока). */
  replaceFiles: string[];
  /**
   * Заменяются ВСЕ строки без файла (`source_file IS NULL`): у поставщика нет строк с файлом и
   * есть доказательство, что они из этого файла/потока. Без него строки заменяются построчно
   * (`matchedNullRowKeys`): только те, чья позиция есть во входящем наборе.
   */
  replaceNull: boolean;
  /** Более новая версия потока уже в базе: старая дата не должна её перетирать. */
  newerFile: string | null;
}

const PATH_SEPARATORS = /[\\/]+/u;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
/** Позиция даты для сравнения: год, месяц, день (без дня - конец месяца, как в актуальности). */
const MONTH_FACTOR = 100;
const YEAR_FACTOR = 10_000;
const LAST_DAY = 31;

/** Слово без регистра, «ё» и составных форм Юникода. */
function normalizeWords(text: string): string {
  return text.normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(NON_WORD, ' ').trim();
}

/** Поток и дата версии по пути файла (путь от корня диска). */
export function priceFileStream(path: string): PriceFileStream {
  const segments = path.split(PATH_SEPARATORS).filter((part) => part !== '');
  const name = segments.pop() ?? '';
  const { text, date } = maskFullPriceFileDates(name);
  return { key: `${normalizeWords(segments.join('/'))}/${normalizeWords(text)}`, date };
}

function dateOrder(date: PriceFileDate): number {
  return date.year * YEAR_FACTOR + date.month * MONTH_FACTOR + (date.day ?? LAST_DAY);
}

/**
 * Какие из лежащих в базе файлов поставщика заменяет запись `incoming`. Файлы других потоков
 * не трогаются. Дата в имени есть у обоих и у лежащего позже - он «новее» и блокирует запись;
 * без даты (у любого из двух) порядок неизвестен, и входящий файл заменяет лежащий: так
 * работал и прежний импорт. `existing` - значения `source_file` строк поставщика (null - без
 * файла); повторы допустимы. `history` - файлы, которые по истории импортов уже брались для
 * этого поставщика (пути от корня диска); не задана - истории нет. `sameFileProof` - sha256
 * входящего файла найден в `import_key` строк без файла.
 */
export function planSourceReplacement(
  existing: ReadonlyArray<string | null>,
  incoming: string,
  history?: readonly string[],
  sameFileProof = false,
): SourceReplacement {
  const wanted = priceFileStream(incoming);
  const files = new Set<string>();
  let hasNull = false;
  for (const file of existing) {
    if (file === null) hasNull = true;
    else files.add(file);
  }
  const replaceFiles: string[] = [];
  let newerFile: string | null = null;
  for (const file of files) {
    if (file === incoming) {
      replaceFiles.push(file);
      continue;
    }
    const mate = priceFileStream(file);
    if (mate.key !== wanted.key) continue;
    if (mate.date !== null && wanted.date !== null && dateOrder(mate.date) > dateOrder(wanted.date)) {
      newerFile ??= file;
    } else {
      replaceFiles.push(file);
    }
  }
  // Происхождение строк без файла по умолчанию неизвестно - их не трогаем (этап 123: импорт
  // «мешков» стёр строки «сумок» того же поставщика). Замена только при положительном
  // доказательстве, и только если у поставщика нет других файлов.
  const replaceNull =
    hasNull && files.size === 0 && nullRowsProvenIn(wanted, incoming, history, sameFileProof);
  return { replaceFiles, replaceNull, newerFile };
}

/**
 * Есть ли доказательство, что строки без файла из потока входящего файла: в истории поставщика
 * другая версия этого потока либо sha256 файла совпал. Сам входящий файл в
 * истории доказательством не служит: он записывается в историю и тогда, когда строки без файла
 * пришли из другой линии (Radicalchic: «платки» стёрты импортом «зонтов»).
 */
function nullRowsProvenIn(
  wanted: PriceFileStream,
  incoming: string,
  history: readonly string[] | undefined,
  sameFileProof: boolean,
): boolean {
  if (sameFileProof) return true;
  const mates = (history ?? []).filter((file) => file !== incoming);
  return mates.some((file) => priceFileStream(file).key === wanted.key);
}

/** Префикс `import_key` импорта файла: `price-import:<поставщик>:<sha256 файла>[:base:...]`. */
export function fileImportKeyPrefix(supplierId: string, fileHash: string): string {
  return `price-import:${supplierId}:${fileHash}`;
}

/**
 * Ключи позиций строк без файла, у которых во входящем наборе есть та же позиция (артикул,
 * иначе название). Такая строка - прежняя версия позиции входящего файла: заменяется новой.
 * Остальные строки без файла остаются как есть (происхождение неизвестно).
 */
export function matchedNullRowKeys(
  nullRows: ReadonlyArray<Pick<PriceItem, 'sku' | 'productName'>>,
  incoming: ReadonlyArray<Pick<PriceItem, 'sku' | 'productName'>>,
): Set<string> {
  const incomingKeys = new Set(incoming.map((item) => priceItemKey(item)));
  const matched = new Set<string>();
  for (const item of nullRows) {
    const key = priceItemKey(item);
    if (incomingKeys.has(key)) matched.add(key);
  }
  return matched;
}
