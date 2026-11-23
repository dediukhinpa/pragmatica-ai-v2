/** Страница документа, как её отрисовала вёрстка: номер с единицы и текст страницы. */
export interface RenderedPage {
  number: number;
  text: string;
}

/** Итог разметки текста номерами страниц. */
export interface PageAnnotation {
  text: string;
  pagesKnown: boolean;
  matchedBlocks: number;
  totalBlocks: number;
  pageCount: number;
}

/** Таблица как её отдаёт разбор: строки, в строках ячейки. */
type TableCells = readonly (readonly (readonly string[])[])[];

/** Блок короче этого числа значимых знаков (после нормализации) не ищется: слишком неоднозначен. */
const MIN_BLOCK_CHARS = 12;
/** Сколько первых знаков блока служит иглой поиска. */
const NEEDLE_CHARS = 40;
/** Доля найденных блоков, с которой номера страниц считаются надёжными. */
const MIN_MATCH_RATIO = 0.6;
/** Сколько страниц вперёд от текущей просматривается при поиске блока. */
const PAGE_LOOKAHEAD = 10;
/** Сколько первых строк таблицы просматривается в поисках содержательной строки. */
const TABLE_PROBE_ROWS = 3;
/** Сколько первых строк markdown-таблицы (с разделителем) определяют страницу таблицы. */
const TABLE_PROBE_LINES = 4;
/** После стольких содержательных блоков поиск бросается, если находится слишком мало. */
const EARLY_CHECK_BLOCKS = 200;
/** Доля найденных на ранней проверке, ниже которой поиск дальше бессмыслен. */
const EARLY_MIN_RATIO = 0.2;
/** Знак вертикальной черты: так начинается строка таблицы markdown. */
const PIPE = '|';
/** Мягкий перенос: в тексте страницы он разрывает слово и сопоставление ломает. */
const SOFT_HYPHEN = /­/g;
/** Всё, кроме букв и цифр: пунктуация, разделители таблицы, пробельные знаки. */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Текст для сопоставления: нижний регистр, «ё» как «е», без пунктуации и разделителей таблицы
 * (`|`, `---`), пробелы схлопнуты, края обрезаны.
 */
export function normalizeForPageMatch(text: string): string {
  return text
    .replace(SOFT_HYPHEN, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(NON_WORD, ' ')
    .trim();
}

/** Курсор поиска: страница (индекс в массиве) и смещение в её нормализованном тексте. */
class PageFinder {
  private readonly texts: readonly string[];
  private pageIndex = 0;
  private offset = 0;

  constructor(pages: readonly RenderedPage[]) {
    this.texts = pages.map((page) => normalizeForPageMatch(page.text));
  }

  /**
   * Индекс страницы, где встретилась игла, не раньше текущего положения курсора; `null`, если
   * её нет на текущей и ближайших страницах. Курсор не убывает: после находки он стоит сразу за
   * иглой. Игла может начинаться в конце страницы и продолжаться на следующей.
   */
  locate(needle: string): number | null {
    const last = Math.min(this.texts.length - 1, this.pageIndex + PAGE_LOOKAHEAD);
    for (let index = this.pageIndex; index <= last; index += 1) {
      const from = index === this.pageIndex ? this.offset : 0;
      const at = this.find(index, needle, from);
      if (at === -1) continue;
      this.pageIndex = index;
      this.offset = Math.min(at + needle.length, (this.texts[index] ?? '').length);
      return index;
    }
    return null;
  }

  /** Позиция иглы на странице `index` не раньше `from` (включая переход на следующую) или -1. */
  private find(index: number, needle: string, from: number): number {
    const text = this.texts[index] ?? '';
    const direct = text.indexOf(needle, from);
    if (direct !== -1) return direct;
    const following = this.texts[index + 1];
    if (following === undefined || following === '') return -1;
    // Переход через границу страницы: хвост этой страницы + начало следующей.
    const tailStart = Math.max(from, text.length - needle.length + 1);
    const tail = text.slice(tailStart);
    if (tail === '') return -1;
    const joined = `${tail} ${following.slice(0, needle.length - 1)}`;
    const at = joined.indexOf(needle);
    return at !== -1 && at < tail.length ? tailStart + at : -1;
  }
}

/** Игла из нормализованного текста блока или `null`, если блок слишком короткий. */
function needleOf(normalized: string): string | null {
  return normalized.length < MIN_BLOCK_CHARS ? null : normalized.slice(0, NEEDLE_CHARS);
}

/** Игла строки таблицы: непустые ячейки, нормализованные и склеенные. */
function rowNeedle(row: readonly string[]): string | null {
  return needleOf(normalizeForPageMatch(row.filter((cell) => cell.trim() !== '').join(' ')));
}

/**
 * Страница каждой таблицы по фактической раскладке документа (индекс - индекс таблицы).
 *
 * Берётся первая содержательная строка таблицы среди первых строк и ищется в текстах страниц
 * монотонно вперёд: таблицы в документе идут по порядку, повтор шапки на следующей странице
 * курсор назад не уводит. Таблица, начатая на одной странице и продолженная на следующей,
 * получает страницу начала. Не нашли надёжно (строка короткая, текста нет на страницах) -
 * `null`: номер не выдумывается.
 */
export function pageOfTables(
  tables: TableCells,
  pages: readonly RenderedPage[],
): Array<number | null> {
  const finder = new PageFinder(pages);
  return tables.map((table) => {
    if (pages.length === 0) return null;
    for (const row of table.slice(0, TABLE_PROBE_ROWS)) {
      const needle = rowNeedle(row);
      if (needle === null) continue;
      // Первая содержательная строка решает: её отсутствие на страницах - «не знаем».
      const index = finder.locate(needle);
      return index === null ? null : (pages[index]?.number ?? null);
    }
    return null;
  });
}

/** Строка markdown относится к таблице. */
function isTableLine(line: string): boolean {
  return line.startsWith(PIPE);
}

/** Текст markdown, в котором перед строками из `markers` вставлена строка `[стр. N]`. */
function insertMarkers(lines: readonly string[], markers: ReadonlyMap<number, number>): string {
  const out: string[] = [];
  lines.forEach((line, index) => {
    const page = markers.get(index);
    if (page !== undefined) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(`[стр. ${page}]`, '');
    }
    out.push(line);
  });
  return out.join('\n');
}

/**
 * Размечает markdown документа номерами страниц по тексту страниц, отрисованных вёрсткой.
 *
 * Каждый содержательный блок (абзац, пункт, строка таблицы; от {@link MIN_BLOCK_CHARS} значимых
 * знаков) ищется по началу в страницах монотонно вперёд: повтор типовых строк («Подписи
 * сторон») курсор назад не уводит. При смене страницы перед блоком вставляется отдельная строка
 * `[стр. N]`; таблица не разрывается: маркер ставится перед ней, по странице её начала.
 * Если найдено меньше {@link MIN_MATCH_RATIO} блоков или страниц нет, номера ненадёжны:
 * `pagesKnown=false` и текст возвращается без изменений.
 */
export function annotateTextWithPages(
  markdown: string,
  pages: readonly RenderedPage[],
): PageAnnotation {
  const lines = markdown.split('\n');
  const finder = new PageFinder(pages);
  const markers = new Map<number, number>();
  let searching = pages.length > 0;
  let totalBlocks = 0;
  let matchedBlocks = 0;
  let lastMarked = 0;
  let tableStart = -1;
  let tableDecided = false;

  lines.forEach((line, index) => {
    const inTable = isTableLine(line);
    if (inTable && !(index > 0 && isTableLine(lines[index - 1] ?? ''))) {
      tableStart = index;
      tableDecided = false;
    }
    const needle = needleOf(normalizeForPageMatch(line));
    if (needle === null) return;
    // Страницу таблицы решает её первая содержательная строка среди первых строк блока.
    const decides = inTable && !tableDecided && index - tableStart < TABLE_PROBE_LINES;
    if (inTable) tableDecided = true;
    totalBlocks += 1;
    if (searching && totalBlocks > EARLY_CHECK_BLOCKS) {
      searching = matchedBlocks / (totalBlocks - 1) >= EARLY_MIN_RATIO;
    }
    if (!searching) return;
    const found = finder.locate(needle);
    if (found === null) return;
    matchedBlocks += 1;
    const page = pages[found]?.number ?? 0;
    // В таблице маркер переносится перед таблицу и определяется только её началом.
    if ((!inTable || decides) && page > lastMarked) {
      markers.set(inTable ? tableStart : index, page);
      lastMarked = page;
    }
  });

  const known = totalBlocks > 0 && matchedBlocks / totalBlocks >= MIN_MATCH_RATIO;
  return {
    text: known ? insertMarkers(lines, markers) : markdown,
    pagesKnown: known,
    matchedBlocks,
    totalBlocks,
    pageCount: pages.length,
  };
}
