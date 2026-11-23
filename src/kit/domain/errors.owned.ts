import { DomainError } from '@business-ai/core';

/**
 * Прайс поставщика изменился между сверкой импорта и записью (параллельный импорт того же
 * поставщика или правка): проверки скачков и подтверждения считались от другой базы, поэтому
 * прайс не записан целиком (R9-A5-02). Не повторяемо как есть: нужна новая сверка.
 */
export class PriceBaseChangedError extends DomainError {
  constructor(supplierId: string) {
    super(
      'conflict',
      `price_base_changed: прайс поставщика ${supplierId} изменился во время записи ` +
        '(параллельный импорт или правка). Прайс не записан. Повторите сверку с текущим ' +
        'прайсом и запись заново (правки сотрудника - снова recordEmployeePriceUpdates).',
    );
    this.name = 'PriceBaseChangedError';
  }
}
/**
 * В базе уже лежит более новая версия этого прайс-файла (по дате в имени): старая дата не
 * перетирает новую. Прайс не записан.
 */
export class NewerPriceVersionError extends DomainError {
  constructor(supplierId: string, newerFile: string) {
    super(
      'conflict',
      `newer_price_version: у поставщика ${supplierId} уже загружена более новая версия этого ` +
        `прайса (${newerFile}). Файл с более старой датой не записан.`,
    );
    this.name = 'NewerPriceVersionError';
  }
}
/**
 * Формат исходного прайса на месте не правится (xls, pdf, скан): безопасной записи без нового
 * пакета нет. Код `invalid_input` (набор кодов закрыт), признак - класс; инструмент по нему
 * предлагает xlsx-копию, а не повтор.
 */
export class UnsupportedPriceFormatError extends DomainError {
  constructor(format: string) {
    super('invalid_input', `Формат «${format}» на месте не правится.`);
    this.name = 'UnsupportedPriceFormatError';
  }
}
/** Type guard: формат прайса не поддерживает правку на месте. */
export function isUnsupportedPriceFormatError(
  value: unknown,
): value is UnsupportedPriceFormatError {
  return value instanceof UnsupportedPriceFormatError;
}
/**
 * Чем именно правка упёрлась в предел сервиса (413): от причины зависит совет сотруднику.
 * `file_size` - файл больше предела загрузки; `structure` - слишком много ячеек, узлов, строк
 * или сложная разметка; `uncompressed` - распакованный размер (тяжёлые картинки, вложения);
 * `edits` - список правок не поместился в запрос; `temporary` - сервис занят или не уложился
 * по времени (повторить позже); `unknown` - сервис причину не назвал.
 */
export const PRICE_FILE_TOO_LARGE_REASONS = [
  'file_size',
  'structure',
  'uncompressed',
  'edits',
  'temporary',
  'unknown',
] as const;
export type PriceFileTooLargeReason = (typeof PRICE_FILE_TOO_LARGE_REASONS)[number];
/**
 * Файл больше предела, который сервис документов принимает для правки цен (413). Код
 * `invalid_input` (набор кодов закрыт), признак - класс. Повтор не поможет (файл тот же), а
 * инструмент по этому признаку отвечает статусом `too_large`, а не общей ошибкой: иначе модель
 * «догадывалась» о причине и подменяла исходник новой таблицей (разбор п.12, ноябрь 2026).
 */
export class PriceFileTooLargeError extends DomainError {
  readonly reason: PriceFileTooLargeReason;

  constructor(fileName: string, reason: PriceFileTooLargeReason = 'unknown') {
    super('invalid_input', `Файл «${fileName}» слишком большой для правки на месте.`);
    this.name = 'PriceFileTooLargeError';
    this.reason = reason;
  }
}
/** Type guard: файл прайса больше предела правки на месте. */
export function isPriceFileTooLargeError(value: unknown): value is PriceFileTooLargeError {
  return value instanceof PriceFileTooLargeError;
}
/** Причины, по которым присланный договор исполнителя не дополняется (коды сервиса документов). */
export const CONTRACT_AMEND_REFUSALS = [
  'customer_block_not_found',
  'customer_block_filled',
  'customer_placeholders_unfilled',
  'verification_failed',
  'unsupported_format',
  'conversion_failed',
  'conversion_unavailable',
  // 503 сервиса: том спула не принял файлы (нет места); временно, повторить позже.
  'spool_unavailable',
  // 404 на /docx/classify: документы старее ядра (выкатка по частям), маршрута ещё нет.
  'service_outdated',
  // 413 сервиса: файл больше предела или конвертация .doc/RTF не уложилась во время.
  'file_too_large',
  'nothing_to_do',
  'bad_request',
] as const;
export type ContractAmendRefusal = (typeof CONTRACT_AMEND_REFUSALS)[number];
/**
 * Присланный договор исполнителя дополнить нельзя или правка не прошла проверку «текст
 * исполнителя не изменился». Код `invalid_input` (набор кодов закрыт), причина - в `reason`:
 * по ней инструмент объясняет сотруднику, что именно не получилось. Файл при этом не выдаётся.
 */
export class ContractAmendRefusedError extends DomainError {
  constructor(readonly reason: ContractAmendRefusal) {
    super('invalid_input', `Договор исполнителя не дополнен: ${reason}.`);
    this.name = 'ContractAmendRefusedError';
  }
}
/** Причины отказа подстановки подписанта нашей стороны в шаблон (коды сервиса документов). */
export const OWN_SIGNATORY_REFUSALS = [
  'signatory_not_found',
  'signatory_inconsistent',
  'signatory_left',
  'verification_failed',
  'bad_request',
] as const;
export type OwnSignatoryRefusal = (typeof OWN_SIGNATORY_REFUSALS)[number];
/**
 * Подписанта нашей стороны в шаблоне подставить нельзя или правка не прошла проверку. Код
 * `conflict` (набор кодов закрыт), причина - в `reason`; значений (ФИО) в тексте нет.
 */
export class OwnSignatoryRefusedError extends DomainError {
  constructor(readonly reason: OwnSignatoryRefusal) {
    super('conflict', `Подписант нашей стороны в шаблоне не подставлен: ${reason}.`);
    this.name = 'OwnSignatoryRefusedError';
  }
}
