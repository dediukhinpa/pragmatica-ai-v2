/** Кто создал версию скрипта: агент сам или правка по просьбе сотрудника. */
export const PRICE_SCRIPT_AUTHORS = ['agent', 'employee_request'] as const;
export type PriceScriptAuthor = (typeof PRICE_SCRIPT_AUTHORS)[number];

/** Сколько последних версий скрипта хранится на пару (поставщик, форма таблицы). */
export const PRICE_SCRIPT_KEEP_VERSIONS = 5;

/** Версия сохранённого скрипта разбора прайса поставщика. */
export interface SupplierPriceScript {
  supplierId: string;
  /** Отпечаток формы таблицы (SHA-256 hex): шапка и раскладка, без значений данных. */
  formHash: string;
  /** Номер версии, с 1. */
  version: number;
  /** Исходник; точка входа `run(tables, source)`. */
  code: string;
  createdBy: PriceScriptAuthor;
  /** ISO 8601. */
  createdAt: string;
}

/** Что сохраняется: номер версии назначает хранилище. */
export type NewSupplierPriceScript = Omit<SupplierPriceScript, 'version'>;

/**
 * Скрипты разбора прайсов за поставщиками. Ключ - поставщик и форма таблицы; версии растут,
 * хранится не больше {@link PRICE_SCRIPT_KEEP_VERSIONS} последних.
 */
export interface SupplierPriceScriptRepository {
  /** Последняя версия скрипта для формы; `null` - скрипта нет. */
  findLatest(supplierId: string, formHash: string): Promise<SupplierPriceScript | null>;
  /** Сохранить новую версию (номер = последний + 1) и вернуть её. */
  save(script: NewSupplierPriceScript): Promise<SupplierPriceScript>;
}
