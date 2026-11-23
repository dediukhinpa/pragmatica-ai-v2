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
import type { PriceCellEdit, SkippedPriceEdit } from './kit/ports/price-file-editor';
import { isPriceEditRefusedError } from './price-edit-refusal';
import {
  refusalTextOf,
  refusedMessageForSpots,
  spotRefusalKey,
} from './price-edit-spot-refusal';
import type { PricesDeps } from './agents/prices/deps';
import { parseSource } from './agents/prices/parse-cache';
import {
  EMPTY_BYTES,
  CONVERTED_PPT_NOTE,
  TOO_LARGE_MESSAGES,
  UNSUPPORTED_MESSAGE,
  editSource,
  skippedFromService,
  sourceFileName,
  type EditedFile,
} from './agents/prices/price-edit-source';
import { openPriceSource } from './agents/prices/price-sources';
import {
  FOLLOWUP_CELL_MAX_CHARS,
  FOLLOWUP_CHANGES_MAX,
  FOLLOWUP_ROW_CELLS_MAX,
  followupExpiry,
  saveFollowup,
  type FollowupChange,
} from './price-edit-followup';
import { labelTables, type TableLabel } from './price-table-places';
import {
  findSpotCandidates,
  isPlainPrice,
  loadSpotMap,
  normalizeText as normalize,
  pagePlace,
  pdfSpotKey,
  keyOfSpot,
  slidePlace,
  spotExcerpt,
  spotKey,
  spotPlace,
} from './price-spots';
import { isPdfSpot, type PriceSpot } from './price-spots-client';
import { isTurnFileBufferEnabled } from './turn-file-buffer';
import {
  ONCE_AT_END_NOTE,
  ONCE_AT_END_PREFIX,
  UPDATED_VERSION_NOTE,
  UPDATED_VERSION_PREFIX,
  isReplay,
  isUpdatedVersion,
  loadTurnRecord,
  saveTurnRecord,
  serializedPerTurn,
  turnRecordKey,
  versionedFileName,
  type CarriedEdit,
} from './price-edit-turn';

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
/** Длина строки-подсказки о месте (ячейки строки через « | »). */
const ROW_PREVIEW_MAX_CHARS = 90;
/** Длина отрывка текста вокруг числа в тексте слайда или страницы (вместо строки таблицы). */
const SPOT_EXCERPT_MAX_CHARS = 90;
/** Длина основы имени файла результата. */
const STEM_MAX_CHARS = 100;
/** Недопустимые в имени файла знаки. */
const FORBIDDEN_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/gu;
/** Длина ISO-даты (гггг-мм-дд). */
const ISO_DATE_LENGTH = 10;
/** Больше знаков после запятой у цены не бывает (как у разбора цены ячейки). */
export const PRICE_DECIMALS_MAX = 4;
/** Основание десятичной системы для округления. */
const DECIMAL_BASE = 10;
/** Число в тексте ячейки: цифры с пробелами-разрядами и одним или несколькими разделителями. */
const NUMBER_IN_TEXT = /\d(?:[\d\s\u00a0\u202f.,]*\d)?/u;
/** Разделитель дробной части в записи числа. */
const DECIMAL_SEPARATOR = /[.,]/gu;
/** Пробелы и разделители разрядов. */
const DIGIT_SPACES = /[\s\u00a0\u202f]/gu;

/**
 * Дописывается к описанию инструмента при отправке одним файлом в конце хода (этап 9u): без
 * флага код не округляет, и такая фраза ввела бы модель в заблуждение.
 */
export const PRICE_ROUNDING_NOTE =
  ' newPrice передавай с полной точностью, не округляй сам: код округлит до знаков исходной ' +
  'ячейки; другое число знаков - только если сотрудник просил (decimals, целое 0..4).';

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
  /**
   * Знаков после запятой у новой цены (0..4). Нужен только если сотрудник просил другое число
   * знаков: по умолчанию код округляет до знаков исходной ячейки (при включённой отправке одним
   * файлом в конце хода).
   */
  decimals: z.number().int().min(0).max(PRICE_DECIMALS_MAX).optional(),
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
  /** Строка таблицы; для числа в тексте слайда или страницы - отрывок текста вокруг числа. */
  row: z.string(),
  /** Правка числа в тексте слайда или страницы (вне таблицы): `row` - текст вокруг числа. */
  textBlock: z.boolean().optional(),
  oldPrice: z.number(),
  newPrice: z.number(),
});
const variantSchema = z.object({
  place: z.string().nullable(),
  /** Таблица и строка с нуля; у числа в тексте слайда или страницы их нет (`textBlock`). */
  table: z.number().int().optional(),
  row: z.number().int().optional(),
  header: z.string().optional(),
  /** Строка таблицы или, у числа в тексте, отрывок текста вокруг него. */
  rowPreview: z.string(),
  /** Число в тексте слайда или страницы (вне таблицы). */
  textBlock: z.boolean().optional(),
});
const skippedSchema = z.object({
  position: z.string(),
  /** Строка таблицы; у числа в тексте слайда или страницы не задаётся. */
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
export interface Candidate {
  table: number;
  row: number;
  col: number;
  label: TableLabel;
  /** Заголовок столбца (первая строка таблицы), если ячейка не в ней. */
  header?: string | undefined;
  rowCells: string[];
  rowPreview: string;
  /**
   * Число вне таблицы (текстовый блок слайда, текст страницы PDF): правка уходит с локатором, а
   * `table`, `row` и `col` равны 0 только как заглушка состояния ожидания (сервис видит
   * row=0, col=0 без table).
   */
  spot?: PriceSpot | undefined;
  /** Текст цены в исходной ячейке (у числа в тексте слайда - число как в тексте): знаки. */
  priceText: string;
}

/** Ячейки строки без пустых: подсказка о месте и узнавание позиции. */
function cellsOf(row: readonly string[]): string[] {
  return row.map((cell) => cell.trim()).filter((cell) => cell !== '');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
  spots: readonly PriceSpot[],
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
          priceText: raw,
          rowCells: cells
            .slice(0, FOLLOWUP_ROW_CELLS_MAX)
            .map((cell) => clip(cell, FOLLOWUP_CELL_MAX_CHARS)),
          rowPreview: clip(cells.join(' | '), ROW_PREVIEW_MAX_CHARS),
        });
      });
    });
  });
  // Числа вне таблиц (текстовые блоки слайдов, текст страниц PDF): тот же поиск по цене,
  // слайду или странице и словам
  for (const spot of findSpotCandidates(spots, spec)) {
    const excerpt = spotExcerpt(spot, SPOT_EXCERPT_MAX_CHARS);
    // Заголовок столбца таблицы без линий (PDF) - подсказка о месте, как у ячейки таблицы
    const header = isPdfSpot(spot) ? (spot.header?.trim() ?? '') : '';
    found.push({
      table: 0,
      row: 0,
      col: 0,
      label: isPdfSpot(spot)
        ? { kind: 'page', number: spot.page, text: spotPlace(spot) }
        : { kind: 'slide', number: spot.slide, text: spotPlace(spot) },
      ...(header === '' ? {} : { header }),
      rowCells: [clip(excerpt, FOLLOWUP_CELL_MAX_CHARS)],
      rowPreview: excerpt,
      priceText: spot.text,
      spot,
    });
  }
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
    ...(item.spot === undefined
      ? { table: item.table, row: item.row }
      : { textBlock: true }),
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

/**
 * Знаков после запятой в записи цены: «680» - 0, «680,50» - 2, «1 250,5» - 1, «1.234.567» - 0.
 * Число берётся из текста целиком: пробелы-разряды и валюта вокруг не мешают. Если разделитель
 * один - после него дробная часть; если несколько одинаковых - это разряды. Не больше
 * {@link PRICE_DECIMALS_MAX}. Нет числа в тексте - null.
 */
export function decimalsOfText(text: string): number | null {
  const token = NUMBER_IN_TEXT.exec(text)?.[0];
  if (token === undefined) return null;
  const compact = token.replace(DIGIT_SPACES, '');
  const separators = compact.match(DECIMAL_SEPARATOR) ?? [];
  const last = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
  const hasBoth = compact.includes('.') && compact.includes(',');
  // Несколько одинаковых разделителей без другого - разряды, дробной части нет
  if (separators.length > 1 && !hasBoth) return 0;
  if (last < 0) return 0;
  return Math.min(compact.length - last - 1, PRICE_DECIMALS_MAX);
}

/** Знаков после запятой у числа как оно напечатано в JS (для цены без текста). */
function decimalsOfNumber(value: number): number {
  return Math.min((String(value).split('.')[1] ?? '').length, PRICE_DECIMALS_MAX);
}

/**
 * Округление «половина вверх» до `decimals` знаков без погрешностей двоичной дроби: сдвиг
 * запятой идёт через запись числа («1.005e2»), а не умножением (1.005 * 100 = 100.49999...).
 */
export function roundHalfUp(value: number, decimals: number): number {
  const plain = String(value);
  if (plain.includes('e')) {
    const factor = DECIMAL_BASE ** decimals;
    return Math.round(value * factor) / factor;
  }
  return Number(`${Math.round(Number(`${plain}e${decimals}`))}e-${decimals}`);
}

/**
 * Значение, которое пойдёт в ячейку. Пока отправка одним файлом в конце хода выключена, это
 * `newPrice` как есть (прежнее поведение). Включена - код округляет сам до `decimals` из
 * указания или до знаков исходной ячейки: модель считает цепочку процентов сама, и без этого
 * итог то с копейками, то целый.
 */
export function valueToWrite(item: Candidate, spec: EditSpec): number {
  if (!isTurnFileBufferEnabled()) return spec.newPrice;
  const decimals =
    spec.decimals ??
    decimalsOfText(item.priceText) ??
    (Number.isInteger(spec.oldPrice) ? 0 : decimalsOfNumber(spec.oldPrice));
  return roundHalfUp(spec.newPrice, decimals);
}

/** Ключ места правки: ячейка таблицы или число в текстовом блоке слайда. */
function placeKey(item: Candidate): string {
  return item.spot === undefined
    ? `${item.table}:${item.row}:${item.col}`
    : `spot:${keyOfSpot(item.spot)}`;
}

/** Ключ места пропуска, который вернул сервис: тот же вид, что у {@link placeKey}. */
function skippedPlaceKey(item: SkippedPriceEdit): string {
  if (item.page !== undefined && item.spot !== undefined) {
    return `spot:${pdfSpotKey({ page: item.page, spot: item.spot })}`;
  }
  if (item.slide !== undefined && item.shape !== undefined) {
    return `spot:${spotKey({
      slide: item.slide,
      shape: item.shape,
      paragraph: item.paragraph ?? 0,
      start: item.start ?? 0,
    })}`;
  }
  return `${item.table ?? ''}:${item.row}:${item.col}`;
}

/**
 * Пропущенная правка для агента: число в тексте называется слайдом или страницей и текстом
 * вокруг. Причина пропуска у таких чисел приходит строкой сервиса (`mismatch`), как у ячеек.
 */
function skippedOf(
  item: SkippedPriceEdit,
  keyAt: ReadonlyMap<string, string>,
  spotAt: ReadonlyMap<string, string>,
): z.infer<typeof skippedSchema> {
  const key = skippedPlaceKey(item).slice('spot:'.length);
  if (item.page !== undefined && item.spot !== undefined) {
    return { position: spotAt.get(key) ?? pagePlace(item.page), reason: item.reason };
  }
  if (item.slide === undefined || item.shape === undefined) {
    return skippedFromService(item, keyAt);
  }
  return { position: spotAt.get(key) ?? slidePlace(item.slide), reason: item.reason };
}

/** Адрес правки для сервиса: ячейка таблицы или локатор числа в тексте слайда либо страницы. */
function locationOf(item: Candidate): Pick<
  PriceCellEdit,
  'sheet' | 'table' | 'row' | 'col' | 'slide' | 'shape' | 'paragraph' | 'start' | 'page' | 'spot'
> {
  if (item.spot !== undefined) {
    // Сервис: у числа в тексте row=0, col=0, table не задаётся
    if (isPdfSpot(item.spot)) return { row: 0, col: 0, page: item.spot.page, spot: item.spot.spot };
    const { slide, shape, paragraph, start } = item.spot;
    return { row: 0, col: 0, slide, shape, paragraph, start };
  }
  return {
    ...(item.label.kind === 'sheet' && item.label.name !== undefined
      ? { sheet: item.label.name }
      : {}),
    table: item.table,
    row: item.row,
    col: item.col,
  };
}

/** Поля ожидания ответа для числа в тексте слайда или страницы: локатор и отрывок текста. */
function followupLocator(
  spot: PriceSpot,
  excerpt: string,
): Pick<
  FollowupChange,
  'slide' | 'shape' | 'paragraph' | 'start' | 'page' | 'spot' | 'context'
> {
  if (isPdfSpot(spot)) return { page: spot.page, spot: spot.spot, context: excerpt };
  const { slide, shape, paragraph, start } = spot;
  return { slide, shape, paragraph, start, context: excerpt };
}

const SPOTS_TRUNCATED_NOTE =
  'Карту чисел вне таблиц сервис обрезал по пределу: часть текстовых блоков не просмотрена.';

const NO_NUMBERS_MESSAGE =
  'Номера страниц в этом файле определить не удалось (раскладка недоступна): не придумывай ' +
  'номер. Попроси сотрудника назвать позицию или артикул из строки и повтори с rowText.';

/**
 * Изменить цену прямо в файле сотрудника и сразу отправить файл, не спрашивая поставщика.
 * Исходный файл не меняется: сервис правит копию.
 */
export const editPriceInFile = serializedPerTurn(defineTool<DirectInput, DirectOutput, PricesDeps>({
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
    '(потом getPendingPriceEdit и запись способом из инструкции). Те же строгие ' +
    'проверки, что у editPricesInSourceFile: pdf при любом сомнении не отправляется (' +
    'status=unsupported_format, причины в message), pptx - цены в таблицах слайдов и в текстовых ' +
    'блоках и группах (у такого числа в variants и changes стоит textBlock=true, а вместо ' +
    'строки таблицы - текст вокруг числа; слайд называй как «Слайд N»), старый ppt уходит как ' +
    'pptx. Сообщай сотруднику message и числа из ответа дословно. supplierId ' +
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
    // Числа вне таблиц слайдов (этап 9q); нет клиента, не презентация или сбой - только таблицы
    const spotMap = await loadSpotMap(deps, source);
    const spots = spotMap?.spots ?? [];
    const planned: Candidate[] = [];
    const specs: EditSpec[] = [];
    const taken = new Set<string>();
    // Что уже отправлено в этом ходе по этому файлу (этап 9t): повтор правки собирает итоговый
    // файл со всеми местами хода, а не второй неполный файл с тем же именем
    const sendKey = directKey(input);
    const turnKey = turnRecordKey(context, `file:${input.path}`);
    const turnRecord = await loadTurnRecord(deps.state, turnKey);
    for (const spec of input.edits) {
      if (spec.oldPrice === spec.newPrice) {
        throw new DomainError('invalid_input', 'Новая цена равна старой: править нечего.');
      }
      const found = findCandidates(parsed, labels, spec, spots);
      if (found.length === 0) {
        // Номера страниц известны по меткам таблиц или по карте чисел в тексте PDF
        const noPageNumbers =
          spec.page !== undefined &&
          !labels.some((label) => label.kind === 'page') &&
          !spots.some(isPdfSpot);
        return {
          ...none,
          status: 'not_found' as const,
          message: noPageNumbers
            ? NO_NUMBERS_MESSAGE
            : `В файле не найдена ${describeSpec(spec)}. Файл не изменён и не отправлен. Не ` +
              'угадывай: скажи сотруднику, что такой цены на этом месте нет, и спроси, где ' +
              'искать (слайд, страница, строка). Ячейки первой строки таблицы ищутся, только ' +
              'если передать row=0.' +
              (spotMap?.truncated === true ? ` ${SPOTS_TRUNCATED_NOTE}` : ''),
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
      const cellKey = placeKey(only);
      if (taken.has(cellKey)) {
        throw new DomainError('invalid_input', 'Две правки указывают на одну и ту же ячейку.');
      }
      // Округление не должно обнулить цену или вернуть прежнюю: модель увидит причину и
      // передаст decimals (включено только вместе с отправкой одним файлом в конце хода)
      const rounded = valueToWrite(only, spec);
      if (rounded <= 0) {
        throw new DomainError(
          'invalid_input',
          `После округления до знаков исходной цены новая цена равна нулю (${spec.newPrice}). ` +
            'Передай decimals, если сотрудник просил больше знаков.',
        );
      }
      if (rounded === spec.oldPrice) {
        throw new DomainError(
          'invalid_input',
          `После округления до знаков исходной цены новая цена (${spec.newPrice}) равна ` +
            'старой: править нечего. Передай decimals, если сотрудник просил больше знаков.',
        );
      }
      taken.add(cellKey);
      planned.push(only);
      specs.push(spec);
    }
    // Правки прежних отправок хода: место, названное заново, берёт новую цену, остальные
    // остаются в файле. Повтор той же отправки (после сбоя) прежних правок не подмешивает.
    const carriedPlanned: Candidate[] = [];
    const carriedSpecs: EditSpec[] = [];
    const earlier = isUpdatedVersion(turnRecord, sendKey) ? turnRecord.carried : [];
    for (const entry of earlier) {
      const parsedSpec = editSpecSchema.safeParse(entry.spec);
      if (!parsedSpec.success) continue;
      const found = findCandidates(parsed, labels, parsedSpec.data, spots);
      const [only] = found;
      if (found.length !== 1 || only === undefined || taken.has(placeKey(only))) continue;
      taken.add(placeKey(only));
      carriedPlanned.push(only);
      carriedSpecs.push(parsedSpec.data);
    }
    planned.unshift(...carriedPlanned);
    specs.unshift(...carriedSpecs);
    const edits: PriceCellEdit[] = planned.map((item, index) => {
      const spec = specs[index];
      return {
        ...locationOf(item),
        value: spec === undefined ? 0 : valueToWrite(item, spec),
      // Старая цена из файла: сервис не запишет, если в ячейке сейчас другое значение
      // (у числа в текстовом блоке слайда без неё не верит и координатам)
        expected: spec?.oldPrice ?? 0,
      };
    });
    const keyAt = new Map<string, string>();
    const spotAt = new Map<string, string>();
    for (const item of planned) {
      const place = item.label.text === null ? '' : `${item.label.text}, `;
      if (item.spot === undefined) {
        keyAt.set(`${item.table}:${item.row}`, `${place}строка «${item.rowPreview}»`);
      } else {
        spotAt.set(keyOfSpot(item.spot), `${place}текст «${item.rowPreview}»`);
      }
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
        const skipped = error.reasons.map((reason) => {
          // Число в тексте PDF называется страницей и текстом вокруг, а не строкой таблицы
          const spotKeyOfReason = spotRefusalKey(reason);
          if (spotKeyOfReason !== null) {
            return {
              position: spotAt.get(spotKeyOfReason) ?? pagePlace(reason.page ?? 0),
              reason: refusalTextOf(reason),
            };
          }
          return {
            position:
              reason.row === undefined
                ? 'файл'
                : (keyAt.get(`${reason.table ?? ''}:${reason.row}`) ?? `строка ${reason.row}`),
            ...(reason.row === undefined ? {} : { row: reason.row }),
            reason: refusalTextOf(reason),
          };
        });
        return {
          ...none,
          status: 'unsupported_format' as const,
          skippedCount: skipped.length,
          skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
          message: refusedMessageForSpots(error.reasons, keyAt, spotAt),
        };
      }
      if (!isUnsupportedPriceFormatError(error)) throw error;
      return { ...none, status: 'unsupported_format' as const, message: UNSUPPORTED_MESSAGE };
    }
    try {
      const skipped = edited.skipped.map((item) => skippedOf(item, keyAt, spotAt));
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
      const skippedCells = new Set(edited.skipped.map(skippedPlaceKey));
      const applied = planned.flatMap((item, index) => {
        if (skippedCells.has(placeKey(item))) return [];
        const spec = specs[index];
        return spec === undefined ? [] : [{ item, spec, value: valueToWrite(item, spec) }];
      });
      const threadId = deps.state === undefined ? null : await chatThreadOf(deps.state, context);
      if (threadId === null) {
        throw new DomainError(
          'conflict',
          'Правка по просьбе сотрудника идёт только в его чате: плановый ход файл не отправляет.',
        );
      }
      const baseName =
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
      // Файл уходит один раз в конце хода (канал заменяет файл с тем же именем), поэтому имя
      // всегда одно; без этого повторная отправка идёт с пометкой «обновлённая версия»
      const onceAtEnd = isTurnFileBufferEnabled();
      const sendName = onceAtEnd ? baseName : versionedFileName(baseName, turnRecord, sendKey);
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
      const changes = applied.map(({ item, spec, value }) => ({
        place: item.label.text,
        ...(item.header === undefined ? {} : { header: item.header }),
        row: item.rowPreview,
        ...(item.spot === undefined ? {} : { textBlock: true }),
        oldPrice: spec.oldPrice,
        newPrice: value,
      }));
      if (deps.state !== undefined) {
        const now = deps.clock.now();
        const followupChanges: FollowupChange[] = applied
          .slice(0, FOLLOWUP_CHANGES_MAX)
          .map(({ item, spec, value }) => ({
            place: item.label.text,
            table: item.table,
            row: item.row,
            col: item.col,
            ...(item.header === undefined ? {} : { header: item.header }),
            ...(item.spot === undefined ? {} : followupLocator(item.spot, item.rowPreview)),
            rowCells: item.rowCells,
            oldPrice: spec.oldPrice,
            newPrice: value,
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
      const updatedVersion = isUpdatedVersion(turnRecord, sendKey);
      if (!isReplay(turnRecord, sendKey)) {
        // Запись хода: что уже отправлено и какие места несёт итоговый файл
        await saveTurnRecord(deps.state, turnKey, {
          sends: [...turnRecord.sends, { key: sendKey, name: sendName }],
          carried: applied.map(({ item, spec }): CarriedEdit => ({ place: placeKey(item), spec })),
        });
      }
      const ask =
        supplier === null
          ? 'Поставщик не определён: в этом же ответе спроси «это поставщик X?» (если по ' +
            'названию файла или тексту он очевиден, найди его через searchSuppliers) либо «как ' +
            'называется поставщик?». '
          : `Поставщик: ${supplier.name}; назови его и спроси, верно ли. `;
      const closing =
        'В ТОМ ЖЕ итоговом ответе: 1) перечисли изменения из changes (было → стало, место); ' +
        `2) ${ask}3) спроси «обновить цены этих позиций в базе?». В базу пока ничего не ` +
        'записано и не будет записано без явного «да» сотрудника; без ответа база остаётся ' +
        'прежней.';
      const converted = edited.convertedFrom === undefined ? '' : ` ${CONVERTED_PPT_NOTE}`;
      const counts = `Изменено ячеек: ${edited.changed}, пропущено: ${skipped.length}.`;
      const message = onceAtEnd
        ? `${ONCE_AT_END_PREFIX} ${counts} Исходный файл не менялся. ${closing}${converted} ` +
          ONCE_AT_END_NOTE
        : `Файл отправлен без подписи. ${counts} Исходный файл не менялся. ${closing}` +
          `${converted}` +
          (updatedVersion
            ? ` ${UPDATED_VERSION_PREFIX}${UPDATED_VERSION_NOTE} Все правки хода в нём ` +
              'перечислены в changes.'
            : '');
      return {
        ...none,
        ...summary,
        status: 'sent' as const,
        delivered: true,
        fileName: sendName,
        changes,
        message,
      };
    } finally {
      await edited.disk?.dispose();
    }
  },
}));
