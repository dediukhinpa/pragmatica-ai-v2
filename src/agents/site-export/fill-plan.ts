import type {
  TemplateCellEdit,
  TemplateCellValue,
  TemplateHeader,
  TemplateStructure,
} from '@business-ai/core';
import { SITE_DESCRIPTION_MAX_CHARS } from '../../kit/domain/site-export';
import {
  columnRole,
  isBlank,
  listHints,
  lookupColumn,
  matchListValue,
  textColumnKinds,
  type ColumnRole,
} from './template-columns';
import type { SizeParts } from './size-units';

/**
 * План записи в шаблон заказчика (этап 158): чистая функция, которая решает, какие ячейки
 * писать, а какие пропустить и почему. Правила владельца живут здесь, в коде, а не только в
 * промпте: модель не может обойти их аргументами, кроме явных флагов с цитатой просьбы.
 */

/** Последняя строка листа Excel. */
export const EXCEL_MAX_ROW = 1_048_576;
/** Предел длины текста в ячейке Excel. */
export const EXCEL_CELL_MAX_CHARS = 32_767;
/** Сколько текста текущего значения показываем в подсказке при отказе. */
const CURRENT_VALUE_MAX_CHARS = 60;

/** Причины пропуска ячейки. */
export const SKIP_REASONS = [
  'column_not_found',
  'column_ambiguous',
  'protected_area',
  'not_filled_by_rule',
  'set_by_code',
  'not_yellow_column',
  'other_sheet_needs_confirmation',
  'not_in_list',
  'list_not_readable',
  'empty_value',
  'value_too_long',
  'cell_not_empty',
  'cell_state_unknown',
  'duplicate_in_request',
  'row_required',
  'row_out_of_range',
  'already_written',
  'text_invariant_changed',
  'size_unparsable',
  'size_order_unclear',
] as const;

/** Одна ячейка запроса. */
export interface PlanCell {
  column: string;
  value: TemplateCellValue;
  /** Размер с подписями осей (решение владельца 14): код собирает Ш×В×Г вместо `value`. */
  dimensions?: SizeParts | undefined;
}

/** Одна позиция (строка) запроса. */
export interface PlanItem {
  row?: number | undefined;
  cells: readonly PlanCell[];
}

/** Явные решения человека, переданные инструментом. */
export interface PlanPermissions {
  /** Сотрудник явно просил и привёл цитату просьбы. */
  requested: boolean;
  /** Сотрудник подтвердил запись на листы 2-4 после предупреждения. */
  confirmed: boolean;
  /** Разрешена перезапись чужих непустых ячеек (только вместе с просьбой). */
  overwrite: boolean;
}

/** Содержимое листа: непустые ячейки по ссылкам. */
export interface SheetIndex {
  values: Map<string, string | number | boolean>;
  truncated: boolean;
  maxListedRow: number;
  lastRow: number;
}

/** Собрать индекс непустых ячеек из ответа сервиса. */
export function indexSheet(structure: TemplateStructure, includeHeaderRow: boolean): SheetIndex {
  const values = new Map<string, string | number | boolean>();
  let maxListedRow = 0;
  for (const row of [...structure.aboveRows, ...structure.exampleRows]) {
    maxListedRow = Math.max(maxListedRow, row.row);
    for (const cell of row.cells) {
      const shown = cell.value ?? (cell.formula ? '(формула)' : null);
      if (!isBlank(shown)) values.set(cell.ref, shown as string | number | boolean);
    }
  }
  // Строка шапки в списках строк не приходит: её ячейки известны по заголовкам.
  if (includeHeaderRow) {
    for (const header of structure.headers) {
      values.set(`${header.letter}${structure.headerRow}`, header.text);
    }
  }
  return {
    values,
    truncated: structure.examplesTruncated,
    maxListedRow,
    lastRow: structure.lastRow,
  };
}

/** Состояние ячейки перед записью. */
function cellState(
  index: SheetIndex,
  ref: string,
  row: number,
): { state: 'empty' } | { state: 'filled'; value: string } | { state: 'unknown' } {
  const value = index.values.get(ref);
  if (value !== undefined) return { state: 'filled', value: String(value) };
  // Список строк обрезан сервисом: за его пределами, но в пределах данных, ячейка неизвестна.
  if (index.truncated && row > index.maxListedRow && row <= index.lastRow) {
    return { state: 'unknown' };
  }
  return { state: 'empty' };
}

/** Пропущенная ячейка. */
export interface PlanSkip {
  itemIndex: number;
  row: number | null;
  column: string;
  reason: (typeof SKIP_REASONS)[number];
  message: string;
  /** Допустимые значения (not_in_list) или другие подсказки. */
  hint?: TemplateCellValue[] | undefined;
}

/** Правка с привязкой к позиции запроса. */
export interface PlannedEdit extends TemplateCellEdit {
  itemIndex: number;
  column: string;
  ref: string;
  /** Номер ячейки в позиции запроса; у значений, поставленных кодом (штампов), -1. */
  cellIndex: number;
  /** Это значение ставит код (менеджер, дата), а не модель. */
  stamped: boolean;
}

/** Данные для автоматических полей: менеджер и дата. */
export interface StampData {
  enabled: boolean;
  managerName: string | null;
  dateIso: string | null;
}

/** Результат планирования. */
export interface FillPlan {
  edits: PlannedEdit[];
  skips: PlanSkip[];
  /** Строка, выбранная для каждой позиции запроса (null - строки нет). */
  rows: Array<number | null>;
  /** Строки позиций (не штампов), в которые что-то будет записано. */
  touchedRows: number[];
  /** Какие автополя не удалось поставить и почему. */
  stampSkipped: Array<{ row: number; column: string; reason: string }>;
  overwritten: string[];
  /** Предупреждения плана: запись выполнена, но есть что проверить. */
  warnings: string[];
}

/** Решение подготовки (этап 225): ячейку не пишем, причина идёт агенту как обычный пропуск. */
export interface CellVerdict {
  reason: PlanSkip['reason'];
  message: string;
}

/** Ключ решения по ячейке запроса: номер позиции и номер ячейки в ней. */
export function cellVerdictKey(itemIndex: number, cellIndex: number): string {
  return `${itemIndex}:${cellIndex}`;
}

export interface PlanInput {
  sheet: string;
  isMainSheet: boolean;
  structure: TemplateStructure;
  index: SheetIndex;
  items: readonly PlanItem[];
  permissions: PlanPermissions;
  /** Ячейки, записанные самим агентом ранее (`лист!ссылка`). */
  written: ReadonlySet<string>;
  stamp: StampData;
  /** Отказы подготовки текстов и размеров (правка моделью, единица шапки), по `cellVerdictKey`. */
  verdicts?: ReadonlyMap<string, CellVerdict> | undefined;
  /**
   * Предел длины описания не проверять (проверит вызывающий после правки моделью, затем
   * повторит план без этого флага). По умолчанию описание длиннее предела отклоняется.
   */
  deferDescriptionLimit?: boolean | undefined;
}

function clip(text: string): string {
  if (text.length <= CURRENT_VALUE_MAX_CHARS) return text;
  return `${text.slice(0, CURRENT_VALUE_MAX_CHARS)}...`;
}

/** Нормализованный текст для сравнения названия и артикула. */
function norm(value: string | number | boolean | undefined): string {
  return value === undefined ? '' : String(value).trim().toLowerCase();
}

/**
 * Ранее записанная этим инструментом строка с тем же названием и артикулом (по `written`).
 * Зачем: повтор вызова без row не должен плодить дубли позиции.
 */
function findWrittenDuplicate(input: PlanInput, item: PlanItem): number | null {
  const { structure, index } = input;
  const nameLetter = structure.nameColumn;
  if (nameLetter === null) return null;
  const skuLetter = structure.skuColumn;
  let name = '';
  let sku = '';
  for (const cell of item.cells) {
    const resolved = resolveColumn(input, cell.column);
    if ('problem' in resolved) continue;
    if (resolved.column.letter === nameLetter) name = norm(cell.value);
    if (resolved.column.letter === skuLetter) sku = norm(cell.value);
  }
  if (name === '') return null;
  const prefix = `${input.sheet}!${nameLetter}`;
  for (const written of input.written) {
    if (!written.startsWith(prefix)) continue;
    const row = Number(written.slice(prefix.length));
    if (!Number.isInteger(row)) continue;
    if (norm(index.values.get(`${nameLetter}${row}`)) !== name) continue;
    if (skuLetter !== null && norm(index.values.get(`${skuLetter}${row}`)) !== sku) continue;
    return row;
  }
  return null;
}

/** Строки позиций и повторы ранее записанных позиций (позиция -> строка). */
interface AssignedRows {
  rows: Array<number | null>;
  duplicates: Map<number, number>;
}

/** Строки позиций назначаются с первой свободной, пропуская занятые название/артикул. */
function assignRows(input: PlanInput): AssignedRows {
  const { structure, index, items } = input;
  const keyLetters = [structure.nameColumn, structure.skuColumn].filter(
    (letter): letter is string => letter !== null,
  );
  const explicit = new Set(items.map((item) => item.row).filter((row) => row !== undefined));
  const occupied = (row: number): boolean =>
    explicit.has(row) ||
    keyLetters.some((letter) => cellState(index, `${letter}${row}`, row).state !== 'empty');
  const duplicates = new Map<number, number>();
  let cursor = structure.firstFreeRow;
  const rows = items.map((item, itemIndex) => {
    if (item.row !== undefined) return item.row;
    if (!input.isMainSheet) return null;
    const existing = findWrittenDuplicate(input, item);
    if (existing !== null) {
      duplicates.set(itemIndex, existing);
      return existing;
    }
    while (occupied(cursor)) cursor += 1;
    const row = cursor;
    cursor += 1;
    return row;
  });
  return { rows, duplicates };
}

interface Resolved {
  header: TemplateHeader | null;
  letter: string;
  role: ColumnRole;
}

/** Построить план записи. */
export function planFill(input: PlanInput): FillPlan {
  const { structure, index, permissions, stamp } = input;
  const { rows, duplicates } = assignRows(input);
  const edits: PlannedEdit[] = [];
  const skips: PlanSkip[] = [];
  const stampSkipped: FillPlan['stampSkipped'] = [];
  const overwritten: string[] = [];
  const warnings: string[] = [];
  const planned = new Set<string>();
  const touched = new Set<number>();
  const explicitStampColumns = new Map<number, Set<string>>();
  const mayOverride = permissions.requested;
  const headers = structure.headers;
  const textKinds = textColumnKinds(headers).kinds;

  const skip = (
    itemIndex: number,
    row: number | null,
    column: string,
    reason: PlanSkip['reason'],
    message: string,
    hint?: TemplateCellValue[],
  ): void => {
    const extra = hint === undefined ? {} : { hint };
    skips.push({ itemIndex, row, column, reason, message, ...extra });
  };

  /** Ячейка, перезапись которой разрешена: в `overwritten` она попадает, только если запишется. */
  let overwriteRef = null as string | null;

  /** Можно ли писать в ячейку: пустая, своя или перезапись с разрешением. */
  const checkTarget = (ref: string, row: number): 'ok' | 'filled' | 'unknown' | string => {
    overwriteRef = null;
    const state = cellState(index, ref, row);
    if (state.state === 'unknown') return 'unknown';
    if (state.state === 'empty') return 'ok';
    if (input.written.has(`${input.sheet}!${ref}`)) return 'ok';
    if (permissions.overwrite && mayOverride) {
      overwriteRef = ref;
      return 'ok';
    }
    return clip(state.value);
  };

  input.items.forEach((item, itemIndex) => {
    const row = rows[itemIndex] ?? null;
    const duplicateRow = duplicates.get(itemIndex);
    if (duplicateRow !== undefined) {
      skip(
        itemIndex,
        duplicateRow,
        item.cells[0]?.column ?? '',
        'already_written',
        `Позиция уже записана в строку ${duplicateRow}; для правки передай row.`,
      );
      return;
    }
    for (const [cellIndex, cell] of item.cells.entries()) {
      const name = cell.column;
      if (row === null) {
        skip(itemIndex, null, name, 'row_required', 'Для этого листа нужен номер строки row.');
        continue;
      }
      if (row < 1 || row > EXCEL_MAX_ROW) {
        skip(itemIndex, row, name, 'row_out_of_range', 'Строка вне допустимого диапазона.');
        continue;
      }
      const resolved = resolveColumn(input, name);
      if ('problem' in resolved) {
        skip(itemIndex, row, name, resolved.problem.reason, resolved.problem.message);
        continue;
      }
      const { header, letter, role } = resolved.column;
      const ref = `${letter}${row}`;
      const where = header === null ? letter : header.text;
      if (input.isMainSheet && row <= structure.headerRow) {
        const text = `Строки 1-${structure.headerRow} не меняются.`;
        skip(itemIndex, row, name, 'protected_area', text);
        continue;
      }
      if (input.isMainSheet && role === 'operator') {
        skip(itemIndex, row, name, 'protected_area', 'Колонка «Оператор» не меняется никогда.');
        continue;
      }
      if (!input.isMainSheet && !(mayOverride && permissions.confirmed)) {
        skip(
          itemIndex,
          row,
          name,
          'other_sheet_needs_confirmation',
          'Значения листов 2-4 пишутся только по явной просьбе сотрудника (requestedByEmployee ' +
            'с requestQuote) после предупреждения, что сайт может не принять файл, и его ' +
            'подтверждения (confirmedByEmployee). Предупреди сотрудника и дождись ответа.',
        );
        continue;
      }
      if (input.isMainSheet && role === 'first_load' && !mayOverride) {
        skip(
          itemIndex,
          row,
          name,
          'not_filled_by_rule',
          'Месяц первичной загрузки по решению владельца не заполняется; только по явной ' +
            'просьбе сотрудника (requestedByEmployee с requestQuote).',
        );
        continue;
      }
      if (input.isMainSheet && (role === 'manager' || role === 'last_correction')) {
        if (!mayOverride) {
          skip(
            itemIndex,
            row,
            name,
            'set_by_code',
            'Менеджера и дату корректировки ставит код (имя из каталога сотрудников, ' +
              'текущая дата). Своё значение - только по явной просьбе сотрудника.',
          );
          continue;
        }
        const set = explicitStampColumns.get(row) ?? new Set<string>();
        explicitStampColumns.set(row, set.add(letter));
      }
      if (input.isMainSheet && header !== null && !header.yellow && !mayOverride) {
        skip(
          itemIndex,
          row,
          name,
          'not_yellow_column',
          `Колонка «${header.text}» не жёлтая: по умолчанию заполняются только жёлтые. Нужна ` +
            'явная просьба сотрудника (requestedByEmployee=true и requestQuote с её цитатой).',
        );
        continue;
      }
      // Отказ подготовки (размер не разобран, порядок осей неясен) идёт раньше проверки на
      // пустоту: ячейка с `dimensions` не имеет `value`, но причину отказа агенту надо назвать.
      const verdict = input.verdicts?.get(cellVerdictKey(itemIndex, cellIndex));
      if (verdict !== undefined) {
        skip(itemIndex, row, name, verdict.reason, verdict.message);
        continue;
      }
      if (isBlank(cell.value)) {
        skip(itemIndex, row, name, 'empty_value', 'Пустое значение не пишется.');
        continue;
      }
      if (typeof cell.value === 'string' && cell.value.length > EXCEL_CELL_MAX_CHARS) {
        skip(itemIndex, row, name, 'value_too_long', 'Текст длиннее предела ячейки Excel.');
        continue;
      }
      let value: TemplateCellValue = cell.value;
      if (input.isMainSheet && header !== null && header.listUnresolved) {
        skip(
          itemIndex,
          row,
          name,
          'list_not_readable',
          `Список колонки «${header.text}» в файле не удалось прочитать: значение не записано, ` +
            'вынеси в предупреждения итога.',
        );
        continue;
      }
      if (input.isMainSheet && header !== null && header.allowedValues !== null) {
        const match = matchListValue(header.allowedValues, cell.value);
        if (match !== null) {
          value = match;
        } else if (permissions.requested) {
          // Значение назвал сам сотрудник: пишем как есть (не отказ из-за формата), а риск, что
          // сайт не примет значение вне списка, выносим в предупреждения.
          warnings.push(
            `Строка ${row}, «${header.text}»: «${String(cell.value)}» нет в списке файла, ` +
              'записано как назвал сотрудник; сайт может не принять.',
          );
        } else {
          skip(
            itemIndex,
            row,
            name,
            'not_in_list',
            `Значения нет в списке колонки «${header.text}»; ячейка оставлена пустой, ` +
              'вынеси в предупреждения итога.',
            listHints(header.allowedValues, cell.value),
          );
          continue;
        }
      }
      if (planned.has(ref)) {
        skip(itemIndex, row, name, 'duplicate_in_request', `Ячейка ${ref} уже есть в запросе.`);
        continue;
      }
      const target = checkTarget(ref, row);
      if (target === 'unknown') {
        skip(itemIndex, row, name, 'cell_state_unknown', `Состояние ячейки ${ref} не проверено.`);
        continue;
      }
      if (target !== 'ok') {
        skip(
          itemIndex,
          row,
          name,
          'cell_not_empty',
          `В ${ref} уже есть «${target}»: чужие значения не затираются. Перезапись - только по ` +
            'явной просьбе сотрудника (overwrite=true, requestedByEmployee, requestQuote).',
        );
        continue;
      }
      // Предел «Описания» держит код, а не промпт: длиннее не пишем никогда, без обрезки.
      // Проверка после защит и состояния ячейки: причина отказа - настоящая, а не длина.
      if (
        input.isMainSheet &&
        input.deferDescriptionLimit !== true &&
        header !== null &&
        typeof cell.value === 'string' &&
        textKinds.get(header.letter) === 'description' &&
        cell.value.length > SITE_DESCRIPTION_MAX_CHARS
      ) {
        skip(
          itemIndex,
          row,
          name,
          'value_too_long',
          `Описание ${cell.value.length} знаков, предел ${SITE_DESCRIPTION_MAX_CHARS}. Сократи ` +
            'текст своими словами (без обрезки на полуслове): числа, артикулы и единицы ' +
            'измерения не меняй, передай ту же позицию с row.',
        );
        continue;
      }
      if (overwriteRef !== null) overwritten.push(overwriteRef);
      planned.add(ref);
      edits.push({
        sheet: input.sheet,
        row,
        letter,
        value,
        itemIndex,
        column: where,
        ref,
        cellIndex,
        stamped: false,
      });
      if (input.isMainSheet) touched.add(row);
    }
  });

  if (input.isMainSheet && stamp.enabled) {
    for (const row of [...touched].sort((a, b) => a - b)) {
      const explicit = explicitStampColumns.get(row) ?? new Set<string>();
      const itemIndex = rows.indexOf(row);
      const stampCell = (role: ColumnRole, value: string | null, kind?: 'date'): void => {
        const header = headers.find((candidate) => columnRole(candidate) === role);
        if (header === undefined) {
          stampSkipped.push({ row, column: role, reason: 'column_not_found' });
          return;
        }
        if (explicit.has(header.letter)) return;
        if (value === null) {
          stampSkipped.push({ row, column: header.text, reason: 'value_unknown' });
          return;
        }
        const ref = `${header.letter}${row}`;
        // Автополя не затирают чужое даже при overwrite: только пустая ячейка или наша запись.
        const state = cellState(index, ref, row);
        const ours = input.written.has(`${input.sheet}!${ref}`);
        if (state.state === 'unknown' || (state.state === 'filled' && !ours)) {
          stampSkipped.push({ row, column: header.text, reason: 'cell_not_empty' });
          return;
        }
        edits.push({
          sheet: input.sheet,
          row,
          letter: header.letter,
          value: value as TemplateCellValue,
          ...(kind === undefined ? {} : { kind }),
          itemIndex: Math.max(itemIndex, 0),
          column: header.text,
          ref,
          cellIndex: -1,
          stamped: true,
        });
      };
      stampCell('manager', stamp.managerName);
      stampCell('last_correction', stamp.dateIso, 'date');
    }
  }
  // Явное значение менеджера/даты отклонено: не молчим, иначе автополе тоже не поставлено.
  if (input.isMainSheet) {
    const plannedRefs = new Set(edits.map((edit) => edit.ref));
    for (const [row, letters] of explicitStampColumns) {
      for (const letter of letters) {
        if (plannedRefs.has(`${letter}${row}`)) continue;
        const header = headers.find((candidate) => candidate.letter === letter);
        stampSkipped.push({
          row,
          column: header?.text ?? letter,
          reason: 'explicit_value_rejected',
        });
      }
    }
  }
  return {
    edits,
    skips,
    rows,
    touchedRows: [...touched].sort((a, b) => a - b),
    stampSkipped,
    overwritten,
    warnings,
  };
}

type ResolveResult =
  | { column: Resolved }
  | { problem: { reason: PlanSkip['reason']; message: string } };

/** Колонка по имени (главный лист) или по букве (листы 2-4). */
function resolveColumn(input: PlanInput, name: string): ResolveResult {
  if (!input.isMainSheet) {
    const letter = name.trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(letter)) {
      return {
        problem: {
          reason: 'column_not_found',
          message: 'На листах 2-4 колонка задаётся буквой (например, B).',
        },
      };
    }
    return { column: { header: null, letter, role: 'plain' } };
  }
  const found = lookupColumn(input.structure.headers, name);
  if (found.status === 'ok') {
    const header = found.header;
    return { column: { header, letter: header.letter, role: columnRole(header) } };
  }
  return {
    problem:
      found.status === 'ambiguous'
        ? {
            reason: 'column_ambiguous',
            message: `Название подходит к нескольким колонкам: ${found.candidates.join('; ')}.`,
          }
        : { reason: 'column_not_found', message: 'Колонки с таким названием в шапке нет.' },
  };
}
