/** Настройки архива файлов чатов (см. `parseChatAttachmentsConfig`). */
export interface ChatAttachmentsConfig {
  /** Сохранять ли файлы вообще. */
  enabled: boolean;
  /** Срок хранения, суток. */
  retentionDays: number;
  /** Предел суммарного размера файлов архива, байт. */
  maxBytes: number;
  /** Предел размера одного файла, байт. */
  maxFileBytes: number;
  /** Предел числа файлов одного треда за UTC-сутки. */
  maxFilesPerThreadDay: number;
}

/** Файл на диске (например, спул очереди чата): в память целиком не читается. */
export interface ChatAttachmentDiskFile {
  path: string;
  size: number;
}

/** Вход сохранения: один файл, присланный сотрудником боту. */
export interface ChatAttachmentInput {
  threadId: string;
  userId: string;
  botId?: string | undefined;
  agentId?: string | undefined;
  /** Ключ события-источника: по нему отсеивается повторная доставка. */
  sourceKey?: string | undefined;
  file: {
    name: string;
    content: Uint8Array;
    disk?: ChatAttachmentDiskFile | undefined;
  };
}

/** Причина, по которой файл не сохранён намеренно. */
export type SkipReason = 'disabled' | 'empty' | 'too_large' | 'thread_limit' | 'no_space';

/** Итог сохранения; `save` никогда не бросает исключение. */
export type SaveOutcome =
  | { kind: 'saved' | 'duplicate'; path: string; sha256: string; size: number }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'failed'; code: string };

/** Запись индекса «кто, когда, какому боту, что» (одна строка JSONL). */
export interface ChatAttachmentRecord {
  v: 1;
  /** Момент получения, ISO. */
  at: string;
  agent: string;
  bot: string;
  /** Каталог треда (хэш, 16 hex). */
  thread: string;
  user: string;
  /** Исходное имя файла как прислали. */
  name: string;
  sha256: string;
  size: number;
  /** Относительный путь `files/<тред>/<хэш>_<имя>`. */
  path: string;
  /** Ключ события-источника; пустая строка, если не известен. */
  key: string;
}

/** Условия поиска по индексу; все заданные условия объединяются по «И». */
export interface ChatAttachmentQuery {
  user?: string | undefined;
  bot?: string | undefined;
  agent?: string | undefined;
  /** Исходный id треда либо каталог треда (16 hex). */
  thread?: string | undefined;
  /** Подстрока исходного имени, без учёта регистра. */
  name?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  /** Префикс sha256 (hex, без учёта регистра). */
  sha?: string | undefined;
  /** Сколько самых свежих записей вернуть; по умолчанию 200. */
  limit?: number | undefined;
}

/** Итог очистки по сроку. */
export interface PurgeResult {
  /** Файлы, у которых не осталось живых записей индекса. */
  files: number;
  /** Удалённые просроченные записи индекса. */
  records: number;
  /** Освобождено байт (файлы, сироты и временные файлы). */
  bytes: number;
  /** Сироты (файлы без записи в индексе) и просроченные `.tmp-*`. */
  orphans: number;
}

/** Итог вытеснения по объёму. */
export interface EvictResult {
  evicted: number;
  bytes: number;
}

/** Приёмник событий журнала: только коды и числа, имена файлов и тексты запрещены. */
export type ChatAttachmentEventSink = (
  event: string,
  fields: Record<string, string | number>,
) => void;

/** Параметры архива. */
export interface ChatAttachmentArchiveOptions {
  /** Корень приёма (INTAKE_ROOT): архив лежит в `<корень>/chat-attachments`. */
  intakeRoot: string;
  config: ChatAttachmentsConfig;
  onEvent?: ChatAttachmentEventSink | undefined;
  /** Источник времени; по умолчанию системные часы. */
  clock?: (() => Date) | undefined;
}
