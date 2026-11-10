import type { PriceFileDate } from '../domain/price-file-date';

/**
 * Что отдаётся на запасной разбор. Имя файла не ПДн, но реализация, отправляющая его внешней
 * модели, обязана вызывать модель через `PseudonymizingModelGateway`; имя в журналы не пишется.
 */
export interface PriceFileDateFallbackInput {
  /** Имя файла или путь (разбирается базовое имя). */
  fileName: string;
  /** Сегодняшняя дата бизнеса `ГГГГ-ММ-ДД`: чтобы модель не называла даты из будущего. */
  today: string;
}

/** Параметры вызова запасного разбора. */
export interface PriceFileDateFallbackOptions {
  /** Сигнал отмены: срабатывает по таймауту; реализация обязана прервать запрос к модели. */
  signal: AbortSignal;
}

/**
 * Запасной разбор даты из названия прайса моделью - для имён, где кодовый разбор даты не
 * нашёл. Вызывается только для имён, похожих на прайс. Ответ - лишь предложение: вызывающий
 * код проверяет его строго (`verifyFallbackPriceFileDate`: окно годов, не будущее, дата
 * действительно есть в названии) и при несовпадении отбрасывает. Ошибка и таймаут означают
 * «дата не найдена».
 */
export interface PriceFileDateFallback {
  /**
   * Предложить дату выпуска прайса; `null` - дату определить нельзя. Ошибки - обычные
   * исключения (код тексты из них не использует).
   */
  resolve(
    input: PriceFileDateFallbackInput,
    options: PriceFileDateFallbackOptions,
  ): Promise<PriceFileDate | null>;
}
