/** Откуда оценка: модель либо запасное правило. */
export const SUPPLIER_RATING_SOURCES = ['model', 'rule'] as const;
export type SupplierRatingSource = (typeof SUPPLIER_RATING_SOURCES)[number];

/** Запись кэша оценки: поставщик, хэш фактов, на которых получена оценка, и сама оценка. */
export interface CachedSupplierRating {
  supplierId: string;
  /** SHA-256 каноничной записи фактов (hex). */
  factsHash: string;
  score: number;
  rationale: string;
  source: SupplierRatingSource;
  /** Момент записи, ISO 8601. */
  createdAt: string;
}

/**
 * Кэш оценок по хэшу фактов: модель не зовётся на каждый шорт-лист, пока факты карточки не
 * менялись. Ключ - поставщик и хэш. Хранится одна, последняя запись поставщика: новая запись
 * с другим хэшем вытесняет прежние (факты изменились, старая оценка не нужна), поэтому таблица
 * не растёт сверх числа поставщиков и отдельная чистка не требуется.
 */
export interface SupplierRatingCache {
  /** Запись по ключу либо `null`. */
  get(supplierId: string, factsHash: string): Promise<CachedSupplierRating | null>;
  /** Сохранить запись (повтор того же ключа перезаписывает) и убрать прочие записи поставщика. */
  put(entry: CachedSupplierRating): Promise<void>;
}
