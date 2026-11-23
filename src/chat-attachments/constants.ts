/** Подкаталог корня приёма (INTAKE_ROOT), где живёт архив файлов чатов. */
export const CHAT_ATTACHMENTS_DIR = 'chat-attachments';
/**
 * Имя подкаталога намеренно с дефисом: платформенная ретенция приёма трогает только
 * каталоги корня вида `^[0-9a-f]{16}$` и архив не видит.
 */
export const FILES_DIR = 'files';
export const INDEX_DIR = 'index';

/** Версия схемы записи индекса. */
export const INDEX_VERSION = 1;

/** Права каталогов и файлов: только владелец процесса (как том приёма). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Префикс временных файлов записи; такие файлы старше часа считаются мусором. */
export const TEMP_PREFIX = '.tmp-';
export const TEMP_SUFFIX_BYTES = 6;
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Префикс временного файла при атомарной перезаписи индекса. */
export const REWRITE_PREFIX = '.rewrite-';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Длина префикса sha256 в имени файла и разделитель между префиксом и именем. */
export const HASH_PREFIX_CHARS = 16;
export const HASH_SEPARATOR = '_';
/** Длина каталога треда (хэш из платформы приёма). */
export const THREAD_DIR_CHARS = 16;

/** Сколько последних ключей событий помним для отсева повторной доставки. */
export const RECENT_KEYS_LIMIT = 1000;
/** Сколько записей отдаёт поиск по умолчанию. */
export const DEFAULT_FIND_LIMIT = 200;
/** Вытеснение по объёму доводит архив до этой доли от предела. */
export const CAP_TARGET_RATIO = 0.9;

/** Пределы безопасного имени: знаков (без учёта префикса хэша) и байт UTF-8. */
export const MAX_SAFE_NAME_CHARS = 120;
/** 255 байт на имя в файловой системе минус префикс хэша (17) и запас. */
export const MAX_SAFE_NAME_BYTES = 200;
export const MAX_EXTENSION_CHARS = 16;
export const FALLBACK_NAME = 'file';
/** Исходное имя в индексе режется по этой длине (защита от гигантских строк). */
export const MAX_ORIGINAL_NAME_CHARS = 1000;
