import { CancelledError } from '@business-ai/core';
import type {
  AttachmentBundle,
  BitrixAttachment,
  DocumentParser,
  ImageAttachment,
  ImageReadMode,
  ImageReadItem,
  ImageReader,
} from '@business-ai/core';

/**
 * Сборка контекста расчёта из вложений заявки: скачанные файлы -> текст -> разделы «Из
 * вложений: <имя>» с обрезкой по объёму. Модуль чистый: сети и дисков не трогает, парсер
 * приходит снаружи. Маскирование ПДн здесь НЕ делается намеренно: результат инструмента
 * уходит модели тем же путём, что текст задачи, и шлюз псевдонимизации маскирует его
 * целиком (сообщения роли `tool`), поэтому отдельного пути маскирования у вложений нет.
 */

/** Сколько символов текста одного файла отдаём модели, если общий лимит больше. */
export const ATTACHMENT_FILE_MAX_CHARS = 8_000;
/** Общий дедлайн на чтение всех вложений заявки, мс: зависшее скачивание не держит ход. */
export const ATTACHMENTS_READ_TIMEOUT_MS = 60_000;
/** Предел длины имени файла в пометках. */
const NAME_MAX_CHARS = 120;
/** Расширения, которые понимает сервис документов (см. `SUPPORTED` в services/documents). */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'xlsx',
  'xlsm',
  'xls',
  'docx',
  'doc',
  'pptx',
  'rtf',
  'pdf',
]);
/** Простой текст (txt, csv, md) сервис документов не берёт: читаем сами. */
const PLAIN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'csv', 'md']);
/**
 * windows-1251 разбираем вручную: CSV из русского Excel обычно в ней, а `TextDecoder` в Bun
 * этой метки не знает. Кириллица лежит одним блоком (0xC0..0xFF -> U+0410..U+044F).
 */
const CP1251_CYRILLIC_START = 0xc0;
const CP1251_TO_UNICODE_OFFSET = 0x410 - CP1251_CYRILLIC_START;
const CP1251_YO_UPPER = 0xa8;
const CP1251_YO_LOWER = 0xb8;
const UNICODE_YO_UPPER = 0x401;
const UNICODE_YO_LOWER = 0x451;
const ASCII_LIMIT = 0x80;
/** Три и более перевода строки подряд схлопываются: пустые строки таблиц только съедают объём. */
const BLANK_LINES_PATTERN = /\n{3,}/g;

/** Раздел контекста: текст одного вложения. */
export interface AttachmentTextSection {
  name: string;
  source: BitrixAttachment['source'];
  /** Текст файла (ПДн маскирует шлюз при передаче модели). */
  text: string;
  /** Текст обрезан по лимиту объёма либо парсером. */
  truncated: boolean;
}

/** Итог разбора вложений заявки. */
export interface AttachmentContext {
  sections: AttachmentTextSection[];
  /** Пометки для сотрудника и модели: «не удалось прочитать вложение X (...)». */
  notes: string[];
  /**
   * Картинки-вложения и сканы PDF для распознавания (`readImages`). Картинки ВНУТРИ
   * документов не извлекаются: это точка расширения, здесь их нет.
   */
  images: ImageAttachment[];
}

export interface AttachmentContextOptions {
  /** Суммарный лимит текста вложений на заявку, символов. */
  maxChars: number;
  /** Лимит на один файл; по умолчанию {@link ATTACHMENT_FILE_MAX_CHARS}. */
  fileMaxChars?: number | undefined;
  /**
   * Определять формат по содержимому, а не по имени (агент «Документы»: сотрудники присылают
   * файлы без расширения или с чужим), и называть причину нечитаемости точно. Не задано -
   * поведение прежнее (расширение/mime), им пользуется агент заявки.
   */
  sniffContent?: boolean | undefined;
}

/** Вид вложения по имени и mime. */
export type AttachmentKind = 'document' | 'text' | 'image' | 'unsupported';

// jfif/jpe/jfi - тот же JPEG (Windows сохраняет фото из браузера как .jfif, задача 220302,
// 28.10.2026); bmp/tif/tiff сервис documents переводит в jpeg/png перед моделью зрения.
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'jfif',
  'jpe',
  'jfi',
  'png',
  'webp',
  'heic',
  'gif',
  'bmp',
  'tif',
  'tiff',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Определить вид вложения: по расширению, а при его отсутствии - по mime. */
export function classifyAttachment(name: string, mime: string): AttachmentKind {
  const extension = extensionOf(name);
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return 'text';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === '') {
    const lowerMime = mime.toLowerCase();
    if (lowerMime.startsWith('image/')) return 'image';
    if (lowerMime === 'text/plain' || lowerMime === 'text/csv') return 'text';
    if (lowerMime === 'application/pdf') return 'document';
  }
  return 'unsupported';
}

/** Сколько первых байт смотрим, решая, текстовый ли файл. */
const TEXT_PROBE_BYTES = 4096;
/** Сигнатуры форматов (первые байты файла). */
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RTF_SIGNATURE = [0x7b, 0x5c, 0x72, 0x74, 0x66];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38];
const BMP_SIGNATURE = [0x42, 0x4d];
const TIFF_LE_SIGNATURE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE_SIGNATURE = [0x4d, 0x4d, 0x00, 0x2a];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_MARK = [0x57, 0x45, 0x42, 0x50];
const WEBP_MARK_OFFSET = 8;
/** Минимальная длина, при которой BMP-сигнатуру из двух байт считаем уверенной. */
const BMP_MIN_BYTES = 26;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** Есть ли ASCII-строка в байтах (для имён частей zip-контейнера Office). */
function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const pattern = Array.from(needle, (char) => char.charCodeAt(0));
  const last = bytes.length - pattern.length;
  for (let index = 0; index <= last; index += 1) {
    if (bytes[index] !== pattern[0]) continue;
    if (pattern.every((value, offset) => bytes[index + offset] === value)) return true;
  }
  return false;
}

/** Текст ли это: в начале нет нулевых байт (кодировку потом выберет decodePlainText). */
function looksLikeText(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, TEXT_PROBE_BYTES);
  return !probe.includes(0);
}

/** Итог определения формата по содержимому: как читать файл или почему нельзя. */
export type SniffedAttachment =
  | { ok: true; kind: Exclude<AttachmentKind, 'unsupported'>; parseName: string; mime: string }
  | { ok: false; why: string };

const NOT_RECOGNIZED_WHY =
  'формат не распознан: это не Word, Excel, PDF, текстовый файл и не изображение';
const IMAGE_MIMES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  webp: 'image/webp',
} as const;

/** Имя для парсера: расширение заменяется на найденное по содержимому. */
function withExtension(name: string, extension: string): string {
  const current = extensionOf(name);
  const known = DOCUMENT_EXTENSIONS.has(current) || PLAIN_TEXT_EXTENSIONS.has(current);
  const base = known || IMAGE_EXTENSIONS.has(current) ? name.slice(0, -(current.length + 1)) : name;
  return `${base}.${extension}`;
}

/**
 * Определить формат вложения по сигнатуре байтов (расширение и mime от отправителя не
 * доверяем). Нечитаемое возвращает с причиной простыми словами: пустой файл, повреждённый,
 * старый формат Office без указания вида, архив. Чистая функция, байты не копирует.
 */
export function sniffAttachment(file: BitrixAttachment): SniffedAttachment {
  const { bytes, name } = file;
  const document = (extension: string): SniffedAttachment => ({
    ok: true,
    kind: 'document',
    parseName: withExtension(name, extension),
    mime: file.mime,
  });
  const image = (mime: string): SniffedAttachment => ({
    ok: true,
    kind: 'image',
    parseName: name,
    mime,
  });
  if (bytes.length === 0) return { ok: false, why: 'файл пустой' };
  if (startsWith(bytes, PDF_SIGNATURE)) return document('pdf');
  if (startsWith(bytes, RTF_SIGNATURE)) return document('rtf');
  if (startsWith(bytes, ZIP_SIGNATURE)) {
    // Office Open XML - это zip: вид документа видно по имени главной папки внутри.
    if (containsAscii(bytes, 'word/document.xml')) return document('docx');
    if (containsAscii(bytes, 'xl/workbook.xml')) return document('xlsx');
    if (containsAscii(bytes, 'ppt/presentation.xml')) return document('pptx');
    return { ok: false, why: 'это архив, а не документ: пришлите сам файл Word или Excel' };
  }
  if (startsWith(bytes, OLE_SIGNATURE)) {
    // Старые .doc/.xls/.ppt - один контейнер; вид различает только расширение от человека.
    const extension = extensionOf(name);
    if (extension === 'doc' || extension === 'xls') return document(extension);
    return {
      ok: false,
      why: 'старый формат Office без понятного расширения: пришлите файл как .docx или .xlsx',
    };
  }
  if (startsWith(bytes, PNG_SIGNATURE)) return image(IMAGE_MIMES.png);
  if (startsWith(bytes, JPEG_SIGNATURE)) return image(IMAGE_MIMES.jpg);
  if (startsWith(bytes, GIF_SIGNATURE)) return image(IMAGE_MIMES.gif);
  if (startsWith(bytes, TIFF_LE_SIGNATURE) || startsWith(bytes, TIFF_BE_SIGNATURE)) {
    return image(IMAGE_MIMES.tif);
  }
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_MARK, WEBP_MARK_OFFSET)) {
    return image(IMAGE_MIMES.webp);
  }
  if (startsWith(bytes, BMP_SIGNATURE) && bytes.length >= BMP_MIN_BYTES) {
    return image(IMAGE_MIMES.bmp);
  }
  if (looksLikeText(bytes)) {
    return { ok: true, kind: 'text', parseName: name, mime: file.mime };
  }
  const declared = classifyAttachment(name, file.mime);
  if (declared === 'unsupported') return { ok: false, why: NOT_RECOGNIZED_WHY };
  return {
    ok: false,
    why: `содержимое не соответствует расширению .${extensionOf(name)}: файл повреждён`,
  };
}

/**
 * Сигнал чтения вложений: отмена хода (если есть) плюс общий дедлайн
 * {@link ATTACHMENTS_READ_TIMEOUT_MS}.
 */
export function attachmentsSignal(turnSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ATTACHMENTS_READ_TIMEOUT_MS);
  return turnSignal === undefined ? deadline : AbortSignal.any([turnSignal, deadline]);
}

/**
 * Управляющие C0/C1 и bidi-символы (LRM/RLM, U+202A-E, U+2066-9): имя файла приходит от
 * постороннего и не должно ни ломать разметку пометок, ни переворачивать текст.
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/** Имя файла для пометки: без управляющих символов и переводов строк, ограниченной длины. */
export function safeAttachmentName(name: string): string {
  const clean = name
    .replace(UNSAFE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_CHARS);
  return clean === '' ? 'без имени' : clean;
}

/** Пометка о непрочитанном вложении. */
export function unreadNote(name: string, why: string): string {
  return `не удалось прочитать вложение ${safeAttachmentName(name)} (${why})`;
}

function decodeWindows1251(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    if (byte < ASCII_LIMIT) result += String.fromCharCode(byte);
    else if (byte >= CP1251_CYRILLIC_START) {
      result += String.fromCharCode(byte + CP1251_TO_UNICODE_OFFSET);
    } else if (byte === CP1251_YO_UPPER) result += String.fromCharCode(UNICODE_YO_UPPER);
    else if (byte === CP1251_YO_LOWER) result += String.fromCharCode(UNICODE_YO_LOWER);
    else result += ' ';
  }
  return result;
}

/** Декодировать txt/csv: UTF-8, а если байты не UTF-8 - windows-1251. Без BOM. */
export function decodePlainText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = decodeWindows1251(bytes);
  }
  return text.replace(/^﻿/, '');
}

function tidy(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(BLANK_LINES_PATTERN, '\n\n').trim();
}

/** Парсер, умеющий отдать страницы скана картинками (HttpDocumentParser.parseWithImages). */
interface PageImageSource {
  parseWithImages(
    name: string,
    content: Uint8Array,
  ): Promise<{ images: { mime: string; bytes: Uint8Array; location?: string; index: number }[] }>;
}

function hasPageImages(parser: DocumentParser): parser is DocumentParser & PageImageSource {
  return typeof (parser as Partial<PageImageSource>).parseWithImages === 'function';
}

/** Пометка: скан нельзя превратить в картинки, и читать его нечем. */
const SCANNED_NOT_SUPPORTED_WHY =
  'скан PDF не поддержан: страницы не удалось получить картинками';

/**
 * Страницы скана как картинки для ридера. PDF целиком в ридер отдавать нельзя: нормализация
 * картинок PDF не принимает (415), поэтому страницы берём из documents (`extract_images`).
 * Пустой список = получить страницы не удалось. Отмена пробрасывается.
 */
async function scannedPages(
  file: BitrixAttachment,
  parser: DocumentParser | undefined,
): Promise<ImageAttachment[]> {
  if (parser === undefined || !hasPageImages(parser)) return [];
  try {
    const { images } = await parser.parseWithImages(file.name, file.bytes);
    const name = safeAttachmentName(file.name);
    return images.map((image) => ({
      name: `${name} (${image.location || `стр. ${image.index}`})`,
      mime: image.mime,
      bytes: image.bytes,
      source: file.source,
      scanned: true,
    }));
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return [];
  }
}

/** Причина по умолчанию, когда парсер документов отказал. */
const PARSE_FAILED_WHY = 'файл не удалось разобрать';

/** Извлечь текст одного файла; бросает только отмену, остальное - в пометку. */
async function extractText(
  file: BitrixAttachment,
  kind: AttachmentKind,
  parser: DocumentParser | undefined,
): Promise<
  | { ok: true; text: string; parserTruncated: boolean; needsOcr: boolean }
  | { ok: false; why: string }
> {
  if (kind === 'text') {
    return {
      ok: true,
      text: decodePlainText(file.bytes),
      parserTruncated: false,
      needsOcr: false,
    };
  }
  if (parser === undefined) return { ok: false, why: 'разбор документов не подключён' };
  try {
    const parsed = await parser.parse(file.name, file.bytes);
    return {
      ok: true,
      text: parsed.text,
      parserTruncated: parsed.truncated,
      needsOcr: parsed.needsOcr,
    };
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    // Внутренности ошибки парсера (пути, стек) наружу не уходят.
    return { ok: false, why: PARSE_FAILED_WHY };
  }
}

/** Источники, чьим файлам доверяем как данным заявки (как в saveIntakeRequest). */
const TRUSTED_SOURCES: ReadonlySet<BitrixAttachment['source']> = new Set(['task', 'deal']);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Один и тот же файл из разных мест (задача и её чат, сделка, личный чат) читаем один раз:
 * иначе платный ридер картинок и парсер вызываются дважды на тех же байтах. Совпадение - по
 * sha256 содержимого. Из группы остаётся файл самого доверенного источника (задача/сделка
 * важнее чата), чтобы дубль из чата не снял доверие; остальные источники попадают в пометку.
 */
async function dedupeAttachments(
  attachments: readonly BitrixAttachment[],
): Promise<{ unique: BitrixAttachment[]; notes: string[] }> {
  const groups = new Map<string, BitrixAttachment[]>();
  for (const file of attachments) {
    const hash = await sha256Hex(file.bytes);
    const group = groups.get(hash);
    if (group === undefined) groups.set(hash, [file]);
    else group.push(file);
  }
  const unique: BitrixAttachment[] = [];
  const notes: string[] = [];
  for (const group of groups.values()) {
    const keep = group.find((file) => TRUSTED_SOURCES.has(file.source)) ?? group[0];
    if (keep === undefined) continue;
    unique.push(keep);
    if (group.length > 1 || (keep.alsoFrom?.length ?? 0) > 0) {
      const sources = [...new Set(group.flatMap((file) => [file.source, ...(file.alsoFrom ?? [])]))]
        .join(', ');
      notes.push(
        `вложение «${safeAttachmentName(keep.name)}» повторяется в источниках: ${sources}; ` +
          'прочитано один раз',
      );
    }
  }
  // Исходный порядок файлов сохраняем: от него зависит порядок разделов и лимит текста.
  const order = new Map(attachments.map((file, index) => [file, index] as const));
  unique.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { unique, notes };
}

/**
 * Собрать контекст из скачанных вложений. Не бросает на битом файле: он превращается в
 * пометку, остальные файлы читаются дальше. Картинки и сканы PDF уходят в `images` для
 * {@link readImages}.
 */
export async function buildAttachmentContext(
  bundle: AttachmentBundle,
  parser: DocumentParser | undefined,
  options: AttachmentContextOptions,
): Promise<AttachmentContext> {
  const fileMax = options.fileMaxChars ?? ATTACHMENT_FILE_MAX_CHARS;
  const sections: AttachmentTextSection[] = [];
  const deduped = await dedupeAttachments(bundle.attachments);
  const notes: string[] = [...bundle.errors.map((error) => error.message), ...deduped.notes];
  const images: ImageAttachment[] = [];
  let remaining = options.maxChars;
  for (const original of deduped.unique) {
    let file = original;
    let kind = classifyAttachment(file.name, file.mime);
    let parseFile = file;
    if (options.sniffContent === true) {
      // Формат по содержимому: разбор идёт под именем с верным расширением, а в пометках и
      // разделах остаётся исходное имя файла.
      const sniffed = sniffAttachment(original);
      if (!sniffed.ok) {
        notes.push(unreadNote(original.name, sniffed.why));
        continue;
      }
      kind = sniffed.kind;
      file = { ...original, mime: sniffed.mime };
      parseFile = { ...file, name: sniffed.parseName };
    }
    if (kind === 'image') {
      images.push(toImage(file, false));
      continue;
    }
    if (kind === 'unsupported') {
      notes.push(unreadNote(file.name, 'формат не поддерживается'));
      continue;
    }
    const result = await extractText(parseFile, kind, parser);
    if (!result.ok) {
      notes.push(
        unreadNote(
          file.name,
          options.sniffContent === true && result.why === PARSE_FAILED_WHY
            ? 'файл повреждён или закрыт паролем, открыть его не удалось'
            : result.why,
        ),
      );
      continue;
    }
    if (result.needsOcr) {
      // Скан без текстового слоя: текста нет, файл уходит в распознавание изображений.
      const pages = await scannedPages(parseFile, parser);
      if (pages.length === 0) notes.push(unreadNote(file.name, SCANNED_NOT_SUPPORTED_WHY));
      images.push(...pages);
      continue;
    }
    const text = tidy(result.text);
    if (text === '') {
      notes.push(unreadNote(file.name, 'в файле нет текста'));
      continue;
    }
    if (remaining <= 0) {
      notes.push(unreadNote(file.name, 'исчерпан лимит объёма текста вложений'));
      continue;
    }
    const limit = Math.min(fileMax, remaining);
    const cut = text.length > limit;
    const shown = cut ? text.slice(0, limit) : text;
    remaining -= shown.length;
    sections.push({
      name: safeAttachmentName(file.name),
      source: file.source,
      text: shown,
      truncated: cut || result.parserTruncated,
    });
  }
  return { sections, notes, images };
}

function toImage(file: BitrixAttachment, scanned: boolean): ImageAttachment {
  return {
    name: safeAttachmentName(file.name),
    mime: file.mime,
    bytes: file.bytes,
    source: file.source,
    ...(scanned ? { scanned: true } : {}),
  };
}

/** Пометка, когда порта ридера нет вовсе (в сборке его подставляет заглушка `unconfigured`). */
const IMAGE_READER_ABSENT_NOTE = 'распознавание изображений не настроено';
/** Пометка, когда ридер вернул не всё или упал. */
const IMAGE_READ_FAILED_NOTE = 'изображение не удалось прочитать';
/** Пометка, когда ридер не назвал причину отказа. */
const IMAGE_READ_NO_REASON_NOTE = 'изображение не прочитано';
/** Заголовок раздела контекста с текстом по изображению. */
const IMAGE_SECTION_PREFIX = 'Из вложений (изображения): ';
/** Имя картинки похоже на прайс или таблицу: читаем режимом `table`, а не как фото изделия. */
const TABLE_NAME_PATTERN = new RegExp(
  // \b с кириллицей без флага u не работает: границу слова для «табл» задаём вручную.
  '(?:прайс|price|таблиц|спецификац|накладн|ведомост)|(?<![а-яёa-z0-9_])табл(?![а-яёa-z0-9_])',
  'iu',
);

/** Результат чтения изображения-вложения для модели: без байтов, текст уже обрезан. */
export interface AttachmentImageRead {
  name: string;
  source: ImageAttachment['source'];
  status: 'ok' | 'unavailable';
  /** Раздел контекста: «Из вложений (изображения): <имя>». */
  heading: string;
  /** Описание или текст изображения; при `unavailable` - причина. ПДн маскирует шлюз. */
  text: string;
  /** Отклонено как плохо читаемое фото (tokens); поле необязательное, старые записи валидны. */
  unreadable?: boolean;
  /** Сервис чтения текста с фото был занят (tokens): фото стоит прислать ещё раз. */
  busy?: boolean;
}

function imageRead(
  image: ImageAttachment,
  status: AttachmentImageRead['status'],
  text: string,
): AttachmentImageRead {
  return {
    name: image.name,
    source: image.source,
    status,
    heading: `${IMAGE_SECTION_PREFIX}${image.name}`,
    text,
  };
}

function toRead(image: ImageAttachment, item: ImageReadItem | undefined, fallback: string) {
  if (item === undefined) return imageRead(image, 'unavailable', fallback);
  if (item.status === 'ok' && item.text.trim() !== '') return null;
  const read = imageRead(image, 'unavailable', item.note ?? IMAGE_READ_NO_REASON_NOTE);
  return {
    ...read,
    ...(item.unreadable === true ? { unreadable: true } : {}),
    ...(item.busy === true ? { busy: true } : {}),
  };
}

/** Режим чтения: сканы PDF и картинки-прайсы (по имени) - таблица, остальное - фото изделия. */
export function imageModeOf(image: ImageAttachment): ImageReadMode {
  return image.scanned === true || TABLE_NAME_PATTERN.test(image.name) ? 'table' : 'product';
}

/**
 * Передать изображения ридеру: все картинки одного режима - одним вызовом (лимит ридера на
 * ход считается по вызову). Без ридера, при отключённом зрении и сбое - пометки `unavailable`,
 * исключение наружу не идёт (кроме отмены). Результат без байтов; текст обрезается по
 * `maxChars` на изображение.
 */
export async function readImages(
  images: readonly ImageAttachment[],
  reader: ImageReader | undefined,
  maxChars: number = ATTACHMENT_FILE_MAX_CHARS,
): Promise<AttachmentImageRead[]> {
  if (images.length === 0) return [];
  const results = new Map<ImageAttachment, AttachmentImageRead>();
  const modes: readonly ImageReadMode[] = ['product', 'table'];
  for (const mode of modes) {
    const group = images.filter((image) => imageModeOf(image) === mode);
    if (group.length === 0) continue;
    let items: readonly ImageReadItem[] = [];
    if (reader !== undefined) {
      try {
        items = (await reader.describe(group, mode)).items;
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        items = [];
      }
    }
    const fallback = reader === undefined ? IMAGE_READER_ABSENT_NOTE : IMAGE_READ_FAILED_NOTE;
    group.forEach((image, index) => {
      const item = items[index];
      const failed = toRead(image, item, fallback);
      results.set(image, failed ?? imageRead(image, 'ok', (item?.text ?? '').slice(0, maxChars)));
    });
  }
  return images.flatMap((image) => results.get(image) ?? []);
}
