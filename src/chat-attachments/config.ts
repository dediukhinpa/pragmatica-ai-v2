import { DEFAULT_ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_FILES } from '@business-ai/adapters';
import type { ChatAttachmentsConfig } from './types';

const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * BYTES_PER_MIB;

/** Умолчания и границы; те же значения использует схема конфигурации проекта. */
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
export const DEFAULT_MAX_BYTES = 3 * BYTES_PER_GIB;
/** Верхний предел файла совпадает с потолком платформенной настройки B24_ATTACHMENT_MAX_BYTES. */
const MAX_FILE_BYTES_LIMIT = 100 * BYTES_PER_MIB;
/**
 * Платформенный лимит файлов (B24_ATTACHMENT_MAX_FILES) действует на один запрос чтения,
 * а архив считает за целые сутки треда, поэтому берём запас в 10 раз.
 */
const FILES_PER_DAY_FACTOR = 10;
const MAX_FILES_PER_DAY_LIMIT = 500;
const OFF_VALUES: readonly string[] = ['false', '0', 'no', 'off'];
const DIGITS_ONLY = /^\d+$/;

/** Целое неотрицательное из строки окружения; всё остальное (мусор, дробь, минус) - null. */
function parseWholeNumber(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (text === undefined || !DIGITS_ONLY.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Положительное целое либо null. */
function parsePositive(raw: string | undefined): number | null {
  const value = parseWholeNumber(raw);
  return value !== null && value > 0 ? value : null;
}

/**
 * Разобрать настройки архива файлов чатов из переменных окружения.
 * Чистая функция: `process.env` здесь не читается, мусорные значения дают умолчания.
 */
export function parseChatAttachmentsConfig(
  env: Record<string, string | undefined>,
): ChatAttachmentsConfig {
  const enabledRaw = env['CHAT_ATTACHMENTS_STORE_ENABLED']?.trim().toLowerCase() ?? '';
  const days = parseWholeNumber(env['CHAT_ATTACHMENTS_RETENTION_DAYS']);
  const retentionDays =
    days !== null && days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS
      ? days
      : DEFAULT_RETENTION_DAYS;
  const fileBytes = parsePositive(env['B24_ATTACHMENT_MAX_BYTES']);
  const files = parsePositive(env['B24_ATTACHMENT_MAX_FILES']);
  const perRequest = files ?? DEFAULT_ATTACHMENT_MAX_FILES;
  return {
    enabled: !OFF_VALUES.includes(enabledRaw),
    retentionDays,
    maxBytes: parsePositive(env['CHAT_ATTACHMENTS_MAX_BYTES']) ?? DEFAULT_MAX_BYTES,
    maxFileBytes: Math.min(fileBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES, MAX_FILE_BYTES_LIMIT),
    maxFilesPerThreadDay: Math.min(perRequest * FILES_PER_DAY_FACTOR, MAX_FILES_PER_DAY_LIMIT),
  };
}

/** Уже проверенные значения (схема конфигурации проекта и платформенные пределы вложений). */
export interface ChatAttachmentsValues {
  enabled: boolean;
  retentionDays: number;
  maxBytes: number;
  /** `B24_ATTACHMENT_MAX_BYTES`; не задан - умолчание платформы. */
  attachmentMaxBytes?: number | undefined;
  /** `B24_ATTACHMENT_MAX_FILES`; не задан - умолчание платформы. */
  attachmentMaxFiles?: number | undefined;
}

/** Настройки архива из проверенных значений; пределы файла и числа файлов - как у вложений. */
export function chatAttachmentsConfigOf(values: ChatAttachmentsValues): ChatAttachmentsConfig {
  const perRequest = values.attachmentMaxFiles ?? DEFAULT_ATTACHMENT_MAX_FILES;
  return {
    enabled: values.enabled,
    retentionDays: values.retentionDays,
    maxBytes: values.maxBytes,
    maxFileBytes: Math.min(
      values.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
      MAX_FILE_BYTES_LIMIT,
    ),
    maxFilesPerThreadDay: Math.min(perRequest * FILES_PER_DAY_FACTOR, MAX_FILES_PER_DAY_LIMIT),
  };
}
