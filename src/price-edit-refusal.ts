import { DomainError } from '@business-ai/core';

/** Причина отказа правки файла проверками сервиса и место, к которому она относится. */
export interface PriceEditRefusal {
  /** Машинный код сервиса (`glyph_missing`, `no_fit`, `price_ambiguous`, ...). */
  code: string;
  table?: number | undefined;
  row?: number | undefined;
  col?: number | undefined;
  /** Число в тексте PDF вне таблицы (этап 9r): страница с 1 и номер места на ней с 0. */
  page?: number | undefined;
  spot?: number | undefined;
}

/**
 * Сервис отказал править файл целиком: любая из строгих проверок (наложение цены в PDF, сверка
 * старого .ppt с конвертацией) не прошла. Файл не выдан, причины по местам. Код `invalid_input`
 * (набор кодов закрыт), признак - класс; инструмент по нему предлагает xlsx-копию, как для
 * `UnsupportedPriceFormatError`, но называет причины.
 */
export class PriceEditRefusedError extends DomainError {
  readonly reasons: readonly PriceEditRefusal[];

  constructor(reasons: readonly PriceEditRefusal[]) {
    super('invalid_input', 'Сервис отказал править файл на месте.');
    this.name = 'PriceEditRefusedError';
    this.reasons = reasons;
  }
}

/** Type guard: правка файла отклонена проверками сервиса. */
export function isPriceEditRefusedError(value: unknown): value is PriceEditRefusedError {
  return value instanceof PriceEditRefusedError;
}
