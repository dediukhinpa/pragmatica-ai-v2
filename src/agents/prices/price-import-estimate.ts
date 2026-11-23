import { estimateCallCostUsd, type ModelPriceTable } from '@business-ai/core';
import { extensionOf } from '@business-ai/core';
import { MAX_MARKDOWN_CHARS } from './read-price-file';
import { PRICE_DISK_SYNC_INTERVAL_MS, PRICE_DISK_SYNC_MAX_FILES } from './price-disk-sync';

/**
 * Смета первичного импорта прайсов (без вызовов модели): по длине текста файлов оценивает
 * токены и стоимость в рублях с учётом кэша промпта. Метод и допущения печатаются вместе с
 * результатом: константы ниже - замеры и допущения, а не точный счёт.
 */

/**
 * Шагов агента на файл, у которого текст помещается в одну страницу чтения: readPriceFile,
 * normalizePriceTable, savePriceImport (или стадия больших прайсов), новая карточка при
 * необходимости, reportToManager и итоговый ответ. Запись eval
 * (`eval/recordings/prices-update-ok.model-a.json`) даёт 4 шага без чтения и создания карточки.
 */
export const ESTIMATE_STEPS_PER_FILE = 6;
/**
 * Входных токенов на шаг без текста файла: промпт агента, схемы всех инструментов, поручение.
 * Замер по логу шлюза на бою 27.10.2026: 35 429 входных токенов на вызов с небольшим прайсом,
 * из них ~5 тыс. - текст файла. Прежняя оценка по записи eval (2 826) не учитывала боевой
 * набор инструментов и занижала смету в разы.
 */
export const ESTIMATE_BASE_INPUT_TOKENS_PER_STEP = 30_000;
/** Выходных токенов на шаг: аргументы инструментов (сопоставление колонок) и короткий текст. */
export const ESTIMATE_OUTPUT_TOKENS_PER_STEP = 500;
/**
 * Сколько раз текст файла лежит в контексте: прочитанные страницы плюс разобранные позиции,
 * которые normalizePriceTable возвращает агенту.
 */
export const ESTIMATE_TEXT_COPIES = 2;
/**
 * Символов на токен для русского табличного текста. Осторожнее среднего (~3): в прайсах много
 * цифр, единиц измерения и разметки таблиц.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 2.5;
/**
 * Запас на повторное чтение, ошибки проверок записи и лишние шаги: доля сверху к расчётным
 * токенам.
 */
export const ESTIMATE_MARGIN = 1.3;
/** Курс по умолчанию, рублей за доллар (переменная `PRICE_IMPORT_ESTIMATE_RUB_PER_USD`). */
export const ESTIMATE_DEFAULT_RUB_PER_USD = 90;

/** Рублёвые копейки в сумме для показа. */
const RUB_DECIMALS = 2;
const MS_PER_HOUR = 3_600_000;

/**
 * Символов извлечённого текста на байт файла по расширению. Допущение: у сжатых форматов
 * (xlsx, docx) текст разворачивается, у pdf и устаревших бинарных форматов - заметно меньше
 * размера; csv и txt в UTF-8 с кириллицей - около 0,6 символа на байт.
 */
const TEXT_CHARS_PER_BYTE: Readonly<Record<string, number>> = {
  '.csv': 0.6,
  '.txt': 0.6,
  '.xlsx': 1.2,
  '.xlsm': 1.2,
  '.xls': 0.5,
  '.docx': 1.5,
  '.doc': 0.4,
  '.pptx': 1,
  '.rtf': 0.3,
  '.pdf': 0.5,
};
/** Для расширения без записи в таблице. */
const DEFAULT_TEXT_CHARS_PER_BYTE = 0.6;

/** Файл к импорту: путь, размер на диске и, если известна, длина извлечённого текста. */
export interface EstimateFile {
  path: string;
  sizeBytes: number;
  /** Длина текста по индексу базы знаний; нет - оценивается по размеру и расширению. */
  textChars?: number | undefined;
}

/** Исходные данные сметы. */
export interface PriceImportEstimateInput {
  files: readonly EstimateFile[];
  /** Алиас модели агента прайсов (`PRICES_MODEL`): по нему берётся цена. */
  model: string;
  /** Таблица цен моделей телеметрии (`MODEL_PRICES_FILE` или встроенная). */
  prices: ModelPriceTable;
  /** Курс, рублей за доллар. */
  rubPerUsd: number;
}

/** Результат сметы. */
export interface PriceImportEstimate {
  files: number;
  totalBytes: number;
  /** Все входные токены, включая записанные в кэш и прочитанные из него. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** Файлов, длина текста которых взята из индекса, а не оценена по размеру. */
  measuredFiles: number;
  /** Стоимость в долларах; `undefined`, если у алиаса модели нет цены (не придумывается). */
  costUsd: number | undefined;
  costRub: number | undefined;
  /** Сколько тиков синхронизации понадобится при пределе файлов за тик. */
  ticks: number;
  /** Сколько часов займёт импорт при периодичности тика. */
  hours: number;
}

/** Длина текста файла: из индекса, иначе по размеру и расширению. */
function textCharsOf(file: EstimateFile): number {
  if (file.textChars !== undefined) return file.textChars;
  const ratio = TEXT_CHARS_PER_BYTE[extensionOf(file.path)] ?? DEFAULT_TEXT_CHARS_PER_BYTE;
  return file.sizeBytes * ratio;
}

/** Токены одного файла по шагам агента. */
interface FileTokens {
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * Токены одного файла с кэшем промпта. Агент читает ВСЕ страницы большого файла (по курсору),
 * каждая лишняя страница - лишний шаг. На каждом шаге префикс прошлых шагов читается из кэша,
 * а новое (база на первом шаге, затем текст и ответы) записывается в кэш. Между файлами кэш
 * не переиспользуется: тик раз в 10 минут длиннее времени жизни кэша.
 */
function fileTokens(file: EstimateFile): FileTokens {
  const chars = textCharsOf(file);
  const pages = Math.max(1, Math.ceil(chars / MAX_MARKDOWN_CHARS));
  const steps = ESTIMATE_STEPS_PER_FILE + pages - 1;
  const text = Math.ceil((chars / ESTIMATE_CHARS_PER_TOKEN) * ESTIMATE_TEXT_COPIES);
  const output = steps * ESTIMATE_OUTPUT_TOKENS_PER_STEP;
  // Префикс растёт: база на всех шагах после первого, текст - в среднем на половине шагов
  // чтения и целиком на шагах после чтения, ответы - в среднем половиной.
  const afterReading = steps - pages;
  const cacheRead =
    ESTIMATE_BASE_INPUT_TOKENS_PER_STEP * (steps - 1) +
    Math.ceil((text * (pages - 1)) / 2) +
    text * afterReading +
    Math.ceil((output * (steps - 1)) / 2);
  return { cacheWrite: ESTIMATE_BASE_INPUT_TOKENS_PER_STEP + text + output, cacheRead, output };
}

/** Смета по списку файлов к импорту. */
export function estimatePriceImport(input: PriceImportEstimateInput): PriceImportEstimate {
  let cacheWrite = 0;
  let cacheRead = 0;
  let output = 0;
  let totalBytes = 0;
  let measuredFiles = 0;
  for (const file of input.files) {
    totalBytes += file.sizeBytes;
    if (file.textChars !== undefined) measuredFiles += 1;
    const tokens = fileTokens(file);
    cacheWrite += tokens.cacheWrite;
    cacheRead += tokens.cacheRead;
    output += tokens.output;
  }
  const cacheWriteTokens = Math.ceil(cacheWrite * ESTIMATE_MARGIN);
  const cacheReadTokens = Math.ceil(cacheRead * ESTIMATE_MARGIN);
  const outputTokens = Math.ceil(output * ESTIMATE_MARGIN);
  const inputTokens = cacheWriteTokens + cacheReadTokens;
  const costUsd =
    input.files.length === 0
      ? 0
      : estimateCallCostUsd(input.prices, input.model, {
          input: inputTokens,
          cacheWrite: cacheWriteTokens,
          cacheRead: cacheReadTokens,
          output: outputTokens,
        });
  const ticks = Math.ceil(input.files.length / PRICE_DISK_SYNC_MAX_FILES);
  return {
    files: input.files.length,
    totalBytes,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    measuredFiles,
    costUsd,
    costRub:
      costUsd === undefined
        ? undefined
        : Number((costUsd * input.rubPerUsd).toFixed(RUB_DECIMALS)),
    ticks,
    hours: (ticks * PRICE_DISK_SYNC_INTERVAL_MS) / MS_PER_HOUR,
  };
}
