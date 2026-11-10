import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import {
  isPriceFileTooLargeError,
  isUnsupportedPriceFormatError,
  type PriceFileTooLargeReason,
} from '../../kit/domain/errors.owned';
import { priceItemKey } from '../../kit/domain/price-diff';
import type {
  EditedPriceFile,
  EditPricesRequest,
  PriceCellEdit,
  PriceFileEditor,
  SkippedPriceEdit,
} from '../../kit/ports/price-file-editor';
import type { TempDiskFile } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { extensionOf, requirePort, stableHash } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { chatThreadOf } from '@business-ai/core';
import { changeFileRecipient, CHANGES_FILE_FORMAT, type PricesDeps } from './deps';
import { parseSource } from './parse-cache';
import { openPriceSource, type PriceSource } from './price-sources';
import { priceChangeFileName } from './price-changes';
import { stagingImportId } from './staging-source';
import { loadSourceCells, type CellPlace } from './source-cells';
import { parsePriceCell } from './table-rows';

/** Длина даты в ISO-строке (гггг-мм-дд). */
const ISO_DATE_LENGTH = 10;
/** Процент в долю. */
const PERCENT = 100;
/** Предел изменения в процентах: больше - почти наверняка ошибка ввода. */
const MAX_PERCENT = 1000;
/** Знаков после запятой не больше этого: длинный «хвост» в ячейке - артефакт разбора. */
const MAX_PRICE_DECIMALS = 4;
/** Сколько пропущенных ячеек перечисляем агенту (остальные только числом). */
const MAX_SKIPPED_LISTED = 50;
/** Сколько названий шапки показываем в вопросе о неизвестном столбце. */
const MAX_HEADERS_LISTED = 30;
/** Столбцов цен за один вызов не больше этого. */
const MAX_PRICE_COLUMNS = 10;
/** Правок за один вызов не больше этого (защита от огромного тела запроса). */
const MAX_EDITS = 20_000;

const fixedSchema = z.object({
  key: z.string().min(1).optional(),
  sku: z.string().min(1).optional(),
  price: z.number().positive(),
});

interface EditInput {
  supplierId: string;
  fileHash: string;
  mode: 'percent' | 'fixed';
  percent?: number | undefined;
  fixed?: Array<z.infer<typeof fixedSchema>> | undefined;
  priceColumns?: string[] | undefined;
  decimals?: number | undefined;
}

const skippedSchema = z.object({
  position: z.string(),
  row: z.number().int().optional(),
  reason: z.string(),
});
type SkippedOutput = z.infer<typeof skippedSchema>;

const STATUSES = [
  'sent',
  'no_coordinates',
  'unsupported_format',
  'too_large',
  'nothing_changed',
  'unknown_column',
] as const;

interface EditOutput {
  status: (typeof STATUSES)[number];
  /** Предупреждения для сотрудника (например, запрошено больше знаков, чем в ячейках). */
  warnings?: string[] | undefined;
  delivered: boolean;
  fileName?: string | undefined;
  changed: number;
  skippedCount: number;
  skipped: SkippedOutput[];
  /** Что сказать сотруднику; формулировку статуса задаёт код, а не модель. */
  message: string;
}

const NO_COORDINATES_MESSAGE =
  'Для этого импорта нет координат ячеек цен (файл разобран до появления правки на месте ' +
  'или записан иначе): исходный файл править нельзя. Предложите сотруднику прислать файл ' +
  'заново, тогда цены можно будет изменить прямо в нём.';
const UNSUPPORTED_MESSAGE =
  'Этот формат файла на месте не правится (xls, pdf, скан и подобные). Файл не отправлен. ' +
  'Предложите сотруднику xlsx-копию с тем же содержимым (один лист, структура исходного, с ' +
  'новыми ценами) и делайте её ТОЛЬКО с его согласия.';

/** Запрет подменять исходный файл: общий для отказов по размеру (кроме временного). */
const NO_SUBSTITUTE_MESSAGE =
  'Файл не изменён и не отправлен. Скажи сотруднику эту причину прямо. Не подменяй исходный ' +
  'файл новой таблицей (createFile) и не предлагай столбцы «было/стало»: это не правка ' +
  'прайса, а другой файл без оформления и картинок.';

/** Текст отказа по размеру: совет зависит от того, во что именно упёрся сервис правки. */
const TOO_LARGE_MESSAGES: Readonly<Record<PriceFileTooLargeReason, string>> = {
  file_size:
    'Файл слишком большой, чтобы поправить цены прямо в нём: сервис правки его не принял. ' +
    `${NO_SUBSTITUTE_MESSAGE} Предложи прислать файл полегче (например, без картинок) или ` +
    'изменить цены вручную.',
  uncompressed:
    'Файл слишком тяжёлый внутри (скорее всего, много или слишком крупных картинок): сервис ' +
    `не смог его открыть. ${NO_SUBSTITUTE_MESSAGE} Предложи прислать файл без картинок или ` +
    'изменить цены вручную.',
  structure:
    'В файле слишком много ячеек или слишком сложная разметка (листы, объединения): сервис ' +
    `правки не смог его открыть. ${NO_SUBSTITUTE_MESSAGE} Предложи прислать только лист с ` +
    'ценами или изменить цены вручную.',
  edits:
    'Сервис не принял список правок: изменяемых ячеек слишком много для одного запроса. ' +
    `${NO_SUBSTITUTE_MESSAGE} Предложи править по частям (например, один столбец цен за раз) ` +
    'или изменить цены вручную.',
  temporary:
    'Сервис правки сейчас занят или не уложился по времени. Файл не изменён и не отправлен. ' +
    'Скажи сотруднику, что стоит повторить запрос чуть позже; исходный файл новой таблицей не ' +
    'подменяй.',
  unknown:
    'Файл слишком большой или слишком сложный, чтобы поправить цены прямо в нём: сервис ' +
    `правки его не принял. ${NO_SUBSTITUTE_MESSAGE} Предложи прислать файл полегче (меньше ` +
    'листов, без картинок) или изменить цены вручную.',
};

/** Один вопрос сотруднику: каких столбцов нет в шапке и какие есть. */
function unknownColumnMessage(resolved: ColumnResolution): string {
  const listed = resolved.headers.slice(0, MAX_HEADERS_LISTED).join('; ');
  return (
    `Столбец «${resolved.unknown.join('», «')}» не найден в шапке файла однозначно. Файл не ` +
    `менялся и не отправлен. Задайте сотруднику ОДИН вопрос, какой именно столбец править; ` +
    `столбцы в шапке: ${listed}. Название не выдумывайте.`
  );
}

/** Знаков после запятой в записи цены в ячейке («10,50» - 2, «100» - 0). */
function decimalsOf(raw: string): number {
  const match = /[.,](\d+)(?!.*\d)/u.exec(raw);
  return Math.min(match?.[1]?.length ?? 0, MAX_PRICE_DECIMALS);
}

/**
 * Округление цены до `decimals` знаков: половина - от нуля (1,005 -> 1,01; -2,5 -> -3), без
 * потерь двоичной дроби (1,005 * 100 = 100,49999...): сдвиг запятой идёт через запись числа
 * (`1.005e2`), а не умножением. Запись с экспонентой (очень малые числа) считается напрямую.
 */
export function roundEditedPrice(value: number, decimals: number): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const text = String(abs);
  const rounded = text.includes('e')
    ? Math.round(abs * 10 ** decimals) / 10 ** decimals
    : Number(`${Math.round(Number(`${text}e${decimals}`))}e-${decimals}`);
  // `|| 0`: результат «-0» (малое отрицательное) в ячейку не пишем
  return sign * rounded || 0;
}

function sendKey(input: EditInput): string {
  const importId = stagingImportId(input.supplierId, input.fileHash);
  // decimals входит в хеш, только когда задан: ключи запросов без него остаются прежними
  // (иначе повтор уже обработанного запроса после выкатки отправил бы файл второй раз)
  const edit = stableHash([
    input.mode,
    input.percent ?? null,
    input.fixed ?? null,
    input.priceColumns ?? null,
    ...(input.decimals === undefined ? [] : [input.decimals]),
  ]);
  return `prices-edit-source:${importId}:${edit}`;
}

/** Файл с расширением исходного: имя считается как у файла изменений, кроме расширения. */
function sourceFileName(supplierName: string, isoDate: string, fileName: string): string {
  const base = priceChangeFileName(supplierName, isoDate);
  const stem = base.slice(0, base.length - CHANGES_FILE_FORMAT.length - 1);
  const extension = extensionOf(fileName);
  return `${stem}${extension === '' ? `.${CHANGES_FILE_FORMAT}` : extension}`;
}

/** Ключ позиции из аргумента: готовый `key` либо ключ по артикулу. */
function keyOfFixed(entry: z.infer<typeof fixedSchema>): string | null {
  if (entry.key !== undefined) return entry.key;
  return entry.sku === undefined ? null : priceItemKey({ sku: entry.sku, productName: '' });
}

function validateInput(input: EditInput): void {
  if (input.mode === 'fixed' && (input.priceColumns?.length ?? 0) > 1) {
    throw new DomainError(
      'invalid_input',
      'Фиксированная цена задаётся для одного столбца: для нескольких используйте percent.',
    );
  }
  if (input.mode === 'percent') {
    const percent = input.percent;
    if (percent === undefined || !Number.isFinite(percent) || percent === 0) {
      throw new DomainError('invalid_input', 'Для mode=percent укажите percent (не 0).');
    }
    if (percent <= -PERCENT || percent > MAX_PERCENT) {
      throw new DomainError(
        'invalid_input',
        `percent должен быть больше -${PERCENT} и не больше ${MAX_PERCENT}.`,
      );
    }
    return;
  }
  if (input.fixed === undefined || input.fixed.length === 0) {
    throw new DomainError('invalid_input', 'Для mode=fixed передайте fixed: [{key|sku, price}].');
  }
  if (input.fixed.some((entry) => keyOfFixed(entry) === null)) {
    throw new DomainError('invalid_input', 'У каждого элемента fixed нужен key или sku.');
  }
}

type Table = readonly (readonly string[])[];

/** Название столбца для сравнения: регистр, пробелы и хвостовая пунктуация не важны. */
function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').replace(/[\s.,;:]+$/u, '').trim();
}

interface ColumnResolution {
  /** Столбцы по индексу таблицы: что править вместо столбцов, найденных разбором. */
  byTable: Map<number, number[]>;
  /** Названия, которых нет в шапке (или они неоднозначны), - для вопроса сотруднику. */
  unknown: string[];
  /** Шапка файла: подсказка для вопроса. */
  headers: string[];
}

/**
 * Столбцы цен по названиям из шапки файла. Разбор прайса берёт одну цену на позицию, а
 * сотрудник может назвать несколько столбцов (розница и опт), поэтому столбцы ищем в самой
 * шапке, а не в координатах разбора. Точное совпадение важнее вхождения: «Цена» не должна
 * молча попасть в «Цена опт»; неоднозначное или неизвестное название не угадываем.
 */
function resolveColumns(
  names: readonly string[],
  items: Readonly<Record<string, readonly CellPlace[]>>,
  tableOf: (index: number) => Table | undefined,
): ColumnResolution {
  const firstData = new Map<number, number>();
  for (const places of Object.values(items)) {
    for (const place of places) {
      firstData.set(place.table, Math.min(firstData.get(place.table) ?? place.row, place.row));
    }
  }
  const byTable = new Map<number, number[]>();
  const unknown = new Set<string>();
  const headers = new Set<string>();
  for (const [index, dataRow] of firstData) {
    const header = new Map<number, string>();
    for (const row of tableOf(index)?.slice(0, dataRow) ?? []) {
      row.forEach((text, col) => {
        const norm = normalizeHeader(text);
        if (norm === '') return;
        header.set(col, header.has(col) ? `${header.get(col)} ${norm}` : norm);
        headers.add(text.trim());
      });
    }
    const cols = new Set<number>();
    for (const name of names) {
      const wanted = normalizeHeader(name);
      const entries = [...header.entries()];
      const exact = entries.filter(([, text]) => text === wanted || text.endsWith(` ${wanted}`));
      const partial = entries.filter(([, text]) => wanted !== '' && text.includes(wanted));
      const found = exact.length > 0 ? exact : partial;
      const [only] = found;
      if (found.length === 1 && only !== undefined) cols.add(only[0]);
      else unknown.add(name);
    }
    byTable.set(index, [...cols].sort((a, b) => a - b));
  }
  return { byTable, unknown: [...unknown], headers: [...headers] };
}

/** Расчёт правок по координатам и текущим значениям ячеек таблицы. */
interface Plan {
  edits: PriceCellEdit[];
  skipped: SkippedOutput[];
  /** Сколько правляемых ячеек имеют меньше знаков, чем запросил сотрудник (`decimals`). */
  fewerPlacesCells: number;
  /** Сколько знаков у самой подробной из правимых ячеек (для предупреждения). */
  maxCellPlaces: number;
}

function planEdits(
  input: EditInput,
  items: Readonly<Record<string, readonly CellPlace[]>>,
  tableOf: (index: number) => Table | undefined,
  columnsOf: (place: CellPlace) => readonly number[] = (place) => place.cols,
): Plan {
  const edits: PriceCellEdit[] = [];
  const skipped: SkippedOutput[] = [];
  let fewerPlacesCells = 0;
  let maxCellPlaces = 0;
  const fixedByKey = new Map<string, number>();
  for (const entry of input.fixed ?? []) {
    const key = keyOfFixed(entry);
    if (key !== null) fixedByKey.set(key, entry.price);
  }
  if (input.mode === 'fixed') {
    for (const key of fixedByKey.keys()) {
      if (items[key] === undefined) {
        skipped.push({ position: key, reason: 'позиции нет в разобранном файле' });
      }
    }
  }
  for (const [key, places] of Object.entries(items)) {
    const fixed = fixedByKey.get(key);
    if (input.mode === 'fixed' && fixed === undefined) continue;
    for (const place of places) {
      const table = tableOf(place.table);
      const cols = columnsOf(place);
      if (input.mode === 'fixed' && cols.length !== 1) {
        skipped.push({
          position: key,
          row: place.row,
          reason: 'несколько столбцов цен (тиражи): фиксированную цену не назначить',
        });
        continue;
      }
      for (const col of cols) {
        const raw = table?.[place.row]?.[col] ?? '';
        const cell = parsePriceCell(raw);
        const plain =
          cell.kind === 'ok' && cell.qualifier === undefined && cell.minQuantity === undefined;
        if (!plain) {
          skipped.push({
            position: key,
            row: place.row,
            reason: `текстовая или нечисловая цена «${raw.slice(0, 40)}», ячейка не менялась`,
          });
          continue;
        }
        // Знаков столько же, сколько в исходной ячейке, пока сотрудник не назвал число знаков
        const cellPlaces = decimalsOf(raw);
        const places = input.decimals ?? cellPlaces;
        // Фиксированная цена округляется, только если сотрудник назвал знаки (иначе как задана)
        const next =
          fixed === undefined
            ? roundEditedPrice(cell.value * (1 + (input.percent ?? 0) / PERCENT), places)
            : input.decimals === undefined
              ? fixed
              : roundEditedPrice(fixed, input.decimals);
        if (next === cell.value) {
          skipped.push({ position: key, row: place.row, reason: 'цена не изменилась' });
          continue;
        }
        maxCellPlaces = Math.max(maxCellPlaces, cellPlaces);
        if (input.decimals !== undefined && input.decimals > cellPlaces) fewerPlacesCells += 1;
        edits.push({
          ...(place.sheet === undefined ? {} : { sheet: place.sheet }),
          table: place.table,
          row: place.row,
          col,
          value: next,
          // Старая цена из файла: сервис не запишет, если в ячейке сейчас другое значение.
          expected: cell.value,
        });
      }
    }
  }
  return { edits, skipped, fewerPlacesCells, maxCellPlaces };
}

/** Позиция по координатам, чтобы объяснить пропуск ячейки, который вернул сервис. */
function skippedFromService(
  item: SkippedPriceEdit,
  keyAt: ReadonlyMap<string, string>,
): SkippedOutput {
  return {
    position: keyAt.get(`${item.table ?? ''}:${item.row}`) ?? `строка ${item.row}`,
    row: item.row,
    reason: item.reason,
  };
}

/** Пустое содержимое файла, чей текст лежит на диске. */
const EMPTY_BYTES = new Uint8Array(0);

/** Результат правки для инструмента: файл либо в памяти (`bytes`), либо на диске (`disk`). */
interface EditedFile {
  mimeType: string;
  bytes: Uint8Array;
  disk?: TempDiskFile | undefined;
  changed: number;
  skipped: EditedPriceFile['skipped'];
}

/**
 * Править источник: файл на диске и редактор с поддержкой диска идут потоком (этап 231, пик
 * памяти не растёт с размером файла), остальное - прежним путём через память.
 */
async function editSource(
  editor: PriceFileEditor,
  source: PriceSource,
  fileName: string,
  edits: EditPricesRequest['edits'],
): Promise<EditedFile> {
  if (editor.editPricesFile !== undefined && source.disk !== undefined) {
    const result = await editor.editPricesFile({
      fileName,
      file: await source.disk(),
      edits,
    });
    return { ...result, bytes: EMPTY_BYTES, disk: result.file };
  }
  return editor.editPrices({ fileName, bytes: await source.read(), edits });
}

/**
 * Изменить цены прямо в исходном файле поставщика и отправить его сотруднику. Исходный файл не
 * меняется: сервис правит копию. Новых листов, строк и столбцов нет.
 */
export const editPricesInSourceFile = defineTool<EditInput, EditOutput, PricesDeps>({
  name: 'editPricesInSourceFile',
  readsFile: true,
  sideEffect: true,
  description:
    'Изменить цены в ИСХОДНОМ файле прайса (xlsx, csv, docx с таблицей) и отправить его ' +
    'тому, кто просил в этом чате, с именем Прайс_<поставщик>_<дата>. Меняются только ячейки ' +
    'цен, структура и форматирование сохраняются; текстовые цены («от 100») не трогаются и ' +
    'перечисляются в skipped. Передайте supplierId и fileHash импорта (из stagePriceRows) и ' +
    'mode: percent (+percent, например 5 или -10) либо fixed (+fixed: [{key|sku, price}]). ' +
    'Работает только для файлов, разобранных с сохранением координат; иначе status=' +
    'no_coordinates - предложите прислать файл заново. xls/pdf/скан на месте не правятся ' +
    '(status=unsupported_format) - предложите xlsx-копию и делайте её только с согласия ' +
    'сотрудника. status=too_large - файл или правки не приняты по размеру: передайте совет ' +
    'из message сотруднику, исходный файл новой таблицей не подменять. ' +
    'Число знаков после запятой в новых ценах по умолчанию как в исходной ячейке; если ' +
    'сотрудник просит округлить («до 1 знака», «до целых»), передайте decimals (0-4). ' +
    'Сообщайте сотруднику message и числа из ответа дословно: сколько изменено и что ' +
    'пропущено. Если сотрудник назвал столбцы цен ' +
    '(«оба», «опт», «розница») - передайте ВСЕ названные в priceColumns по шапке файла ' +
    '(["Цена, руб.", "Цена опт, руб."]) одним вызовом: меняются именно они, независимо от ' +
    'разбора. status=unknown_column - спросите сотрудника одним вопросом, имя не выдумывайте.',
  inputSchema: z.object({
    supplierId: z.string().min(1),
    fileHash: z.string().min(1),
    mode: z.enum(['percent', 'fixed']),
    percent: z.number().optional(),
    fixed: z.array(fixedSchema).max(MAX_EDITS).optional(),
    priceColumns: z.array(z.string().min(1)).max(MAX_PRICE_COLUMNS).optional(),
    decimals: z.number().int().min(0).max(MAX_PRICE_DECIMALS).optional(),
  }),
  outputSchema: z.object({
    status: z.enum(STATUSES),
    warnings: z.array(z.string()).optional(),
    delivered: z.boolean(),
    fileName: z.string().optional(),
    changed: z.number().int(),
    skippedCount: z.number().int(),
    skipped: z.array(skippedSchema),
    message: z.string(),
  }),
  idempotencyKey: sendKey,
  async execute(input, deps, context) {
    validateInput(input);
    const editor = requirePort(deps.priceFileEditor, 'правка цен в файле');
    const importId = stagingImportId(input.supplierId, input.fileHash);
    const empty = { delivered: false, changed: 0, skippedCount: 0, skipped: [] };
    const cells = await loadSourceCells(deps, importId);
    if (cells === null || Object.keys(cells.items).length === 0) {
      return { ...empty, status: 'no_coordinates' as const, message: NO_COORDINATES_MESSAGE };
    }
    const source = await openPriceSource(deps, cells.path, context);
    if (source.hash !== input.fileHash) {
      throw new DomainError(
        'conflict',
        'Файл изменился после разбора: разберите его заново (stagePriceRows) и повторите.',
      );
    }
    const parsed = await parseSource(deps.parser, source, deps.turnScope);
    const tableOf = (index: number): Table | undefined => parsed.tables[index];
    let columnsOf: ((place: CellPlace) => readonly number[]) | undefined;
    if (input.priceColumns !== undefined && input.priceColumns.length > 0) {
      const resolved = resolveColumns(input.priceColumns, cells.items, tableOf);
      if (resolved.unknown.length > 0) {
        const message = unknownColumnMessage(resolved);
        return { ...empty, status: 'unknown_column' as const, message };
      }
      columnsOf = (place) => resolved.byTable.get(place.table) ?? place.cols;
    }
    const plan = planEdits(input, cells.items, tableOf, columnsOf);
    // Позиции по координатам: чтобы пропуск сервиса назвать позицией, а не номером строки.
    const keyAt = new Map<string, string>();
    for (const [key, places] of Object.entries(cells.items)) {
      for (const place of places) keyAt.set(`${place.table}:${place.row}`, key);
    }
    const supplier = await deps.suppliers.get(input.supplierId);
    const day = deps.clock.now().toISOString().slice(0, ISO_DATE_LENGTH);
    const fileName = sourceFileName(supplier?.name ?? input.supplierId, day, cells.fileName);
    let edited: EditedFile;
    try {
      edited = await editSource(editor, source, cells.fileName, plan.edits);
    } catch (error) {
      if (isPriceFileTooLargeError(error)) {
        return {
          ...empty,
          status: 'too_large' as const,
          message: TOO_LARGE_MESSAGES[error.reason],
        };
      }
      if (!isUnsupportedPriceFormatError(error)) throw error;
      return { ...empty, status: 'unsupported_format' as const, message: UNSUPPORTED_MESSAGE };
    }
    try {
      const skipped = [
        ...plan.skipped,
        ...edited.skipped.map((item) => skippedFromService(item, keyAt)),
      ];
      // Запрошено знаков больше, чем в ячейках: формат ячейки может показывать меньше, чем записано
      const warnings =
        plan.fewerPlacesCells === 0 || input.decimals === undefined
          ? []
          : [
              `Запрошено знаков после запятой: ${input.decimals}, но в ${plan.fewerPlacesCells} ` +
                `правимых ячейках формат показывает не больше ${plan.maxCellPlaces}: значение ` +
                'записано с запрошенным числом знаков, а на экране в Excel может выглядеть ' +
                'округлённым.',
            ];
      const summary = {
        changed: edited.changed,
        skippedCount: skipped.length,
        skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
        ...(warnings.length === 0 ? {} : { warnings }),
      };
      if (edited.changed === 0) {
        return {
          ...summary,
          status: 'nothing_changed' as const,
          delivered: false,
          message: 'Ни одна ячейка не изменена, файл не отправлен: причины в skipped.',
        };
      }
      const requesterThread =
        deps.state === undefined ? null : await chatThreadOf(deps.state, context);
      const threadId =
        requesterThread ?? (await changeFileRecipient(deps, workSubject.import(input.fileHash)));
      try {
        // Файл уходит без подписи кода: итог сотруднику говорит одно сообщение агента (иначе они
        // дублировали друг друга по смыслу, решение владельца 03.11).
        await deps.chat.sendFile(
          threadId,
          edited.disk === undefined
            ? { name: fileName, mimeType: edited.mimeType, content: edited.bytes }
            : {
                name: fileName,
                mimeType: edited.mimeType,
                content: EMPTY_BYTES,
                disk: edited.disk,
              },
          `${sendKey(input)}:file`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'неизвестная причина';
        throw new DomainError(
          'external_failure',
          `Файл не доставлен: ${reason}. Сообщи сотруднику причину; файл не доставлен.`,
          { retryable: true },
        );
      }
      return {
        ...summary,
        status: 'sent' as const,
        delivered: true,
        fileName,
        message:
          `Файл отправлен без подписи. Изменено ячеек: ${edited.changed}, пропущено: ` +
          `${skipped.length}. В итоговом ответе скажи сам: сколько ячеек изменено и сколько ` +
          'пропущено, что исходный файл на диске не менялся, цены в базу не попали и внести их ' +
          `нужно самому.${warnings.map((text) => ` ${text}`).join('')}`,
      };
    } finally {
      // Результат на диске - временный файл: убираем при любом исходе.
      await edited.disk?.dispose();
    }
  },
});
