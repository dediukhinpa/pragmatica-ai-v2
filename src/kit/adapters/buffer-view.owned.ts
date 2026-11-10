
/**
 * Представление `Uint8Array` поверх `Buffer` без копирования (R5-ADP-6).
 *
 * `new Uint8Array(buffer)` копирует содержимое: для файла в десятки мегабайт это лишние десятки
 * мегабайт пика памяти. Представление использует ту же память; `Buffer` после этого нельзя
 * изменять - вызывающие его не оставляют у себя.
 */
export function bytesOf(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}
/**
 * `Blob` из байтов без промежуточной копии (R5-ADP-6): `Blob` сам копирует содержимое один раз,
 * лишний `new Uint8Array(content)` перед ним удваивал пик. Общая память (SharedArrayBuffer)
 * в `BlobPart` не допускается типами, для неё копия остаётся.
 */
export function blobOf(bytes: Uint8Array): Blob {
  const { buffer, byteOffset, length } = bytes;
  if (buffer instanceof ArrayBuffer) return new Blob([new Uint8Array(buffer, byteOffset, length)]);
  return new Blob([new Uint8Array(bytes)]);
}
