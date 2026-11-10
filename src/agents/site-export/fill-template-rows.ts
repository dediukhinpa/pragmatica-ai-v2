import { z } from 'zod';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../kit/domain/monitoring';
import { localDateKey } from '@business-ai/core';
import type { TemplateCellValue, TemplateWriteSkip } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { resolveEmployeeIdentity } from './employee-identity';
import type { SiteExportDeps } from './deps';
import { prepareCells, refineDescriptions } from './prepare-cells';
import { indexSheet, planFill, SKIP_REASONS, type PlanSkip, type PlannedEdit } from './fill-plan';
import { columnRole, findHeader, isBlank } from './template-columns';
import { readTurnSends } from './send-ledger';
import {
  mergeSizeUnresolved,
  sizeUnresolvedLabels,
  sizeUnresolvedWarning,
  type SizeUnresolvedEntry,
} from './size-unresolved';
import { loadWorkbook, requireWorkbook, saveWorkbook } from './template-store';

/** Позиций в одном вызове: задача до 300 позиций, вызов принимает все сразу. */
export const FILL_ITEMS_MAX = 300;
/** Ячеек в одной позиции. */
export const FILL_CELLS_PER_ITEM_MAX = 60;
/** Сколько пропусков показываем модели подробно; остальные сводятся по причинам. */
export const FILL_SKIPS_LISTED_MAX = 60;
/** Сколько значений списка предлагаем в подсказке о недостающей колонке. */
const MISSING_OPTIONS_MAX = 12;
/** Длина названия позиции в отчёте о незаполненных списках. */
const POSITION_LABEL_MAX = 60;
/** Строка шапки другого листа для его просмотра: заголовков там нет, строка 1 служебная. */
const OTHER_SHEET_HEADER_ROW = 1;

/** Одно измерение: число или текст с единицей («26 см»); одно число на поле. */
const dimensionSchema = z.union([z.string().min(1), z.number().finite()]);

/**
 * Размер упаковки с подписями осей (решение владельца 14). Порядок Ш×В×Г собирает код по
 * полям, а не по порядку чисел в источнике: агент раскладывает измерения по смыслу.
 */
const dimensionsSchema = z.object({
  /** Ширина. */
  width: dimensionSchema.optional(),
  /** Высота. */
  height: dimensionSchema.optional(),
  /** Глубина (толщина). */
  depth: dimensionSchema.optional(),
  /** «Длина» из источника: однозначна только в тройке «длина, высота, глубина». */
  length: dimensionSchema.optional(),
  /**
   * Числа БЕЗ подписей, порядок которых неизвестен (одной строкой, как в источнике). Код ничего
   * не пишет: ячейка остаётся пустой, позиция идёт в предупреждение. Не сочетается с полями осей.
   */
  unlabeled: z.string().min(1).optional(),
});

const cellSchema = z
  .object({
    /** Название колонки из шапки (можно начало названия) или её буква. */
    column: z.string().min(1),
    /** Текст или число. Стоимость, вес и т.п. передавай числом. */
    value: z.union([z.string(), z.number().finite()]).optional(),
    /**
     * Только для колонки «Размер упаковки» главного листа, вместо value: измерения с подписями
     * осей (width, height, depth) либо unlabeled, если порядок неизвестен.
     */
    dimensions: dimensionsSchema.optional(),
  })
  // value необязателен лишь потому, что размер можно передать через dimensions; ячейка без
  // обоих раньше тихо превращалась в пустую строку и уходила в empty_value без объяснения.
  .refine((cell) => cell.value !== undefined || cell.dimensions !== undefined, {
    message:
      'Ячейке нужен value; без value допустим только dimensions (столбец «Размер упаковки»).',
  });

const itemSchema = z.object({
  /**
   * Номер строки. Не задан - позиция идёт в первую свободную строку (проверка по названию и
   * артикулу). Чтобы исправить ранее записанную позицию, передай её row из прошлого ответа.
   */
  row: z.number().int().min(1).optional(),
  cells: z.array(cellSchema).min(1).max(FILL_CELLS_PER_ITEM_MAX),
});

const inputSchema = z.object({
  workbookId: z.string().min(1),
  /** Лист по имени; по умолчанию первый (рабочий лист оператора). Листы 2-4 - особый режим. */
  sheet: z.string().min(1).optional(),
  items: z.array(itemSchema).min(1).max(FILL_ITEMS_MAX),
  /**
   * Сотрудник ЯВНО просил (например, «заполни колонку N», «укажи раздел ...», «перезапиши»).
   * Только с непустым requestQuote.
   */
  requestedByEmployee: z.boolean().default(false),
  /** Дословная цитата просьбы сотрудника: обязательна при requestedByEmployee. */
  requestQuote: z.string().optional(),
  /** Сотрудник подтвердил запись на листы 2-4 после предупреждения о риске для сайта. */
  confirmedByEmployee: z.boolean().default(false),
  /** Заменить чужие непустые значения (по просьбе сотрудника). По умолчанию чужое не трогаем. */
  overwrite: z.boolean().default(false),
  /** Ставить менеджера и дату корректировки автоматически (по умолчанию да). */
  stampManager: z.boolean().default(true),
});

const skipSchema = z.object({
  item: z.number().int(),
  row: z.number().int().nullable(),
  column: z.string(),
  reason: z.string(),
  message: z.string(),
  hint: z.array(z.union([z.string(), z.number()])).optional(),
});

const outputSchema = z.object({
  workbookId: z.string(),
  sheet: z.string(),
  revision: z.number().int(),
  written: z.number().int(),
  /** Строка каждой позиции запроса (по порядку items); null - строки нет. */
  rows: z.array(z.object({ item: z.number().int(), row: z.number().int().nullable() })),
  skippedTotal: z.number().int(),
  skippedByReason: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  skipped: z.array(skipSchema),
  /** Значения, записанные сверх запроса кодом: менеджер и дата. */
  stamped: z.object({
    managerName: z.string().optional(),
    date: z.string().optional(),
    /** Что кодом не поставлено и почему (колонка, причина). */
    notStamped: z.array(
      z.object({ row: z.number().int(), column: z.string(), reason: z.string() }),
    ),
  }),
  /** Устарело: вопросы до выдачи не задаются, недостающее идёт в warnings. Всегда пусто. */
  askEmployee: z.array(z.string()),
  /**
   * Записанные позиции, у которых жёлтая колонка со списком осталась пустой. Это
   * предупреждение: оставь пустой, не выдумывай значение, вынеси в список предупреждений
   * итога (колонка, позиция, варианты из options).
   */
  missingListValues: z.array(
    z.object({
      row: z.number().int(),
      position: z.string(),
      columns: z.array(
        z.object({
          column: z.string(),
          options: z.array(z.union([z.string(), z.number()])),
          listSize: z.number().int(),
        }),
      ),
    }),
  ),
  overwrittenCells: z.array(z.string()),
  /**
   * Единица столбца «Размер упаковки», в которой записан размер: по шапке книги (assumed=false)
   * или мм по умолчанию, когда в шапке единицы нет (assumed=true). Назови её сотруднику.
   */
  sizeUnits: z
    .array(z.object({ column: z.string(), unit: z.string(), assumed: z.boolean() }))
    .optional(),
  /**
   * Позиции, у которых размер есть в источнике, но не записан: порядок Ш×В×Г определить нельзя
   * либо запись не разобрана (решение владельца 15). Ячейка пуста, сотруднику вопросов не
   * задаём. Список накопительный по книге (все пакеты), строку предупреждения собирает код.
   */
  sizeUnresolved: z.array(z.string()).optional(),
  warnings: z.array(z.string()),
  /** Первая свободная строка после записи и неизменность структуры. */
  nextFreeRow: z.number().int().optional(),
  sheetsCount: z.number().int().optional(),
  columnsCount: z.number().int().optional(),
  structureUnchanged: z.boolean().optional(),
});
type Output = z.infer<typeof outputSchema>;

function positionLabel(
  value: string | number | boolean | undefined,
  fallback: string,
): string {
  const text = value === undefined ? fallback : String(value);
  return text.length > POSITION_LABEL_MAX ? `${text.slice(0, POSITION_LABEL_MAX)}...` : text;
}

/** Пакетная запись позиций в шаблон заказчика по названиям колонок. */
export const fillTemplateRows = defineTool<z.infer<typeof inputSchema>, Output, SiteExportDeps>({
  name: 'fillTemplateRows',
  description:
    'Записать позиции в рабочую книгу workbookId пакетом (до 300 позиций за вызов). items - ' +
    'позиции: cells = [{column, value}], column - название колонки из шапки или её буква, ' +
    'НЕ угадывай буквы: бери из readTemplateStructure. Без row позиция идёт в первую ' +
    'свободную строку; чтобы исправить уже записанную позицию, передай её row из прошлого ' +
    'ответа (иначе будет дубль). Правила проверяет код: пишутся только ЖЕЛТЫЕ колонки ' +
    'листа 1; нежёлтые - только при requestedByEmployee=true и requestQuote с цитатой ' +
    'просьбы сотрудника (not_yellow_column иначе); «Оператор» и строки 1-11 не меняются ' +
    'никогда (protected_area); «месяц первичной загрузки» не заполняется (not_filled_by_rule), ' +
    'разве что по явной просьбе; менеджера и дату корректировки ставит код сам (имя из ' +
    'каталога, не из текста), поставщика ставишь ты обычной ячейкой; для колонок со списком ' +
    'допустимо ТОЛЬКО значение из списка файла (без учёта регистра; записывается значение ' +
    'списка), иначе not_in_list (ячейка пуста, в предупреждения; значение, которое назвал ' +
    'сам сотрудник с requestQuote, пишется как есть с предупреждением); ' +
    'чужие непустые ячейки не затираются (cell_not_empty), перезапись - overwrite=true по ' +
    'явной просьбе. Листы 2-4 (sheet) - ' +
    'только при requestedByEmployee и confirmedByEmployee: сначала предупреди сотрудника, ' +
    'что сайт может не принять файл, дождись подтверждения; колонка там буквой, row обязателен. ' +
    'Ответ: written, row каждой позиции, skipped с причинами, missingListValues - позиции с ' +
    'пустой жёлтой колонкой со списком (оставь пустой и вынеси в предупреждения итога, не ' +
    'спрашивай до выдачи), warnings - что вынести в предупреждения.',
  inputSchema,
  outputSchema,
  async execute(input, deps, context) {
    assertEmployeeChatTurn(context);
    const workbook = requireWorkbook(deps);
    const loaded = await loadWorkbook(deps, input.workbookId);
    const { headerRow } = loaded.record;
    const main = await workbook.inspect({
      bytes: loaded.bytes,
      headerRow,
      signal: context.signal,
    });
    const mainSheet = main.sheet;
    const sheetName = input.sheet ?? mainSheet;
    const isMainSheet = sheetName === mainSheet;
    const structure = isMainSheet
      ? main
      : await workbook.inspect({
          bytes: loaded.bytes,
          headerRow: OTHER_SHEET_HEADER_ROW,
          sheet: sheetName,
          signal: context.signal,
        });
    const hasRequest =
      input.requestedByEmployee && !isBlank(input.requestQuote ?? '');
    const warnings: string[] = [];
    if (input.requestedByEmployee && !hasRequest) {
      warnings.push('requestedByEmployee без requestQuote не учитывается: нужна цитата просьбы.');
    }
    if (structure.headers.length === 0 && isMainSheet) {
      warnings.push('В шапке файла нет заголовков: проверь, что это шаблон сайта.');
    }

    // Автополя: имя из каталога сотрудников (не из текста), дата по часам в поясе бизнеса.
    const askEmployee: string[] = [];
    let managerName: string | null = null;
    let dateIso: string | null = null;
    const stampEnabled = input.stampManager && isMainSheet;
    if (stampEnabled) {
      const identity = await resolveEmployeeIdentity(deps, context);
      if (identity.status === 'known') managerName = identity.fullName;
      else {
        // Имя не выдумываем и вопросом результат не задерживаем: колонка пуста + предупреждение.
        warnings.push(
          'Менеджер не проставлен: сотрудника нет в каталоге, колонка осталась пустой.',
        );
      }
      if (deps.clock === undefined) {
        warnings.push('Часы не подключены: дата корректировки не поставлена.');
      } else {
        const zone = deps.businessTimeZone ?? DEFAULT_BUSINESS_TIMEZONE;
        dateIso = localDateKey(deps.clock.now(), zone);
      }
    }

    const written = new Set(loaded.record.written);
    const index = indexSheet(structure, !isMainSheet);
    // Пробелы и размер по единице шапки - локально, до плана и без модели (этап 225).
    const prepared = prepareCells({
      items: input.items.map((item) => ({
        ...item,
        cells: item.cells.map(({ value, ...cell }) => ({ ...cell, value: value ?? '' })),
      })),
      structure,
      isMainSheet,
    });
    warnings.push(...prepared.warnings);
    const planInput = {
      sheet: sheetName,
      isMainSheet,
      structure,
      index,
      verdicts: prepared.verdicts,
      permissions: {
        requested: hasRequest,
        confirmed: input.confirmedByEmployee,
        overwrite: input.overwrite,
      },
      written,
      stamp: { enabled: stampEnabled, managerName, dateIso },
    };
    // Правка описаний моделью - только для ячеек, которые план принял: чужие непустые ячейки,
    // защищённые строки и дубли в модель не уходят. Затем план повторяется уже с принятыми
    // текстами и полной проверкой предела (при выключенном редакторе предел держит первый план).
    const editor = isMainSheet ? deps.textEditor : undefined;
    let plan = planFill({
      ...planInput,
      items: prepared.items,
      deferDescriptionLimit: editor !== undefined,
    });
    if (editor !== undefined) {
      const refined = await refineDescriptions({
        plan,
        items: prepared.items,
        structure,
        editor,
        signal: context.signal ?? new AbortController().signal,
        threadId: context.threadId,
      });
      warnings.push(...refined.warnings);
      plan = planFill({
        ...planInput,
        items: refined.items,
        verdicts: new Map([...prepared.verdicts, ...refined.verdicts]),
      });
    }

    // Предупреждение о размерах собирает код (решение владельца 15), по накопленному списку
    // книги: пакетов может быть несколько, а итог пишет модель в самом конце. Подписи позиций
    // без названия берутся из строки листа плана - она уникальна между пакетами.
    const storedUnresolved = loaded.record.sizeUnresolved ?? [];
    const sizeEntries: SizeUnresolvedEntry[] = mergeSizeUnresolved({
      stored: storedUnresolved,
      fresh: prepared.sizeUnresolved,
      rows: plan.rows,
      resolvedItems: prepared.sizeResolved,
      batchTag: loaded.record.revision + 1,
    });
    const sizeUnresolved = sizeUnresolvedLabels(sizeEntries);
    if (sizeEntries.length > 0) warnings.push(sizeUnresolvedWarning(sizeEntries));
    const sizeUnresolvedChanged = JSON.stringify(sizeEntries) !== JSON.stringify(storedUnresolved);

    const skips: PlanSkip[] = [...plan.skips];
    let writtenCount = 0;
    let revision = loaded.record.revision;
    let afterWrite = { sheets: structure.sheets.length, columns: structure.headers.length };
    let nextFreeRow: number | undefined;
    const okEdits: PlannedEdit[] = [];
    if (plan.edits.length > 0) {
      const result = await workbook.writeCells({
        bytes: loaded.bytes,
        edits: plan.edits.map(toServiceEdit),
        signal: context.signal,
      });
      const refused = new Map<string, TemplateWriteSkip>();
      for (const item of result.skipped) refused.set(`${item.sheet}|${item.ref ?? ''}`, item);
      for (const edit of plan.edits) {
        const refusal = refused.get(`${edit.sheet}|${edit.ref}`);
        if (refusal === undefined) {
          okEdits.push(edit);
        } else if (!edit.stamped) {
          skips.push({
            itemIndex: edit.itemIndex,
            row: edit.row,
            column: edit.column,
            reason: refusal.reason as PlanSkip['reason'],
            message: `Сервис не записал ячейку ${edit.ref}: ${refusal.reason}.`,
          });
        } else {
          plan.stampSkipped.push({ row: edit.row, column: edit.column, reason: refusal.reason });
        }
      }
      writtenCount = result.written;
      if (result.written !== okEdits.length) {
        warnings.push(
          `Сервис записал ${result.written} ячеек из ${okEdits.length} запланированных: ` +
            'проверь файл перед выдачей.',
        );
      }
      if (result.needsDateStyle.length > 0) {
        warnings.push(
          'Дата записана в ячейки без датового формата (' +
            result.needsDateStyle.map((cell) => cell.ref).join(', ') +
            '): в файле она видна числом. Скажи об этом сотруднику.',
        );
      }
      if (writtenCount > 0) {
        revision += 1;
        const refs = okEdits.map((edit) => `${edit.sheet}!${edit.ref}`);
        await saveWorkbook(
          deps,
          loaded.id,
          {
            bytes: result.bytes,
            fileName: loaded.record.fileName,
            source: loaded.record.source,
            headerRow,
            revision,
            written: [...new Set([...loaded.record.written, ...refs])],
            sizeUnresolved: sizeEntries,
          },
          loaded.record.revision,
        );
        const after = await workbook.inspect({
          bytes: result.bytes,
          headerRow,
          signal: context.signal,
        });
        nextFreeRow = after.firstFreeRow;
        afterWrite = { sheets: after.sheets.length, columns: after.headers.length };
        for (const edit of okEdits) index.values.set(edit.ref, edit.value);
      }
    }

    // Ничего не записано, а список позиций без размера изменился: сохраняем только его, версия
    // файла (revision) и байты прежние - повторная выдача файла из-за этого не нужна.
    if (writtenCount === 0 && sizeUnresolvedChanged) {
      await saveWorkbook(
        deps,
        loaded.id,
        {
          bytes: loaded.bytes,
          fileName: loaded.record.fileName,
          source: loaded.record.source,
          headerRow,
          revision: loaded.record.revision,
          written: loaded.record.written,
          sizeUnresolved: sizeEntries,
        },
        loaded.record.revision,
      );
    }

    // Файл в этом ходе уже ушёл: подсказка нужна модели, а не сотруднику.
    const issued = await readTurnSends(deps, loaded.id, context.turnNumber);
    if (issued !== null) {
      warnings.push(
        'Файл уже выдан сотруднику в этом обращении. Перед повторной выдачей убедись, что ' +
          'правка нужна сотруднику; если да - одной короткой фразой скажи, что исправлено.',
      );
    }

    const missingListValues: Output['missingListValues'] = [];
    if (isMainSheet) {
      const writtenRows = new Set(okEdits.filter((edit) => !edit.stamped).map((edit) => edit.row));
      const nameHeader = findHeader(structure.headers, 'name');
      const skuHeader = findHeader(structure.headers, 'sku');
      for (const row of [...writtenRows].sort((a, b) => a - b)) {
        const columns = structure.headers
          .filter((header) => header.yellow && columnRole(header) === 'plain')
          .filter((header) => header.allowedValues !== null || header.listUnresolved)
          .filter((header) => isBlank(index.values.get(`${header.letter}${row}`)))
          .map((header) => ({
            column: header.text,
            options: (header.allowedValues ?? []).slice(0, MISSING_OPTIONS_MAX),
            listSize: header.allowedValues?.length ?? 0,
          }));
        if (columns.length === 0) continue;
        const label = positionLabel(
          index.values.get(`${nameHeader?.letter ?? ''}${row}`) ??
            index.values.get(`${skuHeader?.letter ?? ''}${row}`),
          `строка ${row}`,
        );
        missingListValues.push({ row, position: label, columns });
      }
    }

    warnings.push(...plan.warnings);
    const byReason = new Map<string, number>();
    for (const item of skips) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    const reasonOrder = (reason: string): number => {
      const position = (SKIP_REASONS as readonly string[]).indexOf(reason);
      return position < 0 ? SKIP_REASONS.length : position;
    };
    deps.fileLog?.('site_template_filled', {
      written: writtenCount,
      skipped: skips.length,
      items: input.items.length,
      mainSheet: isMainSheet,
    });
    return {
      workbookId: loaded.id,
      sheet: sheetName,
      revision,
      written: writtenCount,
      rows: plan.rows.map((row, item) => ({ item, row })),
      skippedTotal: skips.length,
      skippedByReason: [...byReason.entries()]
        .sort(([a], [b]) => reasonOrder(a) - reasonOrder(b))
        .map(([reason, count]) => ({ reason, count })),
      skipped: skips.slice(0, FILL_SKIPS_LISTED_MAX).map((item) => ({
        item: item.itemIndex,
        row: item.row,
        column: item.column,
        reason: item.reason,
        message: item.message,
        ...(item.hint === undefined ? {} : { hint: item.hint }),
      })),
      stamped: {
        ...(managerName === null || !okEdits.some((edit) => edit.stamped)
          ? {}
          : { managerName }),
        ...(dateIso === null || !okEdits.some((edit) => edit.stamped) ? {} : { date: dateIso }),
        notStamped: plan.stampSkipped,
      },
      askEmployee,
      missingListValues,
      overwrittenCells: plan.overwritten,
      ...(prepared.sizeUnits.length === 0 ? {} : { sizeUnits: prepared.sizeUnits }),
      ...(sizeUnresolved.length === 0 ? {} : { sizeUnresolved }),
      warnings,
      ...(nextFreeRow === undefined ? {} : { nextFreeRow }),
      sheetsCount: afterWrite.sheets,
      columnsCount: afterWrite.columns,
      structureUnchanged:
        afterWrite.sheets === structure.sheets.length &&
        afterWrite.columns === structure.headers.length,
    };
  },
});

function toServiceEdit(edit: PlannedEdit): {
  sheet: string;
  row: number;
  letter: string | undefined;
  value: TemplateCellValue;
  kind: 'date' | undefined;
} {
  return {
    sheet: edit.sheet,
    row: edit.row,
    letter: edit.letter,
    value: edit.value,
    kind: edit.kind === 'date' ? 'date' : undefined,
  };
}
