import { z } from 'zod';
import { createPriceStaleScope } from '../../kit/domain/price-stale-scope';
import type { FileEntry } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { extensionOf } from '@business-ai/core';
import { PRICE_TEXT_EXTENSIONS, SCAN_EXTENSIONS, type PricesDeps } from './deps';

/**
 * Время изменения файла модель видит строкой ISO, а не числом миллисекунд: 13 цифр подряд
 * похожи на ОГРН, и проверки ПДн (своя вторая линия и зарубежный шлюз) могут отклонить запрос.
 */
const knownFileSchema = z.object({
  path: z.string().min(1),
  modifiedAt: z.string().optional(),
  hash: z.string().min(1),
});

const listedFileSchema = z.object({
  path: z.string(),
  /** Нет у удалённого файла, о котором известен только путь и хэш. */
  modifiedAt: z.string().optional(),
  hash: z.string(),
  /** Что случилось с файлом; пусто при полном списке. */
  change: z.enum(['added', 'modified', 'removed']).optional(),
  /** Скан или фото: не обрабатывается, о нём сообщают менеджеру. */
  isScan: z.boolean(),
});
type ListedFile = z.infer<typeof listedFileSchema>;
type KnownFile = z.infer<typeof knownFileSchema>;

/** Время изменения, когда оно неизвестно: на поиск изменений не влияет (сравнивается хэш). */
const UNKNOWN_MTIME_MS = 0;

function toFileEntry(known: KnownFile): FileEntry {
  const parsed = known.modifiedAt === undefined ? Number.NaN : Date.parse(known.modifiedAt);
  return {
    path: known.path,
    mtimeMs: Number.isNaN(parsed) ? UNKNOWN_MTIME_MS : parsed,
    hash: known.hash,
  };
}

/** Время изменения строкой ISO; undefined, если оно неизвестно или вне диапазона дат. */
function modifiedAtOf(entry: FileEntry): string | undefined {
  if (entry.mtimeMs === UNKNOWN_MTIME_MS) return undefined;
  const date = new Date(entry.mtimeMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Сколько путей максимум отдаётся модели за один вызов: список всего диска раздувал контекст
 * и ронял ход (413 на следующем шаге, импорт прайсов 27.10.2026).
 */
export const MAX_LISTED_PRICE_FILES = 200;

interface ListPriceFilesInput {
  known?: KnownFile[] | undefined;
  query?: string | undefined;
  /** С какого файла показывать (страницы по {@link MAX_LISTED_PRICE_FILES}); по умолчанию 0. */
  offset?: number | undefined;
}
interface ListPriceFilesOutput {
  files: ListedFile[];
  /** Список обрезан до {@link MAX_LISTED_PRICE_FILES}: часть файлов не показана. */
  truncated?: boolean | undefined;
  /** Сколько файлов подошло всего (задан только при обрезке). */
  total?: number | undefined;
  /** Что делать при обрезке. */
  hint?: string | undefined;
  /** Смещение следующей страницы; задано, пока остались непоказанные файлы. */
  nextOffset?: number | undefined;
}

/**
 * Страница списка: предел размера ответа защищает контекст хода, но просьбу «покажи все файлы»
 * не режет: остальное отдаётся следующими страницами (`offset=nextOffset`, этап 177).
 */
function capListed(files: ListedFile[], offset: number): ListPriceFilesOutput {
  const end = offset + MAX_LISTED_PRICE_FILES;
  if (files.length <= MAX_LISTED_PRICE_FILES && offset === 0) return { files };
  const page = files.slice(offset, end);
  if (end >= files.length) return { files: page, total: files.length };
  return {
    files: page,
    truncated: true,
    total: files.length,
    nextOffset: end,
    hint:
      `Показаны файлы ${offset + 1}-${end} из ${files.length}: остальные - вызовом с ` +
      `offset=${end} (или сузьте запрос параметром query).`,
  };
}

/** Список прайс-файлов; если передан известный список, только изменения относительно него. */
export const listPriceFiles = defineTool<ListPriceFilesInput, ListPriceFilesOutput, PricesDeps>({
  name: 'listPriceFiles',
  description:
    'Список файлов прайсов на диске. Если передать known (path, modifiedAt, hash ранее ' +
    'обработанных файлов), вернёт только новые, изменённые и удалённые. Параметр query - ' +
    'подстрока пути (без учёта регистра), чтобы найти нужный файл. Только папка прайсов, ' +
    'без архивов. Покажет не более ' +
    `${MAX_LISTED_PRICE_FILES} путей за вызов: при truncated=true остальные придут с ` +
    'offset=nextOffset.',
  inputSchema: z.object({
    known: z.array(knownFileSchema).optional(),
    query: z.string().min(1).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  outputSchema: z.object({
    files: z.array(listedFileSchema),
    truncated: z.boolean().optional(),
    total: z.number().int().optional(),
    hint: z.string().optional(),
    nextOffset: z.number().int().optional(),
  }),
  async execute(input, deps) {
    const supported = [...PRICE_TEXT_EXTENSIONS, ...SCAN_EXTENSIONS];
    const needle = input.query?.toLowerCase();
    // Та же область, что у проверки устаревших прайсов (PRICE_STALE_*: папка прайсов, без
    // архивов): весь диск - тысячи чужих файлов, и в предел попадали не прайсы (тест 28.10.2026).
    const inScope = createPriceStaleScope({
      prefixes: deps.staleScan?.prefixes ?? [],
      excludePattern: deps.staleScan?.excludePattern,
    });
    const isSupported = (path: string): boolean =>
      supported.includes(extensionOf(path)) &&
      inScope(path) &&
      (needle === undefined || path.toLowerCase().includes(needle));
    const toListed = (entry: FileEntry, change?: ListedFile['change']): ListedFile => {
      const modifiedAt = modifiedAtOf(entry);
      return {
        path: entry.path,
        ...(modifiedAt === undefined ? {} : { modifiedAt }),
        hash: entry.hash,
        ...(change === undefined ? {} : { change }),
        isScan: SCAN_EXTENSIONS.includes(extensionOf(entry.path)),
      };
    };
    const offset = input.offset ?? 0;
    if (input.known === undefined) {
      const entries = await deps.files.list();
      return capListed(
        entries.filter((e) => isSupported(e.path)).map((e) => toListed(e)),
        offset,
      );
    }
    const changes = await deps.files.changesSince(input.known.map(toFileEntry));
    return capListed(
      changes
        .filter((change) => isSupported(change.entry.path))
        .map((change) => toListed(change.entry, change.kind)),
      offset,
    );
  },
});
