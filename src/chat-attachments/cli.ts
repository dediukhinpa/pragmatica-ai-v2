import { ChatAttachmentArchive } from './archive';
import { parseChatAttachmentsConfig } from './config';
import type { ChatAttachmentQuery, ChatAttachmentRecord } from './types';

/**
 * Команды владельца для архива файлов чатов (этап 9s). Запускаются внутри контейнера app:
 * `bun run src/chat-attachments-cli.ts <команда> [флаги]`. Читают индекс и том приёма
 * (`INTAKE_ROOT`), в сеть и базу не ходят.
 *
 * - `find`  - поиск записей по сотруднику, боту, дате, имени файла, хэшу;
 * - `path`  - абсолютный путь файла в контейнере (для `docker cp`);
 * - `stats` - сколько файлов и байт в архиве, самая старая и новая запись;
 * - `purge` - очистка по сроку и объёму сейчас (то же, что делает ежедневная задача).
 */

/** Куда пишет команда: вывод и ошибки (в тестах - массивы). */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Код выхода: сделано. */
export const CLI_EXIT_OK = 0;
/** Код выхода: ошибка выполнения. */
export const CLI_EXIT_ERROR = 1;
/** Код выхода: неверный вызов. */
export const CLI_EXIT_USAGE = 2;

/** Сколько записей читает `stats` (практический потолок индекса за срок хранения). */
const STATS_LIMIT = 1_000_000;
/** Предел записей `find` по умолчанию (как у архива). */
const DEFAULT_FIND_LIMIT = 200;
const BYTES_PER_KIB = 1024;
const SHORT_SHA_CHARS = 8;
const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Текст справки. */
export const CHAT_ATTACHMENTS_CLI_USAGE = [
  'Использование: bun run src/chat-attachments-cli.ts <команда> [флаги]',
  '  find  [--user ID] [--bot КЛЮЧ] [--agent ID] [--thread ID] [--name ЧАСТЬ_ИМЕНИ]',
  '        [--date ГГГГ-ММ-ДД | --from ВРЕМЯ --to ВРЕМЯ] [--sha ПРЕФИКС] [--limit N] [--json]',
  '        день --date считается по поясу BUSINESS_TIMEZONE (по умолчанию UTC);',
  '        --from/--to - время ISO (2026-11-05T09:00:00Z).',
  '  path  <относительный путь из find>   абсолютный путь файла в контейнере',
  '  stats                               размер архива и границы записей',
  '  purge                               очистка по сроку и объёму сейчас',
].join('\n');

/** Флаги команды: `--имя значение`, `--имя` без значения - булев. */
interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  rest: string[];
}

const BOOLEAN_FLAGS: readonly string[] = ['json'];

function parseArgs(argv: readonly string[]): ParsedArgs | string {
  const [command, ...tail] = argv;
  if (command === undefined) return 'не указана команда';
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const item = tail[index] ?? '';
    if (!item.startsWith('--')) {
      rest.push(item);
      continue;
    }
    const name = item.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      flags.set(name, 'true');
      continue;
    }
    const value = tail[index + 1];
    if (value === undefined || value.startsWith('--')) return `у флага --${name} нет значения`;
    flags.set(name, value);
    index += 1;
  }
  return { command, flags, rest };
}

/** Смещение пояса относительно UTC в миллисекундах на момент `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string): number =>
    Number(parts.find((item) => item.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Границы календарного дня `ГГГГ-ММ-ДД` в поясе: [полночь, полночь следующих суток).
 * `null` - дата или пояс некорректны.
 */
export function dayRangeIn(date: string, timeZone: string): { from: Date; to: Date } | null {
  const match = DATE_PATTERN.exec(date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const midnightUtc = Date.UTC(year, month - 1, day);
  if (new Date(midnightUtc).getUTCDate() !== day) return null;
  try {
    // Два прохода: смещение зависит от момента (переход на летнее время).
    const first = midnightUtc - zoneOffsetMs(new Date(midnightUtc), timeZone);
    const start = midnightUtc - zoneOffsetMs(new Date(first), timeZone);
    const nextUtc = midnightUtc + MS_PER_DAY;
    const nextFirst = nextUtc - zoneOffsetMs(new Date(nextUtc), timeZone);
    const end = nextUtc - zoneOffsetMs(new Date(nextFirst), timeZone);
    return { from: new Date(start), to: new Date(end - 1) };
  } catch {
    return null;
  }
}

/** Условия поиска из флагов; строка - текст ошибки. */
function queryOf(
  flags: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): ChatAttachmentQuery | string {
  const query: ChatAttachmentQuery = {};
  const user = flags.get('user');
  if (user !== undefined) query.user = user;
  const bot = flags.get('bot');
  if (bot !== undefined) query.bot = bot;
  const agent = flags.get('agent');
  if (agent !== undefined) query.agent = agent;
  const thread = flags.get('thread');
  if (thread !== undefined) query.thread = thread;
  const name = flags.get('name');
  if (name !== undefined) query.name = name;
  const sha = flags.get('sha');
  if (sha !== undefined) query.sha = sha;
  const limit = flags.get('limit');
  if (limit !== undefined) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value <= 0) return '--limit: нужно положительное целое';
    query.limit = value;
  } else {
    query.limit = DEFAULT_FIND_LIMIT;
  }
  const date = flags.get('date');
  if (date !== undefined) {
    const range = dayRangeIn(date, env['BUSINESS_TIMEZONE']?.trim() || 'UTC');
    if (range === null) return '--date: нужна дата ГГГГ-ММ-ДД и корректный BUSINESS_TIMEZONE';
    query.from = range.from;
    query.to = range.to;
  }
  for (const key of ['from', 'to'] as const) {
    const raw = flags.get(key);
    if (raw === undefined) continue;
    const moment = new Date(raw);
    if (Number.isNaN(moment.getTime())) return `--${key}: нужно время в формате ISO`;
    query[key] = moment;
  }
  return query;
}

/** Размер для людей: Б, КиБ, МиБ. */
function humanSize(bytes: number): string {
  if (bytes < BYTES_PER_KIB) return `${bytes} Б`;
  if (bytes < BYTES_PER_KIB * BYTES_PER_KIB) return `${(bytes / BYTES_PER_KIB).toFixed(1)} КиБ`;
  return `${(bytes / (BYTES_PER_KIB * BYTES_PER_KIB)).toFixed(1)} МиБ`;
}

/** Строка записи для человека; имя файла идёт с кавычками, чтобы пробелы не путали столбцы. */
function lineOf(record: ChatAttachmentRecord, absolute: string | null): string {
  const when = record.at.replace('T', ' ').slice(0, 19);
  return [
    `${when}Z`,
    record.agent === '' ? '-' : record.agent,
    record.bot === '' ? '-' : record.bot,
    `user=${record.user === '' ? '-' : record.user}`,
    humanSize(record.size),
    `«${record.name}»`,
    `sha=${record.sha256.slice(0, SHORT_SHA_CHARS)}`,
    `path=${record.path}`,
    absolute === null ? 'файл удалён' : `abs=${absolute}`,
  ].join('  ');
}

async function runFind(
  archive: ChatAttachmentArchive,
  parsed: ParsedArgs,
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const query = queryOf(parsed.flags, env);
  if (typeof query === 'string') {
    io.err(query);
    return CLI_EXIT_USAGE;
  }
  const records = await archive.find(query);
  const asJson = parsed.flags.has('json');
  for (const record of records) {
    const absolute = await archive.locate(record.path);
    io.out(asJson ? JSON.stringify({ ...record, abs: absolute }) : lineOf(record, absolute));
  }
  if (!asJson) io.out(`Найдено записей: ${records.length}`);
  return CLI_EXIT_OK;
}

async function runPath(
  archive: ChatAttachmentArchive,
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  const [relative] = parsed.rest;
  if (relative === undefined) {
    io.err('path: укажите относительный путь (поле path= из find)');
    return CLI_EXIT_USAGE;
  }
  const absolute = await archive.locate(relative);
  if (absolute === null) {
    io.err('файл не найден (удалён по сроку или путь неверен)');
    return CLI_EXIT_ERROR;
  }
  io.out(absolute);
  return CLI_EXIT_OK;
}

async function runStats(archive: ChatAttachmentArchive, io: CliIo): Promise<number> {
  const records = await archive.find({ limit: STATS_LIMIT });
  const sizeByPath = new Map<string, number>();
  const perBot = new Map<string, number>();
  for (const record of records) {
    sizeByPath.set(record.path, record.size);
    const key = record.bot === '' ? '-' : record.bot;
    perBot.set(key, (perBot.get(key) ?? 0) + 1);
  }
  const bytes = [...sizeByPath.values()].reduce((sum, size) => sum + size, 0);
  io.out(
    `Записей индекса: ${records.length}, файлов: ${sizeByPath.size}, ` +
      `объём: ${humanSize(bytes)}`,
  );
  const first = records[0];
  const last = records[records.length - 1];
  if (first !== undefined && last !== undefined) io.out(`Период: ${first.at} .. ${last.at}`);
  for (const [bot, count] of [...perBot.entries()].sort()) io.out(`  бот ${bot}: ${count}`);
  return CLI_EXIT_OK;
}

async function runPurge(
  archive: ChatAttachmentArchive,
  io: CliIo,
  now: Date,
): Promise<number> {
  const purged = await archive.purge(now);
  const capped = await archive.enforceCap();
  io.out(
    `Удалено по сроку: файлов ${purged.files}, записей ${purged.records}, ` +
      `сирот ${purged.orphans}, освобождено ${humanSize(purged.bytes)}; ` +
      `по объёму: файлов ${capped.evicted}, ${humanSize(capped.bytes)}`,
  );
  return CLI_EXIT_OK;
}

/**
 * Выполнить команду. Окружение берётся из `env` (в боевом контейнере - `process.env`): корень
 * приёма `INTAKE_ROOT`, срок и пределы - те же `CHAT_ATTACHMENTS_*`, что у службы.
 */
export async function runChatAttachmentsCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  now: () => Date = () => new Date(),
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    io.out(CHAT_ATTACHMENTS_CLI_USAGE);
    return argv.length === 0 ? CLI_EXIT_USAGE : CLI_EXIT_OK;
  }
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    io.err(parsed);
    io.err(CHAT_ATTACHMENTS_CLI_USAGE);
    return CLI_EXIT_USAGE;
  }
  const intakeRoot = env['INTAKE_ROOT']?.trim();
  if (intakeRoot === undefined || intakeRoot === '') {
    io.err('не задан INTAKE_ROOT (команда запускается внутри контейнера app)');
    return CLI_EXIT_ERROR;
  }
  const archive = new ChatAttachmentArchive({
    intakeRoot,
    config: parseChatAttachmentsConfig({ ...env }),
  });
  try {
    switch (parsed.command) {
      case 'find':
        return await runFind(archive, parsed, env, io);
      case 'path':
        return await runPath(archive, parsed, io);
      case 'stats':
        return await runStats(archive, io);
      case 'purge':
        return await runPurge(archive, io, now());
      default:
        io.err(`неизвестная команда: ${parsed.command}`);
        io.err(CHAT_ATTACHMENTS_CLI_USAGE);
        return CLI_EXIT_USAGE;
    }
  } catch (error) {
    io.err(`сбой: ${error instanceof Error ? error.name : 'unknown'}`);
    return CLI_EXIT_ERROR;
  }
}
