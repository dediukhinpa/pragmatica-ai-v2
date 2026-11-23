import { z } from 'zod';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../kit/domain/monitoring';
import { PRICE_FILE_STALE_MONTHS } from '../../kit/domain/price-file-date';
import { YEAR_ANCHOR_LABELS } from '../../kit/domain/price-file-year-anchor';
import { localDateKey } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import type { PricesDeps } from './deps';
import { formatFileDate, scanStalePriceFiles, type PriceFileItem } from './stale-price-files';

/** Сколько устаревших файлов отдаётся модели за вызов (остаток - числом). */
export const STALE_FILES_LISTED_LIMIT = 100;
/** Сколько прайсов без даты в названии отдаётся модели за вызов (остаток - числом). */
export const UNDATED_FILES_LISTED_LIMIT = 50;

const staleFileSchema = z.object({
  path: z.string(),
  /** Поставщик по истории импортов или названию в пути; не задан - не определён. */
  supplier: z.string().optional(),
  /** Дата из названия файла: `ДД.ММ.ГГГГ` или `ММ.ГГГГ`. */
  dateInName: z.string(),
  /** Откуда взят год, если в названии его нет. */
  yearFrom: z.string().optional(),
});
type StaleFile = z.infer<typeof staleFileSchema>;

const undatedFileSchema = z.object({
  path: z.string(),
  supplier: z.string().optional(),
});
type UndatedFile = z.infer<typeof undatedFileSchema>;

interface StalePriceFilesOutput {
  today: string;
  staleMonths: number;
  stale: StaleFile[];
  moreStale: number;
  undated: UndatedFile[];
  moreUndated: number;
}

function toStale(item: PriceFileItem): StaleFile {
  if (item.date === null) throw new Error('stale_file_without_date');
  return {
    path: item.entry.path,
    ...(item.supplier === null ? {} : { supplier: item.supplier.name }),
    dateInName: formatFileDate(item.date),
    ...(item.yearSource === undefined ? {} : { yearFrom: YEAR_ANCHOR_LABELS[item.yearSource] }),
  };
}

function toUndated(item: PriceFileItem): UndatedFile {
  return {
    path: item.entry.path,
    ...(item.supplier === null ? {} : { supplier: item.supplier.name }),
  };
}

/**
 * Прайс-файлы диска, устаревшие по дате в названии, - по запросу сотрудника. Тот же отбор, что
 * у понедельничной рассылки (`scanStalePriceFiles`: область PRICE_STALE_*, признак прайса,
 * вывод года), без рассылки и без запасного разбора даты моделью. Дата изменения файла
 * устаревание не определяет. Сегодняшняя дата возвращается в ответе: модели её больше неоткуда
 * взять, а выводить её из дат файлов нельзя.
 */
export const listStalePriceFiles = defineTool<
  Record<string, never>,
  StalePriceFilesOutput,
  PricesDeps
>({
  name: 'listStalePriceFiles',
  description:
    `Прайс-файлы на сетевом диске, у которых дата В НАЗВАНИИ старше ${PRICE_FILE_STALE_MONTHS} ` +
    'месяцев (дата изменения файла не учитывается), и прайсы без даты в названии. Та же ' +
    'область и правила, что у понедельничной проверки (архивы и «не брать» исключены). ' +
    'today - сегодняшняя дата (ГГГГ-ММ-ДД).',
  inputSchema: z.object({}),
  outputSchema: z.object({
    today: z.string(),
    staleMonths: z.number().int(),
    stale: z.array(staleFileSchema),
    moreStale: z.number().int(),
    undated: z.array(undatedFileSchema),
    moreUndated: z.number().int(),
  }),
  async execute(_input, deps) {
    const now = deps.clock.now();
    const timezone = deps.businessTimeZone ?? DEFAULT_BUSINESS_TIMEZONE;
    const { stale, undated } = await scanStalePriceFiles(deps, now, timezone, {
      modelFallback: false,
    });
    return {
      today: localDateKey(now, timezone),
      staleMonths: PRICE_FILE_STALE_MONTHS,
      stale: stale.slice(0, STALE_FILES_LISTED_LIMIT).map(toStale),
      moreStale: Math.max(0, stale.length - STALE_FILES_LISTED_LIMIT),
      undated: undated.slice(0, UNDATED_FILES_LISTED_LIMIT).map(toUndated),
      moreUndated: Math.max(0, undated.length - UNDATED_FILES_LISTED_LIMIT),
    };
  },
});
