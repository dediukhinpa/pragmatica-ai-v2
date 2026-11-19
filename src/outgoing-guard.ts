import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { DomainError } from '@business-ai/core';
import type { ChatChannel, ChatFile } from '@business-ai/core';

/**
 * Проверка исходящих файлов: агенты видят только обезличенный текст (персональные данные
 * заменены служебными знаками вида `[PERSON_1]`), а шлюз подставляет настоящие значения обратно.
 * Если подстановка не сработала, служебный знак остаётся в файле. Любой файл, который уходит
 * сотруднику, проходит эту проверку; найден неподставленный знак - файл НЕ отправляется
 * (fail closed). Любой сбой самой проверки (битый архив, слишком большой файл) - тоже отказ.
 */

/** Предел суммарного размера распакованных текстовых частей архива (защита от зип-бомбы). */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
/** Предел числа записей в центральном каталоге архива. */
export const MAX_ZIP_ENTRIES = 4096;
/** Предел размера проверяемого файла целиком: больше - отказ, а не пропуск. */
export const MAX_CHECKED_FILE_BYTES = 256 * 1024 * 1024;
/** Размер порции при чтении файла с диска через собственный дескриптор шары. */
const DISK_READ_CHUNK_BYTES = 1024 * 1024;
/** До этого размера «сырой» файл дополнительно просматривается как UTF-16 (старые .doc/.xls). */
const RAW_UTF16_MAX_BYTES = 16 * 1024 * 1024;

// Структура zip (APPNOTE): сигнатуры и смещения полей.
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const EOCD_ENTRIES_OFFSET = 10;
const EOCD_CD_OFFSET_OFFSET = 16;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;
const CENTRAL_FLAGS_OFFSET = 8;
const CENTRAL_METHOD_OFFSET = 10;
const CENTRAL_COMPRESSED_OFFSET = 20;
const CENTRAL_UNCOMPRESSED_OFFSET = 24;
const CENTRAL_NAME_LEN_OFFSET = 28;
const CENTRAL_EXTRA_LEN_OFFSET = 30;
const CENTRAL_COMMENT_LEN_OFFSET = 32;
const CENTRAL_LOCAL_OFFSET_OFFSET = 42;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;
const LOCAL_NAME_LEN_OFFSET = 26;
const LOCAL_EXTRA_LEN_OFFSET = 28;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

/** Текстовые части архива: xml (тело, колонтитулы, комментарии, строки, свойства), связи и т.п. */
const ZIP_TEXT_PART = /\.(xml|rels|vml|txt|csv|json)$/i;
/** Расширения файлов, которые читаются как обычный текст. */
const PLAIN_TEXT_EXTENSION = /\.(txt|csv|tsv|md|markdown|json)$/i;

/**
 * Виды знаков, которые реально выдаёт псевдонимизатор (как в защите шлюза): любой другой текст в
 * квадратных скобках («[XL_2]» в артикуле) знаком не считается, иначе исправный файл не уходил бы.
 */
const TOKEN_KINDS =
  'PERSON|PHONE|EMAIL|INN|OGRNIP|OGRN|SNILS|PASSPORT|CONTACT|ORG|CARD|ACCOUNT|ADDRESS';
/** Необязательная падежная пометка знака: `[PERSON_1|datv]`. */
const CASE_CODES = 'nomn|gent|datv|accs|ablt|loct';

/**
 * Служебный знак платформы `[PERSON_1]`. Регулярка
 * платформы (`/\[[A-Z][A-Z_]*_\d+\]/`) - частный случай этой. Наш легальный маркер
 * `[ЗАПОЛНИТЬ: номер договора]` не совпадает: в нём нет `_<число>]`.
 */
const UNRESOLVED_TOKEN = new RegExp(
  `\\[(?:${TOKEN_KINDS})_\\d{1,6}(?:\\|(?:${CASE_CODES}))?\\]`,
  'gu',
);
/** Разбор знака на вид и номер. */
const TOKEN_PARTS = new RegExp(`^\\[(${TOKEN_KINDS})_(\\d+)(?:\\|(?:${CASE_CODES}))?\\]$`, 'u');

/** Вид служебного знака -> русское слово для сотрудника. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  PERSON: 'ФИО',
  ORG: 'организация',
  PHONE: 'телефон',
  EMAIL: 'e-mail',
  ADDRESS: 'адрес',
};
/** Слово для вида, которого в таблице нет. */
const UNKNOWN_KIND_WORD = 'данные';

/** Теги, закрывающие абзац, ячейку, строку: на их месте ставится перевод строки. */
const BLOCK_END_TAG = /<\/(?:w:p|a:p|w:tc|w:tr|si|row|c|text:p)>/g;
const ANY_TAG = /<[^>]*>/g;
const XML_ENTITY = /&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

/** Причина, по которой файл не удалось проверить (во внешнее сообщение не попадает). */
export type FileCheckFailure =
  | 'broken_archive'
  | 'archive_too_large'
  | 'archive_unsupported'
  | 'file_too_large'
  | 'unreadable';

/** Файл не удалось проверить: он не отправляется (fail closed). */
export class OutgoingFileCheckError extends DomainError {
  readonly reason: FileCheckFailure;

  constructor(reason: FileCheckFailure, options?: { cause?: unknown }) {
    super('validation_failed', 'Не удалось проверить файл перед отправкой. Файл не отправлен.');
    this.name = 'OutgoingFileCheckError';
    this.reason = reason;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Вид служебного знака (`PHONE` из `[PHONE_3]`); пусто, если это не знак. */
function tokenKind(token: string): string {
  return TOKEN_PARTS.exec(token)?.[1] ?? '';
}

/** Найденные виды, без повторов и в порядке появления. */
function uniqueKinds(tokens: readonly string[]): string[] {
  const kinds: string[] = [];
  for (const token of tokens) {
    const kind = tokenKind(token);
    if (kind !== '' && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/** Русская подпись вида для сотрудника. */
function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? UNKNOWN_KIND_WORD;
}

/**
 * В файле (или тексте) остались неподставленные служебные значения. Сообщение для сотрудника
 * называет только число и вид (ФИО, организация, телефон...), самих знаков не показывает и
 * слов «токен»/«метка» не использует.
 */
export class UnresolvedTokensInFileError extends DomainError {
  /** Число найденных уникальных знаков. */
  readonly count: number;
  /** Виды найденных знаков в исходной записи (`PHONE`, `EMAIL`...), без повторов. */
  readonly kinds: readonly string[];

  constructor(tokens: readonly string[], place: 'file' | 'text' = 'file') {
    const kinds = uniqueKinds(tokens);
    const words = [...new Set(kinds.map(kindWord))];
    const listed = words.length > 0 ? ` (${words.join(', ')})` : '';
    const where = place === 'file' ? 'файле' : 'тексте';
    const tail = place === 'file' ? ' Файл не отправлен.' : '';
    super(
      'validation_failed',
      `В ${where} остались неподставленные значения${listed}, всего ${tokens.length}.${tail}`,
    );
    this.name = 'UnresolvedTokensInFileError';
    this.count = tokens.length;
    this.kinds = kinds;
  }
}

/**
 * Уникальные служебные знаки в тексте (в порядке появления). Ловит и знаки платформы
 * `[PERSON_1]`, и вариант с кириллицей `[ФИО_1]`; маркер `[ЗАПОЛНИТЬ: ...]` знаком не считается.
 */
export function findUnresolvedTokens(text: string): string[] {
  return [...new Set(text.match(UNRESOLVED_TOKEN) ?? [])];
}

/** Бросает UnresolvedTokensInFileError, если в тексте остался хотя бы один служебный знак. */
export function assertNoUnresolvedTokens(text: string): void {
  const tokens = findUnresolvedTokens(text);
  if (tokens.length > 0) throw new UnresolvedTokensInFileError(tokens, 'text');
}

/** Код символа из числовой сущности; некорректный код даёт пустую строку. */
function codePointToString(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Декодирует XML-сущности и записанные процентами скобки (`%5B`, `%5D` в ссылках). */
function decodeEntities(text: string): string {
  return text
    .replace(XML_ENTITY, (_whole, body: string) => {
      const lower = body.toLowerCase();
      if (lower.startsWith('#x')) return codePointToString(parseInt(lower.slice(2), HEX_RADIX));
      if (lower.startsWith('#')) return codePointToString(parseInt(lower.slice(1), DECIMAL_RADIX));
      return NAMED_ENTITIES[lower] ?? '';
    })
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']');
}

/**
 * Два взгляда на xml-часть: «с тегами» (значения атрибутов: alt-текст, ссылки, имена листов) и
 * «чистый текст» (теги сняты без разделителей, чтобы знак, разбитый на несколько фрагментов
 * форматирования, склеился).
 */
function xmlViews(xml: string): string[] {
  const stripped = xml.replace(BLOCK_END_TAG, '\n').replace(ANY_TAG, '');
  return [decodeEntities(xml), decodeEntities(stripped)];
}

/** Запись центрального каталога zip, нужная для чтения текстовой части. */
interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Ищет конец центрального каталога с конца файла; -1, если это не zip. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let pos = buf.length - EOCD_MIN_SIZE; pos >= lowest; pos--) {
    if (buf.readUInt32LE(pos) === EOCD_SIGNATURE) return pos;
  }
  return -1;
}

/** Читает центральный каталог. Чтение за границей буфера бросает RangeError (= битый архив). */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new OutgoingFileCheckError('broken_archive');
  const total = buf.readUInt16LE(eocd + EOCD_ENTRIES_OFFSET);
  let pos = buf.readUInt32LE(eocd + EOCD_CD_OFFSET_OFFSET);
  if (total === ZIP64_MARKER_16 || pos === ZIP64_MARKER_32) {
    throw new OutgoingFileCheckError('archive_unsupported');
  }
  if (total > MAX_ZIP_ENTRIES) throw new OutgoingFileCheckError('archive_too_large');
  const entries: ZipEntry[] = [];
  for (let index = 0; index < total; index++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new OutgoingFileCheckError('broken_archive');
    }
    const nameLength = buf.readUInt16LE(pos + CENTRAL_NAME_LEN_OFFSET);
    const extraLength = buf.readUInt16LE(pos + CENTRAL_EXTRA_LEN_OFFSET);
    const commentLength = buf.readUInt16LE(pos + CENTRAL_COMMENT_LEN_OFFSET);
    const nameStart = pos + CENTRAL_HEADER_SIZE;
    if (nameStart + nameLength > buf.length) throw new OutgoingFileCheckError('broken_archive');
    entries.push({
      name: buf.toString('utf8', nameStart, nameStart + nameLength),
      flags: buf.readUInt16LE(pos + CENTRAL_FLAGS_OFFSET),
      method: buf.readUInt16LE(pos + CENTRAL_METHOD_OFFSET),
      compressedSize: buf.readUInt32LE(pos + CENTRAL_COMPRESSED_OFFSET),
      uncompressedSize: buf.readUInt32LE(pos + CENTRAL_UNCOMPRESSED_OFFSET),
      localOffset: buf.readUInt32LE(pos + CENTRAL_LOCAL_OFFSET_OFFSET),
    });
    pos = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Достаёт и распаковывает запись; `budget` - сколько байт ещё можно распаковать. */
function unpackEntry(buf: Buffer, entry: ZipEntry, budget: number): Buffer {
  if ((entry.flags & ZIP_FLAG_ENCRYPTED) !== 0) {
    throw new OutgoingFileCheckError('archive_unsupported');
  }
  if (entry.uncompressedSize > budget) throw new OutgoingFileCheckError('archive_too_large');
  const local = entry.localOffset;
  if (buf.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new OutgoingFileCheckError('broken_archive');
  }
  const start =
    local +
    LOCAL_HEADER_SIZE +
    buf.readUInt16LE(local + LOCAL_NAME_LEN_OFFSET) +
    buf.readUInt16LE(local + LOCAL_EXTRA_LEN_OFFSET);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new OutgoingFileCheckError('broken_archive');
  const packed = buf.subarray(start, end);
  if (entry.method === ZIP_METHOD_STORED) {
    if (packed.length > budget) throw new OutgoingFileCheckError('archive_too_large');
    return packed;
  }
  if (entry.method !== ZIP_METHOD_DEFLATE) throw new OutgoingFileCheckError('archive_unsupported');
  try {
    // Заявленный в каталоге размер может лгать: предел действует и на сам поток.
    return inflateRawSync(packed, { maxOutputLength: Math.max(1, budget) });
  } catch (error) {
    const tooLarge = error instanceof RangeError || /larger than|too large/i.test(String(error));
    throw new OutgoingFileCheckError(tooLarge ? 'archive_too_large' : 'broken_archive', {
      cause: error,
    });
  }
}

/** Текст всех текстовых частей zip-файла (docx/xlsx/pptx и подобных). */
function zipText(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const views: string[] = [];
  let budget = MAX_UNPACKED_BYTES;
  try {
    for (const entry of readCentralDirectory(buf)) {
      if (!ZIP_TEXT_PART.test(entry.name)) continue;
      const data = unpackEntry(buf, entry, budget);
      budget -= data.length;
      const text = data.toString('utf8');
      views.push(entry.name, ...xmlViews(text));
    }
  } catch (error) {
    if (error instanceof OutgoingFileCheckError) throw error;
    throw new OutgoingFileCheckError('broken_archive', { cause: error });
  }
  return views;
}

/** Байты -> строка в заданной кодировке; неподдерживаемая кодировка даёт пустую строку. */
function decodeAs(label: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return '';
  }
}

/** Переставляет байты каждой пары (UTF-16BE -> UTF-16LE). */
function swapPairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    out[index] = bytes[index + 1] ?? 0;
    out[index + 1] = bytes[index] ?? 0;
  }
  return out;
}

// Кодировка windows-1251: среда выполнения её не поддерживает, кириллицу раскладываем сами.
const CP1251_CYRILLIC_START = 0xc0;
const CP1251_CAPITAL_A = 0x0410;
const CP1251_YO_BYTE = 0xa8;
const CP1251_YO_SMALL_BYTE = 0xb8;
const CODE_YO = 0x0401;
const CODE_YO_SMALL = 0x0451;
const CP1251_CHUNK = 8192;

/** Байты windows-1251 -> строка (кириллица, ASCII; прочие байты как latin1). */
function decodeCp1251(bytes: Uint8Array): string {
  let result = '';
  for (let start = 0; start < bytes.length; start += CP1251_CHUNK) {
    const codes: number[] = [];
    for (const byte of bytes.subarray(start, start + CP1251_CHUNK)) {
      if (byte >= CP1251_CYRILLIC_START) {
        codes.push(CP1251_CAPITAL_A + byte - CP1251_CYRILLIC_START);
      }
      else if (byte === CP1251_YO_BYTE) codes.push(CODE_YO);
      else if (byte === CP1251_YO_SMALL_BYTE) codes.push(CODE_YO_SMALL);
      else codes.push(byte);
    }
    result += String.fromCharCode(...codes);
  }
  return result;
}

/** Взгляды на обычный текстовый файл: UTF-8 (с BOM или без), UTF-16 по BOM, windows-1251. */
function plainTextViews(bytes: Uint8Array): string[] {
  const [first, second] = bytes;
  if (first === 0xff && second === 0xfe) return [decodeAs('utf-16le', bytes)];
  if (first === 0xfe && second === 0xff) return [decodeAs('utf-16le', swapPairs(bytes))];
  return [decodeAs('utf-8', bytes), decodeCp1251(bytes)];
}

/** Взгляды на «сырой» файл: latin1 и utf-8 (метка в несжатом PDF), для небольших - и UTF-16. */
function rawViews(bytes: Uint8Array): string[] {
  const views = [Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')];
  views.push(decodeAs('utf-8', bytes));
  if (bytes.length <= RAW_UTF16_MAX_BYTES) {
    views.push(decodeAs('utf-16le', bytes));
    views.push(decodeAs('utf-16le', bytes.subarray(1)));
  }
  return views;
}

/** Начинается ли файл с локальной сигнатуры zip (`PK\x03\x04`). */
function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).readUInt32LE(0) === LOCAL_SIGNATURE;
}

/** Содержимое файла: из памяти или с диска (по собственному дескриптору шары либо по пути). */
async function readFileBytes(file: ChatFile): Promise<Uint8Array> {
  const disk = file.disk;
  if (disk === undefined) {
    if (file.content.length > MAX_CHECKED_FILE_BYTES) {
      throw new OutgoingFileCheckError('file_too_large');
    }
    return file.content;
  }
  if (disk.size > MAX_CHECKED_FILE_BYTES) throw new OutgoingFileCheckError('file_too_large');
  if (disk.open === undefined) return new Uint8Array(await readFile(disk.path));
  const handle = await disk.open();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(DISK_READ_CHUNK_BYTES);
      const read = await handle.read(chunk);
      if (read <= 0) break;
      total += read;
      if (total > MAX_CHECKED_FILE_BYTES) throw new OutgoingFileCheckError('file_too_large');
      chunks.push(chunk.subarray(0, read));
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    await handle.close();
  }
}

/**
 * Достаёт весь текст файла для проверки. docx/xlsx/pptx (и любой zip) разбирается по
 * центральному каталогу: тело, колонтитулы, сноски, комментарии, строки и листы таблиц, слайды,
 * заметки, свойства документа. txt/csv/md/json читаются как текст (UTF-8, BOM, UTF-16,
 * windows-1251). Любой другой формат и PDF проверяются по сырым байтам как latin1 и utf-8:
 * метка в несжатом тексте PDF видна, внутри сжатого потока FlateDecode - нет.
 *
 * @returns Текст всех частей или `null`, если файл пуст (проверять нечего).
 * @throws OutgoingFileCheckError Файл не удалось прочитать или разобрать (битый архив, зип-бомба,
 * слишком большой файл): вызывающий обязан считать это отказом, а не пропуском.
 */
export async function extractFileText(file: ChatFile): Promise<string | null> {
  try {
    const bytes = await readFileBytes(file);
    if (bytes.length === 0) return null;
    let views: string[];
    if (looksLikeZip(bytes)) views = zipText(bytes);
    else if (PLAIN_TEXT_EXTENSION.test(file.name)) views = plainTextViews(bytes);
    else views = rawViews(bytes);
    return views.join('\n');
  } catch (error) {
    if (error instanceof OutgoingFileCheckError) throw error;
    throw new OutgoingFileCheckError('unreadable', { cause: error });
  }
}

/** Что известно об отказе отправить файл (для журнала; самих знаков и текста файла нет). */
export interface OutgoingRefusal {
  fileName: string;
  /** Виды найденных знаков (`PHONE`, `EMAIL`...); пусто, если отказ из-за сбоя проверки. */
  kinds: string[];
  /** Почему отказ: найдены знаки или файл не удалось проверить. */
  reason?: 'unresolved' | 'unchecked';
}

/** Вызов обратного вызова журнала так, чтобы его сбой не заменил исходный отказ. */
function notifyRefused(
  onRefused: ((info: OutgoingRefusal) => void) | undefined,
  info: OutgoingRefusal,
): void {
  if (onRefused === undefined) return;
  try {
    onRefused(info);
  } catch {
    // Журнал не должен ломать отказ.
  }
}

/**
 * Проверяет файл перед отправкой.
 *
 * @throws UnresolvedTokensInFileError В файле остались служебные знаки.
 * @throws OutgoingFileCheckError Файл не удалось проверить.
 */
async function assertFileClean(
  file: ChatFile,
  onRefused: ((info: OutgoingRefusal) => void) | undefined,
): Promise<void> {
  let text: string | null;
  try {
    text = await extractFileText(file);
  } catch (error) {
    notifyRefused(onRefused, { fileName: file.name, kinds: [], reason: 'unchecked' });
    throw error;
  }
  if (text === null) return;
  const tokens = findUnresolvedTokens(text);
  if (tokens.length === 0) return;
  const error = new UnresolvedTokensInFileError(tokens);
  notifyRefused(onRefused, { fileName: file.name, kinds: [...error.kinds], reason: 'unresolved' });
  throw error;
}

/**
 * Декоратор канала: `sendFile` сначала проверяет файл и при неподставленных знаках или сбое
 * проверки бросает ошибку, ничего не отправляя. Остальные члены канала (reply, typing,
 * updateMessage, onEvent) делегируются исходному каналу как есть с сохранением `this`;
 * необязательные методы, которых у исходного канала нет, в обёртке тоже отсутствуют
 * (это прокси, а не копия).
 *
 * @param chat Исходный канал.
 * @param onRefused Необязательный обратный вызов для журнала при отказе.
 */
export function guardOutgoingFiles(
  chat: ChatChannel,
  onRefused?: (info: OutgoingRefusal) => void,
): ChatChannel {
  return new Proxy(chat, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'sendFile' && typeof value === 'function') {
        return async (threadId: string, file: ChatFile, key: string): Promise<void> => {
          await assertFileClean(file, onRefused);
          await Reflect.apply(value, target, [threadId, file, key]);
        };
      }
      if (typeof value === 'function') {
        return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      }
      return value;
    },
  });
}
