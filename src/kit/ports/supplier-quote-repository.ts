import type { SupplierQuote } from '../domain/models';

/** Сохранённые КП поставщиков. */
export interface SupplierQuoteRepository {
  /**
   * Сохранить КП. Новое КП того же поставщика по той же заявке замещает прежнее (одно
   * актуальное КП). Некорректное КП — DomainError('invalid_input'), ничего не пишется.
   * Возвращает версию записи: 1 для первого КП, дальше +1 при каждой замене.
   */
  save(quote: SupplierQuote): Promise<number>;
  /** КП поставщика по заявке; null, если нет. */
  get(requestId: string, supplierId: string): Promise<SupplierQuote | null>;
  /** Все актуальные КП заявки по возрастанию id поставщика (порядок кодовых точек). */
  listByRequest(requestId: string): Promise<SupplierQuote[]>;
  /** Все актуальные КП поставщика по возрастанию id заявки (порядок кодовых точек). */
  listBySupplier(supplierId: string): Promise<SupplierQuote[]>;
  /**
   * Id заявок, по которым у поставщика есть актуальное КП: первые `limit` по возрастанию
   * (порядок кодовых точек, как в `listBySupplier`), без выгрузки самих КП.
   */
  listRequestIdsBySupplier(supplierId: string, limit: number): Promise<string[]>;
}
