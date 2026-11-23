import { KnowledgeHit } from '@business-ai/core';

/** Ограничение области поиска. Без полей - вся база знаний. */
export interface KnowledgeScope {
  /** Только раздел поставщиков: документы и заметки, помеченные каким-либо поставщиком. */
  suppliersOnly?: boolean | undefined;
  /** Только документы одного поставщика (включает `suppliersOnly`). */
  supplierId?: string | undefined;
}
/** Гибридный (векторный + полнотекстовый) поиск по базе знаний. */
export interface KnowledgeSearch {
  /**
   * Найти документы по запросу; результат отсортирован по убыванию score. `scope` ограничивает
   * область (раздел поставщиков или один поставщик); без него поиск идёт по всей базе.
   */
  search(query: string, limit: number, scope?: KnowledgeScope): Promise<KnowledgeHit[]>;
  /**
   * Поставщик, к которому привязан документ (`supplier_id` фрагментов): только документы с
   * ОДНОЗНАЧНОЙ привязкой, остальные в результате отсутствуют. Нужен, чтобы документ-подсказка
   * стал кандидатом-поставщиком; функции гибридного поиска `supplier_id` не возвращают, а
   * менять их из-за этого (миграция) не стали.
   */
  supplierIdsOf?(documentIds: readonly string[]): Promise<Map<string, string>>;
}
