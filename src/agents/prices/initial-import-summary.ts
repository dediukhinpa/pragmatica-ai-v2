import type { DiskSyncOutcome } from './disk-sync-outcome';

/**
 * Сводка первичного импорта ответственному за прайсы: сколько файлов записано, сколько
 * пропущено и почему, какие новые карточки поставщиков созданы. Текст строит код из итогов по файлам,
 * свободного текста модели в нём нет.
 */

/** Сколько ждать итога по файлу, прежде чем считать, что агент его не обработал, мс. */
/** Часов ожидания итога по файлу. */
const TIMEOUT_HOURS = 2;
const MS_PER_HOUR = 3_600_000;
export const INITIAL_IMPORT_RESULT_TIMEOUT_MS = TIMEOUT_HOURS * MS_PER_HOUR;
/** Сколько причин пропуска и карточек показывать поимённо; остальное - числом. */
const LISTED_FILES_PER_REASON = 5;
const LISTED_DRAFTS = 30;

/** Причина пропуска без результата агента. */
export const NO_RESULT_REASON = 'no_result';

/** Подписи причин пропуска (код до двоеточия); неизвестный код показывается как есть. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  needs_review: 'нужна проверка',
  scan_skipped: 'скан без текста',
  structure_changed: 'изменилась структура таблицы',
  [NO_RESULT_REASON]: 'агент не дал результата за отведённое время',
};

/**
 * Подписи кодов замечаний агента (то, что после двоеточия в причине): человеческими словами
 * для частых кодов. Код, которого здесь нет, показывается как есть; новые коды добавляются сюда.
 */
const ISSUE_LABELS: Readonly<Record<string, string>> = {
  // Варианты: одна модель в нескольких размерах, цветах, весах.
  duplicate_row: 'повторяющиеся строки',
  same_name_different_weight: 'варианты товара (вес)',
  one_sku_many_sizes_colors: 'варианты товара (размеры, цвета)',
  size_variants_same_article: 'варианты товара (размеры)',
  duplicate_sku_multiple_sizes: 'варианты товара (размеры)',
  duplicate_sku_different_price: 'варианты товара с разной ценой',
  // Группы: название только в заголовке группы или в объединённой ячейке.
  name_in_group_header: 'название в заголовке группы',
  group_header_names: 'название в заголовке группы',
  empty_product_name: 'пустое название товара',
  empty_name_rows: 'пустое название товара',
  variant_rows_without_name: 'у вариантов нет названия',
  name_split_across_rows: 'название разбито на несколько строк',
  empty_name_merged_article: 'название в объединённой ячейке',
  // Тиражи: цены за количество в нескольких столбцах.
  price_tiers_by_quantity: 'цены по тиражам',
  multiple_price_tiers: 'цены по тиражам',
  two_price_columns: 'два столбца цен',
  price_tiers_ambiguous: 'неясные цены по тиражам',
  complex_table: 'сложная таблица',
  // Устройство листа.
  repeated_header_in_table: 'шапка повторяется внутри листа',
  mixed_tables_on_sheet: 'несколько таблиц на листе',
  // Скрытые данные и обрезка. Скан - не код замечания, а вид итога scan_skipped (REASON_LABELS).
  // `file_truncated` - реальный код проверки импорта (import-checks.ts); `hidden_data` и
  // `hidden_sheets` системой не выдаются: их называет промпт «Прайсов» для hidden=true.
  hidden_data: 'скрытые данные',
  hidden_sheets: 'скрытые листы',
  file_truncated: 'файл прочитан не целиком',
  // Скрипт в песочнице пробовали, а файл всё равно ушёл людям.
  script_did_not_help: 'скрипт не помог',
  script_attempt_required: 'нужна попытка скрипта',
  // Прочие коды проверок импорта и сверки.
  rows_rejected: 'часть строк отклонена',
  price_date_out_of_window: 'дата цены вне допустимого окна',
  price_jump: 'резкий скачок цены',
  no_sku: 'нет артикула',
  same_name_different_sku: 'то же название с другим артикулом',
  currency_mismatch: 'валюта не совпадает с прайсом поставщика',
  // Почему у файла нет результата агента (`no_result:<код>`): ход без итога или сбой задачи.
  no_final_action: 'агент закончил без записи итога',
  tool_results_budget: 'не хватило объёма данных одного хода',
  validation_failed: 'отказ проверки ПДн',
  invalid_input: 'ошибка в данных шага',
  external_failure: 'сбой внешнего сервиса или предел шагов',
  handler_timeout: 'превышено время разбора',
};

/**
 * Подписи по ключевым словам кода - для кодов, которых нет в {@link ISSUE_LABELS}: агент
 * придумывает их свободно (`multi_tier_price_columns`, `tiered_price_by_quantity`,
 * `hidden_flag_without_hidden_sheets`), точное совпадение их не ловит. Порядок важен: первое
 * совпадение побеждает. Ни одно слово не подошло - код показывается как есть.
 */
const ISSUE_KEYWORD_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/tier|quantity|price_columns/, 'цены по тиражам'],
  [/group/, 'название в заголовке группы'],
  [/size|color|colour|weight|variant|packaging/, 'варианты товара'],
  [/duplicate|not_unique/, 'повторяющиеся строки'],
  [/hidden/, 'скрытые данные'],
  [/truncat/, 'файл прочитан не целиком'],
  [/scan|ocr/, 'скан без текста'],
  [/draft/, 'создана новая карточка поставщика'],
  [/supplier/, 'поставщик не определён'],
  [/(mixed|multi|multiple)_?tables?|table/, 'сложная таблица'],
  [/sku|article/, 'нет артикула'],
  [/anomal|jump/, 'резкий скачок цены'],
  [/currency|exchange/, 'цена зависит от валюты или курса'],
  [/empty|name/, 'пустое или неясное название товара'],
];

/** Подпись кода замечания: точная из таблицы, иначе по ключевому слову, иначе сам код. */
export function issueLabel(issue: string): string {
  const exact = ISSUE_LABELS[issue];
  if (exact !== undefined) return exact;
  const code = issue.toLowerCase();
  return ISSUE_KEYWORD_LABELS.find(([pattern]) => pattern.test(code))?.[1] ?? issue;
}

/** Сколько файлов ещё ждут итога (в очереди и не просрочены). */
export function pendingOutcomes(outcomes: readonly DiskSyncOutcome[], now: Date): number {
  return outcomes.filter(
    (item) =>
      item.status === 'queued' &&
      now.getTime() - Date.parse(item.at) < INITIAL_IMPORT_RESULT_TIMEOUT_MS,
  ).length;
}

function labelOf(reason: string): string {
  const [code = reason, details] = reason.split(':');
  const label = REASON_LABELS[code] ?? code;
  if (details === undefined || details === '') return label;
  const issues = details.split(',').map(issueLabel);
  // Одинаковые подписи разных кодов не повторяются.
  return `${label} (${[...new Set(issues)].join(', ')})`;
}

/** Строки «Пропущено — причина: N. файлы» по причинам. */
function skippedLines(skipped: ReadonlyArray<{ file: string; reason: string }>): string[] {
  const byReason = new Map<string, string[]>();
  for (const item of skipped) {
    const files = byReason.get(item.reason) ?? [];
    files.push(item.file);
    byReason.set(item.reason, files);
  }
  const lines: string[] = [];
  for (const [reason, files] of byReason) {
    const shown = files.slice(0, LISTED_FILES_PER_REASON).join('; ');
    const rest = files.length - LISTED_FILES_PER_REASON;
    lines.push(
      `Пропущено — ${labelOf(reason)}: ${files.length}. ${shown}` +
        (rest > 0 ? `; и ещё ${rest}` : ''),
    );
  }
  return lines;
}

/**
 * Сводка догрузки отложенных файлов. Записанное в первый проход (нет номера догрузки) и
 * записанное при догрузке считаются раздельно; в «ещё пропущено» - всё, что не записано.
 */
export function buildRetrySummary(
  outcomes: readonly DiskSyncOutcome[],
  attempt: number,
  truncated: boolean,
): string {
  const written = outcomes.filter((item) => item.status === 'written');
  const first = written.filter((item) => item.attempt === undefined);
  const retried = written.filter((item) => item.attempt !== undefined);
  const rowsOf = (items: readonly DiskSyncOutcome[]): number =>
    items.reduce((sum, item) => sum + (item.rows ?? 0), 0);
  const skipped = outcomes
    .filter((item) => item.status !== 'written')
    .map((item) => ({ ...item, reason: item.reason ?? NO_RESULT_REASON }));
  const lines = [
    `Догрузка отложенных прайсов (попытка ${attempt}) завершена.`,
    `Записано в первый проход: ${first.length} (позиций: ${rowsOf(first)}).`,
    `Записано при догрузке: ${retried.length} (позиций: ${rowsOf(retried)}).`,
    ...priceFormsLines(written),
    ...scriptLines(written),
    `Всё ещё не записано: ${skipped.length}.`,
    ...skippedLines(skipped),
  ];
  if (truncated) lines.push('Список итогов прочитан не целиком: цифры могут быть занижены.');
  return lines.join('\n');
}

/** Подпись причины для плана догрузки. */
export function reasonLabel(reason: string): string {
  return labelOf(reason);
}

/** Строка о позициях с ценой словами среди записанных; пусто, если таких нет. */
function priceFormsLines(written: readonly DiskSyncOutcome[]): string[] {
  const sum = (pick: (item: DiskSyncOutcome) => number | undefined): number =>
    written.reduce((total, item) => total + (pick(item) ?? 0), 0);
  const from = sum((item) => item.fromRows);
  const range = sum((item) => item.rangeRows);
  const tier = sum((item) => item.cellTierRows);
  if (from + range + tier === 0) return [];
  const parts = [
    ...(from > 0 ? [`цена «от»: ${from}`] : []),
    ...(range > 0 ? [`диапазон цен: ${range}`] : []),
    ...(tier > 0 ? [`тираж из ячейки цены: ${tier}`] : []),
  ];
  return [`Из записанных позиций с ценой словами: ${parts.join(', ')}.`];
}

/** Строка о файлах, разобранных скриптом в песочнице, среди записанных; пусто, если таких нет. */
function scriptLines(written: readonly DiskSyncOutcome[]): string[] {
  const count = written.filter((item) => item.viaScript === true).length;
  return count === 0 ? [] : [`Из записанных файлов разобрано скриптом: ${count}.`];
}

/** Текст сводки. `truncated` - итоги прочитаны не целиком. */
export function buildInitialImportSummary(
  outcomes: readonly DiskSyncOutcome[],
  truncated: boolean,
): string {
  const written = outcomes.filter((item) => item.status === 'written');
  const skipped = outcomes
    .filter((item) => item.status === 'skipped' || item.status === 'queued')
    // Файл без итога после срока - пропущен: ответ агента не получен.
    .map((item) => ({ ...item, reason: item.reason ?? NO_RESULT_REASON }));
  const drafts = outcomes.flatMap((item) => (item.draft === undefined ? [] : [item.draft]));
  const uniqueDrafts = [...new Map(drafts.map((draft) => [draft.supplierId, draft])).values()];
  const rows = written.reduce((sum, item) => sum + (item.rows ?? 0), 0);
  const lines = [
    'Первичный импорт прайсов с диска завершён.',
    `Файлов обработано: ${outcomes.length}. Записано: ${written.length} (позиций: ${rows}). ` +
      `Пропущено: ${skipped.length}.`,
    ...priceFormsLines(written),
    ...scriptLines(written),
    ...skippedLines(skipped),
  ];
  if (uniqueDrafts.length > 0) {
    const shown = uniqueDrafts
      .slice(0, LISTED_DRAFTS)
      .map((draft) => `«${draft.name}»`)
      .join(', ');
    const rest = uniqueDrafts.length - LISTED_DRAFTS;
    lines.push(
      `Созданы новые карточки поставщиков (по шапке файла): ${uniqueDrafts.length}. ` +
        `${shown}` +
        (rest > 0 ? `, и ещё ${rest}` : '') +
        '. Карточки сразу рабочие; при необходимости дополните их данными.',
    );
  }
  if (truncated) lines.push('Список итогов прочитан не целиком: цифры могут быть занижены.');
  return lines.join('\n');
}
