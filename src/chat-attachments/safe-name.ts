import {
  FALLBACK_NAME,
  MAX_EXTENSION_CHARS,
  MAX_SAFE_NAME_BYTES,
  MAX_SAFE_NAME_CHARS,
} from './constants';

/**
 * Что заменяется на `_`: разделители пути, NUL и управляющие символы (в том числе C1),
 * разделители строк и символы смены направления письма (подмена расширения).
 */
const UNSAFE_CHARS = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f/\\\\\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]`,
  'gu',
);
const LEADING_DOTS = /^\.+/;
const REPLACEMENT = '_';

/** Длина строки в знаках (кодовых точках) и в байтах UTF-8. */
function measure(text: string): { chars: number; bytes: number } {
  return { chars: Array.from(text).length, bytes: Buffer.byteLength(text) };
}

/** Взять из начала строки не больше `maxChars` знаков и `maxBytes` байт, не рвя символы. */
function clip(text: string, maxChars: number, maxBytes: number): string {
  let chars = 0;
  let bytes = 0;
  let result = '';
  for (const symbol of text) {
    const symbolBytes = Buffer.byteLength(symbol);
    if (chars + 1 > maxChars || bytes + symbolBytes > maxBytes) break;
    chars += 1;
    bytes += symbolBytes;
    result += symbol;
  }
  return result;
}

/** Расширение с точкой, если оно короткое и не является всем именем; иначе пустая строка. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = name.slice(dot);
  if (extension.length < 2 || measure(extension).chars > MAX_EXTENSION_CHARS) return '';
  return extension;
}

/**
 * Безопасное имя файла для архива: без `/`, `\`, NUL и управляющих символов, не начинается
 * с точки, не длиннее 120 знаков (и 200 байт UTF-8, чтобы с префиксом хэша имя влезло в
 * 255 байт файловой системы) с сохранением расширения; пустое даёт `file`. Тип файла не
 * ограничивается, но выйти из каталога имя не может.
 */
export function safeAttachmentName(original: string): string {
  const cleaned = original.replace(UNSAFE_CHARS, REPLACEMENT).trim().replace(LEADING_DOTS, '');
  if (cleaned === '') return FALLBACK_NAME;
  const size = measure(cleaned);
  if (size.chars <= MAX_SAFE_NAME_CHARS && size.bytes <= MAX_SAFE_NAME_BYTES) return cleaned;
  const extension = extensionOf(cleaned);
  const used = measure(extension);
  const stem = cleaned.slice(0, cleaned.length - extension.length);
  const clipped = clip(stem, MAX_SAFE_NAME_CHARS - used.chars, MAX_SAFE_NAME_BYTES - used.bytes);
  return `${clipped}${extension}`;
}
