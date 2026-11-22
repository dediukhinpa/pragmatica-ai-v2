import { z } from 'zod';
import {
  DomainError,
  chatThreadOf,
  defineTool,
  extensionOf,
  requirePort,
  stableHash,
} from '@business-ai/core';
import type { ParsedDocument } from '@business-ai/core';
import { isPriceFileTooLargeError, isUnsupportedPriceFormatError } from './kit/domain/errors.owned';
import type { PriceCellEdit } from './kit/ports/price-file-editor';
import { isPriceEditRefusedError } from './price-edit-refusal';
import type { PricesDeps } from './agents/prices/deps';
import { parseSource } from './agents/prices/parse-cache';
import {
  EMPTY_BYTES,
  CONVERTED_PPT_NOTE,
  REFUSAL_TEXTS,
  TOO_LARGE_MESSAGES,
  UNSUPPORTED_MESSAGE,
  editSource,
  refusedMessage,
  skippedFromService,
  sourceFileName,
  type EditedFile,
} from './agents/prices/price-edit-source';
import { openPriceSource } from './agents/prices/price-sources';
import { parsePriceCell } from './agents/prices/table-rows';
import {
  FOLLOWUP_CELL_MAX_CHARS,
  FOLLOWUP_CHANGES_MAX,
  FOLLOWUP_ROW_CELLS_MAX,
  followupExpiry,
  saveFollowup,
  type FollowupChange,
} from './price-edit-followup';
import { labelTables, type TableLabel } from './price-table-places';

/**
 * Правка цены в файле сотрудника СРАЗУ, без поставщика и без черновика импорта (этап 9p).
 * Старый путь (`editPricesInSourceFile`) привязан к импорту поставщика: ему нужны supplierId и
 * fileHash из `stagePriceRows`, поэтому агент сначала спрашивал поставщика. Здесь файл правится
 * по указанию сотрудника: место (слайд, страница, лист, строка) и старая цена с новой. Все
 * строгие проверки правки остаются прежними: старая цена уходит в сервис как `expected`
 * (в другой ячейке сервис не запишет), отказы pdf и пропуски приходят теми же причинами.
 */

/** Имя инструмента. */
export const PRICE_EDIT_DIRECT_TOOL = 'editPriceInFile';

/** Правок за один вызов не больше этого: это просьба сотрудника, а не массовая правка. */
export const DIRECT_EDITS_MAX = 50;
/** Сколько вариантов места перечисляем в вопросе об неоднозначной цене. */
export const VARIANTS_MAX = 10;
/** Сколько пропущенных ячеек перечисляем агенту (остальные только числом). */
const MAX_SKIPPED_LISTED = 50;
/** Допуск сравнения цен: разбор округляет цену до долей копейки. */
const PRICE_EPSILON = 1e-6;
/** Длина строки-подсказки о месте (ячейки строки через « | »). */
const ROW_PREVIEW_MAX_CHARS = 90;
/** Длина основы имени файла результата. */
const STEM_MAX_CHARS = 100;
/** Недопустимые в имени файла знаки. */
const FORBIDDEN_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/gu;
/** Длина ISO-даты (гггг-мм-дд). */
const ISO_DATE_LENGTH = 10;

const editSpecSchema = z.object({
  /** Цена, которая сейчас в файле (её называет сотрудник). */
  oldPrice: z.number().positive(),
  /** Новая цена. */
  newPrice: z.number().positive(),
  /** Номер слайда презентации (с 1), как «Слайд N» в тексте разбора. */
  slide: z.number().int().positive().optional(),
  /** Номер страницы (pdf, docx), как «Страница N» в тексте разбора. */
  page: z.number().int().positive().optional(),
  /** Название листа xlsx. */
  sheet: z.string().min(1).optional(),
  /** Номер таблицы из readPriceFile (с нуля). */
  table: z.number().int().nonnegative().optional(),
  /** Строка таблицы с нуля, как в readPriceFile (первая строка таблицы - 0). */
  row: z.number().int().nonnegative().optional(),
  /** Слова из строки: название позиции или артикул (регистр не важен). */
  rowText: z.string().min(1).optional(),
});
type EditSpec = z.infer<typeof editSpecSchema>;

const inputSchema = z.object({
  /** Идентификатор файла: path из сообщения сотрудника (чат), письма или диска. */
  path: z.string().min(1),
  edits: z.array(editSpecSchema).min(1).max(DIRECT_EDITS_MAX),
  /** Поставщик, ЕСЛИ он точно известен (найден в базе); иначе не передавай. */
  supplierId: z.string().min(1).optional(),
});
interface DirectInput {
  path: string;
  edits: EditSpec[];
  supplierId?: string | undefined;
}

const STATUSES = [
  'sent',
  'ambiguous',
  'not_found',
  'unsupported_format',
  'too_large',
  'nothing_changed',
] as const;

const changeOutputSchema = z.object({
  place: z.string().nullable(),
  header: z.string().optional(),
  row: z.string(),
  oldPrice: z.number(),
  newPrice: z.number(),
});
const variantSchema = z.object({
  place: z.string().nullable(),
  table: z.number().int(),
  row: z.number().int(),
  header: z.string().optional(),
  rowPreview: z.string(),
});
const skippedSchema = z.object({
  position: z.string(),
  row: z.number().int().optional(),
  reason: z.string(),
});
const outputSchema = z.object({
  status: z.enum(STATUSES),
  delivered: z.boolean(),
  fileName: z.string().optional(),
  /** Что изменено: место, строка, было и стало (только реально записанное). */
  changes: z.array(changeOutputSchema),
  /** Варианты места при status=ambiguous. */
  variants: z.array(variantSchema),
  skippedCount: z.number().int(),
  skipped: z.array(skippedSchema),
  /** Поставщик, если он определён кодом; null - не определён, спроси сотрудника. */
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
  message: z.string(),
});
type DirectOutput = z.infer<typeof outputSchema>;

/** Найденная ячейка цены. */
interface Candidate {
  table: number;
  row: number;
  col: number;
  label: TableLabel;
  /** Заголовок столбца (первая строка таблицы), если ячейка не в ней. */
  header?: string | undefined;
  rowCells: string[];
  rowPreview: string;
}

/** Нормализация текста для сравнения: регистр и пробелы не важны. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Ячейки строки без пустых: подсказка о месте и узнавание позиции. */
function cellsOf(row: readonly string[]): string[] {
  return row.map((cell) => cell.trim()).filter((cell) => cell !== '');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Совпадает ли ячейка с ценой: обычная цена без «от»/диапазона/тиража. */
function isPlainPrice(raw: string, price: number): boolean {
  const cell = parsePriceCell(raw);
  return (
    cell.kind === 'ok' &&
    cell.qualifier === undefined &&
    cell.minQuantity === undefined &&
    Math.abs(cell.value - price) < PRICE_EPSILON
  );
}

/** Подходит ли таблица под указание места (слайд, страница, лист, номер таблицы). */
function tableMatches(spec: EditSpec, index: number, label: TableLabel): boolean {
  if (spec.table !== undefined && spec.table !== index) return false;
  if (spec.slide !== undefined && !(label.kind === 'slide' && label.number === spec.slide)) {
    return false;
  }
  if (spec.page !== undefined && !(label.kind === 'page' && label.number === spec.page)) {
    return false;
  }
  if (spec.sheet !== undefined) {
    const wanted = normalize(spec.sheet);
    if (!(label.kind === 'sheet' && normalize(label.name ?? '') === wanted)) return false;
  }
  return true;
}

/** Все ячейки файла, где стоит `oldPrice` и которые подходят под указание сотрудника. */
function findCandidates(
  parsed: ParsedDocument,
  labels: readonly TableLabel[],
  spec: EditSpec,
): Candidate[] {
  const found: Candidate[] = [];
  const wantedText = spec.rowText === undefined ? null : normalize(spec.rowText);
  parsed.tables.forEach((table, index) => {
    const label = labels[index] ?? NO_LABEL;
    if (!tableMatches(spec, index, label)) return;
    table.forEach((row, rowIndex) => {
      if (spec.row !== undefined && spec.row !== rowIndex) return;
      // Первая строка таблицы - шапка: её числа (годы, номера) ценами не считаем, если сотрудник
      // не назвал строку 0 сам или в таблице одна строка.
      if (rowIndex === 0 && spec.row === undefined && table.length > 1) return;
      if (wantedText !== null && !normalize(row.join(' ')).includes(wantedText)) return;
      row.forEach((raw, col) => {
        if (!isPlainPrice(raw, spec.oldPrice)) return;
        const header = rowIndex > 0 ? table[0]?.[col]?.trim() : undefined;
        const cells = cellsOf(row);
        found.push({
          table: index,
          row: rowIndex,
          col,
          label,
          ...(header === undefined || header === '' ? {} : { header }),
          rowCells: cells
            .slice(0, FOLLOWUP_ROW_CELLS_MAX)
            .map((cell) => clip(cell, FOLLOWUP_CELL_MAX_CHARS)),
          rowPreview: clip(cells.join(' | '), ROW_PREVIEW_MAX_CHARS),
        });
      });
    });
  });
  return found;
}

/** Метка таблицы, когда место не определено. */
const NO_LABEL: TableLabel = { kind: null, text: null };

/** Описание указания сотрудника для сообщений («цена 680», «слайд 11»). */
function describeSpec(spec: EditSpec): string {
  const parts = [`цена ${spec.oldPrice}`];
  if (spec.slide !== undefined) parts.push(`слайд ${spec.slide}`);
  if (spec.page !== undefined) parts.push(`страница ${spec.page}`);
  if (spec.sheet !== undefined) parts.push(`лист «${spec.sheet}»`);
  if (spec.table !== undefined) parts.push(`таблица ${spec.table}`);
  if (spec.row !== undefined) parts.push(`строка ${spec.row}`);
  if (spec.rowText !== undefined) parts.push(`«${spec.rowText}»`);
  return parts.join(', ');
}

function variantsOf(found: readonly Candidate[]): DirectOutput['variants'] {
  return found.slice(0, VARIANTS_MAX).map((item) => ({
    place: item.label.text,
    table: item.table,
    row: item.row,
    ...(item.header === undefined ? {} : { header: item.header }),
    rowPreview: item.rowPreview,
  }));
}

/** Пустой итог: ничего не отправлено, изменений и вариантов нет. */
function emptyResult(): Pick<
  DirectOutput,
  'delivered' | 'changes' | 'variants' | 'skippedCount' | 'skipped'
> {
  return { delivered: false, changes: [], variants: [], skippedCount: 0, skipped: [] };
}

/** Дата для имени файла: дд.мм.гггг из ISO. */
function russianDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day ?? ''}.${month ?? ''}.${year ?? ''}`;
}

/** Основа имени исходного файла: без каталога, расширения и недопустимых знаков. */
function stemOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(FORBIDDEN_FILE_NAME_CHARS, '_').trim();
  return clip(stem === '' ? 'файл' : stem, STEM_MAX_CHARS);
}

/** Имя результата без поставщика: от имени исходного файла, расширение прежнее. */
export function resultNameFromSource(name: string, isoDate: string, extension: string): string {
  return `${stemOf(name)}_новые_цены_${russianDay(isoDate)}${extension}`;
}

/** Ключ идемпотентности: тот же файл и те же правки не отправляют файл второй раз. */
function directKey(input: DirectInput): string {
  return `prices-edit-file:${stableHash([input.path, input.edits, input.supplierId ?? null])}`;
}

/** Расширение файла с точкой; пусто, если его нет. */
function dottedExtension(name: string): string {
  const extension = extensionOf(name);
  return extension === '' || extension.startsWith('.') ? extension : `.${extension}`;
}

const NO_NUMBERS_MESSAGE =
  'Номера страниц в этом файле определить не удалось (раскладка недоступна): не придумывай ' +
  'номер. Попроси сотрудника назвать позицию или артикул из строки и повтори с rowText.';

/**
 * Изменить цену прямо в файле сотрудника и сразу отправить файл, не спрашивая поставщика.
 * Исходный файл не меняется: сервис правит копию.
 */
export const editPriceInFile = defineTool<DirectInput, DirectOutput, PricesDeps>({
  name: PRICE_EDIT_DIRECT_TOOL,
  readsFile: true,
  sideEffect: true,
  description:
    'Изменить цену в файле, который прислал сотрудник (pptx, pdf с текстовым слоем, xlsx, csv, ' +
    'docx с таблицей, старый ppt), СРАЗУ и отправить исправленный файл в этот чат. Поставщик и ' +
    'импорт не нужны: не спрашивай поставщика до правки. Передай path файла и edits: ' +
    'oldPrice (цена в файле сейчас) и newPrice, а место - как назвал сотрудник: slide (слайд ' +
    'N), page (страница N), sheet (лист), table и row (как в readPriceFile, с нуля) и/или ' +
    'rowText (название позиции, артикул). Если oldPrice встречается в файле несколько раз и ' +
    'указание места не различает их, файл НЕ правится: status=ambiguous, варианты в variants - ' +
    'задай сотруднику ОДИН короткий вопрос с вариантами (слайд/строка) и повтори вызов с ' +
    'уточнением. status=not_found - такой цены на этом месте нет, ничего не придумывай. ' +
    'После status=sent в ТОМ ЖЕ ответе: перечисли изменения из changes (было → стало, место); ' +
    'если supplier=null - спроси «это поставщик X?» или «как называется поставщик?»; спроси ' +
    '«обновить цены этих позиций в базе?». В базу ничего не пиши без явного «да» сотрудника ' +
    '(потом getPendingPriceEdit и прежний путь recordEmployeePriceUpdates). Те же строгие ' +
    'проверки, что у editPricesInSourceFile: pdf при любом сомнении не отправляется (' +
    'status=unsupported_format, причины в message), pptx - цены в таблицах слайдов, старый ppt ' +
    'уходит как pptx. Сообщай сотруднику message и числа из ответа дословно. supplierId ' +
    'передавай только если поставщик точно найден в базе.',
  inputSchema,
  outputSchema,
  idempotencyKey: directKey,
  async execute(input, deps, context) {
    const editor = requirePort(deps.priceFileEditor, 'правка цен в файле');
    const source = await openPriceSource(deps, input.path, context);
    const parsed = await parseSource(deps.parser, source, deps.turnScope);
    const supplierId = input.supplierId ?? source.senderSupplierId;
    const supplierRecord =
      supplierId === undefined ? undefined : await deps.suppliers.get(supplierId);
    const supplier =
      supplierId === undefined || supplierRecord === undefined || supplierRecord === null
        ? null
        : { id: supplierId, name: supplierRecord.name };
    const none = { ...emptyResult(), supplier };
    if (parsed.needsOcr) {
      return {
        ...none,
        status: 'unsupported_format' as const,
        message: UNSUPPORTED_MESSAGE,
      };
    }
    const labels = await labelTables(deps, source, parsed);
    const planned: Candidate[] = [];
    const specs: EditSpec[] = [];
    const taken = new Set<string>();
    for (const spec of input.edits) {
      if (spec.oldPrice === spec.newPrice) {
        throw new DomainError('invalid_input', 'Новая цена равна старой: править нечего.');
      }
      const found = findCandidates(parsed, labels, spec);
      if (found.length === 0) {
        const noPageNumbers =
          spec.page !== undefined && !labels.some((label) => label.kind === 'page');
        return {
          ...none,
          status: 'not_found' as const,
          message: noPageNumbers
            ? NO_NUMBERS_MESSAGE
            : `В файле не найдена ${describeSpec(spec)}. Файл не изменён и не отправлен. Не ` +
              'угадывай: скажи сотруднику, что такой цены на этом месте нет, и спроси, где ' +
              'искать (слайд, страница, строка). Ячейки первой строки таблицы ищутся, только ' +
              'если передать row=0.',
        };
      }
      if (found.length > 1) {
        return {
          ...none,
          status: 'ambiguous' as const,
          variants: variantsOf(found),
          message:
            `Цена ${spec.oldPrice} встречается в файле несколько раз (${found.length}), ` +
            'указание сотрудника не различает места. Файл не изменён и не отправлен. Задай ' +
            'ОДИН короткий вопрос с вариантами из variants (слайд или страница и строка), без ' +
            'других вопросов. После ответа вызови инструмент снова с slide/page/sheet и ' +
            'row или rowText.',
        };
      }
      const [only] = found;
      if (only === undefined) continue;
      const cellKey = `${only.table}:${only.row}:${only.col}`;
      if (taken.has(cellKey)) {
        throw new DomainError('invalid_input', 'Две правки указывают на одну и ту же ячейку.');
      }
      taken.add(cellKey);
      planned.push(only);
      specs.push(spec);
    }
    const edits: PriceCellEdit[] = planned.map((item, index) => ({
      ...(item.label.kind === 'sheet' && item.label.name !== undefined
        ? { sheet: item.label.name }
        : {}),
      table: item.table,
      row: item.row,
      col: item.col,
      value: specs[index]?.newPrice ?? 0,
      // Старая цена из файла: сервис не запишет, если в ячейке сейчас другое значение
      expected: specs[index]?.oldPrice ?? 0,
    }));
    const keyAt = new Map<string, string>();
    for (const item of planned) {
      const place = item.label.text === null ? '' : `${item.label.text}, `;
      keyAt.set(`${item.table}:${item.row}`, `${place}строка «${item.rowPreview}»`);
    }
    const day = deps.clock.now().toISOString().slice(0, ISO_DATE_LENGTH);
    let edited: EditedFile;
    try {
      edited = await editSource(editor, source, source.name, edits);
    } catch (error) {
      if (isPriceFileTooLargeError(error)) {
        return {
          ...none,
          status: 'too_large' as const,
          message: TOO_LARGE_MESSAGES[error.reason],
        };
      }
      if (isPriceEditRefusedError(error)) {
        const skipped = error.reasons.map((reason) => ({
          position:
            reason.row === undefined
              ? 'файл'
              : (keyAt.get(`${reason.table ?? ''}:${reason.row}`) ?? `строка ${reason.row}`),
          ...(reason.row === undefined ? {} : { row: reason.row }),
          reason: REFUSAL_TEXTS[reason.code] ?? reason.code,
        }));
        return {
          ...none,
          status: 'unsupported_format' as const,
          skippedCount: skipped.length,
          skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
          message: refusedMessage(error.reasons, keyAt),
        };
      }
      if (!isUnsupportedPriceFormatError(error)) throw error;
      return { ...none, status: 'unsupported_format' as const, message: UNSUPPORTED_MESSAGE };
    }
    try {
      const skipped = edited.skipped.map((item) => skippedFromService(item, keyAt));
      const summary = {
        skippedCount: skipped.length,
        skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
      };
      if (edited.changed === 0) {
        return {
          ...none,
          ...summary,
          status: 'nothing_changed' as const,
          message: 'Ни одна ячейка не изменена, файл не отправлен: причины в skipped.',
        };
      }
      const skippedCells = new Set(
        edited.skipped.map((item) => `${item.table ?? ''}:${item.row}:${item.col}`),
      );
      const applied = planned.flatMap((item, index) => {
        if (skippedCells.has(`${item.table}:${item.row}:${item.col}`)) return [];
        const spec = specs[index];
        return spec === undefined ? [] : [{ item, spec }];
      });
      const threadId = deps.state === undefined ? null : await chatThreadOf(deps.state, context);
      if (threadId === null) {
        throw new DomainError(
          'conflict',
          'Правка по просьбе сотрудника идёт только в его чате: плановый ход файл не отправляет.',
        );
      }
      const sendName =
        supplier === null
          ? resultNameFromSource(
              source.name,
              day,
              dottedExtension(edited.convertedFrom === undefined ? source.name : edited.fileName),
            )
          : sourceFileName(
              supplier.name,
              day,
              edited.convertedFrom === undefined ? source.name : edited.fileName,
            );
      const sendKey = directKey(input);
      try {
        await deps.chat.sendFile(
          threadId,
          edited.disk === undefined
            ? { name: sendName, mimeType: edited.mimeType, content: edited.bytes }
            : {
                name: sendName,
                mimeType: edited.mimeType,
                content: EMPTY_BYTES,
                disk: edited.disk,
              },
          `${sendKey}:file`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'неизвестная причина';
        throw new DomainError(
          'external_failure',
          `Файл не доставлен: ${reason}. Сообщи сотруднику причину; файл не доставлен.`,
          { retryable: true },
        );
      }
      const changes = applied.map(({ item, spec }) => ({
        place: item.label.text,
        ...(item.header === undefined ? {} : { header: item.header }),
        row: item.rowPreview,
        oldPrice: spec.oldPrice,
        newPrice: spec.newPrice,
      }));
      if (deps.state !== undefined) {
        const now = deps.clock.now();
        const followupChanges: FollowupChange[] = applied
          .slice(0, FOLLOWUP_CHANGES_MAX)
          .map(({ item, spec }) => ({
            place: item.label.text,
            table: item.table,
            row: item.row,
            col: item.col,
            ...(item.header === undefined ? {} : { header: item.header }),
            rowCells: item.rowCells,
            oldPrice: spec.oldPrice,
            newPrice: spec.newPrice,
          }));
        await saveFollowup(deps.state, threadId, {
          createdAt: now.toISOString(),
          expiresAt: followupExpiry(now),
          sourceName: source.name,
          resultName: sendName,
          supplier,
          changes: followupChanges,
        });
      }
      const ask =
        supplier === null
          ? 'Поставщик не определён: в этом же ответе спроси «это поставщик X?» (если по ' +
            'названию файла или тексту он очевиден, найди его через searchSuppliers) либо «как ' +
            'называется поставщик?». '
          : `Поставщик: ${supplier.name}; назови его и спроси, верно ли. `;
      return {
        ...none,
        ...summary,
        status: 'sent' as const,
        delivered: true,
        fileName: sendName,
        changes,
        message:
          `Файл отправлен без подписи. Изменено ячеек: ${edited.changed}, пропущено: ` +
          `${skipped.length}. Исходный файл не менялся. В ТОМ ЖЕ итоговом ответе: 1) перечисли ` +
          `изменения из changes (было → стало, место); 2) ${ask}3) спроси «обновить цены ` +
          'этих позиций в базе?». В базу пока ничего не записано и не будет записано без ' +
          'явного «да» сотрудника; без ответа база остаётся прежней.' +
          (edited.convertedFrom === undefined ? '' : ` ${CONVERTED_PPT_NOTE}`),
      };
    } finally {
      await edited.disk?.dispose();
    }
  },
});
