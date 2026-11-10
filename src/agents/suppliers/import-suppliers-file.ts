import type { ZodIssue } from 'zod';
import {
  DUPLICATE_REASON_LABELS,
  SUPPLIER_STATUS_LABELS,
  SUPPLIER_STATUSES,
  duplicateReasons,
  findDuplicateKeys,
  validateSupplierCard,
  type DuplicateKeys,
  type DuplicateMatch,
  type DuplicateReason,
  type SupplierStatus,
} from '../../kit/domain/supplier-card';
import { isDomainError } from '@business-ai/core';
import { checkSupplierNameForm } from '../../kit/domain/supplier-legal-form';
import type { DiskFile, DocumentParser } from '@business-ai/core';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';
import { requirePort, stableHash, toStoredJson } from '@business-ai/core';
import {
  cardFromFields,
  supplierCardFieldsSchema,
  type ContactFields,
  type SupplierCardFields,
} from './card-fields';
import { sanitizeSupplierCard } from './card-sanitize';
import { CONFIRM_CARD_UNAVAILABLE_TEXT, confirmCardVerdict } from './confirm-card-right';
import { columnKeyOfField, parseExtraRowFields } from './import-row-fields';
import {
  decisionHintLine,
  notePendingSupplierRequest,
  type SupplierBatchRequest,
  type SupplierCardAction,
} from './card-request';
import {
  SUPPLIER_BATCH_MAX_ROWS,
  SUPPLIER_BATCH_NAMESPACE,
  SUPPLIER_REPORT_LIST_LIMIT,
  type SupplierCardsDeps,
} from './deps';
import {
  SUPPLIER_TEMPLATE_COLUMNS,
  SUPPLIER_TEMPLATE_EXAMPLE_NAME,
  matchSupplierHeaders,
  type SupplierColumnKey,
} from './supplier-template';

/**
 * Загрузка поставщиков файлом-шаблоном: детерминированный разбор таблицы (без модели),
 * построчная проверка, отчёт сотруднику и запрос подтверждения пачки одним ответом.
 * Содержимое файла модели не передаётся: ПДн остаются в коде и в состоянии запроса.
 */

/** Расширения таблиц, которые имеет смысл пробовать разбирать как шаблон поставщиков. */
const IMPORT_EXTENSIONS: readonly string[] = ['.xlsx', '.xls', '.csv'];
/** Сколько первых строк листа просматриваем в поисках заголовков. */
const HEADER_SCAN_ROWS = 10;
/** Разделитель значений в списках: `;`, `,` или перевод строки. */
const LIST_SPLIT = /[;,\n]+/;
/** Числовая ячейка Excel с хвостом `.0`. */
const TRAILING_ZERO = /^(\d+)\.0+$/;

/** Подходит ли имя файла для разбора как таблицы поставщиков. */
export function isSupplierImportCandidate(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Лист с найденными заголовками: колонки и строки данных с номерами строк файла. */
export interface SupplierTable {
  columns: ReadonlyMap<SupplierColumnKey, number>;
  rows: Array<{ row: number; cells: string[] }>;
}

/**
 * Найти в разобранном документе лист-шаблон поставщиков по заголовкам (чтобы не путать с
 * прайсом). Номер строки - позиция в таблице листа, считая с единицы.
 */
export function findSupplierTable(tables: readonly string[][][]): SupplierTable | null {
  for (const table of tables) {
    const limit = Math.min(HEADER_SCAN_ROWS, table.length);
    for (let index = 0; index < limit; index += 1) {
      const columns = matchSupplierHeaders(table[index] ?? []);
      if (columns === null) continue;
      const rows = table
        .slice(index + 1)
        .map((cells, offset) => ({ row: index + offset + 2, cells }));
      return { columns, rows };
    }
  }
  return null;
}

function cellOf(
  cells: readonly string[],
  columns: ReadonlyMap<SupplierColumnKey, number>,
  key: SupplierColumnKey,
): string | undefined {
  const index = columns.get(key);
  const raw = index === undefined ? undefined : cells[index];
  const value = raw?.trim().replace(TRAILING_ZERO, '$1');
  return value === undefined || value === '' ? undefined : value;
}

/** Прежние названия статусов в файлах: понимаются наряду с новыми подписями. */
const LEGACY_STATUS_WORDS: Readonly<Record<string, SupplierStatus>> = {
  новый: 'new',
  'не работаем': 'inactive',
};

function statusOf(value: string | undefined): SupplierStatus | 'unknown' | undefined {
  if (value === undefined) return undefined;
  const lower = value.trim().toLowerCase();
  const direct = SUPPLIER_STATUSES.find((status) => status === lower);
  if (direct !== undefined) return direct;
  const byLabel = SUPPLIER_STATUSES.find((status) => SUPPLIER_STATUS_LABELS[status] === lower);
  return byLabel ?? LEGACY_STATUS_WORDS[lower] ?? 'unknown';
}

function listOf(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(LIST_SPLIT)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? undefined : items;
}

/** Строка пуста: ни одной непустой ячейки. */
function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

function headerOf(key: SupplierColumnKey | undefined): string {
  const column = SUPPLIER_TEMPLATE_COLUMNS.find((item) => item.key === key);
  return column === undefined ? 'поле' : column.header.replace('*', '');
}

/** Замечание схемы по длине: без значения, с названием колонки. */
function schemaIssueText(issue: ZodIssue): string {
  const path = issue.path.filter((part): part is string => typeof part === 'string');
  // Первое название пути, которое есть среди колонок (`contacts.0.fullName` - ФИО контакта).
  const key = path.map(columnKeyOfField).find((item) => item !== undefined);
  return `Колонка «${headerOf(key)}»: значение не принято, ячейка оставлена пустой.`;
}

/** Сколько раз повторяем разбор, убирая поля, которые схема не приняла. */
const SCHEMA_RETRY_LIMIT = 5;

/**
 * Результат разбора одной строки. Этап 177: `issues` - только то, что мешает записи (нет
 * названия); всё остальное (непонятные и неверные значения) уходит в `warnings`, строка
 * записывается с очищенными ячейками.
 */
interface RowParse {
  fields: SupplierCardFields;
  issues: string[];
  warnings: string[];
}

/** Строка таблицы -> поля карточки и замечания (тексты без значений ячеек). */
function parseSupplierRow(
  cells: readonly string[],
  columns: ReadonlyMap<SupplierColumnKey, number>,
): RowParse {
  const get = (key: SupplierColumnKey): string | undefined => cellOf(cells, columns, key);
  const issues: string[] = [];
  const warnings: string[] = [];
  const status = statusOf(get('status'));
  if (status === 'unknown') {
    warnings.push('Статус: допустимы «действующий», «потенциальный», «не действующий».');
  }
  const contact: ContactFields = {
    ...(get('contactName') === undefined ? {} : { fullName: get('contactName') }),
    ...(get('contactPosition') === undefined ? {} : { position: get('contactPosition') }),
    ...(get('email') === undefined ? {} : { email: get('email') }),
    ...(get('phone') === undefined ? {} : { phone: get('phone') }),
    ...(get('messenger') === undefined ? {} : { messenger: get('messenger') }),
    isPrimary: true,
  };
  const hasContact = Object.keys(contact).length > 1;
  const terms = {
    ...(get('payment') === undefined ? {} : { payment: get('payment') }),
    ...(get('delivery') === undefined ? {} : { delivery: get('delivery') }),
    ...(get('minBatch') === undefined ? {} : { minBatch: get('minBatch') }),
    ...(get('leadTime') === undefined ? {} : { leadTime: get('leadTime') }),
    ...(get('discounts') === undefined ? {} : { discounts: get('discounts') }),
  };
  const extra = parseExtraRowFields(get);
  warnings.push(...extra.issues);
  const raw = {
    ...extra.fields,
    ...(get('name') === undefined ? {} : { name: get('name') }),
    ...(get('inn') === undefined ? {} : { inn: get('inn') }),
    ...(get('website') === undefined ? {} : { website: get('website') }),
    ...(status === undefined || status === 'unknown' ? {} : { status }),
    ...(hasContact ? { contacts: [contact] } : {}),
    ...(listOf(get('categories')) === undefined ? {} : { categories: listOf(get('categories')) }),
    ...(listOf(get('brands')) === undefined ? {} : { brands: listOf(get('brands')) }),
    ...(listOf(get('regions')) === undefined ? {} : { regions: listOf(get('regions')) }),
    ...(Object.keys(terms).length === 0 ? {} : { terms }),
    ...(get('note') === undefined ? {} : { note: get('note') }),
  };
  // Схема принимает не всё (например, длинные списки полной карточки): непринятое поле
  // убираем из строки с предупреждением и разбираем остальное, а не бросаем всю строку.
  let parsed = supplierCardFieldsSchema.safeParse(raw);
  for (let retry = 0; !parsed.success && retry < SCHEMA_RETRY_LIMIT; retry += 1) {
    warnings.push(...new Set(parsed.error.issues.map(schemaIssueText)));
    for (const issue of parsed.error.issues) {
      const top = issue.path[0];
      if (typeof top === 'string') delete (raw as Record<string, unknown>)[top];
    }
    parsed = supplierCardFieldsSchema.safeParse(raw);
  }
  if (!parsed.success) {
    issues.push('Строка не разобрана.');
    return { fields: {}, issues, warnings: [...new Set(warnings)] };
  }
  const fields = parsed.data;
  const card = cardFromFields(
    fields,
    { userId: 'import', nowIso: new Date(0).toISOString(), source: 'file' },
    'check',
  );
  const sanitized = sanitizeSupplierCard(card);
  warnings.push(...sanitized.warnings);
  // Не лечится очисткой только пустое название: ключа записи нет, строка пропускается.
  issues.push(...validateSupplierCard(sanitized.card).map((issue) => issue.message));
  return { fields, issues: [...new Set(issues)], warnings: [...new Set(warnings)] };
}

/** Строка, готовая к записи как новая карточка. */
interface ImportValidRow {
  row: number;
  name: string;
  fields: SupplierCardFields;
  /** Подсказки, не мешающие записи (например, нет формы собственности). */
  warnings: string[];
}

/** Строка-дубль: внутри файла (`file`, `firstRow`) или с базой (`base`, `targetId`). */
interface ImportDuplicateRow {
  row: number;
  name: string;
  fields: SupplierCardFields;
  /** Подсказки, не мешающие записи. */
  warnings: string[];
  scope: 'file' | 'base';
  reasons: DuplicateReason[];
  /** Для `file`: номер первой строки с тем же поставщиком. */
  firstRow?: number;
  /** Для `base`: карточка, которую обновит «Записать и обновить дубли». */
  targetId?: string;
  /** Для `base`: название существующей карточки. */
  existingName?: string;
}

/** Строка с замечаниями: не записывается (нет названия) либо записывается с очисткой. */
interface ImportInvalidRow {
  row: number;
  issues: string[];
}

/** Отчёт проверки файла: что можно записать, что дубль, что с ошибками. */
export interface SupplierImportReport {
  valid: ImportValidRow[];
  duplicates: ImportDuplicateRow[];
  invalid: ImportInvalidRow[];
  /** Примерные строки шаблона, пропущенные без записи. */
  skippedExamples: number;
  /** Строки, записываемые с очищенными значениями (этап 177): что не принято и очищено. */
  cleaned: ImportInvalidRow[];
}

function keysOf(fields: SupplierCardFields): DuplicateKeys {
  return findDuplicateKeys({
    name: fields.name ?? '',
    ...(fields.inn === undefined ? {} : { inn: fields.inn }),
    contacts: fields.contacts ?? [],
  });
}

/**
 * Проверить строки таблицы: пустые и примерные пропускаются, остальные - в `valid`,
 * `duplicates` (повтор внутри файла или совпадение с базой) или `invalid`.
 */
async function checkSupplierTable(
  suppliers: SupplierRepository,
  table: SupplierTable,
): Promise<SupplierImportReport> {
  const report: SupplierImportReport = {
    valid: [],
    duplicates: [],
    invalid: [],
    skippedExamples: 0,
    cleaned: [],
  };
  const seen: Array<{ row: number; keys: DuplicateKeys }> = [];
  for (const { row, cells } of table.rows) {
    if (isBlank(cells)) continue;
    const { fields, issues, warnings: rowWarnings } = parseSupplierRow(cells, table.columns);
    if (fields.name === SUPPLIER_TEMPLATE_EXAMPLE_NAME) {
      report.skippedExamples += 1;
      continue;
    }
    if (issues.length > 0) {
      report.invalid.push({ row, issues });
      continue;
    }
    const name = fields.name ?? '';
    // Наименование в карточке не правится: только подсказка в отчёте.
    const warnings = checkSupplierNameForm(name).map((issue) => issue.message);
    if (rowWarnings.length > 0) report.cleaned.push({ row, issues: rowWarnings });
    const keys = keysOf(fields);
    const earlier = seen.find((item) => duplicateReasons(keys, item.keys).length > 0);
    if (earlier !== undefined) {
      const reasons = duplicateReasons(keys, earlier.keys);
      report.duplicates.push({
        row,
        name,
        fields,
        warnings,
        scope: 'file',
        reasons,
        firstRow: earlier.row,
      });
      continue;
    }
    seen.push({ row, keys });
    const matches = await suppliers.findDuplicates({
      name,
      ...(fields.inn === undefined ? {} : { inn: fields.inn }),
      contacts: fields.contacts ?? [],
    });
    const best: DuplicateMatch | undefined = matches[0];
    if (best === undefined) {
      report.valid.push({ row, name, fields, warnings });
    } else {
      report.duplicates.push({
        row,
        name,
        fields,
        warnings,
        scope: 'base',
        reasons: best.reasons,
        targetId: best.supplierId,
        existingName: best.name,
      });
    }
  }
  return report;
}

function reasonsText(reasons: readonly DuplicateReason[]): string {
  return reasons.map((reason) => DUPLICATE_REASON_LABELS[reason]).join(', ');
}

function limited(lines: readonly string[]): string[] {
  const shown = lines.slice(0, SUPPLIER_REPORT_LIST_LIMIT);
  const rest = lines.length - shown.length;
  return rest > 0 ? [...shown, `- и ещё ${rest}`] : shown;
}

/** Отчёт для сотрудника: итоги и строки с номерами. */
function formatSupplierImportReport(report: SupplierImportReport): string {
  const baseDuplicates = report.duplicates.filter((item) => item.scope === 'base');
  const fileDuplicates = report.duplicates.filter((item) => item.scope === 'file');
  const lines = [
    'Проверка файла поставщиков:',
    `Можно записать новыми: ${report.valid.length}.`,
    `Уже есть в базе: ${baseDuplicates.length}.`,
    `Повторы внутри файла: ${fileDuplicates.length}.`,
    `Без названия (пропущены): ${report.invalid.length}.`,
  ];
  if (report.skippedExamples > 0) lines.push('Примерная строка шаблона пропущена.');
  if (baseDuplicates.length > 0) {
    lines.push(
      'Совпадают с базой:',
      ...limited(
        baseDuplicates.map(
          (item) =>
            `- строка ${item.row}: «${item.name}» похоже на существующего ` +
            `«${item.existingName ?? ''}» (${reasonsText(item.reasons)})`,
        ),
      ),
    );
  }
  if (fileDuplicates.length > 0) {
    lines.push(
      'Повторы в файле (записывается только первая строка):',
      ...limited(
        fileDuplicates.map(
          (item) =>
            `- строка ${item.row} повторяет строку ${item.firstRow ?? '?'} ` +
            `(${reasonsText(item.reasons)})`,
        ),
      ),
    );
  }
  if (report.invalid.length > 0) {
    lines.push(
      'Пропущены:',
      ...limited(report.invalid.map((item) => `- строка ${item.row}: ${item.issues.join(' ')}`)),
    );
  }
  const cleaned = report.cleaned;
  if (cleaned.length > 0) {
    lines.push(
      'Предупреждения (строки записываются, неверные значения оставлены пустыми):',
      ...limited(cleaned.map((item) => `- строка ${item.row}: ${item.issues.join(' ')}`)),
    );
  }
  const hinted = [...report.valid, ...report.duplicates].filter(
    (item) => item.warnings.length > 0,
  );
  if (hinted.length > 0) {
    lines.push(
      'Подсказки (строки записываются как есть, наименование не меняется):',
      ...limited(
        hinted
          .sort((a, b) => a.row - b.row)
          .map((item) => `- строка ${item.row}: добавьте форму собственности (ООО, АО, ИП).`),
      ),
    );
  }
  return lines.join('\n');
}

/** Файл, присланный сотрудником в тред. */
export interface SupplierImportInput {
  /** Агент-владелец сценария (бот, в чате которого прислан файл). */
  agentId: string;
  threadId: string;
  /** Сотрудник из события канала. */
  userId: string;
  fileName: string;
  /** Содержимое в памяти; у файла на диске (`disk`) пустое. */
  content: Uint8Array;
  /**
   * Файл на диске (большой прайс, этап 231): разбирается по пути, без чтения в память. Нет
   * `parseFile` у разборщика - вызывающий кладёт содержимое в `content`.
   */
  disk?: DiskFile | undefined;
}

/** Итог обработки файла. `not_template` - это не шаблон, файл разбирает обычный сценарий. */
export type SupplierImportOutcome =
  | { kind: 'not_template' }
  | { kind: 'too_many_rows'; rows: number }
  | { kind: 'nothing_to_write'; report: SupplierImportReport }
  /** Загрузивший не руководитель отдела: отчёт показан, запроса записи нет (этап 234). */
  | { kind: 'no_permission'; report: SupplierImportReport }
  /** Справочник руководителей недоступен: право неизвестно, запроса записи нет. */
  | { kind: 'access_unavailable'; report: SupplierImportReport }
  | { kind: 'shown'; token: string; report: SupplierImportReport };

/** Подсказки ответа на отчёт пачки. */
const BATCH_HINT_SAVE_ONLY_NEW = 'записать только новых';
const BATCH_HINT_SAVE = 'записать';
const BATCH_HINT_UPDATE_WITH_NEW = 'записать и обновить дубли';
const BATCH_HINT_UPDATE = 'обновить дубли';
const BATCH_HINT_CANCEL = 'отмена';

/**
 * Варианты ответа на отчёт пачки (вместо кнопок): `save` - только новые строки, `update` -
 * новые и обновление дублей базы. Подписи - подсказка жирным в тексте.
 */
function batchChoices(report: SupplierImportReport): {
  actions: SupplierCardAction[];
  hint: string;
} {
  const baseDuplicates = report.duplicates.filter((item) => item.scope === 'base').length;
  const actions: SupplierCardAction[] = [];
  const labels: string[] = [];
  if (report.valid.length > 0) {
    actions.push('save');
    labels.push(baseDuplicates > 0 ? BATCH_HINT_SAVE_ONLY_NEW : BATCH_HINT_SAVE);
  }
  if (baseDuplicates > 0) {
    actions.push('update');
    labels.push(report.valid.length > 0 ? BATCH_HINT_UPDATE_WITH_NEW : BATCH_HINT_UPDATE);
  }
  actions.push('cancel');
  labels.push(BATCH_HINT_CANCEL);
  return { actions, hint: decisionHintLine(labels) };
}

/** Код сбоя обработки файла, который уже распознан как шаблон поставщиков. */
export const SUPPLIER_IMPORT_FAILED_CODE = 'supplier_import_failed';

/**
 * Сбой после того, как файл распознан как шаблон поставщиков (проверка дублей, состояние,
 * ответ в чат). Такой файл содержит ПДн контактов и в прежний путь (приём файлов, модель) не
 * попадает: вызывающий отвечает сотруднику и останавливается. Причина - в `cause`, текст без
 * значений из файла.
 */
export class SupplierImportFailedError extends Error {
  readonly code = SUPPLIER_IMPORT_FAILED_CODE;
  /** Код причины (код доменной ошибки или `unexpected`), для журнала. */
  readonly causeCode: string;

  constructor(cause: unknown) {
    super('Файл поставщиков распознан, но обработать его не удалось.');
    this.name = 'SupplierImportFailedError';
    this.causeCode = isDomainError(cause) ? cause.code : 'unexpected';
  }
}

/**
 * Разобрать присланный файл как шаблон поставщиков и показать отчёт с подсказкой. Не шаблон -
 * `not_template` без сообщений (файл пойдёт обычным путём). Запись пачки выполняет
 * `SupplierCardService.press` по ответу сотрудника, здесь в базу ничего не пишется.
 *
 * Фазы: разбор и поиск заголовков - сбой здесь пробрасывается как есть (файл ещё не признан
 * шаблоном, прежний путь допустим); всё после признания шаблоном - сбой превращается в
 * `SupplierImportFailedError`.
 */
export async function importSuppliersFile(
  deps: SupplierCardsDeps,
  input: SupplierImportInput,
): Promise<SupplierImportOutcome> {
  const parser: DocumentParser = requirePort(deps.parser, 'разбор файлов');
  // Прайс до 100 МБ: разбор по пути, а не через FormData из памяти (+190 МБ на 100 МБ файла).
  const parsed =
    input.disk !== undefined && parser.parseFile !== undefined
      ? await parser.parseFile(input.fileName, input.disk)
      : await parser.parse(input.fileName, input.content);
  const table = findSupplierTable(parsed.tables);
  if (table === null) return { kind: 'not_template' };
  try {
    return await processSupplierTable(deps, input, table);
  } catch (error) {
    throw new SupplierImportFailedError(error);
  }
}

/** Отчёт и запрос подтверждения по таблице, распознанной как шаблон. */
async function processSupplierTable(
  deps: SupplierCardsDeps,
  input: SupplierImportInput,
  table: SupplierTable,
): Promise<SupplierImportOutcome> {
  const requestedAt = deps.clock.now().toISOString();
  // Ответ об ошибках файла отправляется на каждую присылку: хэш содержимого и момент в ключе
  // не дают каналу отбросить отчёт по повторно присланному файлу как повтор доставки.
  const key = `suppliers-import:${stableHash([input.threadId, input.userId, table.rows])}`;
  const replyKey = `${key}:${requestedAt}`;
  const filled = table.rows.filter((item) => !isBlank(item.cells));
  if (filled.length > SUPPLIER_BATCH_MAX_ROWS) {
    await deps.chat.reply(
      input.threadId,
      {
        text:
          `В файле ${filled.length} строк: за один раз можно загрузить не больше ` +
          `${SUPPLIER_BATCH_MAX_ROWS}. Разбейте файл на части.`,
      },
      `${replyKey}:too-many`,
    );
    return { kind: 'too_many_rows', rows: filled.length };
  }
  const report = await checkSupplierTable(deps.suppliers, table);
  const text = formatSupplierImportReport(report);
  const baseDuplicates = report.duplicates.filter((item) => item.scope === 'base');
  if (report.valid.length === 0 && baseDuplicates.length === 0) {
    await deps.chat.reply(input.threadId, { text }, `${replyKey}:report`);
    return { kind: 'nothing_to_write', report };
  }
  // Предложение записать показывается только тому, кто вправе подтвердить запись в общую базу
  // (как и показ карточки): не-руководитель получает отчёт и пояснение, а не вопрос, на который
  // потом придёт отказ. Политики нет - прежнее поведение (запись всё равно закрыта проверкой
  // права на подтверждении).
  if (deps.access !== undefined) {
    const verdict = await confirmCardVerdict(deps.access, {
      userId: input.userId,
      botId: input.agentId,
    });
    if (verdict !== 'allowed') {
      const note =
        verdict === 'denied'
          ? 'Записать эти данные в общую базу может руководитель отдела: передайте файл ему.'
          : CONFIRM_CARD_UNAVAILABLE_TEXT;
      await deps.chat.reply(input.threadId, { text: `${text}\n${note}` }, `${replyKey}:no-right`);
      return verdict === 'denied'
        ? { kind: 'no_permission', report }
        : { kind: 'access_unavailable', report };
    }
  }
  const token = stableHash(['scard-batch', input.userId, input.threadId, key, requestedAt]);
  const request: SupplierBatchRequest = {
    token,
    kind: 'batch',
    agentId: input.agentId,
    ownerUserId: input.userId,
    threadId: input.threadId,
    requestedAt,
    status: 'shown',
    rows: report.valid.map((item) => ({ row: item.row, fields: item.fields })),
    duplicates: baseDuplicates.map((item) => ({
      row: item.row,
      fields: item.fields,
      ...(item.targetId === undefined ? {} : { targetId: item.targetId }),
    })),
  };
  await deps.state.put(SUPPLIER_BATCH_NAMESPACE, token, toStoredJson(request));
  const choices = batchChoices(report);
  await deps.chat.reply(
    input.threadId,
    { text: `${text}\nЗаписать в базу?\n${choices.hint}` },
    `scard:${token}`,
  );
  // Ответ сотрудника текстом модель записывает confirmSupplierRequest по этому указателю.
  await notePendingSupplierRequest(deps.state, input.threadId, {
    token,
    actions: choices.actions,
  });
  return { kind: 'shown', token, report };
}
