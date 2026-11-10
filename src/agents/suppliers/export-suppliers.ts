import { z } from 'zod';
import { ACTION_EXPORT_SUPPLIERS } from '../../kit/domain/access.owned';
import { DomainError, isDomainError } from '@business-ai/core';
import {
  SUPPLIER_STATUSES,
  type SupplierCard,
  type SupplierStatus,
} from '../../kit/domain/supplier-card';
import type { TableCell } from '@business-ai/core';
import { defineTool, type ToolContext } from '@business-ai/core';
import { type OperationTurn } from '../../kit/application/tool.owned';
import { FILE_MAX_BYTES } from '../shared/create-file.owned';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { requirePort } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { cardCellValue } from './card-cells';
import { SUPPLIER_AUDIT_EXPORT, type SupplierCardsDeps, type SupplierCardsHost } from './deps';
import {
  resolveSupplierColumn,
  resolveSupplierField,
  supplierColumnTitles,
  type SupplierColumnKey,
  type SupplierTemplateColumn,
} from './supplier-template';

/**
 * Выгрузка базы поставщиков файлом xlsx в чат (этап 215). Модель называет только поля и
 * простой фильтр; значения читает и пишет в файл код, поэтому контакты и реквизиты уходят
 * сотруднику в чат, а в модель - лишь счётчики и имя файла. Заголовки и формат ячеек - как в
 * файле-шаблоне загрузки пачкой, выгрузку можно загрузить обратно.
 *
 * Отказы (нет права, пустая выборка, предел строк или размера) - ошибки инструмента, а не
 * результат: рантайм не кэширует ошибки, и тот же запрос после выдачи права или после изменения
 * базы выполнится заново. В хранилище ключей попадает только успешная выгрузка.
 */

/** Название инструмента. */
export const EXPORT_SUPPLIERS_TOOL = 'exportSuppliers';

/** Больше строк в одну выгрузку не отдаётся: такой файл сотрудник всё равно не прочтёт. */
export const SUPPLIER_EXPORT_MAX_ROWS = 2_000;
/** Размер страницы чтения базы. */
const PAGE_SIZE = 200;
/**
 * Предохранитель обхода: страниц не больше, чем нужно для предела строк с большим запасом.
 * Обход, упёршийся в него на полной странице, - отказ (база длиннее обхода), а не усечение.
 */
const MAX_PAGES = 200;
/**
 * Оценка размера до сборки: сумма длин ячеек (знаков). Выше порога файл не собирается - тот же
 * предел, что и у готового файла: сжатый xlsx меньше, но предел защищает память сборки.
 */
const SIZE_ESTIMATE_MAX_CHARS = FILE_MAX_BYTES;
/** Сколько неизвестных названий полей показывается в отказе. */
const UNKNOWN_SHOWN_MAX = 10;
/** Длина показываемого названия поля: длиннее - это не название. */
const UNKNOWN_NAME_MAX_CHARS = 60;
/** Длина даты `YYYY-MM-DD` в начале ISO-строки. */
const ISO_DATE_LENGTH = 10;
const MODULE_NAME = 'карточки поставщиков';
const SHEET_NAME = 'Поставщики';
const FILE_NAME_STEM = 'Поставщики';
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * Опознающие поля, которые есть в любой выгрузке: название и ИНН. Без них строки не опознать, а
 * выгруженный файл не узнается как шаблон при обратной загрузке и уйдёт в обычную обработку
 * (значения попали бы в модель).
 */
const IDENTITY_KEYS: readonly SupplierColumnKey[] = ['name', 'inn'];

const ACCESS_DENIED_TEXT =
  'Выгрузка базы поставщиков доступна только руководителям отделов. ' +
  'Скажи сотруднику, что файл не создан, и предложи обратиться к своему руководителю.';
/** Справочник руководителей недоступен: причина временная, отказ не означает «нет права». */
const ACCESS_UNAVAILABLE_TEXT =
  'Не удалось проверить, что сотрудник руководитель отдела, поэтому файл не создан. ' +
  'Скажи сотруднику, что это временный сбой, и предложи повторить запрос чуть позже.';
const EMPTY_TEXT = 'По этим условиям поставщиков в базе нет, файл не создан.';
const TOO_MANY_TEXT =
  `Подходящих поставщиков больше ${SUPPLIER_EXPORT_MAX_ROWS}: файл не создан. ` +
  'Предложи сотруднику сузить выборку (статус, товарная группа, бренд, часть названия).';
const TOO_LARGE_TEXT =
  'Файл получился больше допустимого размера и не создан. Предложи сотруднику взять ' +
  'меньше полей или сузить выборку.';

const inputSchema = z.object({
  fields: z
    .array(z.string())
    .describe(
      'Поля карточки, которые назвал сотрудник (например «телефон», «ИНН», «почта», ' +
        '«условия оплаты»). Название поставщика добавляется само. Не добавляй поля от себя.',
    ),
  query: z.string().optional().describe('Часть названия поставщика'),
  category: z.string().optional().describe('Товарная группа поставщика'),
  brand: z.string().optional().describe('Бренд поставщика'),
  status: z
    .enum(SUPPLIER_STATUSES)
    .optional()
    .describe('active - действующий, new - потенциальный, inactive - не действующий'),
});
type ExportInput = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  status: z.literal('sent'),
  /** Что сказать сотруднику; значений из базы здесь нет. */
  message: z.string(),
  fileName: z.string().optional(),
  rows: z.number().int().optional(),
  /** Заголовки столбцов файла (названия полей, не значения). */
  columns: z.array(z.string()).optional(),
});
type ExportOutput = z.infer<typeof outputSchema>;

/** Фильтры, заданные сотрудником: в аудит идут только их имена. */
const FILTER_KEYS = ['query', 'category', 'brand', 'status'] as const;

function foldText(value: string): string {
  return value.trim().toLowerCase().replaceAll('ё', 'е');
}

function includesFolded(haystack: readonly string[], needle: string): boolean {
  return haystack.some((item) => foldText(item).includes(needle));
}

/** Проверка карточки по фильтру сотрудника: условия действуют вместе. */
function matchesFilter(card: SupplierCard, input: ExportInput): boolean {
  const status: SupplierStatus | undefined = input.status;
  if (status !== undefined && card.status !== status) return false;
  const query = foldText(input.query ?? '');
  if (query !== '' && !foldText(card.name).includes(query)) return false;
  const category = foldText(input.category ?? '');
  if (category !== '' && !includesFolded(card.supplies.categories, category)) return false;
  const brand = foldText(input.brand ?? '');
  return brand === '' || includesFolded(card.supplies.brands, brand);
}

/**
 * Колонки выгрузки по названиям сотрудника: название и ИНН первыми всегда, повторы и синонимы
 * одной колонки схлопываются, группа («контакты», «реквизиты») раскрывается в несколько колонок.
 * Неизвестное название - отказ со списком допустимых, неоднозначное («адрес») - отказ с короткой
 * подсказкой вариантов; значений в тексте отказа нет.
 */
function resolveColumns(fields: readonly string[]): SupplierTemplateColumn[] {
  const wanted = fields.map((field) => field.trim()).filter((field) => field !== '');
  if (wanted.length === 0) {
    throw new DomainError(
      'invalid_input',
      `Назови поля, которые нужны в файле. Допустимые: ${supplierColumnTitles().join(', ')}.`,
    );
  }
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const found = new Map<SupplierColumnKey, SupplierTemplateColumn>();
  for (const field of wanted) {
    const shown = field.slice(0, UNKNOWN_NAME_MAX_CHARS);
    const resolved = resolveSupplierField(field);
    if (resolved.kind === 'unknown') unknown.push(shown);
    else if (resolved.kind === 'ambiguous') {
      ambiguous.push(`«${shown}» - ${resolved.options.join(' или ')}`);
    } else {
      for (const column of resolved.columns) {
        if (!found.has(column.key)) found.set(column.key, column);
      }
    }
  }
  if (ambiguous.length > 0) {
    throw new DomainError(
      'invalid_input',
      `Название поля неоднозначно: ${ambiguous.slice(0, UNKNOWN_SHOWN_MAX).join('; ')}. ` +
        'Файл не создан; уточни у сотрудника, какое именно поле нужно.',
    );
  }
  if (unknown.length > 0) {
    throw new DomainError(
      'invalid_input',
      `Неизвестные поля: ${unknown.slice(0, UNKNOWN_SHOWN_MAX).join(', ')}. ` +
        `Допустимые: ${supplierColumnTitles().join(', ')}. Файл не создан; ` +
        'уточни у сотрудника, какие поля нужны.',
    );
  }
  const identity = IDENTITY_KEYS.flatMap((key) => {
    const column = resolveSupplierColumn(key);
    return column === undefined ? [] : [column];
  });
  const rest = [...found.values()].filter((column) => !IDENTITY_KEYS.includes(column.key));
  return [...identity, ...rest];
}

/** Строка файла. */
interface ExportRow {
  cells: TableCell[];
}

type Collected =
  | { kind: 'ok'; rows: ExportRow[] }
  | { kind: 'too_many' }
  | { kind: 'too_large' };

/** Длина ячейки в знаках для оценки размера: число считается по записи, пусто - нулём. */
function cellLength(cell: TableCell): number {
  return cell === null ? 0 : String(cell).length;
}

/**
 * Читает базу страницами и собирает строки по фильтру. Прекращает обход, как только подходящих
 * больше предела строк (`too_many`) или сумма длин ячеек перешла порог (`too_large`): файл до
 * сборки не доходит. Обход, исчерпавший страницы без конца базы, - тоже `too_many`: усекать
 * молча нельзя.
 */
async function collectRows(
  deps: SupplierCardsDeps,
  input: ExportInput,
  columns: readonly SupplierTemplateColumn[],
): Promise<Collected> {
  const rows: ExportRow[] = [];
  let size = columns.reduce((sum, column) => sum + column.header.length, 0);
  let after: string | null = null;
  let reachedEnd = false;
  for (let page = 0; page < MAX_PAGES && !reachedEnd; page += 1) {
    const suppliers = await deps.suppliers.listPage(after, PAGE_SIZE);
    const last = suppliers.at(-1);
    if (last === undefined) {
      reachedEnd = true;
      break;
    }
    after = last.id;
    const batch = await deps.suppliers.getCards(suppliers.map((supplier) => supplier.id));
    for (const card of batch) {
      if (!matchesFilter(card, input)) continue;
      const cells = columns.map((column) => cardCellValue(card, column.key));
      size += cells.reduce((sum: number, cell) => sum + cellLength(cell), 0);
      if (size > SIZE_ESTIMATE_MAX_CHARS) return { kind: 'too_large' };
      rows.push({ cells });
      if (rows.length > SUPPLIER_EXPORT_MAX_ROWS) return { kind: 'too_many' };
    }
    reachedEnd = suppliers.length < PAGE_SIZE;
  }
  return reachedEnd ? { kind: 'ok', rows } : { kind: 'too_many' };
}

/** Результат записи аудита: успех или код отказа. */
type AuditResult = 'ok' | 'denied' | 'not_employee_turn' | 'empty' | 'too_many_rows' | 'too_large';

/** Запись аудита: действие, число строк, ключи полей и имена фильтров - без значений. */
async function auditExport(
  deps: SupplierCardsDeps,
  fact: {
    actor: string;
    agentId: string;
    operationId: string;
    result: AuditResult;
    rows: number;
    fields: readonly string[];
    filters: readonly string[];
  },
): Promise<void> {
  const at = deps.clock.now().toISOString();
  try {
    // Ключ записи - операция и результат: повтор той же операции не плодит дубли.
    await deps.audit.append(
      {
        at,
        actor: fact.actor,
        agent: fact.agentId,
        action: SUPPLIER_AUDIT_EXPORT,
        details:
          `rows=${fact.rows} fields=${fact.fields.join(',')} filters=${fact.filters.join(',')}`,
        result: fact.result,
      },
      `${SUPPLIER_AUDIT_EXPORT}:${fact.operationId}:${fact.result}`,
    );
  } catch (error) {
    // Файл уже у сотрудника (или отказ уже дан): сбой журнала не ломает ответ, но виден в логе.
    deps.log?.('supplier_export_audit_failed', {
      code: isDomainError(error) ? error.code : 'unexpected',
    });
  }
}

/** Автор действия для журнала: сотрудник, а для не-сотрудника - вид инициатора хода. */
function actorOf(context: ToolContext): string {
  const { initiator } = context;
  return initiator.kind === 'user' ? `user:${initiator.userId}` : `system:${initiator.kind}`;
}

/** Исполнитель в ключе повтора: сотрудник либо вид инициатора. */
function whoOf(turn: OperationTurn | number | undefined): string {
  // Платформа передаёт в предшественника только номер реплики: исполнитель неизвестен.
  if (turn === undefined || typeof turn === 'number') return 'unknown';
  return turn.initiator.kind === 'user' ? turn.initiator.userId : turn.initiator.kind;
}

/** Номер реплики из объекта хода либо числа (форма вызова платформы). */
function turnNumberOf(turn: OperationTurn | number | undefined): number {
  if (turn === undefined) return 0;
  return typeof turn === 'number' ? turn : turn.turnNumber;
}

/** Выгрузить базу поставщиков в xlsx и отправить сотруднику в чат. */
export const exportSuppliers = defineTool<ExportInput, ExportOutput, SupplierCardsHost>({
  name: EXPORT_SUPPLIERS_TOOL,
  description:
    'Выгрузить базу поставщиков файлом xlsx в чат сотруднику. fields - только поля, которые ' +
    'сотрудник назвал в запросе (название и ИНН добавляются сами); значения в ответ не ' +
    'приходят - читает и пишет в файл код. Можно сузить выборку: query (часть названия), ' +
    'category, brand, status. Больше предела строк или размера файл не создаётся.',
  sideEffect: true,
  // Другой тред или время - другой файл в чате, поэтому повтор после падения только по кнопке.
  replay: 'confirm',
  inputSchema,
  outputSchema,
  idempotencyKey: (input) => `export-suppliers:${stableHash(input)}`,
  // Ключ идемпотентности общий на все треды: без треда, сотрудника и номера реплики второй
  // сотрудник с тем же запросом получил бы чужой результат, а не свой файл. Номер реплики
  // (а не текущее время) задаёт границу повтора: повтор той же реплики после падения процесса
  // получает тот же ключ в любой момент и не шлёт дубль, новая реплика - свежая выгрузка,
  // потому что база между репликами менялась.
  idempotencyPredecessor: async (_input, _host, threadId, turn) =>
    `${threadId}:${whoOf(turn)}:${turnNumberOf(turn)}`,
  async execute(input, host, context) {
    const deps = requirePort(host.supplierCards, MODULE_NAME);
    const filters = FILTER_KEYS.filter((key) => (input[key] ?? '') !== '');
    const base = { actor: actorOf(context), agentId: context.agentId };
    const operationId = context.operationId;
    /** Отказ: запись в аудит и ошибка инструмента (рантайм её не кэширует). */
    const refuse = async (
      result: Exclude<AuditResult, 'ok'>,
      error: DomainError,
      fields: readonly string[] = [],
    ): Promise<never> => {
      await auditExport(deps, { ...base, operationId, result, rows: 0, fields, filters });
      throw error;
    };
    let userId: string;
    try {
      userId = assertEmployeeChatTurn(context);
    } catch (error) {
      if (error instanceof DomainError) return refuse('not_employee_turn', error);
      throw error;
    }
    const access = requirePort(deps.access, 'проверка прав');
    const request = { userId, botId: context.agentId, action: ACTION_EXPORT_SUPPLIERS };
    // Только руководителям отделов (этап 234); сбой справочника - отдельный текст, но тоже отказ.
    const decision =
      access.decide === undefined
        ? { allowed: await access.isAllowed(request), reason: undefined }
        : await access.decide(request);
    if (!decision.allowed) {
      const text =
        decision.reason === 'directory_unavailable' ? ACCESS_UNAVAILABLE_TEXT : ACCESS_DENIED_TEXT;
      return refuse('denied', new DomainError('access_denied', text));
    }
    // Поля проверяются до чтения базы: опечатка не стоит обхода тысяч карточек.
    const columns = resolveColumns(input.fields);
    const fieldKeys = columns.map((column) => column.key);
    const exporter = requirePort(deps.tableExporter, 'выгрузка таблиц');
    const collected = await collectRows(deps, input, columns);
    if (collected.kind === 'too_many') {
      return refuse('too_many_rows', new DomainError('invalid_input', TOO_MANY_TEXT), fieldKeys);
    }
    if (collected.kind === 'too_large') {
      return refuse('too_large', new DomainError('invalid_input', TOO_LARGE_TEXT), fieldKeys);
    }
    if (collected.rows.length === 0) {
      return refuse('empty', new DomainError('not_found', EMPTY_TEXT), fieldKeys);
    }
    // Значения ячеек пишутся как есть, без safeCell: сервис выгрузки сам пишет строки текстом
    // (data_type "s"), поэтому «=...» не исполняется, а второй слой дал бы видимый апостроф.
    const sheet = {
      name: SHEET_NAME,
      columns: columns.map((column) => column.header.replace('*', '')),
      rows: collected.rows.map((row): TableCell[] => row.cells),
    };
    const stamp = deps.clock.now().toISOString().slice(0, ISO_DATE_LENGTH);
    const file = await exporter.export([sheet], 'xlsx', `${FILE_NAME_STEM} ${stamp}`);
    if (file.bytes.length > FILE_MAX_BYTES) {
      return refuse('too_large', new DomainError('invalid_input', TOO_LARGE_TEXT), fieldKeys);
    }
    // Файл только в тред текущего хода сотрудника; ключ - операция, повтор не шлёт дубль.
    // Аудит ok - после отправки: запись говорит о доставленном файле. Падение между отправкой
    // и записью лечит повтор той же операции: ключ отправки и ключ записи те же, файл не
    // дублируется, а запись появится.
    await deps.chat.sendFile(
      context.threadId,
      { name: file.fileName, mimeType: file.mimeType || XLSX_MIME_TYPE, content: file.bytes },
      `${SUPPLIER_AUDIT_EXPORT}:${operationId}`,
    );
    await auditExport(deps, {
      ...base,
      operationId,
      result: 'ok',
      rows: sheet.rows.length,
      fields: fieldKeys,
      filters,
    });
    return {
      status: 'sent',
      message:
        `Файл отправлен в чат: ${sheet.rows.length} поставщиков, ` +
        `столбцов ${sheet.columns.length}. ` +
        'Скажи сотруднику коротко, что отправил файл и какие в нём поля; значения не пересказывай.',
      fileName: file.fileName,
      rows: sheet.rows.length,
      columns: sheet.columns,
    };
  },
});

/** Блок промпта агента: когда вызывать `exportSuppliers`. */
export const SUPPLIER_EXPORT_PROMPT = `

Выгрузка базы поставщиков:
- Если сотрудник просит выгрузить / скинуть файлом базу поставщиков (всех или по группе), вызови
  ${EXPORT_SUPPLIERS_TOOL}: в fields передай только поля, которые он назвал, при необходимости
  добавь фильтр. Значения из базы ты не видишь и не пересказываешь: файл собирает код и
  отправляет в чат. Не используй createFile для данных базы поставщиков.
- Не назвал поля - спроси, какие нужны. Предел и отказ по правам объясни сотруднику своими
  словами.`;
