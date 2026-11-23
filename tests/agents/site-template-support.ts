import {
  FixedClock,
  MemoryBotFileRegistry,
  MemoryChatChannel,
  MemoryEmployeeIdentity,
  MemoryFileSource,
  MemoryTemplateWorkbook,
  MemoryWorkflowStateStore,
  encodeMemoryWorkbook,
  type MemoryWorkbookModel,
} from '@business-ai/adapters';
import { createToolContext, type ToolContext } from '@business-ai/core';
import { type SiteExportDeps } from '../../src/agents/site-export/deps';
import type { BitrixAttachmentReader, TemplateHeader } from '@business-ai/core';
import { buildSiteDeps } from './site-support';

/** Синтетический шаблон сайта: структура как у шаблона заказчика, данные выдуманные. */

export const SHEET_MAIN = 'приложение 1 - оператор';
export const SHEET_CONTENT = 'Содержание';
export const SHEET_CARD = 'Карточка товара';
export const SHEET_FILTERS = 'категории для ФИЛЬТРОВ';
export const TEMPLATE_PATH = 'Сайт/шаблон.xlsx';
export const USER_ID = '2002';
export const THREAD_ID = 'orders/2002';

export const PRICE_LIST = [
  'до 500 руб.',
  'до 1 тыс.',
  'до 2 тыс.',
  '2-5 тыс.',
  '5-10 тыс.',
  '10-20 тыс.',
  'более 20 тыс.',
];
export const WEEKS_LIST = [1, 2, 3, 4, 5, 6, 7];
export const PACK_LIST = ['подарочная', 'транспортная', 'отсутствует'];
export const DIRECTION_LIST = ['Категория A', 'Категория B', 'Категория C', 'Категория D'];
export const SECTION_LIST = ['Раздел A', 'Раздел B'];

interface ColumnSpec {
  letter: string;
  col: number;
  text: string;
  yellow: boolean;
  list?: ReadonlyArray<string | number>;
}

/** Колонки: порядок и жёлтые как в шаблоне заказчика, но короче (только нужные для правил). */
export const COLUMNS: readonly ColumnSpec[] = [
  { letter: 'A', col: 1, text: 'Раздел', yellow: false, list: SECTION_LIST },
  { letter: 'H', col: 8, text: 'Название', yellow: true },
  { letter: 'I', col: 9, text: 'Артикул', yellow: true },
  { letter: 'J', col: 10, text: 'Основное фото', yellow: true },
  { letter: 'P', col: 16, text: 'Описание / Легенда', yellow: true },
  {
    letter: 'Q',
    col: 17,
    text: 'Размер упаковки, мм, (ш-в-г) (размер сувенира)',
    yellow: true,
  },
  { letter: 'T', col: 20, text: 'Срок изготовления, недели', yellow: true, list: WEEKS_LIST },
  { letter: 'U', col: 21, text: 'Упаковка (подарочная)', yellow: true, list: PACK_LIST },
  { letter: 'V', col: 22, text: 'Направления', yellow: true, list: DIRECTION_LIST },
  { letter: 'Y', col: 25, text: 'по цене', yellow: true, list: PRICE_LIST },
  { letter: 'AA', col: 27, text: 'Стоимость при минимальном тираже, руб./шт. С НДС', yellow: true },
  { letter: 'AB', col: 28, text: 'Дополнительная информация', yellow: false },
  { letter: 'AD', col: 30, text: 'Менеджер ответств.', yellow: true },
  { letter: 'AE', col: 31, text: 'последняя корректировка по цене и срокам', yellow: true },
  { letter: 'AF', col: 32, text: 'месяц первичной загрузки данных на сайт', yellow: true },
  { letter: 'AH', col: 34, text: 'название поставщика. Техническое поле', yellow: true },
  { letter: 'AI', col: 35, text: 'Оператор', yellow: false },
];

export function headersOf(columns: readonly ColumnSpec[] = COLUMNS): TemplateHeader[] {
  return columns.map((spec) => ({
    col: spec.col,
    letter: spec.letter,
    text: spec.text,
    fillRgb: spec.yellow ? 'FFFF00' : null,
    yellow: spec.yellow,
    allowedValues: spec.list === undefined ? null : [...spec.list],
    listSource: spec.list === undefined ? null : 'x14',
    listFormula: spec.list === undefined ? null : `'${SHEET_FILTERS}'!$A$1:$A$9`,
    listUnresolved: false,
    listTruncated: false,
  }));
}

/** Примеры под шапкой: строки 12 и 13 заполнены (как в шаблоне на диске). */
export const EXAMPLE_CELLS: Record<string, string | number> = {
  H12: 'Пример изделия',
  I12: 'EX-1',
  T12: 3,
  AE12: '2026-08-25',
  H13: 'Ещё пример',
  I13: 'EX-2',
};

export interface BookOptions {
  cells?: Record<string, string | number>;
  /** Значения листов 2-4 (ссылка -> значение). */
  other?: Partial<Record<string, Record<string, string | number>>>;
  columns?: readonly ColumnSpec[];
}

/** Файл книги для MemoryTemplateWorkbook. */
export function buildBook(options: BookOptions = {}): Uint8Array {
  const model: MemoryWorkbookModel = {
    sheets: [SHEET_MAIN, SHEET_CONTENT, SHEET_CARD, SHEET_FILTERS],
    headerRow: 11,
    headers: headersOf(options.columns),
    cells: {
      [SHEET_MAIN]: { A1: 'Пояснение к шаблону', H11: 'Название', ...(options.cells ?? {}) },
      [SHEET_CONTENT]: options.other?.[SHEET_CONTENT] ?? { A1: 'Содержание' },
      [SHEET_CARD]: options.other?.[SHEET_CARD] ?? {},
      [SHEET_FILTERS]: options.other?.[SHEET_FILTERS] ?? { B2: 'до 500 руб.' },
    },
  };
  return encodeMemoryWorkbook(model);
}

export interface TemplateWorld {
  deps: SiteExportDeps & {
    chat: MemoryChatChannel;
    state: MemoryWorkflowStateStore;
    workbook: MemoryTemplateWorkbook;
    templateFiles: MemoryFileSource;
    employeeIdentity: MemoryEmployeeIdentity;
    botFiles: MemoryBotFileRegistry;
    clock: FixedClock;
  };
  disk: MemoryFileSource;
  identity: MemoryEmployeeIdentity;
  /** Файл, который «скачивается» из чата. */
  chatFile: { name: string; bytes: Uint8Array } | null;
  setChatFile(name: string, bytes: Uint8Array): void;
  ctx: ToolContext;
  /** Контекст другого вызова: другой operationId. */
  ctxOf(operationId: string): ToolContext;
}

export interface WorldOptions {
  diskBytes?: Uint8Array | null;
  identity?: { firstName: string; lastName: string } | null;
  now?: Date;
}

/** Окружение инструментов шаблона: диск, часы, личность, чат с файлом. */
export async function buildTemplateWorld(options: WorldOptions = {}): Promise<TemplateWorld> {
  const base = await buildSiteDeps(1);
  const disk = new MemoryFileSource();
  const diskBytes = options.diskBytes === undefined
    ? buildBook({ cells: EXAMPLE_CELLS })
    : options.diskBytes;
  if (diskBytes !== null) disk.put(TEMPLATE_PATH, diskBytes, 1);
  const identity = new MemoryEmployeeIdentity();
  const identityName =
    options.identity === undefined ? { firstName: 'Иван', lastName: 'Тестов' } : options.identity;
  if (identityName !== null) identity.set(USER_ID, identityName);
  const clock = new FixedClock(options.now ?? new Date('2026-11-02T10:00:00.000Z'));
  const botFiles = new MemoryBotFileRegistry({ clock });
  const world: TemplateWorld = {
    chatFile: null,
    disk,
    identity,
    deps: undefined as never,
    setChatFile(name, bytes) {
      world.chatFile = { name, bytes };
      botFiles.remember(THREAD_ID, { botId: 1, fileId: 7, name });
    },
    ctx: makeCtx('op-1'),
    ctxOf: makeCtx,
  };
  const attachments: BitrixAttachmentReader = {
    async fetchAttachments() {
      const file = world.chatFile;
      if (file === null) return { attachments: [], errors: [] };
      return {
        attachments: [
          { name: file.name, mime: 'application/octet-stream', bytes: file.bytes, source: 'bot' },
        ],
        errors: [],
      };
    },
  };
  world.deps = {
    ...base,
    clock,
    // Колонки названия и артикула в шаблоне заказчика называются «Название…» и «Артикул…»;
    // заглушка платформы по умолчанию ищет `name` и `code`.
    workbook: new MemoryTemplateWorkbook({ nameHeader: 'название', codeHeader: 'артикул' }),
    templateFiles: disk,
    siteTemplatePath: TEMPLATE_PATH,
    employeeIdentity: identity,
    botFiles,
    attachments,
  };
  return world;
}

function makeCtx(operationId: string): ToolContext {
  return createToolContext({
    threadId: THREAD_ID,
    agentId: 'site-export',
    operationId,
    initiator: { kind: 'user', userId: USER_ID },
  });
}
