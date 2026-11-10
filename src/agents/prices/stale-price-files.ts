import {
  DEFAULT_PRICE_STALE_EXCLUDE_PATTERN,
  createPriceStaleScope,
} from '../../kit/domain/price-stale-scope';
import {
  PRICE_FILE_CHECK_HOUR,
  PRICE_FILE_CHECK_WEEKDAY,
  PRICE_FILE_MAX_LISTED,
} from '../../kit/domain/monitoring';
import {
  PRICE_FILE_STALE_MONTHS,
  isPriceDateStale,
  hasYearlessDayMonth,
  nearestPastPriceFileDate,
  parsePriceFileDate,
  type PriceFileDate,
} from '../../kit/domain/price-file-date';
import {
  YEAR_ANCHOR_LABELS,
  resolveYearAnchor,
  yearAnchorDateKey,
  yearFromPath,
  type YearAnchor,
  type YearAnchorSource,
} from '../../kit/domain/price-file-year-anchor';
import {
  classifyPriceFileName,
  looksLikePriceListName,
  priceFileBaseName,
} from '../../kit/domain/price-file-kind';
import { hasPriceWordInFileName } from '../../kit/domain/price-table-signal';
import {
  createPriceFileSupplierMatcher,
  type PriceFileImportRecord,
  type SupplierNameRef,
} from '../../kit/domain/price-file-supplier';
import { localDateKey, localHour, localWeekday } from '@business-ai/core';
import { verifyFallbackPriceFileDate } from '../../kit/domain/price-file-date-check';
import type { FileAuthors, FileEntry } from '@business-ai/core';
import type { PriceTableVerdict } from '../../kit/ports/price-table-index';
import { stateEntries } from '@business-ai/core';
import { extensionOf, hasSlot, markSlot, stableHash } from '@business-ai/core';
import { listAllSuppliers } from '../shared/supplier-email-index';
import { mapPool } from '@business-ai/core';
import {
  IMPORT_META_NAMESPACE,
  PRICE_TEXT_EXTENSIONS,
  SCAN_EXTENSIONS,
  responsibleThread,
  type PricesDeps,
} from './deps';
import { importMetaSchema, requireState } from './price-state';
import {
  AUTHORSHIP_EXTENSIONS,
  PRICE_FILE_AUTHORSHIP_MAX_FILES,
  resolveFileRecipients,
} from './stale-price-recipients';

/** Обязанность мониторинга в хранилище слотов. */
const DUTY = 'stale-price-files';
/** Записей истории импортов за одно обращение к хранилищу. */
const IMPORT_META_PAGE = 200;
/**
 * Предел страниц истории импортов (10 000 записей): пространство растёт с каждым импортом, а
 * история нужна лишь для подбора поставщика по пути файла. Сверх предела история неполна, и
 * поставщик определяется по названию в пути - сообщение всё равно уходит.
 */
const IMPORT_META_MAX_PAGES = 50;
/** Разделитель идентификатора поставщика и отпечатка файла в ключе импорта. */
const IMPORT_KEY_SEPARATOR = ':';
/** Префикс ключа слота получателя: к локальной дате добавляется отпечаток его треда. */
const RECIPIENT_SLOT_SEPARATOR = ':';
/** Подпись блока файлов, поставщика которых определить не удалось. */
const UNKNOWN_SUPPLIER_LABEL = 'поставщик не определён';

/**
 * Сколько чтений свойств за проверку уходит на вывод года: это часть общего лимита
 * `PRICE_FILE_AUTHORSHIP_MAX_FILES`, вторая половина остаётся адресатам.
 */
const PRICE_FILE_YEAR_PROPERTY_MAX_FILES = PRICE_FILE_AUTHORSHIP_MAX_FILES / 2;

/** Таймаут одного запасного разбора даты моделью. */
const FALLBACK_TIMEOUT_MS = 20_000;
/** Предел обращений к модели за одну проверку: остальные файлы - в списке «без даты». */
export const PRICE_FILE_FALLBACK_MAX_CALLS = 30;
/** Сколько запросов запасного разбора идёт одновременно. */
const FALLBACK_CONCURRENCY = 3;

/** Результаты, когда проверка не выполнялась: сообщения не было, счётчики нулевые. */
const NO_RUN = {
  not_due: { status: 'not_due', notified: 0, deferred: 0, undated: 0 },
  already_done: {
    status: 'already_done',
    notified: 0,
    deferred: 0,
    undated: 0,
  },
  nothing: { status: 'nothing', notified: 0, deferred: 0, undated: 0 },
} as const satisfies Record<string, StalePriceFilesResult>;

/** Параметры проверки. */
export interface StalePriceFilesOptions {
  /** Часовой пояс бизнеса (IANA): по нему считаются понедельник и час проверки. */
  timezone: string;
}

/** Итог проверки: только счётчики (без путей и текстов - они идут в журнал задач). */
export interface StalePriceFilesResult {
  /**
   * `not_due` - не понедельник или ещё нет часа проверки; `already_done` - в этот понедельник
   * уже проверено; `nothing` - сообщать нечего (сообщение не пишется); `sent` - отправлено.
   */
  status: 'not_due' | 'already_done' | 'nothing' | 'sent';
  /** Сколько файлов вошло в отправленное сообщение (устаревшие и без даты). */
  notified: number;
  /** Сколько файлов не поместилось в сообщение (будут в проверке следующего понедельника). */
  deferred: number;
  /** Сколько из вошедших в сообщение файлов - без даты в названии. */
  undated: number;
  /** Сколько сообщений отправлено (по одному на получателя); только при `sent`. */
  messages?: number;
  /** Сколько из них ушло в личные треды сотрудников, работавших с файлами; при `sent`. */
  personal?: number;
}

export interface PriceFileItem {
  entry: FileEntry;
  /** Дата из названия файла; null - в названии даты нет. */
  date: PriceFileDate | null;
  /** Откуда взят год, если в названии он не записан (`28.10`); иначе не задан. */
  yearSource?: YearAnchorSource | undefined;
  /** Поставщик (id и название); null - не определён. */
  supplier: SupplierNameRef | null;
}

/** Файл - прайс по расширению (те же расширения, что у `listPriceFiles`). */
function isPriceFile(path: string): boolean {
  const extension = extensionOf(path);
  return PRICE_TEXT_EXTENSIONS.includes(extension) || SCAN_EXTENSIONS.includes(extension);
}

/**
 * Отобрать из файлов диска прайсы по тем же критериям, что у недельной проверки старых файлов:
 * область (префиксы, исключения), имя «прайс», признак таблицы цен. Сканы не берутся: их не
 * импортировать без распознавания. Нужна синхронизации цен с диска.
 */
export async function selectImportablePriceFiles(
  deps: Pick<PricesDeps, 'staleScan' | 'priceTables' | 'log'>,
  entries: readonly FileEntry[],
): Promise<FileEntry[]> {
  // В базу цен архив («Архив_цены неактуальные», «НЕ БРАТЬ») не импортируется никогда: умолчание
  // действует безусловно, а заданное PRICE_STALE_EXCLUDE_PATTERN лишь добавляет к нему
  // исключения (иначе иное выражение молча вернуло бы архив в импорт и в смету).
  const notArchive = createPriceStaleScope({
    prefixes: [],
    excludePattern: DEFAULT_PRICE_STALE_EXCLUDE_PATTERN,
  });
  const configured = createPriceStaleScope({
    prefixes: deps.staleScan?.prefixes ?? [],
    excludePattern: deps.staleScan?.excludePattern,
  });
  const inScope = (path: string): boolean => notArchive(path) && configured(path);
  const scoped = entries.filter(
    (entry) =>
      PRICE_TEXT_EXTENSIONS.includes(extensionOf(entry.path)) &&
      inScope(entry.path) &&
      classifyPriceFileName(entry.path) === 'price',
  );
  const verdicts = await loadTableVerdicts(deps, scoped);
  return scoped.filter(
    (entry) =>
      verdicts === null ||
      hasPriceWordInFileName(entry.path) ||
      verdicts.get(entry.path) === 'table',
  );
}

/**
 * Запасной разбор даты моделью для файлов, где код даты не нашёл. Ответ принимается только
 * после строгой проверки кодом; таймаут, сбой и неверный ответ - «дата не найдена». В журнал
 * идут только счётчики: имена файлов туда не попадают.
 */
async function resolveByFallback(
  deps: PricesDeps,
  paths: readonly string[],
  now: Date,
  timezone: string,
  anchors: ReadonlyMap<string, YearAnchor>,
): Promise<Map<string, PriceFileDate>> {
  const found = new Map<string, PriceFileDate>();
  const fallback = deps.priceDateFallback;
  if (fallback === undefined) return found;
  const asked = paths.filter(looksLikePriceListName).slice(0, PRICE_FILE_FALLBACK_MAX_CALLS);
  if (asked.length === 0) return found;
  const today = localDateKey(now, timezone);
  let failed = 0;
  await mapPool(asked, FALLBACK_CONCURRENCY, async (path) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('price_date_fallback_timeout')),
      FALLBACK_TIMEOUT_MS,
    );
    const anchor = anchors.get(path);
    try {
      const answer = await fallback.resolve(
        // Модели - только базовое имя: каталоги (имена поставщиков, клиентов) не нужны.
        // «Сегодня» для модели - опорная дата файла: от неё выводится год записи без года.
        {
          fileName: priceFileBaseName(path),
          today: anchor === undefined ? today : yearAnchorDateKey(anchor, timezone),
        },
        { signal: controller.signal },
      );
      const verified =
        answer === null
          ? null
          : verifyFallbackPriceFileDate(path, answer, now, timezone, anchor?.at);
      if (verified !== null) found.set(path, verified);
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  });
  deps.log?.('price_file_date_fallback', {
    asked: asked.length,
    resolved: found.size,
    failed,
  });
  return found;
}

/**
 * Вердикты «таблица цен» для файлов без слова «прайс» в имени (с ним текст не нужен). `null` -
 * проверка содержимого выключена (порт не подключён). В журнал - только счётчики.
 */
async function loadTableVerdicts(
  deps: Pick<PricesDeps, 'priceTables' | 'log'>,
  entries: readonly FileEntry[],
): Promise<Map<string, PriceTableVerdict> | null> {
  const { priceTables } = deps;
  if (priceTables === undefined) return null;
  const paths = entries
    .map((entry) => entry.path)
    .filter((path) => !hasPriceWordInFileName(path));
  const verdicts = await priceTables.verdicts(paths);
  const counts = { table: 0, not_table: 0, absent: 0 };
  for (const path of paths) counts[verdicts.get(path) ?? 'absent'] += 1;
  deps.log?.('price_stale_content_check', {
    inScope: entries.length,
    checked: paths.length,
    table: counts.table,
    notTable: counts.not_table,
    absent: counts.absent,
  });
  return verdicts;
}

/** Результат вывода года для файлов с датой `дд.мм` без года. */
interface YearlessResolution {
  /** Опорная дата файла и её источник; файла без опоры в карте нет. */
  anchors: Map<string, YearAnchor>;
  /** Свойства, прочитанные при выводе года: повторно для адресатов не запрашиваются. */
  authors: Map<string, FileAuthors>;
  /** Сколько чтений свойств потрачено из лимита проверки. */
  reads: number;
}

/**
 * Опорная дата для файлов с записью `дд.мм` без года: год в пути, затем дата сохранения из
 * свойств документа, затем время изменения файла. Свойства читаются только для файлов, у
 * которых года в пути нет, и не больше `PRICE_FILE_AUTHORSHIP_MAX_FILES` раз за проверку;
 * сбой чтения (нет сервиса, битый файл, формат без свойств) - следующий источник. Файл без
 * опорной даты в карту не попадает (он пойдёт в «без даты»).
 */
async function resolveYearlessAnchors(
  deps: PricesDeps,
  entries: readonly FileEntry[],
  now: Date,
  timezone: string,
): Promise<YearlessResolution> {
  const anchors = new Map<string, YearAnchor>();
  const authors = new Map<string, FileAuthors>();
  const { authorship } = deps;
  const readable =
    authorship === undefined
      ? []
      : entries
          .filter(
            (entry) =>
              yearFromPath(entry.path) === null &&
              AUTHORSHIP_EXTENSIONS.includes(extensionOf(entry.path)),
          )
          .slice(0, PRICE_FILE_YEAR_PROPERTY_MAX_FILES);
  let failed = 0;
  if (authorship !== undefined) {
    await mapPool(readable, FALLBACK_CONCURRENCY, async (entry) => {
      try {
        authors.set(
          entry.path,
          await authorship.authorsOf(entry.path, await deps.files.read(entry.path)),
        );
      } catch {
        failed += 1;
      }
    });
  }
  const bySource: Record<YearAnchorSource, number> = {
    path: 0,
    properties: 0,
    mtime: 0,
  };
  for (const entry of entries) {
    const found = authors.get(entry.path);
    const anchor = resolveYearAnchor(
      {
        path: entry.path,
        savedAtIso: found === undefined ? null : savedAtOf(found, now, timezone),
        mtimeMs: entry.mtimeMs,
      },
      now,
      timezone,
    );
    if (anchor === null) continue;
    anchors.set(entry.path, anchor);
    bySource[anchor.source] += 1;
  }
  deps.log?.('price_file_year_anchor', {
    asked: entries.length,
    unresolved: entries.length - anchors.size,
    ...bySource,
    propertyReads: readable.length,
    propertyFailed: failed,
  });
  return { anchors, authors, reads: readable.length };
}

/** Дата сохранения из свойств: первая из изменения и создания, которой можно верить. */
function savedAtOf(authors: FileAuthors, now: Date, timezone: string): string | null {
  return (
    [authors.modifiedAt, authors.createdAt].find(
      (iso) =>
        iso !== null && resolveYearAnchor({ path: '', savedAtIso: iso }, now, timezone) !== null,
    ) ?? null
  );
}

/** Источник года, если модель вывела его от опорной даты, а в названии он не записан. */
function impliedYearSource(
  path: string,
  date: PriceFileDate,
  anchors: ReadonlyMap<string, YearAnchor>,
  timezone: string,
): YearAnchorSource | undefined {
  const anchor = anchors.get(path);
  if (anchor === undefined || date.day === null) return undefined;
  if (priceFileBaseName(path).includes(String(date.year))) return undefined;
  const implied = nearestPastPriceFileDate(date.day, date.month, anchor.at, timezone);
  return implied?.year === date.year ? anchor.source : undefined;
}

/** История импортов с диска: путь файла и поставщик (из ключа `<поставщик>:<отпечаток>`). */
async function loadDiskImportHistory(deps: PricesDeps): Promise<PriceFileImportRecord[]> {
  const records: PriceFileImportRecord[] = [];
  const entries = stateEntries(requireState(deps), IMPORT_META_NAMESPACE, {
    pageSize: IMPORT_META_PAGE,
    maxPages: IMPORT_META_MAX_PAGES,
  });
  for await (const entry of entries) {
    const meta = importMetaSchema.safeParse(entry.value);
    if (!meta.success || meta.data.source !== 'disk' || meta.data.fileName === undefined) continue;
    const separator = entry.key.lastIndexOf(IMPORT_KEY_SEPARATOR);
    if (separator <= 0) continue;
    records.push({
      supplierId: entry.key.slice(0, separator),
      fileName: meta.data.fileName,
    });
  }
  return records;
}

/** Две цифры: день и месяц в записи даты. */
const DATE_PART_WIDTH = 2;

/** Пометка у даты, год которой выведен, а не записан в названии. */
function yearNote(source: YearAnchorSource | undefined): string {
  return source === undefined ? '' : ` (${YEAR_ANCHOR_LABELS[source]})`;
}

/** Дата из названия: `ДД.ММ.ГГГГ`, для записи «только месяц» - `ММ.ГГГГ`. */
export function formatFileDate(date: PriceFileDate): string {
  const month = String(date.month).padStart(DATE_PART_WIDTH, '0');
  if (date.day === null) return `${month}.${date.year}`;
  return `${String(date.day).padStart(DATE_PART_WIDTH, '0')}.${month}.${date.year}`;
}

/** Файлы одного получателя недельной сводки: устаревшие и без даты. */
interface ThreadBucket {
  stale: PriceFileItem[];
  undated: PriceFileItem[];
}

/** Добавить файлы `from` в `into` без повторов по пути (файл мог уже быть у получателя). */
function mergeBucket(into: ThreadBucket, from: ThreadBucket): void {
  for (const kind of ['stale', 'undated'] as const) {
    const known = new Set(into[kind].map((item) => item.entry.path));
    for (const item of from[kind]) {
      if (!known.has(item.entry.path)) into[kind].push(item);
    }
    // Детерминированный порядок: повтор задачи соберёт тот же текст.
    into[kind].sort(compareFiles);
  }
}

/**
 * Порядок в сообщении: сначала поставщики по названию, затем «не определён»; внутри - по пути.
 * Порядок детерминирован, чтобы повтор задачи собрал тот же текст и тот же набор файлов.
 */
function compareFiles(a: PriceFileItem, b: PriceFileItem): number {
  const aKnown = a.supplier !== null;
  if (aKnown !== (b.supplier !== null)) return aKnown ? -1 : 1;
  const byName = (a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? '');
  if (byName !== 0) return byName;
  return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
}

/** Блок сообщения: файлы, сгруппированные по поставщикам (список уже отсортирован). */
function groupedLines(items: readonly PriceFileItem[]): string[] {
  const lines: string[] = [];
  let current: string | null = null;
  for (const item of items) {
    const who = item.supplier?.name ?? UNKNOWN_SUPPLIER_LABEL;
    if (who !== current) {
      if (current !== null) lines.push('');
      lines.push(`${who}:`);
      current = who;
    }
    const suffix =
      item.date === null ? '' : ` — ${formatFileDate(item.date)}${yearNote(item.yearSource)}`;
    lines.push(`• ${item.entry.path}${suffix}`);
  }
  return lines;
}

/** Текст сообщения ответственному (шаблон кода; хотя бы один из блоков не пуст). */
function buildMessage(
  stale: readonly PriceFileItem[],
  undated: readonly PriceFileItem[],
  deferred: number,
): string {
  const blocks: string[] = [];
  if (stale.length > 0) {
    blocks.push(
      [
        `Прайсы не обновлялись последние ${PRICE_FILE_STALE_MONTHS} месяца ` +
          '(по дате в названии файла):',
        ...groupedLines(stale),
      ].join('\n'),
    );
  }
  if (undated.length > 0) {
    blocks.push(
      ['Дата в названии не найдена — проверьте вручную:', ...groupedLines(undated)].join('\n'),
    );
  }
  if (deferred > 0) {
    blocks.push(
      `…и ещё файлов: ${deferred} (не поместились в список; проверка повторится в ` +
        'следующий понедельник, если они останутся в списке).',
    );
  }
  if (stale.some((item) => item.yearSource !== undefined)) {
    blocks.push(
      'В названии некоторых файлов года нет: он выведен по признакам файла (см. пометку у даты).',
    );
  }
  if (stale.length > 0) {
    blocks.push('Проверьте, актуальны ли эти прайсы, и запросите обновление у поставщиков.');
  }
  return blocks.join('\n\n');
}

/** Отбор недельной проверки: устаревшие по дате в названии и прайсы без даты. */
export interface StalePriceFilesScan {
  /** Устаревшие (дата в названии старше срока), отсортированы по поставщику и пути. */
  stale: PriceFileItem[];
  /** Прайсы без даты в названии, в том же порядке. */
  undated: PriceFileItem[];
  /** Свойства документов, прочитанные при выводе года (повторно для адресатов не читаются). */
  authors: Map<string, FileAuthors>;
  /** Сколько чтений свойств потрачено из `PRICE_FILE_AUTHORSHIP_MAX_FILES`. */
  reads: number;
}

/** Параметры отбора. */
export interface StalePriceFilesScanOptions {
  /**
   * Запасной разбор даты моделью (если подключён). Справке по запросу сотрудника он не нужен:
   * до 30 обращений к модели затянули бы ход, а файл без даты всё равно попадёт в «без даты».
   */
  modelFallback?: boolean;
}

/**
 * Отобрать прайс-файлы диска, у которых дата в названии старше `PRICE_FILE_STALE_MONTHS`
 * месяцев, и прайсы без даты в названии. Правила те же, что у недельной проверки (область,
 * признак прайса, вывод года для `дд.мм`); дата изменения файла служит только опорой года.
 * Ничего не отправляет и не пишет слотов: общий отбор для рассылки и для инструмента агента.
 */
export async function scanStalePriceFiles(
  deps: PricesDeps,
  now: Date,
  timezone: string,
  options: StalePriceFilesScanOptions = {},
): Promise<StalePriceFilesScan> {
  const staleEntries: Array<{
    entry: FileEntry;
    date: PriceFileDate;
    yearSource?: YearAnchorSource;
  }> = [];
  const undatedEntries: FileEntry[] = [];
  const unparsed: FileEntry[] = [];
  const yearless: FileEntry[] = [];
  const consider = (entry: FileEntry, date: PriceFileDate, yearSource?: YearAnchorSource): void => {
    if (!isPriceDateStale(date, now, timezone)) return;
    staleEntries.push(yearSource === undefined ? { entry, date } : { entry, date, yearSource });
  };
  // Область проверки (префиксы и исключения) применяется до любой классификации.
  const inScope = createPriceStaleScope({
    prefixes: deps.staleScan?.prefixes ?? [],
    excludePattern: deps.staleScan?.excludePattern,
  });
  // «Не прайс» по имени (КП, сроки исполнения, «не актуален», каталоги...) отсеивается сразу:
  // ни просрочки, ни «без даты», и такой файл не попадает в запрос к признаку таблицы цен.
  const scoped = (await deps.files.list()).filter(
    (entry) =>
      isPriceFile(entry.path) &&
      inScope(entry.path) &&
      classifyPriceFileName(entry.path) === 'price',
  );
  // Признак «таблица цен»: один пакетный запрос по файлам без слова «прайс» в имени. Нет порта -
  // прежнее правило. Файл, которого нет в базе (нет текста), по содержимому не прайс.
  const verdicts = await loadTableVerdicts(deps, scoped);
  const isPriceByContent = (entry: FileEntry): boolean =>
    verdicts === null ||
    hasPriceWordInFileName(entry.path) ||
    verdicts.get(entry.path) === 'table';
  // Каталоги, презентации и документы-правила прайсами не являются: «без даты» не нужны.
  const keepUnparsed = (entry: FileEntry): void => {
    if (classifyPriceFileName(entry.path) === 'price' && isPriceByContent(entry)) {
      unparsed.push(entry);
    }
  };
  for (const entry of scoped) {
    // Не прайс ни по имени, ни по тексту - не просрочен и не «без даты».
    if (!isPriceByContent(entry)) continue;
    // Без опорной даты: полные даты и `мм-гг`; запись `дд.мм` без года разбирается ниже.
    const date = parsePriceFileDate(entry.path, now, timezone);
    if (date !== null) consider(entry, date);
    else if (hasYearlessDayMonth(entry.path)) yearless.push(entry);
    else keepUnparsed(entry);
  }
  // Год для `дд.мм` берётся из признаков самого файла (путь, свойства, mtime), не из «сегодня».
  // Опора нужна и тем, кого спросят у модели («1 октября» без года): год ей тоже выводится от
  // файла, а не от сегодняшнего дня.
  const modelCandidates = unparsed
    .filter((entry) => looksLikePriceListName(entry.path))
    .slice(0, PRICE_FILE_FALLBACK_MAX_CALLS);
  const resolution = await resolveYearlessAnchors(
    deps,
    [...yearless, ...modelCandidates],
    now,
    timezone,
  );
  for (const entry of yearless) {
    const anchor = resolution.anchors.get(entry.path);
    const date =
      anchor === undefined ? null : parsePriceFileDate(entry.path, now, timezone, anchor.at);
    if (date !== null && anchor !== undefined) consider(entry, date, anchor.source);
    else keepUnparsed(entry);
  }
  const recovered =
    options.modelFallback === false
      ? new Map<string, PriceFileDate>()
      : await resolveByFallback(
          deps,
          unparsed.map((entry) => entry.path),
          now,
          timezone,
          resolution.anchors,
        );
  for (const entry of unparsed) {
    const date = recovered.get(entry.path);
    if (date === undefined) undatedEntries.push(entry);
    else consider(entry, date, impliedYearSource(entry.path, date, resolution.anchors, timezone));
  }
  if (staleEntries.length === 0 && undatedEntries.length === 0) {
    return { stale: [], undated: [], authors: resolution.authors, reads: resolution.reads };
  }

  // Без хранилища (справка вне боевой сборки) поставщик ищется только по названию в пути.
  const history = deps.state === undefined ? [] : await loadDiskImportHistory(deps);
  // Все поставщики постранично (без лимита выборки), индексы имён и истории - один раз.
  const suppliers: SupplierNameRef[] = (await listAllSuppliers(deps.suppliers)).map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
  }));
  const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const matchSupplier = createPriceFileSupplierMatcher(history, suppliers);
  const withSupplier = (
    entry: FileEntry,
    date: PriceFileDate | null,
    yearSource?: YearAnchorSource,
  ): PriceFileItem => {
    const match = matchSupplier(entry.path);
    const supplier = match.kind === 'matched' ? (byId.get(match.supplierId) ?? null) : null;
    return yearSource === undefined
      ? { entry, date, supplier }
      : { entry, date, supplier, yearSource };
  };
  const stale = staleEntries.map(({ entry, date, yearSource }) =>
    withSupplier(entry, date, yearSource),
  );
  const undated = undatedEntries.map((entry) => withSupplier(entry, null));
  stale.sort(compareFiles);
  undated.sort(compareFiles);
  return { stale, undated, authors: resolution.authors, reads: resolution.reads };
}

/**
 * Еженедельная проверка диска: каждый понедельник с `PRICE_FILE_CHECK_HOUR` по часам бизнеса.
 * Прайс-файлы, у которых дата в названии (базовое имя, не дата изменения файла) старше
 * `PRICE_FILE_STALE_MONTHS` месяцев, и файлы без даты в названии. Адресаты: сотрудники отдела
 * закупок, создавшие файл или последними его сохранявшие (имена из свойств документа
 * сопоставляет код, см. `resolveFileRecipients`), - каждому сводка только по его файлам в его
 * личный тред; файлы без найденного сотрудника (и всё, если адресная раздача не подключена) -
 * одним сообщением ответственному за прайсы. Решает код; единственное исключение -
 * необязательный запасной разбор даты моделью (`deps.priceDateFallback`, по флагу) для имён,
 * похожих на прайс, где код даты не нашёл: ответ принимается только после строгой проверки
 * кодом. Каталоги, презентации и документы-правила в «без даты» не попадают. Год для записи
 * `дд.мм` без года берётся из признаков самого файла (путь, свойства документа, дата изменения
 * файла - `resolveYearAnchor`), а не из сегодняшнего дня; в сводке у такой даты пометка источника,
 * без признаков файл идёт в «без даты». В остальных случаях дата изменения файла не участвует.
 *
 * Слот - локальная дата понедельника: в понедельник сообщение уходит один раз, а если сервис
 * был недоступен утром - позже в тот же понедельник (во вторник уже нет). Записей о
 * прежних уведомлениях нет: пока файл устарел, он снова в списке каждый понедельник. Нечего
 * сообщать - ничего не пишется (ни пустого сообщения, ни статуса); слот при этом закрывается.
 * Порядок - отправка, затем слот получателя (`<дата>:<отпечаток треда>`), затем слот дня: при
 * сбое на середине рассылки повтор дошлёт только тем, кому сообщение ещё не ушло, а ключ
 * `chat.reply` не даёт канала задвоить доставку. Сбой одного получателя не мешает остальным;
 * после попытки всем бросается первая ошибка. Ошибка чтения диска пробрасывается.
 */
export async function runStalePriceFilesCheck(
  deps: PricesDeps,
  options: StalePriceFilesOptions,
): Promise<StalePriceFilesResult> {
  const state = requireState(deps);
  const now = deps.clock.now();
  const { timezone } = options;
  if (
    localWeekday(now, timezone) !== PRICE_FILE_CHECK_WEEKDAY ||
    localHour(now, timezone) < PRICE_FILE_CHECK_HOUR
  ) {
    return NO_RUN.not_due;
  }
  const dateKey = localDateKey(now, timezone);
  if (await hasSlot(state, DUTY, dateKey)) return NO_RUN.already_done;

  const { stale, undated, authors, reads } = await scanStalePriceFiles(deps, now, timezone);
  if (stale.length === 0 && undated.length === 0) {
    await markSlot(state, DUTY, dateKey, now);
    return NO_RUN.nothing;
  }

  // Получатели: сотрудники, создавшие или последними правившие файл (по свойствам документа,
  // имена сопоставляет код), остальные файлы - ответственному. Только для файлов этой недели.
  const responsible = responsibleThread(deps);
  const { threadsByPath, openedThreads } = await resolveFileRecipients(
    deps,
    [...stale, ...undated].map((item) => item.entry.path),
    authors,
    PRICE_FILE_AUTHORSHIP_MAX_FILES - reads,
  );
  const perThread = new Map<string, ThreadBucket>();
  const addTo = (item: PriceFileItem, kind: 'stale' | 'undated'): void => {
    for (const thread of threadsByPath.get(item.entry.path) ?? [responsible]) {
      const bucket = perThread.get(thread) ?? { stale: [], undated: [] };
      bucket[kind].push(item);
      perThread.set(thread, bucket);
    }
  };
  for (const item of stale) addTo(item, 'stale');
  for (const item of undated) addTo(item, 'undated');

  const listedPaths = new Set<string>();
  const listedUndatedPaths = new Set<string>();
  let deferred = 0;
  let messages = 0;
  let personal = 0;
  const failures: unknown[] = [];
  let redirectedThreads = 0;
  let redirectedFiles = 0;
  const sendTo = async (thread: string, bucket: ThreadBucket): Promise<void> => {
    // Лимит строк общий на сообщение: сначала устаревшие, затем без даты; остаток - числом.
    const listedStale = bucket.stale.slice(0, PRICE_FILE_MAX_LISTED);
    const listedUndated = bucket.undated.slice(0, PRICE_FILE_MAX_LISTED - listedStale.length);
    const listedCount = listedStale.length + listedUndated.length;
    const threadDeferred = bucket.stale.length + bucket.undated.length - listedCount;
    // Слот получателя: сообщение ему уже ушло в этот понедельник (рестарт посреди рассылки).
    const slotKey = `${dateKey}${RECIPIENT_SLOT_SEPARATOR}${stableHash(thread)}`;
    try {
      if (!(await hasSlot(state, DUTY, slotKey))) {
        await deps.chat.reply(
          thread,
          { text: buildMessage(listedStale, listedUndated, threadDeferred) },
          `price-stale-files:${dateKey}:${stableHash(thread)}`,
        );
        await markSlot(state, DUTY, slotKey, now);
      }
    } catch (error) {
      // Тред построен по id, сотрудник боту не писал: диалога может не быть, и повторы шли бы
      // весь понедельник, а ответственный не получил бы ничего. Файлы уходят ему (ниже).
      if (thread !== responsible && openedThreads.has(thread)) {
        const target = perThread.get(responsible) ?? { stale: [], undated: [] };
        mergeBucket(target, bucket);
        perThread.set(responsible, target);
        redirectedThreads += 1;
        redirectedFiles += bucket.stale.length + bucket.undated.length;
        return;
      }
      failures.push(error);
      return;
    }
    messages += 1;
    if (thread !== responsible) personal += 1;
    deferred += threadDeferred;
    for (const item of listedStale) listedPaths.add(item.entry.path);
    for (const item of listedUndated) {
      listedPaths.add(item.entry.path);
      listedUndatedPaths.add(item.entry.path);
    }
  };
  // Ответственный - последним: при сбое построенного треда его файлы пополняют это сообщение.
  const others = [...perThread.keys()]
    .filter((thread) => thread !== responsible)
    .sort((a, b) => a.localeCompare(b));
  for (const thread of others) {
    const bucket = perThread.get(thread);
    if (bucket !== undefined) await sendTo(thread, bucket);
  }
  const own = perThread.get(responsible);
  if (own !== undefined) await sendTo(responsible, own);
  if (redirectedThreads > 0) {
    // Штатный случай, не сбой: только счётчики, без идентификаторов и путей.
    deps.log?.('price_stale_files_opened_redirected', {
      threads: redirectedThreads,
      files: redirectedFiles,
    });
  }
  if (failures.length > 0) {
    // Слот дня не закрывается: повтор дошлёт только тем, кому ещё не ушло (слоты получателей).
    deps.log?.('price_stale_files_send_failed', {
      failed: failures.length,
      sent: messages,
    });
    throw failures[0];
  }
  await markSlot(state, DUTY, dateKey, now);
  return {
    status: 'sent',
    notified: listedPaths.size,
    deferred,
    undated: listedUndatedPaths.size,
    messages,
    personal,
  };
}
