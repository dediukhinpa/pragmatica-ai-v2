import { MemoryDocumentParser, markdownToTables } from '@business-ai/adapters';
import type { MemoryChatChannel } from '@business-ai/adapters';
import type {
  DocumentParser,
  ParseOptions,
  ParsedDocument,
  WorkflowStateStore,
} from '@business-ai/core';
import { listProposals } from '../../src/agents/prices/price-proposals';
import type {
  EditedPriceFile,
  EditPricesRequest,
  PriceCellEdit,
  PriceFileEditor,
  SkippedPriceEdit,
} from '../../src/kit/ports/price-file-editor';
import { PRICE_EDIT_FOLLOWUP_NAMESPACE } from '../../src/price-edit-followup';
import { chatFileContainsCount } from './common';
import { chatFileCount } from '@business-ai/eval';
import { splitArg, type ProbeFn } from '@business-ai/eval';

/**
 * Заглушки режима «правка цены в файле сотрудника сразу» (этап 9p): презентация, парсер, который
 * берёт таблицы из её markdown, и редактор цен, который помнит правки и меняет ячейки в тексте.
 * Файл кейса (`chatFiles`) - markdown с заголовками «## Слайд N» и таблицами цен: так же выглядит
 * текст разбора настоящей презентации, по нему агент находит слайд.
 */

/** Сигнатура zip: приём файлов чата сверяет начало pptx с расширением. */
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b, 0x03, 0x04];
/** Расширение презентации. */
const DECK_EXTENSION = '.pptx';
/** Тип содержимого презентации. */
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Строка-разделитель таблицы markdown (то же правило, что у разбора таблиц платформы). */
const SEPARATOR_ROW = /^\|(\s*:?-+:?\s*\|)+\s*$/;
/** Допуск сверки старой цены с ячейкой (как у настоящего сервиса правки). */
const EXPECTED_TOLERANCE = 0.01;
/** Сколько записей состояния просматривает замер ожидания. */
const SCAN_LIMIT = 1000;
/** Число частей адреса ячейки в замерах правок: таблица, строка, столбец. */
const CELL_ADDRESS_PARTS = 3;

/** Презентация ли файл по имени. */
function isDeck(name: string): boolean {
  return name.toLowerCase().endsWith(DECK_EXTENSION);
}

/** Содержимое файла чата: pptx - с сигнатурой zip перед markdown, остальное - обычный текст. */
export function chatFileBytes(name: string, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!isDeck(name)) return body;
  const bytes = new Uint8Array(ZIP_SIGNATURE.length + body.length);
  bytes.set(ZIP_SIGNATURE);
  bytes.set(body, ZIP_SIGNATURE.length);
  return bytes;
}

/** Markdown презентации без сигнатуры. */
function deckText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(ZIP_SIGNATURE.length));
}

/**
 * Парсер презентаций-заглушек: таблицы берутся из markdown тем же разбором, что у настоящего
 * парсера, поэтому номера таблиц и строк совпадают с теми, что видит агент. Остальные форматы
 * читает обычная заглушка (txt, csv).
 */
export class DeckMarkdownParser implements DocumentParser {
  constructor(private readonly fallback: DocumentParser = new MemoryDocumentParser()) {}

  async parse(name: string, content: Uint8Array, options?: ParseOptions): Promise<ParsedDocument> {
    if (!isDeck(name)) return this.fallback.parse(name, content, options);
    const text = deckText(content);
    return {
      text,
      tables: markdownToTables(text),
      needsOcr: text.trim() === '',
      hasHiddenContent: false,
      hiddenSheets: [],
      truncated: false,
      warnings: [],
    };
  }
}

/** Ячейки строки markdown-таблицы без крайних вертикальных черт. */
function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Номера строк текста по таблицам (первой идёт шапка; разделитель пропущен). */
function tableRowLines(lines: readonly string[]): number[][] {
  const tables: number[][] = [];
  let at = 0;
  while (at < lines.length) {
    const next = lines[at + 1];
    if (!(lines[at] ?? '').startsWith('|') || next === undefined || !SEPARATOR_ROW.test(next)) {
      at += 1;
      continue;
    }
    const rows = [at];
    at += 2;
    while (at < lines.length && (lines[at] ?? '').startsWith('|')) {
      rows.push(at);
      at += 1;
    }
    tables.push(rows);
  }
  return tables;
}

/** Совпадает ли ожидаемая старая цена с ячейкой (число с допуском в копейку). */
function matchesExpected(expected: PriceCellEdit['expected'], cell: string): boolean {
  if (expected === undefined || expected === null) return true;
  const have = Number(cell.replace(/\s/gu, '').replace(',', '.'));
  const want = typeof expected === 'number' ? expected : Number(expected.replace(',', '.'));
  if (!Number.isFinite(have) || !Number.isFinite(want)) return false;
  return Math.abs(have - want) <= EXPECTED_TOLERANCE;
}

/**
 * Редактор цен презентаций-заглушек: запоминает каждую просьбу о правке (по ним кейс проверяет
 * таблицу, строку, столбец и старую цену) и меняет ячейки в markdown. Как настоящий сервис, не
 * пишет ячейку, если в ней сейчас не та цена, которую назвал вызывающий (`expected`).
 */
export class DeckPriceEditor implements PriceFileEditor {
  readonly requests: EditPricesRequest[] = [];

  async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    this.requests.push(request);
    const lines = deckText(request.bytes).split('\n');
    const tables = tableRowLines(lines);
    const skipped: SkippedPriceEdit[] = [];
    let changed = 0;
    for (const edit of request.edits) {
      const where = { table: edit.table ?? 0, row: edit.row, col: edit.col };
      const lineAt = tables[where.table]?.[edit.row];
      const cells = lineAt === undefined ? undefined : splitCells(lines[lineAt] ?? '');
      const cell = cells?.[edit.col];
      if (lineAt === undefined || cells === undefined || cell === undefined) {
        skipped.push({ ...where, reason: 'ячейка вне таблицы' });
      } else if (!matchesExpected(edit.expected, cell)) {
        skipped.push({ ...where, reason: 'mismatch' });
      } else {
        cells[edit.col] = String(edit.value);
        lines[lineAt] = `| ${cells.join(' | ')} |`;
        changed += 1;
      }
    }
    return {
      fileName: request.fileName,
      mimeType: PPTX_MIME,
      bytes: chatFileBytes(request.fileName, lines.join('\n')),
      changed,
      skipped,
    };
  }

  /** Все ячейки, которые просили изменить за прогон, по порядку вызовов. */
  allEdits(): PriceCellEdit[] {
    return this.requests.flatMap((request) => [...request.edits]);
  }
}

/** Адрес ячейки из аргумента замера `таблица:строка:столбец`. */
function cellAddress(name: string, arg: string | undefined): [number, number, number] {
  const parts = (arg ?? '').split(':').map(Number);
  if (parts.length !== CELL_ADDRESS_PARTS || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`замер «${name}» требует аргумент вида «таблица:строка:столбец»`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Последняя просьба о правке ячейки по адресу; null - ячейку не трогали. */
function lastEditAt(
  editor: DeckPriceEditor,
  name: string,
  arg: string | undefined,
): PriceCellEdit | null {
  const [table, row, col] = cellAddress(name, arg);
  const found = editor.allEdits().filter(
    (edit) => (edit.table ?? 0) === table && edit.row === row && edit.col === col,
  );
  return found[found.length - 1] ?? null;
}

/**
 * Имена замеров режима (к четырём замерам агента прайсов из манифеста): eval/index.ts добавляет
 * их в список проверок состояния, схема кейса сверяется с ним.
 */
export const PRICE_EDIT_PROBE_NAMES: readonly string[] = [
  'chatFiles',
  'chatFileContains',
  'editedCellCount',
  'editedValue',
  'editedExpected',
  'pendingPriceEdit',
  'proposedPrice',
];

/** Замеры режима: файлы в чате, правки редактора, ожидание ответа и предложение цен. */
export function priceEditProbes(
  chat: MemoryChatChannel,
  editor: DeckPriceEditor,
  state: WorkflowStateStore,
): Record<string, ProbeFn> {
  return {
    // Файлов, ушедших в чат (исправленный файл сотрудника).
    chatFiles: () => chatFileCount(chat),
    // Файлов в чате с подстрокой: что именно записано в ячейку и что осталось нетронутым.
    chatFileContains: (arg) => chatFileContainsCount(chat, arg ?? ''),
    // Сколько ячеек просили изменить у редактора за прогон.
    editedCellCount: () => editor.allEdits().length,
    // Новое значение ячейки `таблица:строка:столбец`; null - ячейку не правили.
    editedValue: (arg) => lastEditAt(editor, 'editedValue', arg)?.value ?? null,
    // Старая цена, с которой сверялась правка той же ячейки (expected у редактора).
    editedExpected: (arg) => {
      const expected = lastEditAt(editor, 'editedExpected', arg)?.expected;
      return typeof expected === 'number' ? expected : null;
    },
    // Открытые ожидания ответа сотрудника: 1 - после правки, 0 - закрыто или правки не было.
    pendingPriceEdit: async () =>
      (await state.list(PRICE_EDIT_FOLLOWUP_NAMESPACE, null, SCAN_LIMIT)).length,
    // Цена позиции в неподтверждённом предложении (`поставщик:название`); null - нет.
    proposedPrice: async (arg) => {
      const [supplierId, productName] = splitArg('proposedPrice', arg);
      const proposals = await listProposals(state, supplierId);
      for (const proposal of proposals) {
        const item = proposal.items.find((candidate) => candidate.productName === productName);
        if (item !== undefined) return item.price;
      }
      return null;
    },
  };
}
