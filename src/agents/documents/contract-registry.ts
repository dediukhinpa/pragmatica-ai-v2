import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import type { FileEntry, FileSource } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { baseName, extensionOf } from '@business-ai/core';
import type { DocumentsDeps } from './deps';

/** Папка реестров договоров на диске К (путь от корня файлового источника). */
export const CONTRACT_REGISTRY_DIR = 'Юридическая документация';

/** Юрлица, у которых есть свой реестр: часть имени файла после «Реестр заключенных договоров». */
export const CONTRACT_REGISTRY_ENTITIES: readonly string[] = ['Прагматика', 'Мастер Гифтс'];

/** Расширения, которые умеет разобрать документ-парсер. */
const REGISTRY_EXTENSIONS: readonly string[] = ['.xlsx', '.xls', '.csv'];

/** Короче искать нельзя: две буквы совпадут с половиной реестра и ничего не скажут. */
const MIN_QUERY_LENGTH = 3;

/** Лимит совпадений на один реестр: ответ идёт в модель, весь реестр ей не нужен. */
const MAX_MATCHES_PER_REGISTRY = 20;

const SEPARATOR = ' | ';

/** Глубина поиска папки реестров: до трёх уровней от корня, шару целиком не обходим. */
export const REGISTRY_SEARCH_MAX_DEPTH = 3;

/** Лимит различных каталогов на корень: защита от разросшейся шары. */
const MAX_SCANNED_DIRS = 5000;

/** Таймаут получения списка файлов корня при поиске, мс: зависшая шара не вешает ход агента. */
const SEARCH_LIST_TIMEOUT_MS = 20_000;

/** Сколько имён каталогов показываем в сообщении об отказе (только имена, без файлов). */
const MAX_REPORTED_DIRS = 40;

/** Корни, где ищем реестр: шаблоны (по умолчанию) и диск К. */
export type RegistryRoot = 'templates' | 'files';

const ROOT_ORDER: readonly RegistryRoot[] = ['templates', 'files'];
const ROOT_LABEL: Record<RegistryRoot, string> = { templates: 'шаблонов', files: 'файлов' };

/** Разобранная настройка CONTRACT_REGISTRY_PATH. */
export interface RegistryLocation {
  root: RegistryRoot;
  /** Путь папки реестров от корня, без начального и конечного «/». */
  dir: string;
}

/**
 * Разбор `CONTRACT_REGISTRY_PATH`: `files:<путь>` или `templates:<путь>`. Пусто = не задано.
 * Абсолютный путь и «..» отклоняются (undefined): настройка только сужает чтение под корнем.
 */
export function parseContractRegistryPath(raw: string | undefined): RegistryLocation | undefined {
  const text = (raw ?? '').trim();
  const match = /^(files|templates):(.*)$/.exec(text);
  if (match === null) return undefined;
  const dir = (match[2] ?? '').replaceAll('\\', '/').split('/').filter((part) => part !== '');
  if (dir.length === 0 || dir.includes('..') || dir.includes('.')) return undefined;
  if ((match[2] ?? '').trim().startsWith('/')) return undefined;
  return { root: match[1] as RegistryRoot, dir: dir.join('/') };
}

/** Имя реестра без расширения: `<год> год Реестр заключенных договоров <юрлицо>`. */
export function registryFileStem(year: number, entity: string): string {
  return `${year} год Реестр заключенных договоров ${entity}`;
}

/**
 * Сравнение без регистра, в NFC, «ё» = «е», без кавычек, пробелы схлопнуты: на диске имена
 * бывают в NFD, а папку могли назвать в кавычках.
 */
function fold(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[«»"“”„']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const matchSchema = z.object({
  entity: z.string(),
  /** Лист/таблица реестра, если парсер их различает. */
  sheet: z.string().optional(),
  /** Заголовок таблицы реестра (первая строка): подписи столбцов. */
  header: z.string(),
  /** Найденная строка реестра целиком (ячейки через « | »). */
  row: z.string(),
});

const registrySchema = z.object({
  entity: z.string(),
  /** Имя файла реестра, который искали или прочитали. */
  file: z.string(),
  /**
   * read - прочитан; not_found - файла нет на диске; read_error - файл есть, но не читается
   * (причина в reason).
   */
  status: z.enum(['read', 'not_found', 'read_error']),
  reason: z.string().optional(),
});

const searchSchema = z.object({
  /** Настройка CONTRACT_REGISTRY_PATH в том виде, как задана (пусто - не задана). */
  configuredPath: z.string().optional(),
  /** Где найдена папка реестров: `<корень>:<путь>`; нет - не найдена. */
  foundIn: z.string().optional(),
  maxDepth: z.number().int(),
  scannedDirs: z.number().int(),
  /** Каталоги первых уровней по корням: только имена, при неудаче поиска. */
  roots: z.array(
    z.object({
      root: z.enum(['templates', 'files']),
      listed: z.boolean(),
      topDirs: z.array(z.string()),
    }),
  ),
});

interface RegistryInput {
  query: string;
}
interface RegistryOutput {
  year: number;
  registries: Array<z.infer<typeof registrySchema>>;
  matches: Array<z.infer<typeof matchSchema>>;
  /** Совпадений больше лимита: показаны первые, уточните запрос. */
  truncated: boolean;
  /** Где искали папку реестров (для сообщения сотруднику при неудаче). */
  search: z.infer<typeof searchSchema>;
  /** Что обязан сделать агент: задаётся кодом, чтобы не зависеть от формулировки модели. */
  instruction: string;
}

/** Файл реестра на диске: первый подходящий по префиксу имени (xlsx раньше xls и csv). */
function findRegistryEntry(
  entries: readonly FileEntry[],
  dirPath: string,
  stem: string,
): FileEntry | undefined {
  const dir = fold(dirPath);
  const wanted = fold(stem);
  return entries
    .filter((entry) => {
      const path = entry.path.replaceAll('\\', '/').normalize('NFC');
      const name = baseName(path);
      // Служебные файлы-блокировки Excel «~$…» - не реестр.
      if (name.startsWith('~$') || !REGISTRY_EXTENSIONS.includes(extensionOf(name))) return false;
      return fold(path.slice(0, path.length - name.length)) === `${dir}/` &&
        fold(name).startsWith(wanted);
    })
    .sort((a, b) => extensionRank(a.path) - extensionRank(b.path) || a.path.localeCompare(b.path))
    .at(0);
}

/** В каталоге (от корня) есть хотя бы один файл, в том числе во вложенных папках. */
function dirHasFiles(entries: readonly FileEntry[], dirPath: string): boolean {
  const prefix = `${fold(dirPath)}/`;
  return entries.some((entry) => fold(entry.path.replaceAll('\\', '/')).startsWith(prefix));
}

function extensionRank(path: string): number {
  return REGISTRY_EXTENSIONS.indexOf(extensionOf(path));
}


/** Список файлов корня с таймаутом: зависшая шара не должна держать ход агента. */
async function listWithTimeout(files: FileSource): Promise<FileEntry[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DomainError('external_failure', 'список файлов не получен за отведённое время')),
      SEARCH_LIST_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([files.list(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface RootListing {
  entries?: FileEntry[];
  error?: string;
}

interface Candidate extends RegistryLocation {
  depth: number;
}

/** Сегменты каталогов файла (без имени), пути в NFC и с «/». */
function dirSegments(entry: FileEntry): string[] {
  const parts = entry.path.replaceAll('\\', '/').normalize('NFC').split('/');
  return parts.filter((part) => part !== '').slice(0, -1);
}

/**
 * Папки с именем реестров до заданной глубины и первые уровни каталогов. Каталоги берутся из
 * путей файлов (порт отдаёт только файлы); различных каталогов не больше лимита.
 */
function scanDirs(
  root: RegistryRoot,
  entries: readonly FileEntry[],
): { found: Candidate[]; topDirs: string[]; scanned: number } {
  const wanted = fold(CONTRACT_REGISTRY_DIR);
  const seen = new Set<string>();
  const found: Candidate[] = [];
  const top = new Set<string>();
  for (const entry of entries) {
    const segments = dirSegments(entry).slice(0, REGISTRY_SEARCH_MAX_DEPTH);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const dir = segments.slice(0, depth).join('/');
      if (seen.has(dir)) continue;
      if (seen.size >= MAX_SCANNED_DIRS) break;
      seen.add(dir);
      if (depth <= 2) top.add(dir);
      if (fold(segments[depth - 1] ?? '') === wanted) found.push({ root, dir, depth });
    }
  }
  const topDirs = [...top].sort((a, b) => a.localeCompare(b)).slice(0, MAX_REPORTED_DIRS);
  return { found, topDirs, scanned: seen.size };
}

/** Что сказать сотруднику, если реестр не прочитан: где искали и какие каталоги видны. */
function searchReport(search: z.infer<typeof searchSchema>): string {
  const roots = search.roots.map((item) => {
    const state = item.listed ? `каталоги: ${item.topDirs.join(', ') || 'нет'}` : 'не прочитан';
    return `корень ${ROOT_LABEL[item.root]} (${item.root}) - ${state}`;
  });
  const configured =
    search.configuredPath === undefined
      ? 'CONTRACT_REGISTRY_PATH не задан'
      : `CONTRACT_REGISTRY_PATH=${search.configuredPath} не дал результата`;
  return (
    `Папка «${CONTRACT_REGISTRY_DIR}» с нужным реестром не найдена: ${configured}; искали в ` +
    `корнях на глубину ${search.maxDepth} (просмотрено каталогов: ${search.scannedDirs}). ` +
    `${roots.join('; ')}. Назови сотруднику, где искали. Оператору: положить реестр в папку ` +
    `«${CONTRACT_REGISTRY_DIR}» в каталоге шаблонов или задать CONTRACT_REGISTRY_PATH ` +
    '(files:<путь> или templates:<путь>).'
  );
}

/** Причина ошибки чтения без текстов системных ошибок: только код/сообщение домена. */
function readFailure(file: string, error: unknown): string {
  if (error instanceof DomainError) return `ошибка чтения файла ${file}: ${error.message}`;
  return `ошибка чтения файла ${file}`;
}

/**
 * Реестр договоров на диске К (только чтение): ищет договоры контрагента или юрлица по
 * подстроке в строках реестров «Прагматики» и «Мастер Гифтс» за текущий год. Файл читается
 * мимо списка разрешённых шаблонов осознанно, но только по двум именам реестров.
 */
export const searchContractRegistry = defineTool<RegistryInput, RegistryOutput, DocumentsDeps>({
  name: 'searchContractRegistry',
  description:
    'Реестр заключенных договоров на диске («Юридическая документация», файлы «<год> год ' +
    'Реестр заключенных договоров Прагматика» и «… Мастер Гифтс», год берётся по текущей ' +
    'дате). Только чтение. query - контрагент или юрлицо (подстрока без учёта регистра). ' +
    'Если найден договор с этим контрагентом - ОБЯЗАТЕЛЬНО скажи об этом сотруднику (какой ' +
    'реестр и строка). Если реестр не найден или не читается - скажи сотруднику точную ' +
    'причину из registries[].reason, не молчи. Номер и дату нового договора сотрудник ' +
    'смотрит в реестре сам: система их не присваивает.',
  inputSchema: z.object({ query: z.string().trim().min(MIN_QUERY_LENGTH) }),
  outputSchema: z.object({
    year: z.number().int(),
    registries: z.array(registrySchema),
    matches: z.array(matchSchema),
    truncated: z.boolean(),
    search: searchSchema,
    instruction: z.string(),
  }),
  async execute(input, deps) {
    const year = (deps.clock?.now() ?? new Date()).getUTCFullYear();
    const needle = fold(input.query);
    const registries: RegistryOutput['registries'] = [];
    const matches: RegistryOutput['matches'] = [];
    let truncated = false;
    const configured = parseContractRegistryPath(deps.contractRegistryPath);
    const configuredText = (deps.contractRegistryPath ?? '').trim();
    const sources: Partial<Record<RegistryRoot, FileSource>> = {
      templates: deps.files,
      ...(deps.registryFiles === undefined ? {} : { files: deps.registryFiles }),
    };
    // Реестры только читаем: list/read, записи на диск нет.
    const listings = new Map<RegistryRoot, RootListing>();
    const candidates: Candidate[] = [];
    const topDirs = new Map<RegistryRoot, string[]>();
    let scannedDirs = 0;
    for (const root of ROOT_ORDER) {
      const source = sources[root];
      if (source === undefined) continue;
      try {
        const entries = await listWithTimeout(source);
        listings.set(root, { entries });
        const scan = scanDirs(root, entries);
        candidates.push(...scan.found);
        topDirs.set(root, scan.topDirs);
        scannedDirs += scan.scanned;
      } catch (error) {
        listings.set(root, { error: readFailure(CONTRACT_REGISTRY_DIR, error) });
      }
    }
    // Порядок: заданный путь, затем найденные папки: меньшая глубина и корень шаблонов раньше.
    candidates.sort(
      (a, b) =>
        a.depth - b.depth ||
        ROOT_ORDER.indexOf(a.root) - ROOT_ORDER.indexOf(b.root) ||
        a.dir.localeCompare(b.dir),
    );
    if (configured !== undefined) candidates.unshift({ ...configured, depth: 0 });
    const listError = [...listings.values()].every((item) => item.entries === undefined)
      ? [...listings.values()].map((item) => item.error ?? '').find((text) => text !== '')
      : undefined;
    let foundIn: string | undefined;
    for (const entity of CONTRACT_REGISTRY_ENTITIES) {
      const stem = registryFileStem(year, entity);
      if (listError !== undefined) {
        registries.push({ entity, file: stem, status: 'read_error', reason: listError });
        continue;
      }
      let entry: FileEntry | undefined;
      let source: FileSource | undefined;
      for (const candidate of candidates) {
        const found = findRegistryEntry(
          listings.get(candidate.root)?.entries ?? [],
          candidate.dir,
          stem,
        );
        if (found === undefined) continue;
        entry = found;
        source = sources[candidate.root];
        foundIn ??= `${candidate.root}:${candidate.dir}`;
        break;
      }
      if (entry === undefined || source === undefined) {
        // Две разные причины: «папки нет нигде» и «папка есть, файла реестра в ней нет». Раньше
        // всегда писали «в папке», и агент пересказывал «папка найдена», хотя её не было.
        const folderExists = candidates.some((candidate) =>
          dirHasFiles(listings.get(candidate.root)?.entries ?? [], candidate.dir),
        );
        registries.push({
          entity,
          file: stem,
          status: 'not_found',
          reason: folderExists
            ? `папка «${CONTRACT_REGISTRY_DIR}» найдена, но файла «${stem}» в ней нет`
            : `папка «${CONTRACT_REGISTRY_DIR}» не найдена ни в каталоге шаблонов, ` +
              'ни на диске К',
        });
        continue;
      }
      const file = baseName(entry.path);
      try {
        if (deps.parser === undefined) {
          throw new DomainError('not_configured', 'разбор таблиц не настроен');
        }
        const parsed = await deps.parser.parse(file, await source.read(entry.path));
        const found: RegistryOutput['matches'] = [];
        parsed.tables.forEach((table, index) => {
          const header = (table[0] ?? []).join(SEPARATOR);
          for (const cells of table.slice(1)) {
            const row = cells.join(SEPARATOR);
            if (fold(row).includes(needle)) {
              const sheet = parsed.tableNames?.[index];
              found.push({ entity, ...(sheet === undefined ? {} : { sheet }), header, row });
            }
          }
        });
        if (found.length > MAX_MATCHES_PER_REGISTRY) truncated = true;
        matches.push(...found.slice(0, MAX_MATCHES_PER_REGISTRY));
        registries.push({ entity, file, status: 'read' });
      } catch (error) {
        registries.push({
          entity,
          file,
          status: 'read_error',
          reason: readFailure(file, error),
        });
      }
    }
    const missing = registries.some((item) => item.status === 'not_found');
    const search: RegistryOutput['search'] = {
      ...(configured === undefined ? {} : { configuredPath: configuredText }),
      ...(foundIn === undefined ? {} : { foundIn }),
      maxDepth: REGISTRY_SEARCH_MAX_DEPTH,
      scannedDirs,
      roots: ROOT_ORDER.filter((root) => sources[root] !== undefined).map((root) => ({
        root,
        listed: listings.get(root)?.entries !== undefined,
        topDirs: missing ? (topDirs.get(root) ?? []) : [],
      })),
    };
    const instruction = instructionFor(registries, matches, missing ? search : undefined);
    return { year, registries, matches, truncated, search, instruction };
  },
});

/** Указание агенту по итогу поиска: сообщить о совпадениях и о каждой неудаче реестра. */
function instructionFor(
  registries: RegistryOutput['registries'],
  matches: RegistryOutput['matches'],
  notFoundSearch?: RegistryOutput['search'],
): string {
  const parts: string[] = [];
  if (matches.length > 0) {
    parts.push('Договор с этим контрагентом уже есть в реестре: сообщи сотруднику, не молчи.');
  }
  for (const registry of registries) {
    if (registry.status !== 'read') {
      const reason = registry.reason ?? '';
      parts.push(`Реестр «${registry.entity}» не прочитан: ${reason}. Скажи об этом.`);
    }
  }
  if (notFoundSearch !== undefined) {
    parts.push(searchReport(notFoundSearch));
    // Отсутствие реестра ничего не останавливает: номер и дату проставят маркеры.
    parts.push(
      'Это не ошибка и не повод для вопросов: не спрашивай номер и дату договора, договор ' +
        'выдаётся с маркерами «[ЗАПОЛНИТЬ: …]», продолжай сборку.',
    );
  }
  if (parts.length === 0) parts.push('Договоров с этим контрагентом в реестрах за год нет.');
  return parts.join(' ');
}
