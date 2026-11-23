import { withHexLetter } from '@business-ai/core';

/**
 * Непрозрачный идентификатор файла диска для поручения агенту (этап 107). Путь с фамилией в
 * имени маскируется как ПДн, и модель возвращает его в инструмент искажённым (схлопнутые
 * пробелы, токен вместо фамилии). Поэтому поручение несёт не путь, а `fileref:<HMAC пути>`;
 * код сам разрешает его в реальный путь по списку файлов диска.
 *
 * Идентификатор уходит во внешнюю модель, поэтому он не должен подбираться по словарю фамилий:
 * это HMAC-SHA256 с серверным секретом, а не бессолевой хэш пути. Секрет берётся из постоянной
 * конфигурации (не случайный на процесс): поручение лежит в очереди и переживает перезапуск.
 */
export const FILE_REF_PREFIX = 'fileref:';

/** Длина идентификатора в hex-символах (128 бит от HMAC-SHA256: коллизии исключены). */
export const FILE_REF_HEX_CHARS = 32;

/** Разделение назначения: ключ идентификаторов файлов выводится из общего секрета отдельно. */
const FILE_REF_KEY_CONTEXT = 'pragmatika:file-ref:v1';

/** HMAC-SHA256 в hex (встроенный хэшер рантайма: слой application не импортирует `node:*`). */
function hmacHex(key: string, message: string): string {
  return new Bun.CryptoHasher('sha256', key).update(message).digest('hex');
}

/**
 * Идентификатор файла по его пути на диске и серверному секрету. Детерминирован при одном
 * секрете; смена секрета делает ранее выданные идентификаторы неразрешимыми (not_found).
 */
export function fileRefOf(path: string, secret: string): string {
  const key = hmacHex(secret, FILE_REF_KEY_CONTEXT);
  // Буква a-f обязательна: hex из одних цифр кодек идентификаторов не трогает, и модели ушла
  // бы серия цифр, похожая на ИНН или телефон.
  return `${FILE_REF_PREFIX}${withHexLetter(hmacHex(key, path).slice(0, FILE_REF_HEX_CHARS))}`;
}

/** Строка - идентификатор `fileref:...`, а не путь. */
export function isFileRef(value: string): boolean {
  return value.startsWith(FILE_REF_PREFIX);
}
