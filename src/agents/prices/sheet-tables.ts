import type { ParsedDocument } from '@business-ai/core';

/**
 * Скрытые листы xlsx/xls и названия листов для таблиц (этап 116, тема C; этап 181).
 *
 * Сервис документов кладёт каждый лист в markdown блоком `## Лист: <имя>[ [hidden]]`, а
 * таблицы ядро потом достаёт из markdown без заголовков листов. Здесь по тому же markdown
 * восстанавливается, какой таблице какой лист принадлежит: у листов появляется название (оно
 * нужно, когда лист и есть товар). Решение владельца 03.11.2026: скрытые листы ЧИТАЮТСЯ, но с
 * предупреждением и пометкой «скрытый» в названии таблицы, чтобы сотрудник знал об этом.
 */

const SHEET_HEADING_PREFIX = '## Лист: ';
const SHEET_HEADING = /^## Лист: (.*?)( \[hidden\])?$/u;
const TABLE_SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/u;
const PIPE = 0x7c;

/** Лист в markdown: заголовок и диапазон тела (строки между заголовками). */
interface SheetBlock {
  name: string;
  hidden: boolean;
  /** Смещение начала строки заголовка. */
  headingAt: number;
  /** Смещение конца строки заголовка (позиция `\n` или конец текста). */
  headingEnd: number;
  /** Конец тела: начало следующего заголовка (или конец текста). */
  bodyEnd: number;
}

function lineEndOf(text: string, from: number): number {
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at;
}

/**
 * Число таблиц в теле листа `[from, to)`: так же, как их находит адаптер (строка `|...` и
 * разделитель). Без массива строк: прайс на 50 тыс. строк не раздувается в 50 тыс. срезов.
 */
function countTables(text: string, from: number, to: number): number {
  let count = 0;
  let at = from;
  while (at < to) {
    const end = Math.min(lineEndOf(text, at), to);
    if (text.charCodeAt(at) !== PIPE || end >= to) {
      at = end + 1;
      continue;
    }
    const nextEnd = Math.min(lineEndOf(text, end + 1), to);
    if (!TABLE_SEPARATOR.test(text.slice(end + 1, nextEnd))) {
      at = end + 1;
      continue;
    }
    count += 1;
    // Остаток блока строк таблицы пропускаем: следующая таблица начнётся после пустой строки.
    at = nextEnd + 1;
    while (at < to && text.charCodeAt(at) === PIPE) at = Math.min(lineEndOf(text, at), to) + 1;
  }
  return count;
}

/** Заголовки листов `## Лист: <имя>[ [hidden]]` и границы их тел; строки до первого не нужны. */
function splitSheets(text: string): SheetBlock[] {
  const blocks: SheetBlock[] = [];
  let at = text.indexOf(SHEET_HEADING_PREFIX);
  while (at !== -1 && at < text.length) {
    // Заголовок только в начале строки: первый поиск мог попасть в середину строки.
    const lineStart = at === 0 || text.charCodeAt(at - 1) === 0x0a;
    const end = lineEndOf(text, at);
    const match = lineStart ? SHEET_HEADING.exec(text.slice(at, end)) : null;
    if (match !== null) {
      const last = blocks.at(-1);
      if (last !== undefined) last.bodyEnd = at;
      blocks.push({
        name: match[1] ?? '',
        hidden: match[2] !== undefined,
        headingAt: at,
        headingEnd: end,
        bodyEnd: text.length,
      });
    }
    at = text.indexOf(`\n${SHEET_HEADING_PREFIX}`, at + 1);
    if (at !== -1) at += 1;
  }
  return blocks;
}

/** Пометка в названии таблицы и заголовке листа, который в файле скрыт. */
export const HIDDEN_SHEET_MARK = ' (скрытый лист)';

/** Предупреждение о прочитанных скрытых листах (читается и агентом, и человеком). */
export function hiddenSheetsReadWarning(names: readonly string[]): string {
  return `в файле есть скрытые листы, они прочитаны: ${names.join(', ')}. Проверьте, что это цены.`;
}

/** Предупреждение, когда скрытые листы нельзя пометить у таблиц (разметка не сошлась). */
export function hiddenSheetsUnmarkedWarning(names: readonly string[]): string {
  return (
    `в файле есть скрытые листы (${names.join(', ')}), но отделить их таблицы от видимых ` +
    'не удалось: проверьте, что в разбор не попали внутренние расчёты.'
  );
}

/**
 * Документ с названиями таблиц; скрытые листы остаются в разборе и помечаются в названии. Если
 * в markdown нет заголовков листов (csv, pdf, docx) - документ не меняется. Если число таблиц в
 * блоках не сходится с `tables`, названия не расставляются; есть скрытые листы - предупреждение.
 */
export function withSheetNames(parsed: ParsedDocument): ParsedDocument {
  const { text } = parsed;
  const blocks = splitSheets(text);
  if (blocks.length === 0) return parsed;
  const counts = blocks.map((block) => countTables(text, block.headingEnd + 1, block.bodyEnd));
  if (counts.reduce((sum, n) => sum + n, 0) !== parsed.tables.length) {
    return parsed.hiddenSheets.length === 0
      ? parsed
      : {
          ...parsed,
          warnings: [...parsed.warnings, hiddenSheetsUnmarkedWarning(parsed.hiddenSheets)],
        };
  }
  const tableNames: string[] = [];
  const hidden = blocks.filter((block) => block.hidden).map((block) => block.name);
  blocks.forEach((block, index) => {
    const name = block.hidden ? `${block.name}${HIDDEN_SHEET_MARK}` : block.name;
    for (let n = 0; n < (counts[index] ?? 0); n += 1) tableNames.push(name);
  });
  return {
    ...parsed,
    text: textWithNames(text, blocks),
    tableNames,
    warnings:
      hidden.length === 0 ? parsed.warnings : [...parsed.warnings, hiddenSheetsReadWarning(hidden)],
  };
}

/**
 * Текст без строк до первого листа, у скрытых листов в заголовке - пометка вместо `[hidden]`.
 * Без скрытых листов это срез исходного текста (копии 6 МБ markdown не делается).
 */
function textWithNames(text: string, blocks: readonly SheetBlock[]): string {
  const first = blocks[0]?.headingAt ?? 0;
  if (!blocks.some((block) => block.hidden)) return first === 0 ? text : text.slice(first);
  const parts: string[] = [];
  for (const block of blocks) {
    const name = block.hidden ? `${block.name}${HIDDEN_SHEET_MARK}` : block.name;
    parts.push(`${SHEET_HEADING_PREFIX}${name}`, text.slice(block.headingEnd, block.bodyEnd));
  }
  return parts.join('');
}

/** Предупреждение, если выбранная таблица взята со скрытого листа; иначе пусто. */
export function hiddenTableWarnings(parsed: ParsedDocument, tableIndex: number): string[] {
  const name = parsed.tableNames?.[tableIndex];
  if (name === undefined || !name.endsWith(HIDDEN_SHEET_MARK)) return [];
  return [
    `Таблица взята со скрытого листа «${name.slice(0, -HIDDEN_SHEET_MARK.length)}»: ` +
      'сообщите сотруднику, что лист скрыт.',
  ];
}
