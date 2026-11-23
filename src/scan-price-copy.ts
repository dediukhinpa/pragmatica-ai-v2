import { z } from 'zod';
import { DomainError, defineTool, requirePort, validateTableSheets } from '@business-ai/core';
import type { TableCell, TableSheet } from '@business-ai/core';
import { chatThreadOf, extensionOf, stableHash } from '@business-ai/core';
import { SCAN_EXTENSIONS, type PricesDeps } from './agents/prices/deps';
import { parseSource } from './agents/prices/parse-cache';
import { openPriceSource } from './agents/prices/price-sources';
import { loadTurnRecord, saveTurnRecord, turnRecordKey } from './price-edit-turn';
import type { CarriedEdit } from './price-edit-turn';
import {
  applyScanEdits,
  changeTableMarkdown,
  formatMoney,
  type ScanChangeRow,
  type ScanDoubtful,
} from './scan-price-edits';
import {
  DOUBT_LABELS,
  SCAN_DOUBTS,
  lineSum,
  readScanText,
  sumMatches,
  type ScanLine,
} from './scan-price-lines';

/**
 * Копия скана с изменёнными ценами (этап 9v, живой баг 23.11: скан-счёт и просьба «измени
 * стоимость кружек на 239 рублей и пересчитай»). Сам скан не правится: распознанный текст читает
 * код, цены меняет код, суммы и итог пересчитывает код, сотруднику уходит ОДИН xlsx с таблицей
 * «было / стало» в ответе. Названия и числа скана модель не переписывает.
 */

/** Название инструмента. */
export const SCAN_COPY_TOOL = 'createScanPriceCopy';
/** Расширение выгрузки. */
const COPY_FORMAT = 'xlsx';
/** Окончание имени файла-копии: то же, что у `createPriceFileCopy`, файл заменяется в ходе. */
const COPY_SUFFIX = ' (копия)';
/** Предел правок за вызов. */
const MAX_EDITS = 50;
/** Предел позиций, которые модель может передать вместо распознанных кодом. */
const MAX_POSITIONS = 200;
/** Длина короткого хэша в ключе операции. */
const KEY_HASH_CHARS = 16;
/** Предупреждение парсера: текст получен распознаванием картинки. */
const RECOGNIZED_WARNING = /со скана|с изображения|с фото/iu;
/** Название листа копии. */
const SHEET_NAME = 'Счёт';
/** Сколько названий позиций показываем при отказе (остальные не нужны модели). */
const MAX_NAMES_LISTED = 30;

const STATUSES = [
  'sent',
  'no_match',
  'ambiguous',
  'not_a_scan',
  'nothing_read',
  'too_large',
] as const;

interface PositionInput {
  name: string;
  qty: number;
  price: number;
  sum?: number | undefined;
}

interface EditInput {
  match: string;
  newPrice: number;
  applyToAll?: boolean | undefined;
}

interface ScanCopyInput {
  path: string;
  edits: EditInput[];
  positions?: PositionInput[] | undefined;
}

const changeRowSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  qty: z.number().nullable(),
  unit: z.string(),
  oldPrice: z.number().nullable(),
  newPrice: z.number().nullable(),
  oldSum: z.number().nullable(),
  newSum: z.number().nullable(),
  changed: z.boolean(),
  doubts: z.array(z.enum(SCAN_DOUBTS)),
});

const doubtfulSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  reasons: z.array(z.string()),
  raw: z.string(),
});

interface ScanCopyOutput {
  status: (typeof STATUSES)[number];
  delivered: boolean;
  fileName?: string | undefined;
  /** Таблица «было / стало» с пометкой «распознано со скана»: покажите её сотруднику. */
  table: string;
  rows: ScanChangeRow[];
  /** Итого по скану до правки; null - не у всех позиций есть сумма. */
  oldTotal: number | null;
  /** Итого после правки, посчитанное кодом; null - не у всех позиций есть сумма. */
  newTotal: number | null;
  /** «Итого», напечатанное в самом скане, если прочитано. */
  statedTotal: number | null;
  /** Позиции с сомнительными числами: код их не правил, их сверяет сотрудник. */
  doubtful: ScanDoubtful[];
  message: string;
}

/** Ключ операции: тот же запрос на том же скане отправляется один раз. */
function copyKey(input: ScanCopyInput): string {
  return `prices-scan-copy:${stableHash(input).slice(0, KEY_HASH_CHARS)}`;
}

/** Имя файла без расширения и пути. */
function stemOf(name: string): string {
  const last = name.split(/[\\/]/u).pop() ?? name;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

function emptyOutput(status: ScanCopyOutput['status'], message: string): ScanCopyOutput {
  return {
    status,
    delivered: false,
    table: '',
    rows: [],
    oldTotal: null,
    newTotal: null,
    statedTotal: null,
    doubtful: [],
    message,
  };
}

/** Позиции, которые передала модель (исправленное чтение скана): код сверяет их арифметику. */
function linesFromPositions(positions: readonly PositionInput[]): ScanLine[] {
  return positions.map((position, index) => {
    const sum = position.sum ?? null;
    const doubts: ScanLine['doubts'] =
      sum !== null && !sumMatches(position.price, position.qty, sum) ? ['sum_mismatch'] : [];
    return {
      index: index + 1,
      name: position.name,
      qty: position.qty,
      unit: '',
      price: position.price,
      sum: sum ?? lineSum(position.price, position.qty),
      doubts,
      raw: position.name,
    };
  });
}

/** Текст, который читает код: распознанный текст скана, а при его отсутствии таблицы. */
function recognizedTextOf(parsed: { text: string; tables: string[][][] }): string {
  if (parsed.text.trim() !== '') return parsed.text;
  return parsed.tables
    .map((table) => table.map((row) => `| ${row.join(' | ')} |`).join('\n'))
    .join('\n');
}

/** Место в записи хода, где хранится последний набор позиций, переданный моделью. */
const POSITIONS_PLACE = 'positions';

const carriedPositionsSchema = z.object({
  positions: z
    .array(
      z.object({
        name: z.string(),
        qty: z.number(),
        price: z.number(),
        sum: z.number().optional(),
      }),
    )
    .optional(),
});

const carriedEditSchema = z.object({
  match: z.string(),
  newPrice: z.number(),
  applyToAll: z.boolean().optional(),
});

/** Правки и позиции хода: прежние вызовы этого хода плюс текущий (последний выигрывает). */
interface TurnWork {
  edits: EditInput[];
  positions: PositionInput[] | undefined;
}

/**
 * Правки хода накапливаются: второй вызов за ход несёт и правки первого, поэтому файл хода
 * (он заменяет прежний с тем же именем) содержит их все. Правка той же позиции заменяется.
 */
function mergeTurnWork(carried: readonly CarriedEdit[], input: ScanCopyInput): TurnWork {
  const edits = new Map<string, EditInput>();
  let positions: PositionInput[] | undefined;
  for (const item of carried) {
    if (item.place === POSITIONS_PLACE) {
      positions = carriedPositionsSchema.safeParse(item.spec).data?.positions ?? positions;
      continue;
    }
    const edit = carriedEditSchema.safeParse(item.spec);
    if (edit.success) edits.set(item.place, edit.data);
  }
  for (const edit of input.edits) edits.set(edit.match.toLowerCase(), edit);
  return { edits: [...edits.values()], positions: input.positions ?? positions };
}

/** Запись хода: правки по ключу позиции и последний набор позиций. */
function carriedOf(work: TurnWork): CarriedEdit[] {
  const edits = work.edits.map((edit) => ({ place: edit.match.toLowerCase(), spec: { ...edit } }));
  return work.positions === undefined
    ? edits
    : [...edits, { place: POSITIONS_PLACE, spec: { positions: work.positions } }];
}

/** Лист xlsx: позиции после правки, строка «Итого» и пометки. */
function sheetOf(rows: readonly ScanChangeRow[], newTotal: number | null): TableSheet {
  const body: TableCell[][] = rows.map((row) => [
    row.index,
    row.name,
    row.qty,
    row.unit,
    row.newPrice,
    row.newSum,
    notesOf(row),
  ]);
  body.push(['', 'Итого', null, '', null, newTotal, newTotal === null ? 'итог не посчитан' : '']);
  return {
    name: SHEET_NAME,
    columns: ['№', 'Наименование', 'Кол-во', 'Ед.', 'Цена', 'Сумма', 'Примечание'],
    rows: body,
  };
}

function notesOf(row: ScanChangeRow): string {
  const notes: string[] = [];
  if (row.changed) notes.push(`цена изменена, было ${formatMoney(row.oldPrice)}`);
  for (const reason of row.doubts) notes.push(`сверьте со сканом: ${DOUBT_LABELS[reason]}`);
  return notes.join('; ');
}

/**
 * Собрать xlsx-копию скана с новыми ценами и пересчитанными суммами и отправить её сотруднику.
 * Скан не меняется; позиции с сомнительными числами не правятся и перечислены в `doubtful`.
 */
export const createScanPriceCopy = defineTool<ScanCopyInput, ScanCopyOutput, PricesDeps>({
  name: SCAN_COPY_TOOL,
  readsFile: true,
  sideEffect: true,
  description:
    'Изменить цены в СКАНЕ или ФОТО счёта, прайса (jpg, png, pdf-скан) и отправить ' +
    'сотруднику xlsx-копию: сам скан не правится. path - идентификатор файла (listIntakeFiles ' +
    'или fileRef). edits - ВСЕ правки одним вызовом: match (слова из названия позиции, как ' +
    'назвал сотрудник: «кружки»), newPrice (новая цена за единицу), applyToAll=true, только ' +
    'если сотрудник просит менять все подходящие позиции. Распознанный текст читает КОД, цены, ' +
    'суммы позиций и итого считает КОД (цена x количество, до копейки, НДС не добавляется): ' +
    'числа не пересчитывай сам. positions - только если код прочитал скан неверно: ' +
    'исправленные позиции name, qty, price (sum не обязательна). В ответе table - таблица ' +
    '«было / стало» с пометкой «распознано со скана, сверьте»: покажите её сотруднику ' +
    'дословно вместе с message. doubtful - позиции с нечитаемыми или несошедшимися числами: ' +
    'они не правились, назовите их и попросите сверить с оригиналом. status=no_match или ' +
    'ambiguous - задайте сотруднику ОДИН вопрос с названиями из message, не угадывайте. ' +
    'status=nothing_read - скан не прочитан: действуйте по правилам про нечитаемый скан. ' +
    'status=not_a_scan - файл не скан: используйте editPriceInFile или createPriceFileCopy. ' +
    'За ход сотруднику уходит один файл.',
  inputSchema: z.object({
    path: z.string().min(1),
    edits: z
      .array(
        z.object({
          match: z.string().min(1),
          newPrice: z.number().positive(),
          applyToAll: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(MAX_EDITS),
    positions: z
      .array(
        z.object({
          name: z.string().min(1),
          qty: z.number().positive(),
          price: z.number().positive(),
          sum: z.number().nonnegative().optional(),
        }),
      )
      .min(1)
      .max(MAX_POSITIONS)
      .optional(),
  }),
  outputSchema: z.object({
    status: z.enum(STATUSES),
    delivered: z.boolean(),
    fileName: z.string().optional(),
    table: z.string(),
    rows: z.array(changeRowSchema),
    oldTotal: z.number().nullable(),
    newTotal: z.number().nullable(),
    statedTotal: z.number().nullable(),
    doubtful: z.array(doubtfulSchema),
    message: z.string(),
  }),
  idempotencyKey: copyKey,
  async execute(input, deps, context) {
    const exporter = requirePort(deps.tableExporter, 'выгрузка таблиц');
    const source = await openPriceSource(deps, input.path, context);
    const isImage = SCAN_EXTENSIONS.includes(extensionOf(source.name));
    if (isImage && deps.parser.readsImages !== true) {
      return emptyOutput('nothing_read', 'Фото прочитать нельзя: чтение картинок выключено.');
    }
    const parsed = await parseSource(deps.parser, source, deps.turnScope);
    const recognized = parsed.warnings.some((warning) => RECOGNIZED_WARNING.test(warning));
    if (!isImage && !recognized && !parsed.needsOcr) {
      return emptyOutput(
        'not_a_scan',
        'Файл не скан: у него есть текстовый слой. Меняйте цены через editPriceInFile, а ' +
          'копию с наценкой собирайте через createPriceFileCopy.',
      );
    }
    const reading = readScanText(parsed.needsOcr ? '' : recognizedTextOf(parsed));
    const turnKey = turnRecordKey(context, `scan:${input.path}`);
    const record = await loadTurnRecord(deps.state, turnKey);
    const work = mergeTurnWork(record.carried, input);
    const lines =
      work.positions === undefined ? reading.lines : linesFromPositions(work.positions);
    if (lines.length === 0) {
      return emptyOutput(
        'nothing_read',
        'Из скана не удалось прочитать позиции с ценами: файл не изменён и не отправлен. Это ' +
          'неудачное чтение скана: действуйте по правилам про нечитаемый скан.',
      );
    }
    const outcome = applyScanEdits(lines, work.edits);
    if (outcome.status === 'no_match') {
      const names = outcome.names.slice(0, MAX_NAMES_LISTED).join('; ');
      return emptyOutput(
        'no_match',
        `В скане нет позиции «${outcome.match}». Позиции скана: ${names}. Файл не отправлен: ` +
          'спросите сотрудника, какую позицию менять; не угадывайте.',
      );
    }
    if (outcome.status === 'ambiguous') {
      return emptyOutput(
        'ambiguous',
        `Под «${outcome.match}» подходит несколько позиций: ${outcome.candidates.join('; ')}. ` +
          'Файл не отправлен: спросите сотрудника, какую менять или менять все (applyToAll).',
      );
    }
    const sheet = sheetOf(outcome.rows, outcome.newTotal);
    try {
      validateTableSheets([sheet], COPY_FORMAT);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return emptyOutput('too_large', `Таблица не помещается в xlsx (${error.message}).`);
    }
    const stem = `${stemOf(source.name)}${COPY_SUFFIX}`;
    const file = await exporter.export([sheet], COPY_FORMAT, stem);
    const requesterThread =
      deps.state === undefined ? null : await chatThreadOf(deps.state, context);
    try {
      await deps.chat.sendFile(
        requesterThread ?? context.threadId,
        { name: file.fileName, mimeType: file.mimeType, content: file.bytes },
        `${copyKey(input)}:file`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'неизвестная причина';
      throw new DomainError(
        'external_failure',
        `Файл не доставлен: ${reason}. Сообщи сотруднику причину; файл не доставлен.`,
        { retryable: true },
      );
    }
    await saveTurnRecord(deps.state, turnKey, {
      sends: [{ key: copyKey(input), name: file.fileName }],
      carried: carriedOf(work),
    });
    const changed = outcome.rows.filter((row) => row.changed).length;
    const notRead =
      outcome.doubtful.length === 0
        ? ''
        : ` Не правились, сверьте со сканом: ${outcome.doubtful.map((d) => d.name).join('; ')}.`;
    const stated =
      reading.statedTotal !== null &&
      outcome.oldTotal !== null &&
      Math.abs(reading.statedTotal - outcome.oldTotal) > 0
        ? ` Итого в скане (${formatMoney(reading.statedTotal)}) не равно сумме прочитанных ` +
          `позиций (${formatMoney(outcome.oldTotal)}): сверьте.`
        : '';
    return {
      status: 'sent',
      delivered: true,
      fileName: file.fileName,
      table: changeTableMarkdown(outcome.rows, outcome),
      rows: outcome.rows,
      oldTotal: outcome.oldTotal,
      newTotal: outcome.newTotal,
      statedTotal: reading.statedTotal,
      doubtful: outcome.doubtful,
      message:
        `Копия подготовлена и уйдёт сотруднику одним файлом: позиций ${outcome.rows.length}, ` +
        `цен изменено ${changed}, итого ` +
        `${formatMoney(outcome.newTotal)}. Числа распознаны со скана, сверьте с оригиналом. ` +
        `Сам скан не менялся.${notRead}${stated}`,
    };
  },
});
