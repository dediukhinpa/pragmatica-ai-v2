import { z } from 'zod';
import { DomainError, defineTool, requirePort, validateTableSheets } from '@business-ai/core';
import type { TableCell, TableSheet } from '@business-ai/core';
import { chatThreadOf } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import type { PricesDeps } from '../agents/prices/deps';
import { parseSource } from '../agents/prices/parse-cache';
import { openPriceSource } from '../agents/prices/price-sources';
import { scalePriceText, SCALE_MAX_DECIMALS } from './price-text-scale';

/**
 * Копия прайса в xlsx, собранная кодом (этап 9t, живой баг: большой docx со 212 картинками).
 *
 * Раньше копию собирала модель: разбирала таблицу скриптом и передавала ВСЕ строки в
 * `createFile`. Результат скрипта до модели доходит только в пределах 20 тыс. знаков и 200
 * строк, а переписать сотни строк в один вызов она не может (предел ответа модели): ход
 * заканчивался без текста. Здесь таблицы читаются из файла напрямую, цены меняются кодом, xlsx
 * уходит сотруднику, а модели возвращается короткая сводка.
 */

/** Наценка: больше - почти наверняка ошибка ввода. */
const MAX_MULTIPLIER = 100;
/** Снижение в процентах не больше этого: -100 дало бы нулевые цены. */
const MAX_DECREASE_PERCENT = 99;
/** Увеличение в процентах не больше этого. */
const MAX_INCREASE_PERCENT = 10_000;
const PERCENT = 100;
/** Столбцов цен за один вызов не больше этого. */
const MAX_PRICE_COLUMNS = 10;
/** Сколько пропущенных ячеек перечисляем модели (остальные - числом). */
const MAX_SKIPPED_LISTED = 30;
/** Сколько названий шапки показываем в вопросе о неизвестном столбце. */
const MAX_HEADERS_LISTED = 30;
/** Предел длины имени листа Excel. */
const SHEET_NAME_MAX_CHARS = 31;
/** Знаки, которых нет в имени листа Excel. */
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/gu;
/** Длина короткого хэша в ключе операции. */
const KEY_HASH_CHARS = 16;
/** Шапка похожа на столбец цены: «Цена», «Цена опт», «Стоимость», «Розница», «руб.». */
const PRICE_HEADER = /(?:цен|стоим|price|опт|розн|руб)/iu;
/** Расширение выгрузки. */
const COPY_FORMAT = 'xlsx';
/** Окончание имени файла-копии. */
const COPY_SUFFIX = ' (копия)';
const STATUSES = ['sent', 'unknown_column', 'too_large', 'nothing_to_copy'] as const;

interface CopyInput {
  path: string;
  multiplier?: number | undefined;
  percent?: number | undefined;
  priceColumns?: string[] | undefined;
  decimals?: number | undefined;
}

const skippedSchema = z.object({ place: z.string(), reason: z.string() });

interface CopyOutput {
  status: (typeof STATUSES)[number];
  delivered: boolean;
  fileName?: string | undefined;
  sheets: number;
  rows: number;
  changed: number;
  skippedCount: number;
  skipped: Array<z.infer<typeof skippedSchema>>;
  /** Столбцы, цены в которых изменены (по шапке файла). */
  changedColumns: string[];
  message: string;
}

/** Нормализация названия столбца для сравнения: регистр и пробелы не важны. */
function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Имя листа Excel: без запретных знаков, не длиннее 31 знака, уникальное. */
function sheetNameOf(raw: string, taken: Set<string>): string {
  const base = raw.replace(SHEET_NAME_FORBIDDEN, ' ').replace(/\s+/gu, ' ').trim();
  const short = (base === '' ? 'Лист' : base).slice(0, SHEET_NAME_MAX_CHARS);
  let name = short;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const suffix = ` ${n}`;
    name = `${short.slice(0, SHEET_NAME_MAX_CHARS - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** Имя файла без расширения и пути. */
function stemOf(name: string): string {
  const last = name.split(/[\\/]/u).pop() ?? name;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/** Уникальные непустые названия столбцов по шапке таблицы. */
function columnNames(header: readonly string[], width: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const text = (header[index] ?? '').trim();
    const base = text === '' ? `Столбец ${index + 1}` : text;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/** Столбцы таблицы, в которых правятся цены. */
function priceColumnsOf(
  header: readonly string[],
  width: number,
  wanted: ReadonlySet<string> | undefined,
): Set<number> {
  const found = new Set<number>();
  for (let index = 0; index < width; index += 1) {
    const title = normalizeHeader(header[index] ?? '');
    const match = wanted === undefined ? PRICE_HEADER.test(title) : wanted.has(title);
    if (match) found.add(index);
  }
  return found;
}

/** Множитель из ввода: наценка либо процент; без обоих - копия без изменения цен. */
function factorOf(input: CopyInput): number {
  if (input.multiplier !== undefined && input.percent !== undefined) {
    throw new DomainError('invalid_input', 'Передайте либо multiplier, либо percent, не оба.');
  }
  if (input.multiplier !== undefined) return input.multiplier;
  return input.percent === undefined ? 1 : 1 + input.percent / PERCENT;
}

/** Ключ операции: один и тот же запрос на одном файле отправляется один раз. */
function copyKey(input: CopyInput): string {
  return `prices-source-copy:${stableHash(input).slice(0, KEY_HASH_CHARS)}`;
}

const emptyOutput = (message: string, status: CopyOutput['status']): CopyOutput => ({
  status,
  delivered: false,
  sheets: 0,
  rows: 0,
  changed: 0,
  skippedCount: 0,
  skipped: [],
  changedColumns: [],
  message,
});

/**
 * Собрать xlsx-копию прайса (все таблицы файла - листы), поменять цены кодом и отправить файл
 * сотруднику. Исходный файл не меняется.
 */
export const createPriceFileCopy = defineTool<CopyInput, CopyOutput, PricesDeps>({
  name: 'createPriceFileCopy',
  readsFile: true,
  sideEffect: true,
  description:
    'Собрать XLSX-КОПИЮ прайса из файла сотрудника (docx, doc, pdf с текстовым слоем, pptx, ' +
    'xls, xlsx, csv) и отправить её сотруднику: каждая таблица файла - отдельный лист, цены ' +
    'меняет КОД, а не вы. Используйте вместо createFile и runDataScript, когда сотрудник ' +
    'согласился на xlsx-копию с новыми ценами (наценка, «умножь на 2,074», «плюс 10%») или ' +
    'просто попросил прайс в xlsx: большую таблицу через ваш ответ не передать, она не ' +
    'поместится. path - идентификатор файла (listIntakeFiles или fileRef). Наценка: ' +
    'multiplier (2.074 - цена x 2,074) ИЛИ percent (+107.4 - то же самое); без обоих цены не ' +
    'меняются. Цены текстом («140р», «190 р.», «800 рублей», «1 200,50 руб.») меняются в ' +
    'записи исходной ячейки; «от 100», диапазоны и тиражи не меняются и приходят в skipped. ' +
    'Если сотрудник назвал столбцы цен, передайте priceColumns точно как в шапке; иначе ' +
    'правятся ячейки со знаком валюты и столбцы с «цена», «опт», «розн», «руб» в шапке: ' +
    'назовите сотруднику changedColumns из ответа. decimals (0-4) - знаков после запятой; ' +
    'без него как в ячейке. Картинки и оформление в копию не переносятся (только таблицы): ' +
    'скажите об этом сотруднику. status=unknown_column - спросите сотрудника одним вопросом ' +
    'со списком столбцов из message. status=too_large - таблица не помещается в xlsx, ' +
    'передайте причину из message. Сообщите сотруднику числа и message дословно.',
  inputSchema: z.object({
    path: z.string().min(1),
    multiplier: z.number().positive().max(MAX_MULTIPLIER).optional(),
    percent: z.number().gt(-MAX_DECREASE_PERCENT).max(MAX_INCREASE_PERCENT).optional(),
    priceColumns: z.array(z.string().min(1)).max(MAX_PRICE_COLUMNS).optional(),
    decimals: z.number().int().min(0).max(SCALE_MAX_DECIMALS).optional(),
  }),
  outputSchema: z.object({
    status: z.enum(STATUSES),
    delivered: z.boolean(),
    fileName: z.string().optional(),
    sheets: z.number().int(),
    rows: z.number().int(),
    changed: z.number().int(),
    skippedCount: z.number().int(),
    skipped: z.array(skippedSchema),
    changedColumns: z.array(z.string()),
    message: z.string(),
  }),
  idempotencyKey: copyKey,
  async execute(input, deps, context) {
    const factor = factorOf(input);
    const requested = input.multiplier !== undefined || input.percent !== undefined;
    const exporter = requirePort(deps.tableExporter, 'выгрузка таблиц');
    const source = await openPriceSource(deps, input.path, context);
    const parsed = await parseSource(deps.parser, source, deps.turnScope);
    const tables = parsed.tables.filter((table) => table.length > 0);
    if (parsed.needsOcr || tables.length === 0) {
      return emptyOutput(
        'В файле нет таблиц с текстом (скан, фото или текст без таблиц): копию собрать нельзя.',
        'nothing_to_copy',
      );
    }
    const wanted =
      input.priceColumns === undefined
        ? undefined
        : new Set(input.priceColumns.map((title) => normalizeHeader(title)));
    const resolvedNames = new Set<string>();
    const names = new Set<string>();
    const changedColumns = new Set<string>();
    const skipped: Array<{ place: string; reason: string }> = [];
    let changed = 0;
    let skippedCount = 0;
    let rowsTotal = 0;
    const sheets: TableSheet[] = [];
    const allHeaders: string[] = [];
    parsed.tables.forEach((table, tableIndex) => {
      if (table.length === 0) return;
      const header = table[0]?.map((cell) => String(cell)) ?? [];
      const width = Math.max(...table.map((row) => row.length));
      const columns = columnNames(header, width);
      allHeaders.push(...header.map((title) => title.trim()).filter((title) => title !== ''));
      const priced = priceColumnsOf(header, width, wanted);
      for (const index of priced) resolvedNames.add(normalizeHeader(header[index] ?? ''));
      const title = parsed.tableNames?.[tableIndex] ?? `Таблица ${sheets.length + 1}`;
      const sheetName = sheetNameOf(title, names);
      const rows: TableCell[][] = [];
      table.slice(1).forEach((row, rowIndex) => {
        const cells: TableCell[] = [];
        for (let col = 0; col < width; col += 1) {
          const raw = String(row[col] ?? '');
          if (!requested) {
            cells.push(raw);
            continue;
          }
          const outcome = scalePriceText(raw, {
            factor,
            decimals: input.decimals,
            // Названные сотрудником столбцы правятся и без знака валюты; без названия - только
            // столбцы с «ценой» в шапке и ячейки со знаком валюты.
            allowBare: priced.has(col),
          });
          if (outcome.kind === 'scaled') {
            changed += 1;
            changedColumns.add(columns[col] ?? `Столбец ${col + 1}`);
            cells.push(outcome.cell);
          } else {
            if (outcome.kind === 'skipped') {
              skippedCount += 1;
              if (skipped.length < MAX_SKIPPED_LISTED) {
                skipped.push({
                  place: `лист «${sheetName}», строка ${rowIndex + 2}, ${columns[col] ?? col + 1}`,
                  reason: outcome.reason,
                });
              }
            }
            cells.push(raw);
          }
        }
        rows.push(cells);
      });
      rowsTotal += rows.length;
      sheets.push({ name: sheetName, columns, rows });
    });
    if (wanted !== undefined) {
      const unknown = [...wanted].filter((title) => !resolvedNames.has(title));
      if (unknown.length > 0) {
        const listed = [...new Set(allHeaders)].slice(0, MAX_HEADERS_LISTED).join('; ');
        return emptyOutput(
          `Столбцы цен не найдены в шапке файла: ${unknown.join('; ')}. Столбцы шапки: ` +
            `${listed}. Спросите сотрудника, в каких столбцах менять цены; не выдумывайте.`,
          'unknown_column',
        );
      }
    }
    try {
      validateTableSheets(sheets, COPY_FORMAT);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return emptyOutput(
        `Таблица слишком велика для xlsx-копии (${error.message}). Файл не отправлен: ` +
          'предложите сотруднику файл полегче или правку по частям.',
        'too_large',
      );
    }
    if (requested && changed === 0) {
      return {
        ...emptyOutput(
          'Ни одна цена не изменена, файл не отправлен: цен в ожидаемом виде не найдено. ' +
            'Уточните у сотрудника столбцы цен и передайте priceColumns.',
          'nothing_to_copy',
        ),
        skippedCount,
        skipped,
      };
    }
    const fileStem = `${stemOf(source.name)}${COPY_SUFFIX}`;
    const file = await exporter.export(sheets, COPY_FORMAT, fileStem);
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
    return {
      status: 'sent',
      delivered: true,
      fileName: file.fileName,
      sheets: sheets.length,
      rows: rowsTotal,
      changed,
      skippedCount,
      skipped,
      changedColumns: [...changedColumns],
      message:
        `Копия отправлена: листов ${sheets.length}, строк ${rowsTotal}, изменено цен ${changed}` +
        `${skippedCount > 0 ? `, не изменено (см. skipped): ${skippedCount}` : ''}. ` +
        'Исходный файл не менялся, картинки и оформление в копию не переносились.',
    };
  },
});
